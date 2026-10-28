//! `kill_all_children` (the shell's last resort before exiting) takes down every
//! agent process tree. Its own test binary: it kills everything this process started.

#![cfg(unix)]

use std::sync::Arc;
use std::time::Duration;

use armada_core::*;

struct Sink;

impl EventSink for Sink {
    fn emit(&self, _event: ArmadaEvent) {}
}

fn processes_with(marker: &str) -> usize {
    let out = std::process::Command::new("pgrep")
        .args(["-f", marker])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).lines().count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kill_all_children_takes_down_every_agent_tree() {
    let tests = concat!(env!("CARGO_MANIFEST_DIR"), "/tests");
    let marker = format!("armada-exit-marker-{}", std::process::id());
    let data = std::env::temp_dir().join(format!("armada-exit-{}", std::process::id()));
    let project = data.join("project");
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&project).unwrap();
    let core = Core::open(data.join("data"), Arc::new(Sink)).unwrap();
    let mut settings = core.settings().unwrap();
    settings.custom_agents = vec![CustomAgent {
        id: "mock".into(),
        name: "Mock".into(),
        command: "python3".into(),
        args: vec![
            format!("{tests}/mock_wrapper.py"),
            format!("{tests}/mock_modes.py"),
            "normal".into(),
            marker.clone(),
        ],
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
    let agent = core
        .create_agent(CreateAgentRequest {
            provider: Provider::Custom,
            account_id: account,
            project_path: project.to_string_lossy().into_owned(),
            prompt: String::new(),
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
    for _ in 0..100 {
        if core.agent(&agent.id).unwrap().running {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(processes_with(&marker) >= 2);
    // The children file records the live group for crash recovery.
    let recorded = std::fs::read_to_string(data.join("data/children.json")).unwrap();
    assert!(recorded.contains("\"pid\""), "{recorded}");

    kill_all_children();
    let mut left = processes_with(&marker);
    for _ in 0..30 {
        if left == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        left = processes_with(&marker);
    }
    assert_eq!(left, 0, "an agent process survived kill_all_children");
}
