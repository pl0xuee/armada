//! Cost estimate and the monthly usage ledger.
//!
//! The estimate is computed from the token counts OpenAI reports in `response.done`.
//! Prices are per 1M tokens for `gpt-realtime` as published in 2026-10 and WILL drift;
//! the UI labels the figure an estimate and the real bill is on the user's OpenAI
//! account. Update the constants when the price list changes.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::protocol::TokenUsage;

pub const AUDIO_IN_PER_M: f64 = 32.0;
pub const AUDIO_OUT_PER_M: f64 = 64.0;
pub const TEXT_IN_PER_M: f64 = 4.0;
pub const TEXT_OUT_PER_M: f64 = 16.0;
/// Cached input (audio and text alike) is billed at this much per 1M tokens.
pub const CACHED_IN_PER_M: f64 = 0.40;

/// The session also transcribes the user's speech with `gpt-4o-mini-transcribe`
/// (`protocol::session_update`), which is billed per audio minute, outside the
/// `response.done` token counts. Published at about $0.003/min (2026-10; will drift).
/// The estimate charges it for the whole session length, an upper bound on the mic time.
pub const TRANSCRIBE_PER_MIN: f64 = 0.003;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Usage {
    pub audio_in: u64,
    pub text_in: u64,
    pub cached_in: u64,
    pub audio_out: u64,
    pub text_out: u64,
}

impl Usage {
    pub fn add(&mut self, u: &TokenUsage) {
        let i = &u.input_token_details;
        // Cached tokens are included in the audio/text counts; they are billed at the
        // cached rate instead.
        let cached =
            if i.cached_tokens_details.audio_tokens + i.cached_tokens_details.text_tokens > 0 {
                i.cached_tokens_details.audio_tokens + i.cached_tokens_details.text_tokens
            } else {
                i.cached_tokens
            };
        let cached_audio = i.cached_tokens_details.audio_tokens.min(i.audio_tokens);
        let cached_text = cached.saturating_sub(cached_audio).min(i.text_tokens);
        self.audio_in += i.audio_tokens - cached_audio;
        self.text_in += i.text_tokens - cached_text;
        self.cached_in += cached_audio + cached_text;
        self.audio_out += u.output_token_details.audio_tokens;
        self.text_out += u.output_token_details.text_tokens;
    }

    pub fn cost_usd(&self) -> f64 {
        let m = 1_000_000.0;
        self.audio_in as f64 / m * AUDIO_IN_PER_M
            + self.text_in as f64 / m * TEXT_IN_PER_M
            + self.cached_in as f64 / m * CACHED_IN_PER_M
            + self.audio_out as f64 / m * AUDIO_OUT_PER_M
            + self.text_out as f64 / m * TEXT_OUT_PER_M
    }
}

/// Estimated cost of a session that has run `elapsed_secs`: the reported token usage
/// plus the input-transcription model ([`TRANSCRIBE_PER_MIN`]).
pub fn session_cost(usage: &Usage, elapsed_secs: u64) -> f64 {
    usage.cost_usd() + elapsed_secs as f64 / 60.0 * TRANSCRIBE_PER_MIN
}

/// Usage for one calendar month.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MonthUsage {
    /// "YYYY-MM"
    pub month: String,
    pub seconds: u64,
    pub cost_usd: f64,
    pub sessions: u32,
}

fn ledger_path(data_dir: &Path) -> PathBuf {
    data_dir.join("voice-assistant-usage.json")
}

pub fn current_month() -> String {
    chrono::Local::now().format("%Y-%m").to_string()
}

pub fn read_month(data_dir: &Path, month: &str) -> MonthUsage {
    let stored: Option<MonthUsage> = std::fs::read_to_string(ledger_path(data_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    match stored {
        Some(u) if u.month == month => u,
        _ => MonthUsage {
            month: month.to_string(),
            ..Default::default()
        },
    }
}

/// Adds one finished session to the month's totals.
#[cfg(test)]
pub fn record_session(
    data_dir: &Path,
    month: &str,
    seconds: u64,
    cost_usd: f64,
) -> std::io::Result<MonthUsage> {
    add_usage(data_dir, month, seconds, cost_usd, true)
}

fn add_usage(
    data_dir: &Path,
    month: &str,
    seconds: u64,
    cost_usd: f64,
    new_session: bool,
) -> std::io::Result<MonthUsage> {
    let mut u = read_month(data_dir, month);
    u.seconds += seconds;
    u.cost_usd += cost_usd;
    u.sessions += u32::from(new_session);
    let tmp = ledger_path(data_dir).with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(&u)?)?;
    std::fs::rename(&tmp, ledger_path(data_dir))?;
    Ok(u)
}

/// Writes one session's usage to the ledger incrementally: every checkpoint adds only
/// what is new since the last, so a crash loses at most the time since the last
/// `response.done`, and the session is counted once.
pub struct SessionLedger {
    data_dir: PathBuf,
    month: String,
    seconds: u64,
    cost_usd: f64,
    counted: bool,
}

impl SessionLedger {
    pub fn new(data_dir: &Path) -> Self {
        SessionLedger {
            data_dir: data_dir.to_path_buf(),
            month: current_month(),
            seconds: 0,
            cost_usd: 0.0,
            counted: false,
        }
    }

    /// `seconds` and `cost_usd` are the session totals so far.
    pub fn checkpoint(&mut self, seconds: u64, cost_usd: f64) -> std::io::Result<()> {
        let (ds, dc) = (
            seconds.saturating_sub(self.seconds),
            (cost_usd - self.cost_usd).max(0.0),
        );
        if self.counted && ds == 0 && dc == 0.0 {
            return Ok(());
        }
        add_usage(&self.data_dir, &self.month, ds, dc, !self.counted)?;
        self.counted = true;
        self.seconds = self.seconds.max(seconds);
        self.cost_usd = self.cost_usd.max(cost_usd);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice_assistant::protocol::{CachedDetails, InputDetails, OutputDetails};

    #[test]
    fn estimates_cost() {
        let mut u = Usage::default();
        u.add(&TokenUsage {
            input_token_details: InputDetails {
                audio_tokens: 1_000_000,
                text_tokens: 500_000,
                cached_tokens: 100_000,
                cached_tokens_details: CachedDetails {
                    audio_tokens: 0,
                    text_tokens: 100_000,
                },
            },
            output_token_details: OutputDetails {
                audio_tokens: 250_000,
                text_tokens: 0,
            },
        });
        // 1M audio in = 32, 400k text in = 1.6, 100k cached = 0.04, 250k audio out = 16.
        assert!((u.cost_usd() - 49.64).abs() < 1e-9, "{}", u.cost_usd());
    }

    #[test]
    fn cached_without_breakdown_counts_as_text() {
        let mut u = Usage::default();
        u.add(&TokenUsage {
            input_token_details: InputDetails {
                audio_tokens: 10,
                text_tokens: 100,
                cached_tokens: 40,
                cached_tokens_details: CachedDetails::default(),
            },
            output_token_details: OutputDetails::default(),
        });
        assert_eq!((u.audio_in, u.text_in, u.cached_in), (10, 60, 40));
    }

    #[test]
    fn session_cost_includes_transcription() {
        let u = Usage::default();
        assert!((session_cost(&u, 600) - 0.03).abs() < 1e-9);
    }

    #[test]
    fn checkpoints_add_only_the_delta_and_count_the_session_once() {
        let dir = std::env::temp_dir().join(format!("armada-va-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut l = SessionLedger::new(&dir);
        l.checkpoint(30, 0.10).unwrap();
        l.checkpoint(30, 0.10).unwrap();
        l.checkpoint(90, 0.40).unwrap();
        let u = read_month(&dir, &current_month());
        assert_eq!((u.seconds, u.sessions), (90, 1));
        assert!((u.cost_usd - 0.40).abs() < 1e-9);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ledger_accumulates_and_rolls_over() {
        let dir = std::env::temp_dir().join(format!("armada-va-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        record_session(&dir, "2026-10", 60, 0.5).unwrap();
        let u = record_session(&dir, "2026-10", 30, 0.25).unwrap();
        assert_eq!((u.seconds, u.sessions), (90, 2));
        assert!((u.cost_usd - 0.75).abs() < 1e-9);
        assert_eq!(read_month(&dir, "2026-11").seconds, 0);
        std::fs::remove_dir_all(&dir).ok();
    }
}
