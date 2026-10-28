//! Armada core: agent supervision, provider protocol clients (ACP, Codex app-server),
//! accounts and local storage. UI-agnostic; the Tauri shell wires it to the window.

pub mod accounts;
pub mod model;
pub mod providers;
pub mod toolchain;

mod acp;
mod codex;
mod db;
mod files;
mod git;
mod jsonrpc;
mod manager;
mod session;

pub use manager::Core;
pub use model::*;

/// Receives every event the core produces. The Tauri shell forwards these to the
/// window and drives sounds/notifications off `ArmadaEvent::Attention`.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: ArmadaEvent);
}

pub type Result<T> = anyhow::Result<T>;
