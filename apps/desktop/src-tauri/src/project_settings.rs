//! Project settings: the instruction files, permission rules, hooks, slash commands and
//! skills Claude Code / Codex already read from a project. The file logic (and its
//! confinement to the project root) lives in `armada_core::project_config`.

use std::path::PathBuf;

use armada_core::project_config::{
    self, InstructionDoc, PermissionRules, ProjectConfig, SettingsFile, SettingsScope,
};
use armada_core::{providers, Core};
use tauri::State;

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

/// The canonical folder of `project`, which must be one Armada already knows (a recent
/// project or an agent's project), so the UI can't point these commands at any folder.
fn known_project(core: &Core, project: &str) -> CmdResult<PathBuf> {
    let wanted = providers::expand_home(project.trim());
    let root = project_config::resolve_root(&wanted).map_err(err)?;
    let mut known = core.settings().map_err(err)?.recent_projects;
    known.extend(
        core.agents()
            .map_err(err)?
            .into_iter()
            .map(|a| a.project_path),
    );
    let is_known = known
        .iter()
        .any(|p| std::fs::canonicalize(providers::expand_home(p)).is_ok_and(|c| c == root));
    if is_known {
        Ok(root)
    } else {
        Err("That folder isn't one of your projects".to_string())
    }
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> CmdResult<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| e.to_string())?
}

/// Everything the project-settings screen shows, in one read.
#[tauri::command]
pub async fn project_config(core: State<'_, Core>, project: String) -> CmdResult<ProjectConfig> {
    let root = known_project(&core, &project)?;
    blocking(move || project_config::load(&root, providers::home_dir().as_deref()).map_err(err))
        .await
}

/// Saves `CLAUDE.md` or `AGENTS.md` at the project root (created if missing).
#[tauri::command]
pub async fn project_save_instruction(
    core: State<'_, Core>,
    project: String,
    file: String,
    content: String,
) -> CmdResult<InstructionDoc> {
    let root = known_project(&core, &project)?;
    blocking(move || project_config::write_instruction(&root, &file, &content).map_err(err)).await
}

/// Replaces the allow / ask / deny lists in `.claude/settings.json` (shared) or
/// `.claude/settings.local.json` (local), keeping every other key in the file.
#[tauri::command]
pub async fn project_save_rules(
    core: State<'_, Core>,
    project: String,
    scope: SettingsScope,
    rules: PermissionRules,
) -> CmdResult<SettingsFile> {
    let root = known_project(&core, &project)?;
    blocking(move || project_config::write_rules(&root, scope, &rules).map_err(err)).await
}
