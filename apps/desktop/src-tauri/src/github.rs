//! GitHub for agents' work: whether `gh` is signed in and git can use that sign-in, pushing
//! a branch, and turning a folder into a new GitHub repository.
//!
//! Armada runs git and `gh` with prompts switched off (a GUI app has nowhere to answer
//! them), so an HTTPS push only works when git has a credential helper that already knows
//! the token. `gh auth setup-git` installs one; [`setup_git`] is that step, run on request.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail};
use armada_core::Agent;
use serde::Serialize;

use crate::git_review::{
    agent_cwd, commit_all, git, last_url, looks_like_secret, output, push_remote, run_opts, Opts,
    PUSH_TIMEOUT,
};

const HOST: &str = "github.com";

/// Where `gh` and global git config are asked from when no repository is involved.
fn neutral_dir() -> PathBuf {
    armada_core::providers::home_dir().unwrap_or_else(std::env::temp_dir)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    /// The GitHub CLI is on PATH.
    pub gh_installed: bool,
    /// `gh` holds a login for github.com.
    pub logged_in: bool,
    /// The account's login name, when known.
    pub user: Option<String>,
    /// git has a credential helper configured, so HTTPS pushes can authenticate without a
    /// prompt.
    pub git_ready: bool,
}

pub async fn status() -> GithubStatus {
    let cwd = neutral_dir();
    let none = GithubStatus {
        gh_installed: false,
        logged_in: false,
        user: None,
        git_ready: false,
    };
    if armada_core::providers::resolve_program("gh").is_none() {
        return none;
    }
    let logged_in = output(
        "gh",
        &cwd,
        &["auth", "status", "--hostname", HOST],
        Opts::default(),
    )
    .await
    .map(|o| o.status.success())
    .unwrap_or(false);
    let user = if logged_in {
        run_opts(
            "gh",
            &cwd,
            &["api", "user", "--jq", ".login"],
            Opts::default(),
        )
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    } else {
        None
    };
    GithubStatus {
        gh_installed: true,
        logged_in,
        user,
        git_ready: git_has_credential_helper(&cwd).await,
    }
}

/// A `credential.*helper` that can keep a login between runs: anything with a value except
/// `cache` (a short-lived in-memory store that can't have been given GitHub's token from here).
async fn git_has_credential_helper(cwd: &Path) -> bool {
    let Ok(out) = output(
        "git",
        cwd,
        &["config", "--get-regexp", r"^credential\..*helper$"],
        Opts::default(),
    )
    .await
    else {
        return false;
    };
    helper_values(&String::from_utf8_lossy(&out.stdout))
}

/// Whether `git config --get-regexp` output ("key value" lines) names a persistent helper.
fn helper_values(config: &str) -> bool {
    config.lines().any(|l| {
        // An empty value only resets the helper list.
        l.split_once(char::is_whitespace).is_some_and(|(_, v)| {
            let v = v.trim();
            !v.is_empty() && !v.starts_with("cache")
        })
    })
}

/// Lets git authenticate to GitHub with `gh`'s login (`gh auth setup-git`), which is
/// what makes `git push` over HTTPS work without a terminal.
pub async fn setup_git() -> anyhow::Result<()> {
    let cwd = neutral_dir();
    run_opts(
        "gh",
        &cwd,
        &["auth", "setup-git", "--hostname", HOST],
        Opts::default(),
    )
    .await?;
    Ok(())
}

/// The arguments of the interactive sign-in run in the terminal window.
pub fn login_args() -> Vec<&'static str> {
    vec![
        "auth",
        "login",
        "--hostname",
        HOST,
        "--git-protocol",
        "https",
        "--web",
    ]
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// The folder is inside a git work tree.
    pub is_repo: bool,
    pub has_commits: bool,
    /// Checked-out branch (also before the first commit).
    pub branch: Option<String>,
    pub remotes: Vec<GitRemote>,
    /// A valid repository name derived from the folder's name.
    pub suggested_name: String,
}

pub async fn repo_info(path: &Path) -> anyhow::Result<RepoInfo> {
    if !path.is_dir() {
        bail!("{} is not a folder", path.display());
    }
    let suggested_name = suggest_name(path);
    if !armada_core::git_work_tree(path).await {
        return Ok(RepoInfo {
            is_repo: false,
            has_commits: false,
            branch: None,
            remotes: Vec::new(),
            suggested_name,
        });
    }
    let has_commits = output(
        "git",
        path,
        &["rev-parse", "--verify", "-q", "HEAD"],
        Opts::default(),
    )
    .await
    .map(|o| o.status.success())
    .unwrap_or(false);
    let branch = git(path, &["symbolic-ref", "--short", "-q", "HEAD"])
        .await
        .ok()
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty());
    let mut remotes = Vec::new();
    for line in git(path, &["remote", "-v"])
        .await
        .unwrap_or_default()
        .lines()
    {
        // "origin\thttps://github.com/o/r.git (fetch)"
        let mut parts = line.split_whitespace();
        if let (Some(name), Some(url), Some("(fetch)")) = (parts.next(), parts.next(), parts.next())
        {
            remotes.push(GitRemote {
                name: name.to_string(),
                url: url.to_string(),
            });
        }
    }
    Ok(RepoInfo {
        is_repo: true,
        has_commits,
        branch,
        remotes,
        suggested_name,
    })
}

/// The folder's name with anything GitHub rejects in a repository name replaced by `-`.
fn suggest_name(path: &Path) -> String {
    let raw = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches(|c| c == '-' || c == '.').to_string();
    if cleaned.is_empty() {
        "my-project".into()
    } else {
        cleaned
    }
}

/// `name` or `owner/name`, in the characters GitHub allows.
fn validate_repo_name(name: &str) -> anyhow::Result<()> {
    let part_ok = |p: &str| {
        !p.is_empty()
            && p.len() <= 100
            && !p.starts_with('-')
            && p != "."
            && p != ".."
            && p.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    let mut parts = name.split('/');
    let ok = match (parts.next(), parts.next(), parts.next()) {
        (Some(repo), None, _) => part_ok(repo),
        (Some(owner), Some(repo), None) => part_ok(owner) && part_ok(repo),
        _ => false,
    };
    if !ok {
        bail!("“{name}” isn't a valid repository name. Use letters, numbers, `.`, `-` and `_` (optionally as owner/name).");
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    /// The new repository's address.
    pub url: String,
    /// Short hash of the first commit, when Armada had to make one.
    pub committed: Option<String>,
    /// Files with secret-looking names that were left out of that first commit.
    pub left_out: Vec<String>,
}

/// Makes `path` a git repository if it isn't, commits what's there if the repository has
/// no commits yet (leaving out secret-looking files), creates the repository on GitHub
/// and pushes the current branch to it as `origin`.
pub async fn publish(
    path: &Path,
    name: &str,
    private: bool,
    description: &str,
) -> anyhow::Result<PublishResult> {
    let name = name.trim();
    validate_repo_name(name)?;
    let st = status().await;
    if !st.gh_installed {
        bail!("The GitHub CLI (gh) is not installed. Get it from https://cli.github.com");
    }
    if !st.logged_in {
        bail!("Sign in to GitHub first.");
    }
    let info = repo_info(path).await?;
    if let Some(origin) = info.remotes.iter().find(|r| r.name == "origin") {
        bail!(
            "This repository already has a remote named origin ({}). Push to it instead.",
            origin.url
        );
    }
    let (committed, left_out) = prepare_repo(path, info).await?;
    let mut args = vec![
        "repo",
        "create",
        name,
        if private { "--private" } else { "--public" },
        "--source",
        ".",
        "--remote",
        "origin",
        "--push",
    ];
    let description = description.trim();
    if !description.is_empty() {
        args.extend(["--description", description]);
    }
    let created = run_opts(
        "gh",
        path,
        &args,
        Opts {
            timeout: Some(PUSH_TIMEOUT),
            ..Opts::default()
        },
    )
    .await;
    let out = match created {
        Ok(out) => out,
        Err(e) => return Err(explain_push_failure(e)),
    };
    let url = match last_url(&out) {
        Some(url) => url,
        None => git(path, &["remote", "get-url", "origin"])
            .await
            .map(|u| u.trim().to_string())
            .map_err(|_| anyhow!("The repository was created, but its address couldn't be read"))?,
    };
    Ok(PublishResult {
        url,
        committed,
        left_out,
    })
}

/// Makes the folder a git repository (on `main`) if it isn't one, and makes a first commit
/// if the repository has none, leaving out secret-looking files. Returns the commit's
/// short hash (when one was made) and the files left out.
async fn prepare_repo(
    path: &Path,
    mut info: RepoInfo,
) -> anyhow::Result<(Option<String>, Vec<String>)> {
    if !info.is_repo {
        git(path, &["init", "-q"]).await?;
        // `git init -b` needs git 2.28; this works everywhere.
        git(path, &["symbolic-ref", "HEAD", "refs/heads/main"]).await?;
        info = repo_info(path).await?;
    }
    if info.has_commits {
        return Ok((None, Vec::new()));
    }
    let untracked = git(path, &["ls-files", "--others", "--exclude-standard", "-z"]).await?;
    let left_out: Vec<String> = untracked
        .split('\0')
        .filter(|p| !p.is_empty() && looks_like_secret(p))
        .map(str::to_string)
        .collect();
    match commit_all(path, "Initial commit", &left_out).await {
        Ok(summary) => Ok((Some(summary.hash), left_out)),
        Err(e) if e.is::<crate::git_review::NothingToCommit>() => {
            bail!("There's nothing in this folder to publish yet. Add some files, then try again.")
        }
        Err(e) => {
            let text = format!("{e:#}");
            if text.contains("tell me who you are") || text.contains("empty ident") {
                bail!("git doesn't know who you are, so it can't make the first commit. Run `git config --global user.name \"Your Name\"` and `git config --global user.email you@example.com`, then try again.");
            }
            Err(e)
        }
    }
}

/// Pushes the agent's checked-out branch to the remote it tracks (else `origin`), never
/// forced, setting it as the upstream. Returns a line for the UI.
pub async fn push_agent(agent: &Agent) -> anyhow::Result<String> {
    let cwd = agent_cwd(agent)?;
    let branch = git(cwd, &["symbolic-ref", "--short", "-q", "HEAD"])
        .await
        .map(|b| b.trim().to_string())
        .ok()
        .filter(|b| !b.is_empty())
        .ok_or_else(|| {
            anyhow!("The agent isn't on a branch (detached HEAD), so there's nothing to push.")
        })?;
    if output(
        "git",
        cwd,
        &["rev-parse", "--verify", "-q", "HEAD"],
        Opts::default(),
    )
    .await
    .map(|o| !o.status.success())
    .unwrap_or(true)
    {
        bail!("There are no commits to push yet. Commit first.");
    }
    let remote = push_remote(cwd, &branch).await.map_err(|e| {
        anyhow!("{e:#} If this folder isn't on GitHub yet, use “Publish to GitHub”.")
    })?;
    let pushed = run_opts(
        "git",
        cwd,
        &[
            "push",
            "-u",
            &remote,
            &format!("refs/heads/{branch}:refs/heads/{branch}"),
        ],
        Opts {
            timeout: Some(PUSH_TIMEOUT),
            ..Opts::default()
        },
    )
    .await;
    if let Err(e) = pushed {
        let text = format!("{e:#}");
        if text.contains("non-fast-forward")
            || text.contains("fetch first")
            || text.contains("[rejected]")
        {
            bail!("{remote}/{branch} has commits this branch doesn't; pull or merge them first (Armada never force-pushes).");
        }
        return Err(explain_push_failure(e));
    }
    Ok(format!("Pushed {branch} to {remote}"))
}

/// Whether a failed push/clone reads as "git had no usable credentials".
pub fn is_auth_failure(text: &str) -> bool {
    const SIGNS: [&str; 8] = [
        "terminal prompts disabled",
        "could not read Username",
        "could not read Password",
        "Authentication failed",
        "Invalid username or password",
        "Permission denied (publickey)",
        "returned error: 401",
        "returned error: 403",
    ];
    SIGNS.iter().any(|s| text.contains(s))
}

/// Adds the way out to a push that failed for lack of credentials; other errors pass
/// through untouched.
pub fn explain_push_failure(e: anyhow::Error) -> anyhow::Error {
    let text = format!("{e:#}");
    if is_auth_failure(&text) {
        e.context("GitHub didn't accept Armada's credentials. Sign in to GitHub and connect git to it with the GitHub button in the Review panel, or check that you can write to this repository")
    } else {
        e
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_checked() {
        for ok in ["repo", "my.repo-1_x", "owner/repo", "a"] {
            assert!(validate_repo_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "", "-x", "a b", "a/b/c", "/x", "x/", "..", "o/..", "a;b", "é",
        ] {
            assert!(validate_repo_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn folder_names_become_repo_names() {
        assert_eq!(suggest_name(Path::new("/x/My App (v2)")), "My-App--v2");
        assert_eq!(suggest_name(Path::new("/x/.hidden")), "hidden");
        assert_eq!(suggest_name(Path::new("/")), "my-project");
    }

    #[test]
    fn only_persistent_credential_helpers_count() {
        assert!(helper_values(
            "credential.https://github.com.helper !gh auth git-credential\n"
        ));
        assert!(helper_values("credential.helper osxkeychain\n"));
        assert!(helper_values("credential.helper libsecret\n"));
        // A reset line, nothing, and an in-memory cache don't make pushes work from a GUI.
        assert!(!helper_values("credential.https://github.com.helper \n"));
        assert!(!helper_values(""));
        assert!(!helper_values("credential.helper cache --timeout=3600\n"));
    }

    #[test]
    fn auth_failures_are_recognised() {
        assert!(is_auth_failure(
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
        ));
        assert!(is_auth_failure("remote: Invalid username or password."));
        assert!(!is_auth_failure(
            "! [rejected] main -> main (non-fast-forward)"
        ));
    }

    #[tokio::test]
    async fn a_plain_folder_becomes_a_repo_with_a_first_commit_minus_secrets() {
        for (k, v) in [
            ("GIT_AUTHOR_NAME", "T"),
            ("GIT_AUTHOR_EMAIL", "t@example.invalid"),
            ("GIT_COMMITTER_NAME", "T"),
            ("GIT_COMMITTER_EMAIL", "t@example.invalid"),
        ] {
            std::env::set_var(k, v);
        }
        let dir = std::env::temp_dir().join(format!("armada-gh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // Not inside any repository: a stray one in the temp dir's parents would hide the init.
        let dir = dir.canonicalize().unwrap();
        std::fs::write(dir.join("main.rs"), "fn main() {}").unwrap();
        std::fs::write(dir.join(".env"), "TOKEN=1").unwrap();

        let before = repo_info(&dir).await.unwrap();
        assert!(!before.is_repo);
        let (hash, left_out) = prepare_repo(&dir, before).await.unwrap();
        assert!(hash.is_some());
        assert_eq!(left_out, vec![".env".to_string()]);

        let after = repo_info(&dir).await.unwrap();
        assert!(after.is_repo && after.has_commits);
        assert_eq!(after.branch.as_deref(), Some("main"));
        let tracked = git(&dir, &["ls-files"]).await.unwrap();
        assert_eq!(tracked.trim(), "main.rs");
        // A second run changes nothing.
        let (again, _) = prepare_repo(&dir, after).await.unwrap();
        assert!(again.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_empty_folder_is_refused() {
        let dir = std::env::temp_dir().join(format!("armada-gh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let info = repo_info(&dir).await.unwrap();
        let err = prepare_repo(&dir, info).await.unwrap_err();
        assert!(
            format!("{err:#}").contains("nothing in this folder"),
            "{err:#}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
