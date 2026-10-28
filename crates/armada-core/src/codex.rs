//! Driver for OpenAI Codex's native `codex app-server` JSON-RPC protocol (v2 threads).
//! Schema: `codex app-server generate-json-schema --out <dir>`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::anyhow;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::jsonrpc::{Incoming, Peer, SpawnOptions};
use crate::model::*;
use crate::session::{AgentCtx, Prompt, StreamKind, TurnOutcome};

pub struct CodexDriver {
    peer: Arc<Peer>,
    ctx: Arc<AgentCtx>,
    thread_id: String,
    turn_id: Mutex<Option<String>>,
    /// Last turn Codex reported complete (its `turn/start` reply can arrive later).
    completed_turn: Mutex<Option<String>>,
    /// Cancel was requested before Codex told us the turn id.
    cancel_requested: std::sync::atomic::AtomicBool,
    perms: Mutex<HashMap<String, Value>>,
    approval_policy: Mutex<String>,
    model: Mutex<Option<String>>,
    effort: Mutex<Option<String>>,
}

pub struct StartOptions<'a> {
    pub program: &'a Path,
    pub args: &'a [String],
    pub cwd: &'a Path,
    pub env: &'a [(String, String)],
    pub label: &'a str,
    pub resume: Option<&'a str>,
    pub version: &'a str,
    pub mcp_servers: &'a [McpServer],
}

const APPROVAL_CHOICES: [(&str, &str, &str); 3] = [
    (
        "on-request",
        "Ask when needed",
        "The agent asks before risky actions",
    ),
    (
        "untrusted",
        "Ask for most actions",
        "Only trusted read-only commands run without asking",
    ),
    (
        "never",
        "Never ask",
        "Runs everything inside the sandbox without asking",
    ),
];

impl CodexDriver {
    pub async fn start(
        ctx: Arc<AgentCtx>,
        opts: StartOptions<'_>,
    ) -> anyhow::Result<Arc<CodexDriver>> {
        let (peer, rx) = Peer::spawn(SpawnOptions {
            program: opts.program,
            args: opts.args,
            cwd: opts.cwd,
            env: opts.env,
            label: opts.label,
        })?;
        let generation = ctx.begin_start();
        let result = Self::connect(ctx.clone(), &opts, peer.clone(), rx, generation).await;
        ctx.end_start(generation);
        if result.is_err() {
            // Don't leave a half-started agent process behind; the caller reports.
            peer.kill().await;
        }
        result
    }

    async fn connect(
        ctx: Arc<AgentCtx>,
        opts: &StartOptions<'_>,
        peer: Arc<Peer>,
        rx: mpsc::UnboundedReceiver<Incoming>,
        generation: u64,
    ) -> anyhow::Result<Arc<CodexDriver>> {
        peer.request_timeout(
            "initialize",
            json!({ "clientInfo": { "name": "armada", "title": "Armada", "version": opts.version } }),
            Some(Duration::from_secs(60)),
        )
        .await?;
        peer.notify("initialized", json!({})).await?;

        let cwd = opts.cwd.to_string_lossy().into_owned();
        let mut thread: Option<Value> = None;
        if let Some(prev) = opts.resume {
            match peer
                .request_timeout(
                    "thread/resume",
                    json!({ "threadId": prev, "cwd": cwd, "excludeTurns": true, "config": codex_config(opts.mcp_servers) }),
                    Some(Duration::from_secs(120)),
                )
                .await
            {
                Ok(v) => thread = Some(v),
                Err(e) => {
                    tracing::info!("thread/resume failed: {e:#}");
                    ctx.notice(
                        NoticeLevel::Warn,
                        "Couldn't reattach to the previous Codex thread, so Armada started a fresh one and will brief the agent with the conversation so far.",
                    );
                }
            }
        }
        let resp = match thread {
            Some(v) => v,
            None => {
                peer.request_timeout(
                    "thread/start",
                    json!({
                        "cwd": cwd,
                        "approvalPolicy": "on-request",
                        "sandbox": "workspace-write",
                        "serviceName": "armada",
                        "config": codex_config(opts.mcp_servers)
                    }),
                    Some(Duration::from_secs(60)),
                )
                .await?
            }
        };
        let thread_id = resp["thread"]["id"]
            .as_str()
            .ok_or_else(|| anyhow!("Codex returned no thread id"))?
            .to_string();

        let driver = Arc::new(CodexDriver {
            peer: peer.clone(),
            ctx: ctx.clone(),
            thread_id,
            turn_id: Mutex::new(None),
            completed_turn: Mutex::new(None),
            cancel_requested: std::sync::atomic::AtomicBool::new(false),
            perms: Mutex::default(),
            approval_policy: Mutex::new(
                resp["approvalPolicy"]
                    .as_str()
                    .unwrap_or("on-request")
                    .to_string(),
            ),
            model: Mutex::new(resp["model"].as_str().map(str::to_string)),
            effort: Mutex::new(resp["reasoningEffort"].as_str().map(str::to_string)),
        });
        tokio::spawn(event_loop(
            Arc::downgrade(&driver),
            peer.clone(),
            ctx.clone(),
            rx,
            generation,
        ));
        driver.publish_config().await;
        Ok(driver)
    }

    pub fn session_id(&self) -> String {
        self.thread_id.clone()
    }

    async fn publish_config(&self) {
        let mut options = Vec::new();
        let current_model = self.model.lock().clone().unwrap_or_default();
        let models = self
            .peer
            .request_timeout("model/list", json!({}), Some(Duration::from_secs(20)))
            .await
            .ok()
            .and_then(|v| v["data"].as_array().cloned())
            .unwrap_or_default();
        let mut choices: Vec<ConfigOptionChoice> = models
            .iter()
            .filter(|m| !m["hidden"].as_bool().unwrap_or(false))
            .filter_map(|m| {
                let value = m["model"].as_str().or_else(|| m["id"].as_str())?;
                Some(ConfigOptionChoice {
                    value: value.to_string(),
                    name: m["displayName"].as_str().unwrap_or(value).to_string(),
                    description: m["description"].as_str().map(str::to_string),
                })
            })
            .collect();
        if !current_model.is_empty() && !choices.iter().any(|c| c.value == current_model) {
            choices.insert(
                0,
                ConfigOptionChoice {
                    value: current_model.clone(),
                    name: current_model.clone(),
                    description: None,
                },
            );
        }
        if !choices.is_empty() {
            options.push(ConfigOption {
                id: "model".into(),
                name: "Model".into(),
                category: Some("model".into()),
                current_value: current_model,
                options: choices,
            });
        }
        let efforts = ["low", "medium", "high", "xhigh"];
        options.push(ConfigOption {
            id: "effort".into(),
            name: "Reasoning".into(),
            category: Some("thought_level".into()),
            current_value: self
                .effort
                .lock()
                .clone()
                .unwrap_or_else(|| "medium".into()),
            options: efforts
                .iter()
                .map(|e| ConfigOptionChoice {
                    value: e.to_string(),
                    name: capitalize(e),
                    description: None,
                })
                .collect(),
        });
        options.push(ConfigOption {
            id: "approval".into(),
            name: "Approvals".into(),
            category: Some("mode".into()),
            current_value: self.approval_policy.lock().clone(),
            options: APPROVAL_CHOICES
                .iter()
                .map(|(v, n, d)| ConfigOptionChoice {
                    value: v.to_string(),
                    name: n.to_string(),
                    description: Some(d.to_string()),
                })
                .collect(),
        });
        self.ctx.set_config_options(options);
    }

    /// Starts a turn. The turn ends with a `turn/completed` notification.
    pub fn prompt(self: &Arc<Self>, prompt: Prompt) {
        let me = self.clone();
        tokio::spawn(async move { me.start_turn(prompt).await });
    }

    async fn start_turn(self: Arc<Self>, prompt: Prompt) {
        self.ctx.turn_started();
        let body = match self.ctx.take_preamble() {
            Some(pre) => format!("{pre}\n\n---\n\n{}", prompt.text),
            None => prompt.text.clone(),
        };
        let mut input = vec![json!({ "type": "text", "text": body })];
        for a in &prompt.attachments {
            // Codex takes images as local files.
            match write_attachment(a) {
                Ok(path) => input.push(json!({ "type": "localImage", "path": path })),
                Err(e) => self.ctx.notice(
                    NoticeLevel::Warn,
                    format!("Couldn't attach {}: {e:#}", a.name),
                ),
            }
        }
        let mut params = json!({
            "threadId": self.thread_id,
            "input": input,
            "approvalPolicy": self.approval_policy.lock().clone(),
        });
        if let Some(m) = self.model.lock().clone() {
            params["model"] = json!(m);
        }
        if let Some(e) = self.effort.lock().clone() {
            params["effort"] = json!(e);
        }
        self.cancel_requested
            .store(false, std::sync::atomic::Ordering::SeqCst);
        match self.peer.request("turn/start", params).await {
            Ok(v) => {
                let id = v["turn"]["id"].as_str().map(str::to_string);
                let finished = id.is_some() && *self.completed_turn.lock() == id;
                if !finished {
                    *self.turn_id.lock() = id;
                    if self
                        .cancel_requested
                        .swap(false, std::sync::atomic::Ordering::SeqCst)
                    {
                        let _ = self.interrupt().await;
                    }
                }
            }
            Err(e) => {
                let next = self
                    .ctx
                    .turn_finished(TurnOutcome::Failed(format!("{e:#}")));
                debug_assert!(next.is_none());
            }
        }
    }

    pub async fn cancel(&self) -> anyhow::Result<()> {
        let pending: Vec<(String, Value)> = self.perms.lock().drain().collect();
        for (req, rpc_id) in pending {
            let _ = self
                .peer
                .respond(rpc_id, json!({ "decision": "cancel" }))
                .await;
            self.ctx.permission_resolved(&req, "cancelled");
        }
        if self.turn_id.lock().is_none() {
            // turn/start hasn't answered yet; interrupt as soon as it does.
            self.cancel_requested
                .store(true, std::sync::atomic::Ordering::SeqCst);
            return Ok(());
        }
        self.interrupt().await
    }

    async fn interrupt(&self) -> anyhow::Result<()> {
        let turn = self.turn_id.lock().clone();
        if let Some(turn_id) = turn {
            self.peer
                .request_timeout(
                    "turn/interrupt",
                    json!({ "threadId": self.thread_id, "turnId": turn_id }),
                    Some(Duration::from_secs(15)),
                )
                .await?;
        }
        Ok(())
    }

    pub async fn respond_permission(
        &self,
        request_id: &str,
        option_id: &str,
    ) -> anyhow::Result<()> {
        let rpc_id = self
            .perms
            .lock()
            .remove(request_id)
            .ok_or_else(|| anyhow!("This approval is no longer pending."))?;
        self.peer
            .respond(rpc_id, json!({ "decision": option_id }))
            .await?;
        self.ctx.permission_resolved(request_id, option_id);
        Ok(())
    }

    pub async fn set_config(&self, option_id: &str, value: &str) -> anyhow::Result<()> {
        match option_id {
            "model" => *self.model.lock() = Some(value.to_string()),
            "effort" => *self.effort.lock() = Some(value.to_string()),
            "approval" => *self.approval_policy.lock() = value.to_string(),
            other => return Err(anyhow!("Unknown Codex setting {other}")),
        }
        // Codex applies these per turn (they're sent with the next turn/start).
        self.ctx.set_config_value(option_id, value);
        Ok(())
    }

    pub async fn shutdown(&self) {
        self.peer.kill().await;
    }

    pub fn is_closed(&self) -> bool {
        self.peer.is_closed()
    }

    fn on_item(&self, item: &Value, completed: bool) {
        let ctx = &self.ctx;
        let Some(id) = item["id"].as_str() else {
            return;
        };
        match item["type"].as_str().unwrap_or("") {
            "userMessage" | "hookPrompt" | "contextCompaction" => {}
            "agentMessage" => {
                if completed {
                    ctx.finish_text(StreamKind::Message, id, item["text"].as_str().unwrap_or(""));
                }
            }
            "reasoning" => {
                if completed {
                    let summary = match &item["summary"] {
                        Value::Array(a) => a
                            .iter()
                            .filter_map(|s| s.as_str().or_else(|| s["text"].as_str()))
                            .collect::<Vec<_>>()
                            .join("\n\n"),
                        _ => String::new(),
                    };
                    if !summary.is_empty() {
                        ctx.finish_text(StreamKind::Thought, id, &summary);
                    }
                }
            }
            "commandExecution" => {
                let command = item["command"].as_str().unwrap_or("").to_string();
                ctx.tool_call(id, |b| {
                    if let ItemBody::ToolCall {
                        title,
                        tool_kind,
                        status,
                        output,
                        command: cmd,
                        ..
                    } = b
                    {
                        *title = format!("Run {}", short(&command, 80));
                        *tool_kind = ToolKind::Execute;
                        *cmd = Some(command.clone());
                        *status = codex_status(item["status"].as_str(), completed);
                        if let Some(o) = item["aggregatedOutput"].as_str() {
                            *output = o.to_string();
                        }
                        if completed {
                            if let Some(code) = item["exitCode"].as_i64().filter(|c| *c != 0) {
                                output.push_str(&format!("\n[exit code {code}]"));
                            }
                        }
                    }
                });
            }
            "fileChange" => {
                let changes = item["changes"].as_array().cloned().unwrap_or_default();
                ctx.tool_call(id, |b| {
                    if let ItemBody::ToolCall {
                        title,
                        tool_kind,
                        status,
                        locations,
                        diffs,
                        ..
                    } = b
                    {
                        *tool_kind = ToolKind::Edit;
                        *status = codex_status(item["status"].as_str(), completed);
                        diffs.clear();
                        locations.clear();
                        for c in &changes {
                            let path = c["path"].as_str().unwrap_or("").to_string();
                            locations.push(path.clone());
                            diffs.push(FileDiff {
                                path,
                                old_text: None,
                                new_text: None,
                                unified: c["diff"].as_str().map(str::to_string),
                            });
                        }
                        *title = match locations.as_slice() {
                            [one] => format!("Edit {}", file_name(one)),
                            many => format!("Edit {} files", many.len()),
                        };
                    }
                });
            }
            "mcpToolCall" | "dynamicToolCall" => {
                let tool = item["tool"].as_str().unwrap_or("tool");
                let server = item["server"]
                    .as_str()
                    .or_else(|| item["namespace"].as_str());
                ctx.tool_call(id, |b| {
                    if let ItemBody::ToolCall {
                        title,
                        tool_kind,
                        status,
                        output,
                        ..
                    } = b
                    {
                        *title = match server {
                            Some(s) => format!("{s} · {tool}"),
                            None => tool.to_string(),
                        };
                        *tool_kind = ToolKind::Other;
                        *status = codex_status(item["status"].as_str(), completed);
                        if completed {
                            let result = item.get("result").or_else(|| item.get("contentItems"));
                            if let Some(r) = result.filter(|r| !r.is_null()) {
                                *output = serde_json::to_string_pretty(r).unwrap_or_default();
                            }
                            if let Some(err) = item["error"]["message"].as_str() {
                                *output = err.to_string();
                            }
                        }
                    }
                });
            }
            "webSearch" => {
                let query = item["query"].as_str().unwrap_or("").to_string();
                ctx.tool_call(id, |b| {
                    if let ItemBody::ToolCall {
                        title,
                        tool_kind,
                        status,
                        ..
                    } = b
                    {
                        *title = format!("Search the web: {}", short(&query, 80));
                        *tool_kind = ToolKind::Fetch;
                        *status = if completed {
                            ToolStatus::Completed
                        } else {
                            ToolStatus::InProgress
                        };
                    }
                });
            }
            "imageView" => {
                let path = item["path"].as_str().unwrap_or("").to_string();
                ctx.tool_call(id, |b| {
                    if let ItemBody::ToolCall {
                        title,
                        tool_kind,
                        status,
                        locations,
                        ..
                    } = b
                    {
                        *title = format!("View image {}", file_name(&path));
                        *tool_kind = ToolKind::Read;
                        *status = ToolStatus::Completed;
                        *locations = vec![path.clone()];
                    }
                });
            }
            "collabAgentToolCall" | "subAgentActivity" => {
                let label = item["tool"]
                    .as_str()
                    .or_else(|| item["kind"].as_str())
                    .unwrap_or("Sub-agent");
                ctx.tool_call(id, |b| {
                    if let ItemBody::ToolCall {
                        title,
                        tool_kind,
                        status,
                        ..
                    } = b
                    {
                        *title = format!("Sub-agent: {label}");
                        *tool_kind = ToolKind::Think;
                        *status = codex_status(item["status"].as_str(), completed);
                    }
                });
            }
            _ => {}
        }
    }

    fn on_notification(self: &Arc<Self>, method: &str, p: &Value) {
        let ctx = &self.ctx;
        match method {
            "item/started" => self.on_item(&p["item"], false),
            "item/completed" => self.on_item(&p["item"], true),
            "item/agentMessage/delta" => {
                if let (Some(id), Some(d)) = (p["itemId"].as_str(), p["delta"].as_str()) {
                    ctx.append_text(StreamKind::Message, Some(id), d);
                }
            }
            "item/reasoning/summaryTextDelta" => {
                if let (Some(id), Some(d)) = (p["itemId"].as_str(), p["delta"].as_str()) {
                    ctx.append_text(StreamKind::Thought, Some(id), d);
                }
            }
            "item/commandExecution/outputDelta" => {
                if let (Some(id), Some(d)) = (p["itemId"].as_str(), p["delta"].as_str()) {
                    ctx.append_tool_output(id, d);
                }
            }
            "turn/plan/updated" => {
                let entries = p["plan"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|s| PlanEntry {
                                content: s["step"].as_str().unwrap_or("").to_string(),
                                status: match s["status"].as_str() {
                                    Some("inProgress") => PlanStatus::InProgress,
                                    Some("completed") => PlanStatus::Completed,
                                    _ => PlanStatus::Pending,
                                },
                                priority: None,
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                ctx.plan(entries);
            }
            "thread/tokenUsage/updated" => {
                let usage = &p["tokenUsage"];
                if let Some(total) = usage["total"]["totalTokens"].as_i64() {
                    ctx.set_tokens(total);
                }
                ctx.usage(
                    usage["last"]["totalTokens"].as_i64(),
                    usage["modelContextWindow"].as_i64(),
                    None,
                );
            }
            "thread/name/updated" => {
                if let Some(name) = p["name"].as_str().or_else(|| p["threadName"].as_str()) {
                    ctx.set_title_suggestion(name);
                }
            }
            "account/rateLimits/updated" => {
                let r = &p["rateLimits"];
                let window = |w: &Value| -> Option<UsageWindow> {
                    let used = w["usedPercent"].as_f64()?;
                    Some(UsageWindow {
                        used_percent: used,
                        window_mins: w["windowDurationMins"].as_i64(),
                        // Codex reports seconds; normalize to ms.
                        resets_at: w["resetsAt"].as_i64().map(|t| {
                            if t < 1_000_000_000_000 {
                                t * 1000
                            } else {
                                t
                            }
                        }),
                    })
                };
                ctx.account_usage(AccountUsage {
                    primary: window(&r["primary"]),
                    secondary: window(&r["secondary"]),
                    plan: r["planType"].as_str().map(str::to_string),
                    updated_at: now_ms(),
                });
            }
            "turn/started" => {
                *self.turn_id.lock() = p["turn"]["id"].as_str().map(str::to_string);
            }
            "turn/completed" => {
                *self.turn_id.lock() = None;
                *self.completed_turn.lock() = p["turn"]["id"].as_str().map(str::to_string);
                // Approvals from the finished turn can't be answered anymore.
                self.perms.lock().clear();
                let turn = &p["turn"];
                let outcome = match turn["status"].as_str() {
                    Some("interrupted") => TurnOutcome::Cancelled,
                    Some("failed") => TurnOutcome::Failed(error_message(&turn["error"])),
                    _ => TurnOutcome::Completed,
                };
                if let Some(next) = ctx.turn_finished(outcome) {
                    tokio::spawn(self.clone().start_turn(next));
                }
            }
            "error" if !p["willRetry"].as_bool().unwrap_or(false) => {
                tracing::info!("codex error: {}", error_message(&p["error"]));
            }
            _ => {}
        }
    }

    fn on_request(&self, rpc_id: Value, method: &str, p: &Value) -> bool {
        let options = |cmd: bool| {
            vec![
                PermissionOption {
                    id: "accept".into(),
                    name: "Allow".into(),
                    kind: PermissionOptionKind::AllowOnce,
                },
                PermissionOption {
                    id: "acceptForSession".into(),
                    name: if cmd {
                        "Allow for this session".into()
                    } else {
                        "Allow edits to these files for this session".into()
                    },
                    kind: PermissionOptionKind::AllowAlways,
                },
                PermissionOption {
                    id: "decline".into(),
                    name: "Deny".into(),
                    kind: PermissionOptionKind::RejectOnce,
                },
                PermissionOption {
                    id: "cancel".into(),
                    name: "Deny and stop".into(),
                    kind: PermissionOptionKind::RejectAlways,
                },
            ]
        };
        let item_id = p["itemId"].as_str().unwrap_or("");
        let reason = p["reason"].as_str().map(str::to_string);
        match method {
            "item/commandExecution/requestApproval" => {
                let command = p["command"].as_str().map(str::to_string).or_else(|| {
                    match self.ctx.tool_call_body(item_id) {
                        Some(ItemBody::ToolCall { command, .. }) => command,
                        _ => None,
                    }
                });
                let title = match (&command, &reason) {
                    (Some(c), _) => format!("Run {}", short(c, 120)),
                    (None, Some(r)) => r.clone(),
                    _ => "Run a command".into(),
                };
                let request_id = uuid::Uuid::new_v4().to_string();
                self.perms.lock().insert(request_id.clone(), rpc_id);
                self.ctx.permission_requested(
                    &request_id,
                    title,
                    Some(ToolKind::Execute),
                    command,
                    Vec::new(),
                    options(true),
                );
                true
            }
            "item/fileChange/requestApproval" => {
                let (diffs, locations) = match self.ctx.tool_call_body(item_id) {
                    Some(ItemBody::ToolCall {
                        diffs, locations, ..
                    }) => (diffs, locations),
                    _ => (Vec::new(), Vec::new()),
                };
                let title = match locations.as_slice() {
                    [] => reason.unwrap_or_else(|| "Edit files".into()),
                    [one] => format!("Edit {}", file_name(one)),
                    many => format!("Edit {} files", many.len()),
                };
                let request_id = uuid::Uuid::new_v4().to_string();
                self.perms.lock().insert(request_id.clone(), rpc_id);
                self.ctx.permission_requested(
                    &request_id,
                    title,
                    Some(ToolKind::Edit),
                    None,
                    diffs,
                    options(false),
                );
                true
            }
            _ => false,
        }
    }
}

async fn event_loop(
    driver: std::sync::Weak<CodexDriver>,
    peer: Arc<Peer>,
    ctx: Arc<AgentCtx>,
    mut rx: mpsc::UnboundedReceiver<Incoming>,
    generation: u64,
) {
    while let Some(msg) = rx.recv().await {
        match msg {
            Incoming::Notification { method, params } => {
                if let Some(d) = driver.upgrade() {
                    d.on_notification(&method, &params);
                }
            }
            Incoming::Request { id, method, params } => {
                let handled = match driver.upgrade() {
                    Some(d) => d.on_request(id.clone(), &method, &params),
                    None => false,
                };
                if !handled {
                    let _ = peer
                        .respond_error(id, -32601, &format!("{method} is not supported by Armada"))
                        .await;
                }
            }
            Incoming::Barrier(_) => {}
            Incoming::Closed => {
                ctx.process_exited(generation, peer.stderr_tail(8));
                break;
            }
        }
    }
}

/// Config overrides for a Codex thread: Armada's MCP servers under `mcp_servers`.
fn codex_config(servers: &[McpServer]) -> Value {
    let mut map = serde_json::Map::new();
    for s in servers.iter().filter(|s| s.enabled) {
        let key: String = s
            .name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        if key.is_empty() {
            continue;
        }
        let kv = |list: &[KeyValue]| -> Value {
            Value::Object(
                list.iter()
                    .map(|e| (e.name.clone(), Value::String(e.value.clone())))
                    .collect(),
            )
        };
        let entry = match s.transport {
            McpTransport::Stdio if !s.command.trim().is_empty() => {
                json!({ "command": s.command, "args": s.args, "env": kv(&s.env) })
            }
            McpTransport::Http if !s.url.trim().is_empty() => {
                json!({ "url": s.url, "http_headers": kv(&s.headers) })
            }
            _ => continue,
        };
        map.insert(key, entry);
    }
    if map.is_empty() {
        Value::Null
    } else {
        json!({ "mcp_servers": map })
    }
}

/// Codex reads attachments when the turn starts; anything older than a day is done.
fn prune_old_attachments(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let day = Duration::from_secs(24 * 60 * 60);
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > day);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn write_attachment(a: &Attachment) -> anyhow::Result<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(a.data.as_bytes())?;
    let ext = match a.mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "img",
    };
    let dir = std::env::temp_dir().join("armada-attachments");
    std::fs::create_dir_all(&dir)?;
    prune_old_attachments(&dir);
    let path = dir.join(format!("{}.{ext}", uuid::Uuid::new_v4()));
    std::fs::write(&path, bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

fn codex_status(s: Option<&str>, completed: bool) -> ToolStatus {
    match s {
        Some("completed") => ToolStatus::Completed,
        Some("failed") | Some("declined") => ToolStatus::Failed,
        Some("inProgress") => ToolStatus::InProgress,
        _ if completed => ToolStatus::Completed,
        _ => ToolStatus::InProgress,
    }
}

fn error_message(e: &Value) -> String {
    let msg = e["message"]
        .as_str()
        .unwrap_or("The turn failed")
        .to_string();
    let lower = msg.to_lowercase();
    if lower.contains("401") || lower.contains("unauthorized") || lower.contains("authentication") {
        format!("Sign-in required: open Accounts and sign in to this Codex account.\n\n{msg}")
    } else {
        msg
    }
}

fn short(s: &str, max: usize) -> String {
    let flat = s.replace('\n', " ");
    if flat.chars().count() > max {
        format!("{}…", flat.chars().take(max - 1).collect::<String>())
    } else {
        flat
    }
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}
