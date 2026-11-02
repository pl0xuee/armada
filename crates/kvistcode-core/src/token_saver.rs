//! Token saving: the one setting that changes what Claude Code does (when it summarizes a long
//! conversation) and the "Save tokens" preset that applies it with the other cheap defaults.
//!
//! Why: every step an agent takes (each tool call is one) re-reads the agent's whole context, so
//! tokens per turn are roughly context size x steps. Measured on a real install, agents sat at
//! 450-500k tokens of context (1M-context models summarize very late) and a median turn cost
//! about 1M tokens. Keeping the context short is the biggest lever. See docs/TOKEN-SAVING.md.

use std::ops::RangeInclusive;

use crate::model::{Provider, ResponseStyle, Settings};
use crate::Result;

/// Sizes Claude Code accepts for `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.
pub const COMPACT_WINDOW_RANGE: RangeInclusive<u32> = 100_000..=1_000_000;

/// What the preset sets the window to: well under the 450k+ the heaviest agents reach, with room
/// to work in between summaries.
pub const PRESET_COMPACT_WINDOW: u32 = 250_000;

/// The environment variable Claude Code reads for the window (it wins over its own settings).
const ENV_COMPACT_WINDOW: &str = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

/// Adds the token-saving environment for a starting agent. Only Claude Code has this knob, and
/// only when the user chose a size; an environment the account already sets is left alone.
pub fn extend_env(env: &mut Vec<(String, String)>, provider: Provider, settings: &Settings) {
    if provider != Provider::Claude {
        return;
    }
    let Some(window) = settings
        .auto_compact_window
        .filter(|w| COMPACT_WINDOW_RANGE.contains(w))
    else {
        return;
    };
    if env.iter().any(|(k, _)| k == ENV_COMPACT_WINDOW) {
        return;
    }
    env.push((ENV_COMPACT_WINDOW.to_string(), window.to_string()));
}

/// Applies the "Save tokens" preset to `settings` and returns what changed, in plain words.
/// It never touches the model (switching models mid-project costs a cache rebuild and changes
/// quality), budgets, or anything about existing agents.
pub fn apply_preset(settings: &mut Settings) -> Vec<String> {
    let mut changed = Vec::new();
    if settings.auto_compact_window != Some(PRESET_COMPACT_WINDOW) {
        settings.auto_compact_window = Some(PRESET_COMPACT_WINDOW);
        changed.push(format!(
            "Claude agents summarize their conversation at {}k tokens",
            PRESET_COMPACT_WINDOW / 1000
        ));
    }
    if settings.response_style != ResponseStyle::Concise {
        settings.response_style = ResponseStyle::Concise;
        changed.push("Replies are concise".to_string());
    }
    let claude = settings.config_defaults.entry("claude".into()).or_default();
    if !matches!(
        claude.get("effort").map(String::as_str),
        Some("low" | "medium")
    ) {
        claude.insert("effort".into(), "medium".into());
        changed.push("New Claude agents start at medium effort".to_string());
    }
    changed
}

impl crate::Core {
    /// Applies the "Save tokens" preset and saves the settings. Running agents keep the context
    /// size they started with; they pick the new size up when their session next starts.
    pub fn apply_token_saver(&self) -> Result<Settings> {
        self.update_settings(|s| {
            apply_preset(s);
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_only_for_claude_and_only_when_chosen() {
        // On by default; "Claude's default" in Settings saves an explicit None, which is off.
        let mut s = Settings::default();
        let mut env = Vec::new();
        extend_env(&mut env, Provider::Claude, &s);
        assert_eq!(env.len(), 1, "on by default");
        env.clear();
        s.auto_compact_window = None;
        extend_env(&mut env, Provider::Claude, &s);
        assert!(env.is_empty(), "off when the user chose Claude's default");

        s.auto_compact_window = Some(250_000);
        extend_env(&mut env, Provider::Codex, &s);
        assert!(env.is_empty(), "Codex has no such variable");
        extend_env(&mut env, Provider::Claude, &s);
        assert_eq!(
            env,
            vec![(
                "CLAUDE_CODE_AUTO_COMPACT_WINDOW".to_string(),
                "250000".to_string()
            )]
        );
        extend_env(&mut env, Provider::Claude, &s);
        assert_eq!(env.len(), 1, "not added twice");
    }

    #[test]
    fn an_account_that_sets_it_wins() {
        let s = Settings {
            auto_compact_window: Some(250_000),
            ..Default::default()
        };
        let mut env = vec![(ENV_COMPACT_WINDOW.to_string(), "400000".to_string())];
        extend_env(&mut env, Provider::Claude, &s);
        assert_eq!(env[0].1, "400000");
        assert_eq!(env.len(), 1);
    }

    #[test]
    fn out_of_range_sizes_are_rejected_and_reset() {
        let mut s = Settings::default();
        for bad in [0, 99_999, 1_000_001] {
            s.auto_compact_window = Some(bad);
            assert!(s.validate().is_err(), "{bad}");
            let mut env = Vec::new();
            extend_env(&mut env, Provider::Claude, &s);
            assert!(env.is_empty(), "never passes {bad} on");
            assert!(s.sanitize().contains(&"autoCompactWindow"));
            assert_eq!(s.auto_compact_window, None);
        }
        for ok in [100_000, 250_000, 1_000_000] {
            s.auto_compact_window = Some(ok);
            assert!(s.validate().is_ok(), "{ok}");
        }
    }

    #[test]
    fn preset_applies_the_cheap_defaults_and_reports_them() {
        let mut s = Settings {
            response_style: ResponseStyle::Detailed,
            auto_compact_window: None,
            ..Default::default()
        };
        let changed = apply_preset(&mut s);
        assert_eq!(s.auto_compact_window, Some(PRESET_COMPACT_WINDOW));
        assert_eq!(s.response_style, ResponseStyle::Concise);
        assert_eq!(s.config_defaults["claude"]["effort"], "medium");
        assert_eq!(changed.len(), 3);
        assert!(s.validate().is_ok());
    }

    #[test]
    fn preset_is_idempotent_and_keeps_a_lower_effort() {
        let mut s = Settings::default();
        s.config_defaults
            .entry("claude".into())
            .or_default()
            .insert("effort".into(), "low".into());
        s.config_defaults
            .get_mut("claude")
            .unwrap()
            .insert("model".into(), "opus".into());
        apply_preset(&mut s);
        assert_eq!(s.config_defaults["claude"]["effort"], "low");
        assert_eq!(
            s.config_defaults["claude"]["model"], "opus",
            "model untouched"
        );
        assert!(apply_preset(&mut s).is_empty(), "nothing left to change");
    }
}
