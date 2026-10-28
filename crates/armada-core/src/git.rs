//! Git worktree isolation: every agent can get its own branch + checkout so
//! parallel agents never edit the same files.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, bail, Context};

use crate::model::UNSAVED_WORK_ERROR;

/// Default limit for one git command.
const GIT_TIMEOUT: Duration = Duration::from_secs(60);
/// `worktree add` checks out the whole tree, which takes a while in big repos.
const WORKTREE_ADD_TIMEOUT: Duration = Duration::from_secs(120);

async fn git(cwd: &Path, args: &[&str]) -> anyhow::Result<String> {
    git_with_timeout(cwd, args, GIT_TIMEOUT).await
}

async fn git_with_timeout(cwd: &Path, args: &[&str], timeout: Duration) -> anyhow::Result<String> {
    let mut cmd = tokio::process::Command::new("git");
    crate::childenv::sanitize_child_env(&mut cmd);
    cmd.args(args)
        .current_dir(cwd)
        // Never wait for credentials or an editor nobody can see.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let out = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| {
            anyhow!(
                "git {} didn't finish within {} seconds",
                args.join(" "),
                timeout.as_secs()
            )
        })?
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
    git_with_timeout(
        &repo.toplevel,
        &[
            // Deep node_modules/target paths exceed MAX_PATH on Windows otherwise.
            "-c",
            "core.longpaths=true",
            "worktree",
            "add",
            "-b",
            &branch,
            &root_str,
            &repo.head_commit,
        ],
        WORKTREE_ADD_TIMEOUT,
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

fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

/// The checkout `cwd` belongs to, if it still exists and is a git work tree.
async fn worktree_top(cwd: &Path) -> Option<PathBuf> {
    if !cwd.is_dir() {
        return None;
    }
    git(cwd, &["rev-parse", "--show-toplevel"])
        .await
        .ok()
        .map(PathBuf::from)
}

/// Whether `branch` exists in the repo at `repo`.
async fn branch_exists(repo: &Path, branch: &str) -> bool {
    git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .await
    .is_ok()
}

/// Describes what removing the agent's worktree (at `cwd`) and deleting `branch`
/// would lose: uncommitted changes, and commits that no other branch, remote branch
/// or tag contains. None when nothing would be lost. When git can't tell (broken
/// checkout, git missing), that is reported too, so nothing is deleted unchecked.
pub async fn unsaved_work(project_path: &Path, cwd: &Path, branch: Option<&str>) -> Option<String> {
    let mut problems = Vec::new();
    let top = worktree_top(cwd).await;
    let mut head = None;
    if let Some(top) = &top {
        match git(top, &["status", "--porcelain"]).await {
            Ok(status) => {
                let changes = status.lines().filter(|l| !l.trim().is_empty()).count();
                if changes > 0 {
                    problems.push(format!(
                        "{} in the worktree",
                        plural(changes, "uncommitted change", "uncommitted changes")
                    ));
                }
            }
            Err(e) => problems.push(format!("the worktree's status couldn't be read ({e:#})")),
        }
        head = git(top, &["rev-parse", "--verify", "--quiet", "HEAD"])
            .await
            .ok();
    }
    // Branch questions go to the main repository; the worktree may already be gone.
    let repo = if git(project_path, &["rev-parse", "--git-dir"]).await.is_ok() {
        Some(project_path.to_path_buf())
    } else {
        top.clone()
    };
    if let Some(repo) = repo {
        let mut tips: Vec<String> = Vec::new();
        if let Some(b) = branch {
            if branch_exists(&repo, b).await {
                tips.push(format!("refs/heads/{b}"));
            }
        }
        // A detached HEAD in the worktree can hold commits that are on no branch.
        tips.extend(head);
        if !tips.is_empty() {
            let mut args: Vec<String> = vec!["rev-list".into(), "--count".into()];
            args.extend(tips);
            args.push("--not".into());
            if let Some(b) = branch {
                args.push(format!("--exclude={b}"));
            }
            args.extend(["--branches".into(), "--remotes".into(), "--tags".into()]);
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            match git(&repo, &args).await {
                Ok(n) => {
                    let n: usize = n.trim().parse().unwrap_or(0);
                    if n > 0 {
                        let on = branch.map(|b| format!(" on {b}")).unwrap_or_default();
                        problems.push(format!(
                            "{}{on} that no other branch contains",
                            plural(n, "commit", "commits")
                        ));
                    }
                }
                Err(e) => problems.push(format!("the branch couldn't be checked ({e:#})")),
            }
        }
    }
    if problems.is_empty() {
        None
    } else {
        Some(format!(
            "{UNSAVED_WORK_ERROR}: {}. Delete anyway to discard them.",
            problems.join(" and ")
        ))
    }
}

/// Removes the agent's worktree and deletes its branch.
///
/// Without `force` this refuses (with an error starting with `UNSAVED_WORK_ERROR`)
/// when that would lose uncommitted changes or unmerged commits, and deletes the
/// branch with `git branch -d`. With `force` the worktree and branch go regardless.
/// A worktree folder that's already gone is pruned from git's records.
pub async fn remove_worktree(
    project_path: &Path,
    cwd: &Path,
    branch: Option<&str>,
    force: bool,
) -> anyhow::Result<()> {
    if !force {
        if let Some(problem) = unsaved_work(project_path, cwd, branch).await {
            bail!("{problem}");
        }
    }
    if git(project_path, &["rev-parse", "--git-dir"])
        .await
        .is_err()
    {
        tracing::warn!(
            "not removing the worktree at {}: {} is no longer a git repository",
            cwd.display(),
            project_path.display()
        );
        return Ok(());
    }
    match worktree_top(cwd).await {
        Some(top) => remove_checkout(project_path, &top, force).await?,
        None => {
            // The folder is gone already; forget it so the branch can be deleted.
            if let Err(e) = git(project_path, &["worktree", "prune"]).await {
                tracing::warn!("git worktree prune: {e:#}");
            }
        }
    }
    if let Some(branch) = branch {
        if branch_exists(project_path, branch).await {
            let flag = if force { "-D" } else { "-d" };
            if let Err(e) = git(project_path, &["branch", flag, branch]).await {
                // Nothing is lost by keeping it (the unsaved-work check passed, or
                // the user forced and only the branch survived).
                tracing::warn!("keeping branch {branch}: {e:#}");
            }
        }
    }
    Ok(())
}

/// `git worktree remove`, retried briefly: on Windows, antivirus scanners and
/// indexers hold files in a fresh checkout open for a moment.
async fn remove_checkout(project_path: &Path, top: &Path, force: bool) -> anyhow::Result<()> {
    let top_str = top.to_string_lossy().into_owned();
    let mut args = vec!["-c", "core.longpaths=true", "worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&top_str);
    let mut last_err = None;
    for delay_ms in [0u64, 250, 500] {
        if delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }
        match git(project_path, &args).await {
            Ok(_) => return Ok(()),
            Err(e) => last_err = Some(e),
        }
    }
    let err = last_err.unwrap_or_else(|| anyhow!("git worktree remove failed"));
    if !force {
        return Err(err.context(format!("couldn't remove the worktree at {top_str}")));
    }
    // Forced: delete the folder ourselves, then let git forget it. Only ever a
    // linked worktree (its `.git` is a file), never a main checkout.
    if !top.join(".git").is_file() {
        return Err(err.context(format!("{top_str} isn't a linked worktree")));
    }
    tracing::warn!("git worktree remove failed ({err:#}); deleting {top_str} directly");
    std::fs::remove_dir_all(top).with_context(|| format!("deleting {top_str}"))?;
    if let Err(e) = git(project_path, &["worktree", "prune"]).await {
        tracing::warn!("git worktree prune: {e:#}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh_git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[tokio::test]
    async fn refuses_to_lose_work_unless_forced() {
        let base =
            std::env::temp_dir().join(format!("armada-git-{}", uuid::Uuid::new_v4().simple()));
        let repo_dir = base.join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        sh_git(&repo_dir, &["init", "-q", "-b", "main"]);
        std::fs::write(repo_dir.join("a.txt"), "a").unwrap();
        sh_git(&repo_dir, &["add", "."]);
        sh_git(&repo_dir, &["commit", "-q", "-m", "a"]);
        let repo = repo_info(&repo_dir).await.unwrap();
        let data = base.join("data");

        // Clean worktree, no new commits: removed, branch deleted.
        let wt = create_worktree(&repo_dir, &repo, &data, "agent-1-xxxxxxxx", "Clean one")
            .await
            .unwrap();
        assert!(unsaved_work(&repo_dir, &wt.cwd, Some(&wt.branch))
            .await
            .is_none());
        remove_worktree(&repo_dir, &wt.cwd, Some(&wt.branch), false)
            .await
            .unwrap();
        assert!(!wt.cwd.exists());
        assert!(!branch_exists(&repo_dir, &wt.branch).await);

        // Uncommitted change: refused, then forced.
        let wt = create_worktree(&repo_dir, &repo, &data, "agent-2-xxxxxxxx", "Dirty")
            .await
            .unwrap();
        std::fs::write(wt.cwd.join("b.txt"), "b").unwrap();
        let err = remove_worktree(&repo_dir, &wt.cwd, Some(&wt.branch), false)
            .await
            .unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.starts_with(UNSAVED_WORK_ERROR), "{msg}");
        assert!(msg.contains("1 uncommitted change"), "{msg}");
        assert!(wt.cwd.join("b.txt").exists());

        // Committed but unmerged: still refused.
        sh_git(&wt.cwd, &["add", "."]);
        sh_git(&wt.cwd, &["commit", "-q", "-m", "b"]);
        let msg = unsaved_work(&repo_dir, &wt.cwd, Some(&wt.branch))
            .await
            .unwrap();
        assert!(msg.contains("1 commit on armada/dirty-agent-2"), "{msg}");
        // Merged into main: nothing to lose.
        sh_git(&repo_dir, &["merge", "-q", &wt.branch]);
        assert!(unsaved_work(&repo_dir, &wt.cwd, Some(&wt.branch))
            .await
            .is_none());

        // Unmerged work, forced.
        sh_git(&wt.cwd, &["commit", "-q", "--allow-empty", "-m", "c"]);
        assert!(unsaved_work(&repo_dir, &wt.cwd, Some(&wt.branch))
            .await
            .is_some());
        remove_worktree(&repo_dir, &wt.cwd, Some(&wt.branch), true)
            .await
            .unwrap();
        assert!(!wt.cwd.exists());
        assert!(!branch_exists(&repo_dir, &wt.branch).await);

        // Folder already deleted by hand: pruned, branch removed.
        let wt = create_worktree(&repo_dir, &repo, &data, "agent-3-xxxxxxxx", "Gone")
            .await
            .unwrap();
        std::fs::remove_dir_all(&wt.cwd).unwrap();
        remove_worktree(&repo_dir, &wt.cwd, Some(&wt.branch), false)
            .await
            .unwrap();
        assert!(!branch_exists(&repo_dir, &wt.branch).await);
        let list = git(&repo_dir, &["worktree", "list", "--porcelain"])
            .await
            .unwrap();
        assert_eq!(list.matches("worktree ").count(), 1, "{list}");

        let _ = std::fs::remove_dir_all(&base);
    }
}
