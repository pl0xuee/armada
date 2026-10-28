//! Armada core: agent supervision, provider protocol clients (ACP, Codex app-server),
//! accounts and local storage. UI-agnostic; the Tauri shell wires it to the window.

pub mod accounts;
pub mod checkpoints;
pub mod childenv;
pub mod local;
pub mod model;
pub mod providers;
pub mod redact;
pub mod scripts;
pub mod toolchain;
pub mod voice;

mod acp;
mod codex;
mod db;
mod files;
mod git;
mod jsonrpc;
mod manager;
mod mcp;
mod secrets;
mod session;

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
/// window and drives sounds/notifications off `ArmadaEvent::Attention`.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: ArmadaEvent);
}

pub type Result<T> = anyhow::Result<T>;
