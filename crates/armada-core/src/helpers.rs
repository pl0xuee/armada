//! Helper agents, the git side: snapshots of an agent's folder, and three-way merges
//! of one agent's changes into another's working tree.
//!
//! Nothing here moves HEAD, a branch, the stash or any real index. Folders are
//! snapshotted into git trees with a private index (see `checkpoints`), the sync
//! bases live in private refs (`refs/armada/helpers/<helper>/{main,helper}-base`,
//! which also keep their objects alive), and a merge works like this:
//!
//! 1. `plan`: with trees only (base, ours = the target's current files, theirs =
//!    the other agent's files) decide per file whether to take theirs, keep ours or
//!    merge the text. Binary files, deletions against edits, mode changes against
//!    edits, symlinks and sub-repositories that both sides touched are conflicts.
//!    The text merge is `git merge-file` on three temp files: it runs no merge
//!    drivers and no filters, and line endings are never converted.
//! 2. Any conflict: nothing is written, the caller reports the files.
//! 3. Otherwise `write_plan` stages every new file next to its destination, checks
//!    that each file is still what the plan was made from, then renames them into
//!    place (working tree only; the index is never touched).

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context};

use crate::checkpoints::{agent_dir, lock_agent, rel_path, stderr_of, Git};
use crate::model::Agent;

const REF_ROOT: &str = "refs/armada/helpers";
/// Text files above this are never merged line by line (reported as conflicts).
const MAX_MERGE_BYTES: usize = 8 << 20;
pub(crate) const NOT_GIT: &str = "Helpers need a git project";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Side {
    /// The main agent's files as the helper last saw them.
    Main,
    /// The helper's files as the main agent last received them.
    Helper,
}

fn base_ref(helper_id: &str, side: Side) -> String {
    let name = match side {
        Side::Main => "main-base",
        Side::Helper => "helper-base",
    };
    format!("{REF_ROOT}/{helper_id}/{name}")
}

async fn git_for(agent: &Agent) -> anyhow::Result<PathBuf> {
    let cwd = agent_dir(agent).ok_or_else(|| anyhow!("The agent's folder no longer exists"))?;
    let git = Git::new(cwd).await?;
    if !git.available().await {
        bail!(NOT_GIT);
    }
    Ok(cwd.to_path_buf())
}

/// The tree of the agent's folder right now (tracked + untracked, not ignored;
/// credential-looking untracked files excluded, like checkpoints).
///
/// `prev` is a tree the folder may still be identical to: when it is, git isn't
/// asked to re-read every file (the checkpoint fast path).
pub(crate) async fn snapshot_tree(agent: &Agent, prev: Option<&str>) -> anyhow::Result<String> {
    let cwd = git_for(agent).await?;
    let git = Git::new(&cwd).await?;
    let _guard = lock_agent(&agent.id).await;
    git.snapshot_tree(prev).await
}

/// A commit holding `tree`, parented on HEAD, reachable from nothing yet.
pub(crate) async fn commit_of(git: &Git<'_>, tree: &str) -> anyhow::Result<String> {
    let head = git.head().await;
    git.commit_tree(tree, head.as_deref()).await
}

/// Snapshots `parent` as a commit and records it as both sync bases of the helper.
pub(crate) async fn seed(parent: &Agent, helper_id: &str) -> anyhow::Result<String> {
    let cwd = git_for(parent).await?;
    let git = Git::new(&cwd).await?;
    let tree = {
        let _guard = lock_agent(&parent.id).await;
        git.snapshot_tree(None).await?
    };
    let commit = commit_of(&git, &tree).await?;
    for side in [Side::Main, Side::Helper] {
        set_ref(&git, helper_id, side, &commit).await?;
    }
    Ok(commit)
}

async fn set_ref(git: &Git<'_>, helper_id: &str, side: Side, commit: &str) -> anyhow::Result<()> {
    git.run(
        &["update-ref", &base_ref(helper_id, side), commit],
        None,
        &[],
    )
    .await?;
    Ok(())
}

/// Moves a sync base to `tree`.
pub(crate) async fn set_base(
    agent: &Agent,
    helper_id: &str,
    side: Side,
    tree: &str,
) -> anyhow::Result<()> {
    let cwd = git_for(agent).await?;
    let git = Git::new(&cwd).await?;
    let commit = commit_of(&git, tree).await?;
    set_ref(&git, helper_id, side, &commit).await
}

/// The tree of a sync base (None when the refs are gone).
pub(crate) async fn base_tree(
    agent: &Agent,
    helper_id: &str,
    side: Side,
) -> anyhow::Result<Option<String>> {
    let cwd = git_for(agent).await?;
    let git = Git::new(&cwd).await?;
    let spec = format!("{}^{{tree}}", base_ref(helper_id, side));
    Ok(git
        .text(&["rev-parse", "--verify", "-q", &spec])
        .await
        .ok()
        .filter(|t| !t.is_empty()))
}

/// Deletes the helper's sync refs. `folder` is any checkout of the repository.
pub(crate) async fn forget(folder: &Path, helper_id: &str) {
    if !folder.is_dir() {
        return;
    }
    let Ok(git) = Git::new(folder).await else {
        return;
    };
    let deletes: String = [Side::Main, Side::Helper]
        .iter()
        .map(|s| format!("delete {}\n", base_ref(helper_id, *s)))
        .collect();
    if let Err(e) = git
        .run(&["update-ref", "--stdin"], Some(deletes.into_bytes()), &[])
        .await
    {
        tracing::debug!("deleting helper refs: {e:#}");
    }
}

// ---- diffs ---------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct Ent {
    mode: String,
    oid: String,
}

impl Ent {
    fn regular(&self) -> bool {
        self.mode == "100644" || self.mode == "100755"
    }
}

struct Ch {
    path: Vec<u8>,
    old: Option<Ent>,
    new: Option<Ent>,
}

fn ent(mode: &[u8], oid: &[u8]) -> Option<Ent> {
    let mode = String::from_utf8_lossy(mode).into_owned();
    if mode.bytes().all(|b| b == b'0') {
        return None;
    }
    Some(Ent {
        mode,
        oid: String::from_utf8_lossy(oid).into_owned(),
    })
}

/// Files that differ between two trees (sub-repositories left out).
async fn diff(git: &Git<'_>, from: &str, to: &str) -> anyhow::Result<Vec<Ch>> {
    let out = git
        .run(
            &[
                "diff-tree",
                "-r",
                "-z",
                "--raw",
                "--no-renames",
                "--no-abbrev",
                "--no-ext-diff",
                "--no-textconv",
                from,
                to,
            ],
            None,
            &[],
        )
        .await?;
    let mut parts = out.split(|b| *b == 0).filter(|p| !p.is_empty());
    let mut list = Vec::new();
    while let Some(header) = parts.next() {
        let Some(path) = parts.next() else { break };
        // ":100644 100644 <oid> <oid> M"
        let f: Vec<&[u8]> = header
            .strip_prefix(b":")
            .unwrap_or(header)
            .split(|b| *b == b' ')
            .collect();
        if f.len() < 5 || f[0] == b"160000" || f[1] == b"160000" {
            continue;
        }
        list.push(Ch {
            path: path.to_vec(),
            old: ent(f[0], f[2]),
            new: ent(f[1], f[3]),
        });
    }
    Ok(list)
}

/// Paths (lossy) of files that differ between two trees.
pub(crate) async fn changed_paths(
    agent: &Agent,
    from: &str,
    to: &str,
) -> anyhow::Result<Vec<String>> {
    let cwd = git_for(agent).await?;
    let git = Git::new(&cwd).await?;
    let mut paths: Vec<String> = diff(&git, from, to)
        .await?
        .into_iter()
        .map(|c| String::from_utf8_lossy(&c.path).into_owned())
        .collect();
    paths.sort();
    Ok(paths)
}

/// `git diff --binary` of two trees, for the "ask main to merge" patch file.
pub(crate) async fn patch_between(agent: &Agent, from: &str, to: &str) -> anyhow::Result<Vec<u8>> {
    let cwd = git_for(agent).await?;
    let git = Git::new(&cwd).await?;
    git.run(
        &[
            "diff-tree",
            "-p",
            "-r",
            "--binary",
            "--full-index",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            from,
            to,
        ],
        None,
        &[],
    )
    .await
}

// ---- planning ------------------------------------------------------------------

#[derive(Debug)]
enum Content {
    /// An existing blob.
    Blob(String),
    Bytes(Vec<u8>),
}

#[derive(Debug)]
enum Action {
    Set { mode: String, content: Content },
    Delete,
}

#[derive(Debug, Default)]
pub(crate) struct Plan {
    /// (path, what to do), in git's path order.
    actions: Vec<(Vec<u8>, Action)>,
    /// Paths that can't be merged automatically.
    pub conflicts: Vec<String>,
    /// What the target's files looked like for those paths (to verify on write).
    ours: HashMap<Vec<u8>, Option<Ent>>,
}

impl Plan {
    pub fn files(&self) -> usize {
        self.actions.len()
    }
}

async fn blobs(git: &Git<'_>, oids: &[String]) -> anyhow::Result<HashMap<String, Vec<u8>>> {
    let mut map = HashMap::new();
    if oids.is_empty() {
        return Ok(map);
    }
    let mut input = String::new();
    for o in oids {
        input.push_str(o);
        input.push('\n');
    }
    let out = git
        .run(&["cat-file", "--batch"], Some(input.into_bytes()), &[])
        .await?;
    // "<oid> blob <size>\n<bytes>\n"
    let mut at = 0usize;
    for _ in oids {
        let nl = out[at..]
            .iter()
            .position(|b| *b == b'\n')
            .ok_or_else(|| anyhow!("unexpected git cat-file output"))?;
        let header = String::from_utf8_lossy(&out[at..at + nl]).into_owned();
        let mut f = header.split(' ');
        let (oid, kind, size) = (f.next(), f.next(), f.next());
        if kind != Some("blob") {
            bail!("git cat-file: {header}");
        }
        let size: usize = size
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| anyhow!("unexpected git cat-file header"))?;
        let start = at + nl + 1;
        let body = out
            .get(start..start + size)
            .ok_or_else(|| anyhow!("truncated git cat-file output"))?;
        map.insert(oid.unwrap_or_default().to_string(), body.to_vec());
        at = start + size + 1;
    }
    Ok(map)
}

fn lossy(path: &[u8]) -> String {
    String::from_utf8_lossy(path).into_owned()
}

/// Works out what bringing `base -> theirs` into `ours` takes. Reads trees and
/// blobs only.
pub(crate) async fn plan(cwd: &Path, base: &str, ours: &str, theirs: &str) -> anyhow::Result<Plan> {
    let git = Git::new(cwd).await?;
    let theirs_ch = diff(&git, base, theirs).await?;
    let ours_ch: HashMap<Vec<u8>, Option<Ent>> = diff(&git, base, ours)
        .await?
        .into_iter()
        .map(|c| (c.path, c.new))
        .collect();
    let mut plan = Plan::default();
    // (path, base, ours, theirs) for the files both sides changed.
    let mut both: Vec<(Vec<u8>, Ent, Ent, Ent)> = Vec::new();
    for c in theirs_ch {
        let shown = lossy(&c.path);
        if rel_path(&c.path).is_none() || c.path.contains(&b'\n') {
            plan.conflicts.push(shown);
            continue;
        }
        let o = ours_ch
            .get(&c.path)
            .cloned()
            .unwrap_or_else(|| c.old.clone());
        if o == c.new {
            continue;
        }
        plan.ours.insert(c.path.clone(), o.clone());
        if o == c.old {
            match c.new {
                Some(t) if t.regular() => plan.actions.push((
                    c.path,
                    Action::Set {
                        mode: t.mode,
                        content: Content::Blob(t.oid),
                    },
                )),
                Some(_) => plan.conflicts.push(shown),
                None => plan.actions.push((c.path, Action::Delete)),
            }
            continue;
        }
        match (c.old, o, c.new) {
            (Some(b), Some(o), Some(t)) if b.regular() && o.regular() && t.regular() => {
                both.push((c.path, b, o, t));
            }
            _ => plan.conflicts.push(shown),
        }
    }
    if !both.is_empty() {
        let mut want: Vec<String> = Vec::new();
        for (_, b, o, t) in &both {
            for e in [b, o, t] {
                if !want.contains(&e.oid) {
                    want.push(e.oid.clone());
                }
            }
        }
        let data = blobs(&git, &want).await?;
        for (path, b, o, t) in both {
            let shown = lossy(&path);
            let (bb, ob, tb) = (&data[&b.oid], &data[&o.oid], &data[&t.oid]);
            let too_big = [bb, ob, tb].iter().any(|d| d.len() > MAX_MERGE_BYTES);
            let binary = [bb, ob, tb].iter().any(|d| d.contains(&0));
            if too_big || binary {
                plan.conflicts.push(shown);
                continue;
            }
            match merge_text(&git, ob, bb, tb).await? {
                None => plan.conflicts.push(shown),
                Some(merged) => {
                    let mode = if t.mode != b.mode && o.mode == b.mode {
                        t.mode
                    } else {
                        o.mode.clone()
                    };
                    if merged == *ob && mode == o.mode {
                        continue;
                    }
                    plan.actions.push((
                        path,
                        Action::Set {
                            mode,
                            content: Content::Bytes(merged),
                        },
                    ));
                }
            }
        }
    }
    plan.conflicts.sort();
    plan.actions.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(plan)
}

/// Three-way text merge; None when the changes overlap.
async fn merge_text(
    git: &Git<'_>,
    ours: &[u8],
    base: &[u8],
    theirs: &[u8],
) -> anyhow::Result<Option<Vec<u8>>> {
    let dir = std::env::temp_dir().join(format!("armada-merge-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir)?;
    let result = async {
        let (o, b, t) = (dir.join("ours"), dir.join("base"), dir.join("theirs"));
        std::fs::write(&o, ours)?;
        std::fs::write(&b, base)?;
        std::fs::write(&t, theirs)?;
        let out = git
            .exec(
                &[],
                &[
                    "merge-file",
                    "-p",
                    "-L",
                    "ours",
                    "-L",
                    "base",
                    "-L",
                    "theirs",
                    &o.to_string_lossy(),
                    &b.to_string_lossy(),
                    &t.to_string_lossy(),
                ],
                None,
                &[],
            )
            .await?;
        match out.status.code() {
            Some(0) => Ok(Some(out.stdout)),
            Some(n) if (1..=127).contains(&n) => Ok(None),
            _ => Err(anyhow!("git merge-file: {}", stderr_of(&out))),
        }
    }
    .await;
    let _ = std::fs::remove_dir_all(&dir);
    result
}

// ---- applying ------------------------------------------------------------------

/// The tree `onto` would become with the plan's changes (nothing on disk changes).
pub(crate) async fn plan_tree(cwd: &Path, plan: &Plan, onto: &str) -> anyhow::Result<String> {
    let git = Git::new(cwd).await?;
    let zero = "0".repeat(onto.len());
    let mut info: Vec<u8> = Vec::new();
    for (path, action) in &plan.actions {
        let (mode, oid) = match action {
            Action::Delete => ("0".to_string(), zero.clone()),
            Action::Set { mode, content } => {
                let oid = match content {
                    Content::Blob(o) => o.clone(),
                    Content::Bytes(b) => {
                        let out = git
                            .run(
                                &["hash-object", "-w", "--no-filters", "--stdin"],
                                Some(b.clone()),
                                &[],
                            )
                            .await?;
                        String::from_utf8_lossy(&out).trim().to_string()
                    }
                };
                (mode.clone(), oid)
            }
        };
        info.extend_from_slice(format!("{mode} {oid}\t").as_bytes());
        info.extend_from_slice(path);
        info.push(0);
    }
    let index = std::env::temp_dir().join(format!("armada-ckpt-{}", uuid::Uuid::new_v4()));
    let result = async {
        let env: [(&str, &OsStr); 1] = [("GIT_INDEX_FILE", index.as_os_str())];
        git.run(&["read-tree", onto], None, &env).await?;
        if !info.is_empty() {
            git.run(&["update-index", "-z", "--index-info"], Some(info), &env)
                .await?;
        }
        let tree = git.run(&["write-tree"], None, &env).await?;
        Ok(String::from_utf8_lossy(&tree).trim().to_string())
    }
    .await;
    let _ = std::fs::remove_file(&index);
    result
}

fn parent_is_plain(root: &Path, rel: &Path) -> bool {
    let mut at = root.to_path_buf();
    let parts: Vec<_> = rel.components().collect();
    for part in &parts[..parts.len().saturating_sub(1)] {
        at.push(part);
        match std::fs::symlink_metadata(&at) {
            Ok(m) if m.is_dir() => {}
            Ok(_) => return false,
            Err(_) => return true,
        }
    }
    true
}

/// Whether `name` is a staging or backup file `write_plan` creates:
/// `.armada-merge-<32 hex>-<digits>` with an optional `.bak`.
fn is_merge_leftover(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(".armada-merge-") else {
        return false;
    };
    let rest = rest.strip_suffix(".bak").unwrap_or(rest);
    let Some((id, idx)) = rest.split_once('-') else {
        return false;
    };
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && !idx.is_empty()
        && idx.bytes().all(|b| b.is_ascii_digit())
}

/// Removes staged/backup files an interrupted merge left under `root` (skipping `.git`,
/// not following symlinks). Returns the files removed.
pub(crate) fn remove_merge_leftovers(root: &Path) -> Vec<PathBuf> {
    let mut removed = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut seen = 0usize;
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            seen += 1;
            if seen > 500_000 {
                return removed;
            }
            let Ok(ft) = entry.file_type() else { continue };
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if ft.is_dir() {
                if name != ".git" {
                    stack.push(entry.path());
                }
            } else if ft.is_file() && is_merge_leftover(&name) {
                let p = entry.path();
                if std::fs::remove_file(&p).is_ok() {
                    tracing::info!("removed leftover merge file {}", p.display());
                    removed.push(p);
                }
            }
        }
    }
    removed
}

/// Puts back what `write_plan` already moved into place.
fn undo(done: &[(PathBuf, Option<PathBuf>)]) {
    for (dest, backup) in done.iter().rev() {
        match backup {
            Some(b) => {
                let _ = std::fs::rename(b, dest);
            }
            None => {
                let _ = std::fs::remove_file(dest);
            }
        }
    }
}

/// Writes the plan into the working tree at `cwd`. Everything is staged and
/// checked first, so a failure (or a file that changed since the plan) leaves the
/// folder as it was.
pub(crate) async fn write_plan(cwd: &Path, plan: &Plan) -> anyhow::Result<()> {
    if plan.actions.is_empty() {
        return Ok(());
    }
    let git = Git::new(cwd).await?;
    // 1. The folder must still match what the plan was made from.
    let mut existing: Vec<(&Vec<u8>, &Ent)> = Vec::new();
    for (path, _) in &plan.actions {
        let rel = rel_path(path).ok_or_else(|| anyhow!("unsafe path"))?;
        if !parent_is_plain(cwd, &rel) {
            bail!("{} is behind a symlinked folder", rel.display());
        }
        let disk = std::fs::symlink_metadata(cwd.join(&rel));
        match (plan.ours.get(path), disk) {
            (Some(Some(e)), Ok(m)) if m.is_file() => existing.push((path, e)),
            (Some(None), Err(_)) => {}
            _ => bail!("{} changed while merging", rel.display()),
        }
    }
    if !existing.is_empty() {
        let mut input = Vec::new();
        for (p, _) in &existing {
            input.extend_from_slice(p);
            input.push(b'\n');
        }
        let out = git
            .run(
                &["hash-object", "--no-filters", "--stdin-paths"],
                Some(input),
                &[],
            )
            .await?;
        let sums: Vec<String> = String::from_utf8_lossy(&out)
            .lines()
            .map(str::to_string)
            .collect();
        if sums.len() != existing.len() || sums.iter().zip(&existing).any(|(s, (_, e))| *s != e.oid)
        {
            bail!("The folder changed while merging");
        }
    }
    // 2. Stage the new contents next to their destinations.
    let wanted: Vec<String> = plan
        .actions
        .iter()
        .filter_map(|(_, a)| match a {
            Action::Set {
                content: Content::Blob(o),
                ..
            } => Some(o.clone()),
            _ => None,
        })
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let data = blobs(&git, &wanted).await?;
    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new();
    let cleanup = |staged: &[(PathBuf, PathBuf)]| {
        for (tmp, _) in staged {
            let _ = std::fs::remove_file(tmp);
        }
    };
    let n = uuid::Uuid::new_v4().simple().to_string();
    for (i, (path, action)) in plan.actions.iter().enumerate() {
        let Action::Set { mode, content } = action else {
            continue;
        };
        let rel = rel_path(path).ok_or_else(|| anyhow!("unsafe path"))?;
        let dest = cwd.join(&rel);
        let step = (|| -> anyhow::Result<PathBuf> {
            if std::fs::symlink_metadata(&dest).is_ok_and(|m| m.is_dir()) {
                bail!("{} is a folder here", rel.display());
            }
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let tmp = dest.with_file_name(format!(".armada-merge-{n}-{i}"));
            let bytes: &[u8] = match content {
                Content::Bytes(b) => b,
                Content::Blob(o) => data.get(o).map(Vec::as_slice).unwrap_or_default(),
            };
            std::fs::write(&tmp, bytes)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                // Replacing a file keeps its permission bits; a new file takes the
                // source tree's mode.
                let perm = match std::fs::symlink_metadata(&dest) {
                    Ok(m) if m.is_file() => m.permissions().mode() & 0o7777,
                    _ => {
                        if mode == "100755" {
                            0o755
                        } else {
                            0o644
                        }
                    }
                };
                std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(perm))?;
            }
            #[cfg(not(unix))]
            let _ = mode;
            Ok(tmp)
        })();
        match step {
            Ok(tmp) => staged.push((tmp, dest)),
            Err(e) => {
                cleanup(&staged);
                return Err(e).with_context(|| format!("preparing {}", rel.display()));
            }
        }
    }
    // 3. Move into place (undoing it all if one move fails), then remove deleted
    // files. A hard link keeps each replaced file's old content until the end.
    let mut done: Vec<(PathBuf, Option<PathBuf>)> = Vec::new();
    for (i, (tmp, dest)) in staged.iter().enumerate() {
        let backup = dest.with_file_name(format!(".armada-merge-{n}-{i}.bak"));
        let kept = if std::fs::symlink_metadata(dest).is_ok() {
            if std::fs::hard_link(dest, &backup).is_err() {
                if let Err(e) = std::fs::copy(dest, &backup) {
                    let _ = std::fs::remove_file(&backup);
                    undo(&done);
                    cleanup(&staged);
                    return Err(e).with_context(|| format!("writing {}", dest.display()));
                }
            }
            Some(backup)
        } else {
            None
        };
        if let Err(e) = std::fs::rename(tmp, dest) {
            if let Some(b) = &kept {
                let _ = std::fs::remove_file(b);
            }
            undo(&done);
            cleanup(&staged);
            return Err(e).with_context(|| format!("writing {}", dest.display()));
        }
        done.push((dest.clone(), kept));
    }
    for (_, backup) in &done {
        if let Some(b) = backup {
            let _ = std::fs::remove_file(b);
        }
    }
    let mut dirs: std::collections::HashSet<PathBuf> = Default::default();
    for (path, action) in &plan.actions {
        if matches!(action, Action::Delete) {
            if let Some(rel) = rel_path(path) {
                let _ = std::fs::remove_file(cwd.join(&rel));
                let mut parent = rel.parent();
                while let Some(p) = parent.filter(|p| !p.as_os_str().is_empty()) {
                    dirs.insert(p.to_path_buf());
                    parent = p.parent();
                }
            }
        }
    }
    let mut dirs: Vec<PathBuf> = dirs.into_iter().collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in dirs {
        let _ = std::fs::remove_dir(cwd.join(d));
    }
    Ok(())
}

// ---- merging between agents ----------------------------------------------------

#[derive(Debug)]
pub(crate) enum Merge {
    /// Applied; `files` changed in the target. `target_after` is its new tree and
    /// `base_after` the other side's base advanced past this patch.
    Done {
        files: usize,
        target_after: String,
        base_after: String,
    },
    Conflict(Vec<String>),
}

/// Brings `base -> theirs` into the files of `target`. `other_base` is the base of
/// the *target's* side that has to learn about the patch (see `Done::base_after`).
pub(crate) async fn merge_into(
    target: &Agent,
    base: &str,
    theirs: &str,
    other_base: &str,
) -> anyhow::Result<Merge> {
    let cwd = git_for(target).await?;
    let git = Git::new(&cwd).await?;
    // Held across snapshot, plan and write so the agent's own checkpoints can't
    // interleave; the user's editor still can, which `write_plan` re-checks.
    let _guard = lock_agent(&target.id).await;
    let ours = git.snapshot_tree(None).await?;
    let plan = plan(&cwd, base, &ours, theirs).await?;
    if !plan.conflicts.is_empty() {
        return Ok(Merge::Conflict(plan.conflicts));
    }
    // The other side's base learns the patch too (without the target's own edits),
    // so it isn't echoed back later. If it can't be computed it stays put.
    let base_after = plan_for_base(&cwd, base, other_base, theirs)
        .await
        .unwrap_or_else(|| other_base.to_string());
    if plan.actions.is_empty() {
        return Ok(Merge::Done {
            files: 0,
            target_after: ours,
            base_after,
        });
    }
    write_plan(&cwd, &plan).await?;
    let target_after = git.snapshot_tree(None).await?;
    Ok(Merge::Done {
        files: plan.files(),
        target_after,
        base_after,
    })
}

/// `other_base` with the patch `base -> theirs` applied (None on any trouble).
async fn plan_for_base(cwd: &Path, base: &str, other_base: &str, theirs: &str) -> Option<String> {
    let p = plan(cwd, base, other_base, theirs).await.ok()?;
    if !p.conflicts.is_empty() {
        return None;
    }
    plan_tree(cwd, &p, other_base).await.ok()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) struct Repo {
        pub root: PathBuf,
        pub dir: PathBuf,
    }

    impl Repo {
        pub fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("armada-helper-test-{}", uuid::Uuid::new_v4()));
            let dir = root.join("work");
            std::fs::create_dir_all(&dir).unwrap();
            let r = Repo { root, dir };
            r.git(&["init", "-q"]);
            for (k, v) in [
                ("core.autocrlf", "false"),
                ("user.name", "T"),
                ("user.email", "t@t.invalid"),
                ("commit.gpgsign", "false"),
            ] {
                r.git(&["config", k, v]);
            }
            r.write(".gitignore", "*.log\n");
            r.write("a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n");
            r.write("b.txt", "bee\n");
            r.git(&["add", "-A"]);
            r.git(&["commit", "-q", "-m", "init"]);
            r
        }

        pub fn git(&self, args: &[&str]) -> String {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&self.dir)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {}", stderr_of(&out));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        pub fn write(&self, path: &str, content: &str) {
            let p = self.dir.join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, content).unwrap();
        }

        pub fn read(&self, path: &str) -> Option<String> {
            std::fs::read_to_string(self.dir.join(path)).ok()
        }

        pub fn agent(&self, id: &str) -> Agent {
            agent_at(id, &self.dir)
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    pub(crate) fn agent_at(id: &str, dir: &Path) -> Agent {
        serde_json::from_value(serde_json::json!({
            "id": id, "title": "t", "provider": "claude", "accountId": "x",
            "projectPath": dir.to_string_lossy(), "cwd": dir.to_string_lossy(),
            "worktree": false, "status": "idle", "running": false,
            "branch": null, "baseBranch": null, "baseCommit": null,
            "sessionId": null, "groupId": null, "createdAt": 0,
            "updatedAt": 0, "lastActivityAt": 0, "costUsd": 0.0,
            "tokensUsed": 0, "contextUsed": null, "contextSize": null,
            "unread": false, "archived": false, "lastMessage": null,
            "pendingPermissions": 0
        }))
        .unwrap()
    }

    /// A second checkout of the repo with `commit` checked out (like a helper).
    fn helper_of(r: &Repo, commit: &str) -> (PathBuf, Agent) {
        let dir = r.root.join("helper");
        r.git(&[
            "worktree",
            "add",
            "-q",
            "-b",
            "armada/helper-x",
            &dir.to_string_lossy(),
            commit,
        ]);
        let a = agent_at("h1", &dir);
        (dir, a)
    }

    #[tokio::test]
    async fn snapshot_has_uncommitted_and_untracked_but_not_ignored() {
        let r = Repo::new();
        r.write("a.txt", "changed\n");
        r.write("new.txt", "untracked\n");
        r.write("noise.log", "ignored\n");
        let commit = seed(&r.agent("m"), "h1").await.unwrap();
        let (dir, _) = helper_of(&r, &commit);
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "changed\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("new.txt")).unwrap(),
            "untracked\n"
        );
        assert!(!dir.join("noise.log").exists());
        // The parent's index and HEAD were never touched.
        assert!(r.git(&["status", "--porcelain"]).contains("?? new.txt"));
        assert!(r.git(&["status", "--porcelain"]).contains("M a.txt"));
        // Both bases exist.
        let h = r.agent("m");
        assert!(base_tree(&h, "h1", Side::Main).await.unwrap().is_some());
        assert!(base_tree(&h, "h1", Side::Helper).await.unwrap().is_some());
        forget(&r.dir, "h1").await;
        assert!(base_tree(&h, "h1", Side::Main).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn helper_changes_merge_into_main_without_touching_the_index() {
        let r = Repo::new();
        r.write("a.txt", "1\n2\n3\n4\n5\n6\n7\nmain-edit\n");
        let commit = seed(&r.agent("m"), "h1").await.unwrap();
        let (hdir, helper) = helper_of(&r, &commit);
        let main = r.agent("m");
        let h0 = base_tree(&main, "h1", Side::Helper).await.unwrap().unwrap();
        let m0 = base_tree(&main, "h1", Side::Main).await.unwrap().unwrap();
        // Helper edits another part of a.txt, adds a file, deletes b.txt.
        std::fs::write(
            hdir.join("a.txt"),
            "helper-edit\n2\n3\n4\n5\n6\n7\nmain-edit\n",
        )
        .unwrap();
        std::fs::create_dir_all(hdir.join("c")).unwrap();
        std::fs::write(hdir.join("c/d.txt"), "new\r\nfile\r\n").unwrap();
        std::fs::remove_file(hdir.join("b.txt")).unwrap();
        // Meanwhile main edits the other end (already in a.txt) and a file.
        r.write("e.txt", "main only\n");
        let index_before = std::fs::read(r.dir.join(".git/index")).unwrap();
        let head_before = r.git(&["rev-parse", "HEAD"]);

        let h1 = snapshot_tree(&helper, None).await.unwrap();
        let res = merge_into(&main, &h0, &h1, &m0).await.unwrap();
        let Merge::Done { files, .. } = res else {
            panic!("{res:?}")
        };
        assert_eq!(files, 3);
        assert_eq!(
            r.read("a.txt").unwrap(),
            "helper-edit\n2\n3\n4\n5\n6\n7\nmain-edit\n"
        );
        assert_eq!(r.read("c/d.txt").unwrap(), "new\r\nfile\r\n", "CRLF kept");
        assert!(!r.dir.join("b.txt").exists());
        assert_eq!(r.read("e.txt").unwrap(), "main only\n");
        assert_eq!(
            std::fs::read(r.dir.join(".git/index")).unwrap(),
            index_before
        );
        assert_eq!(r.git(&["rev-parse", "HEAD"]), head_before);
        // No staging leftovers.
        assert!(!r
            .git(&["status", "--porcelain", "--ignored"])
            .contains("armada-merge"));
    }

    #[tokio::test]
    async fn conflicts_leave_the_target_untouched() {
        let r = Repo::new();
        let commit = seed(&r.agent("m"), "h1").await.unwrap();
        let (hdir, helper) = helper_of(&r, &commit);
        let main = r.agent("m");
        let h0 = base_tree(&main, "h1", Side::Helper).await.unwrap().unwrap();
        let m0 = base_tree(&main, "h1", Side::Main).await.unwrap().unwrap();
        std::fs::write(hdir.join("a.txt"), "H\n2\n3\n4\n5\n6\n7\n8\n").unwrap();
        std::fs::write(hdir.join("fresh.txt"), "from helper\n").unwrap();
        r.write("a.txt", "M\n2\n3\n4\n5\n6\n7\n8\n");
        let h1 = snapshot_tree(&helper, None).await.unwrap();
        let res = merge_into(&main, &h0, &h1, &m0).await.unwrap();
        let Merge::Conflict(files) = res else {
            panic!("{res:?}")
        };
        assert_eq!(files, vec!["a.txt".to_string()]);
        assert_eq!(r.read("a.txt").unwrap(), "M\n2\n3\n4\n5\n6\n7\n8\n");
        assert!(!r.dir.join("fresh.txt").exists(), "nothing half-applied");
    }

    #[tokio::test]
    async fn main_changes_flow_into_the_helper_and_are_not_echoed() {
        let r = Repo::new();
        let commit = seed(&r.agent("m"), "h1").await.unwrap();
        let (hdir, helper) = helper_of(&r, &commit);
        let main = r.agent("m");
        let m0 = base_tree(&main, "h1", Side::Main).await.unwrap().unwrap();
        let h0 = base_tree(&main, "h1", Side::Helper).await.unwrap().unwrap();
        r.write("a.txt", "1\n2\n3\n4\n5\n6\n7\nMAIN\n");
        r.write("m.txt", "main file\n");
        std::fs::write(hdir.join("b.txt"), "bee edited by helper\n").unwrap();
        let m1 = snapshot_tree(&main, None).await.unwrap();
        let Merge::Done {
            files,
            target_after,
            base_after,
        } = merge_into(&helper, &m0, &m1, &h0).await.unwrap()
        else {
            panic!()
        };
        assert_eq!(files, 2);
        assert_eq!(
            std::fs::read_to_string(hdir.join("a.txt")).unwrap(),
            "1\n2\n3\n4\n5\n6\n7\nMAIN\n"
        );
        assert_eq!(
            std::fs::read_to_string(hdir.join("b.txt")).unwrap(),
            "bee edited by helper\n"
        );
        // The helper base now includes main's patch, so b.txt (helper's own edit)
        // is the only difference left from helper-base to the helper's files.
        let left = changed_paths(&helper, &base_after, &target_after)
            .await
            .unwrap();
        assert_eq!(left, vec!["b.txt".to_string()]);
    }

    #[tokio::test]
    async fn a_folder_that_changes_mid_merge_is_not_written() {
        let r = Repo::new();
        let commit = seed(&r.agent("m"), "h1").await.unwrap();
        let (hdir, helper) = helper_of(&r, &commit);
        let main = r.agent("m");
        let h0 = base_tree(&main, "h1", Side::Helper).await.unwrap().unwrap();
        std::fs::write(hdir.join("b.txt"), "helper\n").unwrap();
        let h1 = snapshot_tree(&helper, None).await.unwrap();
        let ours = snapshot_tree(&main, None).await.unwrap();
        let p = plan(&r.dir, &h0, &ours, &h1).await.unwrap();
        assert_eq!(p.files(), 1);
        r.write("b.txt", "edited meanwhile\n");
        assert!(write_plan(&r.dir, &p).await.is_err());
        assert_eq!(r.read("b.txt").unwrap(), "edited meanwhile\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn merged_files_keep_or_take_the_right_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let r = Repo::new();
        let b = r.dir.join("b.txt");
        std::fs::set_permissions(&b, std::fs::Permissions::from_mode(0o640)).unwrap();
        let oid = r.git(&["hash-object", "--no-filters", "b.txt"]);
        let mut p = Plan::default();
        p.ours.insert(
            b"b.txt".to_vec(),
            Some(Ent {
                mode: "100644".into(),
                oid,
            }),
        );
        p.ours.insert(b"run.sh".to_vec(), None);
        p.actions.push((
            b"b.txt".to_vec(),
            Action::Set {
                mode: "100755".into(),
                content: Content::Bytes(b"new\n".to_vec()),
            },
        ));
        p.actions.push((
            b"run.sh".to_vec(),
            Action::Set {
                mode: "100755".into(),
                content: Content::Bytes(b"#!/bin/sh\n".to_vec()),
            },
        ));
        write_plan(&r.dir, &p).await.unwrap();
        let mode = |f: &str| {
            std::fs::metadata(r.dir.join(f))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777
        };
        assert_eq!(mode("b.txt"), 0o640);
        assert_eq!(mode("run.sh"), 0o755);
        assert_eq!(r.read("b.txt").unwrap(), "new\n");
    }

    #[test]
    fn only_armada_merge_leftovers_are_removed() {
        let r = Repo::new();
        let id = "0123456789abcdef0123456789abcdef";
        std::fs::create_dir_all(r.dir.join("sub")).unwrap();
        let stale = [
            format!(".armada-merge-{id}-0"),
            format!("sub/.armada-merge-{id}-12.bak"),
        ];
        let keep = [
            ".armada-merge-notes.txt".to_string(),
            format!(".armada-merge-{id}-x"),
            format!("armada-merge-{id}-0"),
            format!(".armada-merge-{id}-0.bak.keep"),
            "b.txt".to_string(),
        ];
        for f in stale.iter().chain(&keep) {
            std::fs::write(r.dir.join(f), "x").unwrap();
        }
        let removed = remove_merge_leftovers(&r.dir);
        assert_eq!(removed.len(), 2);
        for f in &stale {
            assert!(!r.dir.join(f).exists(), "{f}");
        }
        for f in &keep {
            assert!(r.dir.join(f).exists(), "{f}");
        }
    }

    #[tokio::test]
    async fn eol_attributes_do_not_rewrite_files_or_block_merges() {
        let r = Repo::new();
        r.write(".gitattributes", "*.txt text eol=crlf\n");
        r.git(&["add", "-A"]);
        r.git(&["commit", "-q", "-m", "attrs"]);
        r.write("w.txt", "one\r\ntwo\r\n");
        let commit = seed(&r.agent("m"), "h1").await.unwrap();
        let (hdir, helper) = helper_of(&r, &commit);
        let main = r.agent("m");
        let h0 = base_tree(&main, "h1", Side::Helper).await.unwrap().unwrap();
        let m0 = base_tree(&main, "h1", Side::Main).await.unwrap().unwrap();
        std::fs::write(hdir.join("x.txt"), "x\r\n").unwrap();
        std::fs::write(hdir.join("b.txt"), "bee2\r\n").unwrap();
        r.write("w.txt", "one\r\ntwo\r\nthree\r\n");
        let h1 = snapshot_tree(&helper, None).await.unwrap();
        let res = merge_into(&main, &h0, &h1, &m0).await.unwrap();
        assert!(matches!(res, Merge::Done { .. }), "{res:?}");
        assert_eq!(r.read("w.txt").unwrap(), "one\r\ntwo\r\nthree\r\n");
        assert_eq!(r.read("x.txt").unwrap(), "x\r\n");
        assert_eq!(r.read("b.txt").unwrap(), "bee2\r\n");
    }
}
