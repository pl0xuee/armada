//! Git worktree isolation: every agent can get its own branch + checkout so
//! parallel agents never edit the same files.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{bail, Context};

async fn git(cwd: &Path, args: &[&str]) -> anyhow::Result<String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let out = cmd.output().await.context("running git")?;
    if !out.status.success() {
        bail!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub struct RepoInfo {
    pub toplevel: PathBuf,
    pub head_commit: String,
    pub branch: Option<String>,
}

/// None when `path` is not inside a git repo or the repo has no commits yet.
pub async fn repo_info(path: &Path) -> Option<RepoInfo> {
    let toplevel = git(path, &["rev-parse", "--show-toplevel"]).await.ok()?;
    let head_commit = git(path, &["rev-parse", "HEAD"]).await.ok()?;
    let branch = git(path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .ok()
        .filter(|b| b != "HEAD");
    Some(RepoInfo {
        toplevel: PathBuf::from(toplevel),
        head_commit,
        branch,
    })
}

pub struct Worktree {
    pub cwd: PathBuf,
    pub branch: String,
}

fn slugify(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 32 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

/// Creates `<data>/worktrees/<repo>-<id8>` on a new branch `armada/<slug>-<id8>`.
/// Returns the directory matching `project_path` inside the new worktree.
pub async fn create_worktree(
    project_path: &Path,
    repo: &RepoInfo,
    data_dir: &Path,
    agent_id: &str,
    title: &str,
) -> anyhow::Result<Worktree> {
    let short = &agent_id[..8.min(agent_id.len())];
    let repo_name = repo
        .toplevel
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".into());
    let slug = slugify(title);
    let branch = if slug.is_empty() {
        format!("armada/{short}")
    } else {
        format!("armada/{slug}-{short}")
    };
    let root = data_dir
        .join("worktrees")
        .join(format!("{}-{short}", slugify(&repo_name)));
    std::fs::create_dir_all(root.parent().unwrap_or(data_dir))?;
    let root_str = root.to_string_lossy().into_owned();
    git(
        &repo.toplevel,
        &[
            "worktree",
            "add",
            "-b",
            &branch,
            &root_str,
            &repo.head_commit,
        ],
    )
    .await?;
    let rel = project_path
        .canonicalize()
        .ok()
        .and_then(|p| {
            let top = repo.toplevel.canonicalize().ok()?;
            p.strip_prefix(&top).ok().map(Path::to_path_buf)
        })
        .unwrap_or_default();
    let cwd = if rel.as_os_str().is_empty() {
        root
    } else {
        root.join(rel)
    };
    Ok(Worktree { cwd, branch })
}

pub async fn remove_worktree(project_path: &Path, cwd: &Path, branch: Option<&str>) {
    let Ok(top) = git(cwd, &["rev-parse", "--show-toplevel"]).await else {
        return;
    };
    let top_str = top.clone();
    if let Err(e) = git(project_path, &["worktree", "remove", "--force", &top_str]).await {
        tracing::warn!("removing worktree {top}: {e:#}");
    }
    if let Some(branch) = branch {
        if let Err(e) = git(project_path, &["branch", "-D", branch]).await {
            tracing::warn!("deleting branch {branch}: {e:#}");
        }
    }
}
