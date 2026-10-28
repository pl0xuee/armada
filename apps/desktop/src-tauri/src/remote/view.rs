//! What a read-only share link may see of an agent's timeline.
//!
//! A viewer gets the conversation (user and assistant messages, secrets redacted)
//! and a one-line outline of tool calls (kind, status and a redacted title with
//! project-relative paths). It never gets tool or command output, diffs, file
//! locations or contents, images, thoughts, plans, notices or permission requests
//! (whose raw input can hold anything the agent was about to run).

use armada_core::redact::redact_secrets;
use armada_core::{ItemBody, TimelineItem};

/// Rewrites absolute paths in `text`: paths under one of `roots` become
/// project-relative, any other absolute path (or `~/…`) is reduced to its file name.
pub fn shorten_paths(text: &str, roots: &[String]) -> String {
    let mut roots: Vec<String> = roots
        .iter()
        .map(|r| r.trim_end_matches(['/', '\\']).to_string())
        .filter(|r| r.len() > 1)
        .collect();
    roots.sort_by_key(|r| std::cmp::Reverse(r.len()));
    roots.dedup();
    let mut text = text.to_string();
    for root in &roots {
        text = text.replace(&format!("{root}/"), "");
        text = text.replace(&format!("{root}\\"), "");
        text = text.replace(root.as_str(), ".");
    }
    let mut out = String::with_capacity(text.len());
    for word in text.split_inclusive(char::is_whitespace) {
        out.push_str(&shorten_word(word));
    }
    out
}

fn shorten_word(word: &str) -> String {
    const LEAD: &[char] = &['"', '\'', '`', '(', '[', '=', '<'];
    const TRAIL: &[char] = &['"', '\'', '`', ')', ']', ',', ';', ':', '>', '.'];
    let body = word.trim_end_matches(char::is_whitespace);
    let tail_ws = &word[body.len()..];
    let lead_len = body.len() - body.trim_start_matches(LEAD).len();
    let (lead, rest) = body.split_at(lead_len);
    let core = rest.trim_end_matches(TRAIL);
    let trail = &rest[core.len()..];
    let windows = {
        let b = core.as_bytes();
        b.len() > 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
    };
    let absolute =
        (core.starts_with('/') && core[1..].contains('/')) || core.starts_with("~/") || windows;
    if !absolute {
        return word.to_string();
    }
    let name = core
        .rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or(core);
    format!("{lead}{name}{trail}{tail_ws}")
}

/// A tool call's title as a viewer sees it.
pub fn viewer_title(title: &str, roots: &[String]) -> String {
    redact_secrets(&shorten_paths(title, roots)).into_owned()
}

/// The viewer's version of a timeline item, or None when viewers don't get it.
pub fn project_item(item: &TimelineItem, roots: &[String]) -> Option<TimelineItem> {
    let body = match &item.body {
        ItemBody::UserMessage { text, .. } => ItemBody::UserMessage {
            text: redact_secrets(text).into_owned(),
            attachments: Vec::new(),
        },
        ItemBody::AgentMessage { text } => ItemBody::AgentMessage {
            text: redact_secrets(text).into_owned(),
        },
        ItemBody::ToolCall {
            tool_call_id,
            title,
            tool_kind,
            status,
            parent_tool_call_id,
            ..
        } => ItemBody::ToolCall {
            tool_call_id: tool_call_id.clone(),
            title: viewer_title(title, roots),
            tool_kind: *tool_kind,
            status: *status,
            locations: Vec::new(),
            diffs: Vec::new(),
            output: String::new(),
            command: None,
            images: Vec::new(),
            subagent: None,
            parent_tool_call_id: parent_tool_call_id.clone(),
        },
        ItemBody::TurnSummary {
            duration_ms,
            tool_calls,
            commands,
            cost_usd,
            tokens,
            ..
        } => ItemBody::TurnSummary {
            duration_ms: *duration_ms,
            files: Vec::new(),
            tool_calls: *tool_calls,
            commands: *commands,
            cost_usd: *cost_usd,
            tokens: *tokens,
        },
        ItemBody::Thought { .. }
        | ItemBody::Permission { .. }
        | ItemBody::Plan { .. }
        | ItemBody::Notice { .. } => return None,
    };
    Some(TimelineItem {
        id: item.id.clone(),
        agent_id: item.agent_id.clone(),
        seq: item.seq,
        ts: item.ts,
        body,
    })
}

/// The viewer's version of a whole timeline.
pub fn project_items(items: &[TimelineItem], roots: &[String]) -> Vec<TimelineItem> {
    items
        .iter()
        .filter_map(|i| project_item(i, roots))
        .collect()
}

/// The viewer's version of a live event (as serialized JSON), or None when viewers
/// don't get it. Streamed text deltas are never forwarded (they can't be redacted
/// piecemeal and may belong to thoughts or tool output); the full item follows.
pub fn project_event(json: &str, roots: &[String]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    match v["type"].as_str()? {
        "item_upserted" => {
            let item: TimelineItem = serde_json::from_value(v["item"].clone()).ok()?;
            let projected = project_item(&item, roots)?;
            Some(serde_json::json!({ "type": "item_upserted", "item": projected }).to_string())
        }
        "attention" => Some(
            serde_json::json!({
                "type": "attention",
                "agentId": v["agentId"],
                "reason": v["reason"],
                "title": viewer_title(v["title"].as_str().unwrap_or(""), roots),
                "body": "",
                "requestId": null,
            })
            .to_string(),
        ),
        _ => None,
    }
}

/// Whether a viewer-visible message or tool title mentions `path` (or its
/// project-relative form), so `/image` only serves what the viewer was shown.
pub fn mentions_path(visible: &[TimelineItem], path: &str, relative: Option<&str>) -> bool {
    let path = path.trim();
    if path.is_empty() {
        return false;
    }
    visible.iter().any(|i| {
        let text = match &i.body {
            ItemBody::UserMessage { text, .. } | ItemBody::AgentMessage { text } => text,
            ItemBody::ToolCall { title, .. } => title,
            _ => return false,
        };
        text.contains(path) || relative.is_some_and(|r| !r.is_empty() && text.contains(r))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use armada_core::{FileDiff, ToolKind, ToolStatus};

    fn item(body: ItemBody) -> TimelineItem {
        TimelineItem {
            id: "i".into(),
            agent_id: "a".into(),
            seq: 1,
            ts: 1,
            body,
        }
    }

    fn roots() -> Vec<String> {
        vec!["/home/me/proj".into(), "/home/me/proj-wt/feature".into()]
    }

    #[test]
    fn paths_become_project_relative_or_file_names() {
        let r = roots();
        assert_eq!(
            shorten_paths("Read /home/me/proj/src/main.rs", &r),
            "Read src/main.rs"
        );
        assert_eq!(
            shorten_paths("Edit `/home/me/proj-wt/feature/a/b.ts`", &r),
            "Edit `a/b.ts`"
        );
        assert_eq!(
            shorten_paths("cat /etc/ssh/sshd_config; ls ~/.ssh/id_rsa", &r),
            "cat sshd_config; ls id_rsa"
        );
        assert_eq!(shorten_paths("cd /home/me/proj", &r), "cd .");
        assert_eq!(
            shorten_paths("open C:\\Users\\me\\secret.txt", &r),
            "open secret.txt"
        );
        assert_eq!(
            shorten_paths("Search for a/b and 1/2", &r),
            "Search for a/b and 1/2"
        );
    }

    #[test]
    fn viewers_get_messages_but_no_tool_output_paths_or_secrets() {
        let r = roots();
        let tool = item(ItemBody::ToolCall {
            tool_call_id: "t".into(),
            title: "Run `curl -H 'Authorization: Bearer abcdefghijklmnopqrstuv' /home/me/proj/x`"
                .into(),
            tool_kind: ToolKind::Execute,
            status: ToolStatus::Completed,
            locations: vec!["/home/me/proj/secret.env".into()],
            diffs: vec![FileDiff {
                path: "/home/me/proj/a".into(),
                old_text: Some("old".into()),
                new_text: Some("new".into()),
                unified: None,
            }],
            output: "PASSWORD=hunter2 and the file contents".into(),
            command: Some("cat /home/me/.ssh/id_rsa".into()),
            images: vec![],
            subagent: None,
            parent_tool_call_id: None,
        });
        let projected = project_item(&tool, &r).unwrap();
        let json = serde_json::to_string(&projected).unwrap();
        for leaked in [
            "hunter2",
            "id_rsa",
            "/home/me",
            "abcdefghijklmnopqrstuv",
            "new\"",
        ] {
            assert!(!json.contains(leaked), "{leaked} leaked: {json}");
        }
        assert!(json.contains("Run `curl"));
        assert!(json.contains(r#""output":"""#));

        let said = item(ItemBody::AgentMessage {
            text: ["I set API_KEY=s", "k-abcdefghijklmnopqrstuv for you"].concat(),
        });
        let json = serde_json::to_string(&project_item(&said, &r).unwrap()).unwrap();
        assert!(!json.contains("sk-abc") && json.contains("[REDACTED]"));
        let user = item(ItemBody::UserMessage {
            text: "hello".into(),
            attachments: vec![],
        });
        assert!(project_item(&user, &r).is_some());
    }

    #[test]
    fn viewers_never_get_thoughts_permissions_plans_or_notices() {
        let r = roots();
        let dropped = [
            ItemBody::Thought { text: "x".into() },
            ItemBody::Permission {
                request_id: "r".into(),
                title: "Run rm -rf".into(),
                tool_kind: None,
                command: Some("rm -rf /".into()),
                diffs: vec![],
                options: vec![],
                resolution: None,
            },
            ItemBody::Plan { entries: vec![] },
            ItemBody::Notice {
                level: armada_core::NoticeLevel::Info,
                text: "/home/me/proj failed".into(),
            },
        ];
        for body in dropped {
            assert!(project_item(&item(body), &r).is_none());
        }
        let summary = item(ItemBody::TurnSummary {
            duration_ms: 5,
            files: vec!["/home/me/proj/a.rs".into()],
            tool_calls: 1,
            commands: 0,
            cost_usd: 0.0,
            tokens: 3,
        });
        let json = serde_json::to_string(&project_item(&summary, &r).unwrap()).unwrap();
        assert!(json.contains(r#""files":[]"#));
    }

    #[test]
    fn live_events_are_projected_for_viewers() {
        let r = roots();
        let tool = serde_json::json!({
            "type": "item_upserted",
            "item": {
                "id": "i", "agentId": "a", "seq": 1, "ts": 1,
                "kind": "tool_call", "toolCallId": "t", "title": "Run ls /home/me/proj/src",
                "toolKind": "execute", "status": "completed", "locations": ["/home/me/proj/x"],
                "diffs": [], "output": "TOKEN=abcdef1234", "command": "ls"
            }
        })
        .to_string();
        let out = project_event(&tool, &r).unwrap();
        assert!(
            !out.contains("abcdef1234") && !out.contains("/home/me"),
            "{out}"
        );
        assert!(out.contains("Run ls src"));
        let delta = r#"{"type":"text_delta","agentId":"a","itemId":"i","field":"output","delta":"secret","offset":0}"#;
        assert!(project_event(delta, &r).is_none());
        let perm = r#"{"type":"item_upserted","item":{"id":"p","agentId":"a","seq":2,"ts":1,"kind":"permission","requestId":"r","title":"rm -rf /","toolKind":null,"command":"rm -rf /","diffs":[],"options":[],"resolution":null}}"#;
        assert!(project_event(perm, &r).is_none());
        let attn = r#"{"type":"attention","agentId":"a","reason":"permission","title":"Needs approval","body":"rm -rf /home/me/proj","requestId":"r"}"#;
        let out = project_event(attn, &r).unwrap();
        assert!(!out.contains("rm -rf") && out.contains("Needs approval"));
    }

    #[test]
    fn image_paths_must_appear_in_what_the_viewer_sees() {
        let r = roots();
        let items = vec![
            item(ItemBody::AgentMessage {
                text: "Saved shots/home.png".into(),
            }),
            item(ItemBody::ToolCall {
                tool_call_id: "t".into(),
                title: "Read /home/me/proj/hidden.png".into(),
                tool_kind: ToolKind::Read,
                status: ToolStatus::Completed,
                locations: vec!["/home/me/proj/private.png".into()],
                diffs: vec![],
                output: "see private.png".into(),
                command: None,
                images: vec![],
                subagent: None,
                parent_tool_call_id: None,
            }),
        ];
        let visible = project_items(&items, &r);
        assert!(mentions_path(&visible, "shots/home.png", None));
        assert!(mentions_path(
            &visible,
            "/home/me/proj/shots/home.png",
            Some("shots/home.png")
        ));
        assert!(mentions_path(&visible, "hidden.png", None));
        assert!(!mentions_path(&visible, "private.png", None));
        assert!(!mentions_path(&visible, "", None));
    }
}
