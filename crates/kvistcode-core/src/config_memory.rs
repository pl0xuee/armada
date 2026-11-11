//! Remembering the composer's session options (model, effort, …) across restarts
//! and for new agents of the same provider. Permission-related options are never
//! remembered: the mode is chosen explicitly per agent.

use std::collections::BTreeMap;

use crate::model::{ConfigOption, Provider};

/// Option ids that carry a permission/sandbox decision.
const SAFETY_IDS: &[&str] = &[
    "mode",
    "approval",
    "approvalpolicy",
    "approval_policy",
    "sandbox",
    "sandboxmode",
    "sandbox_mode",
    "permission",
    "permissions",
    "permissionmode",
    "permission_mode",
];
const SAFETY_CATEGORIES: &[&str] = &["mode", "approval", "sandbox", "permission", "permissions"];
const BYPASS_VALUES: &[&str] = &[
    "bypasspermissions",
    "never",
    "danger-full-access",
    "dangerfullaccess",
    "yolo",
    "dontask",
    "acceptedits",
];
/// Substrings that mark a value as a permission escalation, however it's spelled.
const BYPASS_FRAGMENTS: &[&str] = &[
    "bypass",
    "danger",
    "yolo",
    "full-access",
    "full_access",
    "fullaccess",
    "dont_ask",
    "dont-ask",
];

/// The key a provider's remembered defaults are stored under (matches the UI's
/// identity: a custom agent is its own identity).
pub fn identity_key(provider: Provider, custom_agent_id: Option<&str>) -> String {
    match (provider, custom_agent_id) {
        (Provider::Custom, Some(id)) => format!("custom:{id}"),
        (p, _) => p.as_str().to_string(),
    }
}

pub fn is_bypass_value(value: &str) -> bool {
    let v = value.to_ascii_lowercase();
    BYPASS_VALUES.contains(&v.as_str()) || BYPASS_FRAGMENTS.iter().any(|f| v.contains(f))
}

/// Whether an option id names a permission/sandbox control.
fn is_safety_id(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    SAFETY_IDS.contains(&id.as_str())
        || id.contains("sandbox")
        || id.contains("approval")
        || id.contains("permission")
        || id.contains("bypass")
}

/// Whether a choice set without the option at hand (the model setup) may be remembered: never a
/// permission/sandbox option or a bypass value. Forgetting (an empty value) is always fine.
pub fn may_set_default(option_id: &str, value: &str) -> bool {
    !option_id.trim().is_empty()
        && !is_safety_id(option_id)
        && (value.trim().is_empty() || !is_bypass_value(value))
}

/// Whether the user's choice for this option may be remembered / re-applied.
pub fn is_rememberable(option: &ConfigOption) -> bool {
    if is_safety_id(&option.id) {
        return false;
    }
    if let Some(c) = option.category.as_deref() {
        if SAFETY_CATEGORIES.contains(&c.to_ascii_lowercase().as_str()) {
            return false;
        }
    }
    // Any option offering a bypass choice is a permission control in disguise.
    !option.options.iter().any(|c| is_bypass_value(&c.value))
}

/// Whether `value` is a safe thing to store for `option`.
pub fn may_remember(option: &ConfigOption, value: &str) -> bool {
    is_rememberable(option)
        && !is_bypass_value(value)
        && option.options.iter().any(|c| c.value == value)
}

/// The (option, value) changes needed to bring `options` to the remembered
/// `choices`: only options that still exist, whose remembered value is still one
/// of their choices and differs from the current one. The model goes first (it
/// can change which other options exist). `skip` holds ids already attempted.
pub fn plan(
    options: &[ConfigOption],
    choices: &BTreeMap<String, String>,
    skip: &[String],
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = options
        .iter()
        .filter(|o| !skip.contains(&o.id))
        .filter_map(|o| {
            let want = choices.get(&o.id)?;
            (may_remember(o, want) && &o.current_value != want)
                .then(|| (o.id.clone(), want.clone()))
        })
        .collect();
    out.sort_by_key(|(id, _)| id != "model");
    out
}

/// The options a "kind of work" pick may set at launch.
const REQUESTABLE: &[&str] = &["model", "effort"];

/// What a launch may ask a new Claude agent to start with: only the model and the effort, with
/// plain values (an alias like `opus`, a level like `medium`). Anything else, any other
/// provider, or a permission-looking value is dropped, so a launch can never set a mode.
/// The values are checked against the agent's real options when its session starts
/// (`plan`), so one Claude Code doesn't offer is simply not applied.
pub fn requested_choices(
    provider: Provider,
    asked: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    if provider != Provider::Claude {
        return BTreeMap::new();
    }
    asked
        .iter()
        .filter(|(k, v)| {
            REQUESTABLE.contains(&k.as_str())
                && !v.is_empty()
                && v.len() <= 64
                && v.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
                && !is_bypass_value(v)
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// First-start choices: the provider's remembered defaults, overridden by
/// anything remembered for the agent itself.
pub fn first_start_choices(
    defaults: Option<&BTreeMap<String, String>>,
    agent: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut merged = defaults.cloned().unwrap_or_default();
    merged.extend(agent.iter().map(|(k, v)| (k.clone(), v.clone())));
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ConfigOptionChoice;

    fn opt(id: &str, cat: Option<&str>, cur: &str, vals: &[&str]) -> ConfigOption {
        ConfigOption {
            id: id.into(),
            name: id.into(),
            category: cat.map(Into::into),
            current_value: cur.into(),
            options: vals
                .iter()
                .map(|v| ConfigOptionChoice {
                    value: v.to_string(),
                    name: v.to_string(),
                    description: None,
                })
                .collect(),
        }
    }

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn permission_options_are_never_remembered() {
        assert!(!is_rememberable(&opt("mode", None, "a", &["a", "b"])));
        assert!(!is_rememberable(&opt("x", Some("mode"), "a", &["a"])));
        assert!(!is_rememberable(&opt(
            "approval",
            Some("mode"),
            "untrusted",
            &["never", "untrusted"]
        )));
        assert!(!is_rememberable(&opt(
            "sandbox",
            None,
            "a",
            &["a", "danger-full-access"]
        )));
        assert!(!is_rememberable(&opt(
            "weird",
            None,
            "a",
            &["a", "bypassPermissions"]
        )));
        assert!(is_rememberable(&opt(
            "model",
            Some("model"),
            "a",
            &["a", "b"]
        )));
        assert!(is_rememberable(&opt("effort", None, "a", &["a", "b"])));
    }

    #[test]
    fn disguised_permission_options_are_not_remembered() {
        assert!(!is_rememberable(&opt(
            "access",
            None,
            "a",
            &["a", "full-access"]
        )));
        assert!(!is_rememberable(&opt(
            "perm_level",
            None,
            "a",
            &["a", "Danger-Full-Access"]
        )));
        assert!(!is_rememberable(&opt(
            "tool_permission_level",
            None,
            "a",
            &["a", "b"]
        )));
        assert!(!is_rememberable(&opt(
            "x",
            None,
            "a",
            &["a", "acceptEdits"]
        )));
        assert!(!may_remember(
            &opt("model", None, "a", &["a", "my-yolo-model"]),
            "a"
        ));
    }

    #[test]
    fn bypass_values_are_not_stored() {
        let o = opt("thing", None, "a", &["a", "never"]);
        assert!(!may_remember(&o, "a"));
        let m = opt("model", None, "a", &["a", "b"]);
        assert!(may_remember(&m, "b"));
        assert!(!may_remember(&m, "zzz"));
    }

    #[test]
    fn plan_filters_stale_and_unchanged() {
        let options = vec![
            opt("effort", None, "high", &["low", "high"]),
            opt("model", None, "opus", &["opus", "sonnet"]),
            opt("thinking", None, "off", &["off", "on"]),
            opt("mode", None, "ask", &["ask", "auto"]),
        ];
        let choices = map(&[
            ("effort", "low"),
            ("model", "sonnet"),
            ("thinking", "off"), // unchanged
            ("gone", "x"),       // option vanished
            ("mode", "auto"),    // never
        ]);
        let p = plan(&options, &choices, &[]);
        assert_eq!(
            p,
            vec![
                ("model".into(), "sonnet".into()),
                ("effort".into(), "low".into())
            ]
        );
        assert!(plan(&options, &map(&[("effort", "gone")]), &[]).is_empty());
        assert_eq!(plan(&options, &choices, &["model".into()]).len(), 1);
    }

    #[test]
    fn agent_choices_win_over_defaults() {
        let d = map(&[("model", "a"), ("effort", "low")]);
        let a = map(&[("model", "b")]);
        let m = first_start_choices(Some(&d), &a);
        assert_eq!(m["model"], "b");
        assert_eq!(m["effort"], "low");
    }

    #[test]
    fn identity_keys() {
        assert_eq!(identity_key(Provider::Claude, None), "claude");
        assert_eq!(identity_key(Provider::Custom, Some("abc")), "custom:abc");
    }

    #[test]
    fn a_launch_may_only_ask_for_model_and_effort_on_claude() {
        let ask = |pairs: &[(&str, &str)]| -> BTreeMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        let got = requested_choices(
            Provider::Claude,
            &ask(&[
                ("model", "opus"),
                ("effort", "medium"),
                ("mode", "plan"),
                ("fast", "on"),
            ]),
        );
        assert_eq!(got, ask(&[("model", "opus"), ("effort", "medium")]));
        // Not Claude: nothing.
        assert!(requested_choices(Provider::Codex, &ask(&[("model", "opus")])).is_empty());
        // Odd values are dropped (an empty one, a long one, spaces, a permission-looking one).
        let long = "x".repeat(65);
        assert!(
            requested_choices(Provider::Claude, &ask(&[("model", ""), ("effort", &long)]))
                .is_empty()
        );
        assert!(requested_choices(Provider::Claude, &ask(&[("model", "a b")])).is_empty());
        assert!(
            requested_choices(Provider::Claude, &ask(&[("model", "bypassPermissions")])).is_empty()
        );
    }

    #[test]
    fn a_launch_pick_beats_the_remembered_default_for_that_start_only() {
        let remembered = map(&[("model", "sonnet"), ("effort", "high"), ("fast", "on")]);
        let asked = requested_choices(
            Provider::Claude,
            &map(&[("model", "opus"), ("effort", "medium")]),
        );
        let start = first_start_choices(Some(&remembered), &asked);
        assert_eq!(start["model"], "opus");
        assert_eq!(start["effort"], "medium");
        // What the user did not ask about still comes from what they remembered.
        assert_eq!(start["fast"], "on");
        // And with no pick (My usual model), the remembered choices stand.
        let none = requested_choices(Provider::Claude, &BTreeMap::new());
        assert_eq!(first_start_choices(Some(&remembered), &none), remembered);
    }
}
