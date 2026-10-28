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

// ---- hardening -----------------------------------------------------------------
//
// An agent (or a repository it cloned) can write `.git/config`, so every git command
// Armada runs on its behalf must first neutralize the config keys that execute
// programs or redirect traffic. Only REPO-controlled scopes (local, worktree) are
// touched; the user's global and system config (git-lfs filters, credential helpers,
// their ssh command, their hooks) keep working.

/// What to pass to git (`-c key=value` pairs, in order) so repo-local config can't run
/// anything, plus the things that can't be neutralized and must refuse instead.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Hardening {
    pub args: Vec<String>,
    /// Set when pushing would go somewhere the repo's own config chose (URL rewrites,
    /// custom transports). The message is user-facing.
    pub push_blocker: Option<String>,
    /// Set when the repo defines a custom merge driver (which can't be disabled by `-c`).
    pub merge_blocker: Option<String>,
}

/// The message shown when a repo's config rewrites push URLs.
pub const PUSH_REDIRECT_ERROR: &str =
    "The repository's git config redirects pushes; review .git/config";

#[derive(Debug)]
struct ConfigEntry {
    scope: String,
    key: String,
    value: String,
}

impl ConfigEntry {
    fn repo_controlled(&self) -> bool {
        matches!(self.scope.as_str(), "local" | "worktree")
    }
    fn user_level(&self) -> bool {
        matches!(self.scope.as_str(), "system" | "global" | "command")
    }
}

/// Parses `git config --list -z --show-scope`: `scope NUL key NL value NUL` repeated.
fn parse_config_list(raw: &str) -> Vec<ConfigEntry> {
    let mut parts = raw.split('\0');
    let mut out = Vec::new();
    while let (Some(scope), Some(kv)) = (parts.next(), parts.next()) {
        if scope.is_empty() {
            break;
        }
        let (key, value) = kv.split_once('\n').unwrap_or((kv, ""));
        out.push(ConfigEntry {
            scope: scope.to_string(),
            key: key.to_string(),
            value: value.to_string(),
        });
    }
    out
}

/// `section.sub.name` split into (section, subsection, name); all lowercase except sub.
fn split_key(key: &str) -> (&str, &str, &str) {
    let Some((section, rest)) = key.split_once('.') else {
        return (key, "", "");
    };
    match rest.rsplit_once('.') {
        Some((sub, name)) => (section, sub, name),
        None => (section, "", rest),
    }
}

/// How an executable-ish key is neutralized.
enum Neutral {
    /// Single value: the user's own (global/system) value, else this default.
    Single(&'static str),
    /// Fixed value whatever the user has.
    Fixed(&'static str),
    /// Multi-valued (credential helpers): reset, then re-add the user's values.
    Multi,
    /// The hooks directory: the user's value, else `<git dir>/hooks`.
    Hooks,
}

fn neutral_for(key: &str) -> Option<Neutral> {
    let (section, sub, name) = split_key(key);
    Some(match (section, sub.is_empty(), name) {
        ("core", true, "pager") => Neutral::Single("cat"),
        ("core", true, "editor") | ("sequence", true, "editor") => Neutral::Single("true"),
        ("core", true, "sshcommand") => Neutral::Single("ssh"),
        ("core", true, "gitproxy") | ("core", true, "askpass") => Neutral::Single(""),
        ("core", true, "fsmonitor") => Neutral::Fixed("false"),
        ("core", true, "hookspath") => Neutral::Hooks,
        // diff.external / diff.*.command / diff.*.textconv can't be blanked with `-c`
        // (an empty program is run, and fails the diff). Callers that show diffs pass
        // --no-ext-diff --no-textconv instead.
        ("gpg", true, "program") | ("gpg", false, "program") => match sub {
            "x509" => Neutral::Single("gpgsm"),
            "ssh" => Neutral::Single("ssh-keygen"),
            _ => Neutral::Single("gpg"),
        },
        ("gpg", false, "defaultkeycommand") => Neutral::Single(""),
        ("filter", false, "clean") | ("filter", false, "smudge") | ("filter", false, "process") => {
            Neutral::Single("")
        }
        ("filter", false, "required") => Neutral::Single("false"),
        ("credential", _, "helper") => Neutral::Multi,
        _ => return None,
    })
}

/// Pure planning step, so it can be tested without git: `config` is the raw output of
/// `git config --list -z --show-scope`, `default_hooks` the repo's own hooks directory.
pub fn plan_hardening(config: &str, default_hooks: Option<&str>) -> anyhow::Result<Hardening> {
    let entries = parse_config_list(config);
    let mut plan = Hardening::default();
    for fixed in ["core.fsmonitor=false", "protocol.ext.allow=never"] {
        plan.args.push("-c".into());
        plan.args.push(fixed.into());
    }
    // Keys the repo sets, each handled once.
    let mut seen: Vec<&str> = Vec::new();
    for e in entries.iter().filter(|e| e.repo_controlled()) {
        let key = e.key.as_str();
        let (section, sub, name) = split_key(key);
        if (section == "url" && (name == "insteadof" || name == "pushinsteadof"))
            || (section == "remote" && matches!(name, "receivepack" | "uploadpack" | "vcs"))
        {
            plan.push_blocker = Some(PUSH_REDIRECT_ERROR.to_string());
        }
        if section == "merge" && name == "driver" && !sub.is_empty() {
            plan.merge_blocker = Some(
                "The repository defines a custom merge driver; review .git/config".to_string(),
            );
        }
        let Some(how) = neutral_for(key) else {
            continue;
        };
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        if key.contains('=') {
            // `-c` splits at the first '=', so this key can't be overridden.
            bail!("The repository's git config has an unsupported key: {key:?}");
        }
        let user: Vec<&str> = entries
            .iter()
            .filter(|u| u.user_level() && u.key == key)
            .map(|u| u.value.as_str())
            .collect();
        let mut set = |value: &str| {
            plan.args.push("-c".into());
            plan.args.push(format!("{key}={value}"));
        };
        match how {
            Neutral::Single(default) => set(user.last().copied().unwrap_or(default)),
            Neutral::Fixed(v) => set(v),
            Neutral::Multi => {
                set("");
                for v in user {
                    set(v);
                }
            }
            Neutral::Hooks => match user.last().copied().or(default_hooks) {
                Some(v) => set(v),
                None => bail!("couldn't work out the repository's hooks directory"),
            },
        }
    }
    Ok(plan)
}

/// Plain `git` with the app's environment hygiene, for the config read itself (which
/// executes nothing, but must not be hardened recursively).
async fn raw_git(cwd: &Path, args: &[&str]) -> anyhow::Result<std::process::Output> {
    let mut cmd = tokio::process::Command::new("git");
    crate::childenv::sanitize_child_env(&mut cmd);
    cmd.args(["-c", "core.fsmonitor=false"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    tokio::time::timeout(GIT_TIMEOUT, cmd.output())
        .await
        .map_err(|_| anyhow!("git didn't finish within {} seconds", GIT_TIMEOUT.as_secs()))?
        .context("running git")
}

/// Reads the repo's config at `cwd` and plans how to neutralize it. Outside a repo only
/// the fixed flags are returned.
pub async fn hardening(cwd: &Path) -> anyhow::Result<Hardening> {
    let out = raw_git(cwd, &["config", "--list", "-z", "--show-scope"]).await?;
    if !out.status.success() {
        bail!(
            "git config: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let raw = String::from_utf8_lossy(&out.stdout).into_owned();
    let needs_hooks = parse_config_list(&raw)
        .iter()
        .any(|e| e.repo_controlled() && e.key == "core.hookspath");
    let default_hooks = if needs_hooks {
        let common = raw_git(cwd, &["rev-parse", "--git-common-dir"]).await?;
        let dir = String::from_utf8_lossy(&common.stdout).trim().to_string();
        if common.status.success() && !dir.is_empty() {
            Some(cwd.join(dir).join("hooks").to_string_lossy().into_owned())
        } else {
            None
        }
    } else {
        None
    };
    plan_hardening(&raw, default_hooks.as_deref())
}

/// A `git` command for `cwd` with the repo-config hardening applied: no prompts,
/// sanitized environment, stdin closed, `kill_on_drop`. The caller adds the subcommand.
pub async fn hardened_command(cwd: &Path) -> anyhow::Result<tokio::process::Command> {
    let plan = hardening(cwd).await?;
    let mut cmd = tokio::process::Command::new("git");
    crate::childenv::sanitize_child_env(&mut cmd);
    cmd.args(&plan.args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    Ok(cmd)
}

async fn git_with_timeout(cwd: &Path, args: &[&str], timeout: Duration) -> anyhow::Result<String> {
    let mut cmd = hardened_command(cwd).await?;
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
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
    data_dir: &Path,
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
        Some(top) => remove_checkout(data_dir, project_path, &top, force).await?,
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

/// Whether `top` is a worktree Armada manages: its real path lies inside
/// `<data_dir>/worktrees/` and the project's `git worktree list` names it.
async fn check_managed_worktree(
    data_dir: &Path,
    project_path: &Path,
    top: &Path,
) -> Result<(), String> {
    let real = top
        .canonicalize()
        .map_err(|e| format!("not deleting {}: {e}", top.display()))?;
    let root = data_dir.join("worktrees").canonicalize().map_err(|e| {
        format!(
            "not deleting {}: no managed worktrees folder ({e})",
            top.display()
        )
    })?;
    if real == root || !real.starts_with(&root) {
        return Err(format!(
            "not deleting {}: it isn't inside Armada's worktrees folder",
            real.display()
        ));
    }
    let list = git(project_path, &["worktree", "list", "--porcelain"])
        .await
        .map_err(|e| format!("not deleting {}: {e:#}", real.display()))?;
    let listed = list
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .any(|p| Path::new(p).canonicalize().is_ok_and(|p| p == real));
    if !listed {
        return Err(format!(
            "not deleting {}: the project doesn't list it as a worktree",
            real.display()
        ));
    }
    Ok(())
}

/// `git worktree remove`, retried briefly: on Windows, antivirus scanners and
/// indexers hold files in a fresh checkout open for a moment.
async fn remove_checkout(
    data_dir: &Path,
    project_path: &Path,
    top: &Path,
    force: bool,
) -> anyhow::Result<()> {
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
    // Deleting a folder recursively is only for checkouts Armada made: inside its own
    // worktrees folder (symlinks resolved) and registered with the project's git.
    if let Err(refusal) = check_managed_worktree(data_dir, project_path, top).await {
        return Err(err.context(refusal));
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
        remove_worktree(&data, &repo_dir, &wt.cwd, Some(&wt.branch), false)
            .await
            .unwrap();
        assert!(!wt.cwd.exists());
        assert!(!branch_exists(&repo_dir, &wt.branch).await);

        // Uncommitted change: refused, then forced.
        let wt = create_worktree(&repo_dir, &repo, &data, "agent-2-xxxxxxxx", "Dirty")
            .await
            .unwrap();
        std::fs::write(wt.cwd.join("b.txt"), "b").unwrap();
        let err = remove_worktree(&data, &repo_dir, &wt.cwd, Some(&wt.branch), false)
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
        remove_worktree(&data, &repo_dir, &wt.cwd, Some(&wt.branch), true)
            .await
            .unwrap();
        assert!(!wt.cwd.exists());
        assert!(!branch_exists(&repo_dir, &wt.branch).await);

        // Folder already deleted by hand: pruned, branch removed.
        let wt = create_worktree(&repo_dir, &repo, &data, "agent-3-xxxxxxxx", "Gone")
            .await
            .unwrap();
        std::fs::remove_dir_all(&wt.cwd).unwrap();
        remove_worktree(&data, &repo_dir, &wt.cwd, Some(&wt.branch), false)
            .await
            .unwrap();
        assert!(!branch_exists(&repo_dir, &wt.branch).await);
        let list = git(&repo_dir, &["worktree", "list", "--porcelain"])
            .await
            .unwrap();
        assert_eq!(list.matches("worktree ").count(), 1, "{list}");

        let _ = std::fs::remove_dir_all(&base);
    }

    fn cfg(entries: &[(&str, &str, &str)]) -> String {
        entries
            .iter()
            .map(|(scope, key, value)| format!("{scope}\0{key}\n{value}\0"))
            .collect()
    }

    #[test]
    fn plan_neutralizes_only_repo_config() {
        let raw = cfg(&[
            ("global", "core.sshcommand", "ssh -i mykey"),
            ("global", "filter.lfs.clean", "git-lfs clean -- %f"),
            ("global", "credential.helper", "store"),
            ("local", "core.sshcommand", "evil"),
            ("local", "core.pager", "evil"),
            ("local", "core.editor", "evil"),
            ("local", "filter.lfs.clean", "evil"),
            ("local", "filter.lfs.smudge", "evil"),
            ("local", "filter.lfs.required", "true"),
            ("local", "credential.helper", "!evil"),
            ("local", "core.hookspath", ".evil"),
            ("local", "gpg.program", "evil"),
        ]);
        let plan = plan_hardening(&raw, Some("/r/.git/hooks")).unwrap();
        let args = plan.args.join(" ");
        assert!(args.contains("core.fsmonitor=false"));
        assert!(args.contains("protocol.ext.allow=never"));
        assert!(args.contains("core.sshcommand=ssh -i mykey"), "{args}");
        assert!(args.contains("core.pager=cat"));
        assert!(args.contains("core.editor=true"));
        assert!(args.contains("filter.lfs.clean=git-lfs clean -- %f"));
        assert!(args.contains("filter.lfs.smudge= "), "{args}");
        assert!(args.contains("filter.lfs.required=false"));
        assert!(args.contains("credential.helper= -c credential.helper=store"));
        assert!(args.contains("core.hookspath=/r/.git/hooks"));
        assert!(args.contains("gpg.program=gpg"));
        assert!(!args.contains("evil"));
        assert!(plan.push_blocker.is_none());
    }

    #[test]
    fn plan_leaves_user_config_alone_and_flags_redirects() {
        let raw = cfg(&[
            ("global", "core.pager", "less"),
            ("global", "core.hookspath", "/home/me/hooks"),
            (
                "global",
                "url.git@github.com:.insteadof",
                "https://github.com/",
            ),
        ]);
        let plan = plan_hardening(&raw, None).unwrap();
        assert_eq!(plan.args.len(), 4, "{:?}", plan.args);
        assert!(plan.push_blocker.is_none());

        let raw = cfg(&[(
            "local",
            "url.https://evil/.pushinsteadof",
            "https://github.com/",
        )]);
        let plan = plan_hardening(&raw, None).unwrap();
        assert_eq!(plan.push_blocker.as_deref(), Some(PUSH_REDIRECT_ERROR));
        let raw = cfg(&[("worktree", "merge.x.driver", "evil %A")]);
        assert!(plan_hardening(&raw, None).unwrap().merge_blocker.is_some());
        let raw = cfg(&[("local", "filter.a=b.clean", "evil")]);
        assert!(plan_hardening(&raw, None).is_err());
    }

    /// A repository whose local config tries every way to run `marker`.
    fn booby_trapped_repo(base: &Path) -> (PathBuf, PathBuf) {
        let repo = base.join("trap");
        std::fs::create_dir_all(&repo).unwrap();
        sh_git(&repo, &["init", "-q", "-b", "main"]);
        let marker = base.join("ran");
        let cmd = format!("touch {}", marker.display());
        std::fs::write(repo.join(".gitattributes"), "*.dat filter=bad\n").unwrap();
        std::fs::write(repo.join("a.dat"), "a").unwrap();
        std::fs::write(repo.join("a.txt"), "a").unwrap();
        sh_git(&repo, &["add", "a.txt", ".gitattributes"]);
        sh_git(&repo, &["commit", "-q", "-m", "a"]);
        let hook = base.join("hook-sh");
        std::fs::write(&hook, format!("#!/bin/sh\n{cmd}\n")).unwrap();
        let fsm = base.join("fsmon.sh");
        std::fs::write(&fsm, format!("#!/bin/sh\n{cmd}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for f in [&hook, &fsm] {
                std::fs::set_permissions(f, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        std::fs::create_dir_all(repo.join("evil-hooks")).unwrap();
        std::fs::copy(&hook, repo.join("evil-hooks/post-checkout")).unwrap();
        std::fs::copy(&hook, repo.join("evil-hooks/post-commit")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for h in ["post-checkout", "post-commit"] {
                let f = repo.join("evil-hooks").join(h);
                std::fs::set_permissions(f, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        for (k, v) in [
            ("core.fsmonitor", fsm.to_str().unwrap().to_string()),
            ("filter.bad.clean", cmd.clone()),
            ("filter.bad.smudge", cmd.clone()),
            ("filter.bad.required", "true".into()),
            ("core.sshCommand", cmd.clone()),
            ("core.pager", cmd.clone()),
            ("core.editor", cmd.clone()),
            ("core.hooksPath", "evil-hooks".into()),
            ("alias.status", format!("!{cmd}")),
            ("diff.external", cmd.clone()),
            ("credential.helper", format!("!{cmd}")),
        ] {
            sh_git(&repo, &["config", k, &v]);
        }
        (repo, marker)
    }

    #[tokio::test]
    async fn repo_config_commands_never_run() {
        let base =
            std::env::temp_dir().join(format!("armada-git-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&base).unwrap();
        let (repo, marker) = booby_trapped_repo(&base);
        git(&repo, &["status", "--porcelain"]).await.unwrap();
        git(&repo, &["add", "-A"]).await.unwrap();
        git(
            &repo,
            &[
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "-m",
                "b",
            ],
        )
        .await
        .unwrap();
        git(&repo, &["checkout", "-q", "-b", "other"])
            .await
            .unwrap();
        git(&repo, &["diff", "--no-ext-diff", "--no-textconv", "HEAD~1"])
            .await
            .unwrap();
        assert!(!marker.exists(), "a repo-configured command ran");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn global_filters_still_apply() {
        let base =
            std::env::temp_dir().join(format!("armada-git-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&base).unwrap();
        let repo = base.join("r");
        std::fs::create_dir_all(&repo).unwrap();
        sh_git(&repo, &["init", "-q", "-b", "main"]);
        let global = base.join("gitconfig");
        std::fs::write(&global, "[filter \"up\"]\n\tclean = tr a-z A-Z\n").unwrap();
        std::fs::write(repo.join(".gitattributes"), "*.txt filter=up\n").unwrap();
        std::fs::write(repo.join("f.txt"), "hello\n").unwrap();
        // The repo also tries to replace the global driver.
        sh_git(&repo, &["config", "filter.up.clean", "echo pwned"]);
        // Hardening reads the user's config through the environment, as in the app.
        std::env::set_var("GIT_CONFIG_GLOBAL", &global);
        git(&repo, &["add", "f.txt"]).await.unwrap();
        let blob = git(&repo, &["show", ":f.txt"]).await.unwrap();
        std::env::remove_var("GIT_CONFIG_GLOBAL");
        assert_eq!(blob, "HELLO", "global filter should still run");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn forced_removal_only_deletes_managed_worktrees() {
        let base =
            std::env::temp_dir().join(format!("armada-git-{}", uuid::Uuid::new_v4().simple()));
        let repo_dir = base.join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        sh_git(&repo_dir, &["init", "-q", "-b", "main"]);
        std::fs::write(repo_dir.join("a.txt"), "a").unwrap();
        sh_git(&repo_dir, &["add", "."]);
        sh_git(&repo_dir, &["commit", "-q", "-m", "a"]);
        let data = base.join("data");
        std::fs::create_dir_all(data.join("worktrees")).unwrap();

        // A worktree outside the managed folder, reached through a symlink inside it.
        let outside = base.join("outside-wt");
        sh_git(
            &repo_dir,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "o",
                outside.to_str().unwrap(),
            ],
        );
        sh_git(&repo_dir, &["worktree", "lock", outside.to_str().unwrap()]);
        let link = data.join("worktrees").join("link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let err = remove_worktree(&data, &repo_dir, &link, None, true).await;
        assert!(
            err.is_err(),
            "must refuse to delete outside the managed folder"
        );
        assert!(outside.join("a.txt").exists());

        // A locked, managed worktree is deleted by the fallback.
        let managed = data.join("worktrees").join("m");
        sh_git(
            &repo_dir,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "m",
                managed.to_str().unwrap(),
            ],
        );
        sh_git(&repo_dir, &["worktree", "lock", managed.to_str().unwrap()]);
        remove_worktree(&data, &repo_dir, &managed, Some("m"), true)
            .await
            .unwrap();
        assert!(!managed.exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
