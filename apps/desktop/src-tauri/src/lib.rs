//! Armada desktop shell: wires `armada_core::Core` to a Tauri 2 window, the tray,
//! OS notifications, sounds, PTY terminals and git review commands.

mod attention;
mod clipboard;
mod commands;
mod dictation;
mod events;
mod git_review;
mod hotkey;
mod local;
mod log_writer;
mod notify;
mod pr_status;
mod remote;
mod sound;
mod state;
mod terminal;
mod tray;
mod updater;
mod voice_assistant;
mod window;
mod workspace;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use armada_core::{ArmadaEvent, Core};
use tauri::{Manager, RunEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tracing::{error, info, warn};

use crate::attention::Attention;
use crate::state::Shell;
use crate::terminal::Terminals;

/// The tauri runtime: real windows in the app, the mock runtime in unit tests (so the
/// IPC smoke test can drive every command without a display).
#[cfg(not(test))]
pub(crate) type Rt = tauri::Wry;
#[cfg(test)]
pub(crate) type Rt = tauri::test::MockRuntime;
pub(crate) type AppHandle = tauri::AppHandle<Rt>;

/// The registered command list, shared by `run()` and the IPC smoke test so the test
/// exercises exactly what ships.
macro_rules! handler {
    () => {
        tauri::generate_handler![
            commands::get_state,
            dictation::voice_status,
            dictation::voice_list_devices,
            dictation::voice_download_model,
            dictation::voice_cancel_download,
            dictation::voice_delete_model,
            dictation::voice_start,
            dictation::voice_stop,
            dictation::voice_cancel,
            voice_assistant::va_start,
            voice_assistant::va_stop,
            voice_assistant::va_confirm,
            voice_assistant::va_set_muted,
            voice_assistant::va_active,
            voice_assistant::va_usage,
            voice_assistant::va_voices,
            clipboard::read_clipboard_images,
            commands::list_items,
            commands::search,
            commands::create_agent,
            commands::send_prompt,
            commands::cancel_turn,
            commands::remove_queued,
            commands::send_queued_now,
            commands::resume_queue,
            commands::clear_queue,
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
            commands::chime_watched,
            commands::set_window_title,
            commands::get_diff,
            commands::list_checkpoints,
            commands::preview_checkpoint,
            commands::restore_checkpoint,
            commands::commit_agent,
            commands::secret_looking_files,
            commands::merge_agent,
            commands::ship_agent,
            commands::base_branch_status,
            commands::push_base_branch,
            commands::revert_patch,
            commands::test_mcp_server,
            commands::acknowledge_agent,
            commands::update_account_key,
            commands::discover_projects,
            commands::is_git_repo,
            commands::create_pr,
            commands::pr_status,
            commands::pr_fix_ci_prompt,
            commands::pr_review_prompt,
            commands::discard_worktree,
            commands::create_account,
            commands::update_account,
            commands::delete_account,
            commands::check_account,
            local::detect_local_servers,
            local::probe_local_server,
            local::probe_local_account,
            local::pull_local_model,
            local::cancel_local_pull,
            commands::login_account,
            commands::detect_providers,
            commands::install_provider,
            commands::install_missing,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_kill,
            workspace::workspace_terminal_open,
            workspace::workspace_scripts,
            workspace::probe_ports,
            workspace::probe_loopback,
            commands::update_settings,
            commands::set_interface_zoom,
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
            commands::read_image,
            commands::remote_status,
            commands::remote_rotate_token,
            commands::remote_revoke_device,
            commands::create_share_link,
            commands::revoke_share_link,
        ]
    };
}

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

    tauri::Builder::<Rt>::new()
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
            window::create_main(app.handle())?;
            setup(app.handle(), startup_data_dir.as_deref()).map_err(|e| {
                error!("startup failed: {e:#}");
                Box::<dyn std::error::Error>::from(format!("{e:#}"))
            })
        })
        .on_window_event(window::on_window_event)
        .invoke_handler(handler!())
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

/// Every `State<T>` a command may request. Shared by `setup()` and the IPC smoke test, so
/// dropping a `manage()` here fails that test instead of failing at runtime.
fn manage_state(
    app: &AppHandle,
    core: &Core,
    data_dir: &Path,
) -> (Arc<remote::Remote>, Arc<Attention>) {
    app.manage(core.clone());
    app.manage(Shell::new(data_dir.to_path_buf()));
    app.manage(Terminals::default());
    app.manage(dictation::Dictation::default());
    app.manage(voice_assistant::VoiceAssistant::default());
    app.manage(pr_status::PrCache::default());
    app.manage(updater::UpdateState::default());
    let remote = remote::Remote::new(
        core.clone(),
        app.package_info().version.to_string(),
        data_dir.to_path_buf(),
    );
    app.manage(remote.clone());
    let icon_path = write_notification_icon(data_dir);
    let attention = Arc::new(Attention::new(app.clone(), icon_path));
    app.manage(attention.clone());
    (remote, attention)
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
    let (remote, attention) = manage_state(app, &core, &data_dir);

    // Not fatal: some desktops have no tray (closing the window then quits).
    // On Linux the indicator library is loaded lazily and panics when it's missing.
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| tray::create(app))) {
        Ok(Ok(())) => tray::AVAILABLE.store(true, Ordering::Relaxed),
        Ok(Err(e)) => warn!("could not create the tray icon: {e}"),
        Err(_) => warn!("could not create the tray icon: the tray library panicked (is libayatana-appindicator installed?)"),
    }
    events::spawn_dispatcher(app.clone(), rx);
    spawn_signal_handler(app.clone());
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
        // Failures are logged; Settings reports them when the user changes the hotkey.
        tauri::async_runtime::spawn_blocking(move || {
            let _ = hotkey::apply(&app, &hotkey);
        });
    }
    apply_autostart(app, settings.launch_at_login);
    {
        let remote_settings = settings.remote.clone();
        let remote = remote.clone();
        tauri::async_runtime::spawn(async move { remote.apply(&remote_settings).await });
    }
    {
        // Follow LAN address changes (new Wi-Fi, DHCP) even while the window is closed.
        let remote = remote.clone();
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(30));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                if EXIT_STATE.load(Ordering::SeqCst) != RUNNING {
                    break;
                }
                remote.refresh_lan().await;
            }
        });
    }
    if autostart_launch() {
        // Launched at login: the window was built hidden (quietly in the tray). Without
        // a usable tray there'd be no way back to it, so show it then.
        if !(settings.close_to_tray && tray::available()) {
            window::show_main(app);
        }
    }
    if std::env::args().any(|a| a == "--new-agent") {
        // Cold start via `armada --new-agent`: open New agent once the UI is listening.
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(2000)).await;
            window::navigate(&app, armada_core::NavigateTarget::NewAgent);
        });
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

/// Started by the login item (`--autostart`).
pub(crate) fn autostart_launch() -> bool {
    std::env::args().any(|a| a == "--autostart")
}

fn init_logging(log_dir: &Path) -> tracing_appender::non_blocking::WorkerGuard {
    use tracing_subscriber::prelude::*;
    use tracing_subscriber::{fmt, EnvFilter};

    let _ = std::fs::create_dir_all(log_dir);
    // Logs can include agent output: keep them private and keep a week.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(log_dir, std::fs::Permissions::from_mode(0o700));
    }
    let (file_writer, guard) = match log_writer::CappedLogWriter::new(log_dir.to_path_buf()) {
        Ok(file) => tracing_appender::non_blocking(file),
        Err(e) => {
            eprintln!("could not open the log file: {e}");
            tracing_appender::non_blocking(std::io::sink())
        }
    };
    let filter = EnvFilter::try_from_env("ARMADA_LOG")
        .unwrap_or_else(|_| {
        // Raw agent stderr / non-JSON stdout can carry secrets: off by default,
        // opt in with ARMADA_LOG (e.g. `debug,armada::agent_stderr=debug`).
        EnvFilter::new(
            "info,armada_core=debug,armada_desktop_lib=debug,armada::agent_stderr=warn,armada::rpc=warn",
        )
    });
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
/// An update is being installed; it restarts the app itself.
const UPDATING: u8 = 3;
static EXIT_STATE: AtomicU8 = AtomicU8::new(RUNNING);

/// Claims the app's shutdown for an update install. `false` if the app is already
/// quitting (or updating).
pub(crate) fn begin_update() -> bool {
    EXIT_STATE
        .compare_exchange(RUNNING, UPDATING, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

/// Stops the remote server first (no new work from the phone), then records busy
/// agents as interrupted and ends PTYs. Bounded (server 3 s, agents 10 s,
/// terminals ~1 s) so nothing stuck can block exit. Used on exit and before an
/// update installs.
pub(crate) async fn shutdown_services(app: &AppHandle) {
    // End a live voice session first (bounded to 2 s) so its usage is recorded.
    voice_assistant::shutdown(app).await;
    if let Some(remote) = app.try_state::<Arc<remote::Remote>>() {
        // Also keeps a still-running startup `apply` from starting it again.
        remote.shutdown().await;
    }
    let agents = async {
        if let Some(core) = app.try_state::<Core>().map(|c| c.inner().clone()) {
            info!("shutting down agents");
            if tokio::time::timeout(Duration::from_secs(10), core.shutdown())
                .await
                .is_err()
            {
                warn!("core shutdown timed out");
            }
        }
    };
    let terminals = async {
        if let Some(terminals) = app.try_state::<Terminals>().map(|t| t.inner().clone()) {
            let _ = tauri::async_runtime::spawn_blocking(move || terminals.kill_all()).await;
        }
    };
    tokio::join!(agents, terminals);
    // Anything still alive (a stuck handshake, a timed-out stop): end its whole
    // process tree rather than leave it running after Armada is gone.
    let _ = tauri::async_runtime::spawn_blocking(armada_core::kill_all_children).await;
}

/// Total time allowed for a clean shutdown before the app exits anyway.
pub(crate) const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(20);

/// SIGTERM/SIGINT/SIGHUP (logout, `kill`, system shutdown) take the normal quit
/// path, so agents are recorded as interrupted and their processes are stopped.
fn spawn_signal_handler(app: AppHandle) {
    #[cfg(unix)]
    tauri::async_runtime::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let (Ok(mut term), Ok(mut int), Ok(mut hup)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
            signal(SignalKind::hangup()),
        ) else {
            warn!("could not install signal handlers");
            return;
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
            _ = hup.recv() => {}
        }
        info!("signal received; quitting");
        app.exit(0);
    });
    #[cfg(not(unix))]
    let _ = app;
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
            match EXIT_STATE.compare_exchange(
                RUNNING,
                SHUTTING_DOWN,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Err(DONE) => {}
                // Already shutting down, or installing an update (which restarts the
                // app when done): quitting now would leave a half-installed update.
                Err(_) => api.prevent_exit(),
                Ok(_) => {
                    api.prevent_exit();
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if tokio::time::timeout(SHUTDOWN_DEADLINE, shutdown_services(&app))
                            .await
                            .is_err()
                        {
                            warn!("shutdown took too long; exiting anyway");
                            let _ = tauri::async_runtime::spawn_blocking(
                                armada_core::kill_all_children,
                            )
                            .await;
                        }
                        EXIT_STATE.store(DONE, Ordering::SeqCst);
                        app.exit(code.unwrap_or(0));
                    });
                }
            }
        }
        // Last resort (e.g. a quit path that skipped ExitRequested): no agent
        // process may outlive the app.
        RunEvent::Exit => {
            // A quit path that skipped ExitRequested (Windows log-off, some macOS
            // paths): run the clean shutdown here, bounded, if it hasn't run yet.
            if EXIT_STATE
                .compare_exchange(RUNNING, SHUTTING_DOWN, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                let app2 = app.clone();
                let _ = tauri::async_runtime::block_on(tokio::time::timeout(
                    Duration::from_secs(5),
                    shutdown_services(&app2),
                ));
                EXIT_STATE.store(DONE, Ordering::SeqCst);
            }
            armada_core::kill_all_children()
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

    /// A command asking for `State<T>` of a type that `run()` never `manage()`s compiles
    /// fine and fails only when called ("state not managed for field …"). Every type a
    /// command requests must be one of the managed ones below (keep in sync with `run()`).
    #[test]
    fn commands_only_request_managed_state() {
        const MANAGED: &[&str] = &[
            "Core",
            "armada_core::Core",
            "Shell",
            "Terminals",
            "Dictation",
            "dictation::Dictation",
            "VoiceAssistant",
            "voice_assistant::VoiceAssistant",
            "PrCache",
            "pr_status::PrCache",
            "UpdateState",
            "updater::UpdateState",
            "Arc<Remote>",
            "Arc<Attention>",
            "TrayState",
        ];
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    out.push(p);
                }
            }
        }
        let mut files = Vec::new();
        walk(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut files,
        );
        let mut bad = Vec::new();
        for f in files {
            let text = std::fs::read_to_string(&f).unwrap();
            for (i, line) in text.lines().enumerate() {
                let mut rest = line;
                // Split so this test's own source doesn't match.
                let needle = concat!("State<", "'_,");
                while let Some(at) = rest.find(needle) {
                    rest = &rest[at + needle.len()..];
                    // The type runs to the `>` that closes `State<`.
                    let (mut depth, mut end) = (0i32, rest.len());
                    for (j, c) in rest.char_indices() {
                        match c {
                            '<' => depth += 1,
                            '>' if depth == 0 => {
                                end = j;
                                break;
                            }
                            '>' => depth -= 1,
                            _ => {}
                        }
                    }
                    let ty: String = rest[..end].split_whitespace().collect();
                    if !MANAGED.contains(&ty.as_str()) {
                        bad.push(format!("{}:{}: State<{ty}>", f.display(), i + 1));
                    }
                }
            }
        }
        assert!(
            bad.is_empty(),
            "commands request unmanaged state:\n{}",
            bad.join("\n")
        );
    }
}

/// Drives every registered command through the real IPC path (mock runtime, the real
/// `handler!()` list, the real `manage_state()`), so a command that requests state
/// `setup()` never manages, or a `manage()` that gets dropped, fails here and not on a
/// user's machine ("state not managed for field …" only appears when a command runs).
#[cfg(test)]
mod ipc_smoke {
    use super::*;
    use serde_json::{json, Value};
    use tauri::test::{mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{ipc::CallbackFn, WebviewWindowBuilder};

    /// Commands that would touch the network, install software, the audio device or the
    /// desktop even with throwaway arguments. Their state requests are still covered by
    /// `commands_only_request_managed_state`.
    const SKIP: &[&str] = &[
        "install_missing",
        "install_update",
        "check_for_update",
        "va_start",
        // Never open the microphone or push from a test run.
        "voice_start",
        "push_base_branch",
        "test_notification",
        "open_path",
        "detect_local_servers",
    ];

    fn src(name: &str) -> String {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        std::fs::read_to_string(dir.join(format!("{name}.rs")))
            .or_else(|_| std::fs::read_to_string(dir.join(name).join("mod.rs")))
            .unwrap_or_else(|_| panic!("no source for module {name}"))
    }

    /// `(module, command)` for every entry of the `handler!` list.
    fn registered() -> Vec<(String, String)> {
        let lib = src("lib");
        let start = lib.find("tauri::generate_handler![").unwrap();
        let body = &lib[start..lib[start..].find("\n        ]\n").unwrap() + start];
        body.lines()
            .filter_map(|l| l.trim().strip_suffix(','))
            .filter_map(|l| l.split_once("::"))
            .map(|(m, c)| (m.to_string(), c.to_string()))
            .collect()
    }

    /// Plausible throwaway value for one parameter type; `None` = not an IPC argument.
    fn value_for(ty: &str) -> Option<Value> {
        let ty = ty.replace(' ', "");
        if ["State<", "tauri::State<", "AppHandle", "tauri::AppHandle"]
            .iter()
            .any(|p| ty.starts_with(p))
        {
            return None;
        }
        if ty.starts_with("Channel<") {
            return None;
        }
        Some(match ty.as_str() {
            "String" => json!("x"),
            "bool" => json!(false),
            "u16" | "u32" | "u64" | "usize" | "i32" | "i64" => json!(0),
            t if t.starts_with("Option<") => Value::Null,
            t if t.starts_with("Vec<") => json!([]),
            _ => json!({}),
        })
    }

    fn camel(s: &str) -> String {
        let mut out = String::new();
        let mut up = false;
        for c in s.chars() {
            if c == '_' {
                up = true;
            } else if up {
                out.extend(c.to_uppercase());
                up = false;
            } else {
                out.push(c);
            }
        }
        out
    }

    fn args_for(module: &str, name: &str) -> Value {
        let text = src(module);
        let at = text
            .find(&format!("fn {name}("))
            .or_else(|| text.find(&format!("fn {name}<")))
            .unwrap_or_else(|| panic!("fn {name} not found in {module}"));
        let open = at + text[at..].find('(').unwrap();
        let (mut depth, mut end) = (0i32, open);
        for (i, c) in text[open..].char_indices() {
            match c {
                '(' | '<' | '[' => depth += 1,
                ')' | '>' | ']' => {
                    depth -= 1;
                    if depth == 0 {
                        end = open + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let params = &text[open + 1..end];
        let (mut parts, mut depth, mut cur) = (Vec::new(), 0i32, String::new());
        for c in params.chars() {
            match c {
                '<' | '(' | '[' => depth += 1,
                '>' | ')' | ']' => depth -= 1,
                ',' if depth == 0 => {
                    parts.push(std::mem::take(&mut cur));
                    continue;
                }
                _ => {}
            }
            cur.push(c);
        }
        parts.push(cur);
        let mut map = serde_json::Map::new();
        for p in parts {
            let Some((n, ty)) = p.split_once(": ").or_else(|| p.split_once(':')) else {
                continue;
            };
            let n = n.trim().trim_start_matches("mut ").trim();
            if let Some(v) = value_for(ty.trim()) {
                map.insert(camel(n), v);
            }
        }
        Value::Object(map)
    }

    #[test]
    fn every_command_resolves_its_state() {
        let tmp = std::env::temp_dir().join(format!("armada-ipc-smoke-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let app = mock_builder()
            .invoke_handler(handler!())
            .build(mock_context(noop_assets()))
            .unwrap();
        let (sink, _rx) = events::channel();
        let core = tauri::async_runtime::block_on(async { Core::open(tmp.clone(), sink) }).unwrap();
        manage_state(app.handle(), &core, &tmp);
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();

        let cmds = registered();
        assert!(cmds.len() > 50, "parsed only {} commands", cmds.len());
        let mut failures = Vec::new();
        for (module, name) in &cmds {
            if SKIP.contains(&name.as_str()) {
                continue;
            }
            let req = InvokeRequest {
                cmd: name.clone(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                // Must count as the app's own origin, or the ACL layer rejects the call
                // before it reaches the command.
                url: if cfg!(windows) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: tauri::ipc::InvokeBody::Json(args_for(module, name)),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            };
            let res = tauri::test::get_ipc_response(&webview, req);
            let text = match &res {
                Ok(b) => format!("{b:?}"),
                Err(e) => e.to_string(),
            };
            let low = text.to_lowercase();
            if low.contains("not managed") || low.contains("not found") && low.contains("command") {
                failures.push(format!("{name}: {text}"));
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
        assert!(
            failures.is_empty(),
            "IPC failures:\n{}",
            failures.join("\n")
        );
    }
}
