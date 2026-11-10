//! A Codex turn whose events carry no turn id still finishes (it must not wedge the agent).

#![cfg(unix)]

use std::sync::Arc;
use std::time::Duration;

use kvistcode_core::*;
use tokio::sync::mpsc;

struct Sink(mpsc::UnboundedSender<KvistcodeEvent>);

impl EventSink for Sink {
    fn emit(&self, event: KvistcodeEvent) {
        let _ = self.0.send(event);
    }
}

mod common;

#[tokio::test]
async fn a_turn_without_event_ids_finishes() {
    let mock = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mock_codex_noid.py");
    std::env::set_var("KVISTCODE_CODEX_COMMAND", format!("python3 {mock}"));
    let data = common::scratch("test-codex-noid-data");
    let project = common::scratch("test-codex-noid-project");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let core = Core::open(data, Arc::new(Sink(tx))).unwrap();
    let account = core
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.provider == Provider::Codex && a.is_system)
        .unwrap();
    let agent = core
        .create_agent(CreateAgentRequest {
            provider: Provider::Codex,
            account_id: account.id,
            project_path: project.to_string_lossy().into_owned(),
            prompt: "go".into(),
            title: None,
            worktree: false,
            model: None,
            group_id: None,
            custom_agent_id: None,
            permission_mode: None,
            attachments: vec![],
            config_choices: Default::default(),
        })
        .await
        .unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            match rx.recv().await.expect("channel open") {
                KvistcodeEvent::Attention {
                    reason: AttentionReason::Done,
                    ..
                } => return true,
                KvistcodeEvent::Attention {
                    reason: AttentionReason::Error,
                    ..
                } => return false,
                _ => {}
            }
        }
    })
    .await
    .expect("the turn never finished");
    assert!(outcome, "the turn failed");
    let items = core.items(&agent.id).unwrap();
    assert!(items
        .iter()
        .any(|i| matches!(&i.body, ItemBody::AgentMessage { text, .. } if text == "all done")));
    core.shutdown().await;
}
