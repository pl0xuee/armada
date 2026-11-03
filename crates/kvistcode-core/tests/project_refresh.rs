//! "Refresh projects": a project whose folder moved is found again from its worktrees,
//! or re-pointed by hand when nothing can tell where it went.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Command;
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

fn temp_dir(name: &str) -> PathBuf {
    common::scratch(&format!("test-{name}"))
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

async fn until(what: &str, mut f: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(30), async {
        while !f() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

async fn worktree_agent(core: &Core, account: &str, project: &Path) -> Agent {
    let a = core
        .create_agent(CreateAgentRequest {
            provider: Provider::Custom,
            account_id: account.to_string(),
            project_path: project.to_string_lossy().into_owned(),
            prompt: "hi".into(),
            title: Some("Main".into()),
            worktree: true,
            model: None,
            group_id: None,
            custom_agent_id: Some("mock".into()),
            permission_mode: None,
            attachments: vec![],
        })
        .await
        .unwrap();
    // The mock stops to ask permission; the worktree exists by then, which is all that is needed.
    until("worktree ready", || {
        core.agent(&a.id)
            .is_ok_and(|x| x.status != AgentStatus::Starting)
    })
    .await;
    core.stop_agent(&a.id).await.unwrap();
    core.agent(&a.id).unwrap()
}

#[tokio::test]
async fn refresh_finds_a_moved_project_from_its_repaired_worktree() {
    let (core, account) = core_with_mock("refresh-auto").await;
    let old = repo("refresh-auto-repo");
    let agent = worktree_agent(&core, &account, &old).await;
    let new = old.with_file_name(format!(
        "{}-renamed",
        old.file_name().unwrap().to_string_lossy()
    ));
    std::fs::rename(&old, &new).unwrap();
    // Nothing is wrong until the folder is missing; the worktree is repaired the way git
    // does it (what a user who ran `git worktree repair` has).
    git(&new, &["worktree", "repair", &agent.cwd]);

    let r = core.refresh_projects().await.unwrap();
    assert!(r.missing.is_empty(), "{:?}", r.missing);
    assert_eq!(r.moved.len(), 1);
    assert_eq!(
        Path::new(&r.moved[0].to).canonicalize().unwrap(),
        new.canonicalize().unwrap()
    );
    assert_eq!(
        Path::new(&core.agent(&agent.id).unwrap().project_path)
            .canonicalize()
            .unwrap(),
        new.canonicalize().unwrap()
    );
    // A second refresh has nothing to do.
    let again = core.refresh_projects().await.unwrap();
    assert!(again.moved.is_empty() && again.missing.is_empty());
}

#[tokio::test]
async fn refresh_reports_a_project_it_cannot_find_and_relocate_fixes_it() {
    let (core, account) = core_with_mock("refresh-manual").await;
    let old = repo("refresh-manual-repo");
    let agent = worktree_agent(&core, &account, &old).await;
    let new = old.with_file_name(format!(
        "{}-renamed",
        old.file_name().unwrap().to_string_lossy()
    ));
    // Renamed without repairing: the worktree no longer reaches its repository.
    std::fs::rename(&old, &new).unwrap();

    let r = core.refresh_projects().await.unwrap();
    assert!(r.moved.is_empty());
    assert_eq!(r.missing, vec![old.to_string_lossy().into_owned()]);

    let n = core
        .relocate_project(&old.to_string_lossy(), &new.to_string_lossy())
        .await
        .unwrap();
    assert_eq!(n, 1);
    assert_eq!(
        core.agent(&agent.id).unwrap().project_path,
        new.to_string_lossy()
    );
    // git can use the worktree again.
    git(Path::new(&agent.cwd), &["status", "--short"]);
    let r = core.refresh_projects().await.unwrap();
    assert!(r.moved.is_empty() && r.missing.is_empty());

    // A folder that isn't there is refused.
    let err = core
        .relocate_project(&new.to_string_lossy(), "/definitely/not/here")
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("Folder not found"), "{err:#}");
}
