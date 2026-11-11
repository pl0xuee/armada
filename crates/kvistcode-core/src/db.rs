//! SQLite storage. Rows hold JSON blobs of the model types so the schema can
//! evolve without migrations for every new field.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::model::{Account, Agent, ItemBody, NoticeLevel, Schedule, Settings, TimelineItem};

mod search;

pub struct Db {
    /// Every write, and reads that must see them immediately.
    conn: Mutex<Connection>,
    /// Long reads (timelines, search) on their own connection: WAL lets them run
    /// while agents keep writing, instead of queueing behind every put_item.
    reader: Mutex<Connection>,
    dir: PathBuf,
}

/// `PRAGMA user_version` this build writes. Bump with real schema migrations.
const SCHEMA_VERSION: i64 = 3;

/// Waiting for another connection's lock before failing with "database is locked".
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

const SCHEMA: &str = r#"
PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS accounts (
    id   TEXT PRIMARY KEY,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
    id           TEXT PRIMARY KEY,
    data         TEXT NOT NULL,
    title_custom INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS items (
    id          TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    ts          INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    data        TEXT NOT NULL,
    search_text TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS items_agent_seq ON items(agent_id, seq);
CREATE INDEX IF NOT EXISTS items_pending_perm ON items(agent_id) WHERE kind = 'permission';
CREATE INDEX IF NOT EXISTS items_pending_question ON items(agent_id) WHERE kind = 'question';
CREATE TABLE IF NOT EXISTS schedules (
    id   TEXT PRIMARY KEY,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS queues (
    agent_id TEXT PRIMARY KEY,
    data     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints (
    id         TEXT PRIMARY KEY,
    agent_id   TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    item_id    TEXT,
    created_at INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    tree       TEXT NOT NULL,
    commit_oid TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS checkpoints_agent_seq ON checkpoints(agent_id, seq);
CREATE TABLE IF NOT EXISTS settings (
    id   INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL
);
"#;

/// Shown in place of a timeline row this build can't read.
const UNREADABLE_ITEM_TEXT: &str =
    "This item was written by a newer version of Kvistcode and can't be shown here.";

/// True for errors that mean the file is damaged or isn't a database at all —
/// never for "locked"/"busy", which only mean someone else is using it.
pub fn is_corruption(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        cause
            .downcast_ref::<rusqlite::Error>()
            .and_then(rusqlite::Error::sqlite_error_code)
            .is_some_and(|code| {
                matches!(
                    code,
                    rusqlite::ErrorCode::NotADatabase | rusqlite::ErrorCode::DatabaseCorrupt
                )
            })
    })
}

/// Moves a damaged database (and its WAL/SHM files) aside as
/// `<name>.corrupt-<unix ms>` so a fresh one can be created. Returns the new path.
pub fn quarantine(path: &Path) -> anyhow::Result<PathBuf> {
    let stamp = crate::model::now_ms();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "armada.db".into());
    let moved = path.with_file_name(format!("{name}.corrupt-{stamp}"));
    std::fs::rename(path, &moved)
        .with_context(|| format!("moving the damaged {} aside", path.display()))?;
    for suffix in ["-wal", "-shm"] {
        let side = path.with_file_name(format!("{name}{suffix}"));
        if side.exists() {
            let _ = std::fs::rename(
                &side,
                moved.with_file_name(format!("{name}.corrupt-{stamp}{suffix}")),
            );
        }
    }
    Ok(moved)
}

/// Owner-only permissions: the database holds conversations and settings
/// (including MCP server env/headers and custom agent env).
#[cfg(unix)]
pub(crate) fn restrict_file(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.permissions().mode() & 0o077 != 0 {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
    }
}

#[cfg(not(unix))]
pub(crate) fn restrict_file(_path: &Path) {}

/// Writes a file only the owner can read.
fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    std::io::Write::write_all(&mut opts.open(path)?, data)?;
    restrict_file(path);
    Ok(())
}

/// Deserializes `stored` as `T`, keeping every part that's readable: a field
/// that doesn't fit falls back to its default, and a list keeps the entries that
/// fit. Returns the value and a description of each part that was dropped.
pub(crate) fn from_value_lenient<T>(stored: &Value) -> (T, Vec<String>)
where
    T: Serialize + DeserializeOwned + Default,
{
    if let Ok(v) = serde_json::from_value::<T>(stored.clone()) {
        return (v, Vec::new());
    }
    let mut good = serde_json::to_value(T::default()).unwrap_or(Value::Null);
    let mut dropped = Vec::new();
    if stored.is_object() && good.is_object() {
        merge_lenient::<T>(&mut good, &mut Vec::new(), stored, &mut dropped);
    } else {
        dropped.push("(everything)".into());
    }
    let value = serde_json::from_value(good).unwrap_or_default();
    (value, dropped)
}

fn value_at<'a>(root: &'a mut Value, path: &[String]) -> Option<&'a mut Value> {
    path.iter().try_fold(root, |v, k| v.get_mut(k.as_str()))
}

/// Whether `T` still deserializes with `candidate` placed at `path` in `good`.
fn accepts<T: DeserializeOwned>(good: &Value, path: &[String], candidate: &Value) -> bool {
    let mut probe = good.clone();
    let Some((last, parent)) = path.split_last() else {
        return serde_json::from_value::<T>(candidate.clone()).is_ok();
    };
    match value_at(&mut probe, parent).and_then(Value::as_object_mut) {
        Some(obj) => {
            obj.insert(last.clone(), candidate.clone());
            serde_json::from_value::<T>(probe).is_ok()
        }
        None => false,
    }
}

fn set_at(good: &mut Value, path: &[String], v: Value) {
    if let Some((last, parent)) = path.split_last() {
        if let Some(obj) = value_at(good, parent).and_then(Value::as_object_mut) {
            obj.insert(last.clone(), v);
        }
    }
}

/// `stored` is the stored object at `path`; `good` is a valid `T` throughout.
fn merge_lenient<T: DeserializeOwned>(
    good: &mut Value,
    path: &mut Vec<String>,
    stored: &Value,
    dropped: &mut Vec<String>,
) {
    let Some(map) = stored.as_object() else {
        return;
    };
    for (key, v) in map {
        path.push(key.clone());
        if accepts::<T>(good, path, v) {
            set_at(good, path, v.clone());
        } else if v.is_object() && value_at(good, path).is_some_and(|g| g.is_object()) {
            merge_lenient::<T>(good, path, v, dropped);
        } else if let Some(items) = v.as_array() {
            let mut kept = Vec::new();
            for (i, item) in items.iter().enumerate() {
                let mut candidate = kept.clone();
                candidate.push(item.clone());
                if accepts::<T>(good, path, &Value::Array(candidate)) {
                    kept.push(item.clone());
                } else {
                    dropped.push(format!("{}[{i}]", path.join(".")));
                }
            }
            let kept = Value::Array(kept);
            if accepts::<T>(good, path, &kept) {
                set_at(good, path, kept);
            } else {
                dropped.push(path.join("."));
            }
        } else {
            dropped.push(path.join("."));
        }
        path.pop();
    }
}

impl Db {
    /// Opens (or creates) the database. A file that turns out to be damaged or not a
    /// database at all is moved aside (`armada.db.corrupt-<ms>`) and replaced with an
    /// empty one, so the app still starts; a locked/busy database is an error.
    pub fn open(path: &Path) -> anyhow::Result<Db> {
        match Db::open_once(path) {
            Err(e) if is_corruption(&e) => {
                let moved = quarantine(path)?;
                tracing::error!(
                    "{} is damaged ({e:#}); it was moved to {} and Kvistcode started with an empty database",
                    path.display(),
                    moved.display()
                );
                Db::open_once(path)
            }
            other => other,
        }
    }

    fn open_once(path: &Path) -> anyhow::Result<Db> {
        if !path.exists() {
            // Created owner-only; SQLite gives the WAL/SHM files the same mode.
            write_private(path, b"").with_context(|| format!("creating {}", path.display()))?;
        }
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        conn.busy_timeout(BUSY_TIMEOUT)?;
        conn.execute_batch(SCHEMA)?;
        search::ensure_index(&conn)?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < SCHEMA_VERSION {
            if version < 3 {
                // Schema 3: messages an earlier indexer marked done without indexing are redone.
                search::requeue_unindexed(&conn)?;
            }
            conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
        } else if version > SCHEMA_VERSION {
            tracing::warn!(
                "{} was last written by a newer Kvistcode (schema {version}, this build knows {SCHEMA_VERSION}); \
                 some data may not be shown",
                path.display()
            );
        }
        let reader = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .with_context(|| format!("opening {} for reading", path.display()))?;
        reader.busy_timeout(BUSY_TIMEOUT)?;
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        for suffix in ["", "-wal", "-shm"] {
            restrict_file(&path.with_file_name(format!("{name}{suffix}")));
        }
        Ok(Db {
            conn: Mutex::new(conn),
            reader: Mutex::new(reader),
            dir: path.parent().map(Path::to_path_buf).unwrap_or_default(),
        })
    }

    // ---- accounts ----

    pub fn accounts(&self) -> anyhow::Result<Vec<Account>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT data FROM accounts")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            match serde_json::from_str(&row?) {
                Ok(a) => out.push(a),
                Err(e) => tracing::warn!("skipping unreadable account row: {e}"),
            }
        }
        Ok(out)
    }

    /// Whether a row with this id exists, readable or not.
    pub fn account_row_exists(&self, id: &str) -> anyhow::Result<bool> {
        Ok(self.conn.lock().query_row(
            "SELECT EXISTS(SELECT 1 FROM accounts WHERE id = ?1)",
            params![id],
            |r| r.get(0),
        )?)
    }

    pub fn put_account(&self, account: &Account) -> anyhow::Result<()> {
        // Encode before taking the writer lock, not while other writes wait on it.
        let data = serde_json::to_string(account)?;
        self.conn.lock().execute(
            "INSERT INTO accounts (id, data) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![account.id, data],
        )?;
        Ok(())
    }

    pub fn delete_account(&self, id: &str) -> anyhow::Result<()> {
        self.conn
            .lock()
            .execute("DELETE FROM accounts WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---- agents ----

    pub fn agents(&self) -> anyhow::Result<Vec<(Agent, bool)>> {
        let conn = self.reader.lock();
        let mut stmt = conn.prepare("SELECT data, title_custom FROM agents")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (data, custom) = row?;
            match serde_json::from_str(&data) {
                Ok(a) => out.push((a, custom)),
                Err(e) => tracing::warn!("skipping unreadable agent row: {e}"),
            }
        }
        Ok(out)
    }

    pub fn put_agent(&self, agent: &Agent) -> anyhow::Result<()> {
        let data = serde_json::to_string(agent)?;
        self.conn.lock().execute(
            "INSERT INTO agents (id, data) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![agent.id, data],
        )?;
        Ok(())
    }

    pub fn set_title_custom(&self, id: &str) -> anyhow::Result<()> {
        self.conn.lock().execute(
            "UPDATE agents SET title_custom = 1 WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Deletes the agent and its timeline together (all or nothing).
    pub fn delete_agent(&self, id: &str) -> anyhow::Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM items WHERE agent_id = ?1", params![id])?;
        tx.execute("DELETE FROM queues WHERE agent_id = ?1", params![id])?;
        tx.execute("DELETE FROM checkpoints WHERE agent_id = ?1", params![id])?;
        tx.execute("DELETE FROM agents WHERE id = ?1", params![id])?;
        tx.commit()?;
        // Give the freed pages back to the OS where the database supports it (new
        // databases do; older ones would need a full VACUUM, which we never force).
        let incremental: i64 = conn
            .query_row("PRAGMA auto_vacuum", [], |r| r.get(0))
            .unwrap_or(0);
        if incremental == 2 {
            if let Err(e) = conn.execute_batch("PRAGMA incremental_vacuum") {
                tracing::debug!("incremental vacuum: {e}");
            }
        }
        Ok(())
    }

    /// Whether some stored item still mentions this picture file (a bare file name).
    pub fn picture_in_use(&self, name: &str) -> bool {
        self.reader
            .lock()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM items WHERE instr(data, ?1) > 0)",
                params![name],
                |r| r.get(0),
            )
            // When unsure, keep the file.
            .unwrap_or(true)
    }

    // ---- checkpoints ----

    pub fn add_checkpoint(&self, c: &crate::checkpoints::Checkpoint) -> anyhow::Result<()> {
        self.conn.lock().execute(
            "INSERT INTO checkpoints (id, agent_id, seq, item_id, created_at, kind, tree, commit_oid)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                c.id,
                c.agent_id,
                c.seq,
                c.item_id,
                c.created_at,
                c.kind,
                c.tree,
                c.commit
            ],
        )?;
        Ok(())
    }

    /// The agent's checkpoints, oldest first.
    pub fn checkpoints(
        &self,
        agent_id: &str,
    ) -> anyhow::Result<Vec<crate::checkpoints::Checkpoint>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, seq, item_id, created_at, kind, tree, commit_oid
             FROM checkpoints WHERE agent_id = ?1 ORDER BY seq",
        )?;
        let rows = stmt.query_map(params![agent_id], |r| {
            Ok(crate::checkpoints::Checkpoint {
                id: r.get(0)?,
                agent_id: r.get(1)?,
                seq: r.get(2)?,
                item_id: r.get(3)?,
                created_at: r.get(4)?,
                kind: r.get(5)?,
                tree: r.get(6)?,
                commit: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn delete_checkpoints(&self, ids: &[String]) -> anyhow::Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for id in ids {
            tx.execute("DELETE FROM checkpoints WHERE id = ?1", params![id])?;
        }
        tx.commit()?;
        Ok(())
    }

    // ---- queued prompts ----

    /// Saves an agent's queued messages (text + attachments) so they survive a
    /// restart or crash. An empty queue removes the row.
    pub fn put_queue(
        &self,
        agent_id: &str,
        queue: &[crate::session::StoredPrompt],
    ) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        if queue.is_empty() {
            conn.execute("DELETE FROM queues WHERE agent_id = ?1", params![agent_id])?;
        } else {
            conn.execute(
                "INSERT INTO queues (agent_id, data) VALUES (?1, ?2)
                 ON CONFLICT(agent_id) DO UPDATE SET data = excluded.data",
                params![agent_id, serde_json::to_string(queue)?],
            )?;
        }
        Ok(())
    }

    /// Every saved queue, by agent id.
    pub fn queues(&self) -> anyhow::Result<Vec<(String, Vec<crate::session::StoredPrompt>)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT agent_id, data FROM queues")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (id, data) = row?;
            match serde_json::from_str(&data) {
                Ok(q) => out.push((id, q)),
                Err(e) => tracing::warn!("skipping unreadable queue of {id}: {e}"),
            }
        }
        Ok(out)
    }

    // ---- items ----

    pub fn put_item(&self, item: &TimelineItem) -> anyhow::Result<()> {
        // Encode and extract the search text before taking the writer lock.
        let data = serde_json::to_string(item)?;
        let search_text = search::item_text(item);
        self.conn.lock().execute(
            "INSERT INTO items (id, agent_id, seq, ts, kind, data, search_text, idx_ver)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, search_text = excluded.search_text,
                 idx_ver = 1",
            params![
                item.id,
                item.agent_id,
                item.seq,
                item.ts,
                item.body.kind_str(),
                data,
                search_text
            ],
        )?;
        Ok(())
    }

    /// Saves a text item that is still streaming: the stored text only, without
    /// re-deriving and re-indexing its search text on every flush. The row is marked
    /// unindexed (`idx_ver = -1`, so search doesn't report a backfill while an agent
    /// streams), and the final `put_item` (or the startup backfill, after a crash) indexes it.
    pub fn put_item_draft(&self, item: &TimelineItem) -> anyhow::Result<()> {
        let data = serde_json::to_string(item)?;
        self.conn.lock().execute(
            "INSERT INTO items (id, agent_id, seq, ts, kind, data, idx_ver)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, -1)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, idx_ver = -1",
            params![
                item.id,
                item.agent_id,
                item.seq,
                item.ts,
                item.body.kind_str(),
                data
            ],
        )?;
        Ok(())
    }

    /// Item rows to timeline items; rows this build can't parse become a notice
    /// saying so (keeping their place in the timeline) rather than vanishing.
    fn rows_to_items(
        agent_id: &str,
        rows: impl Iterator<Item = rusqlite::Result<(String, i64, i64, String)>>,
    ) -> anyhow::Result<Vec<TimelineItem>> {
        let mut out = Vec::new();
        let mut unreadable = 0usize;
        for row in rows {
            let (id, seq, ts, data) = row?;
            match serde_json::from_str::<TimelineItem>(&data) {
                Ok(mut item) => {
                    // Rows saved before launches were read from their result.
                    item.body.adopt_async_launch();
                    out.push(item);
                }
                Err(e) => {
                    unreadable += 1;
                    tracing::debug!("unreadable item {id}: {e}");
                    out.push(TimelineItem {
                        id,
                        agent_id: agent_id.to_string(),
                        seq,
                        ts,
                        body: ItemBody::Notice {
                            level: NoticeLevel::Warn,
                            text: UNREADABLE_ITEM_TEXT.into(),
                        },
                    });
                }
            }
        }
        if unreadable > 0 {
            tracing::warn!("agent {agent_id}: {unreadable} timeline item(s) couldn't be read");
        }
        Ok(out)
    }

    pub fn items(&self, agent_id: &str) -> anyhow::Result<Vec<TimelineItem>> {
        let conn = self.reader.lock();
        let mut stmt =
            conn.prepare("SELECT id, seq, ts, data FROM items WHERE agent_id = ?1 ORDER BY seq")?;
        let rows = stmt.query_map(params![agent_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
        Db::rows_to_items(agent_id, rows)
    }

    /// One agent's approvals and questions still waiting for an answer, oldest first,
    /// without parsing the rest of its timeline.
    pub fn pending_requests(&self, agent_id: &str) -> anyhow::Result<Vec<TimelineItem>> {
        let conn = self.reader.lock();
        // `resolution` is always serialized, so a pending row has `"resolution":null`.
        let mut stmt = conn.prepare(
            "SELECT data FROM items WHERE agent_id = ?1 AND kind IN ('permission', 'question')
             AND instr(data, '\"resolution\":null') > 0 ORDER BY seq",
        )?;
        let rows = stmt.query_map(params![agent_id], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(item) = serde_json::from_str::<TimelineItem>(&row?) {
                if matches!(
                    item.body,
                    crate::model::ItemBody::Permission {
                        resolution: None,
                        ..
                    } | crate::model::ItemBody::Question {
                        resolution: None,
                        ..
                    }
                ) {
                    out.push(item);
                }
            }
        }
        Ok(out)
    }

    /// The newest tool call of an agent with this tool-call id.
    pub fn tool_call(
        &self,
        agent_id: &str,
        tool_call_id: &str,
    ) -> anyhow::Result<Option<TimelineItem>> {
        let data: Option<String> = self
            .reader
            .lock()
            .query_row(
                "SELECT data FROM items WHERE agent_id = ?1 AND kind = 'tool_call'
                   AND json_extract(data, '$.toolCallId') = ?2 ORDER BY seq DESC LIMIT 1",
                params![agent_id, tool_call_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(data.and_then(|d| serde_json::from_str(&d).ok()))
    }

    /// The last `limit` items with `seq < before_seq` (all, when None), oldest first.
    pub fn items_page(
        &self,
        agent_id: &str,
        before_seq: Option<i64>,
        limit: usize,
    ) -> anyhow::Result<Vec<TimelineItem>> {
        let conn = self.reader.lock();
        let mut stmt = conn.prepare(
            "SELECT id, seq, ts, data FROM (
                 SELECT id, seq, ts, data FROM items
                 WHERE agent_id = ?1 AND seq < ?2
                 ORDER BY seq DESC LIMIT ?3
             ) ORDER BY seq",
        )?;
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows = stmt.query_map(
            params![agent_id, before_seq.unwrap_or(i64::MAX), limit],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        Db::rows_to_items(agent_id, rows)
    }

    /// Whether the agent's timeline has any message from the user.
    pub fn has_user_message(&self, agent_id: &str) -> anyhow::Result<bool> {
        Ok(self.reader.lock().query_row(
            "SELECT EXISTS(SELECT 1 FROM items WHERE agent_id = ?1 AND kind = 'user_message')",
            params![agent_id],
            |r| r.get(0),
        )?)
    }

    /// How many prompts the user has sent (not counting messages slipped in mid-turn):
    /// the turns an agent from before turn limits had already run.
    pub fn count_prompts(&self, agent_id: &str) -> anyhow::Result<i64> {
        Ok(self.reader.lock().query_row(
            "SELECT COUNT(*) FROM items WHERE agent_id = ?1 AND kind = 'user_message'
                 AND instr(data, '\"midTurn\":true') = 0",
            params![agent_id],
            |r| r.get(0),
        )?)
    }

    /// Whether `needle` occurs verbatim in any of the agent's stored items.
    pub fn items_contain(&self, agent_id: &str, needle: &str) -> anyhow::Result<bool> {
        if needle.is_empty() {
            return Ok(false);
        }
        Ok(self.reader.lock().query_row(
            "SELECT EXISTS(SELECT 1 FROM items WHERE agent_id = ?1 AND instr(data, ?2) > 0)",
            params![agent_id, needle],
            |r| r.get(0),
        )?)
    }

    /// Highest sequence number in the agent's timeline (0 when empty). Errors are
    /// returned, never mapped to 0: restarting at 0 would misorder the timeline.
    pub fn max_seq(&self, agent_id: &str) -> anyhow::Result<i64> {
        Ok(self.conn.lock().query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM items WHERE agent_id = ?1",
            params![agent_id],
            |r| r.get(0),
        )?)
    }

    /// Permission items still waiting for an answer (used to expire them after a restart).
    pub fn unresolved_permissions(&self) -> anyhow::Result<Vec<TimelineItem>> {
        let conn = self.conn.lock();
        // The kind index narrows it to approvals; the text check skips resolved ones (whose
        // diffs can be large) without parsing them. `resolution` is always serialized, so a
        // pending row always has `"resolution":null`.
        let mut stmt = conn.prepare(
            "SELECT data FROM items WHERE kind = 'permission'
             AND instr(data, '\"resolution\":null') > 0",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(item) = serde_json::from_str::<TimelineItem>(&row?) {
                if let crate::model::ItemBody::Permission {
                    resolution: None, ..
                } = &item.body
                {
                    out.push(item);
                }
            }
        }
        Ok(out)
    }

    /// Questions still waiting for an answer (served by items_pending_question).
    pub fn unresolved_questions(&self) -> anyhow::Result<Vec<TimelineItem>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT data FROM items WHERE kind = 'question'
             AND instr(data, '\"resolution\":null') > 0",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(item) = serde_json::from_str::<TimelineItem>(&row?) {
                if let crate::model::ItemBody::Question {
                    resolution: None, ..
                } = &item.body
                {
                    out.push(item);
                }
            }
        }
        Ok(out)
    }

    // ---- schedules ----

    pub fn schedules(&self) -> anyhow::Result<Vec<Schedule>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT data FROM schedules")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            match serde_json::from_str(&row?) {
                Ok(s) => out.push(s),
                Err(e) => tracing::warn!("skipping unreadable schedule row: {e}"),
            }
        }
        Ok(out)
    }

    #[cfg(test)]
    pub fn put_schedule(&self, schedule: &Schedule) -> anyhow::Result<()> {
        self.conn.lock().execute(
            "INSERT INTO schedules (id, data) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![schedule.id, serde_json::to_string(schedule)?],
        )?;
        Ok(())
    }

    /// Saves an edited schedule but keeps the run record (`last_run_at`, `last_agent_id`)
    /// as stored right now, so a run finishing meanwhile isn't undone by the edit.
    pub fn put_schedule_keeping_run(&self, schedule: &mut Schedule) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        let stored: Option<String> = conn
            .query_row(
                "SELECT data FROM schedules WHERE id = ?1",
                params![schedule.id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(prev) = stored.and_then(|d| serde_json::from_str::<Schedule>(&d).ok()) {
            schedule.last_run_at = prev.last_run_at;
            schedule.last_agent_id = prev.last_agent_id;
        }
        conn.execute(
            "INSERT INTO schedules (id, data) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![schedule.id, serde_json::to_string(schedule)?],
        )?;
        Ok(())
    }

    /// Changes the stored schedule in one step (read, `change`, write under the same
    /// lock), so a run's bookkeeping never overwrites an edit made in the meantime.
    /// None if the schedule is gone (it is not brought back).
    pub fn update_schedule(
        &self,
        id: &str,
        change: impl FnOnce(&mut Schedule),
    ) -> anyhow::Result<Option<Schedule>> {
        let conn = self.conn.lock();
        let stored: Option<String> = conn
            .query_row(
                "SELECT data FROM schedules WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(mut schedule) = stored.and_then(|d| serde_json::from_str::<Schedule>(&d).ok())
        else {
            return Ok(None);
        };
        change(&mut schedule);
        conn.execute(
            "UPDATE schedules SET data = ?2 WHERE id = ?1",
            params![id, serde_json::to_string(&schedule)?],
        )?;
        Ok(Some(schedule))
    }

    pub fn delete_schedule(&self, id: &str) -> anyhow::Result<()> {
        self.conn
            .lock()
            .execute("DELETE FROM schedules WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---- settings ----

    /// The stored settings. A field that can't be read (wrong type, a value from a
    /// newer Kvistcode) falls back to its default on its own instead of resetting
    /// everything; the original text is kept in `settings-unreadable-<hash>.json`.
    pub fn settings(&self) -> anyhow::Result<Settings> {
        let data: Option<String> = self
            .conn
            .lock()
            .query_row("SELECT data FROM settings WHERE id = 1", [], |r| r.get(0))
            .optional()?;
        let Some(data) = data else {
            return Ok(Settings::default());
        };
        let (mut settings, mut dropped) = match serde_json::from_str::<Value>(&data) {
            Ok(v) => from_value_lenient::<Settings>(&v),
            Err(e) => (Settings::default(), vec![format!("(not JSON: {e})")]),
        };
        // Secrets live in the OS keychain; bring plaintext left by older versions (or a
        // keychain outage) into it now.
        if crate::secrets::resolve(&mut settings, crate::secrets::vault()) {
            if let Err(e) = self.put_settings(&settings) {
                tracing::warn!("couldn't move secrets to the keychain: {e:#}");
            }
        }
        dropped.extend(settings.sanitize().into_iter().map(str::to_string));
        if !dropped.is_empty() {
            // Keep the user's data recoverable, once per distinct content (not on
            // every launch while the bad value is still stored).
            use sha2::{Digest, Sha256};
            let hash = crate::toolchain::hex_lower(&Sha256::digest(data.as_bytes()));
            let backup = self
                .dir
                .join(format!("settings-unreadable-{}.json", &hash[..12]));
            tracing::warn!(
                "some settings couldn't be read and use their defaults: {}; the original is in {}",
                dropped.join(", "),
                backup.display()
            );
            if !backup.exists() {
                if let Err(e) = write_private(&backup, data.as_bytes()) {
                    tracing::error!("saving {}: {e}", backup.display());
                }
            }
        }
        Ok(settings)
    }

    pub fn put_settings(&self, settings: &Settings) -> anyhow::Result<()> {
        let settings = &crate::secrets::externalize(settings, crate::secrets::vault());
        self.conn.lock().execute(
            "INSERT INTO settings (id, data) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![serde_json::to_string(settings)?],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::McpTransport;

    fn temp(name: &str) -> PathBuf {
        let dir = crate::testutil::scratch(&format!("db-{name}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn one_bad_setting_keeps_the_rest() {
        let stored = serde_json::json!({
            "onboarded": true,
            "theme": 42,
            "failover": "auto",
            "sounds": { "enabled": false, "volume": "loud" },
            "templates": [
                { "id": "a", "name": "A", "body": "x" },
                "garbage",
                { "id": "b" }
            ],
            "mcpServers": [{ "id": "m", "transport": "sse", "url": "https://x" }],
            "remote": { "port": 70000 },
            "fromTheFuture": { "x": 1 }
        });
        let (s, dropped) = from_value_lenient::<Settings>(&stored);
        assert!(s.onboarded);
        assert_eq!(s.failover, "auto");
        assert_eq!(s.theme, Settings::default().theme);
        assert!(!s.sounds.enabled, "sibling fields of a bad one survive");
        assert_eq!(s.sounds.volume, SoundSettings::default().volume);
        let ids: Vec<&str> = s.templates.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]);
        assert_eq!(s.mcp_servers.len(), 1);
        assert_eq!(s.mcp_servers[0].transport, McpTransport::Http);
        assert_eq!(s.remote.port, RemoteSettings::default().port);
        assert!(dropped.contains(&"theme".to_string()), "{dropped:?}");
        assert!(dropped.contains(&"templates[1]".to_string()), "{dropped:?}");
        assert!(dropped.contains(&"remote.port".to_string()), "{dropped:?}");
    }

    use crate::model::{RemoteSettings, SoundSettings};

    fn sample_schedule() -> Schedule {
        serde_json::from_value(serde_json::json!({
            "id": "s1", "name": "Nightly", "enabled": true, "provider": "claude",
            "accountId": "a", "projectPath": "/p", "prompt": "old", "worktree": false,
            "time": "03:00", "days": [], "lastRunAt": null, "lastAgentId": null
        }))
        .unwrap()
    }

    #[test]
    fn a_runs_bookkeeping_does_not_overwrite_a_newer_edit() {
        let dir = temp("schedule-stale");
        let db = Db::open(&dir.join("armada.db")).unwrap();
        db.put_schedule(&sample_schedule()).unwrap();
        // The run read the schedule, then the user edited it while the agent started.
        let mut edited = sample_schedule();
        edited.prompt = "new".into();
        edited.enabled = false;
        db.put_schedule_keeping_run(&mut edited).unwrap();
        let after_start = db
            .update_schedule("s1", |s| s.last_agent_id = Some("agent".into()))
            .unwrap()
            .unwrap();
        assert_eq!(after_start.prompt, "new");
        assert!(!after_start.enabled);
        let stored = db.schedules().unwrap().remove(0);
        assert_eq!(stored.prompt, "new");
        assert_eq!(stored.last_agent_id.as_deref(), Some("agent"));
    }

    #[test]
    fn an_edit_keeps_the_stored_run_record_and_a_deleted_schedule_stays_deleted() {
        let dir = temp("schedule-edit");
        let db = Db::open(&dir.join("armada.db")).unwrap();
        db.put_schedule(&sample_schedule()).unwrap();
        db.update_schedule("s1", |s| {
            s.last_run_at = Some(123);
            s.last_agent_id = Some("agent".into());
        })
        .unwrap();
        // An edit built from an older read has no run record; the stored one survives.
        let mut edited = sample_schedule();
        edited.name = "Renamed".into();
        db.put_schedule_keeping_run(&mut edited).unwrap();
        assert_eq!(edited.last_run_at, Some(123));
        let stored = db.schedules().unwrap().remove(0);
        assert_eq!(
            (
                stored.name.as_str(),
                stored.last_run_at,
                stored.last_agent_id.as_deref()
            ),
            ("Renamed", Some(123), Some("agent"))
        );
        db.delete_schedule("s1").unwrap();
        assert!(db
            .update_schedule("s1", |s| s.last_run_at = Some(5))
            .unwrap()
            .is_none());
        assert!(db.schedules().unwrap().is_empty(), "not brought back");
    }

    #[test]
    fn settings_backup_written_once() {
        let dir = temp("settings");
        let db = Db::open(&dir.join("armada.db")).unwrap();
        db.conn
            .lock()
            .execute(
                "INSERT INTO settings (id, data) VALUES (1, ?1)",
                params![r#"{"onboarded":true,"theme":7}"#],
            )
            .unwrap();
        for _ in 0..3 {
            assert!(db.settings().unwrap().onboarded);
        }
        let backups = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("settings-unreadable-")
            })
            .count();
        assert_eq!(backups, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn settings_backup_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp("settings-private");
        let db = Db::open(&dir.join("armada.db")).unwrap();
        db.conn
            .lock()
            .execute(
                "INSERT INTO settings (id, data) VALUES (1, ?1)",
                params![r#"{"onboarded":true,"theme":7,"apiKey":"sk-secret"}"#],
            )
            .unwrap();
        db.settings().unwrap();
        let backup = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .find(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("settings-unreadable-")
            })
            .expect("a backup")
            .path();
        let mode = std::fs::metadata(&backup).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_database_is_moved_aside() {
        let dir = temp("corrupt");
        let path = dir.join("armada.db");
        std::fs::write(&path, vec![0x42u8; 8192]).unwrap();
        let db = Db::open(&path).unwrap();
        assert!(db.accounts().unwrap().is_empty());
        let moved = std::fs::read_dir(&dir).unwrap().flatten().any(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("armada.db.corrupt-")
        });
        assert!(moved);
        let version: i64 = db
            .conn
            .lock()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prompts_are_counted_without_mid_turn_messages() {
        let dir = temp("prompts");
        let db = Db::open(&dir.join("armada.db")).unwrap();
        let user = |seq: i64, agent: &str, mid_turn: bool| TimelineItem {
            id: format!("{agent}{seq}"),
            agent_id: agent.into(),
            seq,
            ts: seq,
            body: ItemBody::UserMessage {
                text: format!("m{seq}"),
                attachments: Vec::new(),
                mid_turn,
                automatic: false,
            },
        };
        for (seq, mid) in [(1, false), (2, true), (3, false), (4, false)] {
            db.put_item(&user(seq, "a", mid)).unwrap();
        }
        db.put_item(&user(1, "b", false)).unwrap();
        db.put_item(&TimelineItem {
            id: "reply".into(),
            agent_id: "a".into(),
            seq: 5,
            ts: 5,
            body: ItemBody::AgentMessage {
                text: "hi".into(),
                images: Vec::new(),
            },
        })
        .unwrap();
        assert_eq!(db.count_prompts("a").unwrap(), 3);
        assert_eq!(db.count_prompts("b").unwrap(), 1);
        assert_eq!(db.count_prompts("none").unwrap(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tool_call_is_found_by_agent_and_tool_call_id() {
        let dir = temp("toolcall");
        let db = Db::open(&dir.join("armada.db")).unwrap();
        let call = |agent: &str, tool: &str, seq: i64| TimelineItem {
            id: format!("{agent}-{tool}"),
            agent_id: agent.into(),
            seq,
            ts: seq,
            body: ItemBody::ToolCall {
                tool_call_id: tool.into(),
                title: "Workflow".into(),
                tool_kind: crate::model::ToolKind::Other,
                status: crate::model::ToolStatus::Completed,
                locations: vec![],
                diffs: vec![],
                output: String::new(),
                command: None,
                images: vec![],
                subagent: None,
                parent_tool_call_id: None,
            },
        };
        db.put_item(&call("a", "t1", 1)).unwrap();
        db.put_item(&call("b", "t1", 2)).unwrap();
        let hit = db.tool_call("a", "t1").unwrap().unwrap();
        assert_eq!(hit.id, "a-t1");
        assert!(db.tool_call("a", "nope").unwrap().is_none());
        assert!(db.tool_call("c", "t1").unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_items_become_notices_and_pages_work() {
        let dir = temp("items");
        let db = Db::open(&dir.join("armada.db")).unwrap();
        for seq in 1..=5 {
            db.put_item(&TimelineItem {
                id: format!("i{seq}"),
                agent_id: "a".into(),
                seq,
                ts: seq,
                body: ItemBody::AgentMessage {
                    text: format!("m{seq}"),
                    images: Vec::new(),
                },
            })
            .unwrap();
        }
        db.conn
            .lock()
            .execute(
                "UPDATE items SET data = '{\"kind\":\"hologram\"}' WHERE id = 'i3'",
                [],
            )
            .unwrap();
        let all = db.items("a").unwrap();
        assert_eq!(all.len(), 5);
        assert!(
            matches!(&all[2].body, ItemBody::Notice { text, .. } if text == UNREADABLE_ITEM_TEXT)
        );
        assert_eq!(all[2].seq, 3);

        let page = db.items_page("a", None, 2).unwrap();
        assert_eq!(page.iter().map(|i| i.seq).collect::<Vec<_>>(), vec![4, 5]);
        let page = db.items_page("a", Some(4), 2).unwrap();
        assert_eq!(page.iter().map(|i| i.seq).collect::<Vec<_>>(), vec![2, 3]);
        assert!(db.items_page("a", Some(1), 10).unwrap().is_empty());

        assert_eq!(db.max_seq("a").unwrap(), 5);
        assert!(db.items_contain("a", "m4").unwrap());
        db.delete_agent("a").unwrap();
        assert!(db.items("a").unwrap().is_empty());
        assert_eq!(db.max_seq("a").unwrap(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_old_async_launch_loads_as_a_background_sub_agent() {
        let dir = temp("async-launch");
        let db = Db::open(&dir.join("armada.db")).unwrap();
        db.put_item(&TimelineItem {
            id: "t1".into(),
            agent_id: "a".into(),
            seq: 1,
            ts: 1,
            body: ItemBody::ToolCall {
                tool_call_id: "toolu_1".into(),
                title: "Agent".into(),
                tool_kind: crate::model::ToolKind::Think,
                status: crate::model::ToolStatus::Completed,
                locations: Vec::new(),
                diffs: Vec::new(),
                output: "Async agent launched successfully. (internal metadata)".into(),
                command: None,
                images: Vec::new(),
                subagent: Some(crate::model::SubAgent {
                    kind: Some("godot-engineer".into()),
                    ..Default::default()
                }),
                parent_tool_call_id: None,
            },
        })
        .unwrap();
        let items = db.items("a").unwrap();
        assert!(matches!(
            &items[0].body,
            ItemBody::ToolCall { subagent: Some(sa), .. } if sa.background
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
