//! Skills Claude Code loads: yours (`~/.claude/skills`), the project's
//! (`<project>/.claude/skills`) and the ones installed plugins ship (read-only).
//!
//! Callers never pass a file path: a skill is named by an id from `list`, so the only
//! files read are `SKILL.md` files found under the known skill folders. Project and
//! plugin skills are refused when a link leads out of their folder; the user's own
//! folder may be linked into their dotfiles. Creating a skill writes one new
//! `SKILL.md` and never replaces or deletes anything.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail};
use serde::Serialize;
use serde_json::Value;

use crate::project_config::{
    child_entries, clip, first_body_line, frontmatter, read_capped, writable_target, write_atomic,
    HEADER_BYTES, MAX_LISTED,
};
use crate::Result;

/// Most of a `SKILL.md` shown in the viewer.
const VIEW_BYTES: u64 = 256 * 1024;
const MAX_PLUGINS: usize = 60;
const MAX_NAME_CHARS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    /// Stable handle for `read`: `user:<dir>`, `project:<dir>` or `plugin:<plugin>/<dir>`.
    pub id: String,
    pub name: String,
    pub description: String,
    /// "user", "project" or "plugin".
    pub scope: String,
    /// The plugin that ships it (plugin skills only).
    pub plugin: Option<String>,
    /// The `SKILL.md` file.
    pub path: String,
    /// Plugin skills belong to the plugin, so they are view-only.
    pub read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDoc {
    #[serde(flatten)]
    pub info: SkillInfo,
    pub content: String,
    /// The file was longer than what is shown.
    pub truncated: bool,
    /// Other files in the skill's folder (scripts, references), by name.
    pub files: Vec<String>,
}

fn skills_dir(root: &Path) -> PathBuf {
    root.join(".claude").join("skills")
}

/// Skills found directly under `base`. With `follow` off, anything resolving outside
/// `base` is skipped.
fn scan(base: &Path, scope: &str, plugin: Option<&str>, follow: bool, out: &mut Vec<SkillInfo>) {
    let Ok(jail) = std::fs::canonicalize(base) else {
        return;
    };
    if !jail.is_dir() {
        return;
    }
    let mut entries: Vec<_> = std::fs::read_dir(&jail)
        .map(|r| r.flatten().collect())
        .unwrap_or_default();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if out.len() >= MAX_LISTED {
            return;
        }
        let dir_name = entry.file_name().to_string_lossy().into_owned();
        if dir_name.starts_with('.') {
            continue;
        }
        let Ok(file) = std::fs::canonicalize(entry.path().join("SKILL.md")) else {
            continue;
        };
        if !file.is_file() || (!follow && !file.starts_with(&jail)) {
            continue;
        }
        let (text, _) = read_capped(&file, HEADER_BYTES).unwrap_or_default();
        let mut fm = frontmatter(&text);
        let name = fm
            .remove("name")
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| dir_name.clone());
        let description = fm
            .remove("description")
            .filter(|d| !d.is_empty())
            .or_else(|| first_body_line(&text))
            .map(|d| clip(&d))
            .unwrap_or_default();
        out.push(SkillInfo {
            id: match plugin {
                Some(p) => format!("{scope}:{p}/{dir_name}"),
                None => format!("{scope}:{dir_name}"),
            },
            name,
            description,
            scope: scope.to_string(),
            plugin: plugin.map(str::to_string),
            path: file.to_string_lossy().into_owned(),
            read_only: scope == "plugin",
        });
    }
}

/// `(plugin name, folder)` of installed plugins, from Claude Code's own registry.
/// An install path is used only if it lies inside `~/.claude/plugins`.
fn plugin_folders(home: &Path) -> Vec<(String, PathBuf)> {
    let plugins_dir = home.join(".claude").join("plugins");
    let Ok(jail) = std::fs::canonicalize(&plugins_dir) else {
        return Vec::new();
    };
    let Ok((text, _)) = read_capped(&plugins_dir.join("installed_plugins.json"), 1024 * 1024)
    else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(map) = json["plugins"].as_object() else {
        return Vec::new();
    };
    let mut out: Vec<(String, PathBuf)> = Vec::new();
    for (key, value) in map {
        // Newer registries list installs per plugin; older ones hold a single object.
        let installs: Vec<&Value> = match value {
            Value::Array(list) => list.iter().collect(),
            other => vec![other],
        };
        for install in installs {
            let Some(raw) = install["installPath"].as_str() else {
                continue;
            };
            let Ok(real) = std::fs::canonicalize(raw) else {
                continue;
            };
            if !real.starts_with(&jail) || out.iter().any(|(_, p)| *p == real) {
                continue;
            }
            let name = key.split('@').next().unwrap_or(key).to_string();
            out.push((name, real));
        }
        if out.len() >= MAX_PLUGINS {
            break;
        }
    }
    out
}

/// Every skill visible from `project` (when given) and `home`: project first, then
/// yours, then plugins'.
pub fn list(project: Option<&Path>, home: Option<&Path>) -> Vec<SkillInfo> {
    let mut out = Vec::new();
    if let Some(root) = project {
        scan(&skills_dir(root), "project", None, false, &mut out);
    }
    if let Some(home) = home {
        scan(&skills_dir(home), "user", None, true, &mut out);
        for (name, folder) in plugin_folders(home) {
            scan(
                &folder.join("skills"),
                "plugin",
                Some(&name),
                false,
                &mut out,
            );
        }
    }
    out
}

/// A skill's `SKILL.md` and the names of its sibling files.
pub fn read(project: Option<&Path>, home: Option<&Path>, id: &str) -> Result<SkillDoc> {
    let info = list(project, home)
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| anyhow!("That skill no longer exists"))?;
    let file = PathBuf::from(&info.path);
    let (content, truncated) = read_capped(&file, VIEW_BYTES)?;
    let files = file
        .parent()
        .map(|dir| {
            child_entries(dir)
                .into_iter()
                .filter(|(name, _, _)| name != "SKILL.md" && !name.starts_with('.'))
                .map(|(name, _, ft)| {
                    if ft.is_dir() {
                        format!("{name}/")
                    } else {
                        name
                    }
                })
                .take(40)
                .collect()
        })
        .unwrap_or_default();
    Ok(SkillDoc {
        info,
        content,
        truncated,
        files,
    })
}

/// A skill folder name: lowercase letters, digits and single hyphens.
pub fn check_name(name: &str) -> Result<&str> {
    let n = name.trim();
    if n.is_empty() {
        bail!("Give the skill a name");
    }
    if n.chars().count() > MAX_NAME_CHARS {
        bail!("A skill name can be at most {MAX_NAME_CHARS} characters");
    }
    let ok = n
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !n.starts_with('-')
        && !n.ends_with('-')
        && !n.contains("--");
    if !ok {
        bail!("Use lowercase letters, digits and hyphens, like code-review");
    }
    Ok(n)
}

/// The description as a folded YAML block, which needs no escaping.
fn yaml_block(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    format!(">\n  {flat}")
}

fn title_of(name: &str) -> String {
    let mut words = name.split('-').filter(|w| !w.is_empty());
    let first = words.next().unwrap_or(name);
    let mut title: String = first
        .chars()
        .next()
        .map(|c| c.to_uppercase().collect::<String>() + &first[c.len_utf8()..])
        .unwrap_or_default();
    for w in words {
        title.push(' ');
        title.push_str(w);
    }
    title
}

fn template(name: &str, description: &str) -> String {
    let description = if description.trim().is_empty() {
        "Describe what this skill does and when Claude should use it."
    } else {
        description
    };
    format!(
        "---\nname: {name}\ndescription: {}\n---\n\n# {}\n\n## When to use\n\nSay when this skill applies. Claude reads the description above to decide.\n\n## Steps\n\n1. First step.\n2. Second step.\n\n## Notes\n\nAnything Claude should avoid, or where to find supporting files in this folder.\n",
        yaml_block(description),
        title_of(name),
    )
}

/// Creates `<root>/.claude/skills/<name>/SKILL.md` from a template. `root` is the
/// project folder (scope "project") or the home folder (scope "user"). An existing
/// skill is never touched, and a link anywhere on the way is refused.
pub fn create(root: &Path, scope: &str, name: &str, description: &str) -> Result<SkillInfo> {
    if scope != "user" && scope != "project" {
        bail!("Skills can be created for you or for a project");
    }
    let name = check_name(name)?;
    let target = writable_target(root, &[".claude", "skills", name, "SKILL.md"])?;
    if target.exists() || target.parent().is_some_and(|d| d.exists()) {
        bail!("A skill named {name} already exists");
    }
    write_atomic(&target, &template(name, description))?;
    let project = (scope == "project").then_some(root);
    let home = (scope == "user").then_some(root);
    list(project, home)
        .into_iter()
        .find(|s| s.id == format!("{scope}:{name}"))
        .ok_or_else(|| anyhow!("The skill was created but can't be read back"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kvistcode-skills-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    fn skill(base: &Path, dir: &str, body: &str) {
        let d = base.join(dir);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("SKILL.md"), body).unwrap();
    }

    #[test]
    fn lists_project_user_and_plugin_skills_with_scope() {
        let home = tmp("home");
        let project = tmp("proj");
        skill(
            &skills_dir(&home),
            "pdf",
            "---\nname: pdf\ndescription: Work with PDF files\n---\n# PDF\n",
        );
        skill(&skills_dir(&project), "deploy", "# Deploy\n\nShip it.\n");
        std::fs::create_dir_all(skills_dir(&project).join("empty-dir")).unwrap();
        skill(&skills_dir(&project), ".hidden", "# no\n");

        let plug = home.join(".claude/plugins/cache/mk/tools/1.0");
        skill(
            &plug.join("skills"),
            "lint",
            "---\ndescription: Lint it\n---\n",
        );
        std::fs::write(
            home.join(".claude/plugins/installed_plugins.json"),
            format!(
                r#"{{"version":2,"plugins":{{"tools@mk":[{{"scope":"user","installPath":{:?}}}]}}}}"#,
                plug.to_string_lossy()
            ),
        )
        .unwrap();

        let all = list(Some(&project), Some(&home));
        let ids: Vec<_> = all.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["project:deploy", "user:pdf", "plugin:tools/lint"]);
        assert_eq!(all[0].description, "Deploy");
        assert_eq!(all[1].description, "Work with PDF files");
        assert!(!all[1].read_only && all[2].read_only);
        assert_eq!(all[2].plugin.as_deref(), Some("tools"));
        // Without a project, only yours and plugins' show.
        assert_eq!(list(None, Some(&home)).len(), 2);
    }

    #[test]
    fn plugin_install_paths_outside_the_plugins_folder_are_ignored() {
        let home = tmp("plug-home");
        let elsewhere = tmp("elsewhere");
        skill(&elsewhere.join("skills"), "secret", "# Secret\n");
        std::fs::create_dir_all(home.join(".claude/plugins")).unwrap();
        std::fs::write(
            home.join(".claude/plugins/installed_plugins.json"),
            format!(
                r#"{{"plugins":{{"evil@mk":{{"installPath":{:?}}},"dots@mk":[{{"installPath":"{}/../../.."}}]}}}}"#,
                elsewhere.to_string_lossy(),
                home.join(".claude/plugins").to_string_lossy()
            ),
        )
        .unwrap();
        assert!(list(None, Some(&home)).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn project_skills_that_link_out_are_skipped_but_yours_may_be_linked() {
        let project = tmp("link-proj");
        let home = tmp("link-home");
        let dotfiles = tmp("dotfiles");
        skill(&dotfiles, "mine", "# Mine\n");
        skill(&dotfiles, "theirs", "# Theirs\n");
        std::fs::create_dir_all(skills_dir(&project)).unwrap();
        std::fs::create_dir_all(skills_dir(&home)).unwrap();
        std::os::unix::fs::symlink(dotfiles.join("theirs"), skills_dir(&project).join("theirs"))
            .unwrap();
        std::os::unix::fs::symlink(dotfiles.join("mine"), skills_dir(&home).join("mine")).unwrap();
        let all = list(Some(&project), Some(&home));
        let ids: Vec<_> = all.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["user:mine"]);
    }

    #[test]
    fn read_resolves_ids_only_and_shows_sibling_files() {
        let home = tmp("read-home");
        skill(&skills_dir(&home), "pdf", "# PDF\n");
        std::fs::create_dir_all(skills_dir(&home).join("pdf/scripts")).unwrap();
        std::fs::write(skills_dir(&home).join("pdf/notes.txt"), "x").unwrap();
        let doc = read(None, Some(&home), "user:pdf").unwrap();
        assert_eq!(doc.content, "# PDF\n");
        assert_eq!(doc.files, ["notes.txt", "scripts/"]);
        for bad in [
            "user:../pdf",
            "user:pdf/../../x",
            "../../etc/passwd",
            "project:pdf",
            "",
        ] {
            assert!(read(None, Some(&home), bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn create_writes_a_template_and_never_replaces() {
        let root = tmp("create");
        let made = create(&root, "project", "code-review", "Reviews \"diffs\"\nfast").unwrap();
        assert_eq!(made.id, "project:code-review");
        assert_eq!(made.name, "code-review");
        assert_eq!(made.description, "Reviews \"diffs\" fast");
        let text = std::fs::read_to_string(&made.path).unwrap();
        assert!(text.starts_with("---\nname: code-review\n"));
        assert!(text.contains("# Code review"));
        assert!(create(&root, "project", "code-review", "").is_err());
        assert!(std::fs::read_to_string(&made.path)
            .unwrap()
            .contains("Reviews"));
    }

    #[test]
    fn create_rejects_bad_names_and_scopes() {
        let root = tmp("names");
        for bad in [
            "", " ", "../evil", "a/b", "a\\b", "Upper", "-x", "x-", "a--b", ".hidden", "sp ace",
            "..", ".",
        ] {
            assert!(create(&root, "project", bad, "").is_err(), "{bad:?}");
        }
        assert!(create(&root, "plugin", "fine", "").is_err());
        assert!(!root.join(".claude").exists());
        let long = "a".repeat(MAX_NAME_CHARS + 1);
        assert!(create(&root, "user", &long, "").is_err());
        assert!(create(&root, "user", "fine", "").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn create_refuses_to_write_through_links() {
        let root = tmp("create-link");
        let outside = tmp("create-outside");
        std::fs::create_dir_all(root.join(".claude")).unwrap();
        std::os::unix::fs::symlink(&outside, skills_dir(&root)).unwrap();
        assert!(create(&root, "project", "sneaky", "").is_err());
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn titles_read_naturally() {
        assert_eq!(title_of("code-review"), "Code review");
        assert_eq!(title_of("pdf"), "Pdf");
    }
}
