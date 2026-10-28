//! Attention sounds. A dedicated thread owns the audio output stream (rodio
//! streams aren't `Send` on every platform); everyone else sends play requests.

use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};

use armada_core::{AttentionReason, SoundSettings};
use rodio::{Decoder, OutputStream, OutputStreamBuilder, Sink};
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
                let mut stream: Option<OutputStream> = None;
                for req in rx {
                    if stream.is_none() {
                        match OutputStreamBuilder::open_default_stream() {
                            Ok(mut s) => {
                                s.log_on_drop(false);
                                stream = Some(s);
                            }
                            Err(e) => {
                                warn!("audio output unavailable: {e}");
                                continue;
                            }
                        }
                    }
                    let Some(s) = stream.as_ref() else { continue };
                    if let Some(source) = decode(&req) {
                        let sink = Sink::connect_new(s.mixer());
                        sink.set_volume(req.volume.clamp(0.0, 1.0));
                        sink.append(source);
                        sink.detach();
                        debug!(reason = ?req.reason, "played sound");
                    }
                }
            });
        if let Err(e) = spawned {
            warn!("could not start audio thread: {e}");
        }
        AudioPlayer { tx }
    }

    pub fn play(&self, reason: AttentionReason, settings: &SoundSettings) {
        let _ = self.tx.send(PlayRequest {
            reason,
            volume: settings.volume,
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
}
