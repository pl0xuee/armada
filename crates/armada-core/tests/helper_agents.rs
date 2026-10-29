//! Helper agents end to end against the mock ACP agent: spawning from a snapshot,
//! merging both ways, deferring while the main agent is busy.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use armada_core::*;
use tokio::sync::mpsc;

struct Sink(mpsc::UnboundedSender<ArmadaEvent>);

impl EventSink for Sink {
    fn emit(&self, event: ArmadaEvent) {
        let _ = self.0.send(event);
    }
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("armada-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn repo(name: &str) -> PathBuf {
    let dir = temp_dir(name);
    git(&dir, &["init", "-q"]);
    for (k, v) in [
        ("user.name", "T"),
        ("user.email", "t@t.invalid"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(&dir, &["config", k, v]);
    }
    std::fs::write(dir.join("a.txt"), "1\n2\n3\n").unwrap();
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "init"]);
    dir
}

async fn core_with_mock(name: &str) -> (Core, String) {
    let mock = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mock_acp.py").to_string();
    let (tx, rx) = mpsc::unbounded_channel();
    // Events are not inspected here; keep the receiver alive so sends succeed.
    std::mem::forget(rx);
    let core = Core::open(temp_dir(&format!("{name}-data")), Arc::new(Sink(tx))).unwrap();
    let mut settings = core.settings().unwrap();
    settings.custom_agents = vec![CustomAgent {
        id: "mock".into(),
        name: "Mock".into(),
        command: "python3".into(),
        args: vec![mock],
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
    (core, account)
}

async fn main_agent(core: &Core, account: &str, project: &Path, prompt: &str) -> Agent {
    core.create_agent(CreateAgentRequest {
        provider: Provider::Custom,
        account_id: account.to_string(),
        project_path: project.to_string_lossy().into_owned(),
        prompt: prompt.into(),
        title: Some("Main".into()),
        worktree: false,
        model: None,
        group_id: None,
        custom_agent_id: Some("mock".into()),
        permission_mode: None,
        attachments: vec![],
    })
    .await
    .unwrap()
}

async fn until(what: &str, mut f: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(30), async {
        while !f() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

async fn idle(core: &Core, id: &str) {
    until("idle", || {
        core.agent(id).is_ok_and(|a| a.status == AgentStatus::Idle)
    })
    .await;
}

#[tokio::test]
async fn spawn_rejects_unknown_parents_and_non_git_projects() {
    let (core, account) = core_with_mock("helper-reject").await;
    let err = core
        .spawn_helper("nope", "do it", vec![])
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("Agent not found"), "{err:#}");
    assert!(core.sync_helper("nope").await.is_err());
    assert!(core.ask_main_to_merge("nope").await.is_err());

    let plain = temp_dir("helper-plain");
    let main = main_agent(&core, &account, &plain, "").await;
    idle(&core, &main.id).await;
    let err = core
        .spawn_helper(&main.id, "do it", vec![])
        .await
        .unwrap_err();
    assert_eq!(format!("{err:#}"), "Helpers need a git project");
    // A normal agent isn't a helper.
    assert!(core.sync_helper(&main.id).await.is_err());
    assert_eq!(core.agents().unwrap().len(), 1);
}

#[tokio::test]
async fn helpers_start_from_a_snapshot_and_sync_both_ways() {
    let (core, account) = core_with_mock("helper-flow").await;
    let project = repo("helper-flow-project");
    let main = main_agent(&core, &account, &project, "").await;
    idle(&core, &main.id).await;
    // Uncommitted and untracked work of the main agent.
    std::fs::write(project.join("a.txt"), "1\n2\n3\nmain wip\n").unwrap();
    std::fs::write(project.join("new.txt"), "untracked\n").unwrap();

    // Without a prompt text the helper would have nothing to do.
    assert!(core.spawn_helper(&main.id, "  ", vec![]).await.is_err());
    let helper = core
        .spawn_helper(&main.id, "hello there", vec![])
        .await
        .unwrap();
    assert_eq!(helper.parent_id.as_deref(), Some(main.id.as_str()));
    let sync = helper.helper_sync.clone().unwrap();
    assert_eq!(sync.state, HelperSyncState::InSync);
    assert!(helper.worktree && helper.cwd != main.cwd);
    assert!(helper
        .branch
        .as_deref()
        .unwrap()
        .starts_with("armada/helper-"));
    assert_eq!(helper.title, "hello there");
    let hdir = PathBuf::from(&helper.cwd);
    assert_eq!(
        std::fs::read_to_string(hdir.join("a.txt")).unwrap(),
        "1\n2\n3\nmain wip\n"
    );
    assert_eq!(
        std::fs::read_to_string(hdir.join("new.txt")).unwrap(),
        "untracked\n"
    );
    // The main agent's own state is untouched.
    assert!(core.agent(&main.id).unwrap().parent_id.is_none());

    // The helper's first turn waits on a permission request; end it.
    until("helper turn", || {
        core.agent(&helper.id).unwrap().status == AgentStatus::NeedsPermission
    })
    .await;
    core.cancel_turn(&helper.id).await.unwrap();
    idle(&core, &helper.id).await;

    // helper -> main: a clean merge once the helper has changes and main is idle.
    std::fs::write(hdir.join("helper.txt"), "from helper\r\n").unwrap();
    let h = core.sync_helper(&helper.id).await.unwrap();
    let hs = h.helper_sync.unwrap();
    assert_eq!(hs.state, HelperSyncState::InSync);
    assert_eq!(hs.files, 1);
    assert!(hs.last_sync_at.is_some());
    assert_eq!(
        std::fs::read_to_string(project.join("helper.txt")).unwrap(),
        "from helper\r\n"
    );

    // A busy main agent defers the merge.
    core.send_prompt(&main.id, "hello", vec![]).await.unwrap();
    until("main busy", || {
        core.agent(&main.id).unwrap().status == AgentStatus::NeedsPermission
    })
    .await;
    std::fs::write(hdir.join("later.txt"), "later\n").unwrap();
    let h = core.sync_helper(&helper.id).await.unwrap();
    assert_eq!(h.helper_sync.unwrap().state, HelperSyncState::PendingToMain);
    assert!(!project.join("later.txt").exists());
    // The main agent's turn ends: the pending merge runs by itself.
    core.cancel_turn(&main.id).await.unwrap();
    until("deferred merge", || project.join("later.txt").exists()).await;
    until("in sync", || {
        core.agent(&helper.id).unwrap().helper_sync.unwrap().state == HelperSyncState::InSync
    })
    .await;

    // main -> helper: picked up before the helper's next prompt.
    idle(&core, &main.id).await;
    std::fs::write(project.join("from_main.txt"), "main says hi\n").unwrap();
    core.send_prompt(&helper.id, "hello again", vec![])
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(hdir.join("from_main.txt")).unwrap(),
        "main says hi\n"
    );
    core.cancel_turn(&helper.id).await.unwrap();

    // Deleting the main agent keeps the helper, on its own.
    core.delete_agent(&main.id, false, true).await.unwrap();
    let h = core.agent(&helper.id).unwrap();
    assert!(h.parent_id.is_none() && h.helper_sync.is_none());
}
