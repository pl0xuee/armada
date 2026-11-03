//! Wake phrase: listens on this computer for the user's phrase ("Hey Kvistcode") and starts
//! the voice assistant, or wakes a paused one. Nothing leaves the computer: the microphone
//! is cut into utterances by loudness and each one is transcribed by the local dictation
//! model, then matched by sound (`kvistcode_core::wake`). Off by default. While the
//! assistant is listening or the user dictates, the microphone is theirs and this waits.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, StreamTrait};
use kvistcode_core::{voice, wake, Core, Settings};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{Emitter, Manager, State};
use tracing::{info, warn};
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

use crate::dictation::{mic_error, Dictation};
use crate::state::Shell;
use crate::voice_assistant::VoiceAssistant;
use crate::AppHandle;

pub const STATUS_EVENT: &str = "va-wake-status";
pub const WAKE_EVENT: &str = "va-wake";
/// The smallest English model: quick enough to transcribe every utterance as it happens.
pub const PREFERRED_MODEL: &str = "tiny.en";
/// How often the microphone's audio is taken and looked at.
const TICK: Duration = Duration::from_millis(100);
/// Before opening the microphone again after it failed.
const MIC_RETRY: Duration = Duration::from_secs(10);
/// The phrase isn't heard again this soon after it started the assistant.
const COOLDOWN_SECS: u32 = 4;
/// Audio kept while a transcription runs; more than this is dropped, not queued.
const MAX_BUFFER_SECS: usize = 20;
/// whisper.cpp returns nothing for less than a second of audio, so shorter pieces are padded.
const MIN_INPUT_16K: usize = voice::WHISPER_SAMPLE_RATE as usize * 11 / 10;
/// A segment the model itself rates as probably not speech is ignored.
const NO_SPEECH_THRESHOLD: f32 = 0.6;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WakeState {
    #[default]
    Off,
    /// On, but no speech model is downloaded.
    NeedsModel,
    Starting,
    Listening,
    /// The assistant or dictation has the microphone.
    Waiting,
    Error,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeStatus {
    pub state: WakeState,
    pub phrase: String,
    /// The model in use, or the one to download.
    pub model: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Serialize)]
struct WakeEvent {
    request: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct Config {
    phrase: String,
    model: &'static str,
    language: String,
    input_device: Option<String>,
}

enum Desired {
    Off,
    NeedsModel,
    Listen(Config),
}

struct Running {
    config: Config,
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

#[derive(Default)]
struct Inner {
    running: Option<Running>,
    status: WakeStatus,
}

#[derive(Default)]
pub struct WakeWord {
    inner: Mutex<Inner>,
}

/// The installed model the listener would use: the small English one if it is there,
/// else whatever dictation uses.
pub fn model_for(settings: &Settings, data_dir: &Path) -> Option<&'static voice::ModelSpec> {
    [PREFERRED_MODEL, settings.voice.model.as_str()]
        .into_iter()
        .filter_map(voice::model_spec)
        .find(|spec| voice::is_installed(data_dir, spec))
}

/// The phrase that wakes the assistant, when the listener can actually hear it.
pub fn ready_phrase(settings: &Settings, data_dir: &Path) -> Option<String> {
    let va = &settings.voice_assistant;
    (va.enabled && va.wake_word && model_for(settings, data_dir).is_some())
        .then(|| tidy(&va.wake_phrase))
}

fn tidy(phrase: &str) -> String {
    phrase.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn desired(settings: &Settings, data_dir: &Path) -> Desired {
    let va = &settings.voice_assistant;
    if !va.enabled || !va.wake_word || wake::wake_phrase_problem(&va.wake_phrase).is_some() {
        return Desired::Off;
    }
    let Some(spec) = model_for(settings, data_dir) else {
        return Desired::NeedsModel;
    };
    // Short clips are too little to tell the language from, so it is never guessed.
    let language = if !spec.multilingual || settings.voice.language == "auto" {
        "en".to_string()
    } else {
        settings.voice.language.clone()
    };
    Desired::Listen(Config {
        phrase: tidy(&va.wake_phrase),
        model: spec.id,
        language,
        input_device: settings.voice.input_device.clone(),
    })
}

impl WakeWord {
    fn set_status(&self, app: &AppHandle, status: WakeStatus) {
        let mut inner = self.inner.lock();
        if inner.status != status {
            inner.status = status.clone();
            drop(inner);
            let _ = app.emit(STATUS_EVENT, status);
        }
    }

    /// From a listener thread: ignored once that thread has been replaced or stopped.
    fn publish(&self, app: &AppHandle, stop: &Arc<AtomicBool>, status: WakeStatus) {
        let mut inner = self.inner.lock();
        let current = inner
            .running
            .as_ref()
            .is_some_and(|r| Arc::ptr_eq(&r.stop, stop));
        if current && inner.status != status {
            inner.status = status.clone();
            drop(inner);
            let _ = app.emit(STATUS_EVENT, status);
        }
    }

    fn stop(&self) {
        if let Some(r) = self.inner.lock().running.take() {
            r.stop.store(true, Ordering::Relaxed);
        }
    }
}

/// Starts, restarts or stops the listener to match the settings and the installed models.
/// Called at startup, after settings are saved and after a model is downloaded or deleted.
pub fn apply(app: &AppHandle) {
    let (Some(ww), Some(core), Some(shell)) = (
        app.try_state::<WakeWord>(),
        app.try_state::<Core>(),
        app.try_state::<Shell>(),
    ) else {
        return;
    };
    let settings = match core.settings() {
        Ok(s) => s,
        Err(e) => {
            warn!("wake phrase: could not load settings: {e:#}");
            return;
        }
    };
    let phrase = tidy(&settings.voice_assistant.wake_phrase);
    let desired = desired(&settings, &shell.data_dir);
    let mut inner = ww.inner.lock();
    if let (Desired::Listen(cfg), Some(r)) = (&desired, inner.running.as_ref()) {
        if r.config == *cfg && !r.thread.is_finished() {
            return;
        }
    }
    // The old thread lets go of the microphone within a tick.
    if let Some(r) = inner.running.take() {
        r.stop.store(true, Ordering::Relaxed);
    }
    let status = match desired {
        Desired::Off => WakeStatus {
            phrase,
            ..Default::default()
        },
        Desired::NeedsModel => WakeStatus {
            state: WakeState::NeedsModel,
            phrase,
            model: Some(PREFERRED_MODEL.into()),
            message: None,
        },
        Desired::Listen(config) => {
            let status = WakeStatus {
                state: WakeState::Starting,
                phrase: config.phrase.clone(),
                model: Some(config.model.into()),
                message: None,
            };
            let stop = Arc::new(AtomicBool::new(false));
            let thread_app = app.clone();
            let thread_cfg = config.clone();
            let thread_stop = stop.clone();
            let data_dir = shell.data_dir.clone();
            match std::thread::Builder::new()
                .name("kvistcode-wake".into())
                .spawn(move || listen(thread_app, thread_cfg, data_dir, thread_stop))
            {
                Ok(thread) => {
                    inner.running = Some(Running {
                        config,
                        stop,
                        thread,
                    });
                    status
                }
                Err(e) => WakeStatus {
                    state: WakeState::Error,
                    message: Some(format!("Couldn't start listening: {e}")),
                    ..status
                },
            }
        }
    };
    drop(inner);
    ww.set_status(app, status);
}

/// Lets go of the microphone (on quit and before an update installs).
pub fn shutdown(app: &AppHandle) {
    if let Some(ww) = app.try_state::<WakeWord>() {
        ww.stop();
    }
}

#[tauri::command]
pub fn va_wake_status(ww: State<'_, WakeWord>) -> WakeStatus {
    ww.inner.lock().status.clone()
}

// ---- the listener ----------------------------------------------------------------

/// Why the listener should leave the microphone alone right now.
fn mic_busy(app: &AppHandle) -> Option<&'static str> {
    if app
        .try_state::<VoiceAssistant>()
        .is_some_and(|va| va.holds_mic())
    {
        return Some("Paused while the assistant is listening.");
    }
    if app
        .try_state::<Dictation>()
        .is_some_and(|d| d.is_recording())
    {
        return Some("Paused while you dictate.");
    }
    None
}

fn load_model(data_dir: &Path, model: &str) -> Result<WhisperContext, String> {
    let spec = voice::require_model(model).map_err(|e| e.to_string())?;
    voice::verify_once(data_dir, spec).map_err(|_| {
        "The speech model file is damaged. Delete it and download it again in Settings > Voice."
            .to_string()
    })?;
    WhisperContext::new_with_params(
        voice::model_path(data_dir, spec),
        WhisperContextParameters::default(),
    )
    .map_err(|e| format!("Couldn't load the speech model: {e}"))
}

fn listen(app: AppHandle, cfg: Config, data_dir: std::path::PathBuf, stop: Arc<AtomicBool>) {
    let report = |state: WakeState, message: Option<String>| {
        if let Some(ww) = app.try_state::<WakeWord>() {
            ww.publish(
                &app,
                &stop,
                WakeStatus {
                    state,
                    phrase: cfg.phrase.clone(),
                    model: Some(cfg.model.into()),
                    message,
                },
            );
        }
    };
    let ctx = match load_model(&data_dir, cfg.model) {
        Ok(ctx) => ctx,
        Err(e) => {
            warn!("wake phrase: {e}");
            report(WakeState::Error, Some(e));
            return;
        }
    };
    let mut ear = match Ear::new(&ctx, &cfg) {
        Ok(ear) => ear,
        Err(e) => {
            report(WakeState::Error, Some(e));
            return;
        }
    };
    let mut live: Option<(Mic, Detector)> = None;
    let mut retry_at: Option<Instant> = None;
    while !stop.load(Ordering::Relaxed) {
        if let Some(why) = mic_busy(&app) {
            live = None;
            report(WakeState::Waiting, Some(why.into()));
            std::thread::sleep(TICK);
            continue;
        }
        if live.is_none() {
            if retry_at.is_some_and(|t| Instant::now() < t) {
                std::thread::sleep(TICK);
                continue;
            }
            match Mic::open(cfg.input_device.as_deref()) {
                Ok(mic) => {
                    let detector = Detector::new(mic.rate, &cfg.phrase);
                    live = Some((mic, detector));
                    retry_at = None;
                    report(WakeState::Listening, None);
                }
                Err(e) => {
                    warn!("wake phrase: {e}");
                    report(WakeState::Error, Some(e));
                    retry_at = Some(Instant::now() + MIC_RETRY);
                    continue;
                }
            }
        }
        std::thread::sleep(TICK);
        let Some((mic, detector)) = live.as_mut() else {
            continue;
        };
        let failure = mic.failure.lock().take();
        if let Some(e) = failure {
            warn!("wake phrase: microphone error: {e}");
            live = None;
            report(
                WakeState::Error,
                Some(mic_error("The microphone stopped", e)),
            );
            retry_at = Some(Instant::now() + MIC_RETRY);
            continue;
        }
        let samples = std::mem::take(&mut *mic.buf.lock());
        if let Some(heard) = detector.feed(&samples, &mut |audio| ear.hear(audio)) {
            trigger(&app, heard.request);
        }
    }
}

/// Starts the assistant (the window does, so it shows what is going on), or wakes the
/// paused one. What was said is never logged.
fn trigger(app: &AppHandle, request: Option<String>) {
    info!("wake phrase heard");
    if app
        .try_state::<VoiceAssistant>()
        .is_some_and(|va| va.wake(request.clone()))
    {
        return;
    }
    crate::window::reveal_main(app);
    if let Err(e) = app.emit(WAKE_EVENT, WakeEvent { request }) {
        warn!("could not send the wake phrase to the window: {e}");
    }
}

/// The microphone, as mono samples at its own rate. Opened and dropped on the listener
/// thread (a stream isn't Send everywhere).
struct Mic {
    _stream: cpal::Stream,
    buf: Arc<Mutex<Vec<f32>>>,
    failure: Arc<Mutex<Option<String>>>,
    rate: u32,
}

impl Mic {
    fn open(device_name: Option<&str>) -> Result<Mic, String> {
        let device = crate::dictation::pick_device(device_name)?;
        let config = device
            .default_input_config()
            .map_err(|e| mic_error("Couldn't read the microphone's settings", e))?;
        let (rate, channels) = (config.sample_rate(), config.channels() as usize);
        let buf = Arc::new(Mutex::new(Vec::new()));
        let failure = Arc::new(Mutex::new(None));
        let cap = rate as usize * MAX_BUFFER_SECS;
        let sink = {
            let buf = buf.clone();
            move |frames: &[f32]| {
                let mono = voice::downmix(frames, channels);
                let mut b = buf.lock();
                if b.len() + mono.len() <= cap {
                    b.extend_from_slice(&mono);
                }
            }
        };
        let on_err = {
            let failure = failure.clone();
            move |e: cpal::Error| {
                if !matches!(
                    e.kind(),
                    cpal::ErrorKind::Xrun
                        | cpal::ErrorKind::RealtimeDenied
                        | cpal::ErrorKind::DeviceChanged
                ) {
                    *failure.lock() = Some(e.to_string());
                }
            }
        };
        let cfg: cpal::StreamConfig = config.into();
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => build::<f32>(&device, cfg, sink, on_err),
            cpal::SampleFormat::I16 => build::<i16>(&device, cfg, sink, on_err),
            cpal::SampleFormat::U16 => build::<u16>(&device, cfg, sink, on_err),
            cpal::SampleFormat::I32 => build::<i32>(&device, cfg, sink, on_err),
            other => Err(format!("Unsupported microphone sample format: {other:?}")),
        }?;
        stream
            .play()
            .map_err(|e| mic_error("Couldn't start the microphone", e))?;
        Ok(Mic {
            _stream: stream,
            buf,
            failure,
            rate,
        })
    }
}

fn build<T>(
    device: &cpal::Device,
    cfg: cpal::StreamConfig,
    mut sink: impl FnMut(&[f32]) + Send + 'static,
    on_err: impl FnMut(cpal::Error) + Send + 'static,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    device
        .build_input_stream(
            cfg,
            move |d: &[T], _| {
                let f: Vec<f32> = d.iter().map(|s| s.to_sample::<f32>()).collect();
                sink(&f);
            },
            on_err,
            None,
        )
        .map_err(|e| mic_error("Couldn't open the microphone", e))
}

/// The speech model, set up for short utterances.
struct Ear {
    state: WhisperState,
    language: String,
    /// A sentence with the phrase in it, as the model's prompt. It steers the model toward
    /// spelling the phrase the way the user wrote it ("Kvistcode", not "Quist code").
    prompt: Vec<i32>,
    threads: i32,
}

impl Ear {
    fn new(ctx: &WhisperContext, cfg: &Config) -> Result<Ear, String> {
        let state = ctx
            .create_state()
            .map_err(|e| format!("Couldn't start the speech model: {e}"))?;
        // The prompt must not end with the phrase: the model takes the prompt as what was
        // just said, and then often leaves the phrase out of the transcript. Tested on
        // recorded clips, this prompt found the phrase far more often than the bare phrase.
        let prompt = ctx
            .tokenize(&format!("{}, open the project.", cfg.phrase), 64)
            .unwrap_or_default();
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(1, 4) as i32;
        Ok(Ear {
            state,
            language: cfg.language.clone(),
            prompt,
            threads,
        })
    }

    /// One utterance (16 kHz mono) to text; empty when nothing was understood.
    fn hear(&mut self, audio: &[f32]) -> String {
        let mut padded;
        let audio = if audio.len() < MIN_INPUT_16K {
            padded = audio.to_vec();
            padded.resize(MIN_INPUT_16K, 0.0);
            &padded[..]
        } else {
            audio
        };
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(self.threads);
        params.set_language(Some(&self.language));
        params.set_translate(false);
        params.set_no_context(true);
        params.set_single_segment(true);
        params.set_no_timestamps(true);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        // No retries at higher temperatures: a miss is cheaper than a slow guess.
        params.set_temperature_inc(0.0);
        params.set_tokens(&self.prompt);
        // The whole 30 s window is encoded: a shortened one is quicker but makes the model
        // repeat itself and miss the phrase.
        params.set_max_tokens(40);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        if self.state.full(params, audio).is_err() {
            return String::new();
        }
        let mut text = String::new();
        for i in 0..self.state.full_n_segments() {
            if let Some(seg) = self.state.get_segment(i) {
                if seg.no_speech_probability() > NO_SPEECH_THRESHOLD {
                    continue;
                }
                if let Ok(s) = seg.to_str_lossy() {
                    text.push_str(&s);
                }
            }
        }
        text
    }
}

/// What the detector heard: the phrase, and maybe a request after it.
#[derive(Debug, PartialEq)]
struct Heard {
    request: Option<String>,
}

/// Turns microphone audio into wake decisions. Time is counted in audio fed, so the
/// evaluation below sees exactly what the live listener does.
struct Detector {
    rate: u32,
    phrase: String,
    segmenter: wake::Segmenter,
    /// The start of the utterance in progress, and whether it began with the phrase.
    head: Option<(u64, Option<wake::WakeMatch>)>,
    fed: u64,
    quiet_until: u64,
    out: Vec<wake::Utterance>,
}

impl Detector {
    fn new(rate: u32, phrase: &str) -> Self {
        Detector {
            rate,
            phrase: phrase.to_string(),
            segmenter: wake::Segmenter::new(rate),
            head: None,
            fed: 0,
            quiet_until: 0,
            out: Vec::new(),
        }
    }

    /// `hear` transcribes 16 kHz audio.
    fn feed(&mut self, samples: &[f32], hear: &mut dyn FnMut(&[f32]) -> String) -> Option<Heard> {
        self.fed += samples.len() as u64;
        self.segmenter.push(samples, &mut self.out);
        let mut heard = None;
        for utterance in std::mem::take(&mut self.out) {
            if heard.is_some() || self.fed < self.quiet_until {
                continue;
            }
            match utterance {
                wake::Utterance::Head { id, audio } => {
                    let text = hear(&voice::resample_to_16k(&audio, self.rate));
                    self.head = Some((id, wake::match_wake(&text, &self.phrase)));
                }
                wake::Utterance::Done { id, audio } => {
                    let head = self.head.take().filter(|(h, _)| *h == id);
                    // A long utterance that didn't start with the phrase isn't one.
                    if matches!(head, Some((_, None))) {
                        continue;
                    }
                    let text = hear(&voice::resample_to_16k(&audio, self.rate));
                    let found = wake::match_wake(&text, &self.phrase).or(head.and_then(|h| h.1));
                    if let Some(m) = found {
                        heard = Some(Heard { request: m.request });
                    }
                }
            }
        }
        if heard.is_some() {
            self.segmenter.reset();
            self.head = None;
            self.quiet_until = self.fed + u64::from(self.rate) * u64::from(COOLDOWN_SECS);
        }
        heard
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, secs: f32, amp: f32) -> Vec<f32> {
        (0..(rate as f32 * secs) as usize)
            .map(|i| amp * (i as f32 * 0.07).sin())
            .collect()
    }

    /// Feeds `audio` in ticks and returns what was heard and how many times the model ran.
    fn run(det: &mut Detector, audio: &[f32], texts: &mut Vec<&str>) -> (Vec<Heard>, usize) {
        let mut heard = Vec::new();
        let mut calls = 0;
        let tick = det.rate as usize / 10;
        for chunk in audio.chunks(tick) {
            let mut hear = |_: &[f32]| {
                calls += 1;
                if texts.is_empty() {
                    String::new()
                } else {
                    texts.remove(0).to_string()
                }
            };
            if let Some(h) = det.feed(chunk, &mut hear) {
                heard.push(h);
            }
        }
        (heard, calls)
    }

    /// Syllables with short gaps, then a pause (a steady tone would be learned as a hum).
    fn speech_then_pause(rate: u32, secs: f32) -> Vec<f32> {
        let mut a = vec![0.0; rate as usize / 2];
        let mut said = Vec::new();
        while (said.len() as f32) < rate as f32 * secs {
            said.extend(tone(rate, 0.24, 0.3));
            said.extend(vec![0.0; rate as usize * 6 / 100]);
        }
        said.truncate((rate as f32 * secs) as usize);
        a.extend(said);
        a.extend(vec![0.0; rate as usize]);
        a
    }

    #[test]
    fn a_short_utterance_with_the_phrase_wakes_with_the_request() {
        let mut det = Detector::new(16_000, "Hey Kvistcode");
        let mut texts = vec!["Hey Kvistcode, what are the agents doing?"];
        let (heard, calls) = run(&mut det, &speech_then_pause(16_000, 1.5), &mut texts);
        assert_eq!(calls, 1);
        assert_eq!(
            heard,
            vec![Heard {
                request: Some("what are the agents doing?".into())
            }]
        );
    }

    #[test]
    fn other_talk_does_not_wake() {
        let mut det = Detector::new(48_000, "Hey Kvistcode");
        let mut texts = vec!["Can you pass the salt?"];
        let (heard, calls) = run(&mut det, &speech_then_pause(48_000, 1.5), &mut texts);
        assert_eq!(calls, 1);
        assert!(heard.is_empty());
    }

    #[test]
    fn a_long_utterance_is_judged_by_its_start() {
        // Doesn't start with the phrase: the whole is never transcribed.
        let mut det = Detector::new(16_000, "Hey Kvistcode");
        let mut texts = vec!["So I told him about the meeting and"];
        let (heard, calls) = run(&mut det, &speech_then_pause(16_000, 5.0), &mut texts);
        assert!(heard.is_empty());
        assert_eq!(calls, 1);

        // Starts with it: the whole is transcribed for the request.
        let mut det = Detector::new(16_000, "Hey Kvistcode");
        let mut texts = vec![
            "Hey Kvistcode, start an agent",
            "Hey Kvistcode, start an agent in the web project that fixes the login page.",
        ];
        let (heard, calls) = run(&mut det, &speech_then_pause(16_000, 5.0), &mut texts);
        assert_eq!(calls, 2);
        assert_eq!(
            heard[0].request.as_deref(),
            Some("start an agent in the web project that fixes the login page.")
        );

        // The whole came out differently: the start's match still counts.
        let mut det = Detector::new(16_000, "Hey Kvistcode");
        let mut texts = vec![
            "Hey Kvistcode, start an agent",
            "Hey, this code start an agent",
        ];
        let (heard, _) = run(&mut det, &speech_then_pause(16_000, 5.0), &mut texts);
        assert_eq!(heard[0].request.as_deref(), Some("start an agent"));
    }

    #[test]
    fn the_phrase_is_not_heard_twice_in_a_row() {
        let mut det = Detector::new(16_000, "Hey Kvistcode");
        let mut audio = speech_then_pause(16_000, 1.0);
        audio.extend(speech_then_pause(16_000, 1.0));
        let mut texts = vec!["Hey Kvistcode", "Hey Kvistcode"];
        let (heard, calls) = run(&mut det, &audio, &mut texts);
        assert_eq!(heard.len(), 1);
        assert_eq!(calls, 1, "nothing is transcribed during the cooldown");

        // After the cooldown it is heard again.
        audio = vec![0.0; 16_000 * 3];
        audio.extend(speech_then_pause(16_000, 1.0));
        let mut texts = vec!["Hey Kvistcode"];
        let (heard, _) = run(&mut det, &audio, &mut texts);
        assert_eq!(heard.len(), 1);
    }

    fn settings_with(enabled: bool, wake_word: bool, phrase: &str) -> Settings {
        let mut s = Settings::default();
        s.voice_assistant.enabled = enabled;
        s.voice_assistant.wake_word = wake_word;
        s.voice_assistant.wake_phrase = phrase.into();
        s
    }

    #[test]
    fn listens_only_when_on_with_a_model() {
        let tmp = std::env::temp_dir().join(format!("kvistcode-wake-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let dir = Scratch(tmp);
        let off = settings_with(true, false, "Hey Kvistcode");
        assert!(matches!(desired(&off, dir.path()), Desired::Off));
        let va_off = settings_with(false, true, "Hey Kvistcode");
        assert!(matches!(desired(&va_off, dir.path()), Desired::Off));
        let bad = settings_with(true, true, "Kvistcode");
        assert!(matches!(desired(&bad, dir.path()), Desired::Off));
        let on = settings_with(true, true, "  Hey   Kvistcode ");
        assert!(matches!(desired(&on, dir.path()), Desired::NeedsModel));
        assert_eq!(ready_phrase(&on, dir.path()), None);

        // A model file of the right size counts as installed.
        let spec = voice::model_spec(PREFERRED_MODEL).unwrap();
        let path = voice::model_path(dir.path(), spec);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::File::create(&path)
            .unwrap()
            .set_len(spec.size_bytes)
            .unwrap();
        let Desired::Listen(cfg) = desired(&on, dir.path()) else {
            panic!("should listen");
        };
        assert_eq!(cfg.phrase, "Hey Kvistcode");
        assert_eq!(cfg.model, PREFERRED_MODEL);
        assert_eq!(cfg.language, "en");
        assert_eq!(
            ready_phrase(&on, dir.path()).as_deref(),
            Some("Hey Kvistcode")
        );
    }

    /// 16-bit PCM mono WAV to samples (the test clips; anything else is refused).
    fn read_wav(path: &Path) -> (u32, Vec<f32>) {
        let b = std::fs::read(path).unwrap();
        assert_eq!(&b[0..4], b"RIFF", "{}", path.display());
        let (mut pos, mut rate, mut data) = (12, 0, None);
        while pos + 8 <= b.len() {
            let len = u32::from_le_bytes(b[pos + 4..pos + 8].try_into().unwrap()) as usize;
            let body = &b[pos + 8..(pos + 8 + len).min(b.len())];
            match &b[pos..pos + 4] {
                b"fmt " => {
                    assert_eq!(u16::from_le_bytes([body[2], body[3]]), 1, "mono only");
                    assert_eq!(u16::from_le_bytes([body[14], body[15]]), 16, "16-bit only");
                    rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
                }
                b"data" => data = Some(body),
                _ => {}
            }
            pos += 8 + len + (len & 1);
        }
        let samples = data
            .unwrap()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| i16::from_le_bytes(*c) as f32 / 32768.0)
            .collect();
        (rate, samples)
    }

    struct Timed<'a> {
        ear: &'a mut Ear,
        calls: usize,
        spent: Duration,
        texts: Vec<String>,
    }

    impl Timed<'_> {
        fn hear(&mut self, audio: &[f32]) -> String {
            let t = Instant::now();
            let text = self.ear.hear(audio);
            self.spent += t.elapsed();
            self.calls += 1;
            self.texts.push(text.clone());
            text
        }
    }

    /// Feeds audio in ticks like the live listener; returns (seconds into the audio, request)
    /// for each time the phrase was heard.
    fn detect(timed: &mut Timed, rate: u32, audio: &[f32]) -> Vec<(f32, Option<String>)> {
        let mut det = Detector::new(rate, "Hey Kvistcode");
        let mut found = Vec::new();
        for chunk in audio.chunks(rate as usize / 10) {
            if let Some(h) = det.feed(chunk, &mut |a| timed.hear(a)) {
                found.push((det.fed as f32 / rate as f32, h.request));
            }
        }
        found
    }

    fn wavs(dir: &Path) -> Vec<std::path::PathBuf> {
        let mut v: Vec<_> = std::fs::read_dir(dir)
            .map(|d| d.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        v.retain(|p| p.extension().is_some_and(|x| x == "wav"));
        v.sort();
        v
    }

    /// Accuracy and speed on recorded speech. Needs KVISTCODE_WAKE_EVAL_MODEL (a ggml
    /// model file) and KVISTCODE_WAKE_EVAL_DIR with `pos/` and `neg/` clips (16 kHz mono
    /// 16-bit WAV; positives say the phrase) and optionally `long/*.json` mixes listing
    /// their clips. KVISTCODE_WAKE_EVAL_NOPROMPT=1 drops the phrase prompt.
    /// Run with `-- --ignored --nocapture wake_eval`.
    #[test]
    #[ignore]
    fn wake_eval() {
        let model = std::env::var("KVISTCODE_WAKE_EVAL_MODEL").expect("model path");
        let dir = std::path::PathBuf::from(std::env::var("KVISTCODE_WAKE_EVAL_DIR").expect("dir"));
        let ctx =
            WhisperContext::new_with_params(&model, WhisperContextParameters::default()).unwrap();
        let cfg = Config {
            phrase: "Hey Kvistcode".into(),
            model: PREFERRED_MODEL,
            language: "en".into(),
            input_device: None,
        };
        let mut ear = Ear::new(&ctx, &cfg).unwrap();
        if std::env::var("KVISTCODE_WAKE_EVAL_NOPROMPT").is_ok() {
            ear.prompt.clear();
        }
        let mut timed = Timed {
            ear: &mut ear,
            calls: 0,
            spent: Duration::ZERO,
            texts: Vec::new(),
        };
        let mut audio_secs = 0.0f32;
        for (kind, want) in [("pos", true), ("neg", false)] {
            let (mut right, mut total) = (0, 0);
            for path in wavs(&dir.join(kind)) {
                let (rate, clip) = read_wav(&path);
                let mut audio = vec![0.0; rate as usize / 2];
                audio.extend(clip);
                audio.extend(vec![0.0; rate as usize * 6 / 5]);
                audio_secs += audio.len() as f32 / rate as f32;
                timed.texts.clear();
                let found = detect(&mut timed, rate, &audio);
                total += 1;
                let ok = found.is_empty() != want;
                right += usize::from(ok);
                println!(
                    "{} {kind} {:<52} heard {:?} -> {:?}",
                    if ok { "  " } else { "XX" },
                    path.file_name().unwrap().to_string_lossy(),
                    timed.texts,
                    found.first().map(|f| &f.1),
                );
            }
            println!("== {kind}: {right}/{total} right\n");
        }
        for json in std::fs::read_dir(dir.join("long"))
            .into_iter()
            .flatten()
            .flatten()
        {
            let path = json.path();
            if path.extension().is_none_or(|x| x != "json") {
                continue;
            }
            let meta: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let clips = meta["clips"].as_array().unwrap();
            for key in ["clean_file", "noisy_file"] {
                let (rate, audio) = read_wav(&dir.join("long").join(meta[key].as_str().unwrap()));
                audio_secs += audio.len() as f32 / rate as f32;
                timed.texts.clear();
                let found = detect(&mut timed, rate, &audio);
                let mut hit = vec![false; clips.len()];
                let mut false_alarms = Vec::new();
                for (t, _) in &found {
                    // The clip that was playing (or had just ended) when the phrase was heard.
                    let i = clips
                        .iter()
                        .rposition(|c| c["start"].as_f64().unwrap() as f32 <= *t)
                        .unwrap_or(0);
                    if clips[i]["positive"].as_bool().unwrap() {
                        hit[i] = true;
                    } else {
                        false_alarms.push(clips[i]["text"].as_str().unwrap().to_string());
                    }
                }
                // A positive right after a wake is inside the cooldown and can't count.
                let mut missed = Vec::new();
                let mut positives = 0;
                for (i, c) in clips.iter().enumerate() {
                    let start = c["start"].as_f64().unwrap() as f32;
                    let cooled = found
                        .iter()
                        .any(|(t, _)| start > *t - 2.0 && start < *t + COOLDOWN_SECS as f32);
                    if c["positive"].as_bool().unwrap() && !(cooled && !hit[i]) {
                        positives += 1;
                        if !hit[i] {
                            missed.push(c["file"].as_str().unwrap().to_string());
                        }
                    }
                }
                println!(
                    "== {} {key}: {}/{positives} found, false alarms {false_alarms:?}, missed {missed:?}",
                    path.file_name().unwrap().to_string_lossy(),
                    positives - missed.len(),
                );
            }
        }
        println!(
            "== model ran {} times, {:.0} ms each on average, {:.3} s of compute per s of audio",
            timed.calls,
            timed.spent.as_secs_f32() * 1000.0 / timed.calls.max(1) as f32,
            timed.spent.as_secs_f32() / audio_secs,
        );
    }

    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
