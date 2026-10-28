//! Diff review, commit, merge and PR creation for an agent's working copy.
//! Shells out to `git` / `gh` so it behaves exactly like the user's own tools.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;

use anyhow::{anyhow, bail, Context};
use armada_core::Agent;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub status: ChangeStatus,
    pub additions: i64,
    pub deletions: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDiff {
    pub files: Vec<ChangedFile>,
    pub patch: String,
    pub ahead: i64,
}

async fn run(program: &str, cwd: &Path, args: &[&str]) -> anyhow::Result<String> {
    run_env(program, cwd, args, &[]).await
}

async fn run_env(
    program: &str,
    cwd: &Path,
    args: &[&str],
    envs: &[(&str, &OsStr)],
) -> anyhow::Result<String> {
    let out = output(program, cwd, args, envs).await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let msg = if stderr.is_empty() { stdout } else { stderr };
        // Skip global flags ("-c key=value", "--literal-pathspecs") to name the subcommand.
        let mut rest = args.iter().copied();
        let mut subcommand = "";
        while let Some(arg) = rest.next() {
            if arg == "-c" {
                rest.next();
            } else if !arg.starts_with("--") {
                subcommand = arg;
                break;
            }
        }
        bail!(
            "{program} {subcommand} failed: {}",
            if msg.is_empty() {
                format!("exit status {}", out.status)
            } else {
                msg
            }
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

async fn output(
    program: &str,
    cwd: &Path,
    args: &[&str],
    envs: &[(&str, &OsStr)],
) -> anyhow::Result<std::process::Output> {
    let exe = which::which(program).map_err(|_| match program {
        "gh" => anyhow!("The GitHub CLI (gh) is not installed. Get it from https://cli.github.com"),
        _ => anyhow!("{program} is not installed or not on PATH"),
    })?;
    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .envs(envs.iter().copied());
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: don't flash console windows from a GUI app.
        cmd.creation_flags(0x0800_0000);
    }
    cmd.output()
        .await
        .with_context(|| format!("running {program}"))
}

async fn git(cwd: &Path, args: &[&str]) -> anyhow::Result<String> {
    run("git", cwd, args).await
}

fn agent_cwd(agent: &Agent) -> anyhow::Result<&Path> {
    let cwd = Path::new(&agent.cwd);
    if !cwd.is_dir() {
        bail!("The agent's folder no longer exists: {}", agent.cwd);
    }
    Ok(cwd)
}

/// Git for viewing a diff on the user's behalf. An agent can write `.git/config` and
/// `.gitattributes`, so merely looking at its changes must not run anything those
/// configure: fsmonitor hooks and clean/smudge/process filters are switched off here,
/// and every diff also passes `--no-ext-diff --no-textconv`. Optional locks are
/// disabled so git never rewrites the user's index behind their back.
struct ReadOnlyGit<'a> {
    cwd: &'a Path,
    flags: Vec<String>,
    index: Option<PathBuf>,
}

impl<'a> ReadOnlyGit<'a> {
    const BASE_FLAGS: [&'static str; 4] = [
        "-c",
        "core.fsmonitor=false",
        // Keep writes to a temporary index self-contained (no sharedindex.* in .git).
        "-c",
        "core.splitIndex=false",
    ];

    async fn new(cwd: &'a Path) -> anyhow::Result<Self> {
        let mut git = ReadOnlyGit {
            cwd,
            flags: Self::BASE_FLAGS.iter().map(|s| s.to_string()).collect(),
            index: None,
        };
        // Reading config executes nothing. Exit status 1 = no filter configured.
        let out = output(
            "git",
            cwd,
            &[
                "-c",
                "core.fsmonitor=false",
                "config",
                "--null",
                "--get-regexp",
                r"^filter\.",
            ],
            &[],
        )
        .await?;
        if !out.status.success() && out.status.code() != Some(1) {
            bail!(
                "git config failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        for name in filter_drivers(&String::from_utf8_lossy(&out.stdout)) {
            if name.contains('=') {
                // `-c` splits at the first '=', so this driver can't be overridden.
                bail!("Refusing to show the diff: the repository configures a git filter named {name:?}");
            }
            for (key, value) in [
                ("clean", ""),
                ("smudge", ""),
                ("process", ""),
                ("required", "false"),
            ] {
                git.flags.push("-c".into());
                git.flags.push(format!("filter.{name}.{key}={value}"));
            }
        }
        Ok(git)
    }

    async fn run(&self, args: &[&str]) -> anyhow::Result<String> {
        let all: Vec<&str> = self
            .flags
            .iter()
            .map(String::as_str)
            .chain(args.iter().copied())
            .collect();
        let mut envs: Vec<(&str, &OsStr)> = vec![("GIT_OPTIONAL_LOCKS", OsStr::new("0"))];
        if let Some(index) = &self.index {
            envs.push(("GIT_INDEX_FILE", index.as_os_str()));
        }
        run_env("git", self.cwd, &all, &envs).await
    }
}

/// Driver names from `git config --null --get-regexp '^filter\.'` ("key\nvalue\0"…).
fn filter_drivers(out: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for entry in out.split('\0').filter(|e| !e.is_empty()) {
        let key = entry.split('\n').next().unwrap_or_default();
        let Some(rest) = key.strip_prefix("filter.") else {
            continue;
        };
        // filter.<name>.<variable>; <name> may itself contain dots.
        if let Some((name, _variable)) = rest.rsplit_once('.') {
            if !names.iter().any(|n| n == name) {
                names.push(name.to_string());
            }
        }
    }
    names
}

/// A private copy of the repository's index, removed on drop. `git add -N` (needed so
/// brand-new files appear in the diff) writes to this copy, never the user's index.
struct TempIndex(PathBuf);

impl TempIndex {
    async fn copy_of(git: &ReadOnlyGit<'_>) -> anyhow::Result<Self> {
        let real = git
            .run(&["rev-parse", "--path-format=absolute", "--git-path", "index"])
            .await?;
        // Absolute already; the join only matters for very old git versions.
        let real = plain_path(&git.cwd.join(real.trim_end_matches(['\r', '\n'])));
        let name = format!("armada-index-{}", uuid::Uuid::new_v4());
        // Next to the real index (same permissions as the repository) when possible.
        let mut candidates = Vec::new();
        if let Some(dir) = real.parent() {
            candidates.push(dir.join(&name));
        }
        candidates.push(std::env::temp_dir().join(&name));
        let mut last_err = None;
        for tmp in candidates {
            match tokio::fs::copy(&real, &tmp).await {
                Ok(_) => return Ok(TempIndex(tmp)),
                // No index yet (fresh repository): git starts from an empty one.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && !real.exists() => {
                    if tmp.parent().is_some_and(Path::is_dir) {
                        return Ok(TempIndex(tmp));
                    }
                    last_err = Some(e);
                }
                Err(e) => {
                    let _ = tokio::fs::remove_file(&tmp).await;
                    last_err = Some(e);
                }
            }
        }
        Err(anyhow!(
            "copying the git index: {}",
            last_err.map(|e| e.to_string()).unwrap_or_default()
        ))
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let mut lock = self.0.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(lock);
    }
}

pub async fn get_diff(agent: &Agent) -> anyhow::Result<AgentDiff> {
    let cwd = agent_cwd(agent)?;
    diff_worktree(cwd, agent.base_commit.as_deref()).await
}

/// Changes in `cwd`'s working tree (tracked, deleted and untracked files) since `base`
/// (default HEAD), without touching the repository's index.
async fn diff_worktree(cwd: &Path, base: Option<&str>) -> anyhow::Result<AgentDiff> {
    let mut git = ReadOnlyGit::new(cwd).await?;
    git.run(&["rev-parse", "--is-inside-work-tree"])
        .await
        .map_err(|_| anyhow!("{} is not a git repository", cwd.display()))?;

    let index = TempIndex::copy_of(&git).await?;
    git.index = Some(index.0.clone());
    // Intent-to-add (in the private index) so brand-new files show up in `git diff <base>`.
    git.run(&["add", "-A", "-N"]).await?;

    let base = base.unwrap_or("HEAD");
    let name_status = git
        .run(&[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            base,
            "--name-status",
            "-z",
            "-M",
        ])
        .await?;
    let numstat = git
        .run(&[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            base,
            "--numstat",
            "-z",
            "-M",
        ])
        .await?;
    let patch = git
        .run(&[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            base,
            "-M",
        ])
        .await?;
    drop(index);
    git.index = None;
    let ahead = if base == "HEAD" {
        0
    } else {
        git.run(&["rev-list", "--count", &format!("{base}..HEAD")])
            .await?
            .trim()
            .parse()
            .unwrap_or(0)
    };

    let counts = parse_numstat(&numstat);
    let files = parse_name_status(&name_status)
        .into_iter()
        .map(|(path, status)| {
            let (additions, deletions) = counts.get(&path).copied().unwrap_or((0, 0));
            ChangedFile {
                path,
                status,
                additions,
                deletions,
            }
        })
        .collect();
    Ok(AgentDiff {
        files,
        patch,
        ahead,
    })
}

/// `git diff --name-status -z` → (path, status). Renames/copies carry two paths.
fn parse_name_status(out: &str) -> Vec<(String, ChangeStatus)> {
    let mut tokens = out.split('\0').filter(|t| !t.is_empty());
    let mut files = Vec::new();
    while let Some(code) = tokens.next() {
        let kind = code.chars().next().unwrap_or('M');
        match kind {
            'R' | 'C' => {
                let _old = tokens.next();
                if let Some(new) = tokens.next() {
                    let status = if kind == 'R' {
                        ChangeStatus::Renamed
                    } else {
                        ChangeStatus::Added
                    };
                    files.push((new.to_string(), status));
                }
            }
            _ => {
                if let Some(path) = tokens.next() {
                    let status = match kind {
                        'A' => ChangeStatus::Added,
                        'D' => ChangeStatus::Deleted,
                        _ => ChangeStatus::Modified,
                    };
                    files.push((path.to_string(), status));
                }
            }
        }
    }
    files
}

/// `git diff --numstat -z` → path → (additions, deletions). Binary files ("-") count 0.
fn parse_numstat(out: &str) -> HashMap<String, (i64, i64)> {
    let mut map = HashMap::new();
    let mut tokens = out.split('\0');
    while let Some(tok) = tokens.next() {
        if tok.is_empty() {
            continue;
        }
        let mut parts = tok.splitn(3, '\t');
        let adds = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let dels = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let path = match parts.next() {
            Some(p) if !p.is_empty() => p.to_string(),
            // Rename: "adds\tdels\t\0old\0new\0"
            _ => {
                let _old = tokens.next();
                match tokens.next() {
                    Some(new) => new.to_string(),
                    None => continue,
                }
            }
        };
        map.insert(path, (adds, dels));
    }
    map
}

/// Commits the agent's work. An agent in its own worktree owns everything there, so all
/// changes are committed. An agent working directly in the user's checkout only gets
/// the files it edited (`touched`, from `Core::touched_files`) committed: the user's
/// own unrelated changes, staged or not, are left alone.
pub async fn commit(agent: &Agent, message: &str, touched: &[String]) -> anyhow::Result<String> {
    let cwd = agent_cwd(agent)?;
    let message = message.trim();
    if message.is_empty() {
        bail!("Commit message is empty");
    }
    if agent.worktree {
        commit_all(cwd, message).await
    } else {
        commit_paths(cwd, message, touched).await
    }
}

async fn commit_all(cwd: &Path, message: &str) -> anyhow::Result<String> {
    git(cwd, &["add", "-A"]).await?;
    let staged = git(cwd, &["diff", "--cached", "--name-only"]).await?;
    if staged.trim().is_empty() {
        bail!("Nothing to commit");
    }
    git(cwd, &["commit", "-m", message]).await?;
    short_head(cwd).await
}

async fn commit_paths(cwd: &Path, message: &str, touched: &[String]) -> anyhow::Result<String> {
    const NOTHING: &str =
        "Nothing to commit: Armada hasn't seen this agent change any files in this \
                           repository. (Agents without their own worktree only commit the files \
                           they edited; commit anything else yourself.)";
    let top = PathBuf::from(
        git(cwd, &["rev-parse", "--show-toplevel"])
            .await?
            .trim_end_matches(['\r', '\n']),
    );
    let paths = repo_relative_paths(cwd, &top, touched);
    if paths.is_empty() {
        bail!(NOTHING);
    }
    let path_args = |prefix: &[&'static str]| -> Vec<String> {
        prefix
            .iter()
            .map(|s| s.to_string())
            .chain(paths.iter().cloned())
            .collect()
    };
    let run_paths = |args: Vec<String>| {
        let top = top.clone();
        async move {
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            git(&top, &args).await
        }
    };

    // Paths git can stage: present on disk, or tracked (a deletion to record).
    let in_index: HashSet<String> =
        run_paths(path_args(&["--literal-pathspecs", "ls-files", "-z", "--"]))
            .await?
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(str::to_string)
            .collect();
    // Ignored, untracked files (build output, .env…) are never committed.
    let ignored: HashSet<String> = run_paths(path_args(&[
        "--literal-pathspecs",
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--",
    ]))
    .await?
    .split('\0')
    .filter(|p| !p.is_empty())
    .map(str::to_string)
    .collect();
    let stageable: Vec<String> = paths
        .iter()
        .filter(|p| {
            in_index.contains(*p)
                || (!ignored.contains(*p) && top.join(p).symlink_metadata().is_ok())
        })
        .cloned()
        .collect();
    if !stageable.is_empty() {
        let mut args = vec![
            "--literal-pathspecs".to_string(),
            "add".into(),
            "-A".into(),
            "--".into(),
        ];
        args.extend(stageable.iter().cloned());
        run_paths(args).await?;
    }

    // What is now staged among those paths (includes deletions already staged earlier).
    let staged: Vec<String> = run_paths(path_args(&[
        "--literal-pathspecs",
        "diff",
        "--cached",
        "--no-ext-diff",
        "--name-only",
        "-z",
        "--",
    ]))
    .await?
    .split('\0')
    .filter(|p| !p.is_empty())
    .map(str::to_string)
    .collect();
    if staged.is_empty() {
        bail!(NOTHING);
    }
    // `--only`: commit exactly these paths, leaving anything else the user staged staged.
    let mut args = vec![
        "--literal-pathspecs".to_string(),
        "commit".into(),
        "--only".into(),
        "-m".into(),
        message.to_string(),
        "--".into(),
    ];
    args.extend(staged);
    run_paths(args).await?;
    short_head(cwd).await
}

async fn short_head(cwd: &Path) -> anyhow::Result<String> {
    Ok(git(cwd, &["rev-parse", "--short", "HEAD"])
        .await?
        .trim()
        .to_string())
}

/// `touched` (absolute, or relative to the agent's `cwd`) as '/'-separated paths
/// relative to the repository root `top`. Paths outside the repository, inside `.git`,
/// or not valid UTF-8 are dropped; duplicates are removed.
fn repo_relative_paths(cwd: &Path, top: &Path, touched: &[String]) -> Vec<String> {
    let top = lenient_canonicalize(top);
    let mut out: Vec<String> = Vec::new();
    for raw in touched {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let abs = lenient_canonicalize(&cwd.join(raw));
        let Ok(rel) = abs.strip_prefix(&top) else {
            continue;
        };
        let mut parts = Vec::new();
        let mut ok = true;
        for component in rel.components() {
            match component {
                Component::Normal(part) => match part.to_str() {
                    Some(part) => parts.push(part),
                    None => ok = false,
                },
                _ => ok = false,
            }
        }
        if !ok || parts.is_empty() || parts[0].eq_ignore_ascii_case(".git") {
            continue;
        }
        let rel = parts.join("/");
        if !out.contains(&rel) {
            out.push(rel);
        }
    }
    out
}

/// Canonicalizes the longest existing ancestor of `path` (resolving symlinks such as
/// macOS's /var → /private/var) and re-appends the rest; `..` in the missing part is
/// resolved lexically.
/// Removes Windows' `\\?\` verbatim prefix (from `canonicalize`), which git and
/// most tools can't use: `\\?\C:\x` → `C:\x`, `\\?\UNC\srv\x` → `\\srv\x`.
fn plain_path(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

fn lenient_canonicalize(path: &Path) -> PathBuf {
    let mut existing = path;
    let mut missing = Vec::new();
    loop {
        if let Ok(canonical) = existing.canonicalize() {
            let mut result = canonical;
            for part in missing.iter().rev() {
                match part {
                    Component::ParentDir => {
                        result.pop();
                    }
                    Component::CurDir => {}
                    other => result.push(other.as_os_str()),
                }
            }
            return result;
        }
        match (existing.parent(), existing.components().next_back()) {
            (Some(parent), Some(last)) => {
                missing.push(last);
                existing = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

pub async fn merge(agent: &Agent) -> anyhow::Result<String> {
    let (Some(branch), Some(base)) = (agent.branch.as_deref(), agent.base_branch.as_deref()) else {
        bail!("Only agents running in their own worktree branch can be merged");
    };
    if !agent.worktree {
        bail!("Only agents running in their own worktree branch can be merged");
    }
    let project = Path::new(&agent.project_path);
    if !project.is_dir() {
        bail!(
            "The project folder no longer exists: {}",
            agent.project_path
        );
    }
    let agent_dirty = git(agent_cwd(agent)?, &["status", "--porcelain"]).await?;
    if !agent_dirty.trim().is_empty() {
        bail!("The agent has uncommitted changes. Commit them before merging.");
    }
    let dirty = git(project, &["status", "--porcelain", "--untracked-files=no"]).await?;
    if !dirty.trim().is_empty() {
        bail!(
            "{} has uncommitted changes. Commit or stash them before merging.",
            agent.project_path
        );
    }
    let current = git(project, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    let current = current.trim();
    if current != base {
        bail!(
            "{} has `{current}` checked out; switch it to `{base}` to merge.",
            agent.project_path
        );
    }
    let message = format!("Merge Armada agent: {}", agent.title);
    if let Err(e) = git(project, &["merge", "--no-ff", branch, "-m", &message]).await {
        let _ = git(project, &["merge", "--abort"]).await;
        return Err(e.context(format!("merging {branch} into {base} (merge aborted)")));
    }
    let stat = git(project, &["diff", "--shortstat", "HEAD^1", "HEAD"])
        .await
        .unwrap_or_default();
    let stat = stat.trim();
    Ok(if stat.is_empty() {
        format!("Merged {branch} into {base}")
    } else {
        format!("Merged {branch} into {base}: {stat}")
    })
}

pub async fn create_pr(agent: &Agent, title: &str, body: &str) -> anyhow::Result<String> {
    let (Some(branch), Some(base)) = (agent.branch.as_deref(), agent.base_branch.as_deref()) else {
        bail!("Pull requests need an agent running on its own branch (enable worktree)");
    };
    let cwd = agent_cwd(agent)?;
    let title = if title.trim().is_empty() {
        agent.title.as_str()
    } else {
        title.trim()
    };
    // Fail fast with a friendly message before pushing anything.
    which::which("gh").map_err(|_| {
        anyhow!("The GitHub CLI (gh) is not installed. Get it from https://cli.github.com")
    })?;
    git(cwd, &["push", "-u", "origin", branch]).await?;
    let out = run(
        "gh",
        cwd,
        &[
            "pr", "create", "--title", title, "--body", body, "--head", branch, "--base", base,
        ],
    )
    .await?;
    let url = out
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with("http"))
        .unwrap_or_else(|| out.trim())
        .to_string();
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway repository with a deterministic identity and no user/global hooks.
    struct Repo {
        dir: PathBuf,
    }

    impl Repo {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("armada-git-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(dir.join("hooks-none")).unwrap();
            let repo = Repo {
                dir: dir.canonicalize().unwrap(),
            };
            repo.git(&["init", "-q"]);
            repo.git(&["config", "user.name", "Armada Test"]);
            repo.git(&["config", "user.email", "test@armada.invalid"]);
            repo.git(&["config", "commit.gpgsign", "false"]);
            repo.git(&["config", "core.hooksPath", "hooks-none"]);
            repo.write(".gitignore", "hooks-none/\n*.log\n");
            repo
        }

        fn git(&self, args: &[&str]) -> String {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&self.dir)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).into_owned()
        }

        fn write(&self, path: &str, content: &str) {
            let path = self.dir.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }

        fn index_bytes(&self) -> Option<Vec<u8>> {
            std::fs::read(self.dir.join(".git/index")).ok()
        }

        fn lines(&self, args: &[&str]) -> Vec<String> {
            let mut lines: Vec<String> = self.git(args).lines().map(str::to_string).collect();
            lines.sort();
            lines
        }

        fn leftover_temp_indexes(&self) -> Vec<String> {
            std::fs::read_dir(self.dir.join(".git"))
                .unwrap()
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("armada-index-"))
                .collect()
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn verbatim_prefixes_are_removed() {
        assert_eq!(
            plain_path(Path::new(r"\\?\C:\repo\.git\index")),
            PathBuf::from(r"C:\repo\.git\index")
        );
        assert_eq!(
            plain_path(Path::new(r"\\?\UNC\srv\share\x")),
            PathBuf::from(r"\\srv\share\x")
        );
        assert_eq!(
            plain_path(Path::new("/home/me/repo")),
            PathBuf::from("/home/me/repo")
        );
    }

    #[tokio::test]
    async fn diff_never_touches_the_real_index() {
        let repo = Repo::new();
        repo.write("a.txt", "one\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        repo.write("a.txt", "one\ntwo\n");
        repo.write("new.txt", "fresh\n");
        let before = repo.index_bytes().expect("index exists");
        let status_before = repo.git(&["status", "--porcelain"]);

        let diff = diff_worktree(&repo.dir, None).await.unwrap();

        let mut paths: Vec<_> = diff
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status))
            .collect();
        paths.sort_by_key(|(p, _)| *p);
        assert_eq!(
            paths,
            vec![
                ("a.txt", ChangeStatus::Modified),
                ("new.txt", ChangeStatus::Added)
            ]
        );
        assert!(diff.patch.contains("+fresh"), "{}", diff.patch);
        // Byte-for-byte the same index: no intent-to-add entries, no stat refresh.
        assert_eq!(repo.index_bytes().unwrap(), before);
        assert_eq!(repo.git(&["status", "--porcelain"]), status_before);
        assert!(status_before.contains("?? new.txt"), "{status_before}");
        assert!(repo.leftover_temp_indexes().is_empty());
    }

    #[tokio::test]
    async fn diff_without_an_index_leaves_none_behind() {
        let repo = Repo::new();
        repo.write("a.txt", "one\n");
        assert!(repo.index_bytes().is_none());
        // No commit yet, so diffing against HEAD fails; it must still not create an index.
        let _ = diff_worktree(&repo.dir, None).await;
        assert!(repo.index_bytes().is_none());
        assert!(repo.leftover_temp_indexes().is_empty());
    }

    /// Repo-local config an agent could write must not execute when the diff is viewed.
    #[cfg(unix)]
    #[tokio::test]
    async fn diff_runs_no_repo_configured_commands() {
        let repo = Repo::new();
        repo.write("a.txt", "one\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);

        let markers = std::env::temp_dir().join(format!("armada-pwned-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&markers).unwrap();
        let touch = |name: &str| format!("touch '{}'; cat", markers.join(name).display());
        repo.git(&["config", "core.fsmonitor", &touch("fsmonitor")]);
        repo.git(&["config", "filter.evil.clean", &touch("clean")]);
        repo.git(&["config", "filter.evil.smudge", &touch("smudge")]);
        repo.git(&["config", "filter.evil.required", "true"]);
        repo.git(&["config", "filter.evil.proc.process", &touch("process")]);
        repo.git(&["config", "diff.evil.textconv", &touch("textconv")]);
        repo.git(&["config", "diff.evil.command", &touch("diffcommand")]);
        repo.git(&["config", "diff.external", &touch("external")]);
        repo.write(
            ".gitattributes",
            "a.txt filter=evil diff=evil\nb.txt filter=evil.proc diff=evil\n",
        );
        repo.write("a.txt", "one\ntwo\n");
        repo.write("b.txt", "new\n");

        let diff = diff_worktree(&repo.dir, None).await.unwrap();
        assert!(diff.files.iter().any(|f| f.path == "a.txt"));
        let ran: Vec<_> = std::fs::read_dir(&markers)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        std::fs::remove_dir_all(&markers).unwrap();
        assert!(ran.is_empty(), "repo config executed: {ran:?}");
    }

    #[tokio::test]
    async fn commit_without_worktree_only_takes_the_agents_files() {
        let repo = Repo::new();
        repo.write("agent.txt", "a\n");
        repo.write("user.txt", "u\n");
        repo.write("gone.txt", "g\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);

        // The user's own work: a staged edit and an untracked file.
        repo.write("user.txt", "u2\n");
        repo.git(&["add", "user.txt"]);
        repo.write("scratch.txt", "mine\n");
        // The agent's work: an edit, a new file in a subfolder, a deletion, an ignored file.
        repo.write("agent.txt", "a2\n");
        repo.write("src/new.rs", "fn main() {}\n");
        std::fs::remove_file(repo.dir.join("gone.txt")).unwrap();
        repo.write("debug.log", "noise\n");

        let touched = vec![
            "agent.txt".to_string(),
            repo.dir.join("src/new.rs").display().to_string(),
            "./gone.txt".to_string(),
            "debug.log".to_string(),
            "never-existed.txt".to_string(),
            repo.dir.join(".git/config").display().to_string(),
            "/definitely/outside/the/repo.txt".to_string(),
        ];
        commit_paths(&repo.dir, "agent work", &touched)
            .await
            .unwrap();

        assert_eq!(
            repo.lines(&["show", "--name-only", "--format=", "HEAD"]),
            vec!["agent.txt", "gone.txt", "src/new.rs"]
        );
        // The user's staged change is still staged, their untracked file untouched.
        assert_eq!(
            repo.lines(&["diff", "--cached", "--name-only"]),
            vec!["user.txt"]
        );
        let status = repo.git(&["status", "--porcelain", "--ignored"]);
        assert!(status.contains("?? scratch.txt"), "{status}");
        assert!(status.contains("!! debug.log"), "{status}");
    }

    #[tokio::test]
    async fn commit_without_worktree_needs_touched_files() {
        let repo = Repo::new();
        repo.write("a.txt", "a\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        repo.write("a.txt", "user edit\n");

        let err = commit_paths(&repo.dir, "msg", &[]).await.unwrap_err();
        assert!(err.to_string().starts_with("Nothing to commit"), "{err}");
        // Touched but unchanged: also nothing to commit.
        let err = commit_paths(&repo.dir, "msg", &["missing.txt".to_string()])
            .await
            .unwrap_err();
        assert!(err.to_string().starts_with("Nothing to commit"), "{err}");
        assert_eq!(repo.lines(&["rev-list", "--count", "HEAD"]), vec!["1"]);
    }

    #[test]
    fn repo_relative_paths_from_subfolder() {
        let repo = Repo::new();
        repo.write("sub/x.txt", "x");
        let sub = repo.dir.join("sub");
        let touched = vec![
            "x.txt".to_string(),
            "../top.txt".to_string(),
            "x.txt".to_string(),
            sub.join("deleted/y.txt").display().to_string(),
        ];
        assert_eq!(
            repo_relative_paths(&sub, &repo.dir, &touched),
            vec!["sub/x.txt", "top.txt", "sub/deleted/y.txt"]
        );
    }

    #[test]
    fn parses_filter_drivers() {
        let out = "filter.lfs.clean\ngit-lfs clean -- %f\0filter.lfs.process\ngit-lfs filter-process\0filter.a.b.smudge\ncat\0";
        assert_eq!(filter_drivers(out), vec!["lfs", "a.b"]);
        assert!(filter_drivers("").is_empty());
    }

    #[test]
    fn parses_name_status() {
        let out = "M\0a\0D\0b\0R100\0c\0d\0A\0n\0";
        let files = parse_name_status(out);
        assert_eq!(
            files,
            vec![
                ("a".to_string(), ChangeStatus::Modified),
                ("b".to_string(), ChangeStatus::Deleted),
                ("d".to_string(), ChangeStatus::Renamed),
                ("n".to_string(), ChangeStatus::Added),
            ]
        );
    }

    #[test]
    fn parses_numstat() {
        let out = "1\t0\ta\x000\t1\tb\x000\t0\t\0c\0d\x001\t0\tn\0-\t-\timg.png\0";
        let m = parse_numstat(out);
        assert_eq!(m["a"], (1, 0));
        assert_eq!(m["b"], (0, 1));
        assert_eq!(m["d"], (0, 0));
        assert_eq!(m["n"], (1, 0));
        assert_eq!(m["img.png"], (0, 0));
        assert!(!m.contains_key("c"));
    }
}
