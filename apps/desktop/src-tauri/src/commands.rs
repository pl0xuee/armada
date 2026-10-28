//! Tauri commands. Names and argument names mirror apps/desktop/src/lib/api.ts.

use std::path::Path;
use std::sync::Arc;

use armada_core::{
    accounts, toolchain, Account, Agent, AgentStatus, ArmadaEvent, Attachment, AttentionReason,
    Core, CreateAccountRequest, CreateAgentRequest, CustomAgent, McpServer, Provider, ProviderInfo,
    Schedule, SearchHit, Settings, TimelineItem, UpdateInfo,
};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tracing::{info, warn};

use crate::attention::Attention;
use crate::git_review::{self, AgentDiff, CommitSummary};
use crate::pr_status::{self, PrCache, PrStatus};
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

/// Most items returned per page.
const MAX_PAGE: usize = 2000;

/// An agent's timeline: everything, or with `limit`, the last `limit` items before
/// `before_seq` (oldest first) for tail-first loading.
#[tauri::command]
pub async fn list_items(
    core: State<'_, Core>,
    agent_id: String,
    before_seq: Option<i64>,
    limit: Option<usize>,
) -> CmdResult<Vec<TimelineItem>> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || match limit {
        Some(limit) => core.items_page(&agent_id, before_seq, limit.clamp(1, MAX_PAGE)),
        None => core.items(&agent_id),
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(err)
}

#[tauri::command]
pub async fn search(core: State<'_, Core>, query: String) -> CmdResult<Vec<SearchHit>> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.search(&query))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
}

// ---- agents ------------------------------------------------------------------

#[tauri::command]
pub async fn create_agent(core: State<'_, Core>, req: CreateAgentRequest) -> CmdResult<Agent> {
    let agent = core.create_agent(req).await.map_err(err)?;
    // The agent's path: `~` already expanded.
    if let Err(e) = remember_project(&core, &agent.project_path) {
        warn!("could not update recent projects: {e:#}");
    }
    Ok(agent)
}

pub(crate) fn remember_project(core: &Core, project: &str) -> anyhow::Result<()> {
    // One locked read-modify-write, so a concurrent settings save can't drop it.
    core.update_settings(|settings| {
        settings.recent_projects.retain(|p| p != project);
        settings.recent_projects.insert(0, project.to_string());
        settings.recent_projects.truncate(MAX_RECENT_PROJECTS);
    })?;
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
pub async fn remove_queued(
    core: State<'_, Core>,
    agent_id: String,
    queued_id: String,
) -> CmdResult<Option<armada_core::RemovedPrompt>> {
    core.remove_queued(&agent_id, &queued_id).map_err(err)
}

#[tauri::command]
pub async fn send_queued_now(
    core: State<'_, Core>,
    agent_id: String,
    queued_id: String,
) -> CmdResult<()> {
    core.send_queued_now(&agent_id, &queued_id)
        .await
        .map_err(err)
}

/// Unpauses the queue and runs its next message if the agent is idle.
#[tauri::command]
pub async fn resume_queue(core: State<'_, Core>, agent_id: String) -> CmdResult<()> {
    core.resume_queue(&agent_id).await.map_err(err)
}

/// Drops every queued message; returns how many were removed.
#[tauri::command]
pub async fn clear_queue(core: State<'_, Core>, agent_id: String) -> CmdResult<usize> {
    core.clear_queue(&agent_id).map_err(err)
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
/// With `remove_worktree`, fails with an error starting with "Unsaved work:" when
/// the worktree has uncommitted changes or unmerged commits; pass `force: true`
/// ("Delete anyway") to discard them.
pub async fn delete_agent(
    core: State<'_, Core>,
    agent_id: String,
    remove_worktree: bool,
    force: Option<bool>,
) -> CmdResult<()> {
    core.delete_agent(&agent_id, remove_worktree, force.unwrap_or(false))
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

#[tauri::command]
pub async fn chime_watched(attention: State<'_, Arc<Attention>>) -> CmdResult<()> {
    attention.chime_watched();
    Ok(())
}

/// Sets the main window's title (taskbar, alt-tab, tiling-WM bars).
#[tauri::command]
pub async fn set_window_title(app: tauri::AppHandle, title: String) -> CmdResult<()> {
    let title: String = title.chars().take(200).collect();
    if let Some(w) = crate::window::main_window(&app) {
        w.set_title(&title).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---- review / git ------------------------------------------------------------

#[tauri::command]
pub async fn get_diff(core: State<'_, Core>, agent_id: String) -> CmdResult<AgentDiff> {
    let agent = core.agent(&agent_id).map_err(err)?;
    git_review::get_diff(&agent).await.map_err(err)
}

// ---- checkpoints -------------------------------------------------------------

#[tauri::command]
pub async fn list_checkpoints(
    core: State<'_, Core>,
    agent_id: String,
) -> CmdResult<armada_core::checkpoints::CheckpointList> {
    core.list_checkpoints(&agent_id).await.map_err(err)
}

#[tauri::command]
pub async fn preview_checkpoint(
    core: State<'_, Core>,
    agent_id: String,
    checkpoint_id: String,
) -> CmdResult<armada_core::checkpoints::RestorePreview> {
    core.preview_checkpoint(&agent_id, &checkpoint_id)
        .await
        .map_err(err)
}

/// Restores the agent's files to a checkpoint. Also used to undo a restore (restore
/// the `safety_id` it returned).
#[tauri::command]
pub async fn restore_checkpoint(
    core: State<'_, Core>,
    agent_id: String,
    checkpoint_id: String,
) -> CmdResult<armada_core::checkpoints::RestoreResult> {
    let (_guard, _agent) = lock_idle_agent(&core, &agent_id, "restoring its files").map_err(err)?;
    core.restore_checkpoint(&agent_id, &checkpoint_id)
        .await
        .map_err(err)
}

/// Refuses to change the agent's files or branch while its turn is running: it may be
/// writing files at that very moment (or resume as soon as an approval is answered).
fn ensure_not_working(agent: &Agent, doing: &str) -> anyhow::Result<()> {
    match agent.status {
        AgentStatus::Working | AgentStatus::NeedsPermission => {
            anyhow::bail!("The agent is still working; stop it or wait before {doing}")
        }
        _ => Ok(()),
    }
}

/// Takes the agent's git lock, then reads the agent (so the status check sees the
/// state after any operation that held the lock) and checks it isn't mid-turn.
fn lock_idle_agent(
    core: &Core,
    agent_id: &str,
    doing: &str,
) -> anyhow::Result<(tokio::sync::OwnedMutexGuard<()>, Agent)> {
    let guard = git_review::try_lock_agent(agent_id)?;
    let agent = core.agent(agent_id)?;
    ensure_not_working(&agent, doing)?;
    Ok((guard, agent))
}

/// Commit for the desktop and the phone remote. Fails with
/// [`git_review::NothingToCommit`] when there's nothing to take.
pub(crate) async fn commit_impl(
    core: &Core,
    agent_id: &str,
    message: &str,
) -> anyhow::Result<CommitSummary> {
    commit_excluding_impl(core, agent_id, message, &[]).await
}

/// [`commit_impl`], leaving `exclude` (repository-relative paths) out of the commit.
pub(crate) async fn commit_excluding_impl(
    core: &Core,
    agent_id: &str,
    message: &str,
    exclude: &[String],
) -> anyhow::Result<CommitSummary> {
    let (_guard, agent) = lock_idle_agent(core, agent_id, "committing")?;
    let touched = if agent.worktree {
        Vec::new()
    } else {
        core.touched_files(agent_id)
    };
    git_review::commit_excluding(&agent, message, &touched, exclude).await
}

/// New files a commit would add whose names look like secrets (`.env`, `*.pem`, …),
/// so the UI can ask before committing them.
#[tauri::command]
pub async fn secret_looking_files(
    core: State<'_, Core>,
    agent_id: String,
) -> CmdResult<Vec<String>> {
    let agent = core.agent(&agent_id).map_err(err)?;
    let touched = if agent.worktree {
        Vec::new()
    } else {
        core.touched_files(&agent_id)
    };
    git_review::pending_secret_files(&agent, &touched)
        .await
        .map_err(err)
}

/// Outcome of "Commit & merge". `Err` from [`ship_impl`] means nothing changed; `Ok`
/// with `error` set means the commit landed but the merge didn't.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipResult {
    /// Short hash of the commit made first, if there was anything to commit.
    pub committed: Option<String>,
    /// The merge's summary ("Merged x into main: 3 files changed…" or "Nothing to
    /// merge: …"), if the merge ran.
    pub merged: Option<String>,
    /// Set when the commit succeeded but the merge failed:
    /// "Committed <hash> on <branch>, but the merge failed: …".
    pub error: Option<String>,
}

/// "Commit & merge" for the desktop and the phone remote: commits what's left in the
/// agent's worktree (if anything), then merges its branch into the base branch.
pub(crate) async fn ship_impl(
    core: &Core,
    agent_id: &str,
    message: &str,
) -> anyhow::Result<ShipResult> {
    ship_excluding_impl(core, agent_id, message, &[]).await
}

pub(crate) async fn ship_excluding_impl(
    core: &Core,
    agent_id: &str,
    message: &str,
    exclude: &[String],
) -> anyhow::Result<ShipResult> {
    let (_guard, agent) = lock_idle_agent(core, agent_id, "committing")?;
    if !agent.worktree {
        anyhow::bail!("Only agents running in their own worktree branch can be merged");
    }
    // Everything that would stop the merge, checked before committing anything.
    git_review::merge_preflight(&agent).await?;
    let message = if message.trim().is_empty() {
        agent.title.as_str()
    } else {
        message
    };
    let committed = match git_review::commit_excluding(&agent, message, &[], exclude).await {
        Ok(summary) => Some(summary.hash),
        Err(e) if e.is::<git_review::NothingToCommit>() => None,
        Err(e) => return Err(e),
    };
    match git_review::merge(&agent).await {
        Ok(merged) => Ok(ShipResult {
            committed,
            merged: Some(merged),
            error: None,
        }),
        Err(e) => match committed {
            Some(hash) => Ok(ShipResult {
                error: Some(format!(
                    "Committed {hash} on {}, but the merge failed: {e:#}",
                    agent.branch.as_deref().unwrap_or("the agent's branch")
                )),
                committed: Some(hash),
                merged: None,
            }),
            None => Err(e),
        },
    }
}

/// Returns a [`CommitSummary`] (`{hash, files, leftUncommitted, skipped, message}`).
#[tauri::command]
pub async fn commit_agent(
    core: State<'_, Core>,
    agent_id: String,
    message: String,
    exclude: Option<Vec<String>>,
) -> CmdResult<CommitSummary> {
    commit_excluding_impl(&core, &agent_id, &message, &exclude.unwrap_or_default())
        .await
        .map_err(err)
}

/// Merge for the desktop and the phone remote (same lock and checks as commit).
pub(crate) async fn merge_impl(core: &Core, agent_id: &str) -> anyhow::Result<String> {
    let (_guard, agent) = lock_idle_agent(core, agent_id, "merging")?;
    git_review::merge(&agent).await
}

#[tauri::command]
pub async fn merge_agent(core: State<'_, Core>, agent_id: String) -> CmdResult<String> {
    merge_impl(&core, &agent_id).await.map_err(err)
}

/// "Commit & merge". See [`ShipResult`] for the partial-failure contract.
#[tauri::command]
pub async fn ship_agent(
    core: State<'_, Core>,
    agent_id: String,
    message: String,
    exclude: Option<Vec<String>>,
) -> CmdResult<ShipResult> {
    ship_excluding_impl(&core, &agent_id, &message, &exclude.unwrap_or_default())
        .await
        .map_err(err)
}

/// Revert for the desktop and the phone remote (same lock and checks as commit).
pub(crate) async fn revert_impl(core: &Core, agent_id: &str, patch: &str) -> anyhow::Result<()> {
    let (_guard, agent) = lock_idle_agent(core, agent_id, "reverting changes")?;
    git_review::revert_patch(&agent, patch).await
}

/// Reverts a file's or a hunk's changes (a slice of the agent's diff patch).
#[tauri::command]
pub async fn revert_patch(core: State<'_, Core>, agent_id: String, patch: String) -> CmdResult<()> {
    revert_impl(&core, &agent_id, &patch).await.map_err(err)
}

#[tauri::command]
pub async fn acknowledge_agent(core: State<'_, Core>, agent_id: String) -> CmdResult<()> {
    core.acknowledge_agent(&agent_id).map_err(err)
}

#[tauri::command]
pub async fn update_account_key(
    core: State<'_, Core>,
    account_id: String,
    api_key: String,
) -> CmdResult<Account> {
    core.update_account_key(&account_id, &api_key)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn test_mcp_server(core: State<'_, Core>, server: McpServer) -> CmdResult<String> {
    core.test_mcp_server(server).await.map_err(err)
}

#[tauri::command]
pub async fn discover_projects(core: State<'_, Core>) -> CmdResult<Vec<String>> {
    core.discover_projects().await.map_err(err)
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

/// PR + CI status for the agent's branch. Quiet by design: problems come back as
/// `state: "unknown"`, not as errors. Cached per agent (see `pr_status::PrCache`).
#[tauri::command]
pub async fn pr_status(
    core: State<'_, Core>,
    cache: State<'_, PrCache>,
    agent_id: String,
    force: Option<bool>,
) -> CmdResult<PrStatus> {
    let agent = core.agent(&agent_id).map_err(err)?;
    Ok(cache.status(&agent, force.unwrap_or(false)).await)
}

/// The editable "Fix CI" prompt (failing checks + trimmed logs).
#[tauri::command]
pub async fn pr_fix_ci_prompt(
    core: State<'_, Core>,
    cache: State<'_, PrCache>,
    agent_id: String,
) -> CmdResult<pr_status::PrPrompt> {
    let agent = core.agent(&agent_id).map_err(err)?;
    pr_status::build_fix_ci_prompt(&cache, &agent)
        .await
        .map_err(err)
}

/// The editable "Address review comments" prompt.
#[tauri::command]
pub async fn pr_review_prompt(
    core: State<'_, Core>,
    cache: State<'_, PrCache>,
    agent_id: String,
    include_outside: Option<bool>,
) -> CmdResult<pr_status::PrPrompt> {
    let agent = core.agent(&agent_id).map_err(err)?;
    pr_status::build_review_prompt(&cache, &agent, include_outside.unwrap_or(false))
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn discard_worktree(core: State<'_, Core>, agent_id: String) -> CmdResult<()> {
    // The user confirmed discarding uncommitted and unmerged changes.
    core.delete_agent(&agent_id, true, true).await.map_err(err)
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

/// Runs the provider's own login flow in a PTY under the account's profile. While one
/// is still running for this account, returns that terminal's id instead of starting
/// a second login (double clicks, or the dialog reopened).
#[tauri::command]
pub async fn login_account(
    core: State<'_, Core>,
    terminals: State<'_, Terminals>,
    account_id: String,
) -> CmdResult<LoginTerminal> {
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
        // The user's own exported provider keys must not leak into this account's login.
        env_remove: accounts::env_to_remove(&account),
        env: accounts::account_env(&account),
        cwd: None,
    };
    let core2 = core.inner().clone();
    let key = format!("login:{account_id}");
    terminals
        .spawn_unique(&key, core.inner().clone(), spec, move |code| {
            info!(account = %account_id, ?code, "login terminal exited");
            tauri::async_runtime::spawn(async move {
                // Emits account_updated with the fresh status.
                if let Err(e) = core2.check_account(&account_id).await {
                    warn!(account = %account_id, "status check after login failed: {e:#}");
                }
            });
        })
        .map(|(terminal_id, reused)| LoginTerminal {
            terminal_id,
            reused,
        })
        .map_err(err)
}

/// The sign-in terminal; `reused` when a sign-in for this account was already
/// running (its earlier output isn't replayed).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginTerminal {
    terminal_id: String,
    reused: bool,
}

/// Whether `path` is a folder inside a git work tree (for launch preflight).
#[tauri::command]
pub async fn is_git_repo(path: String) -> CmdResult<bool> {
    let path = armada_core::providers::expand_home(&path);
    Ok(armada_core::git_work_tree(std::path::Path::new(&path)).await)
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

/// Checks the fields Armada acts on blindly. Only changed values are checked, so a
/// value saved before validation existed doesn't block unrelated changes.
fn validate_settings(previous: Option<&Settings>, settings: &Settings) -> CmdResult<()> {
    let quiet = &settings.quiet_hours;
    let quiet_changed = previous.is_none_or(|p| {
        p.quiet_hours.enabled != quiet.enabled
            || p.quiet_hours.start != quiet.start
            || p.quiet_hours.end != quiet.end
    });
    if quiet_changed {
        crate::attention::validate_quiet_hours(quiet)?;
    }
    let url = settings
        .ntfy_url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty());
    let url_changed = previous.is_none_or(|p| p.ntfy_url.as_deref().map(str::trim) != url);
    if let (Some(url), true) = (url, url_changed) {
        crate::attention::validate_ntfy_url(url).map_err(|e| format!("Phone push URL: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn update_settings(
    app: AppHandle,
    core: State<'_, Core>,
    mut settings: Settings,
) -> CmdResult<Settings> {
    let previous = core.settings().ok();
    validate_settings(previous.as_ref(), &settings)?;
    // The backend maintains recent projects (create_agent); a UI holding an older copy
    // of the settings must not roll that list back. Done under the settings lock so
    // a project remembered concurrently isn't lost either.
    let saved = core
        .update_settings(move |current| {
            settings.recent_projects = std::mem::take(&mut current.recent_projects);
            *current = settings;
        })
        .map_err(err)?;
    if previous.as_ref().map(|p| p.launch_at_login) != Some(saved.launch_at_login) {
        crate::apply_autostart(&app, saved.launch_at_login);
    }
    // No-op when unchanged; retries a previously failed registration otherwise.
    let hotkey = crate::hotkey::apply(&app, &saved.global_hotkey);
    app.state::<Arc<Remote>>().apply(&saved.remote).await;
    if let Err(e) = hotkey {
        // Reported when the user just set this hotkey; an unchanged one that still can't
        // be registered (e.g. Wayland) shouldn't fail every later save.
        let changed =
            previous.as_ref().map(|p| p.global_hotkey.trim()) != Some(saved.global_hotkey.trim());
        if changed {
            return Err(format!(
                "Settings saved, but the shortcut \"{}\" couldn't be registered: {e}. It may be invalid or used by another app.",
                saved.global_hotkey.trim()
            ));
        }
    }
    Ok(saved)
}

/// Zooms the whole webview (layout, scrollbars and measurements stay consistent).
#[tauri::command]
pub fn set_interface_zoom(app: AppHandle, percent: u32) -> CmdResult<()> {
    let percent = percent.clamp(
        armada_core::model::MIN_INTERFACE_SCALE,
        armada_core::model::MAX_INTERFACE_SCALE,
    );
    if let Some(w) = crate::window::main_window(&app) {
        w.set_zoom(f64::from(percent) / 100.0)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
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

/// Shows a test notification and, when a phone push (ntfy) URL is configured, or
/// `ntfy_url` is given (to test one before saving it), sends a test push too. Fails
/// with the reason if the push is refused or doesn't go through.
#[tauri::command]
pub async fn test_notification(
    attention: State<'_, Arc<Attention>>,
    ntfy_url: Option<String>,
) -> CmdResult<()> {
    attention.test_notification();
    let attention = attention.inner().clone();
    tauri::async_runtime::spawn_blocking(move || attention.test_push(ntfy_url.as_deref()))
        .await
        .map_err(|e| e.to_string())?
        .map(|_| ())
        .map_err(|e| format!("The notification was shown, but the phone push failed: {e}"))
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
    if meta.is_dir() && !is_bundle(p) {
        app.opener()
            .open_path(target, None::<&str>)
            .map_err(|e| e.to_string())
    } else if meta.is_file() || meta.is_dir() {
        app.opener()
            .reveal_item_in_dir(p)
            .map_err(|e| e.to_string())
    } else {
        Err(format!("Can't open {target}: not a file or folder"))
    }
}

/// macOS bundles are folders that `open` launches or installs (apps, installers,
/// plugins…), so they're revealed instead. Checked on every OS (a project can contain
/// them anywhere, and the check is cheap).
fn is_bundle(path: &Path) -> bool {
    const BUNDLES: [&str; 13] = [
        "app",
        "pkg",
        "mpkg",
        "bundle",
        "framework",
        "plugin",
        "kext",
        "prefpane",
        "workflow",
        "action",
        "saver",
        "qlgenerator",
        "mdimporter",
    ];
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| BUNDLES.iter().any(|b| ext.eq_ignore_ascii_case(b)))
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
    let core = core.inner().clone();
    // Reads the transcript and writes a file: off the async runtime.
    tauri::async_runtime::spawn_blocking(move || export_atomically(&core, &agent_id, &path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)?;
    Ok(Some(path_str))
}

/// Writes the export next to `path` under a temporary name, then renames it over
/// `path`, so an existing file is never left half-written. The temporary name keeps
/// the extension, which picks the format (JSON or Markdown).
fn export_atomically(core: &Core, agent_id: &str, path: &Path) -> anyhow::Result<()> {
    use anyhow::Context;
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "export".into());
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("md")
        .to_string();
    let tmp = dir.join(format!(
        ".{name}.{}.part.{ext}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    let tmp_str = tmp
        .to_str()
        .with_context(|| format!("Unsupported file name: {}", tmp.display()))?;
    let written = core.export_agent(agent_id, tmp_str).and_then(|()| {
        std::fs::rename(&tmp, path).with_context(|| format!("saving {}", path.display()))
    });
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
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
    if stem.is_empty() {
        "conversation".to_string()
    } else if is_reserved_windows_name(stem) {
        format!("_{stem}")
    } else {
        stem.to_string()
    }
}

/// Windows device names (CON, PRN, AUX, NUL, COM1–9, LPT1–9, CONIN$, CONOUT$) are
/// reserved in any case and with any extension ("con.txt", "Nul.tar.gz"): the part
/// before the first dot, ignoring trailing spaces, decides.
fn is_reserved_windows_name(name: &str) -> bool {
    let base = name.split('.').next().unwrap_or("").trim_end();
    let upper = base.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ((upper.starts_with("COM") || upper.starts_with("LPT"))
        && upper.len() == 4
        && matches!(upper.as_bytes()[3], b'1'..=b'9'))
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
    remote.refresh_lan().await;
    Ok(remote.status())
}

/// Unpairs every phone/tablet.
#[tauri::command]
pub async fn remote_rotate_token(remote: State<'_, Arc<Remote>>) -> CmdResult<RemoteStatus> {
    remote.unpair_all();
    Ok(remote.status())
}

/// Unpairs one phone/tablet and ends its live connections.
#[tauri::command]
pub async fn remote_revoke_device(
    remote: State<'_, Arc<Remote>>,
    id: String,
) -> CmdResult<RemoteStatus> {
    remote.revoke_device(&id);
    Ok(remote.status())
}

/// Read-only live link to one agent, for teammates.
#[tauri::command]
pub async fn create_share_link(
    remote: State<'_, Arc<Remote>>,
    agent_id: String,
    hours: Option<u32>,
) -> CmdResult<ShareLink> {
    remote.create_share(&agent_id, hours).map_err(err)
}

#[tauri::command]
pub async fn revoke_share_link(remote: State<'_, Arc<Remote>>, id: String) -> CmdResult<()> {
    remote.revoke_share(&id);
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
    fn bundles_are_revealed_not_opened() {
        for p in [
            "/Applications/Foo.app",
            "/x/Installer.pkg",
            "/x/Thing.bundle",
            "/x/A.framework",
            "/x/P.prefPane",
            "/x/W.workflow",
            "/x/I.mdimporter",
            "/x/UPPER.APP",
        ] {
            assert!(is_bundle(Path::new(p)), "{p}");
        }
        for p in ["/home/me/project", "/x/app", "/x/src.d", "/x/foo.apple"] {
            assert!(!is_bundle(Path::new(p)), "{p}");
        }
    }

    #[test]
    fn export_file_stems() {
        assert_eq!(export_file_stem("Fix auth bug"), "Fix auth bug");
        assert_eq!(export_file_stem("a/b\\c: d?*"), "a-b-c- d");
        assert_eq!(export_file_stem("  ..hidden..  "), "hidden");
        assert_eq!(export_file_stem("line\nbreak\ttab"), "line break tab");
        assert_eq!(export_file_stem(""), "conversation");
        assert_eq!(export_file_stem("///"), "conversation");
        assert_eq!(export_file_stem("con"), "_con");
        assert_eq!(export_file_stem("COM1"), "_COM1");
        assert_eq!(export_file_stem("CON.txt"), "_CON.txt");
        assert_eq!(export_file_stem("nul .tar.gz"), "_nul .tar.gz");
        assert_eq!(export_file_stem("lpt9.notes"), "_lpt9.notes");
        assert_eq!(export_file_stem("COM0"), "COM0");
        assert_eq!(export_file_stem("Compute"), "Compute");
        assert_eq!(export_file_stem("console.log"), "console.log");
        assert_eq!(export_file_stem(&"x".repeat(200)).chars().count(), 80);
    }
}

/// An image an agent referenced (screenshot, render), as base64 for inline display.
#[tauri::command]
pub async fn read_image(
    core: State<'_, Core>,
    agent_id: String,
    path: String,
) -> CmdResult<Attachment> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.read_image(&agent_id, &path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
}
