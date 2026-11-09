//! Starting a brand-new project: make its folder (name + parent), and by default turn it
//! into a git repo with a first commit, so each agent can get its own worktree right away
//! (`git::repo_info` ignores a repo that has no commits).

use crate::git;
use crate::providers::{expand_home, home_dir};
use anyhow::{bail, Context};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

const GIT_STEP_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_NAME_CHARS: usize = 100;

#[derive(Debug, Clone, Serialize)]
pub struct NewProject {
    /// The folder that was made.
    pub path: String,
    /// True when it is a git repo with a first commit.
    pub git: bool,
    /// A plain-words heads-up when the folder was made but git could not be set up.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Where new projects go unless the user picks another place: `~/Projects`.
pub fn default_parent() -> Option<PathBuf> {
    home_dir().map(|h| h.join("Projects"))
}

/// A folder name that is safe on Windows, macOS and Linux, or a plain-words reason why not.
pub fn clean_name(raw: &str) -> anyhow::Result<String> {
    let name = raw.trim();
    if name.is_empty() {
        bail!("Give the project a name.");
    }
    if name.chars().count() > MAX_NAME_CHARS {
        bail!("That name is too long. Keep it under {MAX_NAME_CHARS} letters.");
    }
    if name == "." || name == ".." {
        bail!("Pick a name with letters in it.");
    }
    if let Some(c) = name
        .chars()
        .find(|c| c.is_control() || "/\\<>:\"|?*".contains(*c))
    {
        if c.is_control() {
            bail!("The name can't contain control characters.");
        }
        bail!("The name can't contain {c}. Use letters, numbers, spaces, dashes or underscores.");
    }
    if name.ends_with('.') || name.ends_with(' ') {
        bail!("The name can't end with a dot or a space.");
    }
    // Windows refuses these device names whatever the extension.
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved {
        bail!("{name} is a reserved name on Windows. Pick another.");
    }
    Ok(name.to_string())
}

/// Makes `<parent>/<name>` and, when `init_git`, a git repo with one empty first commit.
/// `parent` is made too when missing (so the default `~/Projects` just works). Refuses a
/// folder that already has something in it: nothing existing is ever overwritten.
pub async fn create(parent: &str, name: &str, init_git: bool) -> anyhow::Result<NewProject> {
    let name = clean_name(name)?;
    let parent = parent.trim();
    if parent.is_empty() {
        bail!("Pick where the project should go.");
    }
    let parent = expand_home(parent);
    if !parent.is_absolute() {
        bail!("Pick a full folder path for where the project should go.");
    }
    if parent.exists() && !parent.is_dir() {
        bail!("{} is a file, not a folder.", parent.display());
    }
    std::fs::create_dir_all(&parent)
        .with_context(|| format!("Couldn't make the folder {}", parent.display()))?;
    let dir = parent.join(&name);
    match std::fs::symlink_metadata(&dir) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_dir() {
                bail!("{name} already exists there and isn't a folder. Pick another name.");
            }
            let empty = std::fs::read_dir(&dir)
                .with_context(|| format!("Couldn't open {}", dir.display()))?
                .next()
                .is_none();
            if !empty {
                bail!("A folder named {name} already exists there and isn't empty. Pick another name.");
            }
        }
        // create_dir (not _all) so a folder that appears in between is an error, not a merge.
        Err(_) => std::fs::create_dir(&dir)
            .with_context(|| format!("Couldn't make the folder {}", dir.display()))?,
    }
    let path = dir.to_string_lossy().into_owned();
    if !init_git {
        return Ok(NewProject {
            path,
            git: false,
            note: None,
        });
    }
    match init_repo(&dir).await {
        Ok(()) => Ok(NewProject {
            path,
            git: true,
            note: None,
        }),
        Err(e) => {
            tracing::warn!("new project {path}: git setup failed: {e:#}");
            Ok(NewProject {
                path,
                git: false,
                note: Some(
                    "The folder is ready, but git couldn't be set up. Install git and turn on \
                     git for this project so each agent can work on its own copy."
                        .into(),
                ),
            })
        }
    }
}

async fn run_git(dir: &Path, extra_env: &[(&str, &str)], args: &[&str]) -> anyhow::Result<String> {
    let mut cmd = git::hardened_command(dir).await?;
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let out = tokio::time::timeout(GIT_STEP_TIMEOUT, cmd.output())
        .await
        .map_err(|_| anyhow::anyhow!("git {} took too long", args.join(" ")))?
        .context("running git")?;
    if !out.status.success() {
        bail!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

async fn init_repo(dir: &Path) -> anyhow::Result<()> {
    // `-b` needs git 2.28; older gits get their default branch name.
    if run_git(dir, &[], &["init", "-b", "main"]).await.is_err() {
        run_git(dir, &[], &["init"]).await?;
    }
    // Commit with the user's own identity when they have one; otherwise a neutral one, so
    // the first commit works on a machine where git has never been set up.
    let has = |key: &'static str| async move {
        run_git(dir, &[], &["config", "--get", key])
            .await
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    };
    let mut env: Vec<(&str, &str)> = Vec::new();
    if !has("user.name").await {
        env.push(("GIT_AUTHOR_NAME", "Kvistcode"));
        env.push(("GIT_COMMITTER_NAME", "Kvistcode"));
    }
    if !has("user.email").await {
        env.push(("GIT_AUTHOR_EMAIL", "noreply@kvistcode.invalid"));
        env.push(("GIT_COMMITTER_EMAIL", "noreply@kvistcode.invalid"));
    }
    run_git(
        dir,
        &env,
        &[
            "commit",
            "--allow-empty",
            "--no-verify",
            "-m",
            "Start project",
        ],
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kvist-newproject-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn names_are_checked() {
        assert_eq!(clean_name("  My app ").unwrap(), "My app");
        assert_eq!(clean_name("site-2.0").unwrap(), "site-2.0");
        for bad in [
            "", "  ", ".", "..", "a/b", "a\\b", "a:b", "a*", "x.", "con", "NUL.txt", "Com1",
            "lpt9", "a\nb",
        ] {
            assert!(clean_name(bad).is_err(), "{bad:?} should be refused");
        }
        assert!(clean_name("com0").is_ok());
        assert!(clean_name("console").is_ok());
        assert!(clean_name(&"x".repeat(101)).is_err());
    }

    #[tokio::test]
    async fn makes_a_plain_folder_and_its_parent() {
        let root = tmp("plain");
        let parent = root.join("deep").join("Projects");
        let made = create(parent.to_str().unwrap(), "Blog", false)
            .await
            .unwrap();
        assert!(!made.git && made.note.is_none());
        assert!(Path::new(&made.path).is_dir());
        assert!(!Path::new(&made.path).join(".git").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn never_overwrites_and_allows_an_empty_folder() {
        let root = tmp("exists");
        let full = root.join("Full");
        std::fs::create_dir_all(&full).unwrap();
        std::fs::write(full.join("keep.txt"), "mine").unwrap();
        let err = create(root.to_str().unwrap(), "Full", false)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("isn't empty"), "{err}");
        assert_eq!(
            std::fs::read_to_string(full.join("keep.txt")).unwrap(),
            "mine"
        );

        std::fs::create_dir_all(root.join("Empty")).unwrap();
        assert!(create(root.to_str().unwrap(), "Empty", false).await.is_ok());

        std::fs::write(root.join("file"), "x").unwrap();
        assert!(create(root.join("file").to_str().unwrap(), "Sub", false)
            .await
            .is_err());
        assert!(create(root.to_str().unwrap(), "../escape", false)
            .await
            .is_err());
        assert!(create("relative/dir", "Sub", false).await.is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn git_projects_start_with_a_commit() {
        if std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let root = tmp("git");
        let made = create(root.to_str().unwrap(), "Repo", true).await.unwrap();
        assert!(made.git, "{:?}", made.note);
        let info = git::repo_info(Path::new(&made.path))
            .await
            .expect("a repo with a commit");
        assert!(!info.head_commit.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn refuses_a_symlinked_target() {
        let root = tmp("link");
        std::fs::create_dir_all(&root).unwrap();
        let elsewhere = root.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, root.join("Link")).unwrap();
        assert!(create(root.to_str().unwrap(), "Link", false).await.is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
