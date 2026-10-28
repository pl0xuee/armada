//! Attention sounds. A dedicated thread owns the audio output stream (rodio
//! streams aren't `Send` on every platform); everyone else sends play requests.

use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use armada_core::{AttentionReason, SoundSettings};
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player};
use tracing::{debug, warn};

static PERMISSION_WAV: &[u8] = include_bytes!("../sounds/permission.wav");
static DONE_WAV: &[u8] = include_bytes!("../sounds/done.wav");
static ERROR_WAV: &[u8] = include_bytes!("../sounds/error.wav");

fn clip(reason: AttentionReason) -> &'static [u8] {
    match reason {
        AttentionReason::Permission => PERMISSION_WAV,
        AttentionReason::Done => DONE_WAV,
        AttentionReason::Error => ERROR_WAV,
    }
}

struct PlayRequest {
    reason: AttentionReason,
    volume: f32,
    /// User-chosen sound file; falls back to the built-in clip if it can't be played.
    custom: Option<PathBuf>,
}

/// The user's custom sound for `reason`, if one is configured.
pub fn custom_sound(settings: &SoundSettings, reason: AttentionReason) -> Option<PathBuf> {
    let path = match reason {
        AttentionReason::Permission => settings.custom_permission.as_deref(),
        AttentionReason::Done => settings.custom_done.as_deref(),
        AttentionReason::Error => settings.custom_error.as_deref(),
    }?;
    let path = path.trim();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// Custom sounds are short alerts; anything bigger is a mistake (or a device/FIFO
/// that would never finish reading) and isn't loaded into memory.
const MAX_CUSTOM_SOUND_BYTES: u64 = 10 * 1024 * 1024;

/// Reads a custom sound file, refusing anything that isn't a regular file of at most
/// [`MAX_CUSTOM_SOUND_BYTES`].
fn read_custom(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a regular file".into());
    }
    if meta.len() > MAX_CUSTOM_SOUND_BYTES {
        return Err(format!(
            "file is larger than {} MB",
            MAX_CUSTOM_SOUND_BYTES / (1024 * 1024)
        ));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    // `take` guards against the file growing between the size check and the read.
    std::fs::File::open(path)
        .and_then(|f| f.take(MAX_CUSTOM_SOUND_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_CUSTOM_SOUND_BYTES {
        return Err("file grew past the size limit while reading".into());
    }
    Ok(bytes)
}

/// Decodes the custom file (any supported format) or the built-in WAV.
fn decode(req: &PlayRequest) -> Option<Decoder<Cursor<Vec<u8>>>> {
    if let Some(path) = &req.custom {
        match read_custom(path) {
            Ok(bytes) => match Decoder::new(Cursor::new(bytes)) {
                Ok(d) => return Some(d),
                Err(e) => warn!(
                    "can't play {}: {e}; using the built-in sound",
                    path.display()
                ),
            },
            Err(e) => warn!(
                "can't use {}: {e}; using the built-in sound",
                path.display()
            ),
        }
    }
    match Decoder::new_wav(Cursor::new(clip(req.reason).to_vec())) {
        Ok(d) => Some(d),
        Err(e) => {
            warn!("could not decode sound: {e}");
            None
        }
    }
}

/// The same sound again within this window is dropped (several agents finishing at
/// once shouldn't stack the same chime).
const REPEAT_WINDOW: Duration = Duration::from_millis(400);
/// The output stream is closed after this long without sounds and reopened on the
/// next one, so it follows the current default device (headphones plugged in, AirPods
/// connected) instead of playing into one that's gone.
const IDLE_CLOSE: Duration = Duration::from_secs(45);

/// The open output stream, and whether it has reported an error since.
pub(crate) struct Output {
    pub(crate) stream: MixerDeviceSink,
    broken: Arc<AtomicBool>,
    last_used: Instant,
}

impl Output {
    pub(crate) fn open() -> Result<Output, String> {
        let broken = Arc::new(AtomicBool::new(false));
        let flag = broken.clone();
        let stream = DeviceSinkBuilder::from_default_device()
            .and_then(|b| {
                b.with_error_callback(move |e| {
                    warn!("audio output error: {e}");
                    flag.store(true, Ordering::SeqCst);
                })
                .open_stream()
            })
            // Unusual configurations: rodio's own fallbacks (no error tracking).
            .or_else(|_| DeviceSinkBuilder::open_default_sink())
            .map_err(|e| e.to_string())?;
        let mut stream = stream;
        stream.log_on_drop(false);
        Ok(Output {
            stream,
            broken,
            last_used: Instant::now(),
        })
    }

    fn usable(&self) -> bool {
        !self.broken.load(Ordering::SeqCst) && self.last_used.elapsed() < IDLE_CLOSE
    }
}

/// Plays one request on `output`. Decoding and mixing run third-party code on
/// arbitrary user files, so a panic there is contained to this sound.
fn play_on(output: &Output, req: &PlayRequest) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if let Some(source) = decode(req) {
            let sink = Player::connect_new(output.stream.mixer());
            sink.set_volume(req.volume.clamp(0.0, 1.0));
            sink.append(source);
            sink.detach();
            debug!(reason = ?req.reason, "played sound");
        }
    }))
    .is_ok()
}

/// Drops a sound identical (same reason and file) to one played within
/// [`REPEAT_WINDOW`].
#[derive(Default)]
struct RepeatFilter {
    last: HashMap<(u8, Option<PathBuf>), Instant>,
}

impl RepeatFilter {
    fn allow(&mut self, req: &PlayRequest, now: Instant) -> bool {
        let reason = match req.reason {
            AttentionReason::Permission => 0,
            AttentionReason::Done => 1,
            AttentionReason::Error => 2,
        };
        let key = (reason, req.custom.clone());
        if self
            .last
            .get(&key)
            .is_some_and(|t| now.saturating_duration_since(*t) < REPEAT_WINDOW)
        {
            return false;
        }
        self.last
            .retain(|_, t| now.saturating_duration_since(*t) < REPEAT_WINDOW);
        self.last.insert(key, now);
        true
    }
}

pub struct AudioPlayer {
    tx: Sender<PlayRequest>,
}

impl AudioPlayer {
    pub fn new() -> Self {
        let (tx, rx) = channel::<PlayRequest>();
        let spawned = std::thread::Builder::new()
            .name("armada-audio".into())
            .spawn(move || {
                // Opened lazily and retried on failure: no audio device (headless,
                // PipeWire not up yet) must never take the app down.
                let mut output: Option<Output> = None;
                let mut repeats = RepeatFilter::default();
                loop {
                    // Wake up while idle to close the stream once it's been unused a while.
                    let req = match rx.recv_timeout(IDLE_CLOSE) {
                        Ok(req) => req,
                        Err(RecvTimeoutError::Timeout) => {
                            if output.as_ref().is_some_and(|o| !o.usable()) {
                                output = None;
                            }
                            continue;
                        }
                        Err(RecvTimeoutError::Disconnected) => break,
                    };
                    if !repeats.allow(&req, Instant::now()) {
                        debug!(reason = ?req.reason, "skipped repeated sound");
                        continue;
                    }

                    if output.as_ref().is_some_and(|o| !o.usable()) {
                        // Errored or idle: reopen on whatever the default device is now.
                        output = None;
                    }
                    if output.is_none() {
                        let opened =
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(Output::open))
                                .unwrap_or_else(|_| Err("the audio host panicked".into()));
                        match opened {
                            Ok(o) => output = Some(o),
                            Err(e) => {
                                warn!("audio output unavailable: {e}");
                                continue;
                            }
                        }
                    }
                    let Some(o) = output.as_mut() else { continue };
                    o.last_used = Instant::now();
                    if !play_on(o, &req) {
                        warn!("playing a sound panicked; reopening the audio output next time");
                        output = None;
                    }
                }
            });
        if let Err(e) = spawned {
            warn!("could not start audio thread: {e}");
        }
        AudioPlayer { tx }
    }

    pub fn play(&self, reason: AttentionReason, settings: &SoundSettings) {
        self.play_scaled(reason, settings, 1.0);
    }

    /// Like [`play`](Self::play), at `scale` times the configured volume.
    pub fn play_scaled(&self, reason: AttentionReason, settings: &SoundSettings, scale: f32) {
        let _ = self.tx.send(PlayRequest {
            reason,
            volume: settings.volume * scale,
            custom: custom_sound(settings, reason),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_sound_must_be_a_small_regular_file() {
        let dir = std::env::temp_dir().join(format!("armada-sound-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        // A directory is rejected.
        assert!(read_custom(&dir).is_err());
        // A missing file is rejected.
        assert!(read_custom(&dir.join("missing.wav")).is_err());

        let ok = dir.join("ok.wav");
        std::fs::write(&ok, b"RIFF").unwrap();
        assert_eq!(read_custom(&ok).unwrap(), b"RIFF");

        let big = dir.join("big.wav");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(MAX_CUSTOM_SOUND_BYTES + 1).unwrap();
        drop(f);
        assert!(read_custom(&big).is_err());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Every bundled clip must decode through the same path used for playback,
    /// without needing an output device.
    #[test]
    fn bundled_sounds_decode() {
        use rodio::Source;
        for reason in [
            AttentionReason::Permission,
            AttentionReason::Done,
            AttentionReason::Error,
        ] {
            let req = PlayRequest {
                reason,
                volume: 1.0,
                custom: None,
            };
            let decoder = decode(&req).expect("bundled sound decodes");
            assert!(decoder.sample_rate().get() > 0);
            assert!(decoder.channels().get() > 0);
            assert!(decoder.count() > 0, "{reason:?} decoded to no samples");
        }
    }

    #[test]
    fn identical_sounds_are_rate_limited() {
        let req = |reason| PlayRequest {
            reason,
            volume: 1.0,
            custom: None,
        };
        let mut filter = RepeatFilter::default();
        let t0 = Instant::now();
        assert!(filter.allow(&req(AttentionReason::Done), t0));
        assert!(!filter.allow(&req(AttentionReason::Done), t0 + Duration::from_millis(100)));
        // A different sound isn't held back.
        assert!(filter.allow(
            &req(AttentionReason::Permission),
            t0 + Duration::from_millis(100)
        ));
        assert!(filter.allow(&req(AttentionReason::Done), t0 + REPEAT_WINDOW));
    }
}
