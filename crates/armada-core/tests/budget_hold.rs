//! Spending limits at a turn boundary: a limit hit mid-turn never stops the turn (or a
//! tool call); the agent is held when the turn ends, its queue stays queued, and
//! "Raise limit / Continue once / Stop" decide what happens next.

#![cfg(unix)]

use std::sync::Arc;
use std::time::Duration;

use armada_core::budget::{BudgetAction, BudgetChoice, BudgetMetric, BudgetScope};
use armada_core::*;
use tokio::sync::mpsc;

const TESTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests");

struct Sink(mpsc::UnboundedSender<ArmadaEvent>);

impl EventSink for Sink {
    fn emit(&self, event: ArmadaEvent) {
        let _ = self.0.send(event);
    }
}

type Rx = mpsc::UnboundedReceiver<ArmadaEvent>;

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("armada-budget-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn wait_for(rx: &mut Rx, mut f: impl FnMut(&ArmadaEvent) -> bool) -> Option<ArmadaEvent> {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let ev = rx.recv().await?;
            if f(&ev) {
                return Some(ev);
            }
        }
    })
    .await
    .ok()
    .flatten()
}

fn is_attention(e: &ArmadaEvent, r: AttentionReason) -> bool {
    matches!(e, ArmadaEvent::Attention { reason, .. } if *reason == r)
}

struct Env {
    core: Core,
    rx: Rx,
    project: std::path::PathBuf,
    account: String,
}

/// A core with a mock agent (each "COST" turn reports $0.50) and the Pause action.
async fn setup(name: &str, tune: impl FnOnce(&mut Settings, &str)) -> Env {
    let (tx, rx) = mpsc::unbounded_channel();
    let core = Core::open(temp_dir(&format!("{name}-data")), Arc::new(Sink(tx))).unwrap();
    let project = temp_dir(&format!("{name}-project"));
    let mut settings = core.settings().unwrap();
    settings.custom_agents = vec![CustomAgent {
        id: "mock".into(),
        name: "Mock".into(),
        command: "python3".into(),
        args: vec![format!("{TESTS}/mock_modes.py"), "normal".into()],
        env: vec![],
        color: "#B39DDB".into(),
        enabled: true,
    }];
    settings.budget_action = BudgetAction::Pause;
    tune(&mut settings, &project.to_string_lossy());
    core.save_settings(settings).unwrap();
    let account = core
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.provider == Provider::Custom)
        .unwrap()
        .id;
    Env {
        core,
        rx,
        project,
        account,
    }
}

fn request(env: &Env, prompt: &str) -> CreateAgentRequest {
    CreateAgentRequest {
        provider: Provider::Custom,
        account_id: env.account.clone(),
        project_path: env.project.to_string_lossy().into_owned(),
        prompt: prompt.into(),
        title: None,
        worktree: false,
        model: None,
        group_id: None,
        custom_agent_id: Some("mock".into()),
        permission_mode: None,
        attachments: vec![],
    }
}

/// The hold's Needs-you alert (the Permission reason without a request).
fn is_hold_alert(e: &ArmadaEvent) -> bool {
    matches!(e, ArmadaEvent::Attention { reason: AttentionReason::Permission, request_id: None, title, .. }
        if title == "Paused at a spending limit")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_limit_holds_the_agent_at_the_end_of_the_turn() {
    let mut env = setup("hold", |s, _| s.agent_budget_usd = Some(0.4)).await;
    let agent = env
        .core
        .create_agent(request(&env, "COST one"))
        .await
        .unwrap();
    wait_for(&mut env.rx, is_hold_alert).await.expect("hold");
    // The hold is placed as the turn ends; the status settles right after.
    for _ in 0..50 {
        if env.core.agent(&agent.id).unwrap().status == AgentStatus::Idle {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let a = env.core.agent(&agent.id).unwrap();
    let hold = a.budget_hold.expect("held");
    assert_eq!(
        (hold.scope, hold.metric),
        (BudgetScope::Agent, BudgetMetric::Cost)
    );
    assert_eq!((hold.spent, hold.cap), (0.5, 0.4));
    assert_eq!(a.status, AgentStatus::Idle);
    // The turn finished normally: the reply is in the timeline, and no "finished" alert
    // was raised on top of the Needs-you one.
    assert!(env
        .core
        .items(&agent.id)
        .unwrap()
        .iter()
        .any(|i| matches!(&i.body, ItemBody::AgentMessage { text, .. } if text.contains("reply to COST one"))));
    while let Ok(ev) = env.rx.try_recv() {
        assert!(!is_attention(&ev, AttentionReason::Done), "{ev:?}");
    }

    // Raising it by too little is refused and changes nothing.
    let err = env
        .core
        .budget_resolve(&agent.id, BudgetChoice::Raise { by: 0.05 })
        .await
        .unwrap_err();
    assert!(err.to_string().contains("still under"), "{err}");
    assert!(env.core.agent(&agent.id).unwrap().budget_hold.is_some());

    // Raise it: this agent's own limit goes up, the default stays, the hold is gone.
    let settings = env
        .core
        .budget_resolve(&agent.id, BudgetChoice::Raise { by: 1.0 })
        .await
        .unwrap();
    assert_eq!(settings.agent_budget_usd, Some(0.4));
    let a = env.core.agent(&agent.id).unwrap();
    assert!(a.budget_hold.is_none());
    assert_eq!(a.budget.and_then(|b| b.usd), Some(1.4));

    // Under the new limit the next turn ends normally.
    env.core
        .send_prompt(&agent.id, "COST two", vec![])
        .await
        .unwrap();
    wait_for(&mut env.rx, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("finished");
    assert!(env.core.agent(&agent.id).unwrap().budget_hold.is_none());
    env.core.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_hit_mid_turn_never_stops_the_turn_and_the_queue_waits() {
    let mut env = setup("queue", |s, _| s.agent_budget_usd = Some(0.4)).await;
    // The turn reports its cost, then waits for an approval: it is over the limit and
    // still running.
    let agent = env
        .core
        .create_agent(request(&env, "PERM COST first"))
        .await
        .unwrap();
    let ev = wait_for(&mut env.rx, |e| {
        matches!(e, ArmadaEvent::ItemUpserted { item } if matches!(item.body, ItemBody::Permission { resolution: None, .. }))
    })
    .await
    .expect("permission");
    env.core
        .send_prompt(&agent.id, "COST second", vec![])
        .await
        .unwrap();
    assert_eq!(env.core.agent(&agent.id).unwrap().queued_prompts, 1);
    let a = env.core.agent(&agent.id).unwrap();
    assert!(a.budget_hold.is_none(), "not held while the turn runs");
    assert_eq!(a.status, AgentStatus::NeedsPermission);

    let ArmadaEvent::ItemUpserted { item } = ev else {
        unreachable!()
    };
    let ItemBody::Permission { request_id, .. } = item.body else {
        unreachable!()
    };
    env.core
        .respond_permission(&agent.id, &request_id, "yes")
        .await
        .unwrap();
    wait_for(&mut env.rx, is_hold_alert).await.expect("hold");

    // The approved tool call completed; the queued message did not start.
    let a = env.core.agent(&agent.id).unwrap();
    assert!(a.budget_hold.is_some());
    assert_eq!((a.queued_prompts, a.queue_paused), (1, true));
    assert!(!env
        .core
        .items(&agent.id)
        .unwrap()
        .iter()
        .any(|i| matches!(&i.body, ItemBody::UserMessage { text, .. } if text == "COST second")));

    // Continue once: the queued message runs; at the end of that turn it is held again.
    env.core
        .budget_resolve(&agent.id, BudgetChoice::ContinueOnce)
        .await
        .unwrap();
    wait_for(&mut env.rx, is_hold_alert)
        .await
        .expect("held again");
    let a = env.core.agent(&agent.id).unwrap();
    assert!(a.budget_hold.is_some());
    assert_eq!(a.queued_prompts, 0);
    assert!(env
        .core
        .items(&agent.id)
        .unwrap()
        .iter()
        .any(|i| matches!(&i.body, ItemBody::UserMessage { text, .. } if text == "COST second")));
    env.core.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_drops_the_queue_and_dismisses_the_item() {
    let mut env = setup("stop", |s, _| s.agent_budget_usd = Some(0.4)).await;
    let agent = env
        .core
        .create_agent(request(&env, "PERM COST first"))
        .await
        .unwrap();
    let ev = wait_for(&mut env.rx, |e| {
        matches!(e, ArmadaEvent::ItemUpserted { item } if matches!(item.body, ItemBody::Permission { resolution: None, .. }))
    })
    .await
    .expect("permission");
    env.core
        .send_prompt(&agent.id, "COST second", vec![])
        .await
        .unwrap();
    let ArmadaEvent::ItemUpserted { item } = ev else {
        unreachable!()
    };
    let ItemBody::Permission { request_id, .. } = item.body else {
        unreachable!()
    };
    env.core
        .respond_permission(&agent.id, &request_id, "yes")
        .await
        .unwrap();
    wait_for(&mut env.rx, is_hold_alert).await.expect("hold");

    env.core
        .budget_resolve(&agent.id, BudgetChoice::Stop)
        .await
        .unwrap();
    let a = env.core.agent(&agent.id).unwrap();
    assert!(a.budget_hold.is_none());
    assert_eq!(a.queued_prompts, 0);
    assert!(a.acknowledged_at.is_some());
    // Answering again (a second window) is harmless.
    env.core
        .budget_resolve(&agent.id, BudgetChoice::Stop)
        .await
        .unwrap();
    env.core.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn raising_a_project_limit_frees_every_agent_held_by_it() {
    let mut env = setup("project", |s, project| {
        s.project_budgets.insert(
            project.to_string(),
            armada_core::budget::BudgetCap {
                usd: Some(0.6),
                tokens: None,
            },
        );
    })
    .await;
    // Two agents in one project: each spends $0.50, the project passes $0.60 as the
    // second one finishes.
    let first = env
        .core
        .create_agent(request(&env, "COST a"))
        .await
        .unwrap();
    wait_for(&mut env.rx, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("first finishes under the limit");
    let second = env
        .core
        .create_agent(request(&env, "COST b"))
        .await
        .unwrap();
    wait_for(&mut env.rx, is_hold_alert).await.expect("hold");
    let hold = env.core.agent(&second.id).unwrap().budget_hold.unwrap();
    assert_eq!(hold.scope, BudgetScope::Project);
    assert!((hold.spent - 1.0).abs() < 1e-9);

    let settings = env
        .core
        .budget_resolve(&second.id, BudgetChoice::Raise { by: 2.0 })
        .await
        .unwrap();
    let key = env.project.to_string_lossy().into_owned();
    assert_eq!(settings.project_budgets[&key].usd, Some(2.6));
    assert!(env.core.agent(&second.id).unwrap().budget_hold.is_none());
    assert!(env.core.agent(&first.id).unwrap().budget_hold.is_none());
    env.core.shutdown().await;
}
