use super::*;
use crate::model::{FileDiff, PlanEntry, PlanStatus, ToolKind, ToolStatus};
use std::path::PathBuf;

fn temp(name: &str) -> PathBuf {
    let dir = crate::testutil::scratch(&format!("search-{name}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn open(name: &str) -> Db {
    Db::open(&temp(name).join("armada.db")).unwrap()
}

fn item(agent: &str, seq: i64, body: ItemBody) -> TimelineItem {
    TimelineItem {
        id: format!("{agent}-{seq}"),
        agent_id: agent.into(),
        seq,
        ts: 1_700_000_000_000 + seq,
        body,
    }
}

fn user(agent: &str, seq: i64, text: &str) -> TimelineItem {
    item(
        agent,
        seq,
        ItemBody::UserMessage {
            text: text.into(),
            attachments: vec![],
            mid_turn: false,
            automatic: false,
        },
    )
}

fn tool(agent: &str, seq: i64, title: &str, path: &str, output: &str) -> TimelineItem {
    item(
        agent,
        seq,
        ItemBody::ToolCall {
            tool_call_id: format!("t{seq}"),
            title: title.into(),
            tool_kind: ToolKind::Edit,
            status: ToolStatus::Completed,
            locations: vec![path.into()],
            diffs: vec![FileDiff {
                path: path.into(),
                old_text: None,
                new_text: None,
                unified: None,
            }],
            output: output.into(),
            command: None,
            images: vec![],
            subagent: None,
            parent_tool_call_id: None,
        },
    )
}

fn ids(hits: &[SearchHit]) -> Vec<&str> {
    hits.iter().map(|h| h.item_id.as_str()).collect()
}

#[test]
fn query_words_are_quoted_and_the_last_is_a_prefix() {
    assert_eq!(match_query("  "), None);
    assert_eq!(match_query("--- ***"), None);
    assert_eq!(match_query("fix").as_deref(), Some("\"fix\"*"));
    assert_eq!(
        match_query("fix auth").as_deref(),
        Some("\"fix\" AND \"auth\"*")
    );
    // Operators and quotes are plain text.
    assert_eq!(
        match_query("a OR \"b\" NEAR(c)").as_deref(),
        Some("\"a\" AND \"OR\" AND \"\"\"b\"\"\" AND \"NEAR(c)\"*")
    );
}

#[test]
fn odd_input_never_breaks_the_query() {
    let db = open("odd");
    db.put_item(&user("a", 1, "hello world")).unwrap();
    for q in [
        "\"",
        "AND",
        "a OR",
        "(",
        "NEAR(",
        "*",
        "col:x",
        "^hello",
        "hello -world",
    ] {
        assert!(db.search(q).is_ok(), "{q:?}");
    }
}

#[test]
fn new_items_are_searchable_at_once() {
    let db = open("live");
    db.put_item(&user("a1", 1, "Please fix the login redirect"))
        .unwrap();
    db.put_item(&tool(
        "a1",
        2,
        "Edit",
        "src/auth/session.ts",
        "secret output",
    ))
    .unwrap();
    db.put_item(&user("a2", 1, "Unrelated chat about lunch"))
        .unwrap();

    let hits = db.search("login redirect").unwrap();
    assert_eq!(ids(&hits), ["a1-1"]);
    assert!(hits[0].snippet.contains('\u{1}'), "{}", hits[0].snippet);
    assert_eq!(hits[0].seq, 1);
    // Prefix of the last word, and a file path (also by part).
    assert_eq!(ids(&db.search("redir").unwrap()), ["a1-1"]);
    assert_eq!(ids(&db.search("src/auth/session.ts").unwrap()), ["a1-2"]);
    assert_eq!(ids(&db.search("session.ts").unwrap()), ["a1-2"]);
    // Case doesn't matter.
    assert_eq!(ids(&db.search("LOGIN").unwrap()), ["a1-1"]);
    // Raw tool output isn't indexed.
    assert!(db.search("secret").unwrap().is_empty());
}

#[test]
fn plans_summaries_and_thoughts() {
    let db = open("kinds");
    db.put_item(&item(
        "a",
        1,
        ItemBody::Plan {
            entries: vec![PlanEntry {
                content: "Migrate the billing tables".into(),
                status: PlanStatus::Pending,
                priority: None,
            }],
        },
    ))
    .unwrap();
    db.put_item(&item(
        "a",
        2,
        ItemBody::TurnSummary {
            duration_ms: 1,
            files: vec!["crates/billing/lib.rs".into()],
            tool_calls: 1,
            commands: 0,
            cost_usd: 0.0,
            tokens: 0,
        },
    ))
    .unwrap();
    db.put_item(&item(
        "a",
        3,
        ItemBody::Thought {
            text: "private musings about zebras".into(),
        },
    ))
    .unwrap();
    assert_eq!(ids(&db.search("billing tables").unwrap()), ["a-1"]);
    assert_eq!(ids(&db.search("crates/billing").unwrap()), ["a-2"]);
    assert!(db.search("zebras").unwrap().is_empty());
}

#[test]
fn edits_and_deletes_keep_the_index_in_step() {
    let db = open("sync");
    db.put_item(&user("a", 1, "alpha beta")).unwrap();
    db.put_item(&user("a", 2, "gamma delta")).unwrap();
    // A streamed message is stored again with more text.
    db.put_item(&user("a", 1, "alpha epsilon")).unwrap();
    assert!(db.search("beta").unwrap().is_empty());
    assert_eq!(ids(&db.search("epsilon").unwrap()), ["a-1"]);
    assert_eq!(db.search("alpha").unwrap().len(), 1);
    db.delete_agent("a").unwrap();
    assert!(db.search("gamma").unwrap().is_empty());
    assert!(db.search("epsilon").unwrap().is_empty());
}

#[test]
fn results_group_by_agent_and_cap_each_group() {
    let db = open("group");
    for seq in 1..=5 {
        db.put_item(&user("busy", seq, &format!("deploy step {seq}")))
            .unwrap();
    }
    db.put_item(&user("quiet", 1, "deploy once")).unwrap();
    let r = db.search_grouped("deploy").unwrap();
    assert_eq!(r.groups.len(), 2);
    let busy = r.groups.iter().find(|g| g.agent_id == "busy").unwrap();
    assert_eq!((busy.hits.len(), busy.total), (PER_AGENT, 5));
    let quiet = r.groups.iter().find(|g| g.agent_id == "quiet").unwrap();
    assert_eq!((quiet.hits.len(), quiet.total), (1, 1));
    assert!(!r.indexing && !r.truncated);
    assert!(db.search_grouped("").unwrap().groups.is_empty());
}

#[test]
fn old_databases_are_indexed_in_the_background() {
    // A database from before search: no idx_ver column, no index, no search text.
    let path = temp("legacy").join("armada.db");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE items (
                id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, seq INTEGER NOT NULL,
                ts INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,
                search_text TEXT NOT NULL DEFAULT '');",
        )
        .unwrap();
        for it in [
            user("old", 1, "Refactor the payment webhook"),
            tool("old", 2, "Edit", "src/pay/hook.rs", ""),
        ] {
            conn.execute(
                "INSERT INTO items (id, agent_id, seq, ts, kind, data, search_text)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, '')",
                params![
                    it.id,
                    it.agent_id,
                    it.seq,
                    it.ts,
                    it.body.kind_str(),
                    serde_json::to_string(&it).unwrap()
                ],
            )
            .unwrap();
        }
    }
    let db = Db::open(&path).unwrap();
    // Opening didn't index anything: that happens off the startup path.
    assert!(db.has_unindexed());
    assert!(db.search("webhook").unwrap().is_empty());
    assert!(db.search_grouped("webhook").unwrap().indexing);
    // New writes during the backfill are searchable already.
    db.put_item(&user("new", 1, "A fresh webhook question"))
        .unwrap();
    assert_eq!(db.search("webhook").unwrap().len(), 1);

    assert_eq!(db.index_step(1).unwrap(), 1);
    assert_eq!(db.index_step(10).unwrap(), 1);
    assert_eq!(db.index_step(10).unwrap(), 0);
    assert!(!db.has_unindexed());
    assert_eq!(db.search("webhook").unwrap().len(), 2);
    assert_eq!(ids(&db.search("src/pay/hook.rs").unwrap()), ["old-2"]);
    // A second open leaves it alone.
    drop(db);
    let db = Db::open(&path).unwrap();
    assert!(!db.has_unindexed());
    assert_eq!(db.search("webhook").unwrap().len(), 2);
}

/// 15,000 items over 60 conversations: a search comes back well within a
/// keystroke's debounce even in an unoptimized build.
#[test]
fn stays_fast_with_many_items() {
    let db = open("bench");
    let words = [
        "parser", "cache", "retry", "socket", "config", "render", "schema", "deploy", "lint",
        "token",
    ];
    {
        let conn = db.conn.lock();
        let tx = conn.unchecked_transaction().unwrap();
        for n in 0..15_000i64 {
            let agent = format!("agent-{}", n % 60);
            let text = format!(
                "{} the {} and {} for ticket {n} in module {}",
                words[(n % 10) as usize],
                words[((n / 7) % 10) as usize],
                words[((n / 13) % 10) as usize],
                n % 97
            );
            let it = user(&agent, n, &text);
            tx.execute(
                "INSERT INTO items (id, agent_id, seq, ts, kind, data, search_text, idx_ver)
                 VALUES (?1, ?2, ?3, ?4, 'user_message', ?5, ?6, 1)",
                params![
                    it.id,
                    it.agent_id,
                    it.seq,
                    it.ts,
                    serde_json::to_string(&it).unwrap(),
                    item_text(&it)
                ],
            )
            .unwrap();
        }
        tx.commit().unwrap();
    }
    let started = std::time::Instant::now();
    let common = db.search_grouped("retry sock").unwrap();
    let common_took = started.elapsed();
    let rare = db.search_grouped("ticket 14999").unwrap();
    let both_took = started.elapsed();
    assert!(!common.groups.is_empty() && common.truncated);
    assert_eq!(rare.groups.len(), 1);
    assert!(
        common_took < std::time::Duration::from_millis(1500),
        "common query took {common_took:?}"
    );
    assert!(
        both_took < std::time::Duration::from_millis(3000),
        "both queries took {both_took:?}"
    );
}
