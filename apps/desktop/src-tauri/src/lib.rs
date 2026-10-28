//! Armada desktop shell: wires `armada_core::Core` to a Tauri 2 window, the tray,
//! OS notifications, sounds, PTY terminals and git review commands.

mod attention;
mod commands;
mod events;
mod git_review;
mod hotkey;
mod notify;
mod remote;
mod sound;
mod state;
mod terminal;
mod tray;
mod updater;
mod window;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use armada_core::{ArmadaEvent, Core};
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tracing::{error, info, warn};

use crate::attention::Attention;
use crate::state::Shell;
use crate::terminal::Terminals;

/// Keeps the non-blocking file writer alive for the life of the app.
struct LogGuard(#[allow(dead_code)] tracing_appender::non_blocking::WorkerGuard);

pub fn run() {
    let context = tauri::generate_context!();

    // PATH is process-global and `set_var` is unsound once other threads may read the
    // environment, so every PATH change happens here, before Tauri, tokio or anything
    // else starts a thread. GUI launches (Finder, Start menu, .desktop files) get a
    // minimal PATH; then Armada-managed Node and agent CLIs are added.
    armada_core::providers::augment_path();
    let startup_data_dir = app_data_dir(&context.config().identifier);
    if let Some(dir) = &startup_data_dir {
        armada_core::toolchain::add_managed_paths(dir);
    }

    tauri::Builder::default()
        // Must be first so a second launch is caught before anything else starts.
        // `armada --new-agent` from a compositor/WM keybinding works as a quick-launch
        // where global hotkeys can't be grabbed (Wayland).
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if argv.iter().any(|a| a == "--new-agent") {
                window::navigate(app, armada_core::NavigateTarget::NewAgent);
            } else {
                window::show_main(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(hotkey::on_shortcut)
                .build(),
        )
        .setup(move |app| {
            setup(app.handle(), startup_data_dir.as_deref()).map_err(|e| {
                error!("startup failed: {e:#}");
                Box::<dyn std::error::Error>::from(format!("{e:#}"))
            })
        })
        .on_window_event(window::on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::list_items,
            commands::search,
            commands::create_agent,
            commands::send_prompt,
            commands::cancel_turn,
            commands::respond_permission,
            commands::resume_agent,
            commands::stop_agent,
            commands::delete_agent,
            commands::rename_agent,
            commands::archive_agent,
            commands::mark_read,
            commands::set_agent_config,
            commands::handoff_agent,
            commands::set_focus,
            commands::get_diff,
            commands::commit_agent,
            commands::merge_agent,
            commands::create_pr,
            commands::discard_worktree,
            commands::create_account,
            commands::update_account,
            commands::delete_account,
            commands::check_account,
            commands::login_account,
            commands::detect_providers,
            commands::install_provider,
            commands::install_missing,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_kill,
            commands::update_settings,
            commands::preview_sound,
            commands::test_notification,
            commands::open_path,
            commands::check_for_update,
            commands::install_update,
            commands::switch_account,
            commands::export_agent,
            commands::list_schedules,
            commands::save_schedule,
            commands::delete_schedule,
            commands::run_schedule,
            commands::test_custom_agent,
            commands::list_files,
            commands::remote_status,
            commands::remote_rotate_token,
            commands::create_share_link,
            commands::revoke_share_link,
        ])
        .build(context)
        .expect("error while building Armada")
        .run(on_run_event);
}

/// Mirrors tauri's `PathResolver::app_data_dir()` (`dirs::data_dir()/<identifier>` on
/// every desktop OS; tauri.conf.json sets no `appDirectoriesOverride`), so it can be
/// computed before the Tauri app (and its threads) exist.
fn app_data_dir(identifier: &str) -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join(identifier))
}

fn setup(app: &AppHandle, startup_data_dir: Option<&Path>) -> anyhow::Result<()> {
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    app.manage(LogGuard(init_logging(&data_dir.join("logs"))));
    info!(
        version = %app.package_info().version,
        data_dir = %data_dir.display(),
        "starting Armada"
    );
    if startup_data_dir != Some(data_dir.as_path()) {
        warn!(
            startup = ?startup_data_dir,
            "data dir differs from the one used for PATH setup; Armada-managed tools may not be found"
        );
    }

    // Without this, macOS attributes our notifications to Finder (notify-rust's default).
    #[cfg(target_os = "macos")]
    if let Err(e) = notify_rust::set_application(&app.config().identifier) {
        warn!("could not register notifications under the app's bundle id: {e}");
    }

    // Core events flow through an unbounded channel so `EventSink::emit` never
    // blocks the core; the dispatcher forwards them to the window.
    let (sink, rx) = events::channel();
    let core = tauri::async_runtime::block_on(async { Core::open(data_dir.clone(), sink) })?;
    app.manage(core.clone());
    app.manage(Shell::new(data_dir.clone()));
    app.manage(Terminals::default());
    app.manage(updater::UpdateState::default());
    let remote = remote::Remote::new(
        core.clone(),
        app.package_info().version.to_string(),
        data_dir.clone(),
    );
    app.manage(remote.clone());

    let icon_path = write_notification_icon(&data_dir);
    let attention = Arc::new(Attention::new(app.clone(), icon_path));
    app.manage(attention.clone());

    tray::create(app)?;
    events::spawn_dispatcher(app.clone(), rx);
    attention.spawn_escalation();

    // Settings-driven OS integration.
    let settings = core.settings().unwrap_or_else(|e| {
        warn!("could not load settings: {e:#}");
        Default::default()
    });
    {
        // Registration hops to the main thread and waits; do it off the main thread.
        let app = app.clone();
        let hotkey = settings.global_hotkey.clone();
        tauri::async_runtime::spawn_blocking(move || hotkey::apply(&app, &hotkey));
    }
    apply_autostart(app, settings.launch_at_login);
    {
        let remote_settings = settings.remote.clone();
        tauri::async_runtime::spawn(async move { remote.apply(&remote_settings).await });
    }
    if settings.close_to_tray && std::env::args().any(|a| a == "--autostart") {
        // Launched at login: start quietly in the tray.
        window::hide_main(app);
    }

    updater::spawn_background_checks(app.clone());

    // Background startup work.
    {
        let core = core.clone();
        tauri::async_runtime::spawn(async move { core.startup().await });
    }
    {
        let core = core.clone();
        tauri::async_runtime::spawn(async move {
            match core.accounts() {
                Ok(accounts) => {
                    for account in accounts {
                        let core = core.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = core.check_account(&account.id).await {
                                warn!(account = %account.id, "account check failed: {e:#}");
                            }
                        });
                    }
                }
                Err(e) => warn!("could not list accounts: {e:#}"),
            }
        });
    }
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let providers = app.state::<Shell>().providers().await;
            app.state::<Core>()
                .emit(ArmadaEvent::ProvidersChanged { providers });
        });
    }
    Ok(())
}

fn init_logging(log_dir: &Path) -> tracing_appender::non_blocking::WorkerGuard {
    use tracing_subscriber::prelude::*;
    use tracing_subscriber::{fmt, EnvFilter};

    let _ = std::fs::create_dir_all(log_dir);
    let file = tracing_appender::rolling::daily(log_dir, "armada.log");
    let (file_writer, guard) = tracing_appender::non_blocking(file);
    let filter = EnvFilter::try_from_env("ARMADA_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info,armada_core=debug,armada_desktop_lib=debug"));
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(std::io::stderr))
        .with(fmt::layer().with_ansi(false).with_writer(file_writer))
        .try_init();
    guard
}

/// Linux notification daemons want an icon file path; drop ours into the data dir.
fn write_notification_icon(data_dir: &Path) -> Option<std::path::PathBuf> {
    static ICON: &[u8] = include_bytes!("../icons/128x128.png");
    let path = data_dir.join("notification-icon.png");
    match std::fs::write(&path, ICON) {
        Ok(()) => Some(path),
        Err(e) => {
            warn!("could not write notification icon: {e}");
            None
        }
    }
}

pub(crate) fn apply_autostart(app: &AppHandle, enabled: bool) {
    let autolaunch = app.autolaunch();
    let current = autolaunch.is_enabled().unwrap_or(!enabled);
    if current == enabled {
        return;
    }
    let result = if enabled {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
    if let Err(e) = result {
        warn!("could not update launch-at-login: {e}");
    }
}

const RUNNING: u8 = 0;
const SHUTTING_DOWN: u8 = 1;
const DONE: u8 = 2;
static EXIT_STATE: AtomicU8 = AtomicU8::new(RUNNING);

/// Records busy agents as interrupted (bounded, so a stuck agent can't block exit),
/// kills PTYs and stops the remote server. Used on exit and before an update installs.
pub(crate) async fn shutdown_services(app: &AppHandle) {
    if let Some(core) = app.try_state::<Core>().map(|c| c.inner().clone()) {
        info!("shutting down agents");
        if tokio::time::timeout(Duration::from_secs(10), core.shutdown())
            .await
            .is_err()
        {
            warn!("core shutdown timed out");
        }
    }
    if let Some(terminals) = app.try_state::<Terminals>() {
        terminals.kill_all();
    }
    if let Some(remote) = app.try_state::<Arc<remote::Remote>>() {
        remote.stop();
    }
}

fn on_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        // `app.restart()` (after an update) shuts down first and can't be prevented.
        RunEvent::ExitRequested { code, .. } if code == Some(tauri::RESTART_EXIT_CODE) => {}
        RunEvent::ExitRequested { api, code, .. } => {
            // Let the core record busy agents as interrupted before the process dies.
            if app.try_state::<Core>().is_none() {
                return;
            }
            match EXIT_STATE.load(Ordering::SeqCst) {
                DONE => {}
                SHUTTING_DOWN => api.prevent_exit(),
                _ => {
                    EXIT_STATE.store(SHUTTING_DOWN, Ordering::SeqCst);
                    api.prevent_exit();
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        shutdown_services(&app).await;
                        EXIT_STATE.store(DONE, Ordering::SeqCst);
                        app.exit(code.unwrap_or(0));
                    });
                }
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => window::show_main(app),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    /// `app_data_dir()` above mirrors tauri's resolver only while no directory override
    /// is configured.
    #[test]
    fn data_dir_is_not_overridden() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(conf["app"].get("appDirectoriesOverride").is_none());
        assert_eq!(conf["identifier"], "dev.armada.app");
    }
}
