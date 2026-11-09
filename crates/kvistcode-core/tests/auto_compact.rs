//! "Compact automatically at X% full": between turns, once per crossing, with a timeline note.

#![cfg(unix)]

use std::sync::Arc;
use std::time::Duration;

use kvistcode_core::*;
use tokio::sync::mpsc;

mod common;

struct Sink(mpsc::UnboundedSender<KvistcodeEvent>);

impl EventSink for Sink {
    fn emit(&self, event: KvistcodeEvent) {
        let _ = self.0.send(event);
    }
}

/// Waits for at least one finished turn, then until the agent has been quiet for a while (a
/// compaction starts right after a turn, so the quiet gap only comes once it is done too).
async fn settle(rx: &mut mpsc::UnboundedReceiver<KvistcodeEvent>) {
    let done = |e: &KvistcodeEvent| matches!(e, KvistcodeEvent::Attention { reason, .. } if *reason == AttentionReason::Done);
    tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(e) = rx.recv().await {
            if done(&e) {
                break;
            }
        }
        while let Ok(Some(_)) = tokio::time::timeout(Duration::from_millis(1500), rx.recv()).await {
        }
    })
    .await
    .expect("the agent settles");
}

async fn run(stuck: bool, name: &str, percent: Option<u8>) -> (Vec<String>, Vec<String>) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let core = Core::open(
        common::scratch(&format!("compact-{name}-data")),
        Arc::new(Sink(tx)),
    )
    .unwrap();
    let log = common::scratch(&format!("compact-{name}-log")).join("prompts");
    let mock = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mock_fullctx.py");
    core.update_settings(|s| {
        s.auto_compact_percent = percent;
        s.custom_agents = vec![CustomAgent {
            id: "mock".into(),
            name: "Mock".into(),
            command: "python3".into(),
            args: vec![
                mock.into(),
                if stuck { "stuck" } else { "ok" }.into(),
                log.to_string_lossy().into_owned(),
            ],
            env: vec![],
            color: "#B39DDB".into(),
            enabled: true,
        }];
    })
    .unwrap();
    let account = core
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.provider == Provider::Custom)
        .unwrap()
        .id;
    let agent = core
        .create_agent(CreateAgentRequest {
            provider: Provider::Custom,
            account_id: account,
            project_path: common::scratch(&format!("compact-{name}-project"))
                .to_string_lossy()
                .into_owned(),
            prompt: "one".into(),
            title: None,
            worktree: false,
            model: None,
            group_id: None,
            custom_agent_id: Some("mock".into()),
            permission_mode: None,
            attachments: vec![],
        })
        .await
        .unwrap();
    // Turn one (and any compaction after it), then a later message (and any after that).
    settle(&mut rx).await;
    core.send_prompt(&agent.id, "two", vec![]).await.unwrap();
    settle(&mut rx).await;
    let items = core.items(&agent.id).unwrap();
    // Kvistcode's `/compact` is not the rate-limit resume (whose note says so).
    assert!(items.iter().all(|i| !matches!(&i.body,
        ItemBody::UserMessage { text, automatic: true, .. } if text == "/compact")));
    let notices = items
        .into_iter()
        .filter_map(|i| match i.body {
            ItemBody::Notice { text, .. } if text.contains("automatically") => Some(text),
            _ => None,
        })
        .collect();
    let prompts = std::fs::read_to_string(&log)
        .unwrap_or_default()
        .lines()
        .filter(|l| matches!(*l, "one" | "two" | "/compact"))
        .map(String::from)
        .collect();
    core.shutdown().await;
    (prompts, notices)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn compacts_once_per_crossing_and_says_so() {
    let (prompts, notices) = run(false, "ok", Some(80)).await;
    // Full after "one": compact; it brings usage to 10%; "two" fills it again: compact again.
    assert_eq!(prompts, ["one", "/compact", "two", "/compact"]);
    assert_eq!(notices.len(), 2);
    assert!(notices[0].contains("90%"), "{notices:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn does_not_loop_when_compacting_does_not_help() {
    let (prompts, notices) = run(true, "stuck", Some(80)).await;
    assert_eq!(prompts, ["one", "/compact", "two"]);
    assert_eq!(notices.len(), 1, "{notices:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn off_by_default() {
    let (prompts, notices) = run(false, "off", None).await;
    assert_eq!(prompts, ["one", "two"]);
    assert!(notices.is_empty());
}
