//! Turn-count spending limits: the third unit next to cost and tokens, for accounts with
//! no per-token cost. They reuse the hold machinery of `budget_hold.rs`; this checks the
//! counting (per agent, project and day), that it survives a restart, and old data.

#![cfg(unix)]

use std::sync::Arc;
use std::time::Duration;

use kvistcode_core::budget::{BudgetAction, BudgetChoice, BudgetMetric, BudgetScope};
use kvistcode_core::*;
use tokio::sync::mpsc;

const TESTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests");

struct Sink(mpsc::UnboundedSender<KvistcodeEvent>);

impl EventSink for Sink {
    fn emit(&self, event: KvistcodeEvent) {
        let _ = self.0.send(event);
    }
}

type Rx = mpsc::UnboundedReceiver<KvistcodeEvent>;

mod common;

fn temp_dir(name: &str) -> std::path::PathBuf {
    common::scratch(&format!("turns-{name}"))
}

async fn wait_for(
    rx: &mut Rx,
    mut f: impl FnMut(&KvistcodeEvent) -> bool,
) -> Option<KvistcodeEvent> {
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

fn is_done(e: &KvistcodeEvent) -> bool {
    matches!(
        e,
        KvistcodeEvent::Attention {
            reason: AttentionReason::Done,
            ..
        }
    )
}

/// The hold's Needs-you alert (the Permission reason without a request).
fn is_hold_alert(e: &KvistcodeEvent) -> bool {
    matches!(e, KvistcodeEvent::Attention { reason: AttentionReason::Permission, request_id: None, title, .. }
        if title == "Paused at a spending limit")
}

struct Env {
    core: Core,
    rx: Rx,
    data: std::path::PathBuf,
    project: std::path::PathBuf,
    account: String,
}

fn open(data: &std::path::Path, tx: mpsc::UnboundedSender<KvistcodeEvent>) -> Core {
    Core::open(data.to_path_buf(), Arc::new(Sink(tx))).unwrap()
}

/// A core with a mock agent and the Pause action.
async fn setup(name: &str, tune: impl FnOnce(&mut Settings, &str)) -> Env {
    let (tx, rx) = mpsc::unbounded_channel();
    let data = temp_dir(&format!("{name}-data"));
    let core = open(&data, tx);
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
        data,
        project,
        account,
    }
}

fn request(env: &Env, project: &std::path::Path, prompt: &str) -> CreateAgentRequest {
    CreateAgentRequest {
        provider: Provider::Custom,
        account_id: env.account.clone(),
        project_path: project.to_string_lossy().into_owned(),
        prompt: prompt.into(),
        title: None,
        worktree: false,
        model: None,
        group_id: None,
        custom_agent_id: Some("mock".into()),
        permission_mode: None,
        attachments: vec![],
        config_choices: Default::default(),
    }
}

async fn settle(core: &Core, id: &str) {
    for _ in 0..100 {
        if core.agent(id).unwrap().status == AgentStatus::Idle {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("agent never went idle");
}

/// Creates an agent whose first turn has finished (a "done" alert, or the hold's).
async fn start(env: &mut Env, project: &std::path::Path, prompt: &str) -> Agent {
    let agent = env
        .core
        .create_agent(request(env, project, prompt))
        .await
        .unwrap();
    wait_for(&mut env.rx, |e| is_done(e) || is_hold_alert(e))
        .await
        .expect("first turn finished");
    settle(&env.core, &agent.id).await;
    agent
}

/// Sends a prompt and waits for the turn to finish.
async fn turn(env: &mut Env, id: &str, prompt: &str) {
    env.core.send_prompt(id, prompt, vec![]).await.unwrap();
    wait_for(&mut env.rx, |e| is_done(e) || is_hold_alert(e))
        .await
        .expect("turn finished");
    settle(&env.core, id).await;
}

fn notices(core: &Core, id: &str) -> Vec<String> {
    core.items(id)
        .unwrap()
        .into_iter()
        .filter_map(|i| match i.body {
            ItemBody::Notice { text, .. } => Some(text),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_agent_is_warned_at_80_percent_then_held_after_its_last_turn() {
    let mut env = setup("agent", |s, _| s.agent_budget_turns = Some(5)).await;
    let project = env.project.clone();
    let agent = start(&mut env, &project, "one").await;
    assert_eq!(env.core.agent(&agent.id).unwrap().turns, Some(1));
    for (n, prompt) in [(2, "two"), (3, "three"), (4, "four")] {
        turn(&mut env, &agent.id, prompt).await;
        let a = env.core.agent(&agent.id).unwrap();
        assert_eq!(a.turns, Some(n));
        assert!(a.budget_hold.is_none());
    }
    // 4 of 5 is 80%: a notice, no hold.
    let warned = notices(&env.core, &agent.id);
    assert!(
        warned
            .iter()
            .any(|t| t.contains("Close to the agent limit") && t.contains("4 of 5 turns")),
        "{warned:?}"
    );
    assert!(!warned.iter().any(|t| t.contains("reached")), "{warned:?}");

    // The fifth turn finishes normally and the agent is held after it.
    turn(&mut env, &agent.id, "five").await;
    let a = env.core.agent(&agent.id).unwrap();
    assert_eq!(a.turns, Some(5));
    let hold = a.budget_hold.expect("held");
    assert_eq!(
        (hold.scope, hold.metric, hold.spent, hold.cap),
        (BudgetScope::Agent, BudgetMetric::Turns, 5.0, 5.0)
    );
    // The hold travels to the UI and the phone as plain fields.
    let json = serde_json::to_value(&a).unwrap();
    assert_eq!(json["turns"], 5);
    assert_eq!(json["budgetHold"]["metric"], "turns");
    assert_eq!(json["budgetHold"]["scope"], "agent");
    assert_eq!(json["budgetHold"]["spent"], 5.0);
    assert_eq!(json["budgetHold"]["cap"], 5.0);
    assert!(env.core.items(&agent.id).unwrap().iter().any(
        |i| matches!(&i.body, ItemBody::AgentMessage { text, .. } if text.contains("reply to five"))
    ));

    // A raise of nothing is refused.
    let err = env
        .core
        .budget_resolve(&agent.id, BudgetChoice::Raise { by: 0.0 })
        .await
        .unwrap_err();
    assert!(err.to_string().contains("above zero"), "{err}");

    // Raise by two turns: this agent's own limit is 7, the default stays 5.
    let settings = env
        .core
        .budget_resolve(&agent.id, BudgetChoice::Raise { by: 2.0 })
        .await
        .unwrap();
    assert_eq!(settings.agent_budget_turns, Some(5));
    let a = env.core.agent(&agent.id).unwrap();
    assert!(a.budget_hold.is_none());
    assert_eq!(a.budget.and_then(|b| b.turns), Some(7));
    turn(&mut env, &agent.id, "six").await;
    assert!(env.core.agent(&agent.id).unwrap().budget_hold.is_none());
    turn(&mut env, &agent.id, "seven").await;
    let hold = env
        .core
        .agent(&agent.id)
        .unwrap()
        .budget_hold
        .expect("held again");
    assert_eq!((hold.spent, hold.cap), (7.0, 7.0));

    // Continue once: one more turn, then it is checked again.
    env.core
        .budget_resolve(&agent.id, BudgetChoice::ContinueOnce)
        .await
        .unwrap();
    assert!(env.core.agent(&agent.id).unwrap().budget_hold.is_none());
    turn(&mut env, &agent.id, "eight").await;
    let hold = env
        .core
        .agent(&agent.id)
        .unwrap()
        .budget_hold
        .expect("held a third time");
    assert_eq!((hold.spent, hold.cap), (8.0, 7.0));
    env.core.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cancelled_turn_is_not_counted_and_stop_ends_the_hold() {
    let mut env = setup("stop", |s, _| s.agent_budget_turns = Some(2)).await;
    let project = env.project.clone();
    let agent = start(&mut env, &project, "one").await;
    // A turn that is cancelled never completed: it isn't counted.
    env.core
        .send_prompt(&agent.id, "CANCELERR", vec![])
        .await
        .unwrap();
    for _ in 0..100 {
        if env.core.agent(&agent.id).unwrap().status == AgentStatus::Working {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    env.core.cancel_turn(&agent.id).await.unwrap();
    for _ in 0..200 {
        if notices(&env.core, &agent.id)
            .iter()
            .any(|t| t == "Turn cancelled")
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    settle(&env.core, &agent.id).await;
    let a = env.core.agent(&agent.id).unwrap();
    assert_eq!(a.turns, Some(1));
    assert!(a.budget_hold.is_none());

    // The second completed turn reaches the limit; Stop dismisses the hold.
    turn(&mut env, &agent.id, "two").await;
    assert!(env.core.agent(&agent.id).unwrap().budget_hold.is_some());
    env.core
        .budget_resolve(&agent.id, BudgetChoice::Stop)
        .await
        .unwrap();
    let a = env.core.agent(&agent.id).unwrap();
    assert!(a.budget_hold.is_none());
    assert_eq!(a.turns, Some(2));
    env.core.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_project_limit_counts_every_agent_in_the_folder() {
    let mut env = setup("project", |s, project| {
        s.project_budgets.insert(
            project.to_string(),
            kvistcode_core::budget::BudgetCap {
                turns: Some(3),
                ..Default::default()
            },
        );
    })
    .await;
    let project = env.project.clone();
    let first = start(&mut env, &project, "a1").await;
    let second = start(&mut env, &project, "b1").await;
    // An agent in another folder doesn't count toward it.
    let other = temp_dir("project-other");
    let elsewhere = start(&mut env, &other, "c1").await;
    assert!(env.core.agent(&elsewhere.id).unwrap().budget_hold.is_none());
    assert!(env.core.agent(&second.id).unwrap().budget_hold.is_none());

    // The third turn in the folder hits the limit and holds its agent; raising the
    // project's limit frees it.
    turn(&mut env, &first.id, "a2").await;
    let hold = env
        .core
        .agent(&first.id)
        .unwrap()
        .budget_hold
        .expect("held");
    assert_eq!(
        (hold.scope, hold.metric, hold.spent, hold.cap),
        (BudgetScope::Project, BudgetMetric::Turns, 3.0, 3.0)
    );
    let settings = env
        .core
        .budget_resolve(&first.id, BudgetChoice::Raise { by: 5.0 })
        .await
        .unwrap();
    let key = env.project.to_string_lossy().into_owned();
    assert_eq!(settings.project_budgets[&key].turns, Some(8));
    assert!(env.core.agent(&first.id).unwrap().budget_hold.is_none());
    env.core.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_daily_turn_limit_counts_all_agents_and_shows_in_the_status() {
    let mut env = setup("daily", |s, _| s.daily_budget_turns = Some(2)).await;
    let project = env.project.clone();
    let first = start(&mut env, &project, "a1").await;
    assert!(env.core.agent(&first.id).unwrap().budget_hold.is_none());
    let status = env.core.budget_status();
    assert_eq!(
        (status.today_turns, status.daily_budget_turns),
        (1, Some(2))
    );
    let other = temp_dir("daily-other");
    let second = start(&mut env, &other, "b1").await;
    let hold = env
        .core
        .agent(&second.id)
        .unwrap()
        .budget_hold
        .expect("held");
    assert_eq!(
        (hold.scope, hold.metric, hold.spent, hold.cap),
        (BudgetScope::Daily, BudgetMetric::Turns, 2.0, 2.0)
    );
    assert_eq!(env.core.budget_status().today_turns, 2);

    // Raising the day's limit lives in settings.
    let settings = env
        .core
        .budget_resolve(&second.id, BudgetChoice::Raise { by: 10.0 })
        .await
        .unwrap();
    assert_eq!(settings.daily_budget_turns, Some(12));
    assert!(env.core.agent(&second.id).unwrap().budget_hold.is_none());
    env.core.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_count_and_the_hold_survive_a_restart() {
    let mut env = setup("restart", |s, _| s.agent_budget_turns = Some(2)).await;
    let project = env.project.clone();
    let agent = start(&mut env, &project, "one").await;
    turn(&mut env, &agent.id, "two").await;
    assert!(env.core.agent(&agent.id).unwrap().budget_hold.is_some());
    env.core.shutdown().await;

    let (tx, _rx) = mpsc::unbounded_channel();
    let core = open(&env.data, tx);
    let a = core.agent(&agent.id).unwrap();
    assert_eq!(a.turns, Some(2));
    assert_eq!(
        a.budget_hold.map(|h| (h.metric, h.spent)),
        Some((BudgetMetric::Turns, 2.0))
    );
    core.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_agent_from_before_turn_limits_is_counted_from_its_messages() {
    let mut env = setup("migrate", |_, _| {}).await;
    let project = env.project.clone();
    let agent = start(&mut env, &project, "one").await;
    turn(&mut env, &agent.id, "two").await;
    turn(&mut env, &agent.id, "three").await;
    env.core.shutdown().await;

    // Rewrite the stored agent the way v0.3.0 wrote it: no `turns` at all.
    {
        let conn = rusqlite::Connection::open(env.data.join("armada.db")).unwrap();
        let data: String = conn
            .query_row("SELECT data FROM agents WHERE id = ?1", [&agent.id], |r| {
                r.get(0)
            })
            .unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&data).unwrap();
        assert!(v.as_object_mut().unwrap().remove("turns").is_some());
        conn.execute(
            "UPDATE agents SET data = ?2 WHERE id = ?1",
            rusqlite::params![agent.id, v.to_string()],
        )
        .unwrap();
        let old: Agent = serde_json::from_value(v).unwrap();
        assert_eq!(old.turns, None);
    }

    let (tx, mut rx) = mpsc::unbounded_channel();
    let core = open(&env.data, tx);
    assert_eq!(core.agent(&agent.id).unwrap().turns, Some(3));
    // And it keeps counting from there.
    let mut s = core.settings().unwrap();
    s.agent_budget_turns = Some(4);
    core.save_settings(s).unwrap();
    core.send_prompt(&agent.id, "four", vec![]).await.unwrap();
    wait_for(&mut rx, is_hold_alert).await.expect("hold at 4");
    assert_eq!(core.agent(&agent.id).unwrap().turns, Some(4));
    core.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turn_limits_are_validated_and_old_settings_load() {
    let env = setup("invalid", |_, _| {}).await;
    let good = env.core.settings().unwrap();
    for bad in [
        |s: &mut Settings| s.agent_budget_turns = Some(0),
        |s: &mut Settings| s.daily_budget_turns = Some(-3),
        |s: &mut Settings| {
            s.project_budgets.insert(
                "/work/app".into(),
                kvistcode_core::budget::BudgetCap {
                    turns: Some(0),
                    ..Default::default()
                },
            );
        },
    ] {
        let mut s = good.clone();
        bad(&mut s);
        assert!(env.core.save_settings(s).is_err());
    }
    let mut s = good.clone();
    s.agent_budget_turns = Some(30);
    s.daily_budget_turns = Some(200);
    assert!(env.core.save_settings(s).is_ok());

    // Settings saved by v0.3.0 have neither field.
    let mut v = serde_json::to_value(&good).unwrap();
    let o = v.as_object_mut().unwrap();
    assert!(o.remove("agentBudgetTurns").is_some() && o.remove("dailyBudgetTurns").is_some());
    let old: Settings = serde_json::from_value(v).unwrap();
    assert_eq!(
        (old.agent_budget_turns, old.daily_budget_turns),
        (None, None)
    );
    env.core.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn raising_a_limit_starts_from_the_limit_as_it_is_now() {
    let mut env = setup("raise-current", |s, _| s.daily_budget_turns = Some(2)).await;
    let project = env.project.clone();
    let first = start(&mut env, &project, "a1").await;
    let other = temp_dir("raise-current-other");
    let second = start(&mut env, &other, "b1").await;
    assert!(env.core.agent(&second.id).unwrap().budget_hold.is_some());
    assert!(env.core.agent(&first.id).unwrap().budget_hold.is_none());

    // The limit is edited in Settings while the agent waits. "Raise" on the held agent adds
    // to that, not to the limit the hold recorded (2 + 5 would lower it to 7).
    env.core
        .update_settings(|s| s.daily_budget_turns = Some(50))
        .unwrap();
    let settings = env
        .core
        .budget_resolve(&second.id, BudgetChoice::Raise { by: 5.0 })
        .await
        .unwrap();
    assert_eq!(settings.daily_budget_turns, Some(55));
    assert!(env.core.agent(&second.id).unwrap().budget_hold.is_none());
    env.core.shutdown().await;
}
