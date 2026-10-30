//! Armada's own copies of the agent tools (Claude Code, Codex, Grok): installing them for
//! the providers you use, and keeping them up to date by themselves.
//!
//! Armada prefers its own copy over anything on the system (see
//! `armada_core::providers::find_cli`), so sign-in, status and agents never depend on the
//! system's PATH, launcher scripts or versions. The versions in `providers.rs` are the
//! tested baseline; newer releases come from the npm registry on their own schedule.

use std::sync::Arc;
use std::time::Duration;

use armada_core::toolchain::{self, Log, UpdateTarget};
use armada_core::{AgentStatus, ArmadaEvent, Core, Provider};
use tauri::Manager;

type AppHandle = tauri::AppHandle<crate::Rt>;
use tracing::{info, warn};

use crate::state::Shell;

/// Let the app settle before anything downloads.
const STARTUP_DELAY: Duration = Duration::from_secs(12);
/// How often to look for newer releases.
const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
/// Retry sooner after a failed check (offline) or when updates had to wait for a busy agent.
const RETRY_EVERY: Duration = Duration::from_secs(15 * 60);

/// Starts the background maintenance loop (call once, from `setup`).
pub(crate) fn spawn_maintenance(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            if crate::exiting() {
                break;
            }
            let wait = maintain(&app).await;
            tokio::time::sleep(wait).await;
        }
    });
}

fn log() -> Log {
    Arc::new(|line: &str| {
        if !line.trim().is_empty() {
            info!("tools: {line}");
        }
    })
}

/// A provider's agent is busy: replacing its files could break a running turn.
fn busy(core: &Core, provider: Provider) -> bool {
    core.agents().unwrap_or_default().iter().any(|a| {
        a.provider == provider
            && if cfg!(windows) {
                // Windows can't replace a program that is running.
                a.running
            } else {
                matches!(
                    a.status,
                    AgentStatus::Working | AgentStatus::NeedsPermission | AgentStatus::Starting
                )
            }
    })
}

/// A provider Armada should have its own copy of: one that's installed on the system,
/// or that has agents here. (Others get theirs when the user clicks Install.)
fn in_use(core: &Core, provider: Provider) -> bool {
    armada_core::providers::resolve_program(armada_core::providers::cli_name(provider)).is_some()
        || core
            .agents()
            .unwrap_or_default()
            .iter()
            .any(|a| a.provider == provider)
}

async fn refresh(app: &AppHandle) {
    let providers = app.state::<Shell>().refresh_providers().await;
    app.state::<Core>()
        .emit(ArmadaEvent::ProvidersChanged { providers });
}

/// One round: install missing copies, check for updates, apply them when allowed.
/// Returns how long to wait before the next round.
async fn maintain(app: &AppHandle) -> Duration {
    let data_dir = app.state::<Shell>().data_dir.clone();
    let core = app.state::<Core>().inner().clone();
    let mut wait = CHECK_EVERY;

    // 1. Armada's own copy for every provider in use that lacks one (or has an older one
    //    than the tested baseline).
    for provider in Provider::ALL {
        if toolchain::needs_install(provider, &data_dir) && in_use(&core, provider) {
            if busy(&core, provider) {
                wait = RETRY_EVERY;
                continue;
            }
            info!(provider = provider.as_str(), "installing Armada's own copy");
            if let Err(e) = toolchain::install(provider, &data_dir, log()).await {
                warn!(provider = provider.as_str(), "couldn't install: {e:#}");
                wait = RETRY_EVERY;
            }
            refresh(app).await;
        }
    }

    // 2. What's new on the registry.
    if let Err(e) = toolchain::check_updates(&log()).await {
        warn!("update check failed: {e:#}");
        return RETRY_EVERY;
    }
    refresh(app).await;

    // 3. Apply updates unless the user wants to click for them.
    if core
        .settings()
        .map(|s| s.auto_update_tools)
        .unwrap_or(false)
    {
        for provider in Provider::ALL {
            if !toolchain::update_available(provider, &data_dir)
                || toolchain::is_held(&data_dir, provider)
            {
                continue;
            }
            if busy(&core, provider) {
                // Try again soon instead of waiting for the next check.
                wait = RETRY_EVERY;
                continue;
            }
            info!(provider = provider.as_str(), "updating");
            if let Err(e) =
                toolchain::update(provider, &data_dir, UpdateTarget::Latest, log()).await
            {
                warn!(provider = provider.as_str(), "update failed: {e:#}");
            }
            refresh(app).await;
        }
    }
    wait
}
