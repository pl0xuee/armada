//! Voice dictation, the UI-agnostic half: the registry of speech-to-text models
//! Armada can download (pinned size and SHA-256), the download itself, language
//! codes, and the audio helpers that turn microphone samples into what Whisper
//! wants (16 kHz mono f32). Capture and transcription live in the desktop shell.
//!
//! Privacy: audio is only ever held in memory; nothing here writes a recording to disk.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{anyhow, bail, Context};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Whisper always works on 16 kHz mono audio.
pub const WHISPER_SAMPLE_RATE: u32 = 16_000;
/// A dictation is cut off after this long.
pub const MAX_RECORDING_SECS: u32 = 5 * 60;
/// The model offered first, and used until the user picks another.
pub const DEFAULT_MODEL: &str = "base.en";

const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/// A downloadable Whisper model (ggml format, from the whisper.cpp project).
#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    /// Exact file size in bytes; also how "is it installed" is checked.
    pub size_bytes: u64,
    /// Lower-case hex SHA-256 of the file (Hugging Face LFS oid).
    pub sha256: &'static str,
    /// Whether it understands languages other than English.
    pub multilingual: bool,
}

impl ModelSpec {
    pub fn file_name(&self) -> String {
        format!("ggml-{}.bin", self.id)
    }

    pub fn url(&self) -> String {
        format!("{MODEL_BASE_URL}/{}", self.file_name())
    }
}

pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "tiny.en",
        label: "Tiny (English)",
        description: "Fastest, least accurate",
        size_bytes: 77_704_715,
        sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
        multilingual: false,
    },
    ModelSpec {
        id: "base.en",
        label: "Base (English)",
        description: "Good balance of speed and accuracy",
        size_bytes: 147_964_211,
        sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
        multilingual: false,
    },
    ModelSpec {
        id: "small.en",
        label: "Small (English)",
        description: "More accurate, slower",
        size_bytes: 487_614_201,
        sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
        multilingual: false,
    },
    ModelSpec {
        id: "small",
        label: "Small (multilingual)",
        description: "Understands about 99 languages",
        size_bytes: 487_601_967,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        multilingual: true,
    },
];

pub fn model_spec(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

pub fn models_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("voice").join("models")
}

pub fn model_path(data_dir: &Path, spec: &ModelSpec) -> PathBuf {
    models_dir(data_dir).join(spec.file_name())
}

/// Whether the model file is present (and the right size; the checksum was
/// verified when it was downloaded).
pub fn is_installed(data_dir: &Path, spec: &ModelSpec) -> bool {
    std::fs::metadata(model_path(data_dir, spec)).is_ok_and(|m| m.len() == spec.size_bytes)
}

pub fn delete_model(data_dir: &Path, spec: &ModelSpec) -> anyhow::Result<()> {
    match std::fs::remove_file(model_path(data_dir, spec)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).context("deleting the model file"),
    }
}

/// Error returned by `download_model` when the caller cancelled it.
#[derive(Debug)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Download cancelled")
    }
}

impl std::error::Error for Cancelled {}

/// Downloads `spec` into the models dir, reporting `(bytes_done, bytes_total)` as it
/// goes. The file is checked against the pinned SHA-256 and only then moved into
/// place; a mismatch or cancel leaves nothing behind. Blocking.
pub fn download_model(
    data_dir: &Path,
    spec: &ModelSpec,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> anyhow::Result<()> {
    let dir = models_dir(data_dir);
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let dest = model_path(data_dir, spec);
    let part = dir.join(format!(
        ".{}.{}.part",
        spec.file_name(),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));

    let result = fetch_verified(spec, &part, cancel, &mut progress);
    if let Err(e) = result {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&part, &dest) {
        let _ = std::fs::remove_file(&part);
        return Err(e).with_context(|| format!("moving the model into {}", dest.display()));
    }
    Ok(())
}

fn fetch_verified(
    spec: &ModelSpec,
    part: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> anyhow::Result<()> {
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .tls_config(crate::toolchain::platform_tls())
            .timeout_connect(Some(std::time::Duration::from_secs(20)))
            .timeout_recv_response(Some(std::time::Duration::from_secs(60)))
            // Bounded by `cancel` and the stall check below, not a total time.
            .timeout_recv_body(Some(std::time::Duration::from_secs(60)))
            .user_agent(concat!("Armada/", env!("CARGO_PKG_VERSION")))
            .build(),
    );
    let url = spec.url();
    let resp = agent
        .get(&url)
        .call()
        .with_context(|| format!("downloading {}", spec.file_name()))?;
    let mut reader = resp.into_body().into_reader();
    let mut out =
        std::fs::File::create(part).with_context(|| format!("creating {}", part.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut done = 0u64;
    let mut last_report = std::time::Instant::now();
    progress(0, spec.size_bytes);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(Cancelled.into());
        }
        let n = reader.read(&mut buf).context("download interrupted")?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        out.write_all(&buf[..n]).context("writing the model file")?;
        done += n as u64;
        if done > spec.size_bytes {
            bail!(
                "{} is larger than expected; download aborted",
                spec.file_name()
            );
        }
        if last_report.elapsed() >= std::time::Duration::from_millis(150) {
            progress(done, spec.size_bytes);
            last_report = std::time::Instant::now();
        }
    }
    out.flush()?;
    drop(out);
    progress(done, spec.size_bytes);

    let actual = crate::toolchain::hex_lower(&hasher.finalize());
    if done != spec.size_bytes || actual != spec.sha256 {
        bail!(
            "checksum mismatch for {} (expected {}, got {actual}); the download was discarded",
            spec.file_name(),
            spec.sha256
        );
    }
    Ok(())
}

/// Whether an error from `download_model` is a user cancel.
pub fn is_cancelled(e: &anyhow::Error) -> bool {
    e.downcast_ref::<Cancelled>().is_some()
}

// ---------- languages ----------

/// Languages offered for multilingual models (Whisper codes), besides "auto".
pub const LANGUAGES: &[(&str, &str)] = &[
    ("en", "English"),
    ("ar", "Arabic"),
    ("zh", "Chinese"),
    ("nl", "Dutch"),
    ("fr", "French"),
    ("de", "German"),
    ("hi", "Hindi"),
    ("id", "Indonesian"),
    ("it", "Italian"),
    ("ja", "Japanese"),
    ("ko", "Korean"),
    ("pl", "Polish"),
    ("pt", "Portuguese"),
    ("ru", "Russian"),
    ("es", "Spanish"),
    ("sv", "Swedish"),
    ("tr", "Turkish"),
    ("uk", "Ukrainian"),
    ("vi", "Vietnamese"),
];

/// Checks the dictation settings together: a known model, a known language, and a
/// non-English language only with a multilingual model.
pub fn validate_voice(model: &str, language: &str) -> Result<(), String> {
    let spec = model_spec(model)
        .ok_or_else(|| format!("Unknown dictation model \u{201c}{model}\u{201d}"))?;
    if language != "auto" && !LANGUAGES.iter().any(|(code, _)| *code == language) {
        return Err(format!(
            "Unknown dictation language \u{201c}{language}\u{201d}"
        ));
    }
    if !spec.multilingual && language != "auto" && language != "en" {
        return Err(format!(
            "The {} model only understands English; pick a multilingual model for other languages",
            spec.label
        ));
    }
    Ok(())
}

// ---------- audio helpers ----------

/// Averages interleaved frames of `channels` channels down to mono.
pub fn downmix(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    samples
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Converts mono audio at `from_rate` Hz to 16 kHz. Downsampling averages the input
/// span each output sample covers (a crude low-pass, plenty for speech); upsampling
/// interpolates linearly.
pub fn resample_to_16k(mono: &[f32], from_rate: u32) -> Vec<f32> {
    if from_rate == 0 || mono.is_empty() {
        return Vec::new();
    }
    if from_rate == WHISPER_SAMPLE_RATE {
        return mono.to_vec();
    }
    let ratio = from_rate as f64 / WHISPER_SAMPLE_RATE as f64;
    let out_len = (mono.len() as f64 / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let start = i as f64 * ratio;
        if ratio > 1.0 {
            let end = (start + ratio).min(mono.len() as f64);
            let (a, b) = (start.floor() as usize, end.ceil() as usize);
            let mut sum = 0.0f64;
            let mut weight = 0.0f64;
            for (j, s) in mono[a..b.min(mono.len())].iter().enumerate() {
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
        } else {
            let a = start.floor() as usize;
            let frac = (start - a as f64) as f32;
            let s0 = mono[a];
            let s1 = *mono.get(a + 1).unwrap_or(&s0);
            out.push(s0 + (s1 - s0) * frac);
        }
    }
    out
}

/// Loudness of a block of samples for the level meter, 0.0..=1.0 (RMS, boosted and
/// clamped so ordinary speech moves the meter).
pub fn meter_level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
    (rms * 6.0).clamp(0.0, 1.0)
}

/// What the frontend needs to know about a model.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub size_bytes: u64,
    pub multilingual: bool,
    pub installed: bool,
    pub is_default: bool,
}

pub fn model_infos(data_dir: &Path) -> Vec<ModelInfo> {
    MODELS
        .iter()
        .map(|m| ModelInfo {
            id: m.id,
            label: m.label,
            description: m.description,
            size_bytes: m.size_bytes,
            multilingual: m.multilingual,
            installed: is_installed(data_dir, m),
            is_default: m.id == DEFAULT_MODEL,
        })
        .collect()
}

/// Looks up a model or explains which ones exist.
pub fn require_model(id: &str) -> anyhow::Result<&'static ModelSpec> {
    model_spec(id).ok_or_else(|| anyhow!("Unknown dictation model \u{201c}{id}\u{201d}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_well_formed() {
        assert!(model_spec(DEFAULT_MODEL).is_some());
        for m in MODELS {
            assert_eq!(m.sha256.len(), 64, "{}", m.id);
            assert!(m
                .sha256
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert_eq!(
                m.url(),
                format!(
                    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{}.bin",
                    m.id
                )
            );
            // Multilingual models are the ones without ".en".
            assert_eq!(m.multilingual, !m.id.ends_with(".en"), "{}", m.id);
            assert!(m.size_bytes > 50_000_000 && m.size_bytes < 1_000_000_000);
        }
        let mut ids: Vec<_> = MODELS.iter().map(|m| m.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), MODELS.len());
    }

    #[test]
    fn installed_requires_the_exact_size() {
        let dir = std::env::temp_dir().join(format!("armada-voice-{}", uuid::Uuid::new_v4()));
        let spec = model_spec("tiny.en").unwrap();
        assert!(!is_installed(&dir, spec));
        std::fs::create_dir_all(models_dir(&dir)).unwrap();
        std::fs::write(model_path(&dir, spec), b"truncated").unwrap();
        assert!(!is_installed(&dir, spec));
        delete_model(&dir, spec).unwrap();
        delete_model(&dir, spec).unwrap(); // already gone is fine
        assert!(!model_path(&dir, spec).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn voice_settings_validation() {
        assert!(validate_voice("base.en", "auto").is_ok());
        assert!(validate_voice("base.en", "en").is_ok());
        assert!(validate_voice("base.en", "fr").is_err());
        assert!(validate_voice("small", "fr").is_ok());
        assert!(validate_voice("small", "xx").is_err());
        assert!(validate_voice("nope", "auto").is_err());
    }

    #[test]
    fn downmix_averages_channels() {
        assert_eq!(downmix(&[0.5, -0.5, 1.0, 0.0], 2), vec![0.0, 0.5]);
        assert_eq!(downmix(&[0.1, 0.2], 1), vec![0.1, 0.2]);
        // A trailing partial frame is dropped.
        assert_eq!(downmix(&[1.0, 1.0, 1.0], 2), vec![1.0]);
    }

    #[test]
    fn resample_lengths_and_values() {
        assert_eq!(resample_to_16k(&[0.1, 0.2], 16_000), vec![0.1, 0.2]);
        assert!(resample_to_16k(&[], 48_000).is_empty());
        // 48 kHz -> 16 kHz: a third as many samples; a constant stays constant.
        let out = resample_to_16k(&vec![0.25; 4_800], 48_000);
        assert_eq!(out.len(), 1_600);
        assert!(out.iter().all(|s| (s - 0.25).abs() < 1e-6));
        // 44.1 kHz isn't an integer ratio; length follows the ratio.
        let out = resample_to_16k(&vec![0.0; 44_100], 44_100);
        assert_eq!(out.len(), 16_000);
        // 8 kHz -> 16 kHz interpolates between neighbours.
        let out = resample_to_16k(&[0.0, 1.0, 0.0], 8_000);
        assert_eq!(out.len(), 6);
        assert!((out[1] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn resample_keeps_a_low_tone() {
        // A 440 Hz tone at 48 kHz survives downsampling with most of its energy.
        let src: Vec<f32> = (0..48_000)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 48_000.0).sin())
            .collect();
        let out = resample_to_16k(&src, 48_000);
        assert_eq!(out.len(), 16_000);
        let rms = (out.iter().map(|s| s * s).sum::<f32>() / out.len() as f32).sqrt();
        assert!(rms > 0.6, "rms {rms}");
    }

    #[test]
    fn meter_is_clamped() {
        assert_eq!(meter_level(&[]), 0.0);
        assert_eq!(meter_level(&[0.0; 10]), 0.0);
        assert_eq!(meter_level(&[1.0; 10]), 1.0);
        let quiet = meter_level(&[0.05; 10]);
        assert!(quiet > 0.0 && quiet < 1.0);
    }
}
