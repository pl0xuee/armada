//! Checkpoints: before each message is sent to an agent, the agent's whole working
//! directory (tracked and untracked files, minus what .gitignore excludes) is
//! snapshotted as a git tree, so the user can put the files back the way they were.
//!
//! Nothing here touches the user's repository state: trees are built with a
//! temporary copy of the index (`GIT_INDEX_FILE`), commits are only reachable from
//! private refs (`refs/armada/checkpoints/<agent>/<seq>`), and HEAD, the branch, the
//! real index and the stash are never written. Restoring writes only working-tree
//! files (and removes files that weren't there at the time), never ignored files.
//!
//! The agent's own `.git/config` and `.gitattributes` are untrusted, so filters and
//! fsmonitor are switched off and line-ending conversion is disabled: files are
//! stored and restored byte for byte.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use serde::Serialize;

use crate::db::Db;
use crate::model::Agent;

/// Checkpoints kept per agent; older ones (and their refs) are dropped.
const KEEP: usize = 100;
const GIT_TIMEOUT: Duration = Duration::from_secs(120);
/// Files listed in a restore preview (the totals always cover everything).
const MAX_PREVIEW_FILES: usize = 300;
const GITLINK: &[u8] = b"160000";
/// Limits on untracked (non-ignored) files, which every snapshot copies into the
/// repository's object store. Over them, that message gets no checkpoint.
const MAX_UNTRACKED_FILES: usize = 20_000;
const MAX_UNTRACKED_FILE_BYTES: u64 = 50 << 20;
const MAX_UNTRACKED_TOTAL_BYTES: u64 = 200 << 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub id: String,
    pub agent_id: String,
    pub seq: i64,
    /// The user message this checkpoint precedes (None for safety checkpoints).
    pub item_id: Option<String>,
    pub created_at: i64,
    /// "turn" (taken before a message) or "safety" (taken before a restore).
    pub kind: String,
    #[serde(skip)]
    pub tree: String,
    #[serde(skip)]
    pub commit: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointList {
    /// False when the folder isn't (the root of) a git work tree.
    pub available: bool,
    pub checkpoints: Vec<Checkpoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFile {
    pub path: String,
    /// What restoring does to the file: "added" (it comes back), "deleted" (it was
    /// created since, so it's removed) or "modified".
    pub status: String,
    pub additions: i64,
    pub deletions: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub files: Vec<PreviewFile>,
    pub total_files: usize,
    pub additions: i64,
    pub deletions: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    /// The checkpoint of the state before the restore; restoring it undoes this.
    pub safety_id: String,
    pub files_changed: usize,
}

/// One checkpoint operation at a time per agent.
async fn lock_agent(agent_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
    type Locks = parking_lot::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>;
    static LOCKS: OnceLock<Locks> = OnceLock::new();
    let lock = {
        let mut locks = LOCKS.get_or_init(Default::default).lock();
        locks.retain(|_, l| Arc::strong_count(l) > 1);
        locks.entry(agent_id.to_string()).or_default().clone()
    };
    lock.lock_owned().await
}

fn ref_prefix(agent_id: &str) -> String {
    format!("refs/armada/checkpoints/{agent_id}/")
}

// ---- git ---------------------------------------------------------------------

struct Git<'a> {
    cwd: &'a Path,
    flags: Vec<String>,
}

impl<'a> Git<'a> {
    async fn new(cwd: &'a Path) -> anyhow::Result<Git<'a>> {
        let mut flags: Vec<String> = [
            "core.fsmonitor=false",
            "core.autocrlf=false",
            "core.safecrlf=false",
            "core.splitIndex=false",
            "core.quotePath=false",
            "advice.addEmbeddedRepo=false",
            "commit.gpgsign=false",
        ]
        .iter()
        .flat_map(|c| ["-c".to_string(), c.to_string()])
        .collect();
        let mut git = Git { cwd, flags: vec![] };
        // Reading config executes nothing. Exit status 1 = no filter configured.
        let out = git
            .exec(
                &["-c", "core.fsmonitor=false"],
                &["config", "--null", "--get-regexp", r"^filter\."],
                None,
                &[],
            )
            .await?;
        if !out.status.success() && out.status.code() != Some(1) {
            bail!("git config failed: {}", stderr_of(&out));
        }
        for name in filter_drivers(&String::from_utf8_lossy(&out.stdout)) {
            if name.contains('=') {
                bail!("The repository configures a git filter named {name:?}");
            }
            for (key, value) in [
                ("clean", ""),
                ("smudge", ""),
                ("process", ""),
                ("required", "false"),
            ] {
                flags.push("-c".into());
                flags.push(format!("filter.{name}.{key}={value}"));
            }
        }
        git.flags = flags;
        Ok(git)
    }

    async fn exec(
        &self,
        pre: &[&str],
        args: &[&str],
        stdin: Option<Vec<u8>>,
        envs: &[(&str, &OsStr)],
    ) -> anyhow::Result<std::process::Output> {
        use tokio::io::AsyncWriteExt;
        let mut cmd = tokio::process::Command::new("git");
        crate::childenv::sanitize_child_env(&mut cmd);
        cmd.args(pre)
            .args(&self.flags)
            .args(args)
            .current_dir(self.cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (k, v) in envs {
            cmd.env(k, v);
        }
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);
        let mut child = cmd.spawn().context("running git")?;
        let mut pipe = child.stdin.take();
        let work = async {
            let write = async {
                if let (Some(pipe), Some(data)) = (pipe.as_mut(), stdin) {
                    // A write error means git exited early; its status says why.
                    let _ = pipe.write_all(&data).await;
                }
                drop(pipe.take());
            };
            let (_, out) = tokio::join!(write, child.wait_with_output());
            out
        };
        tokio::time::timeout(GIT_TIMEOUT, work)
            .await
            .map_err(|_| anyhow!("git {} didn't finish in time", args.first().unwrap_or(&"")))?
            .context("running git")
    }

    async fn run(
        &self,
        args: &[&str],
        stdin: Option<Vec<u8>>,
        envs: &[(&str, &OsStr)],
    ) -> anyhow::Result<Vec<u8>> {
        let out = self.exec(&[], args, stdin, envs).await?;
        if !out.status.success() {
            bail!("git {}: {}", args.first().unwrap_or(&""), stderr_of(&out));
        }
        Ok(out.stdout)
    }

    async fn text(&self, args: &[&str]) -> anyhow::Result<String> {
        Ok(String::from_utf8_lossy(&self.run(args, None, &[]).await?)
            .trim()
            .to_string())
    }

    /// A git work tree whose root is the folder itself (a subfolder of a repository
    /// would snapshot, and restore, files outside it).
    async fn available(&self) -> bool {
        match self
            .run(
                &["rev-parse", "--is-inside-work-tree", "--show-prefix"],
                None,
                &[],
            )
            .await
        {
            Ok(out) => {
                let out = String::from_utf8_lossy(&out);
                let mut lines = out.lines();
                lines.next() == Some("true") && lines.next().unwrap_or("").is_empty()
            }
            Err(_) => false,
        }
    }

    async fn head(&self) -> Option<String> {
        self.text(&["rev-parse", "--verify", "-q", "HEAD^{commit}"])
            .await
            .ok()
            .filter(|h| !h.is_empty())
    }

    /// A private copy of the index (so stat info makes unchanged files cheap).
    async fn temp_index(&self, seed: bool) -> anyhow::Result<TempIndex> {
        let tmp =
            TempIndex(std::env::temp_dir().join(format!("armada-ckpt-{}", uuid::Uuid::new_v4())));
        if seed {
            let real = self
                .text(&["rev-parse", "--path-format=absolute", "--git-path", "index"])
                .await?;
            let real = self.cwd.join(real);
            // No index yet (fresh repository): git starts from an empty one.
            if real.exists() {
                tokio::fs::copy(&real, &tmp.0)
                    .await
                    .context("copying the git index")?;
                // Keep the index's own mtime: git re-hashes entries as new as the index
                // ("racily clean"), and a fresh mtime on the copy would turn that off,
                // missing same-size edits made in the same timestamp tick.
                let mtime = std::fs::metadata(&real).and_then(|m| m.modified());
                if let Ok(mtime) = mtime {
                    let file = std::fs::OpenOptions::new().write(true).open(&tmp.0);
                    file.and_then(|f| f.set_modified(mtime))
                        .context("keeping the git index timestamp")?;
                }
            }
        }
        Ok(tmp)
    }

    /// Refuses folders whose untracked, non-ignored files would bloat the repository's
    /// object store on every snapshot (a stray video, an un-ignored build folder...).
    async fn check_untracked_size(&self) -> anyhow::Result<()> {
        let out = self
            .run(
                &["ls-files", "--others", "--exclude-standard", "-z"],
                None,
                &[],
            )
            .await?;
        let (mut count, mut total) = (0usize, 0u64);
        for raw in out.split(|b| *b == 0).filter(|p| !p.is_empty()) {
            count += 1;
            if count > MAX_UNTRACKED_FILES {
                bail!("more than {MAX_UNTRACKED_FILES} untracked files (add them to .gitignore)");
            }
            let Some(rel) = rel_path(raw) else { continue };
            let size = std::fs::symlink_metadata(self.cwd.join(&rel)).map_or(0, |m| m.len());
            if size > MAX_UNTRACKED_FILE_BYTES {
                bail!(
                    "untracked file {} is over {} MB (add it to .gitignore)",
                    rel.display(),
                    MAX_UNTRACKED_FILE_BYTES >> 20
                );
            }
            total += size;
            if total > MAX_UNTRACKED_TOTAL_BYTES {
                bail!(
                    "untracked files total over {} MB (add them to .gitignore)",
                    MAX_UNTRACKED_TOTAL_BYTES >> 20
                );
            }
        }
        Ok(())
    }

    /// The tree of the folder's current contents (tracked + untracked, not ignored).
    async fn snapshot_tree(&self) -> anyhow::Result<String> {
        self.check_untracked_size()
            .await
            .context("Checkpoint skipped")?;
        let index = self.temp_index(true).await?;
        let env: [(&str, &OsStr); 1] = [("GIT_INDEX_FILE", index.0.as_os_str())];
        self.run(&["add", "-A"], None, &env).await?;
        let tree = self.run(&["write-tree"], None, &env).await?;
        Ok(String::from_utf8_lossy(&tree).trim().to_string())
    }

    async fn commit_tree(&self, tree: &str, parent: Option<&str>) -> anyhow::Result<String> {
        let mut args = vec!["commit-tree", tree, "-m", "Armada checkpoint"];
        if let Some(p) = parent {
            args.extend(["-p", p]);
        }
        let name = OsStr::new("Armada");
        let email = OsStr::new("checkpoints@armada.invalid");
        let envs: [(&str, &OsStr); 4] = [
            ("GIT_AUTHOR_NAME", name),
            ("GIT_AUTHOR_EMAIL", email),
            ("GIT_COMMITTER_NAME", name),
            ("GIT_COMMITTER_EMAIL", email),
        ];
        let out = self.run(&args, None, &envs).await?;
        Ok(String::from_utf8_lossy(&out).trim().to_string())
    }
}

fn stderr_of(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stderr).trim().to_string()
}

/// Driver names from `git config --null --get-regexp '^filter\.'` ("key\nvalue\0"...).
fn filter_drivers(out: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for entry in out.split('\0').filter(|e| !e.is_empty()) {
        let key = entry.split('\n').next().unwrap_or_default();
        if let Some((name, _)) = key
            .strip_prefix("filter.")
            .and_then(|rest| rest.rsplit_once('.'))
        {
            if !names.iter().any(|n| n == name) {
                names.push(name.to_string());
            }
        }
    }
    names
}

/// A scratch index file, removed on drop.
struct TempIndex(PathBuf);

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let mut lock = self.0.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(lock);
    }
}

fn agent_dir(agent: &Agent) -> Option<&Path> {
    let cwd = Path::new(&agent.cwd);
    cwd.is_dir().then_some(cwd)
}

// ---- operations --------------------------------------------------------------

pub(crate) async fn list(db: &Db, agent: &Agent) -> anyhow::Result<CheckpointList> {
    let available = match agent_dir(agent) {
        Some(cwd) => Git::new(cwd).await?.available().await,
        None => false,
    };
    let checkpoints = if available {
        db.checkpoints(&agent.id)?
    } else {
        Vec::new()
    };
    Ok(CheckpointList {
        available,
        checkpoints,
    })
}

/// Snapshots the folder before a message is sent. Quietly does nothing (None) for
/// folders that aren't git work trees.
pub(crate) async fn take_for_turn(
    db: &Db,
    agent: &Agent,
    item_id: Option<String>,
) -> anyhow::Result<Option<Checkpoint>> {
    let Some(cwd) = agent_dir(agent) else {
        return Ok(None);
    };
    let git = Git::new(cwd).await?;
    if !git.available().await {
        return Ok(None);
    }
    let _guard = lock_agent(&agent.id).await;
    take_locked(db, &git, agent, "turn", item_id)
        .await
        .map(Some)
}

async fn take_locked(
    db: &Db,
    git: &Git<'_>,
    agent: &Agent,
    kind: &str,
    item_id: Option<String>,
) -> anyhow::Result<Checkpoint> {
    let tree = git.snapshot_tree().await?;
    let existing = db.checkpoints(&agent.id)?;
    let prev = existing.last();
    let commit = match prev {
        // Nothing changed since the last checkpoint: share its commit.
        Some(p) if p.tree == tree => p.commit.clone(),
        // Parented on HEAD only, not on the previous checkpoint: chaining them would keep
        // every pruned checkpoint's objects reachable forever.
        _ => {
            let head = git.head().await;
            git.commit_tree(&tree, head.as_deref()).await?
        }
    };
    let seq = prev.map_or(1, |p| p.seq + 1);
    git.run(
        &[
            "update-ref",
            &format!("{}{seq}", ref_prefix(&agent.id)),
            &commit,
        ],
        None,
        &[],
    )
    .await?;
    let checkpoint = Checkpoint {
        id: uuid::Uuid::new_v4().to_string(),
        agent_id: agent.id.clone(),
        seq,
        item_id,
        created_at: crate::model::now_ms(),
        kind: kind.to_string(),
        tree,
        commit,
    };
    db.add_checkpoint(&checkpoint)?;
    // Past the cap: forget the oldest.
    if existing.len() + 1 > KEEP {
        let drop_n = existing.len() + 1 - KEEP;
        let old = &existing[..drop_n];
        let deletes: String = old
            .iter()
            .map(|c| format!("delete {}{}\n", ref_prefix(&agent.id), c.seq))
            .collect();
        if let Err(e) = git
            .run(&["update-ref", "--stdin"], Some(deletes.into_bytes()), &[])
            .await
        {
            tracing::debug!("pruning checkpoint refs: {e:#}");
        }
        db.delete_checkpoints(&old.iter().map(|c| c.id.clone()).collect::<Vec<_>>())?;
    }
    Ok(checkpoint)
}

/// Deletes the agent's checkpoint refs (the database rows go with the agent).
pub(crate) async fn forget_agent(agent: &Agent) {
    let Some(cwd) = agent_dir(agent) else {
        return;
    };
    let Ok(git) = Git::new(cwd).await else {
        return;
    };
    let _guard = lock_agent(&agent.id).await;
    let prefix = ref_prefix(&agent.id);
    let Ok(refs) = git
        .run(&["for-each-ref", "--format=%(refname)", &prefix], None, &[])
        .await
    else {
        return;
    };
    let deletes: String = String::from_utf8_lossy(&refs)
        .lines()
        .map(|r| format!("delete {r}\n"))
        .collect();
    if !deletes.is_empty() {
        if let Err(e) = git
            .run(&["update-ref", "--stdin"], Some(deletes.into_bytes()), &[])
            .await
        {
            tracing::debug!("deleting checkpoint refs: {e:#}");
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Change {
    /// 'A' (in the target only), 'D' (in the current state only), 'M', 'T'.
    status: u8,
    path: Vec<u8>,
}

/// Files that differ between two trees, without nested repositories.
async fn changes(git: &Git<'_>, from: &str, to: &str) -> anyhow::Result<Vec<Change>> {
    let out = git
        .run(
            &[
                "diff-tree",
                "-r",
                "-z",
                "--raw",
                "--no-renames",
                "--no-ext-diff",
                "--no-textconv",
                from,
                to,
            ],
            None,
            &[],
        )
        .await?;
    Ok(parse_raw(&out))
}

fn parse_raw(out: &[u8]) -> Vec<Change> {
    let mut parts = out.split(|b| *b == 0).filter(|p| !p.is_empty());
    let mut changes = Vec::new();
    while let Some(header) = parts.next() {
        // ":100644 100644 <sha> <sha> M"
        let Some(path) = parts.next() else { break };
        let fields: Vec<&[u8]> = header
            .strip_prefix(b":")
            .unwrap_or(header)
            .split(|b| *b == b' ')
            .collect();
        if fields.len() < 5 || fields[0] == GITLINK || fields[1] == GITLINK {
            continue;
        }
        changes.push(Change {
            status: fields[4].first().copied().unwrap_or(b'M'),
            path: path.to_vec(),
        });
    }
    changes
}

pub(crate) async fn preview(
    db: &Db,
    agent: &Agent,
    checkpoint_id: &str,
) -> anyhow::Result<RestorePreview> {
    let cwd = agent_dir(agent).ok_or_else(|| anyhow!("The agent's folder no longer exists"))?;
    let git = Git::new(cwd).await?;
    if !git.available().await {
        bail!("This folder isn't a git repository");
    }
    let target = find(db, agent, checkpoint_id)?;
    let _guard = lock_agent(&agent.id).await;
    let current = git.snapshot_tree().await?;
    let list = changes(&git, &current, &target.tree).await?;
    let numstat = git
        .run(
            &[
                "diff-tree",
                "-r",
                "-z",
                "--numstat",
                "--no-renames",
                "--no-ext-diff",
                "--no-textconv",
                &current,
                &target.tree,
            ],
            None,
            &[],
        )
        .await?;
    let mut counts: HashMap<Vec<u8>, (i64, i64)> = HashMap::new();
    for rec in numstat.split(|b| *b == 0).filter(|p| !p.is_empty()) {
        let mut f = rec.splitn(3, |b| *b == b'\t');
        let (Some(a), Some(d), Some(path)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        let num = |x: &[u8]| String::from_utf8_lossy(x).parse::<i64>().unwrap_or(0);
        counts.insert(path.to_vec(), (num(a), num(d)));
    }
    let mut files = Vec::new();
    let (mut additions, mut deletions) = (0, 0);
    for c in &list {
        let (a, d) = counts.get(&c.path).copied().unwrap_or((0, 0));
        additions += a;
        deletions += d;
        if files.len() < MAX_PREVIEW_FILES {
            files.push(PreviewFile {
                path: String::from_utf8_lossy(&c.path).into_owned(),
                status: match c.status {
                    b'A' => "added",
                    b'D' => "deleted",
                    _ => "modified",
                }
                .to_string(),
                additions: a,
                deletions: d,
            });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(RestorePreview {
        files,
        total_files: list.len(),
        additions,
        deletions,
    })
}

fn find(db: &Db, agent: &Agent, checkpoint_id: &str) -> anyhow::Result<Checkpoint> {
    db.checkpoints(&agent.id)?
        .into_iter()
        .find(|c| c.id == checkpoint_id)
        .ok_or_else(|| anyhow!("That checkpoint no longer exists"))
}

/// Puts the folder's files back to how they were at the checkpoint. The caller
/// makes sure the agent isn't working. The current state is checkpointed first.
pub(crate) async fn restore(
    db: &Db,
    agent: &Agent,
    checkpoint_id: &str,
) -> anyhow::Result<RestoreResult> {
    let cwd = agent_dir(agent).ok_or_else(|| anyhow!("The agent's folder no longer exists"))?;
    let git = Git::new(cwd).await?;
    if !git.available().await {
        bail!("This folder isn't a git repository");
    }
    let target = find(db, agent, checkpoint_id)?;
    let _guard = lock_agent(&agent.id).await;
    git.run(
        &["cat-file", "-e", &format!("{}^{{tree}}", target.tree)],
        None,
        &[],
    )
    .await
    .context("The saved files for that checkpoint are gone")?;
    let safety = take_locked(db, &git, agent, "safety", None).await?;
    let list = changes(&git, &safety.tree, &target.tree).await?;

    // Files that didn't exist then go first (so a file can become a folder).
    let mut removed: Vec<&Change> = list.iter().filter(|c| c.status == b'D').collect();
    removed.sort_by(|a, b| b.path.cmp(&a.path));
    let mut dirs: HashSet<PathBuf> = HashSet::new();
    for c in &removed {
        if let Some(rel) = rel_path(&c.path) {
            remove_file(cwd, &rel, &mut dirs)?;
        }
    }
    // Folders left empty, deepest first; non-empty ones (ignored files) stay.
    let mut dirs: Vec<PathBuf> = dirs.into_iter().collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in dirs {
        let _ = std::fs::remove_dir(cwd.join(d));
    }

    let mut paths: Vec<u8> = Vec::new();
    let mut count = removed.len();
    for c in list.iter().filter(|c| c.status != b'D') {
        paths.extend_from_slice(&c.path);
        paths.push(0);
        count += 1;
    }
    if !paths.is_empty() {
        let index = git.temp_index(false).await?;
        let env: [(&str, &OsStr); 1] = [("GIT_INDEX_FILE", index.0.as_os_str())];
        git.run(&["read-tree", &target.tree], None, &env).await?;
        git.run(
            &["checkout-index", "-f", "-z", "--stdin"],
            Some(paths),
            &env,
        )
        .await
        .context("Some files couldn't be restored")?;
    }
    Ok(RestoreResult {
        safety_id: safety.id,
        files_changed: count,
    })
}

/// A repository-relative path from git, only if it stays inside the folder.
fn rel_path(raw: &[u8]) -> Option<PathBuf> {
    let s = std::str::from_utf8(raw).ok()?;
    let p = PathBuf::from(s);
    p.components()
        .all(|c| matches!(c, Component::Normal(_)))
        .then_some(p)
}

/// Removes one file, never following a symlinked folder out of `root`.
fn remove_file(root: &Path, rel: &Path, dirs: &mut HashSet<PathBuf>) -> anyhow::Result<()> {
    let mut at = root.to_path_buf();
    let parts: Vec<_> = rel.components().collect();
    for part in &parts[..parts.len().saturating_sub(1)] {
        at.push(part);
        match std::fs::symlink_metadata(&at) {
            Ok(m) if m.is_dir() => {}
            // A symlink or a file where a folder was: the path is gone or unsafe.
            _ => return Ok(()),
        }
    }
    let file = root.join(rel);
    match std::fs::symlink_metadata(&file) {
        Ok(m) if m.is_dir() => return Ok(()),
        Ok(_) => {
            std::fs::remove_file(&file).with_context(|| format!("removing {}", rel.display()))?
        }
        Err(_) => return Ok(()),
    }
    let mut parent = rel.parent();
    while let Some(p) = parent.filter(|p| !p.as_os_str().is_empty()) {
        dirs.insert(p.to_path_buf());
        parent = p.parent();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Repo {
        dir: PathBuf,
        db: Db,
        agent: Agent,
    }

    impl Repo {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("armada-ckpt-test-{}", uuid::Uuid::new_v4()));
            let dir = root.join("work");
            std::fs::create_dir_all(&dir).unwrap();
            let db = Db::open(&root.join("armada.db")).unwrap();
            let repo = Repo {
                agent: serde_json::from_value(serde_json::json!({
                    "id": "a1", "title": "t", "provider": "claude", "accountId": "x",
                    "projectPath": dir.to_string_lossy(), "cwd": dir.to_string_lossy(),
                    "worktree": false, "status": "idle", "running": false,
                    "branch": null, "baseBranch": null, "baseCommit": null,
                    "sessionId": null, "groupId": null, "createdAt": 0,
                    "updatedAt": 0, "lastActivityAt": 0, "costUsd": 0.0,
                    "tokensUsed": 0, "contextUsed": null, "contextSize": null,
                    "unread": false, "archived": false, "lastMessage": null,
                    "pendingPermissions": 0
                }))
                .unwrap_or_else(|e| panic!("agent: {e}")),
                dir,
                db,
            };
            repo.git(&["init", "-q"]);
            repo.git(&["config", "core.autocrlf", "false"]);
            repo.git(&["config", "user.name", "T"]);
            repo.git(&["config", "user.email", "t@t.invalid"]);
            repo.git(&["config", "commit.gpgsign", "false"]);
            repo.write(".gitignore", "*.log\nnode_modules/\n");
            repo.write("a.txt", "one\n");
            repo.git(&["add", "-A"]);
            repo.git(&["commit", "-q", "-m", "init"]);
            repo
        }

        fn git(&self, args: &[&str]) -> String {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&self.dir)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {}", stderr_of(&out));
            String::from_utf8_lossy(&out.stdout).into_owned()
        }

        fn write(&self, path: &str, content: &str) {
            let path = self.dir.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }

        fn read(&self, path: &str) -> Option<String> {
            std::fs::read_to_string(self.dir.join(path)).ok()
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.dir.parent().unwrap());
        }
    }

    #[tokio::test]
    async fn restore_brings_back_files_and_removes_new_ones() {
        let r = Repo::new();
        r.write("b.txt", "untracked\n");
        r.write("node_modules/x.js", "ignored\n");
        let c1 = take_for_turn(&r.db, &r.agent, Some("i1".into()))
            .await
            .unwrap()
            .unwrap();
        // The "agent" edits, deletes, adds (also in a new folder).
        r.write("a.txt", "changed\n");
        std::fs::remove_file(r.dir.join("b.txt")).unwrap();
        r.write("new/dir/c.txt", "new\n");
        r.write("debug.log", "ignored too\n");
        r.write("node_modules/y.js", "ignored\n");
        let index_before = std::fs::read(r.dir.join(".git/index")).unwrap();
        let head_before = r.git(&["rev-parse", "HEAD"]);

        let p = preview(&r.db, &r.agent, &c1.id).await.unwrap();
        assert_eq!(p.total_files, 3);
        assert!(p
            .files
            .iter()
            .any(|f| f.path == "new/dir/c.txt" && f.status == "deleted"));
        assert!(p
            .files
            .iter()
            .any(|f| f.path == "b.txt" && f.status == "added"));

        let res = restore(&r.db, &r.agent, &c1.id).await.unwrap();
        assert_eq!(res.files_changed, 3);
        assert_eq!(r.read("a.txt").as_deref(), Some("one\n"));
        assert_eq!(r.read("b.txt").as_deref(), Some("untracked\n"));
        assert!(!r.dir.join("new").exists(), "emptied folders go too");
        assert_eq!(r.read("debug.log").as_deref(), Some("ignored too\n"));
        assert_eq!(r.read("node_modules/y.js").as_deref(), Some("ignored\n"));
        // The user's git state is untouched.
        assert_eq!(
            std::fs::read(r.dir.join(".git/index")).unwrap(),
            index_before
        );
        assert_eq!(r.git(&["rev-parse", "HEAD"]), head_before);
        assert!(r.git(&["stash", "list"]).is_empty());

        // Undo: restoring the safety checkpoint brings the edits back.
        restore(&r.db, &r.agent, &res.safety_id).await.unwrap();
        assert_eq!(r.read("a.txt").as_deref(), Some("changed\n"));
        assert_eq!(r.read("new/dir/c.txt").as_deref(), Some("new\n"));
        assert!(!r.dir.join("b.txt").exists());
    }

    #[tokio::test]
    async fn unchanged_folder_reuses_the_commit_and_refs_exist() {
        let r = Repo::new();
        let a = take_for_turn(&r.db, &r.agent, Some("i1".into()))
            .await
            .unwrap()
            .unwrap();
        let b = take_for_turn(&r.db, &r.agent, Some("i2".into()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(a.commit, b.commit);
        assert_eq!(b.seq, 2);
        r.write("a.txt", "two\n");
        let c = take_for_turn(&r.db, &r.agent, Some("i3".into()))
            .await
            .unwrap()
            .unwrap();
        assert_ne!(b.commit, c.commit);
        let refs = r.git(&["for-each-ref", "refs/armada/checkpoints/a1/"]);
        assert_eq!(refs.lines().count(), 3);
        // Branch and status are untouched by snapshots.
        assert_eq!(r.git(&["status", "--porcelain"]).trim(), "M a.txt");
        forget_agent(&r.agent).await;
        assert!(r.git(&["for-each-ref", "refs/armada/"]).is_empty());
    }

    #[tokio::test]
    async fn non_git_folders_are_skipped_and_old_checkpoints_pruned() {
        let plain =
            std::env::temp_dir().join(format!("armada-ckpt-plain-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&plain).unwrap();
        let r = Repo::new();
        let mut agent = r.agent.clone();
        agent.cwd = plain.to_string_lossy().into_owned();
        assert!(take_for_turn(&r.db, &agent, None).await.unwrap().is_none());
        assert!(!list(&r.db, &agent).await.unwrap().available);
        std::fs::remove_dir_all(&plain).unwrap();

        for i in 0..KEEP + 3 {
            r.write("a.txt", &format!("{i}\n"));
            take_for_turn(&r.db, &r.agent, None).await.unwrap();
        }
        let all = r.db.checkpoints("a1").unwrap();
        assert_eq!(all.len(), KEEP);
        assert_eq!(all[0].seq, 4);
        let refs = r.git(&["for-each-ref", "refs/armada/checkpoints/a1/"]);
        assert_eq!(refs.lines().count(), KEEP);
        // Not chained: a checkpoint's only parent is HEAD, so pruned ones can be collected.
        let head = r.git(&["rev-parse", "HEAD"]);
        let last = &all[KEEP - 1].commit;
        assert_eq!(r.git(&["rev-parse", &format!("{last}^@")]), head);
    }

    /// A same-size edit in the same timestamp tick as the index ("racily clean") must
    /// still be snapshotted: the temp index keeps the real index's mtime.
    #[tokio::test]
    async fn same_tick_same_size_edit_is_seen() {
        let r = Repo::new();
        let set_mtime = |path: &Path, t: std::time::SystemTime| {
            std::fs::OpenOptions::new()
                .write(true)
                .open(path)
                .and_then(|f| f.set_modified(t))
                .unwrap();
        };
        let tick = std::time::SystemTime::now() - Duration::from_secs(60);
        // The index recorded a.txt ("one\n") in the same tick as the edit below.
        r.git(&["update-index", "--refresh"]);
        set_mtime(&r.dir.join("a.txt"), tick);
        r.git(&["update-index", "--refresh"]);
        set_mtime(&r.dir.join(".git/index"), tick);
        r.write("a.txt", "two\n");
        set_mtime(&r.dir.join("a.txt"), tick);

        let c = take_for_turn(&r.db, &r.agent, None).await.unwrap().unwrap();
        let blob = r.git(&["rev-parse", &format!("{}:a.txt", c.tree)]);
        assert_eq!(r.git(&["cat-file", "-p", blob.trim()]), "two\n");
    }

    #[tokio::test]
    async fn large_untracked_files_skip_the_checkpoint() {
        let r = Repo::new();
        // Sparse: reports 51 MB without writing it.
        std::fs::File::create(r.dir.join("video.mp4"))
            .unwrap()
            .set_len(MAX_UNTRACKED_FILE_BYTES + (1 << 20))
            .unwrap();
        let err = take_for_turn(&r.db, &r.agent, None).await.unwrap_err();
        assert!(format!("{err:#}").contains("video.mp4"), "{err:#}");
        assert!(r.git(&["for-each-ref", "refs/armada/"]).is_empty());
        // Ignoring it is enough.
        r.write(".gitignore", "*.log\nnode_modules/\n*.mp4\n");
        assert!(take_for_turn(&r.db, &r.agent, None)
            .await
            .unwrap()
            .is_some());
    }

    #[test]
    fn unsafe_paths_are_rejected() {
        assert!(rel_path(b"../x").is_none());
        assert!(rel_path(b"/etc/passwd").is_none());
        assert!(rel_path(b"a/b.txt").is_some());
    }

    #[test]
    fn raw_output_skips_nested_repositories() {
        let raw = b":100644 100644 aaa bbb M\0a.txt\0:160000 160000 aaa bbb M\0sub\0:000000 100644 000 bbb A\0n\0";
        let c = parse_raw(raw);
        assert_eq!(c.len(), 2);
        assert_eq!(c[1].status, b'A');
    }
}
