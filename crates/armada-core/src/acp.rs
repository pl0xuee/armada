//! Agent Client Protocol driver (Claude via claude-agent-acp, Grok via `grok agent stdio`,
//! and any other ACP agent). Spec: https://agentclientprotocol.com

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::anyhow;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::jsonrpc::{error_code, Incoming, Peer, SpawnOptions};
use crate::model::*;
use crate::session::{AgentCtx, Prompt, StreamKind, TurnOutcome};

const PROTOCOL_VERSION: i64 = 1;
const RESUME_TIMEOUT: Duration = Duration::from_secs(120);
const REPLAY_DONE: u64 = 1;
const FIRST_SYNC_BARRIER: u64 = 2;

#[derive(Clone, Copy)]
enum ConfigSource {
    ConfigOption,
    Mode,
    Model,
}

pub struct AcpDriver {
    peer: Arc<Peer>,
    ctx: Arc<AgentCtx>,
    session_id: Mutex<String>,
    /// our request id → JSON-RPC id of the agent's `session/request_permission`
    perms: Mutex<HashMap<String, Value>>,
    accepts_images: std::sync::atomic::AtomicBool,
    /// Barriers waiting for the event loop to catch up (see `sync_events`).
    barriers: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<()>>>,
    next_barrier: std::sync::atomic::AtomicU64,
    config_src: Mutex<HashMap<String, ConfigSource>>,
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

impl AcpDriver {
    pub async fn start(
        ctx: Arc<AgentCtx>,
        opts: StartOptions<'_>,
    ) -> anyhow::Result<Arc<AcpDriver>> {
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
    ) -> anyhow::Result<Arc<AcpDriver>> {
        let driver = Arc::new(AcpDriver {
            peer: peer.clone(),
            ctx: ctx.clone(),
            session_id: Mutex::new(String::new()),
            perms: Mutex::default(),
            accepts_images: std::sync::atomic::AtomicBool::new(false),
            barriers: Mutex::default(),
            next_barrier: std::sync::atomic::AtomicU64::new(FIRST_SYNC_BARRIER),
            config_src: Mutex::default(),
        });
        tokio::spawn(event_loop(
            Arc::downgrade(&driver),
            peer.clone(),
            ctx.clone(),
            rx,
            generation,
        ));

        let init = peer
            .request_timeout(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false
                    },
                    "clientInfo": { "name": "armada", "title": "Armada", "version": opts.version }
                }),
                Some(Duration::from_secs(90)),
            )
            .await
            .map_err(|e| with_stderr(e, &peer))?;
        let caps = &init["agentCapabilities"];
        driver.accepts_images.store(
            caps["promptCapabilities"]["image"]
                .as_bool()
                .unwrap_or(false),
            std::sync::atomic::Ordering::Relaxed,
        );
        let cwd = opts.cwd.to_string_lossy().into_owned();
        let mcp = mcp_json(opts.mcp_servers, caps);

        let mut session: Option<(String, Value)> = None;
        if let Some(prev) = opts.resume {
            let can_resume = caps["sessionCapabilities"].get("resume").is_some();
            let can_load = caps["loadSession"].as_bool().unwrap_or(false);
            let params = json!({ "sessionId": prev, "cwd": cwd, "mcpServers": mcp });
            let mut resumed = None;
            if can_resume {
                match peer
                    .request_timeout("session/resume", params.clone(), Some(RESUME_TIMEOUT))
                    .await
                {
                    Ok(v) => resumed = Some(v),
                    Err(e) => tracing::info!("session/resume failed, trying load: {e:#}"),
                }
            }
            if resumed.is_none() && can_load {
                // session/load replays the whole history as updates; we already have
                // it. The replay flag is cleared by a barrier that the event loop
                // reaches only after every replayed message was read.
                ctx.set_replaying(true);
                let r = peer
                    .request_timeout("session/load", params, Some(RESUME_TIMEOUT))
                    .await;
                peer.barrier(REPLAY_DONE);
                match r {
                    Ok(v) => resumed = Some(v),
                    Err(e) => tracing::info!("session/load failed: {e:#}"),
                }
            }
            match resumed {
                Some(v) => session = Some((prev.to_string(), v)),
                None => ctx.notice(
                    NoticeLevel::Warn,
                    "Couldn't reattach to the previous session, so Armada started a fresh one and will brief the agent with the conversation so far.",
                ),
            }
        }
        let (session_id, resp) = match session {
            Some(s) => s,
            None => {
                let resp = peer
                    .request_timeout(
                        "session/new",
                        json!({ "cwd": cwd, "mcpServers": mcp }),
                        Some(Duration::from_secs(120)),
                    )
                    .await
                    .map_err(|e| auth_hint(with_stderr(e, &peer)))?;
                let id = resp["sessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow!("session/new returned no sessionId"))?
                    .to_string();
                (id, resp)
            }
        };
        *driver.session_id.lock() = session_id;
        driver.apply_session_config(&resp);
        Ok(driver)
    }

    pub fn session_id(&self) -> String {
        self.session_id.lock().clone()
    }

    fn apply_session_config(&self, resp: &Value) {
        let mut options = Vec::new();
        let mut src = HashMap::new();
        if let Some(list) = resp["configOptions"].as_array() {
            for o in list {
                if let Some(opt) = parse_config_option(o) {
                    src.insert(opt.id.clone(), ConfigSource::ConfigOption);
                    options.push(opt);
                }
            }
        }
        let has_mode = options
            .iter()
            .any(|o| o.id == "mode" || o.category.as_deref() == Some("mode"));
        if !has_mode {
            if let Some(modes) = resp["modes"].as_object() {
                let choices: Vec<ConfigOptionChoice> = modes
                    .get("availableModes")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|m| {
                                Some(ConfigOptionChoice {
                                    value: m["id"].as_str()?.to_string(),
                                    name: m["name"].as_str().unwrap_or("").to_string(),
                                    description: m["description"].as_str().map(str::to_string),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if !choices.is_empty() {
                    src.insert("mode".into(), ConfigSource::Mode);
                    options.push(ConfigOption {
                        id: "mode".into(),
                        name: "Mode".into(),
                        category: Some("mode".into()),
                        current_value: modes
                            .get("currentModeId")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        options: choices,
                    });
                }
            }
        }
        if !options
            .iter()
            .any(|o| o.category.as_deref() == Some("model") || o.id == "model")
        {
            if let Some(models) = resp["models"].as_object() {
                let choices: Vec<ConfigOptionChoice> = models
                    .get("availableModels")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|m| {
                                Some(ConfigOptionChoice {
                                    value: m["modelId"].as_str()?.to_string(),
                                    name: m["name"].as_str().unwrap_or("").to_string(),
                                    description: m["description"].as_str().map(str::to_string),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if !choices.is_empty() {
                    src.insert("model".into(), ConfigSource::Model);
                    options.push(ConfigOption {
                        id: "model".into(),
                        name: "Model".into(),
                        category: Some("model".into()),
                        current_value: models
                            .get("currentModelId")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        options: choices,
                    });
                }
            }
        }
        if !options.is_empty() {
            *self.config_src.lock() = src;
            self.ctx.set_config_options(options);
        }
    }

    /// Starts a turn in the background; queued prompts run back to back.
    pub fn prompt(self: &Arc<Self>, prompt: Prompt) {
        let me = self.clone();
        tokio::spawn(async move {
            let mut prompt = prompt;
            loop {
                me.ctx.turn_started();
                let body = match me.ctx.take_preamble() {
                    Some(pre) => format!("{pre}\n\n---\n\n{}", prompt.text),
                    None => prompt.text.clone(),
                };
                let mut blocks = vec![json!({ "type": "text", "text": body })];
                if !prompt.attachments.is_empty() {
                    if me.accepts_images.load(std::sync::atomic::Ordering::Relaxed) {
                        for a in &prompt.attachments {
                            blocks.push(
                                json!({ "type": "image", "mimeType": a.mime_type, "data": a.data }),
                            );
                        }
                    } else {
                        me.ctx.notice(
                            NoticeLevel::Warn,
                            "This agent doesn't accept images, so only the text was sent.",
                        );
                    }
                }
                let res = me
                    .peer
                    .request(
                        "session/prompt",
                        json!({
                            "sessionId": me.session_id(),
                            "prompt": blocks
                        }),
                    )
                    .await;
                let outcome = match res {
                    Ok(v) => {
                        if let Some(t) = v["usage"]["totalTokens"].as_i64() {
                            me.ctx.add_tokens(t);
                        }
                        match v["stopReason"].as_str().unwrap_or("end_turn") {
                            "cancelled" => TurnOutcome::Cancelled,
                            "refusal" => TurnOutcome::Refused,
                            "max_tokens" => TurnOutcome::CompletedWithNote(
                                "Stopped: the model hit its output token limit.".into(),
                            ),
                            "max_turn_requests" => TurnOutcome::CompletedWithNote(
                                "Stopped: the agent reached its maximum number of steps for one turn.".into(),
                            ),
                            _ => TurnOutcome::Completed,
                        }
                    }
                    Err(e) => {
                        TurnOutcome::Failed(format!("{:#}", auth_hint(with_stderr(e, &me.peer))))
                    }
                };
                // The prompt reply overtakes queued updates; let the timeline catch up
                // so the turn ends after its last message.
                me.sync_events().await;
                match me.ctx.turn_finished(outcome) {
                    Some(next) => prompt = next,
                    None => {
                        // Requests from the finished turn can't be answered anymore.
                        me.perms.lock().clear();
                        break;
                    }
                }
            }
        });
    }

    /// Waits until the event loop has handled everything read before this call.
    async fn sync_events(&self) {
        let n = self
            .next_barrier
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.barriers.lock().insert(n, tx);
        self.peer.barrier(n);
        let _ = tokio::time::timeout(Duration::from_secs(10), rx).await;
        self.barriers.lock().remove(&n);
    }

    pub async fn cancel(&self) -> anyhow::Result<()> {
        let pending: Vec<(String, Value)> = self.perms.lock().drain().collect();
        for (req, rpc_id) in pending {
            let _ = self
                .peer
                .respond(rpc_id, json!({ "outcome": { "outcome": "cancelled" } }))
                .await;
            self.ctx.permission_resolved(&req, "cancelled");
        }
        self.peer
            .notify("session/cancel", json!({ "sessionId": self.session_id() }))
            .await
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
            .respond(
                rpc_id,
                json!({ "outcome": { "outcome": "selected", "optionId": option_id } }),
            )
            .await?;
        self.ctx.permission_resolved(request_id, option_id);
        Ok(())
    }

    pub async fn set_config(&self, option_id: &str, value: &str) -> anyhow::Result<()> {
        let source = self
            .config_src
            .lock()
            .get(option_id)
            .copied()
            .unwrap_or(ConfigSource::ConfigOption);
        let sid = self.session_id();
        match source {
            ConfigSource::ConfigOption => {
                let resp = self
                    .peer
                    .request(
                        "session/set_config_option",
                        json!({ "sessionId": sid, "configId": option_id, "value": value }),
                    )
                    .await?;
                if resp["configOptions"].is_array() {
                    self.apply_session_config(&resp);
                    return Ok(());
                }
            }
            ConfigSource::Mode => {
                self.peer
                    .request(
                        "session/set_mode",
                        json!({ "sessionId": sid, "modeId": value }),
                    )
                    .await?;
            }
            ConfigSource::Model => {
                self.peer
                    .request(
                        "session/set_model",
                        json!({ "sessionId": sid, "modelId": value }),
                    )
                    .await?;
            }
        }
        self.ctx.set_config_value(option_id, value);
        Ok(())
    }

    pub async fn shutdown(&self) {
        self.peer.kill().await;
    }

    pub fn is_closed(&self) -> bool {
        self.peer.is_closed()
    }

    fn handle_update(&self, u: &Value) {
        let ctx = &self.ctx;
        match u["sessionUpdate"].as_str().unwrap_or("") {
            "agent_message_chunk" => {
                if let Some(t) = content_text(&u["content"]) {
                    ctx.append_text(StreamKind::Message, None, &t);
                }
            }
            "agent_thought_chunk" => {
                if let Some(t) = content_text(&u["content"]) {
                    ctx.append_text(StreamKind::Thought, None, &t);
                }
            }
            "tool_call" | "tool_call_update" => {
                let Some(id) = u["toolCallId"].as_str() else {
                    return;
                };
                ctx.tool_call(id, |b| apply_tool_fields(b, u));
            }
            "plan" => {
                let entries = u["entries"]
                    .as_array()
                    .map(|a| a.iter().map(parse_plan_entry).collect())
                    .unwrap_or_default();
                ctx.plan(entries);
            }
            "usage_update" => {
                ctx.usage(
                    u["used"].as_i64(),
                    u["size"].as_i64(),
                    u["cost"]["amount"].as_f64(),
                );
            }
            "session_info_update" => {
                if let Some(t) = u["title"].as_str() {
                    ctx.set_title_suggestion(t);
                }
            }
            "available_commands_update" => {
                let commands = u["availableCommands"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|c| {
                                Some(SlashCommand {
                                    name: c["name"].as_str()?.trim_start_matches('/').to_string(),
                                    description: c["description"].as_str().map(str::to_string),
                                    hint: c["input"]["hint"].as_str().map(str::to_string),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                ctx.set_commands(commands);
            }
            "current_mode_update" => {
                if let Some(m) = u["currentModeId"].as_str() {
                    ctx.set_config_value("mode", m);
                }
            }
            "config_option_update" | "config_options_update" if u["configOptions"].is_array() => {
                self.apply_session_config(u);
            }
            _ => {}
        }
    }

    fn on_permission_request(&self, rpc_id: Value, params: &Value) {
        let tc = &params["toolCall"];
        let request_id = uuid::Uuid::new_v4().to_string();
        let title = tc["title"]
            .as_str()
            .map(str::to_string)
            .or_else(|| {
                tc["toolCallId"]
                    .as_str()
                    .and_then(|id| match self.ctx.tool_call_body(id) {
                        Some(ItemBody::ToolCall { title, .. }) => Some(title),
                        _ => None,
                    })
            })
            .unwrap_or_else(|| "The agent wants to perform an action".into());
        let options = params["options"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|o| {
                        Some(PermissionOption {
                            id: o["optionId"].as_str()?.to_string(),
                            name: o["name"].as_str().unwrap_or("Option").to_string(),
                            kind: PermissionOptionKind::parse(o["kind"].as_str().unwrap_or("")),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut diffs = Vec::new();
        collect_diffs(&tc["content"], &mut diffs);
        let command = raw_command(&tc["rawInput"]);
        let kind = tc["kind"].as_str().map(ToolKind::parse);
        self.perms.lock().insert(request_id.clone(), rpc_id);
        self.ctx
            .permission_requested(&request_id, title, kind, command, diffs, options);
    }
}

async fn event_loop(
    driver: std::sync::Weak<AcpDriver>,
    peer: Arc<Peer>,
    ctx: Arc<AgentCtx>,
    mut rx: mpsc::UnboundedReceiver<Incoming>,
    generation: u64,
) {
    while let Some(msg) = rx.recv().await {
        match msg {
            Incoming::Notification { method, params } => {
                if method == "session/update" && !ctx.replaying() {
                    if let Some(d) = driver.upgrade() {
                        d.handle_update(&params["update"]);
                    }
                }
            }
            Incoming::Request { id, method, params } => match method.as_str() {
                "session/request_permission" => match driver.upgrade() {
                    Some(d) => d.on_permission_request(id, &params),
                    None => {
                        let _ = peer
                            .respond(id, json!({ "outcome": { "outcome": "cancelled" } }))
                            .await;
                    }
                },
                _ => {
                    let _ = peer
                        .respond_error(id, -32601, &format!("{method} is not supported by Armada"))
                        .await;
                }
            },
            Incoming::Barrier(REPLAY_DONE) => ctx.set_replaying(false),
            Incoming::Barrier(n) => {
                if let Some(d) = driver.upgrade() {
                    if let Some(tx) = d.barriers.lock().remove(&n) {
                        let _ = tx.send(());
                    }
                }
            }
            Incoming::Closed => {
                ctx.process_exited(generation, peer.stderr_tail(8));
                break;
            }
        }
    }
}

/// Starts an ACP agent, completes `initialize`, and describes who answered.
pub async fn probe(
    program: &Path,
    args: &[String],
    env: &[(String, String)],
    cwd: &Path,
) -> anyhow::Result<String> {
    let (peer, _rx) = Peer::spawn(SpawnOptions {
        program,
        args,
        cwd,
        env,
        label: "probe",
    })?;
    let res = peer
        .request_timeout(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                "clientInfo": { "name": "armada", "title": "Armada", "version": env!("CARGO_PKG_VERSION") }
            }),
            Some(Duration::from_secs(30)),
        )
        .await;
    let tail = peer.stderr_tail(4);
    peer.kill().await;
    let init = res.map_err(|e| {
        if tail.trim().is_empty() {
            e
        } else {
            e.context(format!("agent output:\n{tail}"))
        }
    })?;
    let info = &init["agentInfo"];
    let name = info["title"]
        .as_str()
        .or_else(|| info["name"].as_str())
        .unwrap_or("ACP agent");
    let version = info["version"]
        .as_str()
        .map(|v| format!(" {v}"))
        .unwrap_or_default();
    let protocol = init["protocolVersion"].as_i64().unwrap_or(PROTOCOL_VERSION);
    Ok(format!("{name}{version} (ACP v{protocol})"))
}

/// MCP servers in ACP's wire format (HTTP ones only if the agent supports them).
fn mcp_json(servers: &[McpServer], caps: &Value) -> Value {
    let http_ok = caps["mcpCapabilities"]["http"].as_bool().unwrap_or(false);
    let kv = |list: &[KeyValue]| -> Vec<Value> {
        list.iter()
            .map(|e| json!({ "name": e.name, "value": e.value }))
            .collect()
    };
    Value::Array(
        servers
            .iter()
            .filter(|s| s.enabled)
            .filter_map(|s| match s.transport {
                McpTransport::Stdio if !s.command.trim().is_empty() => Some(json!({
                    "name": s.name,
                    "command": s.command,
                    "args": s.args,
                    "env": kv(&s.env),
                })),
                McpTransport::Http if http_ok && !s.url.trim().is_empty() => Some(json!({
                    "type": "http",
                    "name": s.name,
                    "url": s.url,
                    "headers": kv(&s.headers),
                })),
                _ => None,
            })
            .collect(),
    )
}

fn with_stderr(e: anyhow::Error, peer: &Peer) -> anyhow::Error {
    let tail = peer.stderr_tail(6);
    if tail.trim().is_empty() || error_code(&e).is_some_and(|c| c != -32099) {
        e
    } else {
        e.context(format!("agent output:\n{tail}"))
    }
}

fn auth_hint(e: anyhow::Error) -> anyhow::Error {
    let text = format!("{e:#}").to_lowercase();
    if text.contains("auth") || text.contains("login") || text.contains("401") {
        e.context("Sign-in required: open Accounts and sign in to this account")
    } else {
        e
    }
}

fn content_text(c: &Value) -> Option<String> {
    match c["type"].as_str() {
        Some("text") => c["text"].as_str().map(str::to_string),
        Some("resource_link") => c["uri"].as_str().map(|u| format!("[{u}]")),
        _ => None,
    }
}

fn raw_command(raw: &Value) -> Option<String> {
    match &raw["command"] {
        Value::String(s) => Some(s.clone()),
        Value::Array(a) => Some(
            a.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" "),
        ),
        _ => None,
    }
}

fn collect_diffs(content: &Value, out: &mut Vec<FileDiff>) {
    if let Some(list) = content.as_array() {
        for c in list {
            if c["type"] == "diff" {
                if let Some(path) = c["path"].as_str() {
                    out.retain(|d| d.path != path);
                    out.push(FileDiff {
                        path: path.to_string(),
                        old_text: c["oldText"].as_str().map(str::to_string),
                        new_text: c["newText"].as_str().map(str::to_string),
                        unified: None,
                    });
                }
            }
        }
    }
}

fn apply_tool_fields(b: &mut ItemBody, u: &Value) {
    let ItemBody::ToolCall {
        title,
        tool_kind,
        status,
        locations,
        diffs,
        output,
        command,
        ..
    } = b
    else {
        return;
    };
    if let Some(t) = u["title"].as_str() {
        *title = t.to_string();
    }
    if let Some(k) = u["kind"].as_str() {
        *tool_kind = ToolKind::parse(k);
    }
    if let Some(s) = u["status"].as_str() {
        *status = ToolStatus::parse(s);
    }
    if let Some(locs) = u["locations"].as_array() {
        for l in locs {
            if let Some(p) = l["path"].as_str() {
                if !locations.iter().any(|x| x == p) {
                    locations.push(p.to_string());
                }
            }
        }
    }
    if let Some(cmd) = raw_command(&u["rawInput"]) {
        *command = Some(cmd);
    }
    if let Some(content) = u["content"].as_array() {
        collect_diffs(&u["content"], diffs);
        let text: Vec<String> = content
            .iter()
            .filter(|c| c["type"] == "content")
            .filter_map(|c| content_text(&c["content"]))
            .collect();
        if !text.is_empty() {
            *output = text.join("\n");
        }
    }
    if output.is_empty() {
        match &u["rawOutput"] {
            Value::String(s) => *output = s.clone(),
            Value::Null => {}
            Value::Object(o) => {
                if let Some(s) = o
                    .get("output")
                    .or_else(|| o.get("stdout"))
                    .and_then(Value::as_str)
                {
                    *output = s.to_string();
                }
            }
            _ => {}
        }
    }
}

fn parse_plan_entry(e: &Value) -> PlanEntry {
    PlanEntry {
        content: e["content"].as_str().unwrap_or("").to_string(),
        status: match e["status"].as_str() {
            Some("in_progress") => PlanStatus::InProgress,
            Some("completed") => PlanStatus::Completed,
            _ => PlanStatus::Pending,
        },
        priority: match e["priority"].as_str() {
            Some("high") => Some(PlanPriority::High),
            Some("medium") => Some(PlanPriority::Medium),
            Some("low") => Some(PlanPriority::Low),
            _ => None,
        },
    }
}

fn parse_config_option(o: &Value) -> Option<ConfigOption> {
    if o["type"].as_str().is_some_and(|t| t != "select") {
        return None;
    }
    let mut choices = Vec::new();
    fn walk(list: &Value, out: &mut Vec<ConfigOptionChoice>) {
        if let Some(a) = list.as_array() {
            for c in a {
                if c["options"].is_array() {
                    walk(&c["options"], out);
                } else if let Some(v) = c["value"].as_str() {
                    out.push(ConfigOptionChoice {
                        value: v.to_string(),
                        name: c["name"].as_str().unwrap_or(v).to_string(),
                        description: c["description"].as_str().map(str::to_string),
                    });
                }
            }
        }
    }
    walk(&o["options"], &mut choices);
    Some(ConfigOption {
        id: o["id"].as_str()?.to_string(),
        name: o["name"].as_str().unwrap_or("Option").to_string(),
        category: o["category"].as_str().map(str::to_string),
        current_value: o["currentValue"].as_str().unwrap_or("").to_string(),
        options: choices,
    })
}
