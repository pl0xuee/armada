//! Agents that hit a usage limit are resumed by themselves once it lifts, against a mock agent
//! that refuses prompts until a moment passes (`mock_limit.py`). The core runs in "fast" mode:
//! it ticks every 100 ms and every wait (jitter, stagger, backoff) is 1000 times shorter, while
//! the reset times themselves are real (a couple of seconds ahead).

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Once};
use std::time::Duration;

use kvistcode_core::limit_resume::{LimitResumeState, RESUME_PROMPT};
use kvistcode_core::*;
use tokio::sync::mpsc;

struct Sink(mpsc::UnboundedSender<KvistcodeEvent>);

impl EventSink for Sink {
    fn emit(&self, event: KvistcodeEvent) {
        let _ = self.0.send(event);
    }
}

static INIT: Once = Once::new();

/// One mock command for every test in this file (the environment is shared); each test steers
/// it through a file in its own folder.
fn use_mock() {
    INIT.call_once(|| {
        let mock = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mock_limit.py");
        std::env::set_var("KVISTCODE_GROK_COMMAND", format!("python3 {mock}"));
    });
}

/// A folder under the temp dir, removed when dropped.
struct Dir(PathBuf);

impl Dir {
    fn new(name: &str) -> Dir {
        let dir = std::env::temp_dir().join(format!(
            "kvistcode-limit-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Dir(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Rig {
    core: Core,
    rx: mpsc::UnboundedReceiver<KvistcodeEvent>,
    project: Dir,
    _data: Dir,
}

fn open(data: &Path) -> (Core, mpsc::UnboundedReceiver<KvistcodeEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let core = Core::open(data.to_path_buf(), Arc::new(Sink(tx))).unwrap();
    core.set_limit_resume_fast();
    (core, rx)
}

async fn rig(name: &str) -> Rig {
    use_mock();
    let data = Dir::new(&format!("{name}-data"));
    let project = Dir::new(&format!("{name}-project"));
    let (core, rx) = open(data.path());
    core.startup().await;
    Rig {
        core,
        rx,
        project,
        _data: data,
    }
}

/// What the mock does: refuse every prompt with `message` until the test lifts the limit (`lift`).
fn config(project: &Path, message: &str, rate_limit: serde_json::Value) {
    let json = serde_json::json!({
        "lifts_at": null,
        "message": message,
        "rate_limit": rate_limit,
    });
    std::fs::write(project.join(".mock-limit.json"), json.to_string()).unwrap();
}

/// The limit lifts at `at_ms`: prompts the mock gets from then on are answered. Called once the
/// agents are seen waiting, so a slow machine can never let a first prompt slip through.
fn lift(project: &Path, at_ms: i64) {
    let path = project.join(".mock-limit.json");
    let mut json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    json["lifts_at"] = at_ms.into();
    std::fs::write(path, json.to_string()).unwrap();
}

/// What the mock was asked, in order: (text, refused).
fn asked(project: &Path) -> Vec<(String, bool)> {
    std::fs::read_to_string(project.join(".mock-limit.log"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .map(|v| {
            (
                v["text"].as_str().unwrap_or_default().to_string(),
                v["refused"].as_bool().unwrap_or(false),
            )
        })
        .collect()
}

async fn new_agent(core: &Core, project: &Path, title: &str) -> Agent {
    let account = core
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.provider == Provider::Grok && a.is_system)
        .expect("system grok account");
    core.create_agent(CreateAgentRequest {
        provider: Provider::Grok,
        account_id: account.id,
        project_path: project.to_string_lossy().into_owned(),
        prompt: "do the work".into(),
        title: Some(title.into()),
        worktree: false,
        model: None,
        group_id: None,
        custom_agent_id: None,
        permission_mode: None,
        attachments: vec![],
    })
    .await
    .unwrap()
}

async fn until(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    while !f() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for: {what}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn waiting(core: &Core, id: &str) -> bool {
    core.agent(id)
        .is_ok_and(|a| a.rate_limited && a.limit_resume.is_some())
}

fn automatic_messages(core: &Core, id: &str) -> usize {
    core.items(id)
        .unwrap()
        .iter()
        .filter(|i| matches!(&i.body, ItemBody::UserMessage { automatic: true, text, .. } if text == RESUME_PROMPT))
        .count()
}

/// Drains the events seen so far.
fn attentions(rx: &mut mpsc::UnboundedReceiver<KvistcodeEvent>) -> Vec<(AttentionReason, String)> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        if let KvistcodeEvent::Attention { reason, body, .. } = ev {
            out.push((reason, body));
        }
    }
    out
}

#[tokio::test]
async fn resumes_by_itself_after_the_reset_time_in_the_message() {
    let mut r = rig("basic").await;
    config(
        r.project.path(),
        "You've hit your limit \u{b7} resets in 2 seconds",
        serde_json::Value::Null,
    );
    let before = now_ms();
    let agent = new_agent(&r.core, r.project.path(), "Fix login").await;
    until("agent waits for the reset", 20, || {
        waiting(&r.core, &agent.id)
    })
    .await;

    let a = r.core.agent(&agent.id).unwrap();
    assert_eq!(a.status, AgentStatus::Error);
    let at = a
        .limit_resets_at
        .expect("a reset time was read from the message");
    assert!(at >= before && at <= now_ms() + 3000, "{at} vs {before}");
    lift(r.project.path(), at);
    let wait = a.limit_resume.unwrap();
    assert_eq!((wait.state, wait.attempts), (LimitResumeState::Waiting, 0));
    assert_eq!(
        automatic_messages(&r.core, &agent.id),
        0,
        "nothing before the reset"
    );
    let notices: Vec<_> = r
        .core
        .items(&agent.id)
        .unwrap()
        .into_iter()
        .filter_map(|i| match i.body {
            ItemBody::Notice { text, .. } => Some(text),
            _ => None,
        })
        .collect();
    assert!(
        notices
            .iter()
            .any(|t| t.contains("resume this agent automatically")),
        "{notices:?}"
    );

    until("the agent was resumed and finished", 30, || {
        automatic_messages(&r.core, &agent.id) == 1
            && r.core
                .agent(&agent.id)
                .is_ok_and(|a| a.status == AgentStatus::Idle)
    })
    .await;
    let a = r.core.agent(&agent.id).unwrap();
    assert!(!a.rate_limited);
    assert!(
        a.limit_resume.is_none() && a.limit_resets_at.is_none(),
        "the episode is over"
    );
    let ask = asked(r.project.path());
    assert_eq!(ask.len(), 2, "{ask:?}");
    assert!(ask[0].1 && !ask[1].1);
    // (A briefing can come first: the process was restarted.)
    assert!(ask[1].0.ends_with(RESUME_PROMPT), "{}", ask[1].0);
    let said = attentions(&mut r.rx);
    assert!(
        said.iter()
            .any(|(reason, body)| *reason == AttentionReason::Done
                && body == "Resumed Fix login after your usage limit reset"),
        "{said:?}"
    );
    r.core.shutdown().await;
}

#[tokio::test]
async fn the_setting_off_never_resumes() {
    let r = rig("off").await;
    r.core
        .update_settings(|s| s.resume_after_limit = false)
        .unwrap();
    config(
        r.project.path(),
        "usage limit reached, resets in 1 seconds",
        serde_json::Value::Null,
    );
    let agent = new_agent(&r.core, r.project.path(), "Off").await;
    until("agent stopped by the limit", 20, || {
        r.core.agent(&agent.id).is_ok_and(|a| a.rate_limited)
    })
    .await;
    assert!(
        r.core.agent(&agent.id).unwrap().limit_resume.is_none(),
        "nothing recorded"
    );
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(automatic_messages(&r.core, &agent.id), 0);
    assert_eq!(asked(r.project.path()).len(), 1);
    r.core.shutdown().await;
}

#[tokio::test]
async fn cancelling_for_one_agent_leaves_it_alone() {
    let r = rig("cancel").await;
    config(
        r.project.path(),
        "usage limit reached, resets in 1 seconds",
        serde_json::Value::Null,
    );
    let agent = new_agent(&r.core, r.project.path(), "Cancelled").await;
    until("waiting", 20, || waiting(&r.core, &agent.id)).await;
    let a = r.core.cancel_limit_resume(&agent.id).unwrap();
    assert_eq!(a.limit_resume.unwrap().state, LimitResumeState::Cancelled);
    assert_eq!(a.limit_resets_at, None);
    tokio::time::sleep(Duration::from_millis(3000)).await;
    assert_eq!(automatic_messages(&r.core, &agent.id), 0);
    let a = r.core.agent(&agent.id).unwrap();
    assert!(
        a.rate_limited && a.status == AgentStatus::Error,
        "still waiting for the user"
    );
    r.core.shutdown().await;
}

#[tokio::test]
async fn an_agent_the_user_touched_is_not_resumed() {
    let r = rig("touched").await;
    config(
        r.project.path(),
        "usage limit reached, resets in 3 seconds",
        serde_json::Value::Null,
    );
    let agent = new_agent(&r.core, r.project.path(), "Touched").await;
    until("waiting", 20, || waiting(&r.core, &agent.id)).await;
    // The user stops it: the wait is theirs now.
    r.core.stop_agent(&agent.id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(4500)).await;
    assert_eq!(automatic_messages(&r.core, &agent.id), 0);
    let a = r.core.agent(&agent.id).unwrap();
    assert!(
        a.limit_resume.is_none() && a.limit_resets_at.is_none(),
        "the stop ended the wait"
    );

    // An archived one is left alone too.
    config(
        r.project.path(),
        "usage limit reached, resets in 3 seconds",
        serde_json::Value::Null,
    );
    let other = new_agent(&r.core, r.project.path(), "Archived").await;
    until("waiting", 20, || waiting(&r.core, &other.id)).await;
    r.core.archive_agent(&other.id, true).unwrap();
    tokio::time::sleep(Duration::from_millis(4000)).await;
    assert_eq!(automatic_messages(&r.core, &other.id), 0);
    r.core.shutdown().await;
}

#[tokio::test]
async fn gives_up_after_three_automatic_tries_and_asks_for_you() {
    let mut r = rig("giveup").await;
    // Never lifts, and the message always promises 1 second.
    config(
        r.project.path(),
        "usage limit reached, resets in 1 seconds",
        serde_json::Value::Null,
    );
    let agent = new_agent(&r.core, r.project.path(), "Stubborn").await;
    until("it gave up", 40, || {
        r.core
            .agent(&agent.id)
            .ok()
            .and_then(|a| a.limit_resume)
            .is_some_and(|w| w.state == LimitResumeState::GaveUp)
    })
    .await;
    let a = r.core.agent(&agent.id).unwrap();
    assert!(a.rate_limited && a.limit_resets_at.is_none());
    assert_eq!(a.limit_resume.unwrap().attempts, 3);
    assert_eq!(automatic_messages(&r.core, &agent.id), 3);
    // The original prompt and exactly three automatic ones.
    assert_eq!(asked(r.project.path()).len(), 4);
    let said = attentions(&mut r.rx);
    assert!(
        said.iter()
            .any(|(reason, body)| *reason == AttentionReason::Error
                && body.contains("automatic tries")),
        "{said:?}"
    );
    // And it stays that way.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(asked(r.project.path()).len(), 4);
    r.core.shutdown().await;
}

#[tokio::test]
async fn several_agents_resume_together_and_are_announced_once() {
    let mut r = rig("wave").await;
    // One account, one reset time for all of them (as in life): the usage snapshot names it.
    let resets = (now_ms() / 1000) + 6;
    config(
        r.project.path(),
        "You've hit your usage limit",
        serde_json::json!({"status": "rejected", "unifiedWindows": {
            "five_hour": {"utilization": 1.0, "resetsAt": resets, "status": "rejected"}}}),
    );
    let mut ids = Vec::new();
    for i in 0..5 {
        ids.push(
            new_agent(&r.core, r.project.path(), &format!("Agent {i}"))
                .await
                .id,
        );
    }
    for id in &ids {
        until("waiting", 30, || waiting(&r.core, id)).await;
    }
    lift(r.project.path(), resets * 1000);
    until("all resumed and finished", 40, || {
        ids.iter().all(|id| {
            automatic_messages(&r.core, id) == 1
                && r.core
                    .agent(id)
                    .is_ok_and(|a| a.status == AgentStatus::Idle)
        })
    })
    .await;
    let said: Vec<_> = attentions(&mut r.rx)
        .into_iter()
        .filter(|(reason, body)| {
            *reason == AttentionReason::Done && body.contains("after your usage limit reset")
        })
        .collect();
    assert_eq!(said.len(), 1, "{said:?}");
    assert_eq!(said[0].1, "Resumed 5 agents after your usage limit reset");
    r.core.shutdown().await;
}

#[tokio::test]
async fn the_accounts_usage_windows_name_the_reset() {
    let r = rig("usage").await;
    // The message says nothing; the usage snapshot sent with it says the window resets in 2 s.
    let resets = (now_ms() / 1000) + 3;
    config(
        r.project.path(),
        "You've hit your usage limit",
        serde_json::json!({"status": "rejected", "unifiedWindows": {
            "five_hour": {"utilization": 1.0, "resetsAt": resets, "status": "rejected"}}}),
    );
    let agent = new_agent(&r.core, r.project.path(), "Usage").await;
    until("waiting", 20, || waiting(&r.core, &agent.id)).await;
    let at = r.core.agent(&agent.id).unwrap().limit_resets_at;
    assert_eq!(
        at,
        Some(resets * 1000),
        "taken from the account's full window"
    );
    lift(r.project.path(), resets * 1000);
    until("resumed", 40, || {
        automatic_messages(&r.core, &agent.id) == 1
            && r.core
                .agent(&agent.id)
                .is_ok_and(|a| a.status == AgentStatus::Idle)
    })
    .await;
    r.core.shutdown().await;
}

#[tokio::test]
async fn an_unknown_reset_is_probed_after_a_while() {
    let r = rig("unknown").await;
    config(
        r.project.path(),
        "Too many requests",
        serde_json::Value::Null,
    );
    let agent = new_agent(&r.core, r.project.path(), "Unknown").await;
    until("waiting", 20, || waiting(&r.core, &agent.id)).await;
    let a = r.core.agent(&agent.id).unwrap();
    assert_eq!(a.limit_resets_at, None, "no time to promise");
    assert!(a.limit_resume.unwrap().probe_at.is_some());
    // 15 minutes / 1000 later it tries anyway, and the limit is gone by then (on a slow machine a
    // probe can land first and be refused: then the retry after it works).
    lift(r.project.path(), now_ms());
    until("probe resumed it", 30, || {
        automatic_messages(&r.core, &agent.id) >= 1
            && r.core
                .agent(&agent.id)
                .is_ok_and(|a| a.status == AgentStatus::Idle)
    })
    .await;
    r.core.shutdown().await;
}

#[tokio::test]
async fn a_wait_survives_a_restart_and_resumes_at_startup() {
    use_mock();
    let data = Dir::new("restart-data");
    let project = Dir::new("restart-project");
    config(
        project.path(),
        "usage limit reached, resets in 2 seconds",
        serde_json::Value::Null,
    );
    let (core, _rx) = open(data.path());
    core.startup().await;
    let agent = new_agent(&core, project.path(), "Restarted").await;
    until("waiting", 20, || waiting(&core, &agent.id)).await;
    lift(
        project.path(),
        core.agent(&agent.id).unwrap().limit_resets_at.unwrap(),
    );
    core.shutdown().await;
    drop(core);

    // The reset passes while the app is closed.
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let (core, _rx) = open(data.path());
    let a = core.agent(&agent.id).unwrap();
    assert!(
        a.rate_limited && a.limit_resume.is_some() && a.limit_resets_at.is_some(),
        "persisted"
    );
    assert_eq!(a.status, AgentStatus::Error);
    core.startup().await;
    until("resumed at startup", 30, || {
        automatic_messages(&core, &agent.id) == 1
            && core
                .agent(&agent.id)
                .is_ok_and(|a| a.status == AgentStatus::Idle)
    })
    .await;
    core.shutdown().await;
}

#[tokio::test]
async fn with_the_setting_off_at_startup_an_old_wait_is_left_alone() {
    use_mock();
    let data = Dir::new("offstart-data");
    let project = Dir::new("offstart-project");
    config(
        project.path(),
        "usage limit reached, resets in 1 seconds",
        serde_json::Value::Null,
    );
    let (core, _rx) = open(data.path());
    core.startup().await;
    let agent = new_agent(&core, project.path(), "Off at start").await;
    until("waiting", 20, || waiting(&core, &agent.id)).await;
    core.update_settings(|s| s.resume_after_limit = false)
        .unwrap();
    core.shutdown().await;
    drop(core);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let (core, _rx) = open(data.path());
    core.startup().await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(automatic_messages(&core, &agent.id), 0);
    core.shutdown().await;
}

#[test]
fn old_agents_and_settings_without_the_new_fields_still_load() {
    // An agent saved before this feature.
    let agent = serde_json::json!({
        "id": "a", "title": "t", "provider": "claude", "accountId": "x", "projectPath": "/p",
        "cwd": "/p", "worktree": false, "branch": null, "baseBranch": null, "baseCommit": null,
        "sessionId": null, "status": "error", "running": false, "groupId": null, "createdAt": 1,
        "updatedAt": 1, "lastActivityAt": 1, "costUsd": 0.0, "tokensUsed": 0, "contextUsed": null,
        "contextSize": null, "unread": false, "archived": false, "lastMessage": null,
        "pendingPermissions": 0, "rateLimited": true
    });
    let a: Agent = serde_json::from_value(agent).unwrap();
    assert!(a.rate_limited && a.limit_resets_at.is_none() && a.limit_resume.is_none());
    // Settings saved before it get the default, which is on.
    let s: Settings = serde_json::from_str(r#"{"onboarded":true,"autoResume":true}"#).unwrap();
    assert!(s.resume_after_limit && s.auto_resume);
    // An explicit off is kept.
    let s: Settings = serde_json::from_str(r#"{"resumeAfterLimit":false}"#).unwrap();
    assert!(!s.resume_after_limit);
    // Timeline messages from before have no flag, and the flag is not written when false.
    let m: ItemBody = serde_json::from_str(r#"{"kind":"user_message","text":"hi"}"#).unwrap();
    assert!(matches!(
        m,
        ItemBody::UserMessage {
            automatic: false,
            ..
        }
    ));
    let json = serde_json::to_value(&m).unwrap();
    assert!(json.get("automatic").is_none());
}
