//! Diff review, commit, merge and PR creation for an agent's working copy.
//! Shells out to `git` / `gh` so it behaves exactly like the user's own tools.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime};

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
    /// Stored with Git LFS: judged against its committed pointer, so no textual patch.
    #[serde(default)]
    pub lfs: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDiff {
    pub files: Vec<ChangedFile>,
    pub patch: String,
    pub ahead: i64,
    /// Files with uncommitted changes in the agent's checkout (what "Commit" would take).
    ///
    /// Counted with the same filter-free git as the diff (viewing must not run
    /// repository-configured programs), so in repositories with clean/smudge filters
    /// (LFS) a file whose timestamps changed but whose content didn't can be counted
    /// until a real git command refreshes the index. Committing is unaffected.
    pub uncommitted: i64,
    /// `patch` was cut short (at a file boundary) because it exceeded
    /// [`MAX_PATCH_BYTES`]; `files` still lists every changed file.
    pub truncated: bool,
    /// Set when the diff involves Git LFS paths (None otherwise).
    pub lfs: Option<LfsSummary>,
}

/// Git LFS facts about a diff. Armada never runs LFS (or any repository-configured
/// filter) to view a diff: LFS files are compared against their committed pointers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsSummary {
    /// The repository uses LFS but no `git-lfs` executable is on PATH.
    pub tool_missing: bool,
    /// LFS files left out of the diff because their content matches the committed pointer.
    pub hidden: i64,
}

/// What a commit took.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    /// Abbreviated hash of the new commit.
    pub hash: String,
    /// Repository-relative paths in the commit.
    pub files: Vec<String>,
    /// Changed files (tracked or untracked, not ignored) still uncommitted afterwards.
    pub left_uncommitted: i64,
    /// Files the agent touched that were skipped because they're inside a submodule
    /// or a nested repository (commit those in that repository).
    pub skipped: Vec<String>,
    /// One line for the UI, e.g. "Committed 3 files (abc1234); 5 other changed files
    /// were left uncommitted".
    pub message: String,
}

/// The commit had nothing to take. Callers that commit "if needed" (ship) match on
/// it with `err.is::<NothingToCommit>()`.
#[derive(Debug)]
pub struct NothingToCommit(pub String);

impl std::fmt::Display for NothingToCommit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for NothingToCommit {}

/// Extra knobs for running a program.
#[derive(Default)]
struct Opts<'a> {
    envs: Vec<(&'a str, &'a OsStr)>,
    /// Written to the program's stdin (otherwise stdin is closed).
    stdin: Option<Vec<u8>>,
    /// Kill the program if it hasn't finished by then (default [`GIT_TIMEOUT`]).
    timeout: Option<Duration>,
    /// Read at most this much of stdout, then kill the program (see [`Captured`]).
    max_stdout: Option<usize>,
}

const PUSH_TIMEOUT: Duration = Duration::from_secs(180);
const GH_TIMEOUT: Duration = Duration::from_secs(120);
/// Read-only git (viewing a diff, reverting a hunk).
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// Everything else, notably commit and merge, whose hooks can hang.
const GIT_TIMEOUT: Duration = Duration::from_secs(120);
/// Largest patch handed to the UI; larger ones are cut at a file boundary.
pub const MAX_PATCH_BYTES: usize = 8 * 1024 * 1024;
/// Temporary indexes older than this were left behind by a crash and are removed.
const STALE_TEMP_INDEX: Duration = Duration::from_secs(60 * 60);

/// One git operation (commit, ship, merge, revert) at a time per agent: a double
/// click, or the desktop and the phone at once, must not interleave `git add`s.
pub fn try_lock_agent(agent_id: &str) -> anyhow::Result<tokio::sync::OwnedMutexGuard<()>> {
    type Locks = parking_lot::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>;
    static LOCKS: OnceLock<Locks> = OnceLock::new();
    let lock = {
        let mut locks = LOCKS.get_or_init(Default::default).lock();
        // Forget idle agents' locks (only the map holds them, nobody holds the guard).
        locks.retain(|_, l| Arc::strong_count(l) > 1);
        locks.entry(agent_id.to_string()).or_default().clone()
    };
    lock.try_lock_owned().map_err(|_| {
        anyhow!("Armada is already committing, merging or reverting this agent's work; wait for it to finish")
    })
}

/// The subcommand in `args`, skipping global flags ("-c key=value", "--literal-pathspecs").
fn subcommand_of<'a>(args: &[&'a str]) -> &'a str {
    let mut rest = args.iter().copied();
    while let Some(arg) = rest.next() {
        if arg == "-c" {
            rest.next();
        } else if !arg.starts_with("--") {
            return arg;
        }
    }
    ""
}

async fn run(program: &str, cwd: &Path, args: &[&str]) -> anyhow::Result<String> {
    run_opts(program, cwd, args, Opts::default()).await
}

async fn run_opts(
    program: &str,
    cwd: &Path,
    args: &[&str],
    opts: Opts<'_>,
) -> anyhow::Result<String> {
    let out = output(program, cwd, args, opts).await?;
    check(program, args, &out)?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Turns a failed exit into an error carrying the program's own message.
fn check(program: &str, args: &[&str], out: &std::process::Output) -> anyhow::Result<()> {
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let msg = match (stderr.is_empty(), stdout.is_empty()) {
        (true, true) => format!("exit status {}", out.status),
        (false, true) => stderr,
        (true, false) => stdout,
        // Hooks often print their reason on stdout.
        (false, false) => format!("{stderr}\n{stdout}"),
    };
    bail!("{program} {} failed: {msg}", subcommand_of(args));
}

async fn output(
    program: &str,
    cwd: &Path,
    args: &[&str],
    opts: Opts<'_>,
) -> anyhow::Result<std::process::Output> {
    Ok(output_capped(program, cwd, args, opts).await?.output)
}

struct Captured {
    output: std::process::Output,
    /// stdout passed `Opts::max_stdout`: it holds the first `max_stdout + 1` bytes and
    /// the program was killed (so its exit status is meaningless).
    overflowed: bool,
}

/// Most stderr kept (a program spewing errors mustn't exhaust memory).
const MAX_STDERR: usize = 1024 * 1024;

async fn output_capped(
    program: &str,
    cwd: &Path,
    args: &[&str],
    opts: Opts<'_>,
) -> anyhow::Result<Captured> {
    use tokio::io::AsyncReadExt;

    let exe = which::which(program).map_err(|_| match program {
        "gh" => anyhow!("The GitHub CLI (gh) is not installed. Get it from https://cli.github.com"),
        _ => anyhow!("{program} is not installed or not on PATH"),
    })?;
    let mut cmd = tokio::process::Command::new(exe);
    // Running as an AppImage: don't hand git/gh our bundled libraries.
    armada_core::childenv::sanitize_child_env(&mut cmd);
    if program == "git" {
        // Windows: paths past MAX_PATH (deep node_modules) instead of "Filename too long".
        // Unknown elsewhere, where git ignores it.
        cmd.args(["-c", "core.longpaths=true"]);
        // The repository's own config (the agent can write it) must not run programs or
        // redirect pushes; the user's global config keeps working.
        let hardening = armada_core::hardening(cwd).await?;
        match subcommand_of(args) {
            "push" => {
                if let Some(why) = &hardening.push_blocker {
                    bail!("{why}");
                }
            }
            "merge" => {
                if let Some(why) = &hardening.merge_blocker {
                    bail!("{why}");
                }
            }
            "fetch" | "pull" | "clone" => {
                if let Some(why) = &hardening.fetch_blocker {
                    bail!("{why}");
                }
            }
            _ => {}
        }
        cmd.args(&hardening.args);
    } else if program == "gh" {
        // gh spawns git itself: hand it the same hardening through the environment.
        let hardening = armada_core::hardening(cwd).await?;
        if let Some(why) = hardening
            .push_blocker
            .as_ref()
            .or(hardening.fetch_blocker.as_ref())
        {
            bail!("{why}");
        }
        cmd.envs(hardening.git_config_env());
    }
    cmd.args(args)
        .current_dir(cwd)
        .stdin(if opts.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .envs(opts.envs.iter().copied());
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: don't flash console windows from a GUI app.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().with_context(|| format!("running {program}"))?;
    if let (Some(data), Some(mut stdin)) = (opts.stdin, child.stdin.take()) {
        // Concurrently with reading the output, so a chatty program can't deadlock us.
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(&data).await;
        });
    }
    let (Some(mut stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        bail!("running {program}: no output pipes");
    };
    let max_stdout = opts.max_stdout;
    let collect = async {
        let read_stdout = async {
            let mut buf = Vec::new();
            let overflowed = match max_stdout {
                Some(cap) => {
                    (&mut stdout)
                        .take(cap as u64 + 1)
                        .read_to_end(&mut buf)
                        .await?;
                    buf.len() > cap
                }
                None => {
                    stdout.read_to_end(&mut buf).await?;
                    false
                }
            };
            if overflowed {
                // Stop it now: it would otherwise block writing the rest (and stderr
                // would never reach EOF).
                let _ = child.start_kill();
            }
            Ok::<_, std::io::Error>((buf, overflowed))
        };
        let read_stderr = async {
            // Drained to the end (a full pipe would stall the program), kept up to a cap.
            let mut stderr = stderr;
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                let n = stderr.read(&mut chunk).await?;
                if n == 0 {
                    break;
                }
                let room = MAX_STDERR.saturating_sub(buf.len());
                buf.extend_from_slice(&chunk[..n.min(room)]);
            }
            Ok::<_, std::io::Error>(buf)
        };
        let ((stdout, overflowed), stderr) = tokio::try_join!(read_stdout, read_stderr)?;
        let status = child.wait().await?;
        Ok::<_, std::io::Error>(Captured {
            output: std::process::Output {
                status,
                stdout,
                stderr,
            },
            overflowed,
        })
    };
    let limit = opts.timeout.unwrap_or(GIT_TIMEOUT);
    // On timeout, dropping the future drops the child, which kills it (kill_on_drop).
    tokio::time::timeout(limit, collect)
        .await
        .map_err(|_| {
            anyhow!(
                "{program} {} timed out after {} s",
                subcommand_of(args),
                limit.as_secs()
            )
        })?
        .with_context(|| format!("running {program}"))
}

async fn git(cwd: &Path, args: &[&str]) -> anyhow::Result<String> {
    run("git", cwd, args).await
}

/// Runs git with `paths` as NUL-separated pathspecs on stdin (`--pathspec-from-file`),
/// so long lists never hit command-line length limits (32 KiB on Windows).
async fn git_with_pathspecs(cwd: &Path, args: &[&str], paths: &[String]) -> anyhow::Result<String> {
    let mut all = args.to_vec();
    all.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
    git_stdin(cwd, &all, nul_joined(paths)).await
}

async fn git_stdin(cwd: &Path, args: &[&str], stdin: Vec<u8>) -> anyhow::Result<String> {
    run_opts(
        "git",
        cwd,
        args,
        Opts {
            stdin: Some(stdin),
            ..Opts::default()
        },
    )
    .await
}

/// For commands without `--pathspec-from-file` (ls-files): runs `args -- <chunk>` for
/// chunks of `paths` small enough for any command line, concatenating the output.
async fn git_chunked(cwd: &Path, args: &[&str], paths: &[String]) -> anyhow::Result<String> {
    const MAX_CHARS: usize = 8 * 1024;
    let mut out = String::new();
    let mut chunk: Vec<&str> = Vec::new();
    let mut len = 0;
    for (i, path) in paths.iter().enumerate() {
        chunk.push(path);
        len += path.len() + 3;
        if len >= MAX_CHARS || i + 1 == paths.len() {
            let mut all = args.to_vec();
            all.push("--");
            all.append(&mut chunk);
            out.push_str(&git(cwd, &all).await?);
            len = 0;
        }
    }
    Ok(out)
}

fn nul_joined(paths: &[String]) -> Vec<u8> {
    let mut data = Vec::new();
    for p in paths {
        data.extend_from_slice(p.as_bytes());
        data.push(0);
    }
    data
}

fn nul_split(out: &str) -> impl Iterator<Item = &str> {
    out.split('\0').filter(|p| !p.is_empty())
}

fn agent_cwd(agent: &Agent) -> anyhow::Result<&Path> {
    let cwd = Path::new(&agent.cwd);
    if !cwd.is_dir() {
        bail!("The agent's folder no longer exists: {}", agent.cwd);
    }
    Ok(cwd)
}

/// Git for viewing a diff on the user's behalf.
///
/// Safety: an agent can write `.git/config` and `.gitattributes`, so merely looking at
/// its changes must not run anything those configure. fsmonitor hooks and
/// clean/smudge/process filters are switched off here, and every diff also passes
/// `--no-ext-diff --no-textconv`. Optional locks are disabled so git never rewrites
/// the user's index behind their back.
///
/// Nested repositories and submodules: checking whether one is dirty runs git inside
/// it with *its* config (its own filters, fsmonitor…), which the overrides here don't
/// reach. `git add -N` even turns an untracked embedded repository into a gitlink. So
/// submodule dirtiness is never examined (`--ignore-submodules=dirty` on every diff and
/// status, `diff.ignoreSubmodules=dirty` as the default); only their commits are.
///
/// Determinism: the UI parses the output, so settings that change its shape
/// (`diff.noprefix`, `diff.mnemonicPrefix`, `diff.relative`, colors, path quoting,
/// rename detection) are pinned regardless of the user's config.
struct ReadOnlyGit<'a> {
    cwd: &'a Path,
    flags: Vec<String>,
    index: Option<PathBuf>,
}

impl<'a> ReadOnlyGit<'a> {
    const BASE_FLAGS: [&'static str; 22] = [
        "-c",
        "core.fsmonitor=false",
        // Never look inside nested repositories (see above).
        "-c",
        "diff.ignoreSubmodules=dirty",
        "-c",
        "status.submoduleSummary=false",
        // `add -N` of an embedded repository otherwise prints a page of advice.
        "-c",
        "advice.addEmbeddedRepo=false",
        // Keep writes to a temporary index self-contained (no sharedindex.* in .git).
        "-c",
        "core.splitIndex=false",
        // Non-ASCII names verbatim in the patch, as they are in `-z` output.
        "-c",
        "core.quotePath=false",
        "-c",
        "color.ui=false",
        "-c",
        "diff.noprefix=false",
        "-c",
        "diff.mnemonicPrefix=false",
        "-c",
        "diff.relative=false",
        "-c",
        "diff.renames=true",
    ];

    /// Options for every `git diff`: no external programs, fixed output shape.
    const DIFF_FLAGS: [&'static str; 9] = [
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-relative",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--submodule=short",
        "--ignore-submodules=dirty",
        "-M",
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
            Opts {
                timeout: Some(READ_TIMEOUT),
                ..Opts::default()
            },
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
        self.run_input(args, None).await
    }

    async fn run_input(&self, args: &[&str], stdin: Option<Vec<u8>>) -> anyhow::Result<String> {
        let out = self.output(args, stdin, None).await?;
        check("git", args, &out.output)?;
        Ok(String::from_utf8_lossy(&out.output.stdout).into_owned())
    }

    /// Runs git with the safety flags; the exit status is the caller's to check.
    async fn output(
        &self,
        args: &[&str],
        stdin: Option<Vec<u8>>,
        max_stdout: Option<usize>,
    ) -> anyhow::Result<Captured> {
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
        output_capped(
            "git",
            self.cwd,
            &all,
            Opts {
                envs,
                stdin,
                timeout: Some(READ_TIMEOUT),
                max_stdout,
            },
        )
        .await
    }

    /// `git diff <DIFF_FLAGS> <args>`.
    async fn diff(&self, args: &[&str]) -> anyhow::Result<String> {
        let mut all = vec!["diff"];
        all.extend(Self::DIFF_FLAGS);
        all.extend(args);
        self.run(&all).await
    }

    /// The patch (`git diff <DIFF_FLAGS> <args>`), cut at a file boundary if it's
    /// over `cap` bytes. Returns (patch, truncated).
    async fn patch(&self, args: &[&str], cap: usize) -> anyhow::Result<(String, bool)> {
        let mut all = vec!["diff"];
        all.extend(Self::DIFF_FLAGS);
        all.extend(args);
        let out = self.output(&all, None, Some(cap)).await?;
        if !out.overflowed {
            check("git", &all, &out.output)?;
            return Ok((
                String::from_utf8_lossy(&out.output.stdout).into_owned(),
                false,
            ));
        }
        let kept = truncate_patch(&out.output.stdout, cap);
        Ok((String::from_utf8_lossy(kept).into_owned(), true))
    }

    /// Whether HEAD points at a commit (false in a repository with no commits yet).
    async fn has_head(&self) -> anyhow::Result<bool> {
        let args = ["rev-parse", "--verify", "-q", "HEAD^{commit}"];
        let out = self.output(&args, None, None).await?.output;
        match out.status.code() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => check("git", &args, &out).map(|()| false),
        }
    }

    /// The empty tree's id in this repository's hash (SHA-1 or SHA-256).
    async fn empty_tree(&self) -> anyhow::Result<String> {
        Ok(self
            .run_input(
                &["hash-object", "-t", "tree", "--no-filters", "--stdin"],
                Some(Vec::new()),
            )
            .await?
            .trim()
            .to_string())
    }
}

/// The longest prefix of `patch` of at most `cap` bytes that ends at a file boundary
/// (just before a `diff --git` line). Empty if the first file alone is too big.
fn truncate_patch(patch: &[u8], cap: usize) -> &[u8] {
    const MARK: &[u8] = b"\ndiff --git ";
    // The last file boundary whose newline still fits; keep that newline.
    (0..cap.min(patch.len()))
        .rev()
        .find(|&at| patch[at..].starts_with(MARK))
        .map_or(&[], |at| &patch[..at + 1])
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
        for dir in candidates.iter().filter_map(|c| c.parent()) {
            sweep_stale_temp_indexes(dir);
        }
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

/// Removes `armada-index-*` files (and their `.lock`s) in `dir` older than
/// [`STALE_TEMP_INDEX`]: left behind when Armada was killed mid-diff.
fn sweep_stale_temp_indexes(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with("armada-index-")
        {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > STALE_TEMP_INDEX);
        if stale && entry.file_type().is_ok_and(|t| t.is_file()) {
            let _ = std::fs::remove_file(entry.path());
        }
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

/// Largest patch accepted for reverting (a whole-file revert of a big file).
const MAX_REVERT_PATCH: usize = 16 * 1024 * 1024;

/// Undoes part of the agent's changes: `patch` is a slice of the agent's diff (one
/// file's section, or a file header plus one hunk), reverse-applied to the working
/// tree. All or nothing: if any part no longer applies, nothing changes.
pub async fn revert_patch(agent: &Agent, patch: &str) -> anyhow::Result<()> {
    let cwd = agent_cwd(agent)?;
    if patch.len() > MAX_REVERT_PATCH {
        bail!("That change is too large to revert here");
    }
    if !patch.starts_with("diff --git ") {
        bail!("Not a git patch");
    }
    let mut patch = patch.to_string();
    if !patch.ends_with('\n') {
        patch.push('\n');
    }
    // Same hardening as viewing a diff: the agent controls .git/config and
    // .gitattributes, so no filters/fsmonitor run while touching its files.
    let git = ReadOnlyGit::new(cwd).await?;
    git.run_input(
        &["apply", "-R", "--whitespace=nowarn", "-"],
        Some(patch.into_bytes()),
    )
    .await
    .map_err(|e| e.context("The change couldn't be reverted (the file has changed since)"))?;
    Ok(())
}

pub async fn get_diff(agent: &Agent) -> anyhow::Result<AgentDiff> {
    let cwd = agent_cwd(agent)?;
    let started = (agent.created_at > 0)
        .then(|| SystemTime::UNIX_EPOCH + Duration::from_millis(agent.created_at as u64));
    diff_worktree_with(cwd, agent.base_commit.as_deref(), started, None).await
}

/// Changes in `cwd`'s working tree (tracked, deleted and untracked files) since `base`
/// (default HEAD), without touching the repository's index.
#[cfg(test)]
async fn diff_worktree(cwd: &Path, base: Option<&str>) -> anyhow::Result<AgentDiff> {
    diff_worktree_with(cwd, base, None, None).await
}

/// Every LFS-tracked path (attribute `filter=lfs`), as a pathspec relative to the
/// repository root whatever directory git runs in.
const LFS_SPEC: &str = ":(top,attr:filter=lfs)";
/// Everything except LFS-tracked paths.
const NOT_LFS_SPEC: &str = ":(top,exclude,attr:filter=lfs)";

/// [`get_diff`] with the pieces tests need to control: `started` is when the agent's
/// work began (see [`lfs_scan`]), `path_env` the PATH searched for `git-lfs`.
async fn diff_worktree_with(
    cwd: &Path,
    base: Option<&str>,
    started: Option<SystemTime>,
    path_env: Option<&OsStr>,
) -> anyhow::Result<AgentDiff> {
    let mut git = ReadOnlyGit::new(cwd).await?;
    git.run(&["rev-parse", "--is-inside-work-tree"])
        .await
        .map_err(|_| anyhow!("{} is not a git repository", cwd.display()))?;

    let has_head = git.has_head().await?;
    // No commits yet: everything is new relative to the empty tree.
    let base = match base {
        Some(base) => base.to_string(),
        None if has_head => "HEAD".to_string(),
        None => git.empty_tree().await?,
    };

    // LFS files are judged here, never by git: it would hash every (huge) asset several
    // times, and viewing must not run the repository's LFS filters.
    let lfs = lfs_scan(&git, &base, started).await?;
    let pathspec: Vec<&str> = if lfs.any {
        vec!["--", ":(top)", NOT_LFS_SPEC]
    } else {
        Vec::new()
    };

    let index = TempIndex::copy_of(&git).await?;
    git.index = Some(index.0.clone());
    // Intent-to-add (in the private index) so brand-new files show up in `git diff <base>`.
    // Only the untracked files: `add -A` would also hash every modified tracked file and
    // write it into the object database.
    let untracked = &lfs.untracked_plain;
    if !untracked.is_empty() {
        git.run_input(
            &[
                "--literal-pathspecs",
                "add",
                "-N",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            Some(nul_joined(untracked)),
        )
        .await?;
    }

    let mut meta_args = vec!["--raw", "--numstat", "-z", &base];
    meta_args.extend(&pathspec);
    let meta = git.diff(&meta_args).await?;
    let mut patch_args = vec![base.as_str()];
    patch_args.extend(&pathspec);
    let (patch, truncated) = git.patch(&patch_args, MAX_PATCH_BYTES).await?;
    drop(index);
    git.index = None;
    let ahead = if base == "HEAD" || !has_head {
        0
    } else {
        git.run(&["rev-list", "--count", &format!("{base}..HEAD")])
            .await?
            .trim()
            .parse()
            .unwrap_or(0)
    };

    // Filter-free like the diff: see `AgentDiff::uncommitted`.
    let mut status_args = vec![
        "status",
        "--porcelain",
        "-z",
        "--untracked-files=normal",
        "--ignore-submodules=dirty",
    ];
    if lfs.any {
        status_args.extend(["--", ":(top)", NOT_LFS_SPEC]);
    }
    let uncommitted = git
        .run(&status_args)
        .await
        .map(|s| count_porcelain(&s))
        .unwrap_or(0)
        + lfs.files.len() as i64;

    let (entries, numstat) = split_raw_numstat(&meta);
    let counts = parse_numstat(numstat);
    let mut files: Vec<ChangedFile> = parse_raw(entries)
        .into_iter()
        .map(|(path, status)| {
            let (additions, deletions) = counts.get(&path).copied().unwrap_or((0, 0));
            ChangedFile {
                path,
                status,
                additions,
                deletions,
                lfs: false,
            }
        })
        .collect();
    let summary = lfs.any.then(|| LfsSummary {
        tool_missing: !lfs_tool_on_path(path_env),
        hidden: lfs.hidden,
    });
    if !lfs.files.is_empty() {
        files.extend(lfs.files);
        files.sort_by(|a, b| a.path.cmp(&b.path));
    }
    Ok(AgentDiff {
        files,
        patch,
        ahead,
        uncommitted,
        truncated,
        lfs: summary,
    })
}

/// Whether a `git-lfs` executable is on PATH (`path_env`, or the process's own). Looked
/// up, never run.
fn lfs_tool_on_path(path_env: Option<&OsStr>) -> bool {
    match path_env {
        Some(path) => {
            let cwd = std::env::current_dir().unwrap_or_default();
            which::which_in("git-lfs", Some(path), cwd).is_ok()
        }
        None => which::which("git-lfs").is_ok(),
    }
}

const LFS_REFUSAL: &str =
    "This repository stores files with Git LFS, but Git LFS isn't installed. \
Install it (e.g. `sudo pacman -S git-lfs`, `brew install git-lfs`, or Git for Windows includes it) \
and run `git lfs install`, then try again.";

/// Refuses (before any `git add`/`git commit`) when LFS-tracked files changed but
/// `git-lfs` isn't installed: git would commit the raw binaries as ordinary blobs,
/// where the repository expects small pointers. `only` limits the check to those
/// repository-relative paths (an agent sharing the user's checkout). Repositories
/// without LFS are never blocked.
async fn ensure_lfs_commit_safe(
    agent: &Agent,
    cwd: &Path,
    only: Option<&[String]>,
    path_env: Option<&OsStr>,
) -> anyhow::Result<()> {
    if lfs_tool_on_path(path_env) {
        return Ok(());
    }
    let git = ReadOnlyGit::new(cwd).await?;
    let base = if git.has_head().await? {
        "HEAD".to_string()
    } else {
        git.empty_tree().await?
    };
    let started = (agent.created_at > 0)
        .then(|| SystemTime::UNIX_EPOCH + Duration::from_millis(agent.created_at as u64));
    let scan = lfs_scan(&git, &base, started).await?;
    let hit = scan
        .files
        .iter()
        .any(|f| only.is_none_or(|paths| paths.iter().any(|p| path_key(p) == path_key(&f.path))));
    if hit {
        bail!("{LFS_REFUSAL}");
    }
    Ok(())
}

/// A Git LFS pointer file's target.
#[derive(Debug, PartialEq, Eq)]
struct LfsPointer {
    oid: String,
    size: u64,
}

/// Parses `version https://git-lfs.github.com/spec/v1` pointer text.
fn parse_lfs_pointer(blob: &[u8]) -> Option<LfsPointer> {
    let text = std::str::from_utf8(blob).ok()?;
    let mut lines = text.lines();
    if !lines
        .next()?
        .starts_with("version https://git-lfs.github.com/spec/")
    {
        return None;
    }
    let (mut oid, mut size) = (None, None);
    for line in lines {
        if let Some(v) = line.strip_prefix("oid sha256:") {
            oid = Some(v.trim().to_ascii_lowercase());
        } else if let Some(v) = line.strip_prefix("size ") {
            size = v.trim().parse().ok();
        }
    }
    Some(LfsPointer {
        oid: oid.filter(|o| o.len() == 64 && o.bytes().all(|b| b.is_ascii_hexdigit()))?,
        size: size?,
    })
}

/// LFS pointer blobs are ~130 bytes; anything bigger isn't one.
const MAX_POINTER_BYTES: u64 = 1024;

/// What `lfs_scan` found.
#[derive(Default)]
struct LfsScan {
    /// The repository has LFS-tracked paths at all (they are left out of git's passes).
    any: bool,
    /// LFS files that differ from the base (`lfs: true`, no patch).
    files: Vec<ChangedFile>,
    /// Untracked, not ignored, non-LFS files (to intent-to-add for the patch).
    untracked_plain: Vec<String>,
    /// LFS files whose content matches the committed pointer.
    hidden: i64,
}

/// How a tracked LFS file's worktree copy compares with its committed version.
#[derive(Debug, PartialEq, Eq)]
enum Lfs {
    Same,
    Changed,
    Gone,
}

/// The committed side of an LFS path.
enum LfsBase {
    Pointer(LfsPointer),
    /// A regular blob of this size (committed before LFS was adopted).
    Raw(u64),
    Missing,
}

/// Untracked, not-ignored files → (LFS-tracked, others).
async fn split_untracked_lfs(git: &ReadOnlyGit<'_>) -> anyhow::Result<(Vec<String>, Vec<String>)> {
    let all = list(
        git,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--full-name",
            "--",
            ":(top)",
        ],
    )
    .await?;
    if all.is_empty() {
        return Ok((Vec::new(), all));
    }
    let attrs = git
        .run_input(
            &["check-attr", "-z", "--stdin", "filter"],
            Some(nul_joined(&all)),
        )
        .await?;
    // "<path>\0filter\0<value>\0"…
    let mut lfs: HashSet<&str> = HashSet::new();
    let mut tokens = attrs.split('\0');
    while let (Some(path), Some(_attr), Some(value)) = (tokens.next(), tokens.next(), tokens.next())
    {
        if value == "lfs" {
            lfs.insert(path);
        }
    }
    let (lfs_paths, plain): (Vec<String>, Vec<String>) =
        all.into_iter().partition(|p| lfs.contains(p.as_str()));
    Ok((lfs_paths, plain))
}

async fn list(git: &ReadOnlyGit<'_>, args: &[&str]) -> anyhow::Result<Vec<String>> {
    let out = git.run(args).await?;
    Ok(nul_split(&out).map(str::to_string).collect())
}

/// Finds the LFS-tracked files that changed since `base`, without git hashing them.
///
/// A file is judged from its committed pointer (oid, size): missing → deleted; a
/// different size → changed; the same size and last modified before `started` (the
/// agent hasn't touched it) → unchanged, unread; otherwise the file is streamed through
/// SHA-256, remembered in a process-wide cache keyed by path, size, mtime and inode.
async fn lfs_scan(
    git: &ReadOnlyGit<'_>,
    base: &str,
    started: Option<SystemTime>,
) -> anyhow::Result<LfsScan> {
    let mut tracked = list(git, &["ls-files", "-z", "--full-name", "--", LFS_SPEC]).await?;
    tracked.dedup();
    // Untracked files are told apart with `check-attr`: an attribute pathspec doesn't
    // see inside untracked directories.
    let (untracked, plain_untracked) = split_untracked_lfs(git).await?;
    // Removed from the index (`git rm`) or deleted by a commit since `base`.
    let removed = list(
        git,
        &[
            "diff-index",
            "--cached",
            "--raw",
            "-z",
            "--no-renames",
            "--diff-filter=D",
            base,
            "--",
            LFS_SPEC,
        ],
    )
    .await?
    .into_iter()
    .filter(|t| !t.starts_with(':'))
    .collect::<Vec<_>>();
    let mut scan = LfsScan {
        any: !(tracked.is_empty() && untracked.is_empty() && removed.is_empty()),
        untracked_plain: plain_untracked,
        ..LfsScan::default()
    };
    if !scan.any {
        return Ok(scan);
    }
    let top = git
        .run(&["rev-parse", "--show-toplevel"])
        .await?
        .trim_end_matches(['\r', '\n'])
        .to_string();
    let top = PathBuf::from(top);

    let bases = lfs_bases(git, base, &tracked).await?;
    let work: Vec<(String, LfsBase)> = tracked.into_iter().zip(bases).collect();
    let top2 = top.clone();
    let verdicts = tokio::task::spawn_blocking(move || lfs_verdicts(&top2, work, started))
        .await
        .map_err(|e| anyhow!("checking LFS files: {e}"))?;

    for (path, base, verdict) in verdicts {
        let status = match (verdict, base) {
            (Lfs::Same, _) => {
                scan.hidden += 1;
                continue;
            }
            (Lfs::Gone, LfsBase::Missing) => continue,
            (Lfs::Gone, _) => ChangeStatus::Deleted,
            (Lfs::Changed, LfsBase::Missing) => ChangeStatus::Added,
            (Lfs::Changed, _) => ChangeStatus::Modified,
        };
        scan.files.push(lfs_file(path, status));
    }
    for path in untracked {
        scan.files.push(lfs_file(path, ChangeStatus::Added));
    }
    for path in removed {
        scan.files.push(lfs_file(path, ChangeStatus::Deleted));
    }
    Ok(scan)
}

fn lfs_file(path: String, status: ChangeStatus) -> ChangedFile {
    ChangedFile {
        path,
        status,
        additions: 0,
        deletions: 0,
        lfs: true,
    }
}

/// The committed side of each of `paths` at `base`, in order. Two cheap `cat-file`
/// calls; only small blobs (pointers) are ever read.
async fn lfs_bases(
    git: &ReadOnlyGit<'_>,
    base: &str,
    paths: &[String],
) -> anyhow::Result<Vec<LfsBase>> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    // One "<base>:<path>" per line; a path with a newline can't be asked about.
    let asked: Vec<usize> = (0..paths.len())
        .filter(|&i| !paths[i].contains('\n'))
        .collect();
    let mut input = String::new();
    for &i in &asked {
        input.push_str(&format!("{base}:{}\n", paths[i]));
    }
    let checked = git
        .output(
            &["cat-file", "--batch-check"],
            Some(input.clone().into_bytes()),
            None,
        )
        .await?;
    check("git", &["cat-file"], &checked.output)?;
    let text = String::from_utf8_lossy(&checked.output.stdout).into_owned();
    let mut sizes: Vec<Option<u64>> = vec![None; paths.len()];
    let mut missing: Vec<bool> = vec![false; paths.len()];
    let mut small = String::new();
    let mut small_idx = Vec::new();
    for (&i, line) in asked.iter().zip(text.lines()) {
        let mut parts = line.rsplitn(3, ' ');
        let (size, kind) = (parts.next(), parts.next());
        if line.ends_with(" missing") {
            missing[i] = true;
        } else if kind == Some("blob") {
            sizes[i] = size.and_then(|s| s.parse().ok());
            if sizes[i].is_some_and(|s| s <= MAX_POINTER_BYTES) {
                small.push_str(&format!("{base}:{}\n", paths[i]));
                small_idx.push(i);
            }
        }
    }
    let mut pointers: HashMap<usize, LfsPointer> = HashMap::new();
    if !small_idx.is_empty() {
        let out = git
            .output(&["cat-file", "--batch"], Some(small.into_bytes()), None)
            .await?;
        check("git", &["cat-file"], &out.output)?;
        let bytes = out.output.stdout;
        let mut pos = 0;
        for &i in &small_idx {
            let Some(nl) = bytes[pos..].iter().position(|&b| b == b'\n') else {
                break;
            };
            let header = String::from_utf8_lossy(&bytes[pos..pos + nl]).into_owned();
            pos += nl + 1;
            let Some(len) = header
                .rsplit(' ')
                .next()
                .and_then(|s| s.parse::<usize>().ok())
            else {
                continue;
            };
            let Some(body) = bytes.get(pos..pos + len) else {
                break;
            };
            if let Some(p) = parse_lfs_pointer(body) {
                pointers.insert(i, p);
            }
            pos += len + 1;
        }
    }
    Ok((0..paths.len())
        .map(|i| {
            if let Some(p) = pointers.remove(&i) {
                LfsBase::Pointer(p)
            } else if missing[i] {
                LfsBase::Missing
            } else if let Some(size) = sizes[i] {
                LfsBase::Raw(size)
            } else {
                // Unknown (odd path): never claim it is unchanged.
                LfsBase::Raw(u64::MAX)
            }
        })
        .collect())
}

fn lfs_verdicts(
    top: &Path,
    work: Vec<(String, LfsBase)>,
    started: Option<SystemTime>,
) -> Vec<(String, LfsBase, Lfs)> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let results: parking_lot::Mutex<Vec<Option<Lfs>>> =
        parking_lot::Mutex::new(work.iter().map(|_| None).collect());
    let threads = std::thread::available_parallelism()
        .map_or(2, |n| n.get())
        .clamp(1, 8);
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some((path, base)) = work.get(i) else {
                    break;
                };
                let verdict = lfs_verdict(top, path, base, started);
                results.lock()[i] = Some(verdict);
            });
        }
    });
    let results = results.into_inner();
    work.into_iter()
        .zip(results)
        .map(|((path, base), v)| (path, base, v.unwrap_or(Lfs::Changed)))
        .collect()
}

fn lfs_verdict(top: &Path, rel: &str, base: &LfsBase, started: Option<SystemTime>) -> Lfs {
    let file = top.join(rel);
    let Ok(meta) = file.symlink_metadata() else {
        return Lfs::Gone;
    };
    if !meta.is_file() {
        return Lfs::Changed;
    }
    let untouched = || matches!((meta.modified(), started), (Ok(m), Some(s)) if m < s);
    match base {
        LfsBase::Missing => Lfs::Changed,
        LfsBase::Raw(size) => {
            if meta.len() == *size && untouched() {
                Lfs::Same
            } else {
                Lfs::Changed
            }
        }
        LfsBase::Pointer(p) => {
            // A checkout made without git-lfs leaves the pointer text itself in the worktree.
            if meta.len() <= MAX_POINTER_BYTES
                && std::fs::read(&file)
                    .ok()
                    .and_then(|b| parse_lfs_pointer(&b))
                    .is_some_and(|w| w == *p)
            {
                Lfs::Same
            } else if meta.len() != p.size {
                Lfs::Changed
            } else if untouched() || cached_sha256(&file, &meta).is_some_and(|h| h == p.oid) {
                Lfs::Same
            } else {
                Lfs::Changed
            }
        }
    }
}

type HashKey = (PathBuf, u64, Option<SystemTime>, u64);

fn hash_cache() -> &'static parking_lot::Mutex<HashMap<HashKey, String>> {
    static CACHE: OnceLock<parking_lot::Mutex<HashMap<HashKey, String>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

#[cfg(unix)]
fn inode(meta: &std::fs::Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::ino(meta)
}

/// Windows has no cheap stable file id on stable Rust; path + size + mtime key it.
#[cfg(not(unix))]
fn inode(_meta: &std::fs::Metadata) -> u64 {
    0
}

/// SHA-256 (lowercase hex) of the file, streamed; remembered while its path, size,
/// mtime and inode stay the same, so reopening a review doesn't read the file again.
fn cached_sha256(path: &Path, meta: &std::fs::Metadata) -> Option<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let key: HashKey = (
        path.to_path_buf(),
        meta.len(),
        meta.modified().ok(),
        inode(meta),
    );
    if let Some(hit) = hash_cache().lock().get(&key) {
        return Some(hit.clone());
    }
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let hex: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let mut cache = hash_cache().lock();
    if cache.len() > 50_000 {
        cache.clear();
    }
    cache.insert(key, hex.clone());
    Some(hex)
}

/// Entries in `git status --porcelain -z` output. A rename or copy, in the index (X)
/// or only in the working tree (Y, e.g. after `git add -N`), carries an extra path.
fn count_porcelain(out: &str) -> i64 {
    let mut tokens = out.split('\0').filter(|t| !t.is_empty());
    let mut n = 0;
    while let Some(entry) = tokens.next() {
        n += 1;
        if entry.chars().take(2).any(|c| c == 'R' || c == 'C') {
            tokens.next();
        }
    }
    n
}

/// Changed files left in `cwd`'s checkout (after a commit). Plain git: committing
/// has already run the repository's filters and hooks.
async fn count_changes(cwd: &Path) -> i64 {
    git(
        cwd,
        &[
            "-c",
            "core.fsmonitor=false",
            "-c",
            "status.submoduleSummary=false",
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=normal",
            "--ignore-submodules=dirty",
        ],
    )
    .await
    .map(|s| count_porcelain(&s))
    .unwrap_or(0)
}

/// Splits `git diff --raw --numstat -z` output into the raw records (before the first
/// token that isn't `:<modes> <ids> <status>`) and the numstat text after them.
fn split_raw_numstat(out: &str) -> (&str, &str) {
    let mut pos = 0;
    let mut tokens = out.split('\0');
    while let Some(tok) = tokens.next() {
        if tok.starts_with(':') {
            // The record's path(s) follow: one, or two for a rename/copy.
            let status = tok.rsplit(' ').next().unwrap_or("");
            let paths = if status.starts_with(['R', 'C']) { 2 } else { 1 };
            pos += tok.len() + 1;
            for _ in 0..paths {
                if let Some(p) = tokens.next() {
                    pos += p.len() + 1;
                }
            }
        } else {
            break;
        }
    }
    out.split_at(pos.min(out.len()))
}

/// Raw records from [`split_raw_numstat`] → (path, status); same results as
/// [`parse_name_status`] on the equivalent `--name-status -z` output.
fn parse_raw(entries: &str) -> Vec<(String, ChangeStatus)> {
    let mut tokens = entries.split('\0').filter(|t| !t.is_empty());
    let mut flat = String::new();
    while let Some(tok) = tokens.next() {
        let status = tok.rsplit(' ').next().unwrap_or("M");
        flat.push_str(status);
        flat.push('\0');
        let paths = if status.starts_with(['R', 'C']) { 2 } else { 1 };
        for _ in 0..paths {
            if let Some(p) = tokens.next() {
                flat.push_str(p);
                flat.push('\0');
            }
        }
    }
    parse_name_status(&flat)
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
/// own unrelated changes, staged or not, are left alone (and counted in
/// [`CommitSummary::left_uncommitted`], so the UI can say so).
///
/// Fails with [`NothingToCommit`] when there's nothing to take.
/// `exclude` (repository-relative paths) is left out of the commit; those files stay
/// untracked in the worktree.
pub async fn commit_excluding(
    agent: &Agent,
    message: &str,
    touched: &[String],
    exclude: &[String],
) -> anyhow::Result<CommitSummary> {
    let cwd = agent_cwd(agent)?;
    let message = message.trim();
    if message.is_empty() {
        bail!("Commit message is empty");
    }
    if agent.worktree {
        ensure_lfs_commit_safe(agent, cwd, None, None).await?;
        commit_all(cwd, message, exclude).await
    } else {
        let top = PathBuf::from(
            git(cwd, &["rev-parse", "--show-toplevel"])
                .await?
                .trim_end_matches(['\r', '\n']),
        );
        let rel = repo_relative_paths(cwd, &top, touched);
        ensure_lfs_commit_safe(agent, cwd, Some(&rel), None).await?;
        let touched: Vec<String> = touched
            .iter()
            .filter(|t| !exclude.contains(t))
            .cloned()
            .collect();
        commit_paths(cwd, message, &touched).await
    }
}

/// Whether a file name looks like it holds credentials or keys (the list shared with
/// checkpoint snapshots).
pub fn looks_like_secret(path: &str) -> bool {
    armada_core::checkpoints::is_secret_path(path)
}

/// Untracked, not-ignored files that a commit of the agent's work would add and whose
/// names look like secrets (see [`looks_like_secret`]). `touched` limits the search for
/// an agent working in the user's own checkout; a worktree agent owns everything.
pub async fn pending_secret_files(
    agent: &Agent,
    touched: &[String],
) -> anyhow::Result<Vec<String>> {
    let cwd = agent_cwd(agent)?;
    let out = git(cwd, &["ls-files", "--others", "--exclude-standard", "-z"]).await?;
    Ok(nul_split(&out)
        .filter(|p| looks_like_secret(p))
        .filter(|p| agent.worktree || touched.iter().any(|t| t == p))
        .map(str::to_string)
        .collect())
}

async fn commit_all(
    cwd: &Path,
    message: &str,
    exclude: &[String],
) -> anyhow::Result<CommitSummary> {
    if exclude.is_empty() {
        git(cwd, &["add", "-A"]).await?;
    } else {
        let mut specs = vec![".".to_string()];
        specs.extend(exclude.iter().map(|p| format!(":(exclude,literal){p}")));
        git_with_pathspecs(cwd, &["add", "-A"], &specs).await?;
    }
    let files: Vec<String> = nul_split(
        &git(
            cwd,
            &["diff", "--cached", "--no-renames", "--name-only", "-z"],
        )
        .await?,
    )
    .map(str::to_string)
    .collect();
    if files.is_empty() {
        return Err(NothingToCommit("Nothing to commit".into()).into());
    }
    git(cwd, &["commit", "-m", message]).await?;
    let hash = short_head(cwd).await?;
    let left = count_changes(cwd).await;
    Ok(summary(hash, files, left, Vec::new()))
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn summary(hash: String, files: Vec<String>, left: i64, skipped: Vec<String>) -> CommitSummary {
    let mut message = format!(
        "Committed {} ({hash})",
        plural(files.len(), "file", "files")
    );
    if left > 0 {
        message.push_str(&format!(
            "; {} left uncommitted",
            if left == 1 {
                "1 other changed file was".to_string()
            } else {
                format!("{left} other changed files were")
            }
        ));
    }
    if !skipped.is_empty() {
        message.push_str(&format!(
            "; skipped {} inside a submodule or nested repository",
            plural(skipped.len(), "file", "files")
        ));
    }
    CommitSummary {
        hash,
        files,
        left_uncommitted: left,
        skipped,
        message,
    }
}

/// Index/path comparisons: git on Windows (core.ignorecase) matches paths in any case,
/// so the agent's record of a path may differ in case from the index's.
fn path_key(path: &str) -> Cow<'_, str> {
    if cfg!(windows) {
        Cow::Owned(path.to_lowercase())
    } else {
        Cow::Borrowed(path)
    }
}

/// Whether `rel` (repository-relative, '/'-separated) lies inside a nested repository
/// or checked-out submodule below `top`: git refuses to stage such paths in the outer
/// repository.
fn inside_nested_repo(top: &Path, rel: &str) -> bool {
    let mut dir = top.to_path_buf();
    let parts: Vec<&str> = rel.split('/').collect();
    for part in &parts[..parts.len().saturating_sub(1)] {
        dir.push(part);
        if dir.join(".git").symlink_metadata().is_ok() {
            return true;
        }
    }
    false
}

async fn commit_paths(
    cwd: &Path,
    message: &str,
    touched: &[String],
) -> anyhow::Result<CommitSummary> {
    const NOTHING: &str =
        "Nothing to commit: Armada hasn't seen this agent change any files in this \
                           repository. (Agents without their own worktree only commit the files \
                           they edited; commit anything else yourself.)";
    let nothing = || anyhow::Error::new(NothingToCommit(NOTHING.into()));
    let top = PathBuf::from(
        git(cwd, &["rev-parse", "--show-toplevel"])
            .await?
            .trim_end_matches(['\r', '\n']),
    );
    let (mut skipped, paths): (Vec<String>, Vec<String>) = repo_relative_paths(cwd, &top, touched)
        .into_iter()
        .partition(|p| inside_nested_repo(&top, p));
    if paths.is_empty() {
        if !skipped.is_empty() {
            return Err(NothingToCommit(
                "Nothing to commit here: the files this agent changed are inside a submodule \
                 or nested repository. Commit them in that repository."
                    .into(),
            )
            .into());
        }
        return Err(nothing());
    }

    // The user's index entries for these paths, to put back if the commit fails.
    let before = index_entries(&top, &paths).await?;
    if let Some(conflicted) = before.values().find(|e| e.stage != 0) {
        bail!(
            "{} has merge conflicts. Resolve them before committing.",
            conflicted.path
        );
    }
    // A touched path that is itself a submodule (gitlink): not the agent's file.
    let (gitlinks, paths): (Vec<String>, Vec<String>) = paths.into_iter().partition(|p| {
        before
            .get(path_key(p).as_ref())
            .is_some_and(|e| e.mode == "160000")
    });
    skipped.extend(gitlinks);
    // Ignored, untracked files (build output, .env…) are never committed.
    let ignored = ignored_paths(&top, &paths).await?;
    // Only files: a directory path would sweep in everything under it, including the
    // user's own untracked files. Tracked paths gone from disk are deletions to record.
    let stageable: Vec<String> = paths
        .iter()
        .filter(|p| {
            before.contains_key(path_key(p).as_ref())
                || (!ignored.contains(*p)
                    && top.join(p).symlink_metadata().is_ok_and(|m| !m.is_dir()))
        })
        .cloned()
        .collect();
    if stageable.is_empty() {
        return Err(nothing());
    }
    git_with_pathspecs(&top, &["--literal-pathspecs", "add", "-A"], &stageable).await?;

    // What is now staged among those paths (includes deletions staged earlier).
    // `--no-renames` so both sides of a move are listed.
    let wanted: HashSet<Cow<str>> = paths.iter().map(|p| path_key(p)).collect();
    let staged: Vec<String> = nul_split(
        &git(
            &top,
            &[
                "diff",
                "--cached",
                "--no-renames",
                "--no-ext-diff",
                "--name-only",
                "-z",
            ],
        )
        .await?,
    )
    .filter(|p| wanted.contains(&path_key(p)))
    .map(str::to_string)
    .collect();
    if staged.is_empty() {
        return Err(nothing());
    }

    // `--only`: commit exactly these paths, leaving anything else the user staged staged.
    let committed = git_with_pathspecs(
        &top,
        &["--literal-pathspecs", "commit", "--only", "-m", message],
        &staged,
    )
    .await;
    if let Err(e) = committed {
        // Hook rejected it, no identity, signing failed…: leave the user's index as
        // it was before we staged anything.
        return Err(match restore_index(&top, &stageable, &before).await {
            Ok(()) => e.context("The commit failed; nothing was staged or committed"),
            Err(restore) => e.context(format!(
                "The commit failed, and restoring the staging area also failed ({restore:#}); \
                 check `git status`"
            )),
        });
    }
    let hash = short_head(cwd).await?;
    let left = count_changes(&top).await;
    Ok(summary(hash, staged, left, skipped))
}

/// One index entry (`git ls-files -s`).
struct IndexEntry {
    /// The path as the index spells it.
    path: String,
    mode: String,
    oid: String,
    stage: u8,
}

/// Index entries for exactly `paths` (entries under a directory path aren't included),
/// keyed by [`path_key`].
async fn index_entries(
    top: &Path,
    paths: &[String],
) -> anyhow::Result<HashMap<String, IndexEntry>> {
    let wanted: HashSet<Cow<str>> = paths.iter().map(|p| path_key(p)).collect();
    let out = git_chunked(top, &["--literal-pathspecs", "ls-files", "-s", "-z"], paths).await?;
    let mut entries = HashMap::new();
    for record in nul_split(&out) {
        // "<mode> <oid> <stage>\t<path>"
        let Some((meta, path)) = record.split_once('\t') else {
            continue;
        };
        let key = path_key(path);
        if !wanted.contains(&key) {
            continue;
        }
        let mut meta = meta.split(' ');
        let (Some(mode), Some(oid), Some(stage)) = (meta.next(), meta.next(), meta.next()) else {
            continue;
        };
        let stage: u8 = stage.parse().unwrap_or(0);
        // A conflict has several stages; keep the one that's reported as a conflict.
        if entries
            .get(key.as_ref())
            .is_some_and(|e: &IndexEntry| e.stage != 0)
        {
            continue;
        }
        entries.insert(
            key.into_owned(),
            IndexEntry {
                path: path.to_string(),
                mode: mode.to_string(),
                oid: oid.to_string(),
                stage,
            },
        );
    }
    Ok(entries)
}

/// Which of `paths` are ignored and untracked.
async fn ignored_paths(top: &Path, paths: &[String]) -> anyhow::Result<HashSet<String>> {
    let out = output(
        "git",
        top,
        &["check-ignore", "-z", "--stdin"],
        Opts {
            stdin: Some(nul_joined(paths)),
            ..Opts::default()
        },
    )
    .await?;
    // Exit status 1 = none of the paths is ignored.
    if out.status.code() != Some(1) {
        check("git", &["check-ignore"], &out)?;
    }
    Ok(nul_split(&String::from_utf8_lossy(&out.stdout))
        .map(str::to_string)
        .collect())
}

/// Puts the index entries of `paths` back to `before` (removing ones that weren't there).
async fn restore_index(
    top: &Path,
    paths: &[String],
    before: &HashMap<String, IndexEntry>,
) -> anyhow::Result<()> {
    let mut entries = Vec::new();
    let mut removed = Vec::new();
    for path in paths {
        match before.get(path_key(path).as_ref()) {
            Some(e) => {
                entries.extend_from_slice(format!("{} {} 0\t{}", e.mode, e.oid, e.path).as_bytes());
                entries.push(0);
            }
            None => removed.push(path.clone()),
        }
    }
    if !removed.is_empty() {
        git_stdin(
            top,
            &["update-index", "-z", "--force-remove", "--stdin"],
            nul_joined(&removed),
        )
        .await?;
    }
    if !entries.is_empty() {
        git_stdin(top, &["update-index", "-z", "--index-info"], entries).await?;
    }
    Ok(())
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

/// Canonicalizes the longest existing ancestor of `path` (resolving symlinks such as
/// macOS's /var → /private/var) and re-appends the rest; `..` in the missing part is
/// resolved lexically.
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

/// The checks `merge` makes on the project before touching anything, so "Commit &
/// merge" can refuse up front instead of committing and then failing to merge.
/// Returns (branch, base, project).
pub async fn merge_preflight(agent: &Agent) -> anyhow::Result<(&str, &str, &Path)> {
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
    // `symbolic-ref` (not `rev-parse --abbrev-ref HEAD`) also works before the first
    // commit, and tells a detached HEAD apart.
    let head = output(
        "git",
        project,
        &["symbolic-ref", "-q", "--short", "HEAD"],
        Opts::default(),
    )
    .await?;
    let current = match head.status.code() {
        Some(0) => String::from_utf8_lossy(&head.stdout).trim().to_string(),
        Some(1) => bail!(
            "{} has a detached HEAD (no branch checked out); check out `{base}` there to merge.",
            agent.project_path
        ),
        _ => {
            check("git", &["symbolic-ref"], &head)?;
            String::new()
        }
    };
    let born = output(
        "git",
        project,
        &["rev-parse", "--verify", "-q", "HEAD^{commit}"],
        Opts::default(),
    )
    .await?;
    if !born.status.success() {
        bail!(
            "{} has no commits yet. Make a first commit on `{current}` before merging into it.",
            agent.project_path
        );
    }
    if current != base {
        if let Some(elsewhere) = worktree_with_branch(project, base).await {
            bail!(
                "`{base}` is checked out in another worktree ({}), not in {}. Merge `{branch}` \
                 there, or check `{base}` out in {}.",
                elsewhere.display(),
                agent.project_path,
                agent.project_path
            );
        }
        bail!(
            "{} has `{current}` checked out; switch it to `{base}` to merge.",
            agent.project_path
        );
    }
    let dirty = git(
        project,
        &[
            "status",
            "--porcelain",
            "--untracked-files=no",
            "--ignore-submodules=dirty",
        ],
    )
    .await?;
    if !dirty.trim().is_empty() {
        bail!(
            "{} has uncommitted changes. Commit or stash them before merging.",
            agent.project_path
        );
    }
    Ok((branch, base, project))
}

/// The worktree (other than `project` itself) that has `branch` checked out.
async fn worktree_with_branch(project: &Path, branch: &str) -> Option<PathBuf> {
    let list = git(project, &["worktree", "list", "--porcelain", "-z"])
        .await
        .ok()?;
    let wanted = format!("branch refs/heads/{branch}");
    let here = lenient_canonicalize(project);
    let mut path: Option<&str> = None;
    for field in list.split('\0') {
        if let Some(p) = field.strip_prefix("worktree ") {
            path = Some(p);
        } else if field == wanted {
            let p = PathBuf::from(path?);
            return (lenient_canonicalize(&p) != here).then_some(p);
        }
    }
    None
}

/// Merges the agent's branch into its base branch in the project checkout.
///
/// Hooks: the merge runs the project's own hooks (pre-merge-commit, commit-msg,
/// post-merge), exactly like `git merge` in a terminal. A worktree agent shares the
/// repository's hooks directory (`.git/hooks`), so it could plant a hook that runs
/// here. Disabling hooks for this merge (`-c core.hooksPath=<empty dir>`) was
/// considered and rejected: it would silently skip the user's legitimate hooks (commit
/// message checks, post-merge installs), and it wouldn't close the hole anyway, since a
/// planted hook (or `.git/config`) also runs on the user's own next `git commit`.
/// Isolating the agent from `.git` is the sandbox's job, not the merge's.
pub async fn merge(agent: &Agent) -> anyhow::Result<String> {
    let (branch, base, project) = merge_preflight(agent).await?;
    let agent_dirty = git(
        agent_cwd(agent)?,
        &["status", "--porcelain", "--ignore-submodules=dirty"],
    )
    .await?;
    if !agent_dirty.trim().is_empty() {
        bail!("The agent has uncommitted changes. Commit them before merging.");
    }
    // `git merge` exits 0 with "Already up to date." when there is nothing to merge;
    // don't report the previous commit's stats as this merge's.
    let merged = output(
        "git",
        project,
        &["merge-base", "--is-ancestor", branch, "HEAD"],
        Opts::default(),
    )
    .await?;
    match merged.status.code() {
        Some(0) => {
            return Ok(format!(
                "Nothing to merge: {base} already contains {branch}"
            ))
        }
        Some(1) => {}
        _ => check("git", &["merge-base"], &merged)?,
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

/// Where the base branch stands against its upstream, as last fetched. "Commit &
/// merge" only updates the local base branch; this says what a push would send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseBranchStatus {
    pub branch: String,
    /// Short name of the upstream ("origin/master"); `None` when the base has none.
    pub upstream: Option<String>,
    /// Local commits the upstream doesn't have.
    pub ahead: u32,
    /// Upstream commits (as last fetched) the local branch doesn't have.
    pub behind: u32,
}

fn base_of(agent: &Agent) -> anyhow::Result<(&str, &Path)> {
    let Some(base) = agent.base_branch.as_deref() else {
        bail!("Only agents running in their own worktree branch have a base branch");
    };
    let project = Path::new(&agent.project_path);
    if !project.is_dir() {
        bail!(
            "The project folder no longer exists: {}",
            agent.project_path
        );
    }
    Ok((base, project))
}

/// Upstream and ahead/behind of the agent's base branch (no network).
pub async fn base_branch_status(agent: &Agent) -> anyhow::Result<BaseBranchStatus> {
    let (base, project) = base_of(agent)?;
    let none = BaseBranchStatus {
        branch: base.to_string(),
        upstream: None,
        ahead: 0,
        behind: 0,
    };
    let spec = format!("{base}@{{upstream}}");
    let up = output(
        "git",
        project,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", &spec],
        Opts::default(),
    )
    .await?;
    if !up.status.success() {
        return Ok(none);
    }
    let upstream = String::from_utf8_lossy(&up.stdout).trim().to_string();
    if upstream.is_empty() {
        return Ok(none);
    }
    let range = format!("{base}...{spec}");
    let counts = output(
        "git",
        project,
        &["rev-list", "--left-right", "--count", &range, "--"],
        Opts::default(),
    )
    .await?;
    if !counts.status.success() {
        // Upstream configured but never fetched / deleted: nothing to compare against.
        return Ok(BaseBranchStatus {
            upstream: Some(upstream),
            ..none
        });
    }
    let text = String::from_utf8_lossy(&counts.stdout).into_owned();
    let mut nums = text.split_whitespace().map(|n| n.parse().unwrap_or(0));
    Ok(BaseBranchStatus {
        upstream: Some(upstream),
        ahead: nums.next().unwrap_or(0),
        behind: nums.next().unwrap_or(0),
        ..none
    })
}

/// Pushes the base branch to its upstream (never forced) and returns the new status.
pub async fn push_base_branch(agent: &Agent) -> anyhow::Result<BaseBranchStatus> {
    let (base, project) = base_of(agent)?;
    let status = base_branch_status(agent).await?;
    let Some(upstream) = status.upstream.as_deref() else {
        bail!(
            "{base} has no upstream branch; push it from a terminal with git push -u origin {base}"
        );
    };
    let config = |key: &str| {
        let key = format!("branch.{base}.{key}");
        async move {
            let out = output("git", project, &["config", "--get", &key], Opts::default()).await?;
            anyhow::Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
    };
    let remote = config("remote").await?;
    let merge_ref = config("merge").await?;
    if remote.is_empty()
        || remote == "."
        || remote.starts_with('-')
        || remote.contains(char::is_whitespace)
    {
        bail!("{base} tracks `{upstream}`, which isn't on a remote Armada can push to; push it from a terminal.");
    }
    if !merge_ref.starts_with("refs/heads/") {
        bail!("{base}'s upstream `{upstream}` isn't a branch; push it from a terminal.");
    }
    let refspec = format!("refs/heads/{base}:{merge_ref}");
    let pushed = run_opts(
        "git",
        project,
        &["push", &remote, &refspec],
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
            || text.contains("tip of your current branch is behind")
        {
            bail!("{upstream} has new commits; pull first");
        }
        return Err(e.context(format!("pushing {base} to {upstream}")));
    }
    base_branch_status(agent).await
}

/// Pushes the agent's branch and opens a pull request into its base branch. Returns
/// the new PR's URL, or "A pull request already exists: <url>" if the branch has one
/// (the push has then updated it).
pub async fn create_pr(agent: &Agent, title: &str, body: &str) -> anyhow::Result<String> {
    let (Some(branch), Some(base)) = (agent.branch.as_deref(), agent.base_branch.as_deref()) else {
        bail!("Pull requests need an agent running on its own branch (enable worktree)");
    };
    if !agent.worktree {
        bail!("Pull requests need an agent running on its own branch (enable worktree)");
    }
    let cwd = agent_cwd(agent)?;
    let title = if title.trim().is_empty() {
        agent.title.as_str()
    } else {
        title.trim()
    };
    let dirty = git(cwd, &["status", "--porcelain", "--ignore-submodules=dirty"]).await?;
    if !dirty.trim().is_empty() {
        bail!("The agent has uncommitted changes. Commit them before opening a pull request, so they're part of it.");
    }
    let ahead: i64 = git(
        cwd,
        &["rev-list", "--count", &format!("{base}..{branch}"), "--"],
    )
    .await
    .map_err(|e| e.context(format!("comparing {branch} with {base}")))?
    .trim()
    .parse()
    .unwrap_or(0);
    if ahead == 0 {
        bail!("{branch} has no commits that aren't already in {base}, so there's nothing to open a pull request for.");
    }
    // Fail fast with a friendly message before pushing anything.
    which::which("gh").map_err(|_| {
        anyhow!("The GitHub CLI (gh) is not installed. Get it from https://cli.github.com")
    })?;
    let remote = push_remote(cwd, branch).await?;
    run_opts(
        "git",
        cwd,
        &["push", "-u", &remote, branch],
        Opts {
            timeout: Some(PUSH_TIMEOUT),
            ..Opts::default()
        },
    )
    .await?;
    let gh = |args: Vec<&str>| {
        let args: Vec<String> = args.into_iter().map(str::to_string).collect();
        async move {
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            run_opts(
                "gh",
                cwd,
                &args,
                Opts {
                    timeout: Some(GH_TIMEOUT),
                    ..Opts::default()
                },
            )
            .await
        }
    };
    let existing = gh(vec![
        "pr", "list", "--head", branch, "--base", base, "--state", "open", "--json", "url", "--jq",
        ".[0].url",
    ])
    .await
    .ok()
    .and_then(|out| last_url(&out));
    if let Some(url) = existing {
        return Ok(format!("A pull request already exists: {url}"));
    }
    let created = gh(vec![
        "pr", "create", "--title", title, "--body", body, "--head", branch, "--base", base,
    ])
    .await;
    match created {
        Ok(out) => Ok(last_url(&out).unwrap_or_else(|| out.trim().to_string())),
        // Raced with someone else creating it (or `pr list` couldn't see it).
        Err(e) if format!("{e:#}").contains("already exists") => {
            match last_url(&format!("{e:#}")) {
                Some(url) => Ok(format!("A pull request already exists: {url}")),
                None => Err(e),
            }
        }
        Err(e) => Err(e),
    }
}

/// The last http(s) URL that ends a line of `out`.
fn last_url(out: &str) -> Option<String> {
    out.lines()
        .rev()
        .filter_map(|l| l.split_whitespace().last())
        .find(|w| w.starts_with("https://") || w.starts_with("http://"))
        .map(str::to_string)
}

/// The remote `branch` tracks, else `origin`.
async fn push_remote(cwd: &Path, branch: &str) -> anyhow::Result<String> {
    let key = format!("branch.{branch}.remote");
    let configured = output("git", cwd, &["config", "--get", &key], Opts::default()).await?;
    let configured = String::from_utf8_lossy(&configured.stdout)
        .trim()
        .to_string();
    // "." means a local upstream, which can't host a pull request.
    if !configured.is_empty() && configured != "." {
        return Ok(configured);
    }
    let remotes = git(cwd, &["remote"]).await?;
    if remotes.lines().any(|r| r.trim() == "origin") {
        return Ok("origin".into());
    }
    bail!(
        "This repository has no `origin` remote to push {branch} to. Add one (`git remote add origin <url>`) or set the branch's upstream, then try again."
    )
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
                // Without Windows' \\?\ prefix, which git can't handle.
                dir: plain_path(&dir.canonicalize().unwrap()),
            };
            repo.git(&["init", "-q"]);
            // Byte-exact checkouts whatever the machine's git config says.
            repo.git(&["config", "core.autocrlf", "false"]);
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
        // No commit yet: everything is new (diffed against the empty tree), and still
        // no index is created.
        let diff = diff_worktree(&repo.dir, None).await.unwrap();
        let mut paths: Vec<_> = diff.files.iter().map(|f| f.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec![".gitignore", "a.txt"]);
        assert!(diff.files.iter().all(|f| f.status == ChangeStatus::Added));
        assert!(diff.patch.contains("+one"), "{}", diff.patch);
        assert_eq!(diff.ahead, 0);
        assert_eq!(diff.uncommitted, 2);
        assert!(repo.index_bytes().is_none());
        assert!(repo.leftover_temp_indexes().is_empty());
    }

    /// Reported: `git add -N` turns an untracked embedded repository into a gitlink,
    /// and checking a gitlink for local changes runs git inside it with its own
    /// config, out of reach of our overrides. Its filters must not run.
    #[cfg(unix)]
    #[tokio::test]
    async fn diff_never_runs_a_nested_repositorys_filters() {
        let repo = Repo::new();
        repo.write("a.txt", "one\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);

        let inner = repo.dir.join("vendor/inner");
        std::fs::create_dir_all(&inner).unwrap();
        let in_inner = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&inner)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        in_inner(&["init", "-q"]);
        in_inner(&["config", "user.name", "Armada Test"]);
        in_inner(&["config", "user.email", "test@armada.invalid"]);
        in_inner(&["config", "core.hooksPath", "/dev/null"]);
        std::fs::write(inner.join("f.txt"), "hi\n").unwrap();
        std::fs::write(inner.join(".gitattributes"), "f.txt filter=evil\n").unwrap();
        in_inner(&["add", "-A"]);
        in_inner(&["commit", "-q", "-m", "inner"]);
        let marker = std::env::temp_dir().join(format!("armada-nested-{}", uuid::Uuid::new_v4()));
        in_inner(&[
            "config",
            "filter.evil.clean",
            &format!("touch '{}'; cat", marker.display()),
        ]);
        // Stat-dirty, content unchanged: git must re-read (and filter) it to tell.
        let old = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
        std::fs::File::options()
            .write(true)
            .open(inner.join("f.txt"))
            .unwrap()
            .set_modified(old)
            .unwrap();

        let diff = diff_worktree(&repo.dir, None).await.unwrap();
        let ran = marker.exists();
        let _ = std::fs::remove_file(&marker);
        assert!(!ran, "the nested repository's clean filter ran");
        assert!(
            diff.files.iter().any(|f| f.path == "vendor/inner"),
            "{:?}",
            diff.files
        );
        assert!(repo.leftover_temp_indexes().is_empty());
    }

    #[tokio::test]
    async fn huge_patches_are_cut_at_a_file_boundary() {
        let repo = Repo::new();
        repo.write("a.txt", "a\n");
        repo.write("b.txt", "b\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        repo.write("a.txt", &"a line\n".repeat(50));
        repo.write("b.txt", &"b line\n".repeat(5000));
        let git = ReadOnlyGit::new(&repo.dir).await.unwrap();
        let (full, truncated) = git.patch(&["HEAD"], MAX_PATCH_BYTES).await.unwrap();
        assert!(!truncated);
        let (cut, truncated) = git.patch(&["HEAD"], 4096).await.unwrap();
        assert!(truncated);
        assert!(cut.starts_with("diff --git a/a.txt b/a.txt\n"), "{cut}");
        assert!(!cut.contains("b.txt"), "{cut}");
        assert!(full.starts_with(&cut));
        assert!(cut.ends_with('\n'));
    }

    #[test]
    fn patch_truncation() {
        let patch = b"diff --git a/x b/x\n+1\ndiff --git a/y b/y\n+22222\n";
        assert_eq!(
            truncate_patch(patch, patch.len()),
            b"diff --git a/x b/x\n+1\n"
        );
        assert_eq!(truncate_patch(patch, 23), b"diff --git a/x b/x\n+1\n");
        assert_eq!(truncate_patch(patch, 22), b"diff --git a/x b/x\n+1\n");
        assert_eq!(truncate_patch(patch, 21), b"");
        assert_eq!(truncate_patch(patch, 5), b"");
    }

    #[tokio::test]
    async fn stale_temp_indexes_are_swept() {
        let repo = Repo::new();
        repo.write("a.txt", "one\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        let git_dir = repo.dir.join(".git");
        let stale = git_dir.join("armada-index-stale");
        let fresh = git_dir.join("armada-index-fresh");
        std::fs::write(&stale, "x").unwrap();
        std::fs::write(&fresh, "x").unwrap();
        let old = SystemTime::now() - STALE_TEMP_INDEX - Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(old)
            .unwrap();
        diff_worktree(&repo.dir, None).await.unwrap();
        assert!(!stale.exists());
        assert!(fresh.exists(), "a concurrent diff's index must survive");
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

    /// The UI is told what was committed and what was left behind.
    #[tokio::test]
    async fn commit_reports_files_and_what_was_left() {
        let repo = Repo::new();
        repo.write("agent.txt", "a\n");
        repo.write("user.txt", "u\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        repo.write("agent.txt", "a2\n");
        repo.write("user.txt", "u2\n");
        repo.write("scratch.txt", "mine\n");
        // A nested repository the agent also wrote into.
        let inner = repo.dir.join("libs/inner");
        std::fs::create_dir_all(&inner).unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&inner)
            .status()
            .unwrap()
            .success());
        repo.write("libs/inner/x.txt", "x\n");

        let summary = commit_paths(
            &repo.dir,
            "agent work",
            &["agent.txt".into(), "libs/inner/x.txt".into()],
        )
        .await
        .unwrap();
        assert_eq!(summary.files, vec!["agent.txt"]);
        assert_eq!(summary.skipped, vec!["libs/inner/x.txt"]);
        // user.txt, scratch.txt and the nested repository.
        assert_eq!(summary.left_uncommitted, 3);
        assert_eq!(
            summary.message,
            format!(
                "Committed 1 file ({}); 3 other changed files were left uncommitted; \
                 skipped 1 file inside a submodule or nested repository",
                summary.hash
            )
        );
        assert_eq!(
            repo.lines(&["show", "--name-only", "--format=", "HEAD"]),
            vec!["agent.txt"]
        );

        // Only nested-repository files: nothing to commit, and it says why.
        let err = commit_paths(&repo.dir, "msg", &["libs/inner/x.txt".into()])
            .await
            .unwrap_err();
        assert!(err.is::<NothingToCommit>());
        assert!(err.to_string().contains("nested repository"), "{err}");
    }

    #[tokio::test]
    async fn commit_all_with_nothing_is_a_typed_error() {
        let repo = Repo::new();
        repo.write("a.txt", "a\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        let err = commit_all(&repo.dir, "msg", &[]).await.unwrap_err();
        assert!(err.is::<NothingToCommit>(), "{err:#}");
        repo.write("b.txt", "b\n");
        let summary = commit_all(&repo.dir, "msg", &[]).await.unwrap();
        assert_eq!(summary.files, vec!["b.txt"]);
        assert_eq!(summary.left_uncommitted, 0);
        assert_eq!(
            summary.message,
            format!("Committed 1 file ({})", summary.hash)
        );
    }

    #[test]
    fn agent_git_operations_dont_overlap() {
        let id = format!("agent-{}", uuid::Uuid::new_v4());
        let guard = try_lock_agent(&id).unwrap();
        assert!(try_lock_agent(&id).is_err());
        assert!(try_lock_agent("another-agent").is_ok());
        drop(guard);
        assert!(try_lock_agent(&id).is_ok());
    }

    #[test]
    fn counts_porcelain_entries() {
        // Index rename, worktree-only rename (intent-to-add), plain entries.
        let out = "R  new.txt\0old.txt\0 R moved.txt\0orig.txt\0 M a.txt\0?? b.txt\0";
        assert_eq!(count_porcelain(out), 4);
        assert_eq!(count_porcelain(""), 0);
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

    /// The UI parses `diff --git a/… b/…`; user config must not change the shape.
    #[tokio::test]
    async fn diff_output_ignores_user_diff_config() {
        let repo = Repo::new();
        repo.write("café.txt", "one\n");
        repo.write("sub/x.txt", "x\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        for (key, value) in [
            ("diff.mnemonicPrefix", "true"),
            ("diff.noprefix", "true"),
            ("diff.relative", "true"),
            ("diff.renames", "false"),
            ("core.quotePath", "true"),
            ("color.ui", "always"),
            ("color.diff", "always"),
        ] {
            repo.git(&["config", key, value]);
        }
        repo.write("café.txt", "one\ntwo\n");
        repo.write("sub/x.txt", "x\ny\n");

        // From a subfolder, where diff.relative would hide the root file.
        let diff = diff_worktree(&repo.dir.join("sub"), None).await.unwrap();
        let mut paths: Vec<_> = diff.files.iter().map(|f| f.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec!["café.txt", "sub/x.txt"]);
        assert!(
            diff.files.iter().all(|f| f.additions == 1),
            "{:?}",
            diff.files
        );
        assert!(
            diff.patch.contains("diff --git a/café.txt b/café.txt\n"),
            "{}",
            diff.patch
        );
        assert!(diff.patch.contains("--- a/café.txt\n+++ b/café.txt\n"));
        assert!(diff.patch.contains("diff --git a/sub/x.txt b/sub/x.txt\n"));
        assert!(!diff.patch.contains('\x1b'), "no color codes");
    }

    /// A rejected commit (hook, identity, signing) leaves the user's index as it was.
    #[cfg(unix)]
    #[tokio::test]
    async fn failed_commit_restores_the_index() {
        use std::os::unix::fs::PermissionsExt;
        let repo = Repo::new();
        repo.write("agent.txt", "a\n");
        repo.write("user.txt", "u\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        // The repo's own `core.hooksPath` is ignored by Armada; `.git/hooks` is honored.
        std::fs::create_dir_all(repo.dir.join(".git/hooks")).unwrap();
        std::fs::write(
            repo.dir.join(".git/hooks/pre-commit"),
            "#!/bin/sh\necho 'tests are red' >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(
            repo.dir.join(".git/hooks/pre-commit"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();

        repo.write("user.txt", "u2\n");
        repo.git(&["add", "user.txt"]);
        repo.write("agent.txt", "a2\n");
        repo.write("new.txt", "n\n");
        let before = repo.index_bytes().unwrap();

        let err = commit_paths(
            &repo.dir,
            "agent work",
            &["agent.txt".into(), "new.txt".into()],
        )
        .await
        .unwrap_err();
        assert!(format!("{err:#}").contains("tests are red"), "{err:#}");
        assert_eq!(repo.lines(&["rev-list", "--count", "HEAD"]), vec!["1"]);
        assert_eq!(
            repo.lines(&["diff", "--cached", "--name-only"]),
            vec!["user.txt"]
        );
        let status = repo.git(&["status", "--porcelain"]);
        assert!(status.contains("?? new.txt"), "{status}");
        assert!(status.contains(" M agent.txt"), "{status}");
        // Same entries (only stat data may differ).
        let after = repo.git(&["ls-files", "-s"]);
        std::fs::write(repo.dir.join(".git/index"), &before).unwrap();
        assert_eq!(after, repo.git(&["ls-files", "-s"]));
    }

    #[tokio::test]
    async fn commit_skips_directories() {
        let repo = Repo::new();
        repo.write("src/lib.rs", "a\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        repo.write("src/lib.rs", "b\n");
        repo.write("src/users-own.rs", "mine\n");

        let err = commit_paths(&repo.dir, "msg", &["src".into()])
            .await
            .unwrap_err();
        assert!(err.to_string().starts_with("Nothing to commit"), "{err}");

        commit_paths(&repo.dir, "msg", &["src".into(), "src/lib.rs".into()])
            .await
            .unwrap();
        assert_eq!(
            repo.lines(&["show", "--name-only", "--format=", "HEAD"]),
            vec!["src/lib.rs"]
        );
        assert!(repo
            .git(&["status", "--porcelain"])
            .contains("?? src/users-own.rs"));
    }

    /// Thousands of paths go through stdin, not the command line (Windows: 32 KiB).
    #[tokio::test]
    async fn commit_many_paths() {
        let repo = Repo::new();
        repo.write("seed.txt", "s\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        let names: Vec<String> = (0..1500)
            .map(|i| format!("generated/a-fairly-long-file-name-number-{i:05}.txt"))
            .collect();
        for name in &names {
            repo.write(name, "x\n");
        }
        commit_paths(&repo.dir, "many", &names).await.unwrap();
        assert_eq!(
            repo.lines(&["show", "--name-only", "--format=", "HEAD"])
                .len(),
            names.len()
        );
    }

    fn worktree_agent(repo: &Repo, wt: &Path, branch: &str, base: &str) -> Agent {
        serde_json::from_value(serde_json::json!({
            "id": "a1",
            "title": "Agent",
            "provider": "grok",
            "accountId": "acc",
            "projectPath": repo.dir.display().to_string(),
            "cwd": wt.display().to_string(),
            "worktree": true,
            "branch": branch,
            "baseBranch": base,
            "status": "idle",
            "running": false,
            "createdAt": 0,
            "updatedAt": 0,
            "lastActivityAt": 0,
            "costUsd": 0.0,
            "tokensUsed": 0,
            "unread": false,
            "archived": false,
            "pendingPermissions": 0
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn revert_file_and_hunk() {
        let repo = Repo::new();
        let lines: String = (1..=30).map(|i| format!("line {i}\n")).collect();
        repo.write("a.txt", &lines);
        repo.write("b.txt", "keep\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        let agent = worktree_agent(&repo, &repo.dir, "main", "main");
        repo.write(
            "a.txt",
            &lines
                .replace("line 2\n", "TWO\n")
                .replace("line 29\n", "TWENTY-NINE\n"),
        );
        repo.write("b.txt", "changed\n");
        repo.write("new.txt", "fresh\n");
        let diff = get_diff(&agent).await.unwrap();
        assert_eq!(diff.uncommitted, 3);

        // Split the patch into per-file sections, like the UI does.
        let sections: Vec<String> = diff
            .patch
            .split("diff --git ")
            .filter(|s| !s.is_empty())
            .map(|s| format!("diff --git {s}"))
            .collect();
        let section = |name: &str| {
            sections
                .iter()
                .find(|s| s.starts_with(&format!("diff --git a/{name} ")))
                .unwrap()
                .clone()
        };

        // Whole files: a modified one and a brand-new one.
        revert_patch(&agent, &section("b.txt")).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.dir.join("b.txt")).unwrap(),
            "keep\n"
        );
        revert_patch(&agent, &section("new.txt")).await.unwrap();
        assert!(!repo.dir.join("new.txt").exists());

        // One hunk of a.txt: header plus the second hunk only.
        let a = section("a.txt");
        let first_hunk = a.find("\n@@").unwrap() + 1;
        let second_hunk = a[first_hunk + 2..].find("\n@@").unwrap() + first_hunk + 3;
        let hunk = format!("{}{}", &a[..first_hunk], &a[second_hunk..]);
        revert_patch(&agent, &hunk).await.unwrap();
        let now = std::fs::read_to_string(repo.dir.join("a.txt")).unwrap();
        assert!(now.contains("TWO\n") && now.contains("line 29\n"), "{now}");

        // A stale patch changes nothing and says why.
        let err = revert_patch(&agent, &section("b.txt")).await.unwrap_err();
        assert!(
            format!("{err:#}").contains("couldn't be reverted"),
            "{err:#}"
        );
        assert!(revert_patch(&agent, "rm -rf /").await.is_err());
    }

    #[tokio::test]
    async fn merge_with_nothing_new_says_so() {
        let repo = Repo::new();
        repo.write("a.txt", "a\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        let base = repo
            .git(&["rev-parse", "--abbrev-ref", "HEAD"])
            .trim()
            .to_string();
        let wt = repo.dir.join("hooks-none").join("wt");
        repo.git(&[
            "worktree",
            "add",
            "-q",
            "-b",
            "agent-x",
            wt.to_str().unwrap(),
        ]);
        let agent = worktree_agent(&repo, &wt, "agent-x", &base);

        let msg = merge(&agent).await.unwrap();
        assert!(msg.starts_with("Nothing to merge"), "{msg}");
        assert_eq!(repo.lines(&["rev-list", "--count", "HEAD"]), vec!["1"]);

        std::fs::write(wt.join("b.txt"), "b\n").unwrap();
        commit_all(&wt, "agent commit", &[]).await.unwrap();
        let msg = merge(&agent).await.unwrap();
        assert!(msg.starts_with("Merged agent-x"), "{msg}");
        assert!(msg.contains("1 file changed"), "{msg}");
    }

    fn worktree_setup() -> (Repo, PathBuf, String) {
        let repo = Repo::new();
        repo.write("a.txt", "a\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        let base = repo
            .git(&["rev-parse", "--abbrev-ref", "HEAD"])
            .trim()
            .to_string();
        let wt = repo.dir.join("hooks-none").join("wt");
        repo.git(&[
            "worktree",
            "add",
            "-q",
            "-b",
            "agent-x",
            wt.to_str().unwrap(),
        ]);
        (repo, wt, base)
    }

    /// `worktree_setup` plus a bare "origin" the base branch tracks.
    fn with_origin() -> (Repo, PathBuf, String, PathBuf) {
        let (repo, wt, base) = worktree_setup();
        let origin = repo.dir.join("hooks-none").join("origin.git");
        repo.git(&["init", "-q", "--bare", origin.to_str().unwrap()]);
        repo.git(&["remote", "add", "origin", origin.to_str().unwrap()]);
        repo.git(&["push", "-q", "-u", "origin", &base]);
        (repo, wt, base, origin)
    }

    #[tokio::test]
    async fn merge_is_local_until_base_is_pushed() {
        let (repo, wt, base, origin) = with_origin();
        let agent = worktree_agent(&repo, &wt, "agent-x", &base);
        std::fs::write(wt.join("b.txt"), "b\n").unwrap();
        commit_all(&wt, "agent commit", &[]).await.unwrap();
        merge(&agent).await.unwrap();

        let st = base_branch_status(&agent).await.unwrap();
        assert_eq!(
            st.upstream.as_deref(),
            Some(format!("origin/{base}").as_str())
        );
        assert_eq!((st.ahead, st.behind), (2, 0), "{st:?}");

        let st = push_base_branch(&agent).await.unwrap();
        assert_eq!((st.ahead, st.behind), (0, 0), "{st:?}");
        let remote_head = std::process::Command::new("git")
            .args(["rev-list", "--count", &base])
            .current_dir(&origin)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&remote_head.stdout).trim(), "3");
    }

    #[tokio::test]
    async fn pushing_a_base_without_upstream_explains() {
        let (repo, wt, base) = worktree_setup();
        let agent = worktree_agent(&repo, &wt, "agent-x", &base);
        let st = base_branch_status(&agent).await.unwrap();
        assert_eq!(st.upstream, None);
        let err = push_base_branch(&agent).await.unwrap_err();
        assert!(
            format!("{err:#}").contains(&format!("{base} has no upstream branch; push it from a terminal with git push -u origin {base}")),
            "{err:#}"
        );
    }

    #[tokio::test]
    async fn pushing_a_diverged_base_is_rejected() {
        let (repo, wt, base, origin) = with_origin();
        let agent = worktree_agent(&repo, &wt, "agent-x", &base);
        // Someone else pushes to origin from a second clone.
        let other = repo.dir.join("hooks-none").join("other");
        repo.git(&[
            "clone",
            "-q",
            origin.to_str().unwrap(),
            other.to_str().unwrap(),
        ]);
        let in_other = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&other)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        in_other(&["config", "user.name", "O"]);
        in_other(&["config", "user.email", "o@armada.invalid"]);
        in_other(&["config", "commit.gpgsign", "false"]);
        std::fs::write(other.join("o.txt"), "o\n").unwrap();
        in_other(&["add", "-A"]);
        in_other(&["commit", "-q", "-m", "other"]);
        in_other(&["push", "-q", "origin", &base]);
        // A local commit on the base, so the histories diverge.
        std::fs::write(wt.join("b.txt"), "b\n").unwrap();
        commit_all(&wt, "agent commit", &[]).await.unwrap();
        merge(&agent).await.unwrap();

        let err = push_base_branch(&agent).await.unwrap_err();
        assert_eq!(
            format!("{err:#}"),
            format!("origin/{base} has new commits; pull first")
        );
    }

    #[tokio::test]
    async fn merge_explains_why_it_cant() {
        let (repo, wt, base) = worktree_setup();
        let agent = worktree_agent(&repo, &wt, "agent-x", &base);
        std::fs::write(wt.join("b.txt"), "b\n").unwrap();
        commit_all(&wt, "agent commit", &[]).await.unwrap();

        // Detached HEAD in the project.
        repo.git(&["checkout", "-q", "--detach"]);
        let err = merge(&agent).await.unwrap_err();
        assert!(err.to_string().contains("detached HEAD"), "{err}");

        // The base branch checked out in another worktree.
        let other = repo.dir.join("hooks-none").join("other");
        repo.git(&["worktree", "add", "-q", other.to_str().unwrap(), &base]);
        repo.git(&["checkout", "-q", "-b", "elsewhere"]);
        let err = merge(&agent).await.unwrap_err();
        assert!(
            err.to_string().contains("checked out in another worktree"),
            "{err}"
        );
        assert!(err.to_string().contains("hooks-none/other"), "{err}");
        assert_eq!(repo.lines(&["rev-list", "--count", &base]), vec!["1"]);
    }

    #[tokio::test]
    async fn merge_into_an_unborn_branch_says_so() {
        let repo = Repo::new();
        let agent = worktree_agent(&repo, &repo.dir, "agent-x", "main");
        repo.git(&["checkout", "-q", "-b", "main"]);
        let err = merge(&agent).await.unwrap_err();
        assert!(err.to_string().contains("no commits yet"), "{err}");
    }

    #[tokio::test]
    async fn pull_requests_need_commits() {
        let (repo, wt, base) = worktree_setup();
        let agent = worktree_agent(&repo, &wt, "agent-x", &base);
        let err = create_pr(&agent, "t", "b").await.unwrap_err();
        assert!(err.to_string().contains("no commits"), "{err}");
        let mut not_worktree = agent.clone();
        not_worktree.worktree = false;
        let err = create_pr(&not_worktree, "t", "b").await.unwrap_err();
        assert!(err.to_string().contains("enable worktree"), "{err}");
    }

    #[test]
    fn finds_pr_urls() {
        assert_eq!(
            last_url("https://github.com/o/r/pull/7\n").as_deref(),
            Some("https://github.com/o/r/pull/7")
        );
        assert_eq!(
            last_url("gh pr create failed: a pull request for branch \"x\" into branch \"main\" already exists:\nhttps://github.com/o/r/pull/9").as_deref(),
            Some("https://github.com/o/r/pull/9")
        );
        assert_eq!(last_url("\n"), None);
    }

    #[tokio::test]
    async fn pull_requests_push_to_the_tracked_remote() {
        let repo = Repo::new();
        let err = push_remote(&repo.dir, "feature").await.unwrap_err();
        assert!(err.to_string().contains("no `origin` remote"), "{err}");
        repo.git(&["remote", "add", "origin", "https://example.invalid/o.git"]);
        assert_eq!(push_remote(&repo.dir, "feature").await.unwrap(), "origin");
        repo.git(&["remote", "add", "fork", "https://example.invalid/f.git"]);
        repo.git(&["config", "branch.feature.remote", "fork"]);
        assert_eq!(push_remote(&repo.dir, "feature").await.unwrap(), "fork");
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

    #[test]
    fn secret_names_are_recognized() {
        for p in [
            ".env",
            "app/.env.local",
            "certs/server.PEM",
            "a/b/id_rsa",
            "id_ed25519.pub",
            "deploy.key",
            "credentials.json",
            ".npmrc",
            "x/.pypirc",
            ".netrc",
            "bundle.p12",
            "bundle.pfx",
            ".git-credentials",
        ] {
            assert!(looks_like_secret(p), "{p}");
        }
        for p in [
            "src/main.rs",
            "environment.ts",
            ".env.example",
            "keyboard.ts",
            "README.md",
        ] {
            assert!(!looks_like_secret(p), "{p}");
        }
    }

    #[tokio::test]
    async fn commit_can_leave_secret_files_out() {
        let repo = Repo::new();
        repo.write("a.txt", "a");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-q", "-m", "base"]);
        repo.write("b.txt", "b");
        repo.write(".env", "TOKEN=1");
        repo.write("sub/id_rsa", "key");
        let agent = worktree_agent(&repo, &repo.dir, "main", "main");
        let found = pending_secret_files(&agent, &[]).await.unwrap();
        assert_eq!(found, vec![".env".to_string(), "sub/id_rsa".to_string()]);
        let exclude = vec![".env".to_string(), "sub/id_rsa".to_string()];
        let summary = commit_all(&repo.dir, "msg", &exclude).await.unwrap();
        assert_eq!(summary.files, vec!["b.txt".to_string()]);
        let status = repo.git(&["status", "--porcelain", "-uall"]);
        assert!(
            status.contains(".env") && status.contains("sub/id_rsa"),
            "{status}"
        );
    }

    #[tokio::test]
    async fn pushes_are_refused_when_repo_config_rewrites_urls() {
        let repo = Repo::new();
        repo.write("a.txt", "a");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-q", "-m", "a"]);
        repo.git(&["remote", "add", "origin", "https://example.invalid/r.git"]);
        repo.git(&[
            "config",
            "url.https://evil.invalid/.pushInsteadOf",
            "https://example.invalid/",
        ]);
        let err = git(&repo.dir, &["push", "origin", "HEAD"])
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("redirects pushes"), "{err:#}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_hooks_path_is_ignored_but_git_hooks_run() {
        use std::os::unix::fs::PermissionsExt;
        let repo = Repo::new();
        let marker = repo.dir.join("hook-ran");
        std::fs::create_dir_all(repo.dir.join("evil")).unwrap();
        let hook = repo.dir.join("evil/pre-commit");
        std::fs::write(&hook, format!("#!/bin/sh\ntouch {}\n", marker.display())).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        repo.git(&["config", "core.hooksPath", "evil"]);
        repo.write("a.txt", "a");
        git(&repo.dir, &["add", "."]).await.unwrap();
        git(&repo.dir, &["commit", "-q", "-m", "a"]).await.unwrap();
        assert!(!marker.exists());
    }

    // ---- Git LFS ----

    fn pointer_for(content: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let hex: String = Sha256::digest(content)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        format!(
            "version https://git-lfs.github.com/spec/v1\noid sha256:{hex}\nsize {}\n",
            content.len()
        )
    }

    /// A repository tracking `*.bin` with LFS (no git-lfs installed or configured): each
    /// `(name, content)` is committed as a pointer while the worktree holds the content.
    fn lfs_repo(files: &[(&str, &str)]) -> Repo {
        let repo = Repo::new();
        repo.write(
            ".gitattributes",
            "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        );
        repo.write("t.txt", "one\n");
        for (name, content) in files {
            repo.write(name, &pointer_for(content.as_bytes()));
        }
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        for (name, content) in files {
            repo.write(name, content);
        }
        repo
    }

    /// A PATH directory with no `git-lfs` in it.
    fn empty_path() -> (PathBuf, std::ffi::OsString) {
        let dir = std::env::temp_dir().join(format!("armada-path-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = std::env::join_paths([&dir]).unwrap();
        (dir, path)
    }

    async fn lfs_diff(repo: &Repo, path_env: &OsStr) -> AgentDiff {
        diff_worktree_with(&repo.dir, None, None, Some(path_env))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn lfs_file_matching_its_pointer_is_hidden() {
        let repo = lfs_repo(&[("a.bin", "real asset bytes"), ("b.bin", "other asset")]);
        repo.write("t.txt", "two\n");
        let (dir, path) = empty_path();
        let before = repo.index_bytes();

        let diff = lfs_diff(&repo, &path).await;
        let paths: Vec<_> = diff.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["t.txt"]);
        assert!(!diff.files[0].lfs);
        let lfs = diff.lfs.expect("repository uses LFS");
        assert_eq!(lfs.hidden, 2);
        assert!(lfs.tool_missing);
        assert!(diff.patch.contains("+two"), "{}", diff.patch);
        assert!(!diff.patch.contains("bin"), "{}", diff.patch);
        // Only the intended file is "uncommitted"; the hidden assets don't count.
        assert_eq!(diff.uncommitted, 1);
        assert_eq!(repo.index_bytes(), before);
        assert!(repo.leftover_temp_indexes().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn lfs_file_with_other_content_is_shown_without_a_patch() {
        let repo = lfs_repo(&[
            ("same.bin", "aaaa"),
            ("size.bin", "short"),
            ("gone.bin", "x"),
        ]);
        // Same size, different bytes; a different size; a deletion.
        repo.write("same.bin", "bbbb");
        repo.write("size.bin", "much longer content");
        std::fs::remove_file(repo.dir.join("gone.bin")).unwrap();
        let (dir, path) = empty_path();

        let diff = lfs_diff(&repo, &path).await;
        let got: Vec<_> = diff
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status, f.lfs))
            .collect();
        assert_eq!(
            got,
            vec![
                ("gone.bin", ChangeStatus::Deleted, true),
                ("same.bin", ChangeStatus::Modified, true),
                ("size.bin", ChangeStatus::Modified, true),
            ]
        );
        assert_eq!(diff.lfs.unwrap().hidden, 0);
        assert!(diff.patch.is_empty(), "{}", diff.patch);
        assert_eq!(diff.uncommitted, 3);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn new_lfs_files_show_as_added_and_other_changes_are_unaffected() {
        let repo = lfs_repo(&[("a.bin", "kept")]);
        repo.write("sub/new.bin", "brand new asset");
        repo.write("new.txt", "fresh\n");
        std::fs::remove_file(repo.dir.join("t.txt")).unwrap();
        let (dir, path) = empty_path();

        let diff = lfs_diff(&repo, &path).await;
        let got: Vec<_> = diff
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status, f.lfs))
            .collect();
        assert_eq!(
            got,
            vec![
                ("new.txt", ChangeStatus::Added, false),
                ("sub/new.bin", ChangeStatus::Added, true),
                ("t.txt", ChangeStatus::Deleted, false),
            ]
        );
        assert_eq!(diff.files[0].additions, 1);
        assert_eq!(diff.lfs.as_ref().unwrap().hidden, 1);
        assert!(diff.patch.contains("+fresh"), "{}", diff.patch);
        assert!(!diff.patch.contains("new.bin"), "{}", diff.patch);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn lfs_is_found_from_a_subfolder_and_staged_removals() {
        let repo = lfs_repo(&[("a.bin", "kept"), ("rm.bin", "removed")]);
        repo.git(&["rm", "-q", "--cached", "rm.bin"]);
        std::fs::remove_file(repo.dir.join("rm.bin")).unwrap();
        let (dir, path) = empty_path();
        let diff = diff_worktree_with(&repo.dir.join("sub-missing"), None, None, Some(&path)).await;
        assert!(diff.is_err());
        std::fs::create_dir_all(repo.dir.join("sub")).unwrap();
        let diff = diff_worktree_with(&repo.dir.join("sub"), None, None, Some(&path))
            .await
            .unwrap();
        let got: Vec<_> = diff
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status))
            .collect();
        assert_eq!(got, vec![("rm.bin", ChangeStatus::Deleted)]);
        assert_eq!(diff.lfs.unwrap().hidden, 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn untouched_since_the_agent_started_is_not_read() {
        let repo = lfs_repo(&[("a.bin", "aaaa")]);
        // Same size, different bytes, but older than the agent: trusted without hashing.
        repo.write("a.bin", "bbbb");
        let later = SystemTime::now() + Duration::from_secs(3600);
        let (dir, path) = empty_path();
        let diff = diff_worktree_with(&repo.dir, None, Some(later), Some(&path))
            .await
            .unwrap();
        assert!(diff.files.is_empty());
        assert_eq!(diff.lfs.unwrap().hidden, 1);
        // Started before the edit: the content is checked (and the verdict cached).
        let earlier = SystemTime::now() - Duration::from_secs(3600);
        for _ in 0..2 {
            let diff = diff_worktree_with(&repo.dir, None, Some(earlier), Some(&path))
                .await
                .unwrap();
            assert_eq!(diff.files.len(), 1);
            assert!(diff.files[0].lfs);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn unsmudged_pointer_files_in_the_worktree_are_unchanged() {
        // A checkout made without git-lfs leaves the pointer text in the worktree.
        let repo = lfs_repo(&[("a.bin", "real asset bytes")]);
        repo.write("a.bin", &pointer_for(b"real asset bytes"));
        let (dir, path) = empty_path();
        let diff = lfs_diff(&repo, &path).await;
        assert!(diff.files.is_empty(), "{:?}", diff.files);
        assert_eq!(diff.lfs.unwrap().hidden, 1);
        assert_eq!(diff.uncommitted, 0);
        // A pointer to different content is a real change.
        repo.write("a.bin", &pointer_for(b"other bytes"));
        let diff = lfs_diff(&repo, &path).await;
        assert_eq!(diff.files.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn lfs_in_odd_paths_and_untracked_folders() {
        let repo = lfs_repo(&[("my dir/\u{fc}ber file.bin", "asset one")]);
        repo.write("newdir/deep/x.bin", "fresh asset");
        repo.write("newdir/note.txt", "hi\n");
        let (dir, path) = empty_path();
        let diff = lfs_diff(&repo, &path).await;
        let got: Vec<_> = diff
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status, f.lfs))
            .collect();
        assert_eq!(
            got,
            vec![
                ("newdir/deep/x.bin", ChangeStatus::Added, true),
                ("newdir/note.txt", ChangeStatus::Added, false),
            ]
        );
        assert_eq!(diff.lfs.as_ref().unwrap().hidden, 1);
        // One LFS asset and one plain file: two, not three (the folder counted twice).
        assert_eq!(diff.uncommitted, 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn diff_edge_cases_unborn_renamed_detached_crlf() {
        // No commits yet: untracked files with spaces and non-ASCII names.
        let repo = Repo::new();
        repo.write("sp ace/\u{fc}ber.txt", "one\r\ntwo\r\n");
        let diff = diff_worktree(&repo.dir, None).await.unwrap();
        let f = diff
            .files
            .iter()
            .find(|f| f.path.contains("ber.txt"))
            .unwrap();
        assert_eq!(f.path, "sp ace/\u{fc}ber.txt");
        assert_eq!(f.additions, 2);
        assert!(diff.patch.contains("+one\r\n"), "{:?}", diff.patch);

        // Renamed (unstaged) and detached HEAD.
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        repo.git(&["checkout", "-q", "--detach"]);
        std::fs::rename(
            repo.dir.join("sp ace/\u{fc}ber.txt"),
            repo.dir.join("moved.txt"),
        )
        .unwrap();
        let diff = diff_worktree(&repo.dir, None).await.unwrap();
        let got: Vec<_> = diff
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status))
            .collect();
        assert_eq!(
            got,
            vec![("moved.txt", ChangeStatus::Renamed)],
            "{:?}",
            diff.patch
        );
        assert_eq!(diff.uncommitted, 2);
    }

    #[tokio::test]
    async fn repositories_without_lfs_report_none() {
        let repo = Repo::new();
        repo.write("a.txt", "one\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        repo.write("a.txt", "two\n");
        let diff = diff_worktree(&repo.dir, None).await.unwrap();
        assert!(diff.lfs.is_none());
        assert_eq!(diff.files.len(), 1);
        assert!(!diff.files[0].lfs);
    }

    #[test]
    fn lfs_tool_lookup_uses_the_given_path() {
        let (dir, path) = empty_path();
        assert!(!lfs_tool_on_path(Some(&path)));
        let name = if cfg!(windows) {
            "git-lfs.exe"
        } else {
            "git-lfs"
        };
        let exe = dir.join(name);
        std::fs::write(&exe, "").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert!(lfs_tool_on_path(Some(&path)));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn parses_lfs_pointers() {
        let ptr = pointer_for(b"hello");
        let p = parse_lfs_pointer(ptr.as_bytes()).unwrap();
        assert_eq!(p.size, 5);
        assert_eq!(
            p.oid,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        // CRLF checkouts parse too.
        assert!(parse_lfs_pointer(ptr.replace('\n', "\r\n").as_bytes()).is_some());
        assert!(parse_lfs_pointer(b"just text\n").is_none());
        assert!(parse_lfs_pointer(
            b"version https://git-lfs.github.com/spec/v1\noid sha256:zz\nsize 1\n"
        )
        .is_none());
    }

    #[test]
    fn splits_raw_and_numstat_output() {
        let out = ":100644 100644 aaa bbb M\0a.txt\0:100644 100644 aaa bbb R90\0old.txt\0new.txt\0\
                   :000000 100644 000 bbb A\0n.txt\0\
                   1\t2\ta.txt\0\x30\t0\t\0old.txt\0new.txt\0\x33\t0\tn.txt\0";
        let (raw, num) = split_raw_numstat(out);
        assert_eq!(
            parse_raw(raw),
            vec![
                ("a.txt".to_string(), ChangeStatus::Modified),
                ("new.txt".to_string(), ChangeStatus::Renamed),
                ("n.txt".to_string(), ChangeStatus::Added),
            ]
        );
        let counts = parse_numstat(num);
        assert_eq!(counts["a.txt"], (1, 2));
        assert_eq!(counts["new.txt"], (0, 0));
        assert_eq!(counts["n.txt"], (3, 0));
    }

    #[tokio::test]
    async fn commit_is_refused_for_changed_lfs_files_without_git_lfs() {
        let repo = lfs_repo(&[("a.bin", "aaaa")]);
        let agent = worktree_agent(&repo, &repo.dir, "main", "main");
        let (dir, path) = empty_path();

        // Only unchanged assets (and a text edit): nothing to protect.
        repo.write("t.txt", "two\n");
        ensure_lfs_commit_safe(&agent, &repo.dir, None, Some(&path))
            .await
            .unwrap();

        repo.write("a.bin", "bbbb");
        let err = ensure_lfs_commit_safe(&agent, &repo.dir, None, Some(&path))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("Git LFS isn't installed"), "{err}");
        // An agent sharing the user's checkout is only held to the files it touched.
        ensure_lfs_commit_safe(&agent, &repo.dir, Some(&["t.txt".to_string()]), Some(&path))
            .await
            .unwrap();
        let err = commit_excluding(&agent, "msg", &[], &[]).await;
        // (The real PATH may or may not have git-lfs; if not, the commit is refused.)
        if which::which("git-lfs").is_err() {
            assert!(err.unwrap_err().to_string().contains("Git LFS"));
            assert_eq!(repo.lines(&["rev-list", "--count", "HEAD"]), vec!["1"]);
        }
        let _ = std::fs::remove_dir_all(dir);

        // Repositories without LFS are never blocked.
        let plain = Repo::new();
        plain.write("a.txt", "x\n");
        let agent = worktree_agent(&plain, &plain.dir, "main", "main");
        let (dir, path) = empty_path();
        ensure_lfs_commit_safe(&agent, &plain.dir, None, Some(&path))
            .await
            .unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Timing probe: `ARMADA_DIFF_PROBE=<repo> cargo test --lib probe_diff -- --ignored
    /// --nocapture`. Read-only on the probed repository (objects are redirected to a
    /// scratch directory so even the intent-to-add of untracked files writes nowhere).
    #[tokio::test]
    #[ignore]
    async fn probe_diff() {
        let Ok(target) = std::env::var("ARMADA_DIFF_PROBE") else {
            return;
        };
        let target = PathBuf::from(target);
        let scratch = std::env::temp_dir().join(format!("armada-probe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scratch).unwrap();
        let common = git(
            &target,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await
        .unwrap();
        let objects = Path::new(common.trim()).join("objects");
        std::env::set_var("GIT_OBJECT_DIRECTORY", &scratch);
        std::env::set_var("GIT_ALTERNATE_OBJECT_DIRECTORIES", &objects);
        // Like `get_diff`, with the agent starting an hour ago unless told otherwise.
        let started = std::env::var("ARMADA_PROBE_STARTED_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(|ms| SystemTime::UNIX_EPOCH + Duration::from_millis(ms));
        for run in 1..=2 {
            let t = std::time::Instant::now();
            let diff = diff_worktree_with(&target, None, started, None)
                .await
                .unwrap();
            println!(
                "run {run}: {:?}, {} files, {} patch bytes, uncommitted {}, lfs {:?}",
                t.elapsed(),
                diff.files.len(),
                diff.patch.len(),
                diff.uncommitted,
                diff.lfs
            );
        }
        let _ = std::fs::remove_dir_all(scratch);
    }
}
