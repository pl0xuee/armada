//! Plan approvals: the permission request claude-agent-acp sends when the agent
//! in plan mode calls `ExitPlanMode`. It is an ordinary `session/request_permission`
//! whose tool call has `kind: "switch_mode"` and the plan markdown in `rawInput.plan`:
//!
//! ```json
//! { "toolCall": { "toolCallId": "toolu_…", "name": "ExitPlanMode", "title": "Ready to code?",
//!                 "kind": "switch_mode", "rawInput": { "plan": "# Plan\n…" } },
//!   "options": [ { "optionId": "exit-plan-auto", "name": "Yes, and use auto mode", "kind": "allow_always" },
//!                { "optionId": "exit-plan-default", "name": "Yes, manually approve edits", "kind": "allow_once" },
//!                { "optionId": "reject", "name": "No, keep planning", "kind": "reject_once" } ] }
//! ```
//!
//! The options vary with the session's modes (also `exit-plan-accept-edits`,
//! `exit-plan-bypass` and `exit-plan-clear-*`); the UI maps them by id.

use serde_json::Value;

/// Plans longer than this are cut; a plan is a page or two, not a log.
const MAX_PLAN_BYTES: usize = 200 * 1024;

/// The plan of a plan-approval request, or `None` for any other permission
/// request. Strict on purpose: the tool must be a mode switch *and* carry plan text.
pub fn plan_from_tool_call(tool_call: &Value) -> Option<String> {
    if tool_call["kind"].as_str() != Some("switch_mode") {
        return None;
    }
    let plan = tool_call["rawInput"]["plan"].as_str()?.trim();
    if plan.is_empty() {
        return None;
    }
    if plan.len() <= MAX_PLAN_BYTES {
        return Some(plan.to_string());
    }
    let mut end = MAX_PLAN_BYTES;
    while !plan.is_char_boundary(end) {
        end -= 1;
    }
    Some(format!("{}\n\n_… plan truncated_", &plan[..end]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(kind: &str, raw: Value) -> Value {
        json!({
            "toolCallId": "toolu_1", "name": "ExitPlanMode", "title": "Ready to code?",
            "kind": kind, "rawInput": raw, "content": [],
        })
    }

    #[test]
    fn extracts_the_plan_of_an_exit_plan_mode_request() {
        let tc = call("switch_mode", json!({ "plan": "\n# Plan\n- one\n- two\n" }));
        assert_eq!(
            plan_from_tool_call(&tc).as_deref(),
            Some("# Plan\n- one\n- two")
        );
    }

    #[test]
    fn ignores_everything_else() {
        // Entering plan mode has the same kind but no plan.
        assert_eq!(plan_from_tool_call(&call("switch_mode", json!({}))), None);
        assert_eq!(
            plan_from_tool_call(&call("switch_mode", json!({ "plan": "  " }))),
            None
        );
        assert_eq!(
            plan_from_tool_call(&call("switch_mode", json!({ "plan": 3 }))),
            None
        );
        // A plan field on some other tool is not an approval of a plan.
        assert_eq!(
            plan_from_tool_call(&call("execute", json!({ "plan": "x" }))),
            None
        );
        assert_eq!(plan_from_tool_call(&json!({})), None);
    }

    #[test]
    fn caps_the_plan_on_a_char_boundary() {
        let plan = "é".repeat(MAX_PLAN_BYTES);
        let out = plan_from_tool_call(&call("switch_mode", json!({ "plan": plan }))).unwrap();
        assert!(out.len() <= MAX_PLAN_BYTES + 40);
        assert!(out.ends_with("_… plan truncated_"));
    }
}
