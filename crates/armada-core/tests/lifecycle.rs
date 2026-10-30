//! Agent process lifecycle regressions: stop/kill of whole process trees, start
//! failures, crashes, replay on reattach, and determinism of stop. Each test uses
//! its own custom-agent definition so tests can run in parallel.

#![cfg(unix)]

use std::sync::Arc;
use std::time::Duration;

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
    let dir = std::env::temp_dir().join(format!("armada-life-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn wait_for(
    rx: &mut Rx,
    secs: u64,
    mut f: impl FnMut(&ArmadaEvent) -> bool,
) -> Option<ArmadaEvent> {
    tokio::time::timeout(Duration::from_secs(secs), async {
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

fn drain(rx: &mut Rx) -> Vec<ArmadaEvent> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        out.push(ev);
    }
    out
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

/// A core whose only custom agent runs `args` with python3.
async fn setup(name: &str, args: Vec<String>) -> Env {
    let (tx, rx) = mpsc::unbounded_channel();
    let core = Core::open(temp_dir(&format!("{name}-data")), Arc::new(Sink(tx))).unwrap();
    let mut settings = core.settings().unwrap();
    settings.custom_agents = vec![CustomAgent {
        id: "mock".into(),
        name: "Mock".into(),
        command: "python3".into(),
        args,
        env: vec![],
        color: "#B39DDB".into(),
        enabled: true,
    }];
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
        project: temp_dir(&format!("{name}-project")),
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

fn mode(m: &str) -> Vec<String> {
    vec![format!("{TESTS}/mock_modes.py"), m.into()]
}

fn processes_with(marker: &str) -> usize {
    let out = std::process::Command::new("pgrep")
        .args(["-f", marker])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).lines().count()
}

/// npm-style launchers keep the real agent as a child; Stop must end both.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_kills_the_whole_process_tree() {
    let marker = format!("armada-tree-marker-{}", std::process::id());
    let args = vec![
        format!("{TESTS}/mock_wrapper.py"),
        format!("{TESTS}/mock_modes.py"),
        "normal".into(),
        marker.clone(),
    ];
    let mut env = setup("tree", args).await;
    let agent = env
        .core
        .create_agent(request(&env, "PERM please"))
        .await
        .unwrap();
    wait_for(&mut env.rx, 15, |e| {
        is_attention(e, AttentionReason::Permission)
    })
    .await
    .expect("permission");
    assert!(processes_with(&marker) >= 2, "launcher + agent running");

    env.core.stop_agent(&agent.id).await.unwrap();
    let a = env.core.agent(&agent.id).unwrap();
    assert_eq!(a.status, AgentStatus::Stopped);
    assert!(!a.running);
    assert_eq!(a.pending_permissions, 0);
    for _ in 0..50 {
        if processes_with(&marker) == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(processes_with(&marker), 0, "no orphaned agent left behind");

    // The agent is usable again afterwards.
    env.core
        .send_prompt(&agent.id, "hello again", vec![])
        .await
        .unwrap();
    let done = wait_for(&mut env.rx, 15, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("done");
    let ArmadaEvent::Attention { body, .. } = done else {
        unreachable!()
    };
    assert!(body.contains("reply to"));
    env.core.shutdown().await;
}

/// Invalid UTF-8 and floods on stderr must not break the connection.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bad_bytes_on_stderr_are_harmless() {
    let mut env = setup("badbytes", mode("badstderr")).await;
    env.core.create_agent(request(&env, "hi")).await.unwrap();
    let done = wait_for(&mut env.rx, 20, |e| {
        is_attention(e, AttentionReason::Done) || is_attention(e, AttentionReason::Error)
    })
    .await
    .expect("turn ends");
    assert!(is_attention(&done, AttentionReason::Done), "{done:?}");
    env.core.shutdown().await;
}

/// Reattaching with session/load replays history; it must not be duplicated.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_load_replay_is_not_duplicated() {
    let mut env = setup("replay", mode("replay")).await;
    let agent = env.core.create_agent(request(&env, "first")).await.unwrap();
    wait_for(&mut env.rx, 15, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("first turn");
    env.core.stop_agent(&agent.id).await.unwrap();

    env.core
        .send_prompt(&agent.id, "second", vec![])
        .await
        .unwrap();
    wait_for(&mut env.rx, 30, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("second turn");
    let items = env.core.items(&agent.id).unwrap();
    let kinds: Vec<&str> = items.iter().map(|i| i.body.kind_str()).collect();
    assert_eq!(
        kinds,
        [
            "user_message",
            "agent_message",
            "user_message",
            "agent_message"
        ],
        "replayed history leaked into the timeline; notices: {:?}",
        items
            .iter()
            .filter_map(|i| match &i.body {
                ItemBody::Notice { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
    );
    env.core.shutdown().await;
}

/// Stopping always ends in the same state, and never as an error.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_is_deterministic() {
    let mut env = setup("determinism", mode("normal")).await;
    let agent = env
        .core
        .create_agent(request(&env, "PERM 0"))
        .await
        .unwrap();
    for i in 0..15 {
        if i > 0 {
            env.core
                .send_prompt(&agent.id, &format!("PERM {i}"), vec![])
                .await
                .unwrap();
        }
        wait_for(&mut env.rx, 15, |e| {
            is_attention(e, AttentionReason::Permission)
        })
        .await
        .expect("permission");
        env.core.stop_agent(&agent.id).await.unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let errors = drain(&mut env.rx)
            .iter()
            .filter(|e| is_attention(e, AttentionReason::Error))
            .count();
        assert_eq!(errors, 0, "iteration {i}: stop reported as an error");
        assert_eq!(
            env.core.agent(&agent.id).unwrap().status,
            AgentStatus::Stopped,
            "iteration {i}"
        );
    }
    env.core.shutdown().await;
}

/// Stop while the agent is still starting cancels the run.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_during_start_cancels_the_prompt() {
    let mut env = setup("slowstart", mode("slowinit")).await;
    let agent = env
        .core
        .create_agent(request(&env, "never run me"))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    env.core.stop_agent(&agent.id).await.unwrap();
    let finished = wait_for(&mut env.rx, 6, |e| is_attention(e, AttentionReason::Done)).await;
    assert!(
        finished.is_none(),
        "the prompt ran even though the agent was stopped"
    );
    let a = env.core.agent(&agent.id).unwrap();
    assert_eq!(a.status, AgentStatus::Stopped);
    assert!(!a.running);
    assert!(env
        .core
        .items(&agent.id)
        .unwrap()
        .iter()
        .all(|i| !matches!(i.body, ItemBody::AgentMessage { .. })));
    env.core.shutdown().await;
}

/// A failed start is reported exactly once, with the agent's own error output.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn start_failure_is_reported_once() {
    let mut env = setup("die", mode("die")).await;
    let agent = env.core.create_agent(request(&env, "hello")).await.unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;
    let events = drain(&mut env.rx);
    let errors = events
        .iter()
        .filter(|e| is_attention(e, AttentionReason::Error))
        .count();
    assert_eq!(errors, 1, "one failure, one alert");
    let a = env.core.agent(&agent.id).unwrap();
    assert_eq!(a.status, AgentStatus::Error);
    assert!(!a.running);
    env.core.shutdown().await;
}

/// Codex: a failed first launch must not stop a later crash from being reported.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn codex_crash_after_failed_start_is_reported() {
    let state = temp_dir("codex-state").join("launches");
    std::env::set_var(
        "ARMADA_CODEX_COMMAND",
        format!("python3 {TESTS}/mock_codex.py {}", state.display()),
    );
    let (tx, mut rx) = mpsc::unbounded_channel();
    let core = Core::open(temp_dir("codex-data"), Arc::new(Sink(tx))).unwrap();
    let account = core
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.provider == Provider::Codex && a.is_system)
        .unwrap();
    let project = temp_dir("codex-project");
    let agent = core
        .create_agent(CreateAgentRequest {
            provider: Provider::Codex,
            account_id: account.id,
            project_path: project.to_string_lossy().into_owned(),
            prompt: "first".into(),
            title: None,
            worktree: false,
            model: None,
            group_id: None,
            custom_agent_id: None,
            permission_mode: None,
            attachments: vec![],
        })
        .await
        .unwrap();
    wait_for(&mut rx, 10, |e| is_attention(e, AttentionReason::Error))
        .await
        .expect("start failure reported");

    core.send_prompt(&agent.id, "second", vec![]).await.unwrap();
    wait_for(&mut rx, 10, |e| is_attention(e, AttentionReason::Error))
        .await
        .expect("crash reported");
    let a = core.agent(&agent.id).unwrap();
    assert_eq!(a.status, AgentStatus::Error);
    assert!(!a.running);
    core.shutdown().await;
}

/// Stop followed immediately by a new prompt: the old process's late exit and
/// queued output must not end (or leak into) the new turn. The flood mode keeps
/// the old process's queue busy so its exit is always processed late.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_then_prompt_keeps_the_new_turn_clean() {
    let mut env = setup("stop-then-prompt", mode("flood")).await;
    let agent = env
        .core
        .create_agent(request(&env, "PERM 0"))
        .await
        .unwrap();
    for i in 0..5 {
        if i > 0 {
            env.core
                .send_prompt(&agent.id, &format!("PERM {i}"), vec![])
                .await
                .unwrap();
        }
        wait_for(&mut env.rx, 30, |e| {
            is_attention(e, AttentionReason::Permission)
        })
        .await
        .expect("permission");
        env.core.stop_agent(&agent.id).await.unwrap();
        let next = format!("plain {i}");
        env.core
            .send_prompt(&agent.id, &next, vec![])
            .await
            .unwrap();
        wait_for(&mut env.rx, 30, |e| is_attention(e, AttentionReason::Done))
            .await
            .expect("new turn finished");
        let items = env.core.items(&agent.id).unwrap();
        let start = items
            .iter()
            .rposition(|i| matches!(&i.body, ItemBody::UserMessage { text, .. } if *text == next))
            .expect("new prompt recorded");
        let after: Vec<String> = items[start + 1..]
            .iter()
            .map(|i| match &i.body {
                ItemBody::Notice { text, .. } => format!("notice: {text}"),
                b => b.kind_str().to_string(),
            })
            .collect();
        assert_eq!(
            after,
            ["agent_message"],
            "iteration {i}: new turn got {after:?}"
        );
        assert_eq!(env.core.agent(&agent.id).unwrap().status, AgentStatus::Idle);
    }
    env.core.shutdown().await;
}

/// Starting an agent without a prompt: it warms up, waits idle, and is named
/// after the first message you send.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn agent_without_a_prompt_waits_for_one() {
    let mut env = setup("no-prompt", mode("normal")).await;
    let agent = env.core.create_agent(request(&env, "   ")).await.unwrap();
    let folder = env
        .project
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(agent.title, format!("New agent · {folder}"));
    assert_eq!(agent.status, AgentStatus::Starting);

    // Warms up to idle with its process running, without running any turn.
    for _ in 0..100 {
        let a = env.core.agent(&agent.id).unwrap();
        if a.status == AgentStatus::Idle && a.running {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let a = env.core.agent(&agent.id).unwrap();
    assert_eq!(a.status, AgentStatus::Idle);
    assert!(a.running);
    assert!(env.core.items(&agent.id).unwrap().is_empty());
    assert!(drain(&mut env.rx)
        .iter()
        .all(|e| !matches!(e, ArmadaEvent::Attention { .. })));

    env.core
        .send_prompt(&agent.id, "Summarize the repo layout", vec![])
        .await
        .unwrap();
    assert_eq!(
        env.core.agent(&agent.id).unwrap().title,
        "Summarize the repo layout"
    );
    let done = wait_for(&mut env.rx, 15, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("first turn");
    let ArmadaEvent::Attention { body, .. } = done else {
        unreachable!()
    };
    assert_eq!(body, "reply to Summarize the repo layout");
    env.core.shutdown().await;
}

/// Messages sent while the agent works are queued, counted, and run in order
/// right after the current turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn prompts_sent_mid_turn_are_queued_and_run_in_order() {
    let mut env = setup("queue", mode("normal")).await;
    let agent = env
        .core
        .create_agent(request(&env, "PERM first"))
        .await
        .unwrap();
    let ev = wait_for(&mut env.rx, 15, |e| {
        matches!(e, ArmadaEvent::ItemUpserted { item } if matches!(item.body, ItemBody::Permission { resolution: None, .. }))
    })
    .await
    .expect("permission");

    env.core
        .send_prompt(&agent.id, "second", vec![])
        .await
        .unwrap();
    env.core
        .send_prompt(&agent.id, "third", vec![])
        .await
        .unwrap();
    assert_eq!(env.core.agent(&agent.id).unwrap().queued_prompts, 2);

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
    let done = wait_for(&mut env.rx, 20, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("all turns finish");
    let ArmadaEvent::Attention { body, .. } = done else {
        unreachable!()
    };
    assert_eq!(
        body, "reply to third",
        "only the last turn of the run alerts"
    );

    let a = env.core.agent(&agent.id).unwrap();
    assert_eq!(a.queued_prompts, 0);
    assert_eq!(a.status, AgentStatus::Idle);
    let replies: Vec<String> = env
        .core
        .items(&agent.id)
        .unwrap()
        .into_iter()
        .filter_map(|i| match i.body {
            ItemBody::AgentMessage { text, .. } => Some(text),
            _ => None,
        })
        .collect();
    assert_eq!(
        replies,
        ["reply to PERM first", "reply to second", "reply to third"]
    );
    env.core.shutdown().await;
}

/// "Send now" while a turn runs puts the message into that turn when the agent
/// supports steering: nothing is cancelled, the message shows where it was sent,
/// and the turn's reply covers it. Asking to interrupt still stops the turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn send_now_steers_into_the_running_turn() {
    let mut env = setup("steer", mode("steer")).await;
    let agent = env
        .core
        .create_agent(request(&env, "PERM first"))
        .await
        .unwrap();
    let ev = wait_for(&mut env.rx, 15, |e| {
        matches!(e, ArmadaEvent::ItemUpserted { item } if matches!(item.body, ItemBody::Permission { resolution: None, .. }))
    })
    .await
    .expect("permission");
    assert!(env.core.agent(&agent.id).unwrap().steerable);

    env.core
        .send_prompt(&agent.id, "also this", vec![])
        .await
        .unwrap();
    let queued = env.core.agent(&agent.id).unwrap().queue[0].id.clone();
    env.core
        .send_queued_now(&agent.id, &queued, false)
        .await
        .unwrap();
    let a = env.core.agent(&agent.id).unwrap();
    assert!(
        a.queue.is_empty(),
        "it went into the turn, not back in line"
    );
    assert_ne!(a.status, AgentStatus::Idle, "the turn is still running");
    assert_eq!(user_texts(&env, &agent.id), ["PERM first", "also this"]);

    // A slash command only works at the start of a turn: it goes first in line.
    env.core
        .send_prompt(&agent.id, "later", vec![])
        .await
        .unwrap();
    env.core
        .send_prompt(&agent.id, "/compact", vec![])
        .await
        .unwrap();
    let a = env.core.agent(&agent.id).unwrap();
    let command = a.queue[1].id.clone();
    env.core
        .send_queued_now(&agent.id, &command, false)
        .await
        .unwrap();
    let a = env.core.agent(&agent.id).unwrap();
    let queued: Vec<&str> = a.queue.iter().map(|q| q.text.as_str()).collect();
    assert_eq!(queued, ["/compact", "later"]);
    assert_eq!(user_texts(&env, &agent.id), ["PERM first", "also this"]);

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
    wait_for(&mut env.rx, 20, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("the turn finishes");
    assert_eq!(
        agent_texts(&env, &agent.id),
        [
            "reply to PERM first +steered also this",
            "reply to /compact",
            "reply to later"
        ],
        "the first turn took the message in; the command ran as its own turn"
    );

    // Stop & send: the running turn is cancelled and the message runs next.
    env.core
        .send_prompt(&agent.id, "PERM again", vec![])
        .await
        .unwrap();
    wait_for(&mut env.rx, 15, |e| {
        matches!(e, ArmadaEvent::ItemUpserted { item } if matches!(item.body, ItemBody::Permission { resolution: None, .. }))
    })
    .await
    .expect("second permission");
    env.core
        .send_prompt(&agent.id, "instead", vec![])
        .await
        .unwrap();
    let queued = env.core.agent(&agent.id).unwrap().queue[0].id.clone();
    env.core
        .send_queued_now(&agent.id, &queued, true)
        .await
        .unwrap();
    wait_for(&mut env.rx, 20, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("the chosen message runs");
    let texts = agent_texts(&env, &agent.id);
    assert_eq!(
        texts.last().map(String::as_str),
        Some("reply to instead"),
        "{texts:?}"
    );
    assert!(
        !texts
            .iter()
            .any(|t| t.contains("instead") && t.contains("PERM again")),
        "interrupting doesn't steer: {texts:?}"
    );
    env.core.shutdown().await;
}

/// A question the agent asks (Claude's AskUserQuestion via a form elicitation) shows
/// as a question item with its fields; the agent waits ("needs you") until it is
/// answered, gets the answers in the form's shape, and a skip reaches it as declined.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn questions_are_shown_and_answered() {
    let mut env = setup("question", mode("normal")).await;
    let agent = env
        .core
        .create_agent(request(&env, "ASK one"))
        .await
        .unwrap();
    let question = |e: &ArmadaEvent| matches!(e, ArmadaEvent::ItemUpserted { item } if matches!(item.body, ItemBody::Question { resolution: None, .. }));
    let ev = wait_for(&mut env.rx, 15, question).await.expect("question");
    let ArmadaEvent::ItemUpserted { item } = ev else {
        unreachable!()
    };
    let ItemBody::Question {
        request_id,
        fields,
        message,
        ..
    } = item.body
    else {
        unreachable!()
    };
    assert_eq!(message, "Please answer the following questions.");
    // The alert comes once the agent is marked as waiting on you.
    wait_for(&mut env.rx, 15, |e| {
        is_attention(e, AttentionReason::Permission)
    })
    .await
    .expect("a needs-you alert");
    let ids: Vec<&str> = fields.iter().map(|f| f.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "question_0",
            "question_0_custom",
            "question_1",
            "question_1_custom"
        ]
    );
    let a = env.core.agent(&agent.id).unwrap();
    assert_eq!(a.status, AgentStatus::NeedsPermission);
    assert_eq!(a.pending_permissions, 1);

    // Wrong answers are refused and the question keeps waiting.
    let bad: serde_json::Map<String, serde_json::Value> =
        serde_json::from_value(serde_json::json!({ "question_0": "MySQL" })).unwrap();
    assert!(env
        .core
        .answer_question(&agent.id, &request_id, Some(bad))
        .await
        .is_err());

    let answers: serde_json::Map<String, serde_json::Value> = serde_json::from_value(
        serde_json::json!({ "question_0": "SQLite", "question_1": ["Auth"], "question_1_custom": "Billing" }),
    )
    .unwrap();
    env.core
        .answer_question(&agent.id, &request_id, Some(answers))
        .await
        .unwrap();
    wait_for(&mut env.rx, 20, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("the turn finishes");
    let texts = agent_texts(&env, &agent.id);
    assert_eq!(
        texts.last().map(String::as_str),
        Some(
            r#"reply to ASK one action=accept content={"question_0": "SQLite", "question_1": ["Auth"], "question_1_custom": "Billing"}"#
        ),
        "{texts:?}"
    );
    let a = env.core.agent(&agent.id).unwrap();
    assert_eq!(a.pending_permissions, 0);
    let answered = env
        .core
        .items(&agent.id)
        .unwrap()
        .into_iter()
        .find_map(|i| match i.body {
            ItemBody::Question {
                resolution,
                answers,
                ..
            } => Some((resolution, answers)),
            _ => None,
        });
    let (resolution, answers) = answered.unwrap();
    assert_eq!(resolution.as_deref(), Some("answered"));
    assert_eq!(answers.unwrap()["question_0"], "SQLite");
    assert!(
        env.core
            .answer_question(&agent.id, &request_id, None)
            .await
            .is_err(),
        "answered once"
    );

    // Skip: the agent hears the question was declined.
    env.core
        .send_prompt(&agent.id, "ASK two", vec![])
        .await
        .unwrap();
    let ev = wait_for(&mut env.rx, 15, question)
        .await
        .expect("second question");
    let ArmadaEvent::ItemUpserted { item } = ev else {
        unreachable!()
    };
    let ItemBody::Question { request_id, .. } = item.body else {
        unreachable!()
    };
    env.core
        .answer_question(&agent.id, &request_id, None)
        .await
        .unwrap();
    wait_for(&mut env.rx, 20, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("the second turn finishes");
    let texts = agent_texts(&env, &agent.id);
    assert_eq!(
        texts.last().map(String::as_str),
        Some("reply to ASK two action=decline content=null"),
        "{texts:?}"
    );

    // Stopping the turn while a question waits closes it as cancelled.
    env.core
        .send_prompt(&agent.id, "ASK three", vec![])
        .await
        .unwrap();
    wait_for(&mut env.rx, 15, question)
        .await
        .expect("third question");
    env.core.cancel_turn(&agent.id).await.unwrap();
    let cancelled = wait_for(&mut env.rx, 15, |e| {
        matches!(e, ArmadaEvent::ItemUpserted { item } if matches!(&item.body, ItemBody::Question { resolution: Some(r), .. } if r == "cancelled"))
    })
    .await;
    assert!(cancelled.is_some(), "the waiting question is closed");
    env.core.shutdown().await;
}

/// A picture in the agent's reply is kept with the conversation, in order around the
/// text; a picture that is only a link becomes a markdown link (never fetched).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pictures_in_agent_replies_are_kept() {
    let mut env = setup("pictures", mode("normal")).await;
    let agent = env.core.create_agent(request(&env, "PIC")).await.unwrap();
    wait_for(&mut env.rx, 20, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("the turn finishes");
    let replies: Vec<(String, usize)> = env
        .core
        .items(&agent.id)
        .unwrap()
        .into_iter()
        .filter_map(|i| match i.body {
            ItemBody::AgentMessage { text, images } => Some((text, images.len())),
            _ => None,
        })
        .collect();
    assert_eq!(
        replies,
        [
            ("before ".to_string(), 0),
            (String::new(), 1),
            (
                "\n\n![image](https://example.com/a.png)\n\nafter".to_string(),
                0
            )
        ],
        "{replies:?}"
    );
    env.core.shutdown().await;
}

/// A question that arrives between turns (not tied to one) is closed when the agent is
/// stopped, instead of staying "needs you" with nobody left to answer it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_question_between_turns_is_closed_when_the_agent_stops() {
    let mut env = setup("late-question", mode("normal")).await;
    let agent = env.core.create_agent(request(&env, "LATEQ")).await.unwrap();
    wait_for(&mut env.rx, 20, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("the turn finishes");
    // It may already have arrived (events before "done" aren't kept): look at the items.
    let open = |env: &Env| {
        env.core.items(&agent.id).unwrap().iter().any(|i| {
            matches!(
                i.body,
                ItemBody::Question {
                    resolution: None,
                    ..
                }
            )
        })
    };
    for _ in 0..100 {
        if open(&env) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(open(&env), "the late question");
    assert_eq!(env.core.agent(&agent.id).unwrap().pending_permissions, 1);
    env.core.stop_agent(&agent.id).await.unwrap();
    let closed = env.core.items(&agent.id).unwrap().into_iter().any(
        |i| matches!(&i.body, ItemBody::Question { resolution: Some(r), .. } if r == "cancelled"),
    );
    assert!(closed, "the question is closed");
    assert_eq!(env.core.agent(&agent.id).unwrap().pending_permissions, 0);
    env.core.shutdown().await;
}

/// A runaway agent's pictures are capped per turn, repeats are skipped, and the user is
/// told once.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pictures_per_turn_are_capped() {
    let mut env = setup("shots", mode("normal")).await;
    let agent = env.core.create_agent(request(&env, "SHOTS")).await.unwrap();
    wait_for(&mut env.rx, 20, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("the turn finishes");
    let items = env.core.items(&agent.id).unwrap();
    let pictures = items
        .iter()
        .filter(|i| matches!(&i.body, ItemBody::AgentMessage { images, .. } if !images.is_empty()))
        .count();
    assert_eq!(pictures, 24, "30 distinct pictures, capped");
    let told = items
        .iter()
        .filter(|i| matches!(&i.body, ItemBody::Notice { text, .. } if text.contains("more than 24 pictures")))
        .count();
    assert_eq!(told, 1, "told once");
    env.core.shutdown().await;
}

/// A question the agent withdraws ($/cancel_request) is closed instead of waiting for
/// an answer nobody is listening for.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_withdrawn_question_is_closed() {
    let mut env = setup("withdraw", mode("normal")).await;
    let agent = env
        .core
        .create_agent(request(&env, "WITHDRAW"))
        .await
        .unwrap();
    // The agent withdraws the question 0.3 s in and keeps working for another 0.3 s:
    // the question must close then, not only when the turn ends.
    let mut closed_while_working = false;
    for _ in 0..150 {
        let items = env.core.items(&agent.id).unwrap();
        let closed = items.iter().any(|i| {
            matches!(&i.body, ItemBody::Question { resolution: Some(r), .. } if r == "cancelled")
        });
        if closed {
            let moved_on = items.iter().any(|i| {
                matches!(&i.body, ItemBody::AgentMessage { text, .. } if text.contains("moved on"))
            });
            closed_while_working = !moved_on;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        closed_while_working,
        "closed when withdrawn, before the turn went on"
    );
    wait_for(&mut env.rx, 20, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("the turn finishes");
    assert_eq!(env.core.agent(&agent.id).unwrap().pending_permissions, 0);
    env.core.shutdown().await;
}

fn user_texts(env: &Env, agent_id: &str) -> Vec<String> {
    env.core
        .items(agent_id)
        .unwrap()
        .into_iter()
        .filter_map(|i| match i.body {
            ItemBody::UserMessage { text, .. } => Some(text),
            _ => None,
        })
        .collect()
}

/// Queued messages stay out of the timeline until they run; Stop pauses the queue
/// instead of dropping it; "send now" runs one and the rest follow in order.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn queue_is_editable_and_pauses_on_stop() {
    let mut env = setup("queue-pause", mode("normal")).await;
    let agent = env
        .core
        .create_agent(request(&env, "PERM first"))
        .await
        .unwrap();
    wait_for(&mut env.rx, 15, |e| {
        is_attention(e, AttentionReason::Permission)
    })
    .await
    .expect("permission");
    env.core
        .send_prompt(&agent.id, "second", vec![])
        .await
        .unwrap();
    env.core
        .send_prompt(&agent.id, "third", vec![])
        .await
        .unwrap();
    env.core
        .send_prompt(&agent.id, "fourth", vec![])
        .await
        .unwrap();
    assert_eq!(
        user_texts(&env, &agent.id),
        ["PERM first"],
        "queued messages aren't in the timeline yet"
    );
    let a = env.core.agent(&agent.id).unwrap();
    let texts: Vec<&str> = a.queue.iter().map(|q| q.text.as_str()).collect();
    assert_eq!(texts, ["second", "third", "fourth"]);

    // Remove one (e.g. to edit it): its text comes back.
    let fourth = a.queue[2].id.clone();
    assert_eq!(
        env.core
            .remove_queued(&agent.id, &fourth)
            .unwrap()
            .map(|p| p.text)
            .as_deref(),
        Some("fourth")
    );

    // Stop pauses the queue rather than throwing it away.
    env.core.stop_agent(&agent.id).await.unwrap();
    let a = env.core.agent(&agent.id).unwrap();
    assert_eq!(a.status, AgentStatus::Stopped);
    assert_eq!(a.queue.len(), 2);
    assert!(a.queue_paused);

    // Sending one now runs it, then the rest of the queue follows.
    let third = a.queue[1].id.clone();
    env.core
        .send_queued_now(&agent.id, &third, false)
        .await
        .unwrap();
    // One "done" alert when the whole run (third, then second) finishes.
    wait_for(&mut env.rx, 20, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("queued turns run");
    assert_eq!(
        user_texts(&env, &agent.id),
        ["PERM first", "third", "second"]
    );
    let a = env.core.agent(&agent.id).unwrap();
    assert!(a.queue.is_empty() && !a.queue_paused);
    env.core.shutdown().await;
}

/// Cancelling an agent that is still warming up returns it to idle.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_during_warm_up_settles() {
    let mut env = setup("warm-cancel", mode("slowinit")).await;
    let agent = env.core.create_agent(request(&env, "")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    env.core.cancel_turn(&agent.id).await.unwrap();
    assert_eq!(env.core.agent(&agent.id).unwrap().status, AgentStatus::Idle);
    tokio::time::sleep(Duration::from_secs(4)).await;
    let a = env.core.agent(&agent.id).unwrap();
    assert_eq!(a.status, AgentStatus::Idle);
    assert!(!a.running, "the abandoned start shut itself down");
    let _ = drain(&mut env.rx);
    env.core.shutdown().await;
}

/// Stop during warm-up doesn't leave a sticky cancel behind: Resume works after.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resume_after_stopping_a_warm_up() {
    let mut env = setup("warm-stop", mode("slowinit")).await;
    let agent = env.core.create_agent(request(&env, "")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    env.core.stop_agent(&agent.id).await.unwrap();
    tokio::time::sleep(Duration::from_secs(4)).await;
    env.core.resume_agent(&agent.id, false).await.unwrap();
    let a = env.core.agent(&agent.id).unwrap();
    assert_eq!(a.status, AgentStatus::Idle);
    assert!(a.running);
    let _ = drain(&mut env.rx);
    env.core.shutdown().await;
}

/// A message sent while Stop is still shutting the old process down must run on a
/// fresh process — never get stuck queued forever.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn prompt_sent_during_stop_is_not_wedged() {
    let marker = format!("armada-stop-race-{}", std::process::id());
    // The wrapper keeps the agent as a child, so Stop takes a moment.
    let args = vec![
        format!("{TESTS}/mock_wrapper.py"),
        format!("{TESTS}/mock_modes.py"),
        "normal".into(),
        marker,
    ];
    let mut env = setup("stop-race", args).await;
    let agent = env
        .core
        .create_agent(request(&env, "PERM go"))
        .await
        .unwrap();
    wait_for(&mut env.rx, 15, |e| {
        is_attention(e, AttentionReason::Permission)
    })
    .await
    .expect("permission");
    let core = env.core.clone();
    let id = agent.id.clone();
    let stop = tokio::spawn(async move { core.stop_agent(&id).await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    env.core
        .send_prompt(&agent.id, "after stop", vec![])
        .await
        .unwrap();
    stop.await.unwrap().unwrap();
    let done = wait_for(&mut env.rx, 20, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("the message sent during Stop still runs");
    let ArmadaEvent::Attention { body, .. } = done else {
        unreachable!()
    };
    assert_eq!(body, "reply to after stop");
    // And the agent keeps working afterwards.
    env.core
        .send_prompt(&agent.id, "and again", vec![])
        .await
        .unwrap();
    wait_for(&mut env.rx, 20, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("not wedged");
    env.core.shutdown().await;
}

fn agent_texts(env: &Env, agent_id: &str) -> Vec<String> {
    env.core
        .items(agent_id)
        .unwrap()
        .into_iter()
        .filter_map(|i| match i.body {
            ItemBody::AgentMessage { text, .. } => Some(text),
            _ => None,
        })
        .collect()
}

fn notices(core: &Core, agent_id: &str) -> Vec<String> {
    core.items(agent_id)
        .unwrap()
        .into_iter()
        .filter_map(|i| match i.body {
            ItemBody::Notice { text, .. } => Some(text),
            _ => None,
        })
        .collect()
}

async fn wait_status(core: &Core, agent_id: &str, want: AgentStatus, secs: u64) -> AgentStatus {
    for _ in 0..secs * 20 {
        let s = core.agent(agent_id).unwrap().status;
        if s == want {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    core.agent(agent_id).unwrap().status
}

async fn wait_gone(marker: &str, secs: u64) -> usize {
    for _ in 0..secs * 10 {
        if processes_with(marker) == 0 {
            return 0;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    processes_with(marker)
}

/// One turn ran, for prompt B. The fresh session is briefed with the earlier
/// (never sent) message A as history (M5), but A never ran as a prompt of its own.
fn assert_only_b_ran(replies: &[String]) {
    assert_eq!(replies.len(), 1, "A was sent too: {replies:?}");
    let reply = &replies[0];
    assert!(reply.ends_with("---\n\nB"), "{reply:?}");
    assert!(reply.contains("USER: A"), "{reply:?}");
    assert!(
        !reply.contains("USER: B"),
        "B repeated in the briefing: {reply:?}"
    );
}

/// H1: Stop while a prompt waits for its process, then a new prompt: only the
/// new one runs (the stopped one must never reach the agent).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_then_new_prompt_during_start_runs_only_the_new_one() {
    let mut env = setup("h1", mode("slowinit")).await;
    let agent = env.core.create_agent(request(&env, "A")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    env.core.stop_agent(&agent.id).await.unwrap();
    env.core.send_prompt(&agent.id, "B", vec![]).await.unwrap();
    wait_for(&mut env.rx, 20, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("B runs");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_only_b_ran(&agent_texts(&env, &agent.id));
    assert_eq!(env.core.agent(&agent.id).unwrap().status, AgentStatus::Idle);
    env.core.shutdown().await;
}

/// M1: "send now" while the agent is still starting cancels the waiting prompt
/// and runs the chosen one (instead of leaving the agent stuck "working").
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn send_now_during_start_runs_the_chosen_message() {
    let mut env = setup("m1", mode("slowinit")).await;
    let agent = env.core.create_agent(request(&env, "A")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    env.core.send_prompt(&agent.id, "B", vec![]).await.unwrap();
    let queued = env.core.agent(&agent.id).unwrap().queue[0].id.clone();
    env.core
        .send_queued_now(&agent.id, &queued, false)
        .await
        .unwrap();
    wait_for(&mut env.rx, 20, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("B runs");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_only_b_ran(&agent_texts(&env, &agent.id));
    let a = env.core.agent(&agent.id).unwrap();
    assert_eq!(a.status, AgentStatus::Idle);
    assert!(a.queue.is_empty());
    env.core.shutdown().await;
}

/// M3: Stop (and quit) during a handshake that never answers kills the agent's
/// whole process tree at once, without reporting an error.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_and_quit_kill_a_hung_handshake() {
    let marker = format!("armada-hung-start-{}", std::process::id());
    let args = vec![
        format!("{TESTS}/mock_wrapper.py"),
        format!("{TESTS}/mock_modes.py"),
        "hanginit".into(),
        marker.clone(),
    ];
    let mut env = setup("hung-start", args).await;
    let agent = env.core.create_agent(request(&env, "hi")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(processes_with(&marker) >= 2, "launcher + agent running");
    let started = std::time::Instant::now();
    env.core.stop_agent(&agent.id).await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(
        wait_gone(&marker, 3).await,
        0,
        "the hung agent outlived Stop"
    );
    let a = env.core.agent(&agent.id).unwrap();
    assert_eq!(a.status, AgentStatus::Stopped);
    assert!(!a.running);

    // Quitting during a hung warm-up.
    let other = env.core.create_agent(request(&env, "")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(processes_with(&marker) >= 2);
    env.core.shutdown().await;
    assert_eq!(
        wait_gone(&marker, 3).await,
        0,
        "the hung agent outlived quit"
    );
    assert!(!env.core.agent(&other.id).unwrap().running);
    assert!(env
        .core
        .send_prompt(&agent.id, "after quit", vec![])
        .await
        .is_err_and(|e| e.to_string().contains("shutting down")));
    let errors = drain(&mut env.rx)
        .iter()
        .filter(|e| is_attention(e, AttentionReason::Error))
        .count();
    assert_eq!(errors, 0);
}

/// M4: queued messages survive a restart, come back paused with a notice, and
/// run when the queue is resumed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn queue_survives_a_restart() {
    let mut env = setup("queue-restart", mode("normal")).await;
    let data = env.core.data_dir().to_path_buf();
    let agent = env
        .core
        .create_agent(request(&env, "PERM first"))
        .await
        .unwrap();
    wait_for(&mut env.rx, 15, |e| {
        is_attention(e, AttentionReason::Permission)
    })
    .await
    .expect("permission");
    let png = Attachment {
        name: "shot.png".into(),
        mime_type: "image/png".into(),
        data: "iVBORw0KGgo=".into(),
    };
    env.core
        .send_prompt(&agent.id, "second", vec![png])
        .await
        .unwrap();
    env.core
        .send_prompt(&agent.id, "third", vec![])
        .await
        .unwrap();
    env.core.shutdown().await;
    drop(env.core);

    let (tx, mut rx) = mpsc::unbounded_channel();
    let core = Core::open(data, Arc::new(Sink(tx))).unwrap();
    let a = core.agent(&agent.id).unwrap();
    assert_eq!(a.status, AgentStatus::Interrupted);
    let texts: Vec<&str> = a.queue.iter().map(|q| q.text.as_str()).collect();
    assert_eq!(texts, ["second", "third"]);
    assert_eq!(a.queue[0].attachments, 1);
    assert!(a.queue_paused, "a restored queue waits for the user");
    assert!(notices(&core, &agent.id)
        .iter()
        .any(|n| n.contains("kept from before Armada closed")));

    core.resume_queue(&agent.id).await.unwrap();
    let done = wait_for(&mut rx, 20, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("queue runs");
    let ArmadaEvent::Attention { body, .. } = done else {
        unreachable!()
    };
    assert_eq!(body, "reply to third");
    let items = core.items(&agent.id).unwrap();
    assert!(
        items.iter().any(|i| matches!(&i.body,
        ItemBody::UserMessage { text, attachments } if text == "second" && attachments.len() == 1))
    );
    let a = core.agent(&agent.id).unwrap();
    assert!(a.queue.is_empty() && !a.queue_paused);

    // Clearing the queue.
    core.send_prompt(&agent.id, "PERM again", vec![])
        .await
        .unwrap();
    wait_for(&mut rx, 15, |e| {
        is_attention(e, AttentionReason::Permission)
    })
    .await
    .expect("permission");
    core.send_prompt(&agent.id, "dropped", vec![])
        .await
        .unwrap();
    assert_eq!(core.clear_queue(&agent.id).unwrap(), 1);
    assert!(core.agent(&agent.id).unwrap().queue.is_empty());
    core.shutdown().await;
}

/// M5 + L8: a fresh session after a start that never got one is briefed with
/// the earlier conversation, without repeating the prompt being sent.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fresh_session_after_a_failed_start_is_briefed_once() {
    let mut env = setup("briefing", mode("die")).await;
    let agent = env
        .core
        .create_agent(request(&env, "remember the word pineapple"))
        .await
        .unwrap();
    wait_for(&mut env.rx, 30, |e| is_attention(e, AttentionReason::Error))
        .await
        .expect("start fails");
    assert!(env.core.agent(&agent.id).unwrap().session_id.is_none());
    let mut settings = env.core.settings().unwrap();
    settings.custom_agents[0].args = mode("normal");
    env.core.save_settings(settings).unwrap();

    env.core
        .send_prompt(&agent.id, "what was the word", vec![])
        .await
        .unwrap();
    let done = wait_for(&mut env.rx, 30, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("turn runs");
    drop(done);
    let reply = agent_texts(&env, &agent.id).pop().unwrap();
    assert!(
        reply.contains("USER: remember the word pineapple"),
        "{reply}"
    );
    assert_eq!(
        reply.matches("what was the word").count(),
        1,
        "the prompt was sent twice: {reply}"
    );
    // Only the first prompt of the new session carries the briefing.
    env.core
        .send_prompt(&agent.id, "and now", vec![])
        .await
        .unwrap();
    wait_for(&mut env.rx, 30, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("turn runs");
    assert_eq!(
        agent_texts(&env, &agent.id).pop().unwrap(),
        "reply to and now"
    );
    env.core.shutdown().await;
}

/// L21: an agent that answers a cancelled prompt with an RPC error ends the turn
/// as cancelled, not failed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_answered_with_an_error_is_a_cancel() {
    let mut env = setup("cancel-err", mode("normal")).await;
    let agent = env
        .core
        .create_agent(request(&env, "CANCELERR"))
        .await
        .unwrap();
    assert_eq!(
        wait_status(&env.core, &agent.id, AgentStatus::Working, 10).await,
        AgentStatus::Working
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    env.core.cancel_turn(&agent.id).await.unwrap();
    assert_eq!(
        wait_status(&env.core, &agent.id, AgentStatus::Idle, 5).await,
        AgentStatus::Idle
    );
    let errors = drain(&mut env.rx)
        .iter()
        .filter(|e| is_attention(e, AttentionReason::Error))
        .count();
    assert_eq!(errors, 0);
    assert!(notices(&env.core, &agent.id)
        .iter()
        .any(|n| n == "Turn cancelled"));
    env.core.shutdown().await;
}

/// Watchdog: an agent that ignores Cancel is restarted and the turn ends as
/// cancelled; the next message works on a fresh process.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_watchdog_restarts_a_hung_turn() {
    let mut env = setup("watchdog", mode("normal")).await;
    env.core.set_cancel_timeout(Duration::from_millis(800));
    let agent = env.core.create_agent(request(&env, "HANG")).await.unwrap();
    assert_eq!(
        wait_status(&env.core, &agent.id, AgentStatus::Working, 10).await,
        AgentStatus::Working
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    env.core.cancel_turn(&agent.id).await.unwrap();
    assert_eq!(
        wait_status(&env.core, &agent.id, AgentStatus::Idle, 6).await,
        AgentStatus::Idle
    );
    let n = notices(&env.core, &agent.id);
    assert!(n.iter().any(|t| t.contains("didn't stop")), "{n:?}");
    assert!(n.iter().any(|t| t == "Turn cancelled"), "{n:?}");
    env.core
        .send_prompt(&agent.id, "hello", vec![])
        .await
        .unwrap();
    let done = wait_for(&mut env.rx, 15, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("works again");
    let ArmadaEvent::Attention { body, .. } = done else {
        unreachable!()
    };
    assert_eq!(body, "reply to hello");
    env.core.shutdown().await;
}

/// L20 + L9 + L15: a permission request without choices is declined (not stuck),
/// an idle agent that exits says so, and cost adds up across processes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_choice_permission_idle_exit_and_cost_across_processes() {
    let mut env = setup("misc", mode("normal")).await;
    let agent = env
        .core
        .create_agent(request(&env, "NOOPTS COST EXITLATER"))
        .await
        .unwrap();
    let done = wait_for(&mut env.rx, 15, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("turn ends");
    let ArmadaEvent::Attention { body, .. } = done else {
        unreachable!()
    };
    assert!(body.ends_with("outcome=cancelled"), "{body}");
    let a = env.core.agent(&agent.id).unwrap();
    assert_eq!(a.pending_permissions, 0);
    assert!((a.cost_usd - 0.5).abs() < 1e-9);
    // The process exits on its own while idle.
    for _ in 0..40 {
        if !env.core.agent(&agent.id).unwrap().running {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let n = notices(&env.core, &agent.id);
    assert!(
        n.iter().any(|t| t.contains("without offering any choices")),
        "{n:?}"
    );
    assert!(
        n.iter()
            .any(|t| t.contains("will restart with your next message")),
        "{n:?}"
    );
    assert_eq!(env.core.agent(&agent.id).unwrap().status, AgentStatus::Idle);

    env.core
        .send_prompt(&agent.id, "COST", vec![])
        .await
        .unwrap();
    wait_for(&mut env.rx, 15, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("second turn");
    let a = env.core.agent(&agent.id).unwrap();
    assert!((a.cost_usd - 1.0).abs() < 1e-9, "cost {}", a.cost_usd);
    env.core.shutdown().await;
}

/// L4: Resume on an agent that is running a turn changes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resume_of_a_running_agent_is_a_no_op() {
    let mut env = setup("resume-live", mode("normal")).await;
    let agent = env
        .core
        .create_agent(request(&env, "PERM x"))
        .await
        .unwrap();
    wait_for(&mut env.rx, 15, |e| {
        is_attention(e, AttentionReason::Permission)
    })
    .await
    .expect("permission");
    env.core.resume_agent(&agent.id, false).await.unwrap();
    let statuses: Vec<AgentStatus> = drain(&mut env.rx)
        .into_iter()
        .filter_map(|e| match e {
            ArmadaEvent::AgentUpdated { agent: a } if a.id == agent.id => Some(a.status),
            _ => None,
        })
        .collect();
    assert!(
        statuses.iter().all(|s| *s == AgentStatus::NeedsPermission),
        "{statuses:?}"
    );
    assert_eq!(
        env.core.agent(&agent.id).unwrap().status,
        AgentStatus::NeedsPermission
    );
    env.core.shutdown().await;
}

/// L17: replaying history skips timeline updates only; commands still apply.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn replay_keeps_non_timeline_updates() {
    let mut env = setup("replay-cmds", mode("replay")).await;
    let agent = env.core.create_agent(request(&env, "first")).await.unwrap();
    wait_for(&mut env.rx, 15, |e| is_attention(e, AttentionReason::Done))
        .await
        .expect("first turn");
    env.core.stop_agent(&agent.id).await.unwrap();
    env.core.resume_agent(&agent.id, false).await.unwrap();
    let a = env.core.agent(&agent.id).unwrap();
    assert!(
        a.available_commands.iter().any(|c| c.name == "replayed"),
        "{:?}",
        a.available_commands
    );
    assert_eq!(
        env.core.items(&agent.id).unwrap().len(),
        2 + notices(&env.core, &agent.id).len()
    );
    env.core.shutdown().await;
}

/// L12: agent process groups left by a crashed run are killed at startup, but
/// only when the recorded process is provably still the same one.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn orphans_of_a_crashed_run_are_reaped() {
    use std::os::unix::process::CommandExt;
    let python = which_python();
    let spawn = |tag: &str| {
        std::process::Command::new(&python)
            .args(["-c", "import time; time.sleep(60)", tag])
            .process_group(0)
            .spawn()
            .unwrap()
    };
    let start_time = |pid: u32| -> u64 {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
        let rest = &stat[stat.rfind(')').unwrap() + 1..];
        rest.split_whitespace().nth(19).unwrap().parse().unwrap()
    };
    let mut ours = spawn("armada-orphan-ours");
    let mut other = spawn("armada-orphan-other");
    tokio::time::sleep(Duration::from_millis(200)).await;
    let data = temp_dir("orphans-data");
    let records = serde_json::json!([
        { "pid": ours.id(), "program": python, "start_time": start_time(ours.id()) },
        // Same program, but not the process that was recorded (pid reused).
        { "pid": other.id(), "program": python, "start_time": start_time(other.id()) + 1 },
    ]);
    std::fs::write(data.join("children.json"), records.to_string()).unwrap();
    let (tx, _rx) = mpsc::unbounded_channel();
    let core = Core::open(data.clone(), Arc::new(Sink(tx))).unwrap();
    let mut reaped = false;
    for _ in 0..30 {
        if ours.try_wait().unwrap().is_some() {
            reaped = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(reaped, "the orphan survived");
    assert!(
        other.try_wait().unwrap().is_none(),
        "an unrelated process was killed"
    );
    let _ = other.kill();
    let _ = other.wait();
    core.shutdown().await;
}

#[cfg(target_os = "linux")]
fn which_python() -> String {
    let out = std::process::Command::new("sh")
        .args(["-c", "command -v python3"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}
