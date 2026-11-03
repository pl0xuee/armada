//! A project that moved keeps what was filed under its folder: its spending limit, its own MCP
//! servers, its place in the recent list and its switched-off skills.

#![cfg(unix)]

use std::sync::Arc;

use kvistcode_core::budget::BudgetCap;
use kvistcode_core::*;
use tokio::sync::mpsc;

struct Sink(mpsc::UnboundedSender<KvistcodeEvent>);

impl EventSink for Sink {
    fn emit(&self, event: KvistcodeEvent) {
        let _ = self.0.send(event);
    }
}

mod common;

fn server(name: &str, project: &str) -> McpServer {
    serde_json::from_value(serde_json::json!({
        "id": name,
        "name": name,
        "command": "true",
        "projectPath": project,
    }))
    .unwrap()
}

fn off(names: &[&str]) -> std::collections::BTreeSet<String> {
    names.iter().map(|n| n.to_string()).collect()
}

#[tokio::test]
async fn relocating_a_project_moves_its_limit_servers_recent_entry_and_skills() {
    let (tx, rx) = mpsc::unbounded_channel();
    // Events are not inspected here; keep the receiver alive so sends succeed.
    std::mem::forget(rx);
    let base = common::scratch("test-relocate-settings");
    let core = Core::open(base.join("data"), Arc::new(Sink(tx))).unwrap();

    // The old folder is gone (the project was moved); the new one and an unrelated one exist.
    let old = base.join("old").to_string_lossy().into_owned();
    let new = base.join("new");
    let other = base.join("other").to_string_lossy().into_owned();
    std::fs::create_dir_all(&new).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    let new = new.canonicalize().unwrap().to_string_lossy().into_owned();

    let cap = |usd| BudgetCap {
        usd: Some(usd),
        ..Default::default()
    };
    core.update_settings(|s| {
        s.project_budgets.insert(old.clone(), cap(5.0));
        s.project_budgets.insert(other.clone(), cap(9.0));
        // Stored with a trailing slash, as a hand-typed path may be.
        s.mcp_servers = vec![
            server("docs", &format!("{old}/")),
            server("everywhere", ""),
            server("elsewhere", &other),
        ];
        s.recent_projects = vec![other.clone(), old.clone(), new.clone()];
    })
    .unwrap();
    skill_prefs::update(core.data_dir(), |prefs| {
        prefs.projects.insert(old.clone(), off(&["alpha", "beta"]));
        prefs.projects.insert(new.clone(), off(&["beta", "gamma"]));
        prefs.projects.insert(other.clone(), off(&["delta"]));
        Ok((true, ()))
    })
    .unwrap();

    core.relocate_project(&old, &new).await.unwrap();

    let s = core.settings().unwrap();
    assert_eq!(s.project_budgets.get(&new).and_then(|c| c.usd), Some(5.0));
    assert!(!s.project_budgets.contains_key(&old));
    assert_eq!(s.project_budgets.get(&other).and_then(|c| c.usd), Some(9.0));
    let at = |name: &str| {
        s.mcp_servers
            .iter()
            .find(|m| m.name == name)
            .unwrap()
            .project_path
            .clone()
    };
    assert_eq!(at("docs"), new);
    assert_eq!(at("everywhere"), "");
    assert_eq!(at("elsewhere"), other);
    // The recent list keeps its order and has the new folder once, where the old one was.
    assert_eq!(s.recent_projects, vec![other.clone(), new.clone()]);
    let prefs = skill_prefs::load(core.data_dir());
    assert_eq!(
        prefs.projects.get(&new),
        Some(&off(&["alpha", "beta", "gamma"]))
    );
    assert!(!prefs.projects.contains_key(&old));
    assert_eq!(prefs.projects.get(&other), Some(&off(&["delta"])));

    // Nothing left to move: a second call changes nothing and does not fail.
    core.relocate_project(&old, &new).await.unwrap();
    assert_eq!(core.settings().unwrap().recent_projects, s.recent_projects);

    // A limit already set on the new folder is kept over the old folder's.
    core.update_settings(|s| {
        s.project_budgets.insert(old.clone(), cap(1.0));
        s.project_budgets.insert(new.clone(), cap(7.0));
    })
    .unwrap();
    core.relocate_project(&old, &new).await.unwrap();
    let s = core.settings().unwrap();
    assert_eq!(s.project_budgets.get(&new).and_then(|c| c.usd), Some(7.0));
    assert!(!s.project_budgets.contains_key(&old));
}
