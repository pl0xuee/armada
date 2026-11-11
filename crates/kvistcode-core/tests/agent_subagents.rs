//! A Claude agent's own helper model and effort: saved on the agent, written where its hook
//! reads them on every helper launch, following the settings when unset, and removed with it.

#![cfg(unix)]

use std::sync::Arc;

use kvistcode_core::token_saver::{live_subagents_path, LiveSubagents};
use kvistcode_core::*;

struct Quiet;

impl EventSink for Quiet {
    fn emit(&self, _event: KvistcodeEvent) {}
}

mod common;

fn agent_json(id: &str, provider: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id, "title": "t", "provider": provider, "accountId": "x",
        "projectPath": "/p", "cwd": "/p", "worktree": false, "status": "idle",
        "running": false, "branch": null, "baseBranch": null, "baseCommit": null,
        "sessionId": null, "groupId": null, "createdAt": 0, "updatedAt": 0,
        "lastActivityAt": 0, "costUsd": 0.0, "tokensUsed": 0, "contextUsed": null,
        "contextSize": null, "unread": false, "archived": false, "lastMessage": null,
        "pendingPermissions": 0
    })
}

fn live(data: &std::path::Path, id: &str) -> LiveSubagents {
    let raw = std::fs::read(live_subagents_path(data, id)).expect("live file");
    serde_json::from_slice(&raw).unwrap()
}

#[tokio::test]
async fn an_agent_picks_its_own_helpers_over_the_settings() {
    let data = common::scratch("agent-subagents").join("data");
    // Agents saved by an older version (no helper fields) still load.
    drop(Core::open(data.clone(), Arc::new(Quiet)).unwrap());
    {
        let db = rusqlite::Connection::open(data.join("armada.db")).unwrap();
        for (id, provider) in [("claude1", "claude"), ("codex1", "codex")] {
            db.execute(
                "INSERT INTO agents (id, data) VALUES (?1, ?2)",
                rusqlite::params![id, agent_json(id, provider).to_string()],
            )
            .unwrap();
        }
    }
    let core = Core::open(data.clone(), Arc::new(Quiet)).unwrap();
    let a = core.agent("claude1").unwrap();
    assert_eq!((a.subagent_model, a.subagent_effort), (None, None));

    let mut settings = core.settings().unwrap();
    settings.token_saver.subagent_model = Some("sonnet".into());
    settings.token_saver.subagent_effort = Some("low".into());
    core.save_settings(settings.clone()).unwrap();

    let a = core
        .set_agent_subagents("claude1", Some(" haiku ".into()), None)
        .unwrap();
    assert_eq!(a.subagent_model.as_deref(), Some("haiku"));
    assert_eq!(a.subagent_effort, None);
    let want = |m: Option<&str>, e: Option<&str>| LiveSubagents {
        model: m.map(Into::into),
        effort: e.map(Into::into),
    };
    assert_eq!(live(&data, "claude1"), want(Some("haiku"), Some("low")));

    // "same" and "auto" turn the settings off for this agent.
    core.set_agent_subagents("claude1", Some("same".into()), Some("auto".into()))
        .unwrap();
    assert_eq!(live(&data, "claude1"), want(None, None));

    // Unset follows the settings, and a settings change reaches the file.
    core.set_agent_subagents("claude1", None, Some("max".into()))
        .unwrap();
    assert_eq!(live(&data, "claude1"), want(Some("sonnet"), Some("max")));
    settings.token_saver.subagent_model = Some("haiku".into());
    core.save_settings(settings.clone()).unwrap();
    assert_eq!(live(&data, "claude1"), want(Some("haiku"), Some("max")));
    core.update_settings(|s| s.token_saver.subagent_model = None)
        .unwrap();
    assert_eq!(live(&data, "claude1"), want(None, Some("max")));

    // Bad values and other providers are refused, and nothing changes.
    assert!(core
        .set_agent_subagents("claude1", Some("opus".into()), None)
        .is_err());
    assert!(core
        .set_agent_subagents("claude1", None, Some("extreme".into()))
        .is_err());
    assert!(core
        .set_agent_subagents("codex1", Some("haiku".into()), None)
        .is_err());
    assert_eq!(
        core.agent("claude1").unwrap().subagent_effort.as_deref(),
        Some("max")
    );

    // Saved with the agent.
    drop(core);
    let core = Core::open(data.clone(), Arc::new(Quiet)).unwrap();
    assert_eq!(
        core.agent("claude1").unwrap().subagent_effort.as_deref(),
        Some("max")
    );
    core.delete_agent("claude1", false, true).await.unwrap();
    assert!(!live_subagents_path(&data, "claude1").exists());
}
