//! Audio for the voice assistant: PCM16 helpers, the playback jitter buffer, and the
//! device layer behind the [`AudioDevices`] trait (cpal capture + rodio playback in
//! production, a null device in tests).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use cpal::traits::{DeviceTrait, StreamTrait};
use parking_lot::Mutex;
use rodio::{ChannelCount, Player, SampleRate, Source};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tracing::warn;

use super::protocol::SAMPLE_RATE;

/// Mic chunks sent to OpenAI: 40 ms.
pub const CHUNK_SAMPLES: usize = (SAMPLE_RATE as usize) / 25;
/// Playback waits for this much audio before starting a burst (absorbs network jitter).
const PREBUFFER_SAMPLES: usize = (SAMPLE_RATE as usize) * 120 / 1000;
/// ...but never longer than this for a short tail.
const PREBUFFER_MAX_WAIT: Duration = Duration::from_millis(150);

// ---- PCM helpers ---------------------------------------------------------------------

pub fn f32_to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|s| (s.clamp(-1.0, 1.0) * 32767.0).round() as i16)
        .collect()
}

pub fn pcm16_to_base64(samples: &[i16]) -> String {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn base64_to_pcm16(b64: &str) -> Result<Vec<i16>, base64::DecodeError> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64)?;
    #[allow(clippy::chunks_exact_to_as_chunks)]
    Ok(bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect())
}

/// Peak level 0..=1 of a block, shaped like the dictation meter.
pub fn level_i16(samples: &[i16]) -> f32 {
    let f: Vec<f32> = samples.iter().map(|s| *s as f32 / 32768.0).collect();
    armada_core::voice::meter_level(&f)
}

/// Streaming mono resampler to [`SAMPLE_RATE`]: averages the span each output sample
/// covers when downsampling and interpolates linearly when upsampling. Keeps its
/// fractional position across calls so chunk boundaries are seamless.
pub struct StreamResampler {
    ratio: f64,
    buf: Vec<f32>,
    pos: f64,
}

impl StreamResampler {
    pub fn new(from_rate: u32) -> Self {
        StreamResampler {
            ratio: from_rate.max(1) as f64 / SAMPLE_RATE as f64,
            buf: Vec::new(),
            pos: 0.0,
        }
    }

    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        self.buf.extend_from_slice(input);
        let mut out = Vec::new();
        if self.ratio > 1.0 {
            while self.pos + self.ratio <= self.buf.len() as f64 {
                let (start, end) = (self.pos, self.pos + self.ratio);
                let (a, b) = (
                    start.floor() as usize,
                    (end.ceil() as usize).min(self.buf.len()),
                );
                let (mut sum, mut weight) = (0.0f64, 0.0f64);
                for (j, s) in self.buf[a..b].iter().enumerate() {
                    let idx = (a + j) as f64;
                    let w = (idx + 1.0).min(end) - idx.max(start);
                    if w > 0.0 {
                        sum += *s as f64 * w;
                        weight += w;
                    }
                }
                out.push(if weight > 0.0 {
                    (sum / weight) as f32
                } else {
                    0.0
                });
                self.pos += self.ratio;
            }
        } else {
            while (self.pos.floor() as usize) + 1 < self.buf.len() {
                let a = self.pos.floor() as usize;
                let frac = (self.pos - a as f64) as f32;
                out.push(self.buf[a] + (self.buf[a + 1] - self.buf[a]) * frac);
                self.pos += self.ratio;
            }
        }
        let drop = (self.pos.floor() as usize).min(self.buf.len());
        self.buf.drain(..drop);
        self.pos -= drop as f64;
        out
    }
}

/// Mic callback side: downmix, resample, quantize, and emit 40 ms PCM16 chunks.
pub struct MicEncoder {
    channels: usize,
    resampler: StreamResampler,
    pending: Vec<i16>,
    tx: UnboundedSender<Vec<i16>>,
}

impl MicEncoder {
    pub fn new(channels: usize, rate: u32, tx: UnboundedSender<Vec<i16>>) -> Self {
        MicEncoder {
            channels,
            resampler: StreamResampler::new(rate),
            pending: Vec::new(),
            tx,
        }
    }

    pub fn push(&mut self, interleaved: &[f32]) {
        let mono = armada_core::voice::downmix(interleaved, self.channels);
        let resampled = self.resampler.process(&mono);
        self.pending.extend(f32_to_i16(&resampled));
        while self.pending.len() >= CHUNK_SAMPLES {
            let chunk: Vec<i16> = self.pending.drain(..CHUNK_SAMPLES).collect();
            if self.tx.send(chunk).is_err() {
                self.pending.clear();
                return;
            }
        }
    }
}

// ---- playback buffer -----------------------------------------------------------------

/// Decoded assistant audio waiting to be played. The device pulls from it; the session
/// pushes into it and reads the counters for barge-in. Holds no device, so tests drive
/// it directly with [`SpeakerBuffer::pull`].
#[derive(Default)]
pub struct SpeakerBuffer {
    inner: Mutex<Ring>,
    pushed: AtomicU64,
    played: AtomicU64,
    level: AtomicU32,
}

#[derive(Default)]
struct Ring {
    q: VecDeque<i16>,
    /// Waiting for the jitter buffer to fill.
    gated: bool,
    first_push: Option<Instant>,
}

impl SpeakerBuffer {
    pub fn new() -> Arc<Self> {
        Arc::new(SpeakerBuffer {
            inner: Mutex::new(Ring {
                gated: true,
                ..Default::default()
            }),
            ..Default::default()
        })
    }

    pub fn push(&self, samples: &[i16]) {
        let mut r = self.inner.lock();
        if r.first_push.is_none() {
            r.first_push = Some(Instant::now());
        }
        r.q.extend(samples.iter().copied());
        self.pushed
            .fetch_add(samples.len() as u64, Ordering::SeqCst);
    }

    /// Drops everything queued (barge-in). Afterwards `pushed == played`.
    pub fn clear(&self) {
        let mut r = self.inner.lock();
        r.q.clear();
        r.gated = true;
        r.first_push = None;
        self.pushed
            .store(self.played.load(Ordering::SeqCst), Ordering::SeqCst);
    }

    /// Total samples ever queued (minus any cleared).
    pub fn pushed(&self) -> u64 {
        self.pushed.load(Ordering::SeqCst)
    }

    /// Total samples the device has consumed.
    pub fn played(&self) -> u64 {
        self.played.load(Ordering::SeqCst)
    }

    pub fn queued(&self) -> usize {
        self.inner.lock().q.len()
    }

    /// Output loudness 0..=1 of the most recent pull.
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }

    /// Fills `out` with audio, or silence while gated / underrun.
    pub fn pull(&self, out: &mut [f32]) {
        let mut r = self.inner.lock();
        if r.gated {
            let waited = r
                .first_push
                .is_some_and(|t| t.elapsed() >= PREBUFFER_MAX_WAIT);
            if r.q.len() >= PREBUFFER_SAMPLES || (waited && !r.q.is_empty()) {
                r.gated = false;
            }
        }
        let mut n = 0;
        if !r.gated {
            while n < out.len() {
                match r.q.pop_front() {
                    Some(s) => {
                        out[n] = s as f32 / 32768.0;
                        n += 1;
                    }
                    None => break,
                }
            }
            if r.q.is_empty() && n < out.len() {
                r.gated = true;
                r.first_push = None;
            }
        }
        out[n..].fill(0.0);
        self.played.fetch_add(n as u64, Ordering::SeqCst);
        let peak = out[..n].iter().fold(0.0f32, |m, s| m.max(s.abs()));
        self.level
            .store((peak * 1.5).clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }
}

// ---- devices -------------------------------------------------------------------------

/// What a session needs from the audio hardware.
pub struct AudioIo {
    /// 40 ms mono PCM16 chunks at 24 kHz. Closes if the microphone fails.
    pub mic: UnboundedReceiver<Vec<i16>>,
    pub speaker: Arc<SpeakerBuffer>,
    /// Dropping this releases the devices.
    pub _guard: Box<dyn Send>,
}

pub trait AudioDevices: Send {
    fn open(&mut self) -> Result<AudioIo, String>;
}

struct StopOnDrop(Arc<AtomicBool>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// The real microphone and speakers.
pub struct SystemAudio {
    pub input_device: Option<String>,
}

impl AudioDevices for SystemAudio {
    fn open(&mut self) -> Result<AudioIo, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let guard = StopOnDrop(stop.clone());
        let (tx, rx) = unbounded_channel();
        start_mic(self.input_device.clone(), tx, stop.clone())?;
        let speaker = SpeakerBuffer::new();
        start_speaker(speaker.clone(), stop)?;
        Ok(AudioIo {
            mic: rx,
            speaker,
            _guard: Box::new(guard),
        })
    }
}

fn start_mic(
    device_name: Option<String>,
    tx: UnboundedSender<Vec<i16>>,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("armada-va-mic".into())
        .spawn(move || {
            // The stream is created and dropped on this thread (it isn't Send everywhere).
            let setup = (|| {
                let device = crate::dictation::pick_device(device_name.as_deref())?;
                let config = device.default_input_config().map_err(|e| {
                    crate::dictation::mic_error("Couldn't read the microphone's settings", e)
                })?;
                let (rate, channels) = (config.sample_rate(), config.channels() as usize);
                let enc = MicEncoder::new(channels, rate, tx);
                let stop_on_err = stop.clone();
                let on_err = move |e: cpal::Error| {
                    if matches!(
                        e.kind(),
                        cpal::ErrorKind::Xrun
                            | cpal::ErrorKind::RealtimeDenied
                            | cpal::ErrorKind::DeviceChanged
                    ) {
                        return;
                    }
                    warn!("voice assistant microphone error: {e}");
                    stop_on_err.store(true, Ordering::SeqCst);
                };
                let cfg: cpal::StreamConfig = config.into();
                let stream = match config.sample_format() {
                    cpal::SampleFormat::F32 => build::<f32>(&device, cfg, enc, on_err),
                    cpal::SampleFormat::I16 => build::<i16>(&device, cfg, enc, on_err),
                    cpal::SampleFormat::U16 => build::<u16>(&device, cfg, enc, on_err),
                    cpal::SampleFormat::I32 => build::<i32>(&device, cfg, enc, on_err),
                    other => Err(format!("Unsupported microphone sample format: {other:?}")),
                }?;
                stream
                    .play()
                    .map_err(|e| crate::dictation::mic_error("Couldn't start the microphone", e))?;
                Ok::<_, String>(stream)
            })();
            match setup {
                Ok(stream) => {
                    let _ = ready_tx.send(Ok(()));
                    while !stop.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(60));
                    }
                    drop(stream);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            }
        })
        .map_err(|e| format!("Couldn't start audio capture: {e}"))?;
    ready_rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "The microphone didn't respond.".to_string())?
}

fn build<T>(
    device: &cpal::Device,
    cfg: cpal::StreamConfig,
    mut enc: MicEncoder,
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
                enc.push(&f);
            },
            on_err,
            None,
        )
        .map_err(|e| crate::dictation::mic_error("Couldn't open the microphone", e))
}

/// Endless mono source fed from the [`SpeakerBuffer`]; ends when `stop` is set.
struct RingSource {
    buf: Arc<SpeakerBuffer>,
    chunk: Vec<f32>,
    pos: usize,
    stop: Arc<AtomicBool>,
}

impl Iterator for RingSource {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        if self.pos >= self.chunk.len() {
            if self.stop.load(Ordering::Relaxed) {
                return None;
            }
            self.buf.pull(&mut self.chunk);
            self.pos = 0;
        }
        let s = self.chunk[self.pos];
        self.pos += 1;
        Some(s)
    }
}

impl Source for RingSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> ChannelCount {
        ChannelCount::new(1).expect("1 is non-zero")
    }
    fn sample_rate(&self) -> SampleRate {
        SampleRate::new(SAMPLE_RATE).expect("rate is non-zero")
    }
    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

fn start_speaker(buf: Arc<SpeakerBuffer>, stop: Arc<AtomicBool>) -> Result<(), String> {
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("armada-va-speaker".into())
        .spawn(move || {
            // The output stream lives on this thread for the whole session.
            let output = match crate::sound::Output::open() {
                Ok(o) => o,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("No audio output available: {e}")));
                    return;
                }
            };
            let player = Player::connect_new(output.stream.mixer());
            player.append(RingSource {
                buf,
                chunk: vec![0.0; 480],
                pos: 480,
                stop: stop.clone(),
            });
            let _ = ready_tx.send(Ok(()));
            while !stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(60));
            }
            player.stop();
        })
        .map_err(|e| format!("Couldn't start audio playback: {e}"))?;
    ready_rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "The audio output didn't respond.".to_string())?
}

/// A device-free [`AudioDevices`] for tests: playback just accumulates in the buffer.
#[cfg(test)]
pub struct NullAudio {
    pub speaker: Arc<SpeakerBuffer>,
    /// Feed extra microphone chunks to the session.
    pub mic_tx: UnboundedSender<Vec<i16>>,
    mic_rx: Option<UnboundedReceiver<Vec<i16>>>,
}

#[cfg(test)]
impl NullAudio {
    pub fn new() -> Self {
        let (mic_tx, mic_rx) = unbounded_channel();
        NullAudio {
            speaker: SpeakerBuffer::new(),
            mic_tx,
            mic_rx: Some(mic_rx),
        }
    }
}

#[cfg(test)]
impl AudioDevices for NullAudio {
    fn open(&mut self) -> Result<AudioIo, String> {
        let rx = self.mic_rx.take().ok_or("already open")?;
        // One chunk of silence, then the channel stays open (the guard owns a sender).
        let _ = self.mic_tx.send(vec![0i16; CHUNK_SAMPLES]);
        Ok(AudioIo {
            mic: rx,
            speaker: self.speaker.clone(),
            _guard: Box::new(self.mic_tx.clone()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_roundtrip() {
        let pcm = vec![0i16, 1, -1, 32767, -32768, 1234];
        assert_eq!(base64_to_pcm16(&pcm16_to_base64(&pcm)).unwrap(), pcm);
        assert_eq!(pcm16_to_base64(&[0x0201]), "AQI=");
    }

    #[test]
    fn quantizes_and_clamps() {
        assert_eq!(
            f32_to_i16(&[0.0, 1.0, -1.0, 2.0, -3.0]),
            vec![0, 32767, -32767, 32767, -32767]
        );
    }

    #[test]
    fn resamples_48k_to_24k_across_chunks() {
        let mut r = StreamResampler::new(48_000);
        let input: Vec<f32> = (0..4800).map(|i| (i as f32 * 0.01).sin()).collect();
        let mut out = Vec::new();
        for c in input.chunks(333) {
            out.extend(r.process(c));
        }
        assert!((out.len() as i64 - 2400).abs() <= 1, "{}", out.len());
        // Matches the one-shot result for a slow sine: average of adjacent samples.
        let expect = (input[0] + input[1]) / 2.0;
        assert!((out[0] - expect).abs() < 1e-5);
    }

    #[test]
    fn resamples_44100_and_16000() {
        for (rate, expect) in [(44_100u32, 2400f64), (16_000, 2400.0), (24_000, 2400.0)] {
            let mut r = StreamResampler::new(rate);
            let n = (rate as f64 / 10.0) as usize;
            let out = r.process(&vec![0.5; n]);
            assert!(
                (out.len() as f64 - expect).abs() <= 2.0,
                "{rate}: {}",
                out.len()
            );
            assert!(out.iter().all(|s| (s - 0.5).abs() < 1e-5));
        }
    }

    #[test]
    fn encoder_emits_40ms_chunks() {
        let (tx, mut rx) = unbounded_channel();
        let mut enc = MicEncoder::new(2, 48_000, tx);
        // 100 ms of stereo at 48 kHz.
        enc.push(&vec![0.25; 4800 * 2]);
        let mut chunks = 0;
        while let Ok(c) = rx.try_recv() {
            assert_eq!(c.len(), CHUNK_SAMPLES);
            chunks += 1;
        }
        assert_eq!(chunks, 2);
    }

    #[test]
    fn jitter_buffer_gates_then_plays_and_clears() {
        let b = SpeakerBuffer::new();
        let mut out = vec![0.0f32; 480];
        b.push(&vec![1000i16; 480]);
        // Below the prebuffer: silence, nothing consumed.
        b.pull(&mut out);
        assert!(out.iter().all(|s| *s == 0.0));
        assert_eq!(b.played(), 0);
        b.push(&vec![1000i16; PREBUFFER_SAMPLES]);
        b.pull(&mut out);
        assert!(out[0] > 0.0);
        assert_eq!(b.played(), 480);
        assert!(b.level() > 0.0);
        // Barge-in: queue dropped, counters realigned.
        b.clear();
        assert_eq!(b.queued(), 0);
        assert_eq!(b.pushed(), b.played());
        b.pull(&mut out);
        assert!(out.iter().all(|s| *s == 0.0));
    }
}
