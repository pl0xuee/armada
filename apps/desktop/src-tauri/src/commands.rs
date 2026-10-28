//! Tauri commands. Names and argument names mirror apps/desktop/src/lib/api.ts.

use std::path::Path;
use std::sync::Arc;

use armada_core::{
    accounts, toolchain, Account, Agent, ArmadaEvent, Attachment, AttentionReason, Core,
    CreateAccountRequest, CreateAgentRequest, CustomAgent, Provider, ProviderInfo, Schedule,
    SearchHit, Settings, TimelineItem, UpdateInfo,
};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tracing::{info, warn};

use crate::attention::Attention;
use crate::git_review::{self, AgentDiff};
use crate::remote::{Remote, RemoteStatus, ShareLink};
use crate::state::Shell;
use crate::terminal::{SpawnSpec, Terminals};

pub type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

const MAX_RECENT_PROJECTS: usize = 10;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub agents: Vec<Agent>,
    pub accounts: Vec<Account>,
    pub providers: Vec<ProviderInfo>,
    pub settings: Settings,
    pub version: String,
    pub platform: &'static str,
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

// ---- state -------------------------------------------------------------------

#[tauri::command]
pub async fn get_state(
    app: AppHandle,
    core: State<'_, Core>,
    shell: State<'_, Shell>,
) -> CmdResult<AppState> {
    Ok(AppState {
        agents: core.agents().map_err(err)?,
        accounts: core.accounts().map_err(err)?,
        providers: shell.providers().await,
        settings: core.settings().map_err(err)?,
        version: app.package_info().version.to_string(),
        platform: platform(),
    })
}

#[tauri::command]
pub async fn list_items(core: State<'_, Core>, agent_id: String) -> CmdResult<Vec<TimelineItem>> {
    core.items(&agent_id).map_err(err)
}

#[tauri::command]
pub async fn search(core: State<'_, Core>, query: String) -> CmdResult<Vec<SearchHit>> {
    core.search(&query).map_err(err)
}

// ---- agents ------------------------------------------------------------------

#[tauri::command]
pub async fn create_agent(core: State<'_, Core>, req: CreateAgentRequest) -> CmdResult<Agent> {
    let project = req.project_path.clone();
    let agent = core.create_agent(req).await.map_err(err)?;
    if let Err(e) = remember_project(&core, &project) {
        warn!("could not update recent projects: {e:#}");
    }
    Ok(agent)
}

fn remember_project(core: &Core, project: &str) -> anyhow::Result<()> {
    let mut settings = core.settings()?;
    settings.recent_projects.retain(|p| p != project);
    settings.recent_projects.insert(0, project.to_string());
    settings.recent_projects.truncate(MAX_RECENT_PROJECTS);
    core.save_settings(settings)?;
    Ok(())
}

#[tauri::command]
pub async fn send_prompt(
    core: State<'_, Core>,
    agent_id: String,
    text: String,
    attachments: Option<Vec<Attachment>>,
) -> CmdResult<()> {
    core.send_prompt(&agent_id, &text, attachments.unwrap_or_default())
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn cancel_turn(core: State<'_, Core>, agent_id: String) -> CmdResult<()> {
    core.cancel_turn(&agent_id).await.map_err(err)
}

#[tauri::command]
pub async fn respond_permission(
    core: State<'_, Core>,
    agent_id: String,
    request_id: String,
    option_id: String,
) -> CmdResult<()> {
    core.respond_permission(&agent_id, &request_id, &option_id)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn resume_agent(
    core: State<'_, Core>,
    agent_id: String,
    auto_continue: bool,
) -> CmdResult<()> {
    core.resume_agent(&agent_id, auto_continue)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn stop_agent(core: State<'_, Core>, agent_id: String) -> CmdResult<()> {
    core.stop_agent(&agent_id).await.map_err(err)
}

#[tauri::command]
pub async fn delete_agent(
    core: State<'_, Core>,
    agent_id: String,
    remove_worktree: bool,
) -> CmdResult<()> {
    core.delete_agent(&agent_id, remove_worktree)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn rename_agent(core: State<'_, Core>, agent_id: String, title: String) -> CmdResult<()> {
    core.rename_agent(&agent_id, &title).map_err(err)
}

#[tauri::command]
pub async fn archive_agent(
    core: State<'_, Core>,
    agent_id: String,
    archived: bool,
) -> CmdResult<()> {
    core.archive_agent(&agent_id, archived).map_err(err)
}

#[tauri::command]
pub async fn mark_read(core: State<'_, Core>, agent_id: String) -> CmdResult<()> {
    core.mark_read(&agent_id).map_err(err)
}

#[tauri::command]
pub async fn set_agent_config(
    core: State<'_, Core>,
    agent_id: String,
    option_id: String,
    value: String,
) -> CmdResult<()> {
    core.set_agent_config(&agent_id, &option_id, &value)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn handoff_agent(
    core: State<'_, Core>,
    agent_id: String,
    provider: Provider,
    account_id: String,
    instruction: String,
    custom_agent_id: Option<String>,
) -> CmdResult<Agent> {
    core.handoff_agent(
        &agent_id,
        provider,
        &account_id,
        &instruction,
        custom_agent_id.as_deref(),
    )
    .await
    .map_err(err)
}

#[tauri::command]
pub async fn set_focus(
    attention: State<'_, Arc<Attention>>,
    agent_id: Option<String>,
) -> CmdResult<()> {
    attention.set_focus(agent_id);
    Ok(())
}

// ---- review / git ------------------------------------------------------------

#[tauri::command]
pub async fn get_diff(core: State<'_, Core>, agent_id: String) -> CmdResult<AgentDiff> {
    let agent = core.agent(&agent_id).map_err(err)?;
    git_review::get_diff(&agent).await.map_err(err)
}

#[tauri::command]
pub async fn commit_agent(
    core: State<'_, Core>,
    agent_id: String,
    message: String,
) -> CmdResult<String> {
    let agent = core.agent(&agent_id).map_err(err)?;
    let touched = if agent.worktree {
        Vec::new()
    } else {
        core.touched_files(&agent_id)
    };
    git_review::commit(&agent, &message, &touched)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn merge_agent(core: State<'_, Core>, agent_id: String) -> CmdResult<String> {
    let agent = core.agent(&agent_id).map_err(err)?;
    git_review::merge(&agent).await.map_err(err)
}

#[tauri::command]
pub async fn create_pr(
    core: State<'_, Core>,
    agent_id: String,
    title: String,
    body: String,
) -> CmdResult<String> {
    let agent = core.agent(&agent_id).map_err(err)?;
    git_review::create_pr(&agent, &title, &body)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn discard_worktree(core: State<'_, Core>, agent_id: String) -> CmdResult<()> {
    core.delete_agent(&agent_id, true).await.map_err(err)
}

// ---- accounts ----------------------------------------------------------------

#[tauri::command]
pub async fn create_account(
    core: State<'_, Core>,
    req: CreateAccountRequest,
) -> CmdResult<Account> {
    core.create_account(req).await.map_err(err)
}

#[tauri::command]
pub async fn update_account(
    core: State<'_, Core>,
    account_id: String,
    name: String,
    color: String,
) -> CmdResult<Account> {
    core.update_account(&account_id, &name, &color).map_err(err)
}

#[tauri::command]
pub async fn delete_account(core: State<'_, Core>, account_id: String) -> CmdResult<()> {
    core.delete_account(&account_id).map_err(err)
}

#[tauri::command]
pub async fn check_account(core: State<'_, Core>, account_id: String) -> CmdResult<Account> {
    core.check_account(&account_id).await.map_err(err)
}

/// Runs the provider's own login flow in a PTY under the account's profile.
#[tauri::command]
pub async fn login_account(
    core: State<'_, Core>,
    terminals: State<'_, Terminals>,
    account_id: String,
) -> CmdResult<String> {
    let account = core.account(&account_id).map_err(err)?;
    if let Some(dir) = account.config_dir.as_deref().filter(|_| !account.is_system) {
        std::fs::create_dir_all(dir).map_err(|e| format!("creating {dir}: {e}"))?;
    }
    let (program, args) = accounts::login_command(account.provider).ok_or_else(|| {
        "Custom agents handle sign-in themselves; see the agent's own documentation.".to_string()
    })?;
    let exe = which::which(&program).map_err(|_| {
        format!(
            "{} is not installed (could not find `{program}` on PATH). Install it from Settings → Providers.",
            account.provider.display_name()
        )
    })?;
    let spec = SpawnSpec {
        program: exe.into_os_string(),
        args: args.into_iter().map(Into::into).collect(),
        env: accounts::account_env(&account),
        cwd: None,
    };
    let core2 = core.inner().clone();
    terminals
        .spawn(core.inner().clone(), spec, move |code| {
            info!(account = %account_id, ?code, "login terminal exited");
            tauri::async_runtime::spawn(async move {
                // Emits account_updated with the fresh status.
                if let Err(e) = core2.check_account(&account_id).await {
                    warn!(account = %account_id, "status check after login failed: {e:#}");
                }
            });
        })
        .map_err(err)
}

// ---- providers ---------------------------------------------------------------

#[tauri::command]
pub async fn detect_providers(
    core: State<'_, Core>,
    shell: State<'_, Shell>,
) -> CmdResult<Vec<ProviderInfo>> {
    let providers = shell.refresh_providers().await;
    core.emit(ArmadaEvent::ProvidersChanged {
        providers: providers.clone(),
    });
    Ok(providers)
}

/// One-click install: provisions Node.js if needed (verified download into the
/// app's data dir), npm-installs the agent CLI/adapter and checks it runs.
#[tauri::command]
pub async fn install_provider(
    app: AppHandle,
    core: State<'_, Core>,
    shell: State<'_, Shell>,
    terminals: State<'_, Terminals>,
    provider: Provider,
) -> CmdResult<String> {
    info!(provider = provider.as_str(), "installing provider");
    let data_dir = shell.data_dir.clone();
    Ok(terminals.spawn_task(
        core.inner().clone(),
        move |log| async move { toolchain::install(provider, &data_dir, log).await },
        move |code| after_install(app, code),
    ))
}

/// Installs everything that's missing for all providers.
#[tauri::command]
pub async fn install_missing(
    app: AppHandle,
    core: State<'_, Core>,
    shell: State<'_, Shell>,
    terminals: State<'_, Terminals>,
) -> CmdResult<String> {
    let data_dir = shell.data_dir.clone();
    Ok(terminals.spawn_task(
        core.inner().clone(),
        move |log| async move { toolchain::install_missing(&data_dir, log).await },
        move |code| after_install(app, code),
    ))
}

fn after_install(app: AppHandle, code: Option<i32>) {
    info!(?code, "install finished");
    tauri::async_runtime::spawn(async move {
        let providers = app.state::<Shell>().refresh_providers().await;
        app.state::<Core>()
            .emit(ArmadaEvent::ProvidersChanged { providers });
    });
}

// ---- terminals -----------------------------------------------------------------

#[tauri::command]
pub async fn terminal_write(
    terminals: State<'_, Terminals>,
    terminal_id: String,
    data: String,
) -> CmdResult<()> {
    terminals.write(&terminal_id, &data).map_err(err)
}

#[tauri::command]
pub async fn terminal_resize(
    terminals: State<'_, Terminals>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    terminals.resize(&terminal_id, cols, rows).map_err(err)
}

#[tauri::command]
pub async fn terminal_kill(
    core: State<'_, Core>,
    terminals: State<'_, Terminals>,
    terminal_id: String,
) -> CmdResult<()> {
    terminals.kill(&core, &terminal_id).map_err(err)
}

// ---- settings & attention ------------------------------------------------------

#[tauri::command]
pub async fn update_settings(
    app: AppHandle,
    core: State<'_, Core>,
    mut settings: Settings,
) -> CmdResult<Settings> {
    let previous = core.settings().ok();
    // The backend maintains recent projects (create_agent); a UI holding an older copy
    // of the settings must not roll that list back.
    if let Some(prev) = &previous {
        settings.recent_projects = prev.recent_projects.clone();
    }
    let saved = core.save_settings(settings).map_err(err)?;
    if previous.as_ref().map(|p| p.launch_at_login) != Some(saved.launch_at_login) {
        crate::apply_autostart(&app, saved.launch_at_login);
    }
    // No-op when unchanged; retries a previously failed registration otherwise.
    crate::hotkey::apply(&app, &saved.global_hotkey);
    app.state::<Arc<Remote>>().apply(&saved.remote).await;
    Ok(saved)
}

#[tauri::command]
pub async fn preview_sound(
    attention: State<'_, Arc<Attention>>,
    reason: AttentionReason,
) -> CmdResult<()> {
    let attention = attention.inner().clone();
    tauri::async_runtime::spawn_blocking(move || attention.preview(reason))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_notification(attention: State<'_, Arc<Attention>>) -> CmdResult<()> {
    attention.test_notification();
    Ok(())
}

/// Opens a web link in the browser, opens a folder in the file manager, or reveals a
/// file in its folder. Files are never launched: a path coming from agent output must
/// not be able to run a program or script.
#[tauri::command]
pub async fn open_path(app: AppHandle, path: String) -> CmdResult<()> {
    let target = path.trim();
    if let Some(url) = external_url(target)? {
        return app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| e.to_string());
    }
    let p = Path::new(target);
    if !p.is_absolute() {
        return Err(format!(
            "Can't open {target}: not a web link or an absolute path"
        ));
    }
    if is_remote_share(p) {
        // Even stat-ing \\host\share makes Windows authenticate to that host.
        return Err(format!(
            "Can't open {target}: network locations aren't opened"
        ));
    }
    let meta = std::fs::metadata(p).map_err(|_| format!("{target} does not exist"))?;
    if meta.is_dir() {
        app.opener()
            .open_path(target, None::<&str>)
            .map_err(|e| e.to_string())
    } else if meta.is_file() {
        app.opener()
            .reveal_item_in_dir(p)
            .map_err(|e| e.to_string())
    } else {
        Err(format!("Can't open {target}: not a file or folder"))
    }
}

/// Windows UNC / device paths other than local WSL distributions.
fn is_remote_share(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    match path.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(_) | Prefix::VerbatimDisk(_) => false,
            Prefix::UNC(server, _) | Prefix::VerbatimUNC(server, _) => {
                !server.to_str().is_some_and(|s| {
                    s.eq_ignore_ascii_case("wsl$") || s.eq_ignore_ascii_case("wsl.localhost")
                })
            }
            Prefix::Verbatim(_) | Prefix::DeviceNS(_) => true,
        },
        _ => false,
    }
}

/// `Ok(Some(url))` for links handed to the OS: http(s), and mailto with only the
/// address/subject/body/cc/bcc (some mail clients honour `attach=<local file>`).
/// `Ok(None)` when `target` isn't a URL at all; `Err` for any other URL scheme.
fn external_url(target: &str) -> CmdResult<Option<String>> {
    // Windows drive paths ("C:\x") parse as URLs with a one-letter scheme.
    let looks_like_url = target.split_once(':').is_some_and(|(scheme, _)| {
        scheme.len() > 1
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    });
    if !looks_like_url {
        return Ok(None);
    }
    let mut url = tauri::Url::parse(target).map_err(|e| format!("Invalid link {target}: {e}"))?;
    match url.scheme() {
        "http" | "https" => Ok(Some(url.into())),
        "mailto" => {
            const ALLOWED: [&str; 5] = ["to", "cc", "bcc", "subject", "body"];
            let kept: Vec<(String, String)> = url
                .query_pairs()
                .filter(|(k, _)| ALLOWED.iter().any(|a| k.eq_ignore_ascii_case(a)))
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            url.set_query(None);
            if !kept.is_empty() {
                url.query_pairs_mut().extend_pairs(kept);
            }
            Ok(Some(url.into()))
        }
        other => Err(format!("Links of type {other}: can't be opened")),
    }
}

// ---- updates -------------------------------------------------------------------

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> CmdResult<Option<UpdateInfo>> {
    crate::updater::check(&app).await.map_err(err)
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> CmdResult<()> {
    crate::updater::install(&app).await.map_err(err)
}

// ---- accounts failover, export, schedules --------------------------------------

#[tauri::command]
pub async fn switch_account(
    core: State<'_, Core>,
    agent_id: String,
    account_id: String,
) -> CmdResult<Agent> {
    core.switch_account(&agent_id, &account_id)
        .await
        .map_err(err)
}

/// Asks where to save (native dialog, shown by the backend so the webview never picks
/// a write target), then writes the transcript: JSON for `.json`, else Markdown.
/// Returns the saved path, or `None` if the user cancelled.
#[tauri::command]
pub async fn export_agent(
    app: AppHandle,
    core: State<'_, Core>,
    agent_id: String,
) -> CmdResult<Option<String>> {
    let agent = core.agent(&agent_id).map_err(err)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Export conversation")
        .set_file_name(format!("{}.md", export_file_stem(&agent.title)))
        .add_filter("Markdown", &["md"])
        .add_filter("JSON", &["json"]);
    if let Some(window) = crate::window::main_window(&app) {
        dialog = dialog.set_parent(&window);
    }
    // Callback API: the dialog runs on the main thread without blocking any worker.
    dialog.save_file(move |picked| {
        let _ = tx.send(picked);
    });
    let Some(picked) = rx
        .await
        .map_err(|_| "The save dialog closed unexpectedly".to_string())?
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let path_str = path
        .to_str()
        .ok_or_else(|| format!("Unsupported file name: {}", path.display()))?
        .to_string();
    core.export_agent(&agent_id, &path_str).map_err(err)?;
    Ok(Some(path_str))
}

/// A file name stem from an agent title that's valid on every OS.
fn export_file_stem(title: &str) -> String {
    const MAX_CHARS: usize = 80;
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let stem: String = collapsed.chars().take(MAX_CHARS).collect();
    let stem = stem.trim_matches(|c: char| c == '.' || c == ' ' || c == '-');
    // Windows reserves device names regardless of extension.
    let reserved = {
        let upper = stem.to_ascii_uppercase();
        matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((upper.starts_with("COM") || upper.starts_with("LPT"))
                && upper.len() == 4
                && upper.as_bytes()[3].is_ascii_digit())
    };
    if stem.is_empty() || reserved {
        "conversation".to_string()
    } else {
        stem.to_string()
    }
}

#[tauri::command]
pub async fn list_schedules(core: State<'_, Core>) -> CmdResult<Vec<Schedule>> {
    core.schedules().map_err(err)
}

#[tauri::command]
pub async fn save_schedule(core: State<'_, Core>, schedule: Schedule) -> CmdResult<Schedule> {
    core.save_schedule(schedule).map_err(err)
}

#[tauri::command]
pub async fn delete_schedule(core: State<'_, Core>, schedule_id: String) -> CmdResult<()> {
    core.delete_schedule(&schedule_id).map_err(err)
}

#[tauri::command]
pub async fn run_schedule(core: State<'_, Core>, schedule_id: String) -> CmdResult<Agent> {
    core.run_schedule(&schedule_id).await.map_err(err)
}

// ---- custom agents & files ----------------------------------------------------------

/// Launches a custom agent definition and completes the ACP handshake.
#[tauri::command]
pub async fn test_custom_agent(core: State<'_, Core>, agent: CustomAgent) -> CmdResult<String> {
    core.test_custom_agent(agent).await.map_err(err)
}

/// Project files for @-mentions, fuzzy-matched against `query`.
#[tauri::command]
pub async fn list_files(
    core: State<'_, Core>,
    agent_id: String,
    query: String,
) -> CmdResult<Vec<String>> {
    core.list_files(&agent_id, &query).await.map_err(err)
}

// ---- remote control / mobile companion ---------------------------------------------

#[tauri::command]
pub async fn remote_status(remote: State<'_, Arc<Remote>>) -> CmdResult<RemoteStatus> {
    Ok(remote.status())
}

/// Unpairs every phone/tablet by issuing a new pairing token.
#[tauri::command]
pub async fn remote_rotate_token(remote: State<'_, Arc<Remote>>) -> CmdResult<RemoteStatus> {
    remote.rotate_owner_token();
    Ok(remote.status())
}

/// Read-only live link to one agent, for teammates.
#[tauri::command]
pub async fn create_share_link(
    remote: State<'_, Arc<Remote>>,
    agent_id: String,
) -> CmdResult<ShareLink> {
    remote.create_share(&agent_id).map_err(err)
}

#[tauri::command]
pub async fn revoke_share_link(remote: State<'_, Arc<Remote>>, token: String) -> CmdResult<()> {
    remote.revoke_share(&token);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_urls() {
        assert_eq!(
            external_url("https://example.com/a?b=1")
                .unwrap()
                .as_deref(),
            Some("https://example.com/a?b=1")
        );
        assert!(external_url("http://localhost:8080").unwrap().is_some());
        // mailto keeps safe fields and drops attachments.
        let mail = external_url("mailto:a@b.c?subject=Hi&attach=/etc/passwd&body=x")
            .unwrap()
            .unwrap();
        assert!(mail.starts_with("mailto:a@b.c?"), "{mail}");
        assert!(
            mail.contains("subject=Hi") && mail.contains("body=x"),
            "{mail}"
        );
        assert!(!mail.contains("attach"), "{mail}");
        // Other schemes are refused.
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "smb://host/share",
            "ms-msdt:/id",
            "vscode://x",
        ] {
            assert!(external_url(bad).is_err(), "{bad}");
        }
        // Paths aren't URLs.
        assert_eq!(external_url("/home/me/project").unwrap(), None);
        assert_eq!(external_url("C:\\Users\\me").unwrap(), None);
        assert_eq!(external_url("relative/path").unwrap(), None);
    }

    #[test]
    fn export_file_stems() {
        assert_eq!(export_file_stem("Fix auth bug"), "Fix auth bug");
        assert_eq!(export_file_stem("a/b\\c: d?*"), "a-b-c- d");
        assert_eq!(export_file_stem("  ..hidden..  "), "hidden");
        assert_eq!(export_file_stem("line\nbreak\ttab"), "line break tab");
        assert_eq!(export_file_stem(""), "conversation");
        assert_eq!(export_file_stem("///"), "conversation");
        assert_eq!(export_file_stem("con"), "conversation");
        assert_eq!(export_file_stem("COM1"), "conversation");
        assert_eq!(export_file_stem("Compute"), "Compute");
        assert_eq!(export_file_stem(&"x".repeat(200)).chars().count(), 80);
    }
}
