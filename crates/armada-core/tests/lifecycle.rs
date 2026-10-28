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
        "replayed history leaked into the timeline"
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
