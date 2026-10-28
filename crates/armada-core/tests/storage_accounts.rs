//! Storage and account safety: settings validation, account deletion guards,
//! briefing after an account switch surviving a restart, worktree deletion that
//! refuses to lose work, and recovery from a damaged database.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use armada_core::*;
use tokio::sync::mpsc;

const MOCK: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mock_acp.py");

struct Sink(mpsc::UnboundedSender<ArmadaEvent>);

impl EventSink for Sink {
    fn emit(&self, event: ArmadaEvent) {
        let _ = self.0.send(event);
    }
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("armada-store-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn open(data: &Path) -> (Core, mpsc::UnboundedReceiver<ArmadaEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (
        Core::open(data.to_path_buf(), Arc::new(Sink(tx))).unwrap(),
        rx,
    )
}

fn add_mock_agent(core: &Core) {
    core.update_settings(|s| {
        s.custom_agents = vec![CustomAgent {
            id: "mock".into(),
            name: "Mock".into(),
            command: "python3".into(),
            args: vec![MOCK.into()],
            env: vec![],
            color: "#B39DDB".into(),
            enabled: true,
        }];
    })
    .unwrap();
}

fn system_custom(core: &Core) -> String {
    core.accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.provider == Provider::Custom && a.is_system)
        .unwrap()
        .id
}

fn request(account: &str, project: &Path, worktree: bool) -> CreateAgentRequest {
    CreateAgentRequest {
        provider: Provider::Custom,
        account_id: account.into(),
        project_path: project.to_string_lossy().into_owned(),
        // No prompt: the agent warms up and waits (no permission round-trips).
        prompt: String::new(),
        title: Some("Test".into()),
        worktree,
        model: None,
        group_id: None,
        custom_agent_id: Some("mock".into()),
        permission_mode: None,
        attachments: vec![],
    }
}

async fn wait_until(mut f: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(20), async {
        while !f() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("timed out");
}

async fn custom_account(core: &Core, name: &str) -> Account {
    core.create_account(CreateAccountRequest {
        provider: Provider::Custom,
        name: name.into(),
        color: "#4FC3F7".into(),
        auth_kind: AuthKind::Oauth,
        api_key: None,
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn settings_are_validated_and_updated_atomically() {
    let data = temp_dir("settings");
    let (core, _rx) = open(&data);
    let mut bad = core.settings().unwrap();
    bad.failover = "sometimes".into();
    assert!(core.save_settings(bad).is_err());
    assert!(core
        .update_settings(|s| s.default_permission_mode = "yolo".into())
        .is_err());
    assert!(core.update_settings(|s| s.remote.port = 0).is_err());
    assert_eq!(
        core.settings().unwrap().failover,
        "ask",
        "rejected saves change nothing"
    );

    let saved = core
        .update_settings(|s| s.recent_projects.push("/a".into()))
        .unwrap();
    assert_eq!(saved.recent_projects, vec!["/a".to_string()]);
    core.shutdown().await;
    drop(core);

    // Persisted, and the data dir and database are private to the user.
    let (core, _rx) = open(&data);
    assert_eq!(
        core.settings().unwrap().recent_projects,
        vec!["/a".to_string()]
    );
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&data), 0o700);
    assert_eq!(mode(&data.join("armada.db")), 0o600);
    core.shutdown().await;
}

#[tokio::test]
async fn account_deletion_guards_and_briefing_survives_restart() {
    let data = temp_dir("accounts");
    let project = temp_dir("accounts-project");
    let (core, _rx) = open(&data);
    add_mock_agent(&core);
    let system = system_custom(&core);
    let work = custom_account(&core, "Work").await;
    let spare = custom_account(&core, "Spare").await;

    let agent = core
        .create_agent(request(&system, &project, false))
        .await
        .unwrap();
    wait_until(|| core.agent(&agent.id).is_ok_and(|a| a.running)).await;
    assert!(!core.agent(&agent.id).unwrap().needs_briefing);

    // A switch owes the next session a brief, and that survives a restart.
    let switched = core.switch_account(&agent.id, &work.id).await.unwrap();
    assert!(switched.needs_briefing);
    core.shutdown().await;
    drop(core);
    let (core, _rx) = open(&data);
    add_mock_agent(&core);
    assert!(core.agent(&agent.id).unwrap().needs_briefing);

    // Archived agents still block deleting their account.
    core.archive_agent(&agent.id, true).unwrap();
    let err = core.delete_account(&work.id).unwrap_err().to_string();
    assert!(
        err.contains("1 archived agent still use"),
        "unexpected message: {err}"
    );

    // So do schedules.
    let schedule = core
        .save_schedule(Schedule {
            id: String::new(),
            name: "Nightly".into(),
            enabled: false,
            provider: Provider::Custom,
            account_id: spare.id.clone(),
            project_path: project.to_string_lossy().into_owned(),
            prompt: "hello".into(),
            worktree: false,
            time: "03:00".into(),
            days: vec![],
            last_run_at: None,
            last_agent_id: None,
            custom_agent_id: Some("mock".into()),
            updated_at: 0,
            last_error: None,
            permission_mode: None,
        })
        .unwrap();
    let err = core.delete_account(&spare.id).unwrap_err().to_string();
    assert!(err.contains("Nightly"), "unexpected message: {err}");
    core.delete_schedule(&schedule.id).unwrap();
    core.delete_account(&spare.id).unwrap();
    assert!(!data.join("profiles").join(&spare.id).exists());

    // The brief is sent with the next session start, and the flag is cleared.
    core.archive_agent(&agent.id, false).unwrap();
    core.resume_agent(&agent.id, false).await.unwrap();
    wait_until(|| {
        core.agent(&agent.id)
            .is_ok_and(|a| a.running && !a.needs_briefing)
    })
    .await;
    core.shutdown().await;
}

#[tokio::test]
async fn failing_schedule_records_its_error() {
    let data = temp_dir("schedule");
    let project = temp_dir("schedule-project");
    let (core, mut rx) = open(&data);
    add_mock_agent(&core);
    let system = system_custom(&core);
    let saved = core
        .save_schedule(Schedule {
            id: String::new(),
            name: "Broken".into(),
            enabled: true,
            provider: Provider::Custom,
            account_id: system,
            project_path: project.to_string_lossy().into_owned(),
            prompt: "hello".into(),
            worktree: false,
            time: "03:00".into(),
            days: vec![],
            last_run_at: None,
            last_agent_id: None,
            custom_agent_id: Some("mock".into()),
            updated_at: 0,
            last_error: Some("stale".into()),
            permission_mode: None,
        })
        .unwrap();
    assert!(saved.last_error.is_none(), "saving clears an old error");
    // The custom agent disappears: the run fails, and says why.
    core.update_settings(|s| s.custom_agents.clear()).unwrap();
    assert!(core.run_schedule(&saved.id).await.is_err());
    let stored = core.schedules().unwrap().remove(0);
    assert!(stored
        .last_error
        .as_deref()
        .is_some_and(|e| e.contains("custom agent")));
    let mut emitted = false;
    while let Ok(ev) = rx.try_recv() {
        if let ArmadaEvent::ScheduleUpdated { schedule } = ev {
            emitted |= schedule.last_error.is_some();
        }
    }
    assert!(emitted, "the UI hears about the failure");
    core.shutdown().await;
}

fn git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[tokio::test]
async fn deleting_an_agent_keeps_unsaved_worktree_work_unless_forced() {
    let data = temp_dir("worktree");
    let project = temp_dir("worktree-project");
    git(&project, &["init", "-q", "-b", "main"]);
    std::fs::write(project.join("a.txt"), "a").unwrap();
    git(&project, &["add", "."]);
    git(&project, &["commit", "-q", "-m", "a"]);
    let (core, _rx) = open(&data);
    add_mock_agent(&core);
    let system = system_custom(&core);

    let agent = core
        .create_agent(request(&system, &project, true))
        .await
        .unwrap();
    assert!(agent.worktree);
    let cwd = PathBuf::from(&agent.cwd);
    std::fs::write(cwd.join("new.txt"), "work").unwrap();

    let err = core
        .delete_agent(&agent.id, true, false)
        .await
        .unwrap_err()
        .to_string();
    assert!(err.starts_with(UNSAVED_WORK_ERROR), "{err}");
    assert!(core.agent(&agent.id).is_ok(), "nothing deleted");
    assert!(cwd.join("new.txt").exists());

    core.delete_agent(&agent.id, true, true).await.unwrap();
    assert!(core.agent(&agent.id).is_err());
    assert!(!cwd.exists());
    core.shutdown().await;
}

#[tokio::test]
async fn damaged_database_is_set_aside() {
    let data = temp_dir("corrupt");
    std::fs::write(data.join("armada.db"), vec![0x5Au8; 16 * 1024]).unwrap();
    let (core, _rx) = open(&data);
    assert!(core
        .accounts()
        .unwrap()
        .iter()
        .any(|a| a.provider == Provider::Custom && a.is_system));
    let kept = std::fs::read_dir(&data).unwrap().flatten().any(|e| {
        e.file_name()
            .to_string_lossy()
            .starts_with("armada.db.corrupt-")
    });
    assert!(kept, "the damaged file is kept for recovery");
    core.shutdown().await;
}
