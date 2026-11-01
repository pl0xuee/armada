//! Full-text search over every agent's timeline (SQLite FTS5), local only.
//!
//! * `items.search_text` holds what is searchable about an item (messages, tool names
//!   and commands, file paths, plans, turn summaries); `items_fts` is its index.
//!   Triggers keep the index in step with every insert, update and delete, so new
//!   items are searchable the moment they are stored.
//! * Rows written before this existed (or by an older Armada) have `idx_ver = 0`.
//!   `Db::index_step` re-derives their text and indexes them in small batches from a
//!   background thread, so startup never waits for it.

use std::collections::HashMap;

use anyhow::Context;
use rusqlite::{params, Connection};

use super::Db;
use crate::model::{ItemBody, SearchGroup, SearchHit, SearchResults, TimelineItem};

/// Wrap matched words in snippets; control characters never occur in the text.
pub const MARK_START: char = '\u{1}';
pub const MARK_END: char = '\u{2}';

/// `idx_ver` of rows whose text is current.
const INDEX_VERSION: i64 = 1;

/// Longest text indexed for one item (a pasted log shouldn't bloat the index).
const MAX_TEXT_CHARS: usize = 20_000;

/// Most items looked at for one query.
pub const MAX_HITS: usize = 400;
/// Most matches shown per conversation.
pub const PER_AGENT: usize = 3;

/// Creates the index, its triggers and the `idx_ver` column (idempotent).
pub(super) fn ensure_index(conn: &Connection) -> anyhow::Result<()> {
    let has_version: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('items') WHERE name = 'idx_ver'")?
        .exists([])?;
    if !has_version {
        conn.execute_batch("ALTER TABLE items ADD COLUMN idx_ver INTEGER NOT NULL DEFAULT 0")?;
    }
    conn.execute_batch(&format!(
        r#"
CREATE INDEX IF NOT EXISTS items_unindexed ON items(idx_ver) WHERE idx_ver < {INDEX_VERSION};
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid, text) SELECT new.rowid, new.search_text WHERE new.search_text <> '';
END;
CREATE TRIGGER IF NOT EXISTS items_fts_au AFTER UPDATE OF search_text ON items
WHEN old.search_text IS NOT new.search_text BEGIN
    DELETE FROM items_fts WHERE rowid = old.rowid;
    INSERT INTO items_fts(rowid, text) SELECT new.rowid, new.search_text WHERE new.search_text <> '';
END;
CREATE TRIGGER IF NOT EXISTS items_fts_ad AFTER DELETE ON items BEGIN
    DELETE FROM items_fts WHERE rowid = old.rowid;
END;
"#
    ))
    .context("creating the search index")
}

/// What is searchable about an item. Private reasoning (`Thought`) and raw tool
/// output are left out: they are long, noisy and rarely what you are looking for.
pub(super) fn item_text(item: &TimelineItem) -> String {
    use ItemBody::*;
    let mut s = String::new();
    let mut add = |part: &str| {
        if !part.is_empty() {
            if !s.is_empty() {
                s.push(' ');
            }
            s.push_str(part);
        }
    };
    match &item.body {
        UserMessage { text, .. } | AgentMessage { text, .. } | Notice { text, .. } => add(text),
        ToolCall {
            title,
            command,
            locations,
            diffs,
            ..
        } => {
            add(title);
            add(command.as_deref().unwrap_or(""));
            locations.iter().for_each(|l| add(l));
            diffs.iter().for_each(|d| add(&d.path));
        }
        Permission {
            title,
            command,
            diffs,
            plan,
            ..
        } => {
            add(title);
            add(command.as_deref().unwrap_or(""));
            diffs.iter().for_each(|d| add(&d.path));
            add(plan.as_deref().unwrap_or(""));
        }
        Question {
            message, fields, ..
        } => {
            add(message);
            for f in fields {
                for part in [&f.title, &f.description].into_iter().flatten() {
                    add(part);
                }
            }
        }
        Plan { entries } => entries.iter().for_each(|e| add(&e.content)),
        TurnSummary { files, .. } => files.iter().for_each(|f| add(f)),
        Thought { .. } => {}
    }
    if s.chars().count() > MAX_TEXT_CHARS {
        s = s.chars().take(MAX_TEXT_CHARS).collect();
    }
    s
}

/// An FTS5 query for what the user typed: every word must appear (any order), the
/// last one as a prefix (search-as-you-type). Words are quoted, so no input is
/// ever query syntax. None when nothing searchable was typed.
pub fn match_query(input: &str) -> Option<String> {
    let words: Vec<&str> = input
        .split_whitespace()
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .take(12)
        .collect();
    let last = words.len().checked_sub(1)?;
    let parts: Vec<String> = words
        .iter()
        .enumerate()
        .map(|(i, w)| {
            let quoted = format!("\"{}\"", w.replace('"', "\"\""));
            if i == last {
                format!("{quoted}*")
            } else {
                quoted
            }
        })
        .collect();
    Some(parts.join(" AND "))
}

impl Db {
    /// Indexes up to `limit` rows that aren't yet. Returns how many it handled
    /// (0 = nothing left). Rows another thread rewrote meanwhile are skipped; they
    /// were indexed by that write.
    pub fn index_step(&self, limit: usize) -> anyhow::Result<usize> {
        let rows: Vec<(i64, String)> = {
            let conn = self.reader.lock();
            let mut stmt = conn.prepare(&format!(
                "SELECT rowid, data FROM items WHERE idx_ver < {INDEX_VERSION} LIMIT ?1"
            ))?;
            let rows = stmt.query_map(params![limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        if rows.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        {
            let mut update = tx.prepare(&format!(
                "UPDATE items SET search_text = ?1, idx_ver = {INDEX_VERSION}
                 WHERE rowid = ?2 AND idx_ver < {INDEX_VERSION}"
            ))?;
            for (rowid, data) in &rows {
                // A row this build can't read has nothing to index, but is still done.
                let text = serde_json::from_str::<TimelineItem>(data)
                    .map(|i| item_text(&i))
                    .unwrap_or_default();
                update.execute(params![text, rowid])?;
            }
        }
        tx.commit()?;
        Ok(rows.len())
    }

    /// Whether some rows still wait for `index_step`.
    pub fn has_unindexed(&self) -> bool {
        self.reader
            .lock()
            .query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM items WHERE idx_ver < {INDEX_VERSION})"),
                [],
                |r| r.get(0),
            )
            .unwrap_or(false)
    }

    /// Best matches first, over every agent (archived ones included).
    fn search_hits(&self, query: &str, limit: usize) -> anyhow::Result<Vec<SearchHit>> {
        let Some(q) = match_query(query) else {
            return Ok(Vec::new());
        };
        let conn = self.reader.lock();
        let mut stmt = conn.prepare(
            "SELECT i.agent_id, i.id, i.kind, i.ts, i.seq,
                    snippet(items_fts, 0, ?2, ?3, '…', 20)
             FROM items_fts JOIN items i ON i.rowid = items_fts.rowid
             WHERE items_fts MATCH ?1
             ORDER BY rank LIMIT ?4",
        )?;
        let rows = stmt.query_map(
            params![
                q,
                MARK_START.to_string(),
                MARK_END.to_string(),
                limit as i64
            ],
            |r| {
                Ok(SearchHit {
                    agent_id: r.get(0)?,
                    item_id: r.get(1)?,
                    kind: r.get(2)?,
                    ts: r.get(3)?,
                    seq: r.get(4)?,
                    snippet: one_line(&r.get::<_, String>(5)?),
                })
            },
        )?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// A flat list of matches, best first.
    pub fn search(&self, query: &str) -> anyhow::Result<Vec<SearchHit>> {
        self.search_hits(query, 50)
    }

    /// Matches grouped by conversation: the conversation with the best match first,
    /// each with its best few matches.
    pub fn search_grouped(&self, query: &str) -> anyhow::Result<SearchResults> {
        let hits = self.search_hits(query, MAX_HITS)?;
        let truncated = hits.len() >= MAX_HITS;
        let mut order: Vec<String> = Vec::new();
        let mut groups: HashMap<String, SearchGroup> = HashMap::new();
        for hit in hits {
            let group = groups.entry(hit.agent_id.clone()).or_insert_with(|| {
                order.push(hit.agent_id.clone());
                SearchGroup {
                    agent_id: hit.agent_id.clone(),
                    hits: Vec::new(),
                    total: 0,
                }
            });
            group.total += 1;
            if group.hits.len() < PER_AGENT {
                group.hits.push(hit);
            }
        }
        Ok(SearchResults {
            groups: order
                .into_iter()
                .filter_map(|id| groups.remove(&id))
                .collect(),
            indexing: self.has_unindexed(),
            truncated,
        })
    }
}

/// Line breaks and runs of blanks collapsed (snippets are shown on one line).
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
#[path = "search_tests.rs"]
mod tests;
