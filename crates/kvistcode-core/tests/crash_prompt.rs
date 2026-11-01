//! A message typed right after the agent process dies must never vanish: it runs on the
//! restarted process or stays visible in the queue, and the agent is never left in the
//! Error state with `running` still true. `ITERS` (default 20) repeats each scenario.

#![cfg(unix)]

use std::sync::Arc;
use std::time::Duration;

use kvistcode_core::*;
use tokio::sync::mpsc;

const TESTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests");

struct Sink(mpsc::UnboundedSender<KvistcodeEvent>);

impl EventSink for Sink {
    fn emit(&self, event: KvistcodeEvent) {
        let _ = self.0.send(event);
    }
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("kvistcode-crashp-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn iters() -> usize {
    std::env::var("ITERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20)
}

fn is_attention(e: &KvistcodeEvent, r: AttentionReason) -> bool {
    matches!(e, KvistcodeEvent::Attention { reason, .. } if *reason == r)
}

async fn wait_for(rx: &mut mpsc::UnboundedReceiver<KvistcodeEvent>, reason: AttentionReason) {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let ev = rx.recv().await.expect("events");
            if is_attention(&ev, reason) {
                return;
            }
        }
    })
    .await
    .expect("expected event");
}

/// One scenario: `kill` SIGKILLs the idle process after the first turn; otherwise the
/// first turn crashes the process itself. Then "SECOND" is sent after `jitter_us`.
async fn scenario(kill: bool, jitter_us: u64) -> std::result::Result<(), String> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let tag = format!("{kill}-{jitter_us}");
    let core = Core::open(temp_dir(&format!("data-{tag}")), Arc::new(Sink(tx))).unwrap();
    let mut settings = core.settings().unwrap();
    settings.custom_agents = vec![CustomAgent {
        id: "mock".into(),
        name: "Mock".into(),
        command: "python3".into(),
        args: vec![format!("{TESTS}/mock_killable.py")],
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
    let project = temp_dir(&format!("project-{tag}"));
    let agent = core
        .create_agent(CreateAgentRequest {
            provider: Provider::Custom,
            account_id: account,
            project_path: project.to_string_lossy().into_owned(),
            prompt: if kill { "first" } else { "CRASH first" }.into(),
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
    wait_for(
        &mut rx,
        if kill {
            AttentionReason::Done
        } else {
            AttentionReason::Error
        },
    )
    .await;
    let mut killed = 0;
    if kill {
        let pid: i32 = std::fs::read_to_string(project.join("agent.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        killed = pid;
        // SAFETY: plain kill(2) on the mock agent this test started.
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }
    if jitter_us > 0 {
        tokio::time::sleep(Duration::from_micros(jitter_us)).await;
    }
    core.send_prompt(&agent.id, "SECOND", vec![]).await.unwrap();

    let mut ok = false;
    for _ in 0..600 {
        let a = core.agent(&agent.id).unwrap();
        let ran = core.items(&agent.id).unwrap().iter().any(|i| {
            matches!(&i.body, ItemBody::AgentMessage { text, .. } if text.contains("reply to SECOND"))
        });
        if ran || a.queue.iter().any(|q| q.text == "SECOND") {
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    // Let everything settle, then the state must be self-consistent.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let a = core.agent(&agent.id).unwrap();
    let bad_state = a.status == AgentStatus::Error && a.running;
    if !ok || bad_state {
        let items: Vec<String> = core
            .items(&agent.id)
            .unwrap()
            .into_iter()
            .map(|i| format!("{:?}", i.body))
            .collect();
        let now: i32 = std::fs::read_to_string(project.join("agent.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let msg = format!(
            "killed pid {killed}, pid file now {now}\n{}: status {:?} running {} queue {:?}\n{}",
            if bad_state {
                "Error with running=true"
            } else {
                "message neither ran nor stayed queued"
            },
            a.status,
            a.running,
            a.queue,
            items.join("\n")
        );
        core.shutdown().await;
        return Err(msg);
    }
    core.shutdown().await;
    Ok(())
}

async fn run(kill: bool) {
    let mut failures = Vec::new();
    for i in 0..iters() {
        if let Err(e) = scenario(kill, (i as u64 % 10) * 300).await {
            failures.push(format!("iteration {i}: {e}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} failed:\n{}",
        failures.len(),
        failures.join("\n---\n")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn prompt_right_after_a_kill_is_not_lost() {
    run(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn prompt_right_after_a_crashed_turn_is_not_lost() {
    run(false).await;
}
