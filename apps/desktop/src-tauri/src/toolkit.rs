//! "Tools & instructions": safe saving of `CLAUDE.md` / `AGENTS.md` (noticing edits made
//! elsewhere) and the skills Claude Code loads. The file logic, and its confinement to
//! the project root and the known skill folders, lives in `kvistcode_core::project_config`
//! and `kvistcode_core::skills`; MCP servers use the settings and test commands.

use std::path::PathBuf;

use kvistcode_core::project_config::{self, InstructionDoc, InstructionSave};
use kvistcode_core::skills::{self, SkillDoc, SkillInfo};
use kvistcode_core::{providers, Core};
use tauri::State;

use crate::project_settings::{blocking, err, known_project, CmdResult};

/// The project folder when one is given (it must be one of the user's projects).
fn optional_project(core: &Core, project: Option<String>) -> CmdResult<Option<PathBuf>> {
    project
        .filter(|p| !p.trim().is_empty())
        .map(|p| known_project(core, &p))
        .transpose()
}

/// Reads one instruction file fresh from disk (to reload after an outside edit).
#[tauri::command]
pub async fn instructions_read(
    core: State<'_, Core>,
    project: String,
    file: String,
) -> CmdResult<InstructionDoc> {
    let root = known_project(&core, &project)?;
    blocking(move || project_config::read_instruction(&root, &file).map_err(err)).await
}

/// Saves `CLAUDE.md` / `AGENTS.md` unless it changed on disk since `expected_stamp` (the
/// stamp the editor loaded; none = the file didn't exist). On a change nothing is written
/// and the file as it is now comes back, so the editor can offer a reload or an overwrite
/// (`force`).
#[tauri::command]
pub async fn instructions_save(
    core: State<'_, Core>,
    project: String,
    file: String,
    content: String,
    expected_stamp: Option<String>,
    force: bool,
) -> CmdResult<InstructionSave> {
    let root = known_project(&core, &project)?;
    blocking(move || {
        project_config::save_instruction_checked(
            &root,
            &file,
            &content,
            expected_stamp.as_deref(),
            force,
        )
        .map_err(err)
    })
    .await
}

/// Your skills, the project's (when given) and the installed plugins'.
#[tauri::command]
pub async fn skills_list(
    core: State<'_, Core>,
    project: Option<String>,
) -> CmdResult<Vec<SkillInfo>> {
    let root = optional_project(&core, project)?;
    blocking(move || {
        Ok(skills::list(
            root.as_deref(),
            providers::home_dir().as_deref(),
        ))
    })
    .await
}

/// A skill's `SKILL.md`, by the id `skills_list` returned.
#[tauri::command]
pub async fn skills_read(
    core: State<'_, Core>,
    project: Option<String>,
    id: String,
) -> CmdResult<SkillDoc> {
    let root = optional_project(&core, project)?;
    blocking(move || {
        skills::read(root.as_deref(), providers::home_dir().as_deref(), &id).map_err(err)
    })
    .await
}

/// Creates a skill from a template, for you ("user") or for the project ("project").
#[tauri::command]
pub async fn skills_create(
    core: State<'_, Core>,
    project: Option<String>,
    scope: String,
    name: String,
    description: String,
) -> CmdResult<SkillInfo> {
    let root = match scope.as_str() {
        "project" => optional_project(&core, project)?
            .ok_or_else(|| "Choose a project for this skill".to_string())?,
        "user" => {
            providers::home_dir().ok_or_else(|| "Couldn't find your home folder".to_string())?
        }
        _ => return Err("Skills can be created for you or for a project".to_string()),
    };
    blocking(move || skills::create(&root, &scope, &name, &description).map_err(err)).await
}
