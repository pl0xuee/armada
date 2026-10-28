//! Voice dictation: microphone capture (cpal), local speech-to-text (whisper.cpp via
//! whisper-rs) and the model download commands. Audio stays in memory and on this
//! device: nothing is written to disk and nothing is sent anywhere.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use armada_core::voice::{self, ModelInfo};
use armada_core::Core;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::commands::CmdResult;
use crate::state::Shell;

/// The model is dropped from memory after this long without a dictation.
const MODEL_IDLE_UNLOAD: Duration = Duration::from_secs(10 * 60);
/// Recordings shorter than this are treated as accidental clicks.
const MIN_SAMPLES_16K: usize = voice::WHISPER_SAMPLE_RATE as usize * 3 / 10;

struct Loaded {
    model_id: String,
    ctx: Arc<WhisperContext>,
    last_used: Instant,
}

struct Recording {
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<Result<Captured, String>>,
}

struct Captured {
    mono: Vec<f32>,
    sample_rate: u32,
}

#[derive(Default)]
pub struct Dictation {
    recording: Mutex<Option<Recording>>,
    model: Arc<Mutex<Option<Loaded>>>,
    download: Mutex<Option<(String, Arc<AtomicBool>)>>,
    transcribing: Arc<AtomicBool>,
    reaper_started: AtomicBool,
}

// ---- payloads --------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    pub name: String,
    pub is_default: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub models: Vec<ModelInfo>,
    pub languages: Vec<(&'static str, &'static str)>,
    pub max_recording_secs: u32,
    /// The model id picked in settings, and whether it is downloaded.
    pub model: String,
    pub ready: bool,
    pub downloading: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LevelEvent {
    level: f32,
    elapsed_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadEvent {
    id: String,
    done: u64,
    total: u64,
    /// "progress" | "done" | "error" | "cancelled"
    state: &'static str,
    error: Option<String>,
}

// ---- status & devices ------------------------------------------------------------

#[tauri::command]
pub fn voice_status(
    core: State<'_, Arc<Core>>,
    shell: State<'_, Shell>,
    dict: State<'_, Dictation>,
) -> CmdResult<VoiceStatus> {
    let settings = core.settings().map_err(|e| format!("{e:#}"))?;
    let models = voice::model_infos(&shell.data_dir);
    let ready = models
        .iter()
        .any(|m| m.id == settings.voice.model && m.installed);
    Ok(VoiceStatus {
        models,
        languages: voice::LANGUAGES.to_vec(),
        max_recording_secs: voice::MAX_RECORDING_SECS,
        model: settings.voice.model,
        ready,
        downloading: dict.download.lock().as_ref().map(|(id, _)| id.clone()),
    })
}

#[tauri::command]
pub async fn voice_list_devices() -> CmdResult<Vec<InputDevice>> {
    tauri::async_runtime::spawn_blocking(|| {
        let host = cpal::default_host();
        let default = host.default_input_device().and_then(|d| d.name().ok());
        let mut out: Vec<InputDevice> = Vec::new();
        for d in host.input_devices().map_err(|e| e.to_string())? {
            if let Ok(name) = d.name() {
                if !out.iter().any(|o| o.name == name) {
                    out.push(InputDevice {
                        is_default: default.as_deref() == Some(name.as_str()),
                        name,
                    });
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- model download --------------------------------------------------------------

#[tauri::command]
pub async fn voice_download_model(
    app: AppHandle,
    shell: State<'_, Shell>,
    dict: State<'_, Dictation>,
    id: String,
) -> CmdResult<()> {
    let spec = voice::require_model(&id).map_err(|e| e.to_string())?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = dict.download.lock();
        if slot.is_some() {
            return Err("A model is already downloading".into());
        }
        *slot = Some((id.clone(), cancel.clone()));
    }
    let data_dir = shell.data_dir.clone();
    let emit_app = app.clone();
    let emit_id = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        voice::download_model(&data_dir, spec, &cancel, |done, total| {
            let _ = emit_app.emit(
                "voice-download",
                DownloadEvent {
                    id: emit_id.clone(),
                    done,
                    total,
                    state: "progress",
                    error: None,
                },
            );
        })
    })
    .await;
    *dict.download.lock() = None;

    let outcome: Result<(), anyhow::Error> = match result {
        Ok(r) => r,
        Err(e) => Err(anyhow::anyhow!("{e}")),
    };
    let cancelled = outcome.as_ref().err().is_some_and(voice::is_cancelled);
    let (state, error) = match &outcome {
        Ok(()) => ("done", None),
        Err(_) if cancelled => ("cancelled", None),
        Err(e) => ("error", Some(format!("{e:#}"))),
    };
    let _ = app.emit(
        "voice-download",
        DownloadEvent {
            id,
            done: if state == "done" { spec.size_bytes } else { 0 },
            total: spec.size_bytes,
            state,
            error,
        },
    );
    outcome.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn voice_cancel_download(dict: State<'_, Dictation>) {
    if let Some((_, cancel)) = dict.download.lock().as_ref() {
        cancel.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn voice_delete_model(
    shell: State<'_, Shell>,
    dict: State<'_, Dictation>,
    id: String,
) -> CmdResult<()> {
    let spec = voice::require_model(&id).map_err(|e| e.to_string())?;
    if dict.transcribing.load(Ordering::Relaxed) {
        return Err("Wait for the current transcription to finish".into());
    }
    {
        let mut loaded = dict.model.lock();
        if loaded.as_ref().is_some_and(|l| l.model_id == id) {
            *loaded = None;
        }
    }
    voice::delete_model(&shell.data_dir, spec).map_err(|e| format!("{e:#}"))
}

// ---- recording -------------------------------------------------------------------

fn pick_device(name: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if let Some(name) = name {
        if let Ok(mut devices) = host.input_devices() {
            if let Some(d) = devices.find(|d| d.name().ok().as_deref() == Some(name)) {
                return Ok(d);
            }
        }
        tracing::warn!("dictation input device {name:?} not found; using the default");
    }
    host.default_input_device().ok_or_else(|| {
        "No microphone found. Connect one and check your system's sound settings.".to_string()
    })
}

fn mic_error(what: &str, e: impl std::fmt::Display) -> String {
    let hint = if cfg!(target_os = "macos") {
        " Check System Settings > Privacy & Security > Microphone."
    } else if cfg!(windows) {
        " Check Settings > Privacy & security > Microphone."
    } else {
        ""
    };
    format!("{what}: {e}.{hint}")
}

/// Appends mono frames to `buf` (capped) and tracks the peak level since last read.
struct Sink {
    buf: Arc<Mutex<Vec<f32>>>,
    level: Arc<AtomicU32>,
    channels: usize,
    cap: usize,
}

impl Sink {
    fn push(&self, mut mono: Vec<f32>) {
        let level = voice::meter_level(&mono);
        // Keep the loudest block since the poller last looked.
        let mut cur = self.level.load(Ordering::Relaxed);
        while f32::from_bits(cur) < level {
            match self.level.compare_exchange_weak(
                cur,
                level.to_bits(),
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(v) => cur = v,
            }
        }
        let mut buf = self.buf.lock();
        let room = self.cap.saturating_sub(buf.len());
        mono.truncate(room);
        buf.extend_from_slice(&mono);
    }

    fn push_f32(&self, data: &[f32]) {
        self.push(voice::downmix(data, self.channels));
    }
}

fn run_capture(
    app: AppHandle,
    device_name: Option<String>,
    stop: Arc<AtomicBool>,
    ready: std::sync::mpsc::Sender<Result<(), String>>,
) -> Result<Captured, String> {
    // The stream is created and dropped on this thread (it isn't Send everywhere).
    let setup = (|| {
        let device = pick_device(device_name.as_deref())?;
        let config = device
            .default_input_config()
            .map_err(|e| mic_error("Couldn't read the microphone's settings", e))?;
        let rate = config.sample_rate().0;
        let channels = config.channels() as usize;
        let cap = rate as usize * voice::MAX_RECORDING_SECS as usize;
        let buf = Arc::new(Mutex::new(Vec::with_capacity(rate as usize * 30)));
        let level = Arc::new(AtomicU32::new(0));
        let failure: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let sink = Arc::new(Sink {
            buf: buf.clone(),
            level: level.clone(),
            channels,
            cap,
        });
        let err_slot = failure.clone();
        let err_stop = stop.clone();
        let on_err = move |e: cpal::StreamError| {
            *err_slot.lock() = Some(mic_error("The microphone stopped working", e));
            err_stop.store(true, Ordering::Relaxed);
        };
        let stream_config: cpal::StreamConfig = config.clone().into();
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => {
                let s = sink.clone();
                device.build_input_stream(
                    &stream_config,
                    move |d: &[f32], _| s.push_f32(d),
                    on_err,
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let s = sink.clone();
                device.build_input_stream(
                    &stream_config,
                    move |d: &[i16], _| {
                        let f: Vec<f32> = d.iter().map(|v| *v as f32 / 32768.0).collect();
                        s.push_f32(&f)
                    },
                    on_err,
                    None,
                )
            }
            cpal::SampleFormat::U16 => {
                let s = sink.clone();
                device.build_input_stream(
                    &stream_config,
                    move |d: &[u16], _| {
                        let f: Vec<f32> =
                            d.iter().map(|v| (*v as f32 - 32768.0) / 32768.0).collect();
                        s.push_f32(&f)
                    },
                    on_err,
                    None,
                )
            }
            cpal::SampleFormat::I32 => {
                let s = sink.clone();
                device.build_input_stream(
                    &stream_config,
                    move |d: &[i32], _| {
                        let f: Vec<f32> = d.iter().map(|v| *v as f32 / 2_147_483_648.0).collect();
                        s.push_f32(&f)
                    },
                    on_err,
                    None,
                )
            }
            other => return Err(format!("Unsupported microphone sample format: {other:?}")),
        }
        .map_err(|e| mic_error("Couldn't open the microphone", e))?;
        stream
            .play()
            .map_err(|e| mic_error("Couldn't start the microphone", e))?;
        Ok((stream, buf, level, failure, rate, cap))
    })();

    let (stream, buf, level, failure, rate, cap) = match setup {
        Ok(v) => {
            let _ = ready.send(Ok(()));
            v
        }
        Err(e) => {
            let _ = ready.send(Err(e.clone()));
            return Err(e);
        }
    };

    let started = Instant::now();
    let mut limit_sent = false;
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(60));
        let lvl = f32::from_bits(level.swap(0, Ordering::Relaxed));
        let _ = app.emit(
            "voice-level",
            LevelEvent {
                level: lvl,
                elapsed_ms: started.elapsed().as_millis() as u64,
            },
        );
        if !limit_sent && buf.lock().len() >= cap {
            limit_sent = true;
            let _ = app.emit("voice-limit", ());
        }
    }
    drop(stream);
    if let Some(e) = failure.lock().take() {
        return Err(e);
    }
    let mono = std::mem::take(&mut *buf.lock());
    Ok(Captured {
        mono,
        sample_rate: rate,
    })
}

#[tauri::command]
pub async fn voice_start(
    app: AppHandle,
    core: State<'_, Arc<Core>>,
    dict: State<'_, Dictation>,
) -> CmdResult<()> {
    let device = core
        .settings()
        .map_err(|e| format!("{e:#}"))?
        .voice
        .input_device;
    if dict.recording.lock().is_some() {
        return Err("Already recording".into());
    }
    if dict.transcribing.load(Ordering::Relaxed) {
        return Err("Still transcribing the previous recording".into());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = std::sync::mpsc::channel();
    let thread = {
        let stop = stop.clone();
        std::thread::Builder::new()
            .name("armada-dictation-capture".into())
            .spawn(move || run_capture(app, device, stop, tx))
            .map_err(|e| e.to_string())?
    };
    // Wait for the microphone to open so permission/device errors surface right away.
    let opened = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(15))
            .unwrap_or_else(|_| Err("Timed out opening the microphone".into()))
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Err(e) = opened {
        stop.store(true, Ordering::Relaxed);
        let _ = thread.join();
        return Err(e);
    }
    *dict.recording.lock() = Some(Recording { stop, thread });
    Ok(())
}

/// Stops a recording and returns what was captured (or the capture error).
async fn finish_recording(dict: &Dictation) -> CmdResult<Option<Captured>> {
    let Some(rec) = dict.recording.lock().take() else {
        return Ok(None);
    };
    rec.stop.store(true, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || rec.thread.join())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "The recorder crashed".to_string())?
        .map(Some)
}

#[tauri::command]
pub async fn voice_cancel(dict: State<'_, Dictation>) -> CmdResult<()> {
    let _ = finish_recording(&dict).await;
    Ok(())
}

// ---- transcription ---------------------------------------------------------------

fn start_reaper(model: Arc<Mutex<Option<Loaded>>>, busy: Arc<AtomicBool>) {
    let _ = std::thread::Builder::new()
        .name("armada-dictation-reaper".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(30));
            if busy.load(Ordering::Relaxed) {
                continue;
            }
            let mut slot = model.lock();
            if slot
                .as_ref()
                .is_some_and(|l| l.last_used.elapsed() >= MODEL_IDLE_UNLOAD)
            {
                *slot = None;
                tracing::info!("dictation model unloaded after idling");
            }
        });
}

fn clean_transcript(raw: &str) -> String {
    let text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    // Whisper marks non-speech as "[BLANK_AUDIO]", "(silence)", "[Music]" and the like.
    let bracketed = (text.starts_with('[') && text.ends_with(']'))
        || (text.starts_with('(') && text.ends_with(')'))
        || (text.starts_with('*') && text.ends_with('*'));
    if bracketed {
        String::new()
    } else {
        text
    }
}

fn transcribe(
    ctx: &WhisperContext,
    audio: &[f32],
    language: Option<&str>,
) -> Result<String, String> {
    let mut state = ctx
        .create_state()
        .map_err(|e| format!("Couldn't start the speech model: {e}"))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 8);
    params.set_n_threads(threads as i32);
    params.set_language(Some(language.unwrap_or("auto")));
    params.set_translate(false);
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    state
        .full(params, audio)
        .map_err(|e| format!("Transcription failed: {e}"))?;
    let mut text = String::new();
    for i in 0..state.full_n_segments() {
        if let Some(seg) = state.get_segment(i) {
            if let Ok(s) = seg.to_str_lossy() {
                text.push_str(&s);
            }
        }
    }
    Ok(clean_transcript(&text))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub text: String,
    pub auto_send: bool,
}

#[tauri::command]
pub async fn voice_stop(
    core: State<'_, Arc<Core>>,
    shell: State<'_, Shell>,
    dict: State<'_, Dictation>,
) -> CmdResult<Transcript> {
    let voice_settings = core.settings().map_err(|e| format!("{e:#}"))?.voice;
    let captured = finish_recording(&dict).await?;
    let auto_send = voice_settings.auto_send;
    let Some(captured) = captured else {
        return Ok(Transcript {
            text: String::new(),
            auto_send: false,
        });
    };
    let spec = voice::require_model(&voice_settings.model).map_err(|e| e.to_string())?;
    let path = voice::model_path(&shell.data_dir, spec);
    if !voice::is_installed(&shell.data_dir, spec) {
        return Err("The dictation model isn't downloaded yet".into());
    }

    if !dict.reaper_started.swap(true, Ordering::Relaxed) {
        start_reaper(dict.model.clone(), dict.transcribing.clone());
    }
    let model = dict.model.clone();
    let busy = dict.transcribing.clone();
    busy.store(true, Ordering::Relaxed);
    let language = if !spec.multilingual {
        Some("en".to_string())
    } else if voice_settings.language == "auto" {
        None
    } else {
        Some(voice_settings.language.clone())
    };
    let model_id = spec.id.to_string();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let audio =
            voice::resample_to_16k(&voice::downmix(&captured.mono, 1), captured.sample_rate);
        if audio.len() < MIN_SAMPLES_16K {
            return Ok(String::new());
        }
        let ctx = {
            let mut slot = model.lock();
            match slot.as_mut() {
                Some(l) if l.model_id == model_id => {
                    l.last_used = Instant::now();
                    l.ctx.clone()
                }
                _ => {
                    *slot = None;
                    let ctx = Arc::new(
                        WhisperContext::new_with_params(&path, WhisperContextParameters::default())
                            .map_err(|e| format!("Couldn't load the speech model: {e}"))?,
                    );
                    *slot = Some(Loaded {
                        model_id: model_id.clone(),
                        ctx: ctx.clone(),
                        last_used: Instant::now(),
                    });
                    ctx
                }
            }
        };
        let text = transcribe(&ctx, &audio, language.as_deref());
        if let Some(l) = model.lock().as_mut() {
            l.last_used = Instant::now();
        }
        text
    })
    .await;
    busy.store(false, Ordering::Relaxed);
    let text = result.map_err(|e| e.to_string())??;
    Ok(Transcript {
        auto_send: auto_send && !text.is_empty(),
        text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_speech_markers_are_dropped() {
        assert_eq!(clean_transcript(" [BLANK_AUDIO] "), "");
        assert_eq!(clean_transcript("(silence)"), "");
        assert_eq!(clean_transcript("  hello \n world "), "hello world");
        assert_eq!(clean_transcript("Use [x] here"), "Use [x] here");
    }

    /// Needs a model: ARMADA_TEST_WHISPER_MODEL=/path/ggml-tiny.en.bin and a 16 kHz
    /// mono 16-bit WAV in ARMADA_TEST_WAV. Run with `-- --ignored`.
    #[test]
    #[ignore]
    fn transcribes_a_wav() {
        let model = std::env::var("ARMADA_TEST_WHISPER_MODEL").expect("model path");
        let wav = std::fs::read(std::env::var("ARMADA_TEST_WAV").expect("wav path")).unwrap();
        let samples: Vec<f32> = wav[44..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| i16::from_le_bytes(*b) as f32 / 32768.0)
            .collect();
        let ctx =
            WhisperContext::new_with_params(&model, WhisperContextParameters::default()).unwrap();
        let text = transcribe(&ctx, &samples, Some("en")).unwrap();
        println!("TRANSCRIPT: {text}");
        assert!(!text.is_empty());
    }
}
