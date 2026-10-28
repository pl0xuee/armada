//! SQLite storage. Rows hold JSON blobs of the model types so the schema can
//! evolve without migrations for every new field.

use std::path::Path;

use anyhow::Context;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};

use crate::model::{Account, Agent, Schedule, SearchHit, Settings, TimelineItem};

pub struct Db {
    conn: Mutex<Connection>,
    dir: std::path::PathBuf,
}

const SCHEMA: &str = r#"
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
CREATE TABLE IF NOT EXISTS schedules (
    id   TEXT PRIMARY KEY,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    id   INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL
);
"#;

fn search_text(item: &TimelineItem) -> String {
    use crate::model::ItemBody::*;
    let s = match &item.body {
        UserMessage { text, .. } | AgentMessage { text } => text.clone(),
        ToolCall { title, command, .. } => {
            format!("{title} {}", command.as_deref().unwrap_or(""))
        }
        Permission { title, .. } => title.clone(),
        Notice { text, .. } => text.clone(),
        Thought { .. } | Plan { .. } => String::new(),
    };
    s.to_lowercase()
}

impl Db {
    pub fn open(path: &Path) -> anyhow::Result<Db> {
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        conn.execute_batch(SCHEMA)?;
        Ok(Db {
            conn: Mutex::new(conn),
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

    pub fn put_account(&self, account: &Account) -> anyhow::Result<()> {
        self.conn.lock().execute(
            "INSERT INTO accounts (id, data) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![account.id, serde_json::to_string(account)?],
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
        let conn = self.conn.lock();
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
        self.conn.lock().execute(
            "INSERT INTO agents (id, data) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![agent.id, serde_json::to_string(agent)?],
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

    pub fn delete_agent(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM items WHERE agent_id = ?1", params![id])?;
        conn.execute("DELETE FROM agents WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---- items ----

    pub fn put_item(&self, item: &TimelineItem) -> anyhow::Result<()> {
        self.conn.lock().execute(
            "INSERT INTO items (id, agent_id, seq, ts, kind, data, search_text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, search_text = excluded.search_text",
            params![
                item.id,
                item.agent_id,
                item.seq,
                item.ts,
                item.body.kind_str(),
                serde_json::to_string(item)?,
                search_text(item)
            ],
        )?;
        Ok(())
    }

    pub fn items(&self, agent_id: &str) -> anyhow::Result<Vec<TimelineItem>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT data FROM items WHERE agent_id = ?1 ORDER BY seq")?;
        let rows = stmt.query_map(params![agent_id], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(item) = serde_json::from_str(&row?) {
                out.push(item);
            }
        }
        Ok(out)
    }

    pub fn max_seq(&self, agent_id: &str) -> anyhow::Result<i64> {
        Ok(self
            .conn
            .lock()
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM items WHERE agent_id = ?1",
                params![agent_id],
                |r| r.get(0),
            )
            .unwrap_or(0))
    }

    /// Permission items still waiting for an answer (used to expire them after a restart).
    pub fn unresolved_permissions(&self) -> anyhow::Result<Vec<TimelineItem>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT data FROM items WHERE kind = 'permission'")?;
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

    pub fn search(&self, query: &str) -> anyhow::Result<Vec<SearchHit>> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let pattern = format!(
            "%{}%",
            q.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT agent_id, id, kind, search_text, ts FROM items
             WHERE search_text LIKE ?1 ESCAPE '\\' ORDER BY ts DESC LIMIT 50",
        )?;
        let rows = stmt.query_map(params![pattern], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (agent_id, item_id, kind, text, ts) = row?;
            out.push(SearchHit {
                agent_id,
                item_id,
                kind,
                snippet: snippet(&text, &q),
                ts,
            });
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

    pub fn put_schedule(&self, schedule: &Schedule) -> anyhow::Result<()> {
        self.conn.lock().execute(
            "INSERT INTO schedules (id, data) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![schedule.id, serde_json::to_string(schedule)?],
        )?;
        Ok(())
    }

    pub fn delete_schedule(&self, id: &str) -> anyhow::Result<()> {
        self.conn
            .lock()
            .execute("DELETE FROM schedules WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---- settings ----

    pub fn settings(&self) -> anyhow::Result<Settings> {
        let data: Option<String> = self
            .conn
            .lock()
            .query_row("SELECT data FROM settings WHERE id = 1", [], |r| r.get(0))
            .optional()?;
        let Some(data) = data else {
            return Ok(Settings::default());
        };
        match serde_json::from_str(&data) {
            Ok(settings) => Ok(settings),
            Err(e) => {
                // Keep the user's data recoverable instead of silently losing it.
                let backup = self.dir.join(format!(
                    "settings-unreadable-{}.json",
                    crate::model::now_ms()
                ));
                tracing::error!(
                    "settings couldn't be read ({e}); a copy was saved to {}",
                    backup.display()
                );
                let _ = std::fs::write(&backup, &data);
                Ok(Settings::default())
            }
        }
    }

    pub fn put_settings(&self, settings: &Settings) -> anyhow::Result<()> {
        self.conn.lock().execute(
            "INSERT INTO settings (id, data) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![serde_json::to_string(settings)?],
        )?;
        Ok(())
    }
}

fn snippet(text: &str, needle: &str) -> String {
    let Some(pos) = text.find(needle) else {
        return text.chars().take(140).collect();
    };
    let start = text[..pos]
        .char_indices()
        .rev()
        .nth(50)
        .map(|(i, _)| i)
        .unwrap_or(0);
    let s: String = text[start..].chars().take(160).collect();
    let s = s.replace('\n', " ");
    if start > 0 {
        format!("…{s}")
    } else {
        s
    }
}
