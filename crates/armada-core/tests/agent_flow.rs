//! End-to-end flow through `Core` against a mock ACP agent (no network, no tokens).

#![cfg(unix)]

use std::sync::Arc;
use std::time::Duration;

use armada_core::*;
use tokio::sync::mpsc;

struct Sink(mpsc::UnboundedSender<ArmadaEvent>);

impl EventSink for Sink {
    fn emit(&self, event: ArmadaEvent) {
        let _ = self.0.send(event);
    }
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("armada-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn next_matching(
    rx: &mut mpsc::UnboundedReceiver<ArmadaEvent>,
    mut f: impl FnMut(&ArmadaEvent) -> bool,
) -> ArmadaEvent {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let ev = rx.recv().await.expect("channel open");
            if f(&ev) {
                return ev;
            }
        }
    })
    .await
    .expect("timed out waiting for event")
}

#[tokio::test]
async fn prompt_permission_and_resume_flow() {
    let mock = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mock_acp.py");
    std::env::set_var("ARMADA_GROK_COMMAND", format!("python3 {mock}"));

    let data = temp_dir("data");
    let project = temp_dir("project");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let core = Core::open(data.clone(), Arc::new(Sink(tx))).unwrap();

    let account = core
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.provider == Provider::Grok && a.is_system)
        .expect("system grok account");

    let agent = core
        .create_agent(CreateAgentRequest {
            provider: Provider::Grok,
            account_id: account.id.clone(),
            project_path: project.to_string_lossy().into_owned(),
            prompt: "hello there".into(),
            title: None,
            worktree: true, // not a git repo: falls back to the folder itself
            model: None,
            group_id: None,
            custom_agent_id: None,
            permission_mode: None,
            attachments: vec![],
        })
        .await
        .unwrap();
    assert_eq!(agent.status, AgentStatus::Starting);
    assert_eq!(agent.title, "hello there");

    // Permission request arrives and raises attention.
    let ev = next_matching(&mut rx, |e| {
        matches!(e, ArmadaEvent::ItemUpserted { item } if matches!(item.body, ItemBody::Permission { resolution: None, .. }))
    })
    .await;
    let ArmadaEvent::ItemUpserted { item } = ev else {
        unreachable!()
    };
    let ItemBody::Permission {
        request_id,
        options,
        command,
        ..
    } = item.body
    else {
        unreachable!()
    };
    assert_eq!(command, None);
    assert_eq!(options.len(), 2);
    next_matching(&mut rx, |e| {
        matches!(
            e,
            ArmadaEvent::Attention {
                reason: AttentionReason::Permission,
                ..
            }
        )
    })
    .await;
    assert_eq!(
        core.agent(&agent.id).unwrap().status,
        AgentStatus::NeedsPermission
    );
    assert_eq!(core.agent(&agent.id).unwrap().pending_permissions, 1);

    core.respond_permission(&agent.id, &request_id, "yes")
        .await
        .unwrap();

    // Turn completes with a Done attention.
    let ev = next_matching(&mut rx, |e| {
        matches!(
            e,
            ArmadaEvent::Attention {
                reason: AttentionReason::Done,
                ..
            }
        )
    })
    .await;
    let ArmadaEvent::Attention { body, .. } = ev else {
        unreachable!()
    };
    assert_eq!(body, "You said: hello there");

    let a = core.agent(&agent.id).unwrap();
    assert_eq!(a.status, AgentStatus::Idle);
    assert_eq!(a.title, "Mock title");
    assert_eq!(a.session_id.as_deref(), Some("mock-session-1"));
    assert_eq!(a.tokens_used, 42);
    assert!((a.cost_usd - 0.0123).abs() < 1e-9);
    assert_eq!(a.context_used, Some(1200));
    assert_eq!(a.pending_permissions, 0);
    assert!(
        a.config_options
            .iter()
            .any(|o| o.id == "mode" && o.current_value == "auto"),
        "new agents start in Auto mode by default"
    );

    let items = core.items(&agent.id).unwrap();
    let kinds: Vec<&str> = items.iter().map(|i| i.body.kind_str()).collect();
    assert_eq!(
        kinds,
        [
            "user_message",
            "thought",
            "plan",
            "tool_call",
            "permission",
            "agent_message",
            "turn_summary"
        ]
    );
    // The "review" of what the turn did.
    match &items.last().unwrap().body {
        ItemBody::TurnSummary {
            tool_calls,
            commands,
            cost_usd,
            tokens,
            ..
        } => {
            assert_eq!((*tool_calls, *commands), (1, 1));
            assert!((cost_usd - 0.0123).abs() < 1e-9);
            assert_eq!(*tokens, 42);
        }
        other => panic!("expected a turn summary, got {other:?}"),
    }
    match &items[3].body {
        ItemBody::ToolCall {
            status,
            command,
            output,
            ..
        } => {
            assert_eq!(*status, ToolStatus::Completed);
            assert_eq!(command.as_deref(), Some("ls -la"));
            assert_eq!(output, "file.txt");
        }
        other => panic!("unexpected {other:?}"),
    }
    match &items[4].body {
        ItemBody::Permission { resolution, .. } => assert_eq!(resolution.as_deref(), Some("yes")),
        other => panic!("unexpected {other:?}"),
    }

    // Mode switch goes through session/set_mode.
    core.set_agent_config(&agent.id, "mode", "ask")
        .await
        .unwrap();
    assert!(core
        .agent(&agent.id)
        .unwrap()
        .config_options
        .iter()
        .any(|o| o.id == "mode" && o.current_value == "ask"));

    // Search finds the conversation.
    assert!(!core.search("hello there").unwrap().is_empty());

    // Simulate an app restart mid-turn: the agent comes back as interrupted.
    core.send_prompt(&agent.id, "second", vec![]).await.unwrap();
    next_matching(&mut rx, |e| {
        matches!(
            e,
            ArmadaEvent::Attention {
                reason: AttentionReason::Permission,
                ..
            }
        )
    })
    .await;
    core.shutdown().await;
    drop(core);

    let (tx2, mut rx2) = mpsc::unbounded_channel();
    let core = Core::open(data.clone(), Arc::new(Sink(tx2))).unwrap();
    let a = core.agent(&agent.id).unwrap();
    assert_eq!(a.status, AgentStatus::Interrupted);
    assert!(!a.running);
    // The approval that was pending can no longer be answered.
    assert!(core.items(&agent.id).unwrap().iter().all(|i| !matches!(
        i.body,
        ItemBody::Permission {
            resolution: None,
            ..
        }
    )));

    // Resume with auto-continue resumes the same session and runs a new turn.
    core.resume_agent(&agent.id, true).await.unwrap();
    let ev = next_matching(&mut rx2, |e| matches!(e, ArmadaEvent::ItemUpserted { item } if matches!(item.body, ItemBody::Permission { resolution: None, .. }))).await;
    let ArmadaEvent::ItemUpserted { item } = ev else {
        unreachable!()
    };
    let ItemBody::Permission { request_id, .. } = item.body else {
        unreachable!()
    };
    core.respond_permission(&agent.id, &request_id, "no")
        .await
        .unwrap();
    next_matching(&mut rx2, |e| {
        matches!(
            e,
            ArmadaEvent::Attention {
                reason: AttentionReason::Done,
                ..
            }
        )
    })
    .await;
    assert_eq!(
        core.agent(&agent.id).unwrap().session_id.as_deref(),
        Some("mock-session-1")
    );

    // Delete cleans everything up.
    core.delete_agent(&agent.id, true, false).await.unwrap();
    assert!(core.agent(&agent.id).is_err());
    assert!(core.items(&agent.id).unwrap().is_empty());
    core.shutdown().await;
}

#[test]
fn wire_format_matches_typescript_contract() {
    let item = TimelineItem {
        id: "i".into(),
        agent_id: "a".into(),
        seq: 1,
        ts: 2,
        body: ItemBody::ToolCall {
            tool_call_id: "t".into(),
            title: "x".into(),
            tool_kind: ToolKind::Execute,
            status: ToolStatus::InProgress,
            locations: vec![],
            diffs: vec![],
            output: String::new(),
            command: None,
            images: vec![],
            subagent: None,
            parent_tool_call_id: None,
        },
    };
    let v = serde_json::to_value(&item).unwrap();
    assert_eq!(v["kind"], "tool_call");
    assert_eq!(v["agentId"], "a");
    assert_eq!(v["toolCallId"], "t");
    assert_eq!(v["toolKind"], "execute");
    assert_eq!(v["status"], "in_progress");

    let ev = ArmadaEvent::Navigate {
        to: NavigateTarget::Agent {
            agent_id: "a".into(),
        },
    };
    let v = serde_json::to_value(&ev).unwrap();
    assert_eq!(v["type"], "navigate");
    assert_eq!(v["to"]["view"], "agent");
    assert_eq!(v["to"]["agentId"], "a");

    let ev = ArmadaEvent::TextDelta {
        agent_id: "a".into(),
        item_id: "i".into(),
        field: DeltaField::Output,
        delta: "d".into(),
        offset: 7,
    };
    let v = serde_json::to_value(&ev).unwrap();
    assert_eq!(v["type"], "text_delta");
    assert_eq!(v["itemId"], "i");
    assert_eq!(v["field"], "output");
    assert_eq!(v["offset"], 7);

    // Older settings rows missing new fields still load.
    let s: Settings = serde_json::from_str(r#"{"onboarded":true}"#).unwrap();
    assert!(s.onboarded);
    assert_eq!(s.theme, "gunmetal");
}

#[tokio::test]
async fn failover_mcp_commands_and_export() {
    let mock = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mock_acp.py");
    std::env::set_var("ARMADA_GROK_COMMAND", format!("python3 {mock}"));

    let data = temp_dir("data2");
    let project = temp_dir("project2");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let core = Core::open(data.clone(), Arc::new(Sink(tx))).unwrap();

    // One enabled stdio server, one disabled, one HTTP (mock lacks HTTP support).
    let mut settings = core.settings().unwrap();
    settings.failover = "auto".into();
    settings.default_permission_mode = "ask".into();
    let server = |id: &str, enabled: bool, transport: McpTransport| McpServer {
        id: id.into(),
        name: id.into(),
        enabled,
        transport,
        command: "echo".into(),
        args: vec![],
        env: vec![],
        url: "https://example.com/mcp".into(),
        headers: vec![],
    };
    settings.mcp_servers = vec![
        server("files", true, McpTransport::Stdio),
        server("off", false, McpTransport::Stdio),
        server("remote", true, McpTransport::Http),
    ];
    core.save_settings(settings).unwrap();

    let system = core
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.provider == Provider::Grok && a.is_system)
        .unwrap();
    let second = core
        .create_account(CreateAccountRequest {
            provider: Provider::Grok,
            name: "Work".into(),
            color: "#4FC3F7".into(),
            auth_kind: AuthKind::Oauth,
            api_key: None,
        })
        .await
        .unwrap();
    assert!(second
        .config_dir
        .as_deref()
        .is_some_and(|d| std::path::Path::new(d).is_dir()));
    let signed_in = AccountStatus {
        logged_in: true,
        label: None,
        email: None,
        plan: None,
        checked_at: 0,
        error: None,
    };
    core.set_account_status(&system.id, signed_in.clone())
        .unwrap();
    core.set_account_status(&second.id, signed_in).unwrap();

    async fn approve_and_finish(
        core: &Core,
        rx: &mut mpsc::UnboundedReceiver<ArmadaEvent>,
        agent_id: &str,
    ) -> String {
        let ev = next_matching(rx, |e| matches!(e, ArmadaEvent::ItemUpserted { item } if matches!(item.body, ItemBody::Permission { resolution: None, .. }))).await;
        let ArmadaEvent::ItemUpserted { item } = ev else {
            unreachable!()
        };
        let ItemBody::Permission { request_id, .. } = item.body else {
            unreachable!()
        };
        core.respond_permission(agent_id, &request_id, "yes")
            .await
            .unwrap();
        let ev = next_matching(rx, |e| {
            matches!(
                e,
                ArmadaEvent::Attention {
                    reason: AttentionReason::Done,
                    ..
                }
            )
        })
        .await;
        let ArmadaEvent::Attention { body, .. } = ev else {
            unreachable!()
        };
        body
    }

    let agent = core
        .create_agent(CreateAgentRequest {
            provider: Provider::Grok,
            account_id: system.id.clone(),
            project_path: project.to_string_lossy().into_owned(),
            prompt: "MCP?".into(),
            title: Some("Pinned title".into()),
            worktree: false,
            model: None,
            group_id: None,
            custom_agent_id: None,
            permission_mode: None,
            attachments: vec![],
        })
        .await
        .unwrap();
    // Only the enabled stdio server reaches the agent.
    assert_eq!(
        approve_and_finish(&core, &mut rx, &agent.id).await,
        "You said: mcp=1"
    );

    let a = core.agent(&agent.id).unwrap();
    assert_eq!(
        a.title, "Pinned title",
        "custom titles aren't replaced by agent suggestions"
    );
    assert_eq!(a.available_commands.len(), 2);
    assert!(
        a.config_options
            .iter()
            .any(|o| o.id == "mode" && o.current_value == "ask"),
        "with the default set to ask, agents keep their own default mode"
    );
    assert_eq!(a.available_commands[1].hint.as_deref(), Some("path"));

    // Hitting a usage limit with failover = auto moves the agent to the other account
    // and continues there.
    core.send_prompt(&agent.id, "TRIGGER_LIMIT now", vec![])
        .await
        .unwrap();
    next_matching(&mut rx, |e| {
        matches!(
            e,
            ArmadaEvent::Attention {
                reason: AttentionReason::Error,
                ..
            }
        )
    })
    .await;
    approve_and_finish(&core, &mut rx, &agent.id).await;
    let a = core.agent(&agent.id).unwrap();
    assert_eq!(a.account_id, second.id);
    assert!(!a.rate_limited);
    let items = core.items(&agent.id).unwrap();
    assert!(items.iter().any(|i| matches!(&i.body, ItemBody::Notice { text, .. } if text.contains("Switched to the account"))));
    assert!(items.iter().any(|i| matches!(&i.body, ItemBody::UserMessage { text, .. } if text.contains("usage limit on the previous account"))));

    // Export as Markdown and JSON.
    let md = project.join("t.md");
    core.export_agent(&agent.id, md.to_str().unwrap()).unwrap();
    let md = std::fs::read_to_string(md).unwrap();
    assert!(md.starts_with("# Pinned title"));
    assert!(md.contains("### You\n\nMCP?"));
    assert!(md.contains("- [x] Look around"));
    let json = project.join("t.json");
    core.export_agent(&agent.id, json.to_str().unwrap())
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(json).unwrap()).unwrap();
    assert_eq!(v["agent"]["id"], agent.id.as_str());
    assert!(v["items"].as_array().unwrap().len() > 5);

    // Manual switch back works too; deleting an account in use is refused.
    core.switch_account(&agent.id, &system.id).await.unwrap();
    assert_eq!(core.agent(&agent.id).unwrap().account_id, system.id);
    assert!(core.delete_account(&system.id).is_err());

    // Schedules: validation, save, run now.
    let bad = Schedule {
        id: String::new(),
        name: "Nightly".into(),
        enabled: true,
        provider: Provider::Grok,
        account_id: system.id.clone(),
        project_path: project.to_string_lossy().into_owned(),
        prompt: "hello".into(),
        worktree: false,
        time: "25:00".into(),
        days: vec![],
        last_run_at: None,
        last_agent_id: None,
        custom_agent_id: None,
        updated_at: 0,
        last_error: None,
        permission_mode: None,
    };
    assert!(core.save_schedule(bad.clone()).is_err());
    let saved = core
        .save_schedule(Schedule {
            time: "09:00".into(),
            days: vec![5, 1, 1],
            ..bad
        })
        .unwrap();
    assert!(!saved.id.is_empty());
    assert_eq!(saved.days, vec![1, 5]);
    let started = core.run_schedule(&saved.id).await.unwrap();
    assert_eq!(started.schedule_id.as_deref(), Some(saved.id.as_str()));
    approve_and_finish(&core, &mut rx, &started.id).await;
    let after = core.schedules().unwrap();
    assert_eq!(after[0].last_agent_id.as_deref(), Some(started.id.as_str()));
    core.delete_schedule(&saved.id).unwrap();
    assert!(core.schedules().unwrap().is_empty());

    core.shutdown().await;
}

#[tokio::test]
async fn custom_agents_attachments_and_files() {
    let mock = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mock_acp.py").to_string();
    let data = temp_dir("data3");
    let project = temp_dir("project3");
    std::fs::create_dir_all(project.join("src/lib")).unwrap();
    std::fs::write(project.join("src/lib/agent.ts"), "x").unwrap();
    std::fs::write(project.join("README.md"), "x").unwrap();
    std::fs::create_dir_all(project.join("node_modules/pkg")).unwrap();
    std::fs::write(project.join("node_modules/pkg/index.js"), "x").unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    let core = Core::open(data.clone(), Arc::new(Sink(tx))).unwrap();

    let def = CustomAgent {
        id: "mock".into(),
        name: "Mock agent".into(),
        command: "python3".into(),
        args: vec![mock],
        env: vec![KeyValue {
            name: "MOCK".into(),
            value: "1".into(),
        }],
        color: "#B39DDB".into(),
        enabled: true,
    };
    // Connection test performs a real ACP handshake.
    let who = core.test_custom_agent(def.clone()).await.unwrap();
    assert!(who.contains("ACP v1"), "{who}");
    let broken = CustomAgent {
        command: "definitely-not-a-real-binary".into(),
        ..def.clone()
    };
    assert!(core.test_custom_agent(broken).await.is_err());

    let mut settings = core.settings().unwrap();
    settings.custom_agents = vec![def];
    core.save_settings(settings).unwrap();

    let account = core
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.provider == Provider::Custom)
        .expect("default account for custom agents");
    let req = |custom: Option<&str>, attachments: Vec<Attachment>| CreateAgentRequest {
        provider: Provider::Custom,
        account_id: account.id.clone(),
        project_path: project.to_string_lossy().into_owned(),
        prompt: "look at this".into(),
        title: None,
        worktree: false,
        model: None,
        group_id: None,
        custom_agent_id: custom.map(str::to_string),
        permission_mode: None,
        attachments,
    };
    assert!(
        core.create_agent(req(None, vec![])).await.is_err(),
        "custom agent id required"
    );
    assert!(core
        .create_agent(req(Some("missing"), vec![]))
        .await
        .is_err());
    let not_image = Attachment {
        name: "a.txt".into(),
        mime_type: "text/plain".into(),
        data: "aGk=".into(),
    };
    assert!(core
        .create_agent(req(Some("mock"), vec![not_image]))
        .await
        .is_err());

    let png = Attachment {
        name: "shot.png".into(),
        mime_type: "image/png".into(),
        data: "iVBORw0KGgo=".into(),
    };
    let agent = core
        .create_agent(req(Some("mock"), vec![png]))
        .await
        .unwrap();
    assert_eq!(agent.custom_agent_id.as_deref(), Some("mock"));

    let ev = next_matching(&mut rx, |e| matches!(e, ArmadaEvent::ItemUpserted { item } if matches!(item.body, ItemBody::Permission { resolution: None, .. }))).await;
    let ArmadaEvent::ItemUpserted { item } = ev else {
        unreachable!()
    };
    let ItemBody::Permission { request_id, .. } = item.body else {
        unreachable!()
    };
    core.respond_permission(&agent.id, &request_id, "yes")
        .await
        .unwrap();
    next_matching(&mut rx, |e| {
        matches!(
            e,
            ArmadaEvent::Attention {
                reason: AttentionReason::Done,
                ..
            }
        )
    })
    .await;

    let items = core.items(&agent.id).unwrap();
    match &items[0].body {
        ItemBody::UserMessage { attachments, .. } => assert_eq!(attachments.len(), 1),
        other => panic!("unexpected {other:?}"),
    }
    // The mock doesn't advertise image support, so the user is told.
    assert!(items.iter().any(|i| matches!(&i.body, ItemBody::Notice { text, .. } if text.contains("doesn't accept images"))));

    // @-mention search skips node_modules and ranks file-name matches first.
    let files = core.list_files(&agent.id, "agent").await.unwrap();
    assert_eq!(files.first().map(String::as_str), Some("src/lib/agent.ts"));
    assert!(core
        .list_files(&agent.id, "index")
        .await
        .unwrap()
        .is_empty());

    core.shutdown().await;
}

/// Streamed text carries UTF-16 offsets that line up with the concatenated text,
/// and every stream ends with the full item (so a client that missed deltas heals).
#[tokio::test]
async fn stream_offsets_and_final_item() {
    let mock = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mock_acp.py").to_string();
    let data = temp_dir("data-offsets");
    let project = temp_dir("project-offsets");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let core = Core::open(data, Arc::new(Sink(tx))).unwrap();
    let mut settings = core.settings().unwrap();
    settings.custom_agents = vec![CustomAgent {
        id: "mock".into(),
        name: "Mock".into(),
        command: "python3".into(),
        args: vec![mock],
        env: vec![],
        color: "#B39DDB".into(),
        enabled: true,
    }];
    core.save_settings(settings).unwrap();
    let account = core
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.provider == Provider::Custom)
        .unwrap();
    // Non-ASCII text: "é" is 1 UTF-16 unit, "😀" is 2.
    let agent = core
        .create_agent(CreateAgentRequest {
            provider: Provider::Custom,
            account_id: account.id,
            project_path: project.to_string_lossy().into_owned(),
            prompt: "héllo 😀".into(),
            title: None,
            worktree: false,
            model: None,
            group_id: None,
            custom_agent_id: Some("mock".into()),
            // Per-agent override of the "auto" default.
            permission_mode: Some("ask".into()),
            attachments: vec![],
        })
        .await
        .unwrap();

    let mut message_id = None;
    let mut rebuilt = String::new();
    let mut final_text = None;
    loop {
        let ev = next_matching(&mut rx, |_| true).await;
        match ev {
            ArmadaEvent::ItemUpserted { item } => {
                if let ItemBody::Permission {
                    request_id,
                    resolution: None,
                    ..
                } = &item.body
                {
                    core.respond_permission(&agent.id, request_id, "yes")
                        .await
                        .unwrap();
                }
                if let ItemBody::AgentMessage { text } = &item.body {
                    message_id = Some(item.id.clone());
                    if !text.is_empty() {
                        final_text = Some(text.clone());
                    }
                }
            }
            ArmadaEvent::TextDelta {
                item_id,
                field: DeltaField::Text,
                delta,
                offset,
                ..
            } if Some(&item_id) == message_id.as_ref() => {
                assert_eq!(
                    offset,
                    rebuilt.encode_utf16().count(),
                    "offset of {delta:?}"
                );
                rebuilt.push_str(&delta);
            }
            ArmadaEvent::Attention {
                reason: AttentionReason::Done,
                ..
            } => break,
            _ => {}
        }
    }
    assert_eq!(rebuilt, "You said: héllo 😀");
    assert_eq!(
        final_text.as_deref(),
        Some("You said: héllo 😀"),
        "full item after the stream"
    );
    let a = core.agent(&agent.id).unwrap();
    assert_eq!(a.permission_mode.as_deref(), Some("ask"));
    assert!(
        a.config_options
            .iter()
            .any(|o| o.id == "mode" && o.current_value != "auto"),
        "an agent launched in Ask mode stays out of Auto"
    );
    core.acknowledge_agent(&agent.id).unwrap();
    let a = core.agent(&agent.id).unwrap();
    assert!(a.acknowledged_at.is_some() && !a.unread);
    core.shutdown().await;
}

async fn custom_mock_core(
    name: &str,
) -> (
    Core,
    mpsc::UnboundedReceiver<ArmadaEvent>,
    String,
    std::path::PathBuf,
) {
    let mock = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mock_acp.py").to_string();
    let data = temp_dir(&format!("{name}-data"));
    let project = temp_dir(&format!("{name}-project"));
    let (tx, rx) = mpsc::unbounded_channel();
    let core = Core::open(data, Arc::new(Sink(tx))).unwrap();
    let mut settings = core.settings().unwrap();
    settings.custom_agents = vec![CustomAgent {
        id: "mock".into(),
        name: "Mock".into(),
        command: "python3".into(),
        args: vec![mock],
        env: vec![],
        color: "#B39DDB".into(),
        enabled: true,
    }];
    core.save_settings(settings).unwrap();
    let account = core
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.provider == Provider::Custom)
        .unwrap()
        .id;
    (core, rx, account, project)
}

/// Claude-style sub-agents: the Task call carries the sub-agent, the calls it
/// makes nest under it, its own text stays out of the main conversation, and the
/// turn summary counts only the agent's own (top-level) steps and commands.
#[tokio::test]
async fn subagent_calls_nest_under_their_task() {
    let (core, mut rx, account, project) = custom_mock_core("subagent").await;
    let agent = core
        .create_agent(CreateAgentRequest {
            provider: Provider::Custom,
            account_id: account,
            project_path: project.to_string_lossy().into_owned(),
            prompt: "SUBAGENT please".into(),
            title: None,
            worktree: false,
            model: None,
            group_id: None,
            custom_agent_id: Some("mock".into()),
            permission_mode: None,
            attachments: vec![],
        })
        .await
        .unwrap();
    let mut output_deltas = Vec::new();
    loop {
        match next_matching(&mut rx, |_| true).await {
            ArmadaEvent::TextDelta {
                field: DeltaField::Output,
                delta,
                ..
            } => output_deltas.push(delta),
            ArmadaEvent::Attention {
                reason: AttentionReason::Done,
                ..
            } => break,
            _ => {}
        }
    }
    // The growing Task output went out as a delta, not as full re-sends.
    assert_eq!(output_deltas, ["found", " it"]);
    let items = core.items(&agent.id).unwrap();
    let calls: Vec<(&str, bool, Option<&str>, &str)> = items
        .iter()
        .filter_map(|i| match &i.body {
            ItemBody::ToolCall {
                tool_call_id,
                subagent,
                parent_tool_call_id,
                output,
                ..
            } => Some((
                tool_call_id.as_str(),
                subagent.is_some(),
                parent_tool_call_id.as_deref(),
                output.as_str(),
            )),
            _ => None,
        })
        .collect();
    assert_eq!(
        calls,
        [
            ("task1", true, None, "found it"),
            ("sub1", false, Some("task1"), ""),
            ("sub2", false, Some("task1"), ""),
        ]
    );
    let task = items
        .iter()
        .find_map(|i| match &i.body {
            ItemBody::ToolCall {
                subagent: Some(sa), ..
            } => Some(sa.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(task.kind.as_deref(), Some("Explore"));
    assert_eq!(task.description.as_deref(), Some("Explore the repo"));
    let texts: Vec<&str> = items
        .iter()
        .filter_map(|i| match &i.body {
            ItemBody::AgentMessage { text } | ItemBody::Thought { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, ["Done with the sub-agent"], "sub-agent text leaked");
    match &items.last().unwrap().body {
        ItemBody::TurnSummary {
            tool_calls,
            commands,
            ..
        } => assert_eq!((*tool_calls, *commands), (1, 0)),
        other => panic!("expected a summary, got {other:?}"),
    }
    core.shutdown().await;
}

/// Codex: "ask" agents start with the untrusted policy; permission requests,
/// legacy approvals, user-input and elicitation requests all get an answer of
/// the right shape; a sub-agent item that arrives before its collaborator call
/// is re-parented once the call is known.
#[tokio::test]
async fn codex_server_requests_and_ask_mode() {
    let mock = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mock_codex_full.py");
    std::env::set_var("ARMADA_CODEX_COMMAND", format!("python3 {mock}"));
    let data = temp_dir("codex-full-data");
    let project = temp_dir("codex-full-project");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let core = Core::open(data, Arc::new(Sink(tx))).unwrap();
    let account = core
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.provider == Provider::Codex && a.is_system)
        .unwrap();
    let agent = core
        .create_agent(CreateAgentRequest {
            provider: Provider::Codex,
            account_id: account.id,
            project_path: project.to_string_lossy().into_owned(),
            prompt: "go".into(),
            title: None,
            worktree: false,
            model: None,
            group_id: None,
            custom_agent_id: None,
            permission_mode: Some("ask".into()),
            attachments: vec![],
        })
        .await
        .unwrap();
    let mut answered = Vec::new();
    loop {
        match next_matching(&mut rx, |_| true).await {
            ArmadaEvent::ItemUpserted { item } => {
                if let ItemBody::Permission {
                    request_id,
                    title,
                    resolution: None,
                    ..
                } = &item.body
                {
                    // Allow the network grant, decline the legacy command.
                    let choice = if answered.is_empty() {
                        "accept"
                    } else {
                        "decline"
                    };
                    answered.push(title.clone());
                    core.respond_permission(&agent.id, request_id, choice)
                        .await
                        .unwrap();
                }
            }
            ArmadaEvent::Attention {
                reason: AttentionReason::Done,
                ..
            } => break,
            ArmadaEvent::Attention {
                reason: AttentionReason::Error,
                body,
                ..
            } => panic!("turn failed: {body}"),
            _ => {}
        }
    }
    assert_eq!(answered, ["Allow network access", "Run rm -rf build"]);
    let items = core.items(&agent.id).unwrap();
    let reply = items
        .iter()
        .find_map(|i| match &i.body {
            ItemBody::AgentMessage { text } => Some(text.clone()),
            _ => None,
        })
        .unwrap();
    assert!(reply.starts_with("policy=untrusted "), "{reply}");
    let answers: serde_json::Value =
        serde_json::from_str(reply.split_once("answers=").unwrap().1).unwrap();
    assert_eq!(
        answers["perm"],
        serde_json::json!({ "permissions": { "network": { "enabled": true } }, "scope": "turn" })
    );
    assert!(
        answers["exec"]["decision"]["denied"].is_object(),
        "{answers}"
    );
    assert_eq!(answers["input"], serde_json::json!({ "answers": {} }));
    assert_eq!(answers["elicit"]["action"], "decline");
    let notices: Vec<&str> = items
        .iter()
        .filter_map(|i| match &i.body {
            ItemBody::Notice { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        notices
            .iter()
            .filter(|n| n.starts_with("Codex asked for input Armada can't show yet"))
            .count(),
        2,
        "{notices:?}"
    );
    let orphan = items
        .iter()
        .find_map(|i| match &i.body {
            ItemBody::ToolCall {
                tool_call_id,
                parent_tool_call_id,
                ..
            } if tool_call_id == "c-orphan" => Some(parent_tool_call_id.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(orphan.as_deref(), Some("collab1"));
    let a = core.agent(&agent.id).unwrap();
    assert!(a
        .config_options
        .iter()
        .any(|o| o.id == "approval" && o.current_value == "untrusted"));
    core.shutdown().await;
}
