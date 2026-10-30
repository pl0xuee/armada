//! Per-project Claude Code / Codex configuration: the instruction files
//! (`CLAUDE.md`, `AGENTS.md`), the permission rules in `.claude/settings*.json`, and
//! read-only listings of hooks, slash commands and skills.
//!
//! Only a fixed set of files under the project root is ever touched. Reads stay inside
//! the root (symlinks that leave it are refused), writes refuse symlinks outright, and
//! every file is size-capped. File contents are never logged.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::Result;

/// Largest file read or written (an instruction file or a settings file).
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// How much of a command / skill file is read to find its description.
const HEADER_BYTES: u64 = 16 * 1024;
const MAX_LISTED: usize = 500;
const MAX_DEPTH: usize = 6;
const MAX_RULES_PER_LIST: usize = 500;
const MAX_RULE_CHARS: usize = 1000;
const MAX_DESCRIPTION_CHARS: usize = 200;

/// Instruction files at the project root that may be read and written.
pub const INSTRUCTION_FILES: [&str; 2] = ["CLAUDE.md", "AGENTS.md"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingsScope {
    /// `.claude/settings.json`: normally committed, shared with the team.
    Shared,
    /// `.claude/settings.local.json`: personal, normally git-ignored.
    Local,
}

impl SettingsScope {
    pub fn file_name(self) -> &'static str {
        match self {
            SettingsScope::Shared => "settings.json",
            SettingsScope::Local => "settings.local.json",
        }
    }
    fn id(self) -> &'static str {
        match self {
            SettingsScope::Shared => "shared",
            SettingsScope::Local => "local",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRules {
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub ask: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
}

impl PermissionRules {
    fn is_empty(&self) -> bool {
        self.allow.is_empty() && self.ask.is_empty() && self.deny.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionDoc {
    pub file: String,
    pub path: String,
    pub exists: bool,
    pub content: String,
    /// Why the file can't be shown or edited (too large, outside the project…).
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookEntry {
    pub event: String,
    pub matcher: Option<String>,
    pub command: String,
    /// "shared" or "local".
    pub scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFile {
    /// "shared" or "local".
    pub scope: String,
    pub path: String,
    pub exists: bool,
    pub rules: PermissionRules,
    pub hooks: Vec<HookEntry>,
    /// Set when the file can't be used (invalid JSON, too large…); rules are then empty
    /// and editing is refused rather than overwriting it.
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEntry {
    pub name: String,
    pub description: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    pub root: String,
    pub instructions: Vec<InstructionDoc>,
    /// `~/.claude/CLAUDE.md`, read-only.
    pub user_instructions: Option<InstructionDoc>,
    pub settings: Vec<SettingsFile>,
    pub commands: Vec<ConfigEntry>,
    pub skills: Vec<ConfigEntry>,
}

// ---- paths -------------------------------------------------------------------

/// The canonical project folder; it must exist and be a directory.
pub fn resolve_root(project: &Path) -> Result<PathBuf> {
    let root = std::fs::canonicalize(project)
        .map_err(|_| anyhow!("The project folder {} no longer exists", project.display()))?;
    if !root.is_dir() {
        bail!("{} is not a folder", project.display());
    }
    Ok(root)
}

fn join(root: &Path, rel: &[&str]) -> PathBuf {
    rel.iter().fold(root.to_path_buf(), |p, c| p.join(c))
}

fn settings_rel(scope: SettingsScope) -> [&'static str; 2] {
    [".claude", scope.file_name()]
}

/// A readable regular file inside `root`, or `None` when it doesn't exist. Symlinks are
/// followed only while the result stays inside the project.
fn existing_file_in(root: &Path, path: &Path) -> Result<Option<PathBuf>> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => bail!("Can't read {}: {e}", file_label(path)),
    }
    let real = std::fs::canonicalize(path)
        .map_err(|_| anyhow!("{} is a broken link", file_label(path)))?;
    if !real.starts_with(root) {
        bail!("{} points outside the project", file_label(path));
    }
    if !real.is_file() {
        bail!("{} is not a regular file", file_label(path));
    }
    Ok(Some(real))
}

/// The path a write may go to: no symlink anywhere between the project root and the
/// file, and an existing target must be a regular file.
fn writable_target(root: &Path, rel: &[&str]) -> Result<PathBuf> {
    let mut cur = root.to_path_buf();
    for (i, part) in rel.iter().enumerate() {
        cur.push(part);
        let last = i + 1 == rel.len();
        match std::fs::symlink_metadata(&cur) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    bail!(
                        "{} is a symbolic link; Armada won't write through it",
                        file_label(&cur)
                    );
                }
                if last && !meta.is_file() {
                    bail!("{} is not a regular file", file_label(&cur));
                }
                if !last && !meta.is_dir() {
                    bail!("{} is not a folder", file_label(&cur));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => bail!("Can't write {}: {e}", file_label(&cur)),
        }
    }
    Ok(cur)
}

fn file_label(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

fn read_capped(path: &Path, cap: u64) -> Result<(String, bool)> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .with_context(|| format!("Can't open {}", file_label(path)))?
        .take(cap + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("Can't read {}", file_label(path)))?;
    let truncated = bytes.len() as u64 > cap;
    bytes.truncate(cap as usize);
    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}

/// Whole-file read; refuses files over the cap and non-UTF-8 text.
fn read_text(path: &Path) -> Result<String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .with_context(|| format!("Can't open {}", file_label(path)))?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("Can't read {}", file_label(path)))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        bail!("{} is larger than 1 MiB", file_label(path));
    }
    String::from_utf8(bytes).map_err(|_| anyhow!("{} isn't valid UTF-8 text", file_label(path)))
}

/// Writes through a temporary file in the same folder, so a crash never leaves a
/// half-written config behind. An existing file keeps its permissions.
fn write_atomic(path: &Path, content: &str) -> Result<()> {
    if content.len() as u64 > MAX_FILE_BYTES {
        bail!("{} would be larger than 1 MiB", file_label(path));
    }
    let dir = path.parent().ok_or_else(|| anyhow!("Invalid path"))?;
    std::fs::create_dir_all(dir).with_context(|| format!("Can't create {}", dir.display()))?;
    let tmp = dir.join(format!(".{}.armada-tmp", file_label(path)));
    let open = || {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
    };
    let mut file = match open() {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = std::fs::remove_file(&tmp);
            open().with_context(|| format!("Can't write {}", file_label(path)))?
        }
        Err(e) => return Err(anyhow!("Can't write {}: {e}", file_label(path))),
    };
    let result = (|| -> std::io::Result<()> {
        use std::io::Write;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        if let Ok(meta) = std::fs::metadata(path) {
            let _ = std::fs::set_permissions(&tmp, meta.permissions());
        }
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        bail!("Can't write {}: {e}", file_label(path));
    }
    Ok(())
}

// ---- instruction files -------------------------------------------------------

fn check_instruction_name(name: &str) -> Result<&'static str> {
    INSTRUCTION_FILES
        .iter()
        .copied()
        .find(|f| *f == name)
        .ok_or_else(|| anyhow!("{name} isn't an editable instruction file"))
}

pub fn read_instruction(root: &Path, name: &str) -> Result<InstructionDoc> {
    let file = check_instruction_name(name)?;
    let path = join(root, &[file]);
    Ok(read_doc(root, file, &path))
}

fn read_doc(root: &Path, file: &str, path: &Path) -> InstructionDoc {
    let mut doc = InstructionDoc {
        file: file.to_string(),
        path: path.to_string_lossy().into_owned(),
        exists: false,
        content: String::new(),
        error: None,
    };
    match existing_file_in(root, path) {
        Ok(None) => {}
        Ok(Some(real)) => {
            doc.exists = true;
            match read_text(&real) {
                Ok(text) => doc.content = text,
                Err(e) => doc.error = Some(format!("{e:#}")),
            }
        }
        Err(e) => {
            doc.exists = true;
            doc.error = Some(format!("{e:#}"));
        }
    }
    doc
}

/// `~/.claude/CLAUDE.md`. The user's own file, so a link into their dotfiles is fine.
pub fn read_user_instructions(home: &Path) -> InstructionDoc {
    let dir = home.join(".claude");
    let path = dir.join("CLAUDE.md");
    let mut doc = InstructionDoc {
        file: "CLAUDE.md".into(),
        path: path.to_string_lossy().into_owned(),
        exists: false,
        content: String::new(),
        error: None,
    };
    if std::fs::symlink_metadata(&path).is_ok() {
        doc.exists = true;
        if !path.is_file() {
            doc.error = Some("CLAUDE.md is not a regular file".into());
        } else {
            match read_text(&path) {
                Ok(text) => doc.content = text,
                Err(e) => doc.error = Some(format!("{e:#}")),
            }
        }
    }
    doc
}

pub fn write_instruction(root: &Path, name: &str, content: &str) -> Result<InstructionDoc> {
    let file = check_instruction_name(name)?;
    let target = writable_target(root, &[file])?;
    write_atomic(&target, content)?;
    read_instruction(root, file)
}

// ---- settings.json -----------------------------------------------------------

/// The parsed settings object, `None` when the file doesn't exist.
fn load_settings_json(root: &Path, scope: SettingsScope) -> Result<Option<Map<String, Value>>> {
    let path = join(root, &settings_rel(scope));
    let Some(real) = existing_file_in(root, &path)? else {
        return Ok(None);
    };
    let text = read_text(&real)?;
    if text.trim().is_empty() {
        return Ok(Some(Map::new()));
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Ok(Some(map)),
        Ok(_) => bail!("{} isn't a JSON object", scope.file_name()),
        Err(e) => bail!(
            "{} isn't valid JSON ({}); fix it by hand before editing rules here",
            scope.file_name(),
            e
        ),
    }
}

fn string_list(map: &Map<String, Value>, key: &str) -> Vec<String> {
    map.get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn rules_of(settings: &Map<String, Value>) -> PermissionRules {
    let Some(perms) = settings.get("permissions").and_then(Value::as_object) else {
        return PermissionRules::default();
    };
    PermissionRules {
        allow: string_list(perms, "allow"),
        ask: string_list(perms, "ask"),
        deny: string_list(perms, "deny"),
    }
}

/// `(event, matcher, command)` for every hook handler in a settings object.
fn hooks_of(settings: &Map<String, Value>, scope: SettingsScope) -> Vec<HookEntry> {
    let mut out = Vec::new();
    let Some(events) = settings.get("hooks").and_then(Value::as_object) else {
        return out;
    };
    for (event, groups) in events {
        for group in groups.as_array().into_iter().flatten() {
            let matcher = group
                .get("matcher")
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty())
                .map(str::to_string);
            for hook in group
                .get("hooks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                // Command hooks have `command`; prompt / agent hooks have `prompt`.
                let command = ["command", "prompt", "url"]
                    .iter()
                    .find_map(|k| hook.get(*k).and_then(Value::as_str));
                if let Some(command) = command {
                    out.push(HookEntry {
                        event: event.clone(),
                        matcher: matcher.clone(),
                        command: command.to_string(),
                        scope: scope.id().into(),
                    });
                }
            }
            if out.len() >= MAX_LISTED {
                return out;
            }
        }
    }
    out
}

pub fn read_settings(root: &Path, scope: SettingsScope) -> SettingsFile {
    let path = join(root, &settings_rel(scope));
    let mut info = SettingsFile {
        scope: scope.id().into(),
        path: path.to_string_lossy().into_owned(),
        exists: false,
        rules: PermissionRules::default(),
        hooks: Vec::new(),
        error: None,
    };
    match load_settings_json(root, scope) {
        Ok(None) => {}
        Ok(Some(map)) => {
            info.exists = true;
            info.rules = rules_of(&map);
            info.hooks = hooks_of(&map, scope);
        }
        Err(e) => {
            info.exists = true;
            info.error = Some(format!("{e:#}"));
        }
    }
    info
}

/// Trims, validates and de-duplicates one rule list (order kept).
fn normalize_list(label: &str, rules: &[String]) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for rule in rules {
        let rule = rule.trim();
        if rule.is_empty() {
            bail!("A {label} rule can't be empty");
        }
        if rule.chars().any(char::is_control) {
            bail!("{label} rules must be a single line of plain text");
        }
        if rule.chars().count() > MAX_RULE_CHARS {
            bail!("A {label} rule is longer than {MAX_RULE_CHARS} characters");
        }
        if !out.iter().any(|r| r == rule) {
            out.push(rule.to_string());
        }
    }
    if out.len() > MAX_RULES_PER_LIST {
        bail!("Too many {label} rules (the limit is {MAX_RULES_PER_LIST})");
    }
    Ok(out)
}

pub fn normalize_rules(rules: &PermissionRules) -> Result<PermissionRules> {
    Ok(PermissionRules {
        allow: normalize_list("allow", &rules.allow)?,
        ask: normalize_list("ask", &rules.ask)?,
        deny: normalize_list("deny", &rules.deny)?,
    })
}

/// Sets `permissions.allow/ask/deny` in `settings`, leaving every other key (and the
/// rest of `permissions`) alone. A list that is empty and was never there stays absent.
fn apply_rules(settings: &mut Map<String, Value>, rules: &PermissionRules) -> Result<()> {
    match settings.get("permissions") {
        Some(Value::Object(_)) => {}
        Some(Value::Null) | None => {
            if rules.is_empty() {
                return Ok(());
            }
            settings.insert("permissions".into(), Value::Object(Map::new()));
        }
        Some(_) => bail!("\"permissions\" isn't an object; edit the file by hand"),
    }
    let perms = settings
        .get_mut("permissions")
        .and_then(Value::as_object_mut)
        .expect("permissions is an object");
    for (key, list) in [
        ("allow", &rules.allow),
        ("ask", &rules.ask),
        ("deny", &rules.deny),
    ] {
        match perms.get(key) {
            Some(Value::Array(existing)) => {
                if existing.iter().any(|v| !v.is_string()) {
                    bail!(
                        "permissions.{key} holds entries that aren't text; edit the file by hand"
                    );
                }
            }
            Some(Value::Null) | None => {
                if list.is_empty() {
                    continue;
                }
            }
            Some(_) => bail!("permissions.{key} isn't a list; edit the file by hand"),
        }
        perms.insert(
            key.into(),
            Value::Array(list.iter().cloned().map(Value::String).collect()),
        );
    }
    Ok(())
}

/// Saves the three rule lists into `.claude/settings[.local].json`. The file is created
/// only when there is a rule to store, and an existing file that isn't valid JSON is
/// refused rather than overwritten. Everything else in the JSON is preserved.
pub fn write_rules(
    root: &Path,
    scope: SettingsScope,
    rules: &PermissionRules,
) -> Result<SettingsFile> {
    let rules = normalize_rules(rules)?;
    let rel = settings_rel(scope);
    let target = writable_target(root, &rel)?;
    let existing = load_settings_json(root, scope)?;
    if existing.is_none() && rules.is_empty() {
        return Ok(read_settings(root, scope));
    }
    let mut map = existing.unwrap_or_default();
    apply_rules(&mut map, &rules)?;
    let mut text = serde_json::to_string_pretty(&Value::Object(map))?;
    text.push('\n');
    write_atomic(&target, &text)?;
    Ok(read_settings(root, scope))
}

// ---- commands & skills -------------------------------------------------------

/// `key: value` pairs of a leading `---` frontmatter block. Handles quoted values and
/// the `>` / `|` block scalars; nested structures are ignored.
fn frontmatter(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return out;
    }
    let mut block: Option<(String, bool, Vec<String>)> = None;
    let flush = |block: &mut Option<(String, bool, Vec<String>)>,
                 out: &mut BTreeMap<String, String>| {
        if let Some((key, literal, parts)) = block.take() {
            let sep = if literal { "\n" } else { " " };
            out.insert(key, parts.join(sep).trim().to_string());
        }
    };
    for line in lines {
        if line.trim_end() == "---" {
            break;
        }
        if line.starts_with([' ', '\t']) {
            if let Some((_, _, parts)) = block.as_mut() {
                parts.push(line.trim().to_string());
            }
            continue;
        }
        flush(&mut block, &mut out);
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_string();
        let value = value.trim();
        if matches!(value.chars().next(), Some('>' | '|')) {
            block = Some((key, value.starts_with('|'), Vec::new()));
        } else {
            out.insert(key, unquote(value).to_string());
        }
    }
    flush(&mut block, &mut out);
    out
}

fn unquote(value: &str) -> &str {
    for q in ['"', '\''] {
        if let Some(inner) = value.strip_prefix(q).and_then(|v| v.strip_suffix(q)) {
            return inner;
        }
    }
    value
}

/// The first non-empty line after the frontmatter that isn't a heading marker only.
fn first_body_line(text: &str) -> Option<String> {
    let mut lines = text.lines().peekable();
    if lines.peek().map(|l| l.trim_end()) == Some("---") {
        lines.next();
        for l in lines.by_ref() {
            if l.trim_end() == "---" {
                break;
            }
        }
    }
    lines
        .map(|l| l.trim().trim_start_matches('#').trim())
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

fn clip(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= MAX_DESCRIPTION_CHARS {
        return flat;
    }
    let mut out: String = flat.chars().take(MAX_DESCRIPTION_CHARS - 1).collect();
    out.push('…');
    out
}

/// Sub-entries of `dir`, name-sorted, without following symlinks.
fn child_entries(dir: &Path) -> Vec<(String, PathBuf, std::fs::FileType)> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<_> = read
        .flatten()
        .filter_map(|e| {
            let ft = e.file_type().ok()?;
            (!ft.is_symlink()).then(|| (e.file_name().to_string_lossy().into_owned(), e.path(), ft))
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Custom slash commands: `.claude/commands/**/*.md`. A subfolder becomes a prefix
/// (`frontend/test.md` is `/frontend:test`).
pub fn list_commands(root: &Path) -> Vec<ConfigEntry> {
    let base = join(root, &[".claude", "commands"]);
    // The folder itself must not be a link out of the project.
    if std::fs::symlink_metadata(&base).map_or(true, |m| !m.is_dir()) {
        return Vec::new();
    }
    let mut out = Vec::new();
    collect_commands(&base, "", 0, &mut out);
    out
}

fn collect_commands(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<ConfigEntry>) {
    for (name, path, ft) in child_entries(dir) {
        if out.len() >= MAX_LISTED {
            return;
        }
        if ft.is_dir() {
            if depth < MAX_DEPTH {
                collect_commands(&path, &format!("{prefix}{name}:"), depth + 1, out);
            }
        } else if let Some(stem) = name.strip_suffix(".md").filter(|s| !s.is_empty()) {
            let (text, _) = read_capped(&path, HEADER_BYTES).unwrap_or_default();
            let description = frontmatter(&text)
                .remove("description")
                .filter(|d| !d.is_empty())
                .or_else(|| first_body_line(&text))
                .map(|d| clip(&d))
                .unwrap_or_default();
            out.push(ConfigEntry {
                name: format!("/{prefix}{stem}"),
                description,
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
}

/// Skills: `.claude/skills/*/SKILL.md`.
pub fn list_skills(root: &Path) -> Vec<ConfigEntry> {
    let base = join(root, &[".claude", "skills"]);
    if std::fs::symlink_metadata(&base).map_or(true, |m| !m.is_dir()) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (dir_name, dir, ft) in child_entries(&base) {
        if out.len() >= MAX_LISTED {
            break;
        }
        if !ft.is_dir() {
            continue;
        }
        let file = dir.join("SKILL.md");
        if !std::fs::symlink_metadata(&file).is_ok_and(|m| m.is_file()) {
            continue;
        }
        let (text, _) = read_capped(&file, HEADER_BYTES).unwrap_or_default();
        let mut fm = frontmatter(&text);
        out.push(ConfigEntry {
            name: fm
                .remove("name")
                .filter(|n| !n.is_empty())
                .unwrap_or(dir_name),
            description: fm
                .remove("description")
                .filter(|d| !d.is_empty())
                .or_else(|| first_body_line(&text))
                .map(|d| clip(&d))
                .unwrap_or_default(),
            path: file.to_string_lossy().into_owned(),
        });
    }
    out
}

/// Everything the project-settings screen shows, in one read.
pub fn load(project: &Path, home: Option<&Path>) -> Result<ProjectConfig> {
    let root = resolve_root(project)?;
    Ok(ProjectConfig {
        root: root.to_string_lossy().into_owned(),
        instructions: INSTRUCTION_FILES
            .iter()
            .map(|f| read_doc(&root, f, &join(&root, &[f])))
            .collect(),
        user_instructions: home.map(read_user_instructions),
        settings: [SettingsScope::Shared, SettingsScope::Local]
            .into_iter()
            .map(|s| read_settings(&root, s))
            .collect(),
        commands: list_commands(&root),
        skills: list_skills(&root),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "armada-projcfg-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    fn rules(allow: &[&str], ask: &[&str], deny: &[&str]) -> PermissionRules {
        let v = |l: &[&str]| l.iter().map(|s| s.to_string()).collect();
        PermissionRules {
            allow: v(allow),
            ask: v(ask),
            deny: v(deny),
        }
    }

    #[test]
    fn instruction_files_round_trip_and_are_created() {
        let root = tmp("instr");
        let doc = read_instruction(&root, "CLAUDE.md").unwrap();
        assert!(!doc.exists && doc.content.is_empty() && doc.error.is_none());
        let saved = write_instruction(&root, "CLAUDE.md", "# Hi\n").unwrap();
        assert!(saved.exists);
        assert_eq!(saved.content, "# Hi\n");
        assert_eq!(
            std::fs::read_to_string(root.join("CLAUDE.md")).unwrap(),
            "# Hi\n"
        );
        assert!(!root.join(".CLAUDE.md.armada-tmp").exists());
    }

    #[test]
    fn only_the_allowed_instruction_files_are_touched() {
        let root = tmp("names");
        for bad in [
            "../x.md",
            "README.md",
            "claude.md",
            "sub/CLAUDE.md",
            ".claude/settings.json",
        ] {
            assert!(write_instruction(&root, bad, "x").is_err(), "{bad}");
            assert!(read_instruction(&root, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn instruction_size_cap_applies_to_writes_and_reads() {
        let root = tmp("size");
        let big = "a".repeat(MAX_FILE_BYTES as usize + 1);
        assert!(write_instruction(&root, "AGENTS.md", &big).is_err());
        assert!(!root.join("AGENTS.md").exists());
        std::fs::write(root.join("AGENTS.md"), &big).unwrap();
        let doc = read_instruction(&root, "AGENTS.md").unwrap();
        assert!(doc.error.unwrap().contains("1 MiB"));
        assert!(doc.content.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_never_written_through_and_cannot_escape_on_read() {
        use std::os::unix::fs::symlink;
        let root = tmp("link");
        let outside = tmp("outside");
        std::fs::write(outside.join("secret.md"), "secret").unwrap();
        symlink(outside.join("secret.md"), root.join("CLAUDE.md")).unwrap();
        let doc = read_instruction(&root, "CLAUDE.md").unwrap();
        assert!(doc.error.unwrap().contains("outside the project"));
        assert!(doc.content.is_empty());
        assert!(write_instruction(&root, "CLAUDE.md", "pwned").is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("secret.md")).unwrap(),
            "secret"
        );

        // A link that stays inside the project reads fine but still isn't written through.
        symlink(root.join("real.md"), root.join("AGENTS.md")).unwrap();
        std::fs::write(root.join("real.md"), "inside").unwrap();
        assert_eq!(
            read_instruction(&root, "AGENTS.md").unwrap().content,
            "inside"
        );
        assert!(write_instruction(&root, "AGENTS.md", "x").is_err());

        // `.claude` being a link out of the project blocks settings writes.
        symlink(&outside, root.join(".claude")).unwrap();
        assert!(write_rules(
            &root,
            SettingsScope::Shared,
            &rules(&["Bash(ls)"], &[], &[])
        )
        .is_err());
        assert!(!outside.join("settings.json").exists());
    }

    #[test]
    fn rules_creates_file_only_when_a_rule_is_added() {
        let root = tmp("create");
        let none = write_rules(&root, SettingsScope::Local, &PermissionRules::default()).unwrap();
        assert!(!none.exists);
        assert!(!root.join(".claude").exists());

        let saved = write_rules(
            &root,
            SettingsScope::Local,
            &rules(&["Bash(npm test)"], &[], &[]),
        )
        .unwrap();
        assert!(saved.exists && saved.error.is_none());
        assert_eq!(saved.rules.allow, vec!["Bash(npm test)"]);
        let text = std::fs::read_to_string(root.join(".claude/settings.local.json")).unwrap();
        assert_eq!(
            text,
            "{\n  \"permissions\": {\n    \"allow\": [\n      \"Bash(npm test)\"\n    ]\n  }\n}\n"
        );
        assert!(!root.join(".claude/settings.json").exists());
    }

    #[test]
    fn rules_preserve_unknown_keys_and_order() {
        let root = tmp("preserve");
        std::fs::create_dir_all(root.join(".claude")).unwrap();
        let original = r#"{
  "model": "opus",
  "env": { "A": "1" },
  "permissions": {
    "defaultMode": "acceptEdits",
    "deny": ["Read(.env)"],
    "additionalDirectories": ["../x"]
  },
  "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "echo done" }] }] },
  "zeta": [1, 2.5, null, true]
}
"#;
        std::fs::write(root.join(".claude/settings.json"), original).unwrap();
        let saved = write_rules(
            &root,
            SettingsScope::Shared,
            &rules(
                &["Bash(git status)", "Bash(git status)", "  Read(src/**)  "],
                &["Bash(rm:*)"],
                &["Read(.env)"],
            ),
        )
        .unwrap();
        assert_eq!(saved.rules.allow, vec!["Bash(git status)", "Read(src/**)"]);
        assert_eq!(saved.rules.ask, vec!["Bash(rm:*)"]);
        assert_eq!(saved.hooks.len(), 1);

        let text = std::fs::read_to_string(root.join(".claude/settings.json")).unwrap();
        assert!(text.ends_with("}\n"));
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["model"], "opus");
        assert_eq!(v["env"]["A"], "1");
        assert_eq!(v["permissions"]["defaultMode"], "acceptEdits");
        assert_eq!(v["permissions"]["additionalDirectories"][0], "../x");
        assert_eq!(v["hooks"]["Stop"][0]["hooks"][0]["command"], "echo done");
        assert_eq!(v["zeta"][1], 2.5);
        let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["model", "env", "permissions", "hooks", "zeta"]);
    }

    #[test]
    fn removing_every_rule_keeps_the_file_and_other_keys() {
        let root = tmp("remove");
        write_rules(
            &root,
            SettingsScope::Shared,
            &rules(&["Bash(ls)"], &[], &["Bash(rm:*)"]),
        )
        .unwrap();
        let saved = write_rules(&root, SettingsScope::Shared, &PermissionRules::default()).unwrap();
        assert!(saved.exists && saved.rules.is_empty());
        let v: Value = serde_json::from_str(
            &std::fs::read_to_string(root.join(".claude/settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(v["permissions"]["allow"], serde_json::json!([]));
        assert!(v["permissions"].get("ask").is_none());
    }

    #[test]
    fn invalid_json_is_refused_and_left_alone() {
        let root = tmp("invalid");
        std::fs::create_dir_all(root.join(".claude")).unwrap();
        let path = root.join(".claude/settings.json");
        std::fs::write(&path, "{ \"permissions\": { oops").unwrap();
        let err = write_rules(
            &root,
            SettingsScope::Shared,
            &rules(&["Bash(ls)"], &[], &[]),
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("isn't valid JSON"));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{ \"permissions\": { oops"
        );
        let info = read_settings(&root, SettingsScope::Shared);
        assert!(info.exists && info.error.is_some() && info.rules.is_empty());

        // Valid JSON of the wrong shape is refused too.
        std::fs::write(&path, "[1]").unwrap();
        assert!(write_rules(&root, SettingsScope::Shared, &rules(&["x"], &[], &[])).is_err());
        std::fs::write(&path, r#"{"permissions": {"allow": [1, "a"]}}"#).unwrap();
        assert!(write_rules(&root, SettingsScope::Shared, &rules(&["x"], &[], &[])).is_err());
        std::fs::write(&path, r#"{"permissions": "all"}"#).unwrap();
        assert!(write_rules(&root, SettingsScope::Shared, &rules(&["x"], &[], &[])).is_err());
    }

    #[test]
    fn rule_validation() {
        let ok = |s: &str| normalize_rules(&rules(&[s], &[], &[]));
        assert!(ok("Bash(npm run build)").is_ok());
        assert!(ok("").is_err());
        assert!(ok("   ").is_err());
        assert!(ok("a\nb").is_err());
        assert!(ok("a\r").is_ok(), "trailing CR is trimmed");
        assert!(ok("a\tb").is_err());
        assert!(ok(&"x".repeat(MAX_RULE_CHARS + 1)).is_err());
    }

    #[test]
    fn hooks_are_listed_with_event_matcher_and_command() {
        let root = tmp("hooks");
        std::fs::create_dir_all(root.join(".claude")).unwrap();
        std::fs::write(
            root.join(".claude/settings.local.json"),
            r#"{"hooks": {"PreToolUse": [
                {"matcher": "Bash", "hooks": [{"type": "command", "command": "./check.sh"}]},
                {"hooks": [{"type": "command", "command": "echo hi"}, {"type": "weird"}]}
            ]}}"#,
        )
        .unwrap();
        let info = read_settings(&root, SettingsScope::Local);
        assert_eq!(info.hooks.len(), 2);
        assert_eq!(info.hooks[0].event, "PreToolUse");
        assert_eq!(info.hooks[0].matcher.as_deref(), Some("Bash"));
        assert_eq!(info.hooks[0].command, "./check.sh");
        assert_eq!(info.hooks[0].scope, "local");
        assert_eq!(info.hooks[1].matcher, None);
    }

    #[test]
    fn commands_and_skills_are_listed_from_frontmatter() {
        let root = tmp("lists");
        let cmds = root.join(".claude/commands/frontend");
        std::fs::create_dir_all(&cmds).unwrap();
        std::fs::write(
            root.join(".claude/commands/review.md"),
            "---\ndescription: \"Review the diff\"\nallowed-tools: Bash\n---\nBody\n",
        )
        .unwrap();
        std::fs::write(cmds.join("test.md"), "# Run the tests\n\nmore\n").unwrap();
        std::fs::write(root.join(".claude/commands/notes.txt"), "x").unwrap();
        let skill = root.join(".claude/skills/pdf");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: pdf-tools\ndescription: >\n  Work with\n  PDF files\n---\n# PDF\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join(".claude/skills/empty")).unwrap();

        let commands = list_commands(&root);
        let names: Vec<_> = commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["/frontend:test", "/review"]);
        assert_eq!(commands[0].description, "Run the tests");
        assert_eq!(commands[1].description, "Review the diff");

        let skills = list_skills(&root);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "pdf-tools");
        assert_eq!(skills[0].description, "Work with PDF files");
    }

    #[cfg(unix)]
    #[test]
    fn linked_command_folders_and_files_are_skipped() {
        use std::os::unix::fs::symlink;
        let root = tmp("cmdlink");
        let outside = tmp("cmdout");
        std::fs::write(outside.join("evil.md"), "evil").unwrap();
        std::fs::create_dir_all(root.join(".claude/commands")).unwrap();
        symlink(
            outside.join("evil.md"),
            root.join(".claude/commands/evil.md"),
        )
        .unwrap();
        symlink(&outside, root.join(".claude/commands/dir")).unwrap();
        assert!(list_commands(&root).is_empty());
        std::fs::remove_dir_all(root.join(".claude/commands")).unwrap();
        symlink(&outside, root.join(".claude/commands")).unwrap();
        assert!(list_commands(&root).is_empty());
    }

    #[test]
    fn load_reports_everything_and_requires_a_folder() {
        let root = tmp("load");
        std::fs::write(root.join("AGENTS.md"), "agents").unwrap();
        let cfg = load(&root, None).unwrap();
        assert_eq!(cfg.instructions.len(), 2);
        assert!(!cfg.instructions[0].exists && cfg.instructions[1].exists);
        assert_eq!(cfg.settings.len(), 2);
        assert!(cfg.user_instructions.is_none());
        assert!(load(&root.join("missing"), None).is_err());
        assert!(load(&root.join("AGENTS.md"), None).is_err());
    }
}
