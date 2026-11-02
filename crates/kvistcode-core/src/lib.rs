//! Kvistcode core: agent supervision, provider protocol clients (ACP, Codex app-server),
//! accounts and local storage. UI-agnostic; the Tauri shell wires it to the window.

pub mod accounts;
pub mod budget;
pub mod checkpoints;
pub mod childenv;
pub mod limit_resume;
pub mod local;
pub mod model;
pub mod project_config;
pub mod providers;
pub mod questions;
pub mod redact;
pub mod scripts;
pub mod skill_prefs;
pub mod skills;
pub mod toolchain;
pub mod voice;
pub mod workflow;

mod acp;
mod codex;
mod config_memory;
mod db;
mod files;
mod git;
mod guidance;
mod helpers;
mod jsonrpc;
mod limit_reset;
mod manager;
mod mcp;
mod plan_approval;
mod secrets;
mod session;

pub use files::is_network_path;
pub use git::{hardened_command, hardening, Hardening, PUSH_REDIRECT_ERROR};
pub use jsonrpc::kill_all_children;

/// Whether `path` is inside a git work tree with at least one commit (what
/// worktree agents need).
pub async fn git_work_tree(path: &std::path::Path) -> bool {
    git::repo_info(path).await.is_some()
}
pub use manager::Core;
pub use model::*;

/// Receives every event the core produces. The Tauri shell forwards these to the
/// window and drives sounds/notifications off `KvistcodeEvent::Attention`.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: KvistcodeEvent);
}

pub type Result<T> = anyhow::Result<T>;
