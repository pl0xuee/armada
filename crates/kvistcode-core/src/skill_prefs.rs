//! Which of your skills are switched off. Kvistcode keeps its own list (in
//! `skill-prefs.json` in its data folder) and hands it to Claude Code when a Claude agent
//! starts, as the `skillOverrides` setting: a switched-off skill is hidden from the model
//! and its `/name` command, and Claude's Skill tool refuses it. No skill folder, `SKILL.md`
//! or Claude settings file is ever moved, renamed or edited.
//!
//! Claude Code identifies a skill by its folder name (not the `name:` in `SKILL.md`), so
//! the list holds folder names. Plugin skills are not switchable here: the plugin owns them.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::project_config::{read_capped, write_atomic};
use crate::skills::SkillInfo;
use crate::Result;

const FILE: &str = "skill-prefs.json";
/// Most names kept per list; more than this is not a real setup.
const MAX_NAMES: usize = 500;
const MAX_PROJECTS: usize = 500;
const MAX_NAME_CHARS: usize = 128;
const MAX_FILE: u64 = 1024 * 1024;

/// Serializes read-modify-write of the file (commands run on a thread pool).
static LOCK: Mutex<()> = Mutex::new(());

/// Where a switch applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// Every project (your own skills only).
    Global,
    /// Agents started in one project.
    Project,
}

impl Scope {
    pub fn parse(s: &str) -> Result<Scope> {
        match s {
            "global" => Ok(Scope::Global),
            "project" => Ok(Scope::Project),
            _ => bail!("A skill can be switched off everywhere or in one project"),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SkillPrefs {
    /// Folder names switched off in every project.
    pub global: BTreeSet<String>,
    /// Folder names switched off per project, keyed by the project's canonical path.
    pub projects: BTreeMap<String, BTreeSet<String>>,
}

/// What the Skills tab shows for one project.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillToggles {
    /// Switched off everywhere.
    pub global: Vec<String>,
    /// Switched off in the asked-about project.
    pub project: Vec<String>,
}

/// A usable folder name: what a skill folder can be called, never a path.
pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.chars().count() <= MAX_NAME_CHARS
        && !key.starts_with('.')
        && !key.contains(['/', '\\'])
        && !key.chars().any(char::is_control)
}

/// The folder name inside a skill id (`user:<dir>` / `project:<dir>`). Plugin ids give none.
pub fn key_of(id: &str) -> Option<&str> {
    let (scope, dir) = id.split_once(':')?;
    (matches!(scope, "user" | "project") && valid_key(dir)).then_some(dir)
}

/// The path a project is filed under: canonical when it exists, else as given.
pub fn project_key(project: &Path) -> String {
    std::fs::canonicalize(project)
        .unwrap_or_else(|_| PathBuf::from(project.to_string_lossy().trim_end_matches(['/', '\\'])))
        .to_string_lossy()
        .into_owned()
}

fn clean(names: BTreeSet<String>) -> BTreeSet<String> {
    names
        .into_iter()
        .filter(|n| valid_key(n))
        .take(MAX_NAMES)
        .collect()
}

impl SkillPrefs {
    fn sanitized(mut self) -> SkillPrefs {
        self.global = clean(self.global);
        self.projects = self
            .projects
            .into_iter()
            .map(|(p, names)| (p, clean(names)))
            .filter(|(p, names)| !p.is_empty() && !names.is_empty())
            .take(MAX_PROJECTS)
            .collect();
        self
    }

    /// Everything switched off for agents started in `project`.
    pub fn disabled_for(&self, project: Option<&str>) -> BTreeSet<String> {
        let mut out = self.global.clone();
        if let Some(names) = project.and_then(|p| self.projects.get(p)) {
            out.extend(names.iter().cloned());
        }
        out
    }

    pub fn toggles(&self, project: Option<&str>) -> SkillToggles {
        SkillToggles {
            global: self.global.iter().cloned().collect(),
            project: project
                .and_then(|p| self.projects.get(p))
                .map(|n| n.iter().cloned().collect())
                .unwrap_or_default(),
        }
    }

    /// Switches `key` on or off in `scope`. Returns whether anything changed.
    pub fn set(
        &mut self,
        scope: Scope,
        project: Option<&str>,
        key: &str,
        enabled: bool,
    ) -> Result<bool> {
        if !valid_key(key) {
            bail!("That isn't a skill folder name");
        }
        let set = match scope {
            Scope::Global => &mut self.global,
            Scope::Project => {
                let project = project.ok_or_else(|| anyhow!("Choose a project first"))?;
                if enabled && !self.projects.contains_key(project) {
                    return Ok(false);
                }
                if !enabled
                    && self.projects.len() >= MAX_PROJECTS
                    && !self.projects.contains_key(project)
                {
                    bail!("Too many projects have skills switched off");
                }
                self.projects.entry(project.to_string()).or_default()
            }
        };
        let changed = if enabled {
            set.remove(key)
        } else {
            if set.len() >= MAX_NAMES && !set.contains(key) {
                bail!("Too many skills are switched off");
            }
            set.insert(key.to_string())
        };
        if let Some(project) = project {
            if self.projects.get(project).is_some_and(BTreeSet::is_empty) {
                self.projects.remove(project);
            }
        }
        Ok(changed)
    }
}

fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

/// The saved list. A missing or unreadable file means nothing is switched off.
pub fn load(data_dir: &Path) -> SkillPrefs {
    read_capped(&path(data_dir), MAX_FILE)
        .ok()
        .and_then(|(text, _)| serde_json::from_str::<SkillPrefs>(&text).ok())
        .map(SkillPrefs::sanitized)
        .unwrap_or_default()
}

/// Applies `edit` to the saved list and writes it back (only when it changed). Writes
/// `skill-prefs.json` in `data_dir` and nothing else.
pub fn update<T>(
    data_dir: &Path,
    edit: impl FnOnce(&mut SkillPrefs) -> Result<(bool, T)>,
) -> Result<T> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut prefs = load(data_dir);
    let (changed, out) = edit(&mut prefs)?;
    if changed {
        write_atomic(&path(data_dir), &serde_json::to_string_pretty(&prefs)?)?;
    }
    Ok(out)
}

/// Switches a listed skill on or off. `skills` is what `skills::list` found for
/// `project`: switching one off needs it to be a real, switchable skill there (not a
/// plugin's), and a project skill can only be switched in its own project.
pub fn set_enabled(
    data_dir: &Path,
    skills: &[SkillInfo],
    project: Option<&str>,
    scope: Scope,
    id: &str,
    enabled: bool,
) -> Result<SkillToggles> {
    let key = key_of(id).ok_or_else(|| {
        anyhow!("That skill belongs to a plugin: turn it off from the plugin's own settings")
    })?;
    if !enabled {
        let info = skills
            .iter()
            .find(|s| s.id == id)
            .ok_or_else(|| anyhow!("That skill no longer exists"))?;
        if info.read_only {
            bail!("That skill belongs to a plugin: turn it off from the plugin's own settings");
        }
        if scope == Scope::Global && info.scope != "user" {
            bail!("Only your own skills can be switched off in every project");
        }
    }
    update(data_dir, |prefs| {
        let changed = prefs.set(scope, project, key, enabled)?;
        Ok((changed, prefs.toggles(project)))
    })
}

/// Claude Code settings that switch these skills off.
pub fn claude_settings(disabled: &BTreeSet<String>) -> Option<Value> {
    if disabled.is_empty() {
        return None;
    }
    let overrides: serde_json::Map<String, Value> =
        disabled.iter().map(|k| (k.clone(), json!("off"))).collect();
    Some(json!({ "skillOverrides": overrides }))
}

/// The `_meta` claude-agent-acp reads on `session/new`, `session/resume` and
/// `session/load`: its `claudeCode.options.settings` goes to Claude Code as `--settings`.
pub fn claude_meta(disabled: &BTreeSet<String>) -> Option<Value> {
    claude_settings(disabled)
        .map(|settings| json!({ "claudeCode": { "options": { "settings": settings } } }))
}

/// The names to switch off for a Claude agent started in `project`.
pub fn disabled_for_project(data_dir: &Path, project: &Path) -> BTreeSet<String> {
    load(data_dir).disabled_for(Some(&project_key(project)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = crate::testutil::scratch(&format!("skillprefs-{tag}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    fn info(id: &str, scope: &str) -> SkillInfo {
        SkillInfo {
            id: id.to_string(),
            name: id.to_string(),
            description: String::new(),
            scope: scope.to_string(),
            plugin: (scope == "plugin").then(|| "p".to_string()),
            path: String::new(),
            read_only: scope == "plugin",
        }
    }

    /// Every file under `root` with its bytes, to prove nothing else changed.
    fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        fn walk(dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    out.insert(p.clone(), Vec::new());
                    walk(&p, out);
                } else {
                    out.insert(p.clone(), std::fs::read(&p).unwrap());
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(root, &mut out);
        out
    }

    #[test]
    fn folder_names_never_carry_paths() {
        for ok in ["pdf", "code-review", "a b", "ünï", "v1.2"] {
            assert!(valid_key(ok), "{ok}");
        }
        for bad in ["", ".hidden", "a/b", "..\\x", "../x", "tab\there", "nul\0"] {
            assert!(!valid_key(bad), "{bad:?}");
        }
        assert!(!valid_key(&"x".repeat(MAX_NAME_CHARS + 1)));
        assert_eq!(key_of("user:pdf"), Some("pdf"));
        assert_eq!(key_of("project:deploy"), Some("deploy"));
        assert_eq!(key_of("plugin:tools/lint"), None);
        assert_eq!(key_of("user:../etc"), None);
        assert_eq!(key_of("nonsense"), None);
    }

    #[test]
    fn switching_off_unions_global_and_project_and_cleans_up() {
        let mut p = SkillPrefs::default();
        assert!(p.set(Scope::Global, None, "pdf", false).unwrap());
        assert!(!p.set(Scope::Global, None, "pdf", false).unwrap(), "no-op");
        assert!(p.set(Scope::Project, Some("/a"), "deploy", false).unwrap());
        assert!(p.set(Scope::Project, Some("/b"), "lint", false).unwrap());
        assert_eq!(
            p.disabled_for(Some("/a")).into_iter().collect::<Vec<_>>(),
            ["deploy", "pdf"]
        );
        assert_eq!(
            p.disabled_for(Some("/b")).into_iter().collect::<Vec<_>>(),
            ["lint", "pdf"]
        );
        assert_eq!(
            p.disabled_for(None).into_iter().collect::<Vec<_>>(),
            ["pdf"]
        );
        // Switching back on drops the empty project entry.
        assert!(p.set(Scope::Project, Some("/a"), "deploy", true).unwrap());
        assert!(!p.projects.contains_key("/a"));
        assert!(!p.set(Scope::Project, Some("/zzz"), "x", true).unwrap());
        assert!(!p.projects.contains_key("/zzz"));
        assert!(p.set(Scope::Project, None, "x", false).is_err());
        assert!(p.set(Scope::Global, None, "../x", false).is_err());
        let t = p.toggles(Some("/b"));
        assert_eq!(
            (t.global, t.project),
            (vec!["pdf".into()], vec!["lint".into()])
        );
    }

    #[test]
    fn the_list_has_a_size_cap() {
        let mut p = SkillPrefs::default();
        for i in 0..MAX_NAMES {
            p.set(Scope::Global, None, &format!("s{i}"), false).unwrap();
        }
        assert!(p.set(Scope::Global, None, "one-more", false).is_err());
        // Already-listed names can still be switched back on.
        assert!(p.set(Scope::Global, None, "s0", true).unwrap());
    }

    #[test]
    fn claude_gets_skill_overrides_only_when_something_is_off() {
        assert!(claude_meta(&BTreeSet::new()).is_none());
        let off: BTreeSet<String> = ["pdf".to_string(), "deploy".to_string()].into();
        assert_eq!(
            claude_meta(&off).unwrap(),
            json!({"claudeCode": {"options": {"settings": {
                "skillOverrides": {"deploy": "off", "pdf": "off"}
            }}}})
        );
    }

    #[test]
    fn round_trips_and_survives_a_damaged_file() {
        let dir = tmp("data");
        assert_eq!(load(&dir), SkillPrefs::default());
        let skills = [info("user:pdf", "user"), info("project:deploy", "project")];
        let t = set_enabled(&dir, &skills, Some("/p"), Scope::Global, "user:pdf", false).unwrap();
        assert_eq!(t.global, ["pdf"]);
        set_enabled(
            &dir,
            &skills,
            Some("/p"),
            Scope::Project,
            "project:deploy",
            false,
        )
        .unwrap();
        let back = load(&dir);
        assert_eq!(back.disabled_for(Some("/p")).len(), 2);
        assert_eq!(back.disabled_for(Some("/other")).len(), 1);

        // Garbage, wrong shapes and path-like names are ignored, never fatal.
        std::fs::write(path(&dir), "{ not json").unwrap();
        assert_eq!(load(&dir), SkillPrefs::default());
        std::fs::write(
            path(&dir),
            r#"{"global":["ok","../evil","", ".x"],"projects":{"":["a"],"/p":[],"/q":["b","c/d"]}}"#,
        )
        .unwrap();
        let p = load(&dir);
        assert_eq!(p.global.iter().collect::<Vec<_>>(), ["ok"]);
        assert_eq!(p.projects.len(), 1);
        assert_eq!(p.projects["/q"].iter().collect::<Vec<_>>(), ["b"]);
    }

    #[test]
    fn only_switchable_listed_skills_can_be_switched_off() {
        let dir = tmp("rules");
        let skills = [
            info("user:pdf", "user"),
            info("project:deploy", "project"),
            info("plugin:tools/lint", "plugin"),
        ];
        let off = |scope, id: &str| set_enabled(&dir, &skills, Some("/p"), scope, id, false);
        assert!(off(Scope::Project, "plugin:tools/lint").is_err(), "plugin");
        assert!(off(Scope::Project, "user:ghost").is_err(), "not listed");
        assert!(off(Scope::Project, "user:../x").is_err(), "path-like");
        assert!(
            off(Scope::Global, "project:deploy").is_err(),
            "project skill is per project"
        );
        assert!(off(Scope::Global, "user:pdf").is_ok());
        assert!(
            off(Scope::Project, "user:pdf").is_ok(),
            "also off in one project"
        );
        // Nothing was written for the refused ones.
        let p = load(&dir);
        assert_eq!(p.global.len(), 1);
        assert_eq!(p.projects["/p"].len(), 1);
        // A skill that vanished from disk can still be switched back on.
        assert!(set_enabled(&dir, &[], Some("/p"), Scope::Global, "user:pdf", true).is_ok());
        assert!(load(&dir).global.is_empty());
    }

    #[test]
    fn simultaneous_switches_are_not_lost() {
        let dir = tmp("race");
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    let skills = [info(&format!("user:s{i}"), "user")];
                    set_enabled(
                        &dir,
                        &skills,
                        None,
                        Scope::Global,
                        &format!("user:s{i}"),
                        false,
                    )
                    .unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(load(&dir).global.len(), 8);
    }

    #[test]
    fn switching_touches_only_its_own_file() {
        let home = tmp("home");
        let project = tmp("proj");
        let data = tmp("data2");
        for (base, name) in [(&home, "pdf"), (&project, "deploy")] {
            let d = base.join(".claude/skills").join(name);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("SKILL.md"), format!("---\nname: {name}\n---\n")).unwrap();
            std::fs::write(d.join("extra.sh"), "echo hi\n").unwrap();
        }
        std::fs::write(
            project.join(".claude/settings.json"),
            "{\"permissions\":{}}\n",
        )
        .unwrap();
        let before = (snapshot(&home), snapshot(&project));

        let skills = crate::skills::list(Some(&project), Some(&home));
        assert_eq!(skills.len(), 2);
        let pkey = project_key(&project);
        for (scope, id, on) in [
            (Scope::Global, "user:pdf", false),
            (Scope::Project, "project:deploy", false),
            (Scope::Project, "project:deploy", true),
            (Scope::Global, "user:pdf", true),
            (Scope::Global, "user:pdf", false),
        ] {
            set_enabled(&data, &skills, Some(&pkey), scope, id, on).unwrap();
        }
        assert_eq!((snapshot(&home), snapshot(&project)), before);
        // Only the prefs file (no leftover temp file) appeared in the data folder.
        let files: Vec<_> = std::fs::read_dir(&data)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(files, [FILE]);
        assert_eq!(disabled_for_project(&data, &project).len(), 1);
    }
}
