//! Token saving: the one setting that changes what Claude Code does (when it summarizes a long
//! conversation) and the "Save tokens" preset that applies it with the other cheap defaults.
//!
//! Why: every step an agent takes (each tool call is one) re-reads the agent's whole context, so
//! tokens per turn are roughly context size x steps. Measured on a real install, agents sat at
//! 450-500k tokens of context (1M-context models summarize very late) and a median turn cost
//! about 1M tokens. Keeping the context short is the biggest lever. See docs/TOKEN-SAVING.md.

use std::ops::RangeInclusive;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::model::{Provider, ResponseStyle, Settings};
use crate::Result;

/// Sizes Claude Code accepts for `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.
pub const COMPACT_WINDOW_RANGE: RangeInclusive<u32> = 100_000..=1_000_000;

/// Context fullness (percent) at which Kvistcode itself compacts an agent between turns.
pub const COMPACT_PERCENT_RANGE: RangeInclusive<u8> = 50..=95;

/// What the preset sets the window to: well under the 450k+ the heaviest agents reach, with room
/// to work in between summaries.
pub const PRESET_COMPACT_WINDOW: u32 = 250_000;

/// The environment variable Claude Code reads for the window (it wins over its own settings).
const ENV_COMPACT_WINDOW: &str = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

/// Sizes Claude Code accepts for `bashOutputMaxChars` (it clamps to this range itself).
pub const BASH_OUTPUT_RANGE: RangeInclusive<u32> = 4_000..=128_000;

/// What the preset sets it to: well under the 30,000 default, enough for most commands; anything
/// longer is kept in a file the agent can read in parts.
pub const PRESET_BASH_OUTPUT: u32 = 12_000;

/// Sub-agent models offered (Claude Code aliases).
pub const SUBAGENT_MODELS: [&str; 2] = ["sonnet", "haiku"];

/// What the preset runs Claude's sub-agents on.
pub const PRESET_SUBAGENT_MODEL: &str = "sonnet";

const ENV_SUBAGENT_MODEL: &str = "CLAUDE_CODE_SUBAGENT_MODEL";

/// `kvistcode helper-model <model>`: the hook that holds Claude's helpers to the helper model.
pub const HELPER_MODEL_HOOK: &str = "helper-model";

/// Claude Code's tool for starting a helper (`Task` in older versions).
const HELPER_TOOLS: [&str; 2] = ["Agent", "Task"];

/// The `PreToolUse` hook's answer: when a helper launch names a model other than `model`, the
/// same launch with `model` instead. A launch naming none already gets it from the environment
/// (or from its own definition, e.g. Explore), so it is left alone.
pub fn helper_model_reply(input: &Value, model: &str) -> Option<Value> {
    if input["hook_event_name"] != "PreToolUse"
        || !HELPER_TOOLS.contains(&input["tool_name"].as_str()?)
        || !SUBAGENT_MODELS.contains(&model)
    {
        return None;
    }
    let mut tool_input = input["tool_input"].as_object()?.clone();
    let named = tool_input.get("model")?.as_str()?.trim();
    if named.is_empty() || named == model {
        return None;
    }
    tool_input.insert("model".into(), json!(model));
    Some(json!({ "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "updatedInput": tool_input,
    }}))
}

/// Entry point of `kvistcode helper-model <model>`. Like the output filter it always exits 0
/// and prints nothing when anything is unexpected, so a bug here never blocks a helper.
pub fn run_helper_model_hook(model: &str) -> i32 {
    use std::io::Read;
    let mut raw = String::new();
    if std::io::stdin()
        .take(16 * 1024 * 1024)
        .read_to_string(&mut raw)
        .is_err()
    {
        return 0;
    }
    let Ok(input) = serde_json::from_str::<Value>(&raw) else {
        return 0;
    };
    if let Some(reply) = helper_model_reply(&input, model) {
        println!("{reply}");
    }
    0
}

/// The "Save tokens" options beyond the compact size. All off by default.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TokenSaverOptions {
    /// Tidy noisy build/test/install output before Claude agents read it (`output_filter`).
    pub output_filter: bool,
    /// Largest command output a Claude agent gets inline; the rest goes to a file it can read
    /// in parts (None = Claude Code's 30,000 characters).
    pub bash_output_max_chars: Option<u32>,
    /// Model for the helpers Claude agents start (`sonnet`, `haiku`; None = same as the agent).
    pub subagent_model: Option<String>,
}

impl TokenSaverOptions {
    pub fn problem(&self) -> Option<String> {
        if let Some(n) = self.bash_output_max_chars {
            if !BASH_OUTPUT_RANGE.contains(&n) {
                return Some("The command output limit must be between 4,000 and 128,000 characters (or empty for Claude's default)".into());
            }
        }
        if let Some(m) = &self.subagent_model {
            if !SUBAGENT_MODELS.contains(&m.as_str()) {
                return Some(format!("Unknown helper model \u{201c}{m}\u{201d}"));
            }
        }
        None
    }

    /// Resets what `problem` rejects; returns the names reset.
    pub fn sanitize(&mut self) -> Vec<&'static str> {
        let mut reset = Vec::new();
        if self
            .bash_output_max_chars
            .is_some_and(|n| !BASH_OUTPUT_RANGE.contains(&n))
        {
            self.bash_output_max_chars = None;
            reset.push("tokenSaver.bashOutputMaxChars");
        }
        if self
            .subagent_model
            .as_deref()
            .is_some_and(|m| !SUBAGENT_MODELS.contains(&m))
        {
            self.subagent_model = None;
            reset.push("tokenSaver.subagentModel");
        }
        reset
    }
}

/// Adds the token-saving environment for a starting agent. Only Claude Code has these knobs,
/// and only when the user chose them; an environment the account already sets is left alone.
/// `data_dir` is where the output filter records what it saved.
pub fn extend_env(
    env: &mut Vec<(String, String)>,
    provider: Provider,
    settings: &Settings,
    data_dir: &Path,
) {
    if provider != Provider::Claude {
        return;
    }
    let mut add = |key: &str, value: String| {
        if !env.iter().any(|(k, _)| k == key) {
            env.push((key.to_string(), value));
        }
    };
    if let Some(window) = settings
        .auto_compact_window
        .filter(|w| COMPACT_WINDOW_RANGE.contains(w))
    {
        add(ENV_COMPACT_WINDOW, window.to_string());
    }
    if let Some(model) = settings
        .token_saver
        .subagent_model
        .as_deref()
        .filter(|m| SUBAGENT_MODELS.contains(m))
    {
        add(ENV_SUBAGENT_MODEL, model.to_string());
    }
    if settings.token_saver.output_filter {
        add(
            crate::output_filter::STATS_ENV,
            crate::output_filter::stats_path(data_dir)
                .to_string_lossy()
                .into_owned(),
        );
    }
}

/// Recursively merges `extra` into `base` (objects merge, arrays are concatenated so two hook
/// lists both run, anything else is replaced).
fn merge(base: &mut Value, extra: Value) {
    match (base, extra) {
        (Value::Object(b), Value::Object(e)) => {
            for (k, v) in e {
                match b.get_mut(&k) {
                    Some(slot) => merge(slot, v),
                    None => {
                        b.insert(k, v);
                    }
                }
            }
        }
        (Value::Array(b), Value::Array(e)) => b.extend(e),
        (slot, e) => *slot = e,
    }
}

/// The Claude Code settings the token-saving options add (`--settings`): the output-filter hook
/// and the command output limit. `exe` is the Kvistcode binary the hook runs.
pub fn claude_settings(settings: &Settings, exe: Option<&Path>) -> Option<Value> {
    let opts = &settings.token_saver;
    let mut out = serde_json::Map::new();
    let mut hooks = serde_json::Map::new();
    if let (true, Some(exe)) = (opts.output_filter, exe) {
        // Exec form (`args`): no shell, so no quoting trouble with spaces in paths or on Windows.
        hooks.insert(
            "PostToolUse".into(),
            json!([{
                "matcher": "Bash",
                "hooks": [{
                    "type": "command",
                    "command": exe.to_string_lossy(),
                    "args": ["filter-output"],
                    "timeout": 15,
                }],
            }]),
        );
    }
    if let (Some(model), Some(exe)) = (
        opts.subagent_model
            .as_deref()
            .filter(|m| SUBAGENT_MODELS.contains(m)),
        exe,
    ) {
        // The environment variable is only Claude Code's default: a launch that names a model
        // wins over it. This hook makes the helper setting win.
        hooks.insert(
            "PreToolUse".into(),
            json!([{
                "matcher": HELPER_TOOLS.join("|"),
                "hooks": [{
                    "type": "command",
                    "command": exe.to_string_lossy(),
                    "args": [HELPER_MODEL_HOOK, model],
                    "timeout": 15,
                }],
            }]),
        );
    }
    if !hooks.is_empty() {
        out.insert("hooks".into(), Value::Object(hooks));
    }
    if let Some(n) = opts
        .bash_output_max_chars
        .filter(|n| BASH_OUTPUT_RANGE.contains(n))
    {
        out.insert("bashOutputMaxChars".into(), json!(n));
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

/// Adds the token-saving parts to the `_meta` a Claude agent's session starts with (`existing`
/// carries the skill settings). Always turns off Claude Code's "predict the next prompt"
/// request: it re-reads the whole conversation after every turn and Kvistcode never shows it.
pub fn extend_session_meta(
    existing: Option<Value>,
    provider: Provider,
    settings: &Settings,
    exe: Option<&Path>,
) -> Option<Value> {
    if provider != Provider::Claude {
        return existing;
    }
    let mut meta = existing.unwrap_or_else(|| json!({}));
    let mut extra = claude_settings(settings, exe).unwrap_or_else(|| json!({}));
    extra["promptSuggestionEnabled"] = json!(false);
    merge(
        &mut meta,
        json!({ "claudeCode": { "options": { "promptSuggestions": false, "settings": extra } } }),
    );
    Some(meta)
}

/// Whether an agent whose turn just ended should be compacted now, and at what percent full.
/// `armed` is false from the moment we compact until usage is seen below the line again, so a
/// compaction that doesn't bring usage down is never repeated.
pub fn auto_compact_due(
    percent: Option<u8>,
    used: Option<i64>,
    size: Option<i64>,
    has_compact: bool,
    armed: &mut bool,
) -> Option<u32> {
    let pct = percent?;
    let (used, size) = (used?, size.filter(|s| *s > 0)?);
    let now = (used.max(0) * 100 / size) as u32;
    if now < u32::from(pct) {
        *armed = true;
        return None;
    }
    if !*armed || !has_compact {
        return None;
    }
    *armed = false;
    Some(now)
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
    let o = &mut settings.token_saver;
    if !o.output_filter {
        o.output_filter = true;
        changed.push("Noisy build and test output is tidied before agents read it".to_string());
    }
    if o.bash_output_max_chars.is_none() {
        o.bash_output_max_chars = Some(PRESET_BASH_OUTPUT);
        changed.push(format!(
            "Command output over {}k characters goes to a file the agent reads in parts",
            PRESET_BASH_OUTPUT / 1000
        ));
    }
    if o.subagent_model.is_none() {
        o.subagent_model = Some(PRESET_SUBAGENT_MODEL.to_string());
        changed.push("Claude's helper agents run on Sonnet".to_string());
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

    /// What the output filter has saved so far, across all agents.
    pub fn output_filter_stats(&self) -> crate::output_filter::Saved {
        crate::output_filter::read_stats(&crate::output_filter::stats_path(self.data_dir()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_meta_always_stops_prompt_suggestions_and_merges_skills() {
        let s = Settings::default();
        assert_eq!(extend_session_meta(None, Provider::Codex, &s, None), None);
        let meta = extend_session_meta(None, Provider::Claude, &s, None).unwrap();
        let o = &meta["claudeCode"]["options"];
        assert_eq!(o["promptSuggestions"], false);
        assert_eq!(o["settings"]["promptSuggestionEnabled"], false);
        assert!(
            o["settings"].get("hooks").is_none(),
            "no hook unless chosen"
        );

        let skills =
            json!({"claudeCode": {"options": {"settings": {"skillOverrides": {"pdf": "off"}}}}});
        let mut s = Settings::default();
        s.token_saver.output_filter = true;
        s.token_saver.bash_output_max_chars = Some(12_000);
        let meta = extend_session_meta(
            Some(skills),
            Provider::Claude,
            &s,
            Some(Path::new("/opt/kv/kvistcode")),
        )
        .unwrap();
        let st = &meta["claudeCode"]["options"]["settings"];
        assert_eq!(st["skillOverrides"]["pdf"], "off", "skills survive");
        assert_eq!(st["bashOutputMaxChars"], 12_000);
        let hook = &st["hooks"]["PostToolUse"][0];
        assert_eq!(hook["matcher"], "Bash");
        assert_eq!(hook["hooks"][0]["command"], "/opt/kv/kvistcode");
        assert_eq!(hook["hooks"][0]["args"][0], "filter-output");
    }

    #[test]
    fn helper_model_and_stats_env_follow_the_options() {
        let mut s = Settings::default();
        s.token_saver.subagent_model = Some("haiku".into());
        s.token_saver.output_filter = true;
        let mut env = vec![];
        extend_env(&mut env, Provider::Claude, &s, Path::new("/data"));
        assert!(env.contains(&("CLAUDE_CODE_SUBAGENT_MODEL".into(), "haiku".into())));
        assert!(env
            .iter()
            .any(|(k, v)| k == "KVISTCODE_FILTER_STATS" && v.contains("output-filter-stats")));
        let mut env = vec![("CLAUDE_CODE_SUBAGENT_MODEL".to_string(), "opus".to_string())];
        extend_env(&mut env, Provider::Claude, &s, Path::new("/data"));
        assert_eq!(env[0].1, "opus", "the account's own value wins");
    }

    #[test]
    fn bad_option_values_are_rejected_and_reset() {
        let mut s = Settings::default();
        s.token_saver.bash_output_max_chars = Some(500);
        assert!(s.validate().is_err());
        s.token_saver.bash_output_max_chars = Some(200_000);
        assert!(s.validate().is_err());
        s.token_saver.bash_output_max_chars = Some(4_000);
        s.token_saver.subagent_model = Some("opus".into());
        assert!(s.validate().is_err());
        assert!(
            claude_settings(&s, None).is_some(),
            "valid limit still passes"
        );
        s.token_saver.bash_output_max_chars = Some(1);
        assert!(
            claude_settings(&s, None).is_none(),
            "never passes a bad limit on"
        );
        let reset = s.sanitize();
        assert!(reset.contains(&"tokenSaver.subagentModel"));
        assert_eq!(s.token_saver, TokenSaverOptions::default());
        assert!(s.validate().is_ok());
    }

    #[test]
    fn env_only_for_claude_and_only_when_chosen() {
        // On by default; "Claude's default" in Settings saves an explicit None, which is off.
        let mut s = Settings::default();
        let mut env = Vec::new();
        extend_env(&mut env, Provider::Claude, &s, Path::new("/d"));
        assert_eq!(env.len(), 1, "on by default");
        env.clear();
        s.auto_compact_window = None;
        extend_env(&mut env, Provider::Claude, &s, Path::new("/d"));
        assert!(env.is_empty(), "off when the user chose Claude's default");

        s.auto_compact_window = Some(250_000);
        extend_env(&mut env, Provider::Codex, &s, Path::new("/d"));
        assert!(env.is_empty(), "Codex has no such variable");
        extend_env(&mut env, Provider::Claude, &s, Path::new("/d"));
        assert_eq!(
            env,
            vec![(
                "CLAUDE_CODE_AUTO_COMPACT_WINDOW".to_string(),
                "250000".to_string()
            )]
        );
        extend_env(&mut env, Provider::Claude, &s, Path::new("/d"));
        assert_eq!(env.len(), 1, "not added twice");
    }

    #[test]
    fn an_account_that_sets_it_wins() {
        let s = Settings {
            auto_compact_window: Some(250_000),
            ..Default::default()
        };
        let mut env = vec![(ENV_COMPACT_WINDOW.to_string(), "400000".to_string())];
        extend_env(&mut env, Provider::Claude, &s, Path::new("/d"));
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
            extend_env(&mut env, Provider::Claude, &s, Path::new("/d"));
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
        assert_eq!(changed.len(), 6);
        assert!(s.token_saver.output_filter);
        assert_eq!(
            s.token_saver.bash_output_max_chars,
            Some(PRESET_BASH_OUTPUT)
        );
        assert_eq!(s.token_saver.subagent_model.as_deref(), Some("sonnet"));
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

#[cfg(test)]
mod auto_compact_tests {
    use super::*;

    #[test]
    fn fires_once_until_usage_drops_below_the_line() {
        let mut armed = true;
        let due =
            |used, armed: &mut bool| auto_compact_due(Some(80), Some(used), Some(100), true, armed);
        assert_eq!(due(79, &mut armed), None);
        assert_eq!(due(82, &mut armed), Some(82));
        assert_eq!(
            due(90, &mut armed),
            None,
            "no second compaction for the same crossing"
        );
        assert_eq!(due(10, &mut armed), None);
        assert_eq!(
            due(85, &mut armed),
            Some(85),
            "re-armed after dropping below"
        );
    }

    #[test]
    fn needs_the_setting_usage_and_a_compact_command() {
        let mut armed = true;
        assert_eq!(
            auto_compact_due(None, Some(99), Some(100), true, &mut armed),
            None
        );
        assert_eq!(
            auto_compact_due(Some(80), None, Some(100), true, &mut armed),
            None
        );
        assert_eq!(
            auto_compact_due(Some(80), Some(99), Some(0), true, &mut armed),
            None
        );
        assert_eq!(
            auto_compact_due(Some(80), Some(99), Some(100), false, &mut armed),
            None
        );
        assert!(armed, "a missing command doesn't use up the crossing");
    }

    #[test]
    fn helper_model_hook_replaces_a_named_model_only() {
        let launch = |tool: &str, input: Value| json!({"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": input});
        let input = launch(
            "Agent",
            json!({"description": "Review", "prompt": "p", "model": "opus", "effort": "medium"}),
        );
        let reply = helper_model_reply(&input, "sonnet").unwrap();
        let out = &reply["hookSpecificOutput"];
        assert_eq!(out["hookEventName"], "PreToolUse");
        assert!(
            out.get("permissionDecision").is_none(),
            "never approves anything"
        );
        let new = &out["updatedInput"];
        assert_eq!(new["model"], "sonnet");
        assert_eq!(new["effort"], "medium", "everything else kept");
        assert_eq!(new["prompt"], "p");
        // Older Claude Code calls the tool Task.
        let task = launch("Task", json!({"prompt": "p", "model": "haiku"}));
        assert_eq!(
            helper_model_reply(&task, "sonnet").unwrap()["hookSpecificOutput"]["updatedInput"]
                ["model"],
            "sonnet"
        );
        // No model named (the environment or the definition decides), already right, other
        // tools, other events, an unknown setting: left alone.
        assert!(helper_model_reply(&launch("Agent", json!({"prompt": "p"})), "sonnet").is_none());
        assert!(helper_model_reply(&launch("Agent", json!({"model": ""})), "sonnet").is_none());
        assert!(
            helper_model_reply(&launch("Agent", json!({"model": "sonnet"})), "sonnet").is_none()
        );
        assert!(helper_model_reply(&launch("Bash", json!({"model": "opus"})), "sonnet").is_none());
        let mut post = input.clone();
        post["hook_event_name"] = json!("PostToolUse");
        assert!(helper_model_reply(&post, "sonnet").is_none());
        assert!(helper_model_reply(&input, "opus").is_none());
        assert!(helper_model_reply(&json!({}), "sonnet").is_none());
    }

    #[test]
    fn helper_model_hook_is_added_with_the_setting_beside_the_output_filter() {
        let exe = Some(Path::new("/opt/kv/kvistcode"));
        let mut s = Settings::default();
        assert!(claude_settings(&s, exe).is_none());
        s.token_saver.subagent_model = Some("sonnet".into());
        assert!(claude_settings(&s, None).is_none(), "no binary, no hook");
        s.token_saver.output_filter = true;
        let st = claude_settings(&s, exe).unwrap();
        let pre = &st["hooks"]["PreToolUse"][0];
        assert_eq!(pre["matcher"], "Agent|Task");
        assert_eq!(pre["hooks"][0]["command"], "/opt/kv/kvistcode");
        assert_eq!(
            pre["hooks"][0]["args"],
            json!([HELPER_MODEL_HOOK, "sonnet"])
        );
        assert_eq!(
            st["hooks"]["PostToolUse"][0]["matcher"], "Bash",
            "both hooks"
        );
        s.token_saver.subagent_model = Some("opus".into());
        s.token_saver.output_filter = false;
        assert!(claude_settings(&s, exe).is_none(), "only offered models");
    }
}
