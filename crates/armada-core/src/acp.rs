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

use crate::jsonrpc::{looks_like_auth_error, Incoming, Peer, SpawnOptions};
use crate::model::*;
use crate::session::{AgentCtx, Prompt, StartCancelled, Steer, StreamKind, TurnOutcome};

const PROTOCOL_VERSION: i64 = 1;
const RESUME_TIMEOUT: Duration = Duration::from_secs(120);
/// ACP steering extension: puts a message into the running turn instead of
/// cancelling it (claude-agent-acp advertises it in `initialize`'s `_meta`).
const STEER_METHOD: &str = "_session/steering";
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
    /// Which process of this agent we drive (see `AgentCtx::retire_generation`).
    generation: u64,
    session_id: Mutex<String>,
    /// our request id → JSON-RPC id of the agent's `session/request_permission`
    perms: Mutex<HashMap<String, Value>>,
    /// our request id → (JSON-RPC id, requested schema) of an `elicitation/create`
    questions: Mutex<HashMap<String, (Value, Value)>>,
    accepts_images: std::sync::atomic::AtomicBool,
    /// The agent takes `_session/steering` (see `steer`).
    steering: std::sync::atomic::AtomicBool,
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
    pub env_remove: &'a [String],
    pub label: &'a str,
    pub children_file: Option<&'a Path>,
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
            env_remove: opts.env_remove,
            label: opts.label,
            children_file: opts.children_file,
        })?;
        // Registered so Stop/quit/delete can kill a hung handshake right away.
        let generation = ctx.begin_start_with(peer.clone());
        let result = Self::connect(ctx.clone(), &opts, peer.clone(), rx, generation).await;
        ctx.end_start(generation);
        match result {
            Ok(d) => Ok(d),
            Err(e) => {
                // Don't leave a half-started agent process behind; the caller reports.
                peer.kill().await;
                if ctx.start_cancelled(generation) {
                    Err(StartCancelled.into())
                } else {
                    Err(e)
                }
            }
        }
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
            generation,
            session_id: Mutex::new(String::new()),
            perms: Mutex::default(),
            questions: Mutex::default(),
            accepts_images: std::sync::atomic::AtomicBool::new(false),
            steering: std::sync::atomic::AtomicBool::new(false),
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
                        "terminal": false,
                        // Questions (Claude's AskUserQuestion, MCP servers' forms) as
                        // forms in the timeline; without this the adapter turns them off.
                        "elicitation": { "form": true }
                    },
                    "clientInfo": { "name": "armada", "title": "Armada", "version": opts.version }
                }),
                Some(Duration::from_secs(90)),
            )
            .await
            .map_err(|e| peer.with_stderr(e, 0))?;
        let caps = &init["agentCapabilities"];
        driver.accepts_images.store(
            caps["promptCapabilities"]["image"]
                .as_bool()
                .unwrap_or(false),
            std::sync::atomic::Ordering::Relaxed,
        );
        driver.steering.store(
            init["_meta"]["steering"]["supported"]
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
                ctx.set_replaying(generation, true);
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
                    .map_err(|e| auth_hint(peer.with_stderr(e, 0)))?;
                let id = resp["sessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow!("session/new returned no sessionId"))?
                    .to_string();
                (id, resp)
            }
        };
        *driver.session_id.lock() = session_id;
        driver.apply_session_config(&resp);
        ctx.set_steerable(driver.steerable());
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
                // Stopped, cancelled or replaced while waiting: never send it.
                if !me.ctx.is_current(me.generation) || !me.ctx.begin_turn(prompt.token) {
                    break;
                }
                me.ctx.checkpoint_before_turn().await;
                // Cancelled while the checkpoint ran: the prompt is never sent.
                if me.ctx.cancel_was_requested() && me.ctx.is_current(me.generation) {
                    match me
                        .ctx
                        .turn_finished_by(me.generation, TurnOutcome::Cancelled)
                    {
                        Some(next) => {
                            prompt = next;
                            continue;
                        }
                        None => break,
                    }
                }
                me.peer.mark_turn();
                let mark = me.peer.stderr_mark();
                let preamble = me.ctx.take_preamble();
                let body = match &preamble {
                    Some(pre) => format!("{pre}\n\n---\n\n{}", prompt.text),
                    None => prompt.text.clone(),
                };
                let blocks = me.blocks(body, &prompt.attachments);
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
                    // Some agents answer a cancelled prompt with an error.
                    Err(_) if me.ctx.cancel_was_requested() => TurnOutcome::Cancelled,
                    Err(e) => {
                        if let Some(pre) = preamble {
                            // The briefing never reached the agent; send it next time.
                            me.ctx.restore_preamble(pre);
                        }
                        TurnOutcome::Failed(format!(
                            "{:#}",
                            auth_hint(me.peer.with_stderr(e, mark))
                        ))
                    }
                };
                // The prompt reply overtakes queued updates; let the timeline catch up
                // so the turn ends after its last message.
                me.sync_events().await;
                if !me.ctx.is_current(me.generation) {
                    // Stopped meanwhile; the stop already settled the turn.
                    break;
                }
                match me.ctx.turn_finished_by(me.generation, outcome) {
                    Some(next) => {
                        // Approvals from the finished turn can't be answered anymore.
                        me.perms.lock().clear();
                        me.questions.lock().clear();
                        prompt = next;
                    }
                    None => {
                        // Requests from the finished turn can't be answered anymore.
                        me.perms.lock().clear();
                        me.questions.lock().clear();
                        break;
                    }
                }
            }
        });
    }

    /// The prompt's content blocks (images only when the agent takes them).
    fn blocks(&self, text: String, attachments: &[Attachment]) -> Vec<Value> {
        let mut blocks = vec![json!({ "type": "text", "text": text })];
        if !attachments.is_empty() {
            if self
                .accepts_images
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                for a in attachments {
                    blocks
                        .push(json!({ "type": "image", "mimeType": a.mime_type, "data": a.data }));
                }
            } else {
                self.ctx.notice(
                    NoticeLevel::Warn,
                    "This agent doesn't accept images, so only the text was sent.",
                );
            }
        }
        blocks
    }

    pub fn steerable(&self) -> bool {
        self.steering.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Sends a message into the running turn: the agent reads it at its next step
    /// and keeps going (a tool still running, e.g. a sub-agent, moves to the
    /// background) instead of the turn being cancelled.
    pub async fn steer(&self, prompt: &Prompt) -> anyhow::Result<Steer> {
        if !self.steerable() {
            return Ok(Steer::Unsupported);
        }
        let blocks = self.blocks(prompt.text.clone(), &prompt.attachments);
        let resp = self
            .peer
            .request_timeout(
                STEER_METHOD,
                json!({
                    "sessionId": self.session_id(),
                    "prompt": blocks,
                    // When the turn already ended, say so instead of starting one we
                    // wouldn't be tracking: the caller sends it as a normal prompt.
                    "_meta": { "steering": { "idleBehavior": "promptRequired" } }
                }),
                Some(Duration::from_secs(30)),
            )
            .await?;
        Ok(match resp["outcome"].as_str() {
            Some("promptRequired") => Steer::NotRunning,
            _ => Steer::Injected,
        })
    }

    /// Waits until the event loop has handled everything read before this call.
    async fn sync_events(&self) {
        if self.peer.is_closed() {
            return;
        }
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
        let questions: Vec<(String, (Value, Value))> = self.questions.lock().drain().collect();
        for (req, (rpc_id, _)) in questions {
            let _ = self
                .peer
                .respond(rpc_id, json!({ "action": "cancel" }))
                .await;
            self.ctx.question_resolved(&req, "cancelled", None);
        }
        self.peer
            .notify("session/cancel", json!({ "sessionId": self.session_id() }))
            .await
    }

    /// Answers a question (`None` skips it: the agent hears you didn't answer).
    pub async fn respond_question(
        &self,
        request_id: &str,
        answers: Option<serde_json::Map<String, Value>>,
    ) -> anyhow::Result<()> {
        let fields = self
            .ctx
            .pending_question_fields(request_id)
            .ok_or_else(|| anyhow!("This question is no longer waiting for an answer."))?;
        if let Some(a) = &answers {
            crate::questions::validate(&fields, a).map_err(|e| anyhow!(e))?;
        }
        let (rpc_id, schema) = self
            .questions
            .lock()
            .remove(request_id)
            .ok_or_else(|| anyhow!("This question is no longer waiting for an answer."))?;
        let reply = match &answers {
            Some(a) => json!({
                "action": "accept",
                "content": crate::questions::content_for_schema(&schema, a),
            }),
            None => json!({ "action": "decline" }),
        };
        if let Err(e) = self.peer.respond(rpc_id.clone(), reply).await {
            // Still answerable if the write failed (e.g. a transient pipe error).
            self.questions
                .lock()
                .insert(request_id.to_string(), (rpc_id, schema));
            return Err(e);
        }
        let resolution = if answers.is_some() {
            "answered"
        } else {
            "skipped"
        };
        self.ctx.question_resolved(request_id, resolution, answers);
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

    pub fn generation(&self) -> u64 {
        self.generation
    }

    fn handle_update(&self, u: &Value) {
        let ctx = &self.ctx;
        // A sub-agent's own text (Claude Code tags it with the Task call it runs
        // under) isn't part of the main conversation; its result arrives as that
        // call's output. Dropped here rather than merged into the main stream.
        let from_subagent = u["_meta"]["claudeCode"]["parentToolUseId"].is_string();
        match u["sessionUpdate"].as_str().unwrap_or("") {
            "agent_message_chunk" | "agent_thought_chunk" if from_subagent => {}
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
                // A replayed cost is already counted.
                let cost = if ctx.replaying() {
                    None
                } else {
                    u["cost"]["amount"].as_f64()
                };
                ctx.usage(u["used"].as_i64(), u["size"].as_i64(), cost);
                // Claude Code's rate-limit snapshot rides along in `_meta`.
                if !ctx.replaying() {
                    if let Some(usage) = parse_claude_rate_limit(&u["_meta"]["_claude/rateLimit"]) {
                        ctx.account_usage(usage);
                    }
                }
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

    /// Shows the agent's permission request. Returns false if it can't be shown
    /// (no choices offered); the caller then declines it.
    /// A form elicitation: Claude's AskUserQuestion (via claude-agent-acp) or an MCP
    /// server's form. Returns false when it can't be shown (the caller declines it).
    fn on_question(&self, rpc_id: Value, params: &Value) -> bool {
        // Only forms were advertised; a URL elicitation has no fields to show.
        if params["mode"].as_str().is_some_and(|m| m != "form") {
            return false;
        }
        let schema = params["requestedSchema"].clone();
        let fields = crate::questions::fields_from_schema(&schema);
        if fields.is_empty() {
            return false;
        }
        let message = params["message"]
            .as_str()
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .unwrap_or("The agent has a question")
            .to_string();
        let request_id = uuid::Uuid::new_v4().to_string();
        self.questions
            .lock()
            .insert(request_id.clone(), (rpc_id, schema));
        self.ctx
            .question_requested(&request_id, message, None, fields);
        true
    }

    fn on_permission_request(&self, rpc_id: Value, params: &Value) -> bool {
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
        let options: Vec<PermissionOption> = params["options"]
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
        if options.is_empty() {
            self.ctx.notice(
                NoticeLevel::Warn,
                format!("The agent asked to \u{201c}{title}\u{201d} without offering any choices, so Armada declined it."),
            );
            return false;
        }
        let mut diffs = Vec::new();
        collect_diffs(&tc["content"], &mut diffs);
        let command = raw_command(&tc["rawInput"]);
        let kind = tc["kind"].as_str().map(ToolKind::parse);
        self.perms.lock().insert(request_id.clone(), rpc_id);
        self.ctx
            .permission_requested(&request_id, title, kind, command, diffs, options);
        true
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
        // A retired process's leftovers must not touch the current turn.
        if !ctx.is_current(generation) && !matches!(msg, Incoming::Closed | Incoming::Barrier(_)) {
            continue;
        }
        match msg {
            Incoming::Notification { method, params } => {
                // History replayed by session/load is already in the timeline; only
                // timeline updates are skipped (commands, modes, config and usage
                // still apply).
                let skip = ctx.replaying() && is_timeline_update(&params["update"]);
                if method == "session/update" && !skip {
                    if let Some(d) = driver.upgrade() {
                        d.handle_update(&params["update"]);
                    }
                }
            }
            Incoming::Request { id, method, params } => match method.as_str() {
                "session/request_permission" => {
                    let shown = match driver.upgrade() {
                        Some(d) => d.on_permission_request(id.clone(), &params),
                        None => false,
                    };
                    if !shown {
                        let _ = peer
                            .respond(id, json!({ "outcome": { "outcome": "cancelled" } }))
                            .await;
                    }
                }
                "elicitation/create" => {
                    let shown = match driver.upgrade() {
                        Some(d) => d.on_question(id.clone(), &params),
                        None => false,
                    };
                    if !shown {
                        let _ = peer.respond(id, json!({ "action": "decline" })).await;
                    }
                }
                _ => {
                    let _ = peer
                        .respond_error(id, -32601, &format!("{method} is not supported by Armada"))
                        .await;
                }
            },
            Incoming::Barrier(REPLAY_DONE) => ctx.set_replaying(generation, false),
            Incoming::Barrier(n) => {
                if let Some(d) = driver.upgrade() {
                    if let Some(tx) = d.barriers.lock().remove(&n) {
                        let _ = tx.send(());
                    }
                }
            }
            Incoming::Closed => {
                ctx.process_exited(generation, peer.turn_stderr(8));
                // The agent exited on its own: make sure nothing it started lives on.
                peer.kill().await;
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
        env_remove: &[],
        label: "probe",
        children_file: None,
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
            .filter(|e| !crate::secrets::is_unresolved(&e.value))
            .map(|e| json!({ "name": e.name, "value": e.value }))
            .collect()
    };
    Value::Array(
        servers
            .iter()
            .filter(|s| s.enabled)
            .filter_map(|s| match s.transport {
                McpTransport::Stdio if !s.command.trim().is_empty() => {
                    let (command, args) = crate::childenv::mcp_launch(&s.command, &s.args);
                    Some(json!({
                        "name": s.name,
                        "command": command,
                        "args": args,
                        "env": kv(&s.env),
                    }))
                }
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

/// `session/update` kinds that add to the timeline (skipped while replaying).
fn is_timeline_update(u: &Value) -> bool {
    matches!(
        u["sessionUpdate"].as_str().unwrap_or(""),
        "agent_message_chunk"
            | "agent_thought_chunk"
            | "user_message_chunk"
            | "tool_call"
            | "tool_call_update"
            | "plan"
    )
}

fn auth_hint(e: anyhow::Error) -> anyhow::Error {
    if looks_like_auth_error(&format!("{e:#}")) {
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
        images,
        subagent,
        parent_tool_call_id,
        ..
    } = b
    else {
        return;
    };
    if let Some(content) = u["content"].as_array() {
        collect_images(content, images);
    }
    // Claude Code tags sub-agent launches (Agent/Task tool) and the tool calls a
    // sub-agent makes (parentToolUseId) in `_meta`.
    let meta = &u["_meta"]["claudeCode"];
    if let Some(parent) = meta["parentToolUseId"].as_str() {
        *parent_tool_call_id = Some(parent.to_string());
    }
    if matches!(meta["toolName"].as_str(), Some("Agent" | "Task")) {
        let sa = subagent.get_or_insert_with(SubAgent::default);
        let input = &u["rawInput"];
        if let Some(k) = input["subagent_type"].as_str() {
            sa.kind = Some(k.to_string());
        }
        if let Some(d) = input["description"].as_str() {
            sa.description = Some(d.to_string());
        }
        if let Some(p) = input["prompt"].as_str() {
            sa.prompt = Some(p.to_string());
        }
        // The adapter completes a background launch at once; the sub-agent runs on.
        if input["run_in_background"].as_bool() == Some(true) {
            sa.background = true;
        }
        *tool_kind = ToolKind::Think;
    }
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

/// Image blocks in tool output (e.g. a screenshot tool) become viewable images.
fn collect_images(content: &[Value], images: &mut Vec<Attachment>) {
    for c in content.iter().filter(|c| c["type"] == "content") {
        let block = &c["content"];
        if block["type"] != "image" {
            continue;
        }
        let (Some(data), Some(mime)) = (block["data"].as_str(), block["mimeType"].as_str()) else {
            continue;
        };
        if !mime.starts_with("image/")
            || data.len() > crate::files::MAX_IMAGE_BASE64
            || images.len() >= crate::files::MAX_IMAGES_PER_ITEM
            || images.iter().any(|i| i.data == data)
        {
            continue;
        }
        images.push(Attachment {
            name: format!("image-{}", images.len() + 1),
            mime_type: mime.to_string(),
            data: data.to_string(),
        });
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

/// Converts Claude Code's `rate_limit_info` (forwarded by the ACP adapter in a
/// `usage_update`'s `_meta["_claude/rateLimit"]`) into an account usage snapshot.
/// Utilization is a 0-1 fraction and `resetsAt` is unix seconds.
fn parse_claude_rate_limit(info: &Value) -> Option<AccountUsage> {
    fn window(w: &Value, mins: i64) -> Option<UsageWindow> {
        let util = w["utilization"].as_f64()?;
        Some(UsageWindow {
            used_percent: (util * 100.0).clamp(0.0, 100.0),
            window_mins: Some(mins),
            resets_at: w["resetsAt"].as_i64().map(
                |t| {
                    if t < 1_000_000_000_000 {
                        t * 1000
                    } else {
                        t
                    }
                },
            ),
        })
    }
    if !info.is_object() {
        return None;
    }
    let windows = &info["unifiedWindows"];
    let mut primary = window(&windows["five_hour"], 300);
    let mut secondary = window(&windows["seven_day"], 10080);
    if primary.is_none() && secondary.is_none() {
        // Older CLIs: only the window that triggered the event.
        match info["rateLimitType"].as_str() {
            Some("five_hour") => primary = window(info, 300),
            Some("seven_day") => secondary = window(info, 10080),
            _ => {}
        }
    }
    if primary.is_none() && secondary.is_none() {
        return None;
    }
    Some(AccountUsage {
        primary,
        secondary,
        plan: None,
        updated_at: now_ms(),
    })
}

#[cfg(test)]
mod rate_limit_tests {
    use super::*;

    const CAPTURED: &str = r#"{"status":"allowed","resetsAt":1793218200,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.01,"resetsAt":1793218200,"status":"allowed"},"seven_day":{"utilization":0.22,"resetsAt":1793746800,"status":"allowed"}}}"#;

    #[test]
    fn parses_unified_windows() {
        let v: Value = serde_json::from_str(CAPTURED).unwrap();
        let u = parse_claude_rate_limit(&v).unwrap();
        let p = u.primary.unwrap();
        assert!((p.used_percent - 1.0).abs() < 1e-6);
        assert_eq!(p.window_mins, Some(300));
        assert_eq!(p.resets_at, Some(1793218200000));
        let s = u.secondary.unwrap();
        assert!((s.used_percent - 22.0).abs() < 1e-6);
        assert_eq!(s.window_mins, Some(10080));
        assert_eq!(s.resets_at, Some(1793746800000));
        assert!(u.plan.is_none());
    }

    #[test]
    fn falls_back_to_top_level_window() {
        let v = json!({"rateLimitType":"seven_day","utilization":0.5,"resetsAt":1793746800});
        let u = parse_claude_rate_limit(&v).unwrap();
        assert!(u.primary.is_none());
        assert!((u.secondary.unwrap().used_percent - 50.0).abs() < 1e-6);
    }

    #[test]
    fn ignores_missing_or_unusable() {
        assert!(parse_claude_rate_limit(&Value::Null).is_none());
        assert!(
            parse_claude_rate_limit(&json!({"status":"allowed","rateLimitType":"five_hour"}))
                .is_none()
        );
    }
}

#[cfg(test)]
mod subagent_tests {
    use super::*;

    fn blank_tool() -> ItemBody {
        ItemBody::ToolCall {
            tool_call_id: "toolu_1".into(),
            title: String::new(),
            tool_kind: ToolKind::Other,
            status: ToolStatus::Pending,
            locations: Vec::new(),
            diffs: Vec::new(),
            output: String::new(),
            command: None,
            images: Vec::new(),
            subagent: None,
            parent_tool_call_id: None,
        }
    }

    fn sub(b: &ItemBody) -> Option<&SubAgent> {
        match b {
            ItemBody::ToolCall { subagent, .. } => subagent.as_ref(),
            _ => None,
        }
    }

    #[test]
    fn background_launch_is_flagged_and_stays_flagged_after_completion() {
        let mut b = blank_tool();
        apply_tool_fields(
            &mut b,
            &json!({
                "sessionUpdate": "tool_call", "toolCallId": "toolu_1", "title": "Agent",
                "status": "in_progress", "kind": "think",
                "rawInput": {"description": "Scan repo", "subagent_type": "Explore",
                              "prompt": "look around", "run_in_background": true},
                "_meta": {"claudeCode": {"toolName": "Agent"}}
            }),
        );
        let s = sub(&b).unwrap();
        assert!(s.background);
        assert_eq!(s.kind.as_deref(), Some("Explore"));
        // The completion carries no rawInput (as the adapter sends it): flag survives.
        apply_tool_fields(
            &mut b,
            &json!({
                "sessionUpdate": "tool_call_update", "toolCallId": "toolu_1", "status": "completed",
                "content": [{"type": "content", "content": {"type": "text",
                    "text": "Async agent launched successfully."}}],
                "_meta": {"claudeCode": {"toolName": "Agent"}}
            }),
        );
        let s = sub(&b).unwrap();
        assert!(s.background);
        assert!(matches!(
            &b,
            ItemBody::ToolCall {
                status: ToolStatus::Completed,
                ..
            }
        ));
    }

    #[test]
    fn foreground_launch_is_not_background() {
        let mut b = blank_tool();
        apply_tool_fields(
            &mut b,
            &json!({
                "sessionUpdate": "tool_call", "toolCallId": "toolu_1", "status": "in_progress",
                "rawInput": {"description": "x", "subagent_type": "general-purpose", "prompt": "p"},
                "_meta": {"claudeCode": {"toolName": "Task"}}
            }),
        );
        assert!(!sub(&b).unwrap().background);
    }
}
