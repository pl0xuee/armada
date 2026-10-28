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

use crate::jsonrpc::{looks_like_auth_error, Incoming, Peer, SpawnOptions};
use crate::model::*;
use crate::session::{AgentCtx, Prompt, StartCancelled, StreamKind, TurnOutcome};

/// What kind of server request a pending approval answers (they differ in the
/// response shape).
#[derive(Clone)]
enum PermKind {
    /// `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`.
    Decision,
    /// `item/permissions/requestApproval`: grant (a subset of) what was asked.
    Permissions(Value),
    /// Legacy `execCommandApproval` / `applyPatchApproval` (`ReviewDecision`).
    Legacy,
}

impl PermKind {
    /// The JSON-RPC result for the option the user picked (ids as in `options`).
    fn response(&self, option_id: &str) -> Value {
        match self {
            PermKind::Decision => json!({ "decision": option_id }),
            PermKind::Permissions(requested) => match option_id {
                "accept" => json!({ "permissions": requested, "scope": "turn" }),
                "acceptForSession" => json!({ "permissions": requested, "scope": "session" }),
                _ => json!({ "permissions": {} }),
            },
            PermKind::Legacy => match option_id {
                "accept" => json!({ "decision": "approved" }),
                "acceptForSession" => json!({ "decision": "approved_for_session" }),
                "decline" => {
                    json!({ "decision": { "denied": { "rejection": "The user declined this request." } } })
                }
                _ => json!({ "decision": "abort" }),
            },
        }
    }
}

/// How the event loop should answer a server request.
enum RequestReply {
    /// Shown to the user; answered later.
    Deferred,
    /// Answered right away with this result.
    Now(Value),
    Unsupported,
}

pub struct CodexDriver {
    peer: Arc<Peer>,
    ctx: Arc<AgentCtx>,
    /// Which process of this agent we drive (see `AgentCtx::retire_generation`).
    generation: u64,
    thread_id: String,
    turn_id: Mutex<Option<String>>,
    /// Sub-agent thread id → the collaborator item that started it.
    sub_threads: Mutex<HashMap<String, String>>,
    /// Sub-agent thread id → whether Codex last reported it still working. A
    /// `spawnAgent` call completes as soon as the thread exists, so this is what
    /// tells whether the sub-agent itself has finished.
    sub_running: Mutex<HashMap<String, bool>>,
    /// Last turn Codex reported complete (its `turn/start` reply can arrive later).
    completed_turn: Mutex<Option<String>>,
    /// Cancel was requested before Codex told us the turn id.
    cancel_requested: std::sync::atomic::AtomicBool,
    perms: Mutex<HashMap<String, (Value, PermKind)>>,
    /// Items from a sub-agent thread we didn't know yet: thread id → item ids,
    /// re-parented once the collaborator call naming that thread shows up.
    orphans: Mutex<HashMap<String, Vec<String>>>,
    approval_policy: Mutex<String>,
    attachments_dir: std::path::PathBuf,
    model: Mutex<Option<String>>,
    effort: Mutex<Option<String>>,
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
    /// Approval policy for a new thread ("on-request" = Auto, "untrusted" = ask
    /// first). A resumed thread keeps its own.
    pub approval_policy: &'a str,
    /// Where image attachments are written for Codex to read.
    pub attachments_dir: &'a Path,
    pub version: &'a str,
    pub mcp_servers: &'a [McpServer],
}

const APPROVAL_CHOICES: [(&str, &str, &str); 3] = [
    (
        "on-request",
        "Auto",
        "Works freely inside the workspace sandbox; asks only to go beyond it",
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
                    Err(auth_hint(peer.with_stderr(e, 0)))
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
                        "approvalPolicy": opts.approval_policy,
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
            generation,
            thread_id,
            turn_id: Mutex::new(None),
            sub_threads: Mutex::default(),
            sub_running: Mutex::default(),
            completed_turn: Mutex::new(None),
            cancel_requested: std::sync::atomic::AtomicBool::new(false),
            perms: Mutex::default(),
            orphans: Mutex::default(),
            approval_policy: Mutex::new(
                resp["approvalPolicy"]
                    .as_str()
                    .unwrap_or(opts.approval_policy)
                    .to_string(),
            ),
            attachments_dir: opts.attachments_dir.to_path_buf(),
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

    /// Runs `prompt`, then any queued prompt that follows a failed `turn/start`
    /// (a successful one continues via `turn/completed`).
    async fn start_turn(self: Arc<Self>, prompt: Prompt) {
        let mut next = Some(prompt);
        while let Some(prompt) = next {
            next = self.start_turn_once(prompt).await;
        }
    }

    async fn start_turn_once(&self, prompt: Prompt) -> Option<Prompt> {
        // Reset before the turn begins: a cancel from here on must stick.
        self.cancel_requested
            .store(false, std::sync::atomic::Ordering::SeqCst);
        *self.turn_id.lock() = None;
        // Stopped, cancelled or replaced while waiting: never send it.
        if !self.ctx.is_current(self.generation) || !self.ctx.begin_turn(prompt.token) {
            return None;
        }
        self.ctx.checkpoint_before_turn().await;
        self.peer.mark_turn();
        let mark = self.peer.stderr_mark();
        let preamble = self.ctx.take_preamble();
        let body = match &preamble {
            Some(pre) => format!("{pre}\n\n---\n\n{}", prompt.text),
            None => prompt.text.clone(),
        };
        let mut input = vec![json!({ "type": "text", "text": body })];
        for a in &prompt.attachments {
            // Codex takes images as local files.
            match write_attachment(&self.attachments_dir, a).await {
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
                if let Some(pre) = preamble {
                    // The briefing never reached Codex; send it with the next turn.
                    self.ctx.restore_preamble(pre);
                }
                if self.ctx.is_current(self.generation) {
                    let outcome = if self.ctx.cancel_was_requested() {
                        TurnOutcome::Cancelled
                    } else {
                        let e = auth_hint(self.peer.with_stderr(e, mark));
                        TurnOutcome::Failed(format!("{e:#}"))
                    };
                    return self.ctx.turn_finished_by(self.generation, outcome);
                }
            }
        }
        None
    }

    pub async fn cancel(&self) -> anyhow::Result<()> {
        let pending: Vec<(String, (Value, PermKind))> = self.perms.lock().drain().collect();
        for (req, (rpc_id, kind)) in pending {
            let _ = self.peer.respond(rpc_id, kind.response("cancel")).await;
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
        let (rpc_id, kind) = self
            .perms
            .lock()
            .remove(request_id)
            .ok_or_else(|| anyhow!("This approval is no longer pending."))?;
        self.peer.respond(rpc_id, kind.response(option_id)).await?;
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

    pub fn generation(&self) -> u64 {
        self.generation
    }

    fn on_item(&self, item: &Value, completed: bool, thread: Option<&str>) {
        let ctx = &self.ctx;
        let Some(id) = item["id"].as_str() else {
            return;
        };
        // Items from a sub-agent's thread nest under the call that started it; the
        // sub-agent's own messages/reasoning stay out of the main conversation.
        let sub_thread = thread.filter(|t| *t != self.thread_id);
        let parent = sub_thread.and_then(|t| self.sub_threads.lock().get(t).cloned());
        let from_sub_thread = sub_thread.is_some();
        if from_sub_thread
            && matches!(
                item["type"].as_str(),
                Some("agentMessage" | "reasoning" | "userMessage" | "plan")
            )
        {
            return;
        }
        self.on_item_body(item, completed, id);
        if ctx.tool_call_body(id).is_none() {
            return;
        }
        match (parent, sub_thread) {
            (Some(parent), _) => self.set_parent(id, parent),
            // Its collaborator call hasn't named this thread yet: remember it.
            (None, Some(t)) => {
                let mut orphans = self.orphans.lock();
                let list = orphans.entry(t.to_string()).or_default();
                if !list.iter().any(|x| x == id) {
                    list.push(id.to_string());
                }
            }
            (None, None) => {}
        }
    }

    fn set_parent(&self, item_id: &str, parent: String) {
        self.ctx.tool_call(item_id, |b| {
            if let ItemBody::ToolCall {
                parent_tool_call_id,
                ..
            } = b
            {
                *parent_tool_call_id = Some(parent);
            }
        });
    }

    fn on_item_body(&self, item: &Value, completed: bool, id: &str) {
        let ctx = &self.ctx;
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
                            // Renames: record the destination too, so both sides are committed.
                            if let Some(to) = c["kind"]["move_path"].as_str() {
                                locations.push(to.to_string());
                            }
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
                // Show the picture itself, not just its path.
                let image = crate::files::read_image_file(Path::new(&path)).ok();
                ctx.tool_call(id, |b| {
                    if let ItemBody::ToolCall {
                        title,
                        tool_kind,
                        status,
                        locations,
                        images,
                        ..
                    } = b
                    {
                        *title = format!("View image {}", file_name(&path));
                        *tool_kind = ToolKind::Read;
                        *status = ToolStatus::Completed;
                        *locations = vec![path.clone()];
                        if let Some(image) = image {
                            *images = vec![image];
                        }
                    }
                });
            }
            "collabAgentToolCall" | "subAgentActivity" => {
                let label = item["tool"]
                    .as_str()
                    .or_else(|| item["kind"].as_str())
                    .unwrap_or("Sub-agent")
                    .to_string();
                // Remember which threads belong to this sub-agent call, and adopt
                // items those threads produced before we knew.
                let adopted: Vec<String> = {
                    let mut threads = self.sub_threads.lock();
                    let mut orphans = self.orphans.lock();
                    let ids = item["receiverThreadIds"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .chain(item["agentThreadId"].as_str());
                    let mut adopted = Vec::new();
                    for t in ids {
                        threads.insert(t.to_string(), id.to_string());
                        adopted.extend(orphans.remove(t).unwrap_or_default());
                    }
                    adopted
                };
                let prompt = item["prompt"].as_str().map(str::to_string);
                let model = item["model"].as_str().map(str::to_string);
                let tool = item["tool"].as_str().unwrap_or("");
                // spawn/resume start a sub-agent; wait / close / send-input only
                // manage existing ones.
                let control = !tool.is_empty() && !matches!(tool, "spawnAgent" | "resumeAgent");
                let finished = self.record_sub_states(&item["agentsStates"]);
                let owned: Vec<String> = item["receiverThreadIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .chain(item["agentThreadId"].as_str())
                    .map(str::to_string)
                    .collect();
                let still_running = !control && self.any_running(&owned);
                ctx.tool_call(id, |b| {
                    if let ItemBody::ToolCall {
                        title,
                        tool_kind,
                        status,
                        subagent,
                        ..
                    } = b
                    {
                        let description = prompt
                            .as_deref()
                            .map(|p| short(p, 80))
                            .or_else(|| model.clone());
                        *title = description
                            .clone()
                            .unwrap_or_else(|| format!("Sub-agent: {label}"));
                        *tool_kind = ToolKind::Think;
                        *status = codex_status(item["status"].as_str(), completed);
                        // The call completing only means the thread was created.
                        if still_running && *status == ToolStatus::Completed {
                            *status = ToolStatus::InProgress;
                        }
                        *subagent = Some(SubAgent {
                            kind: Some(label.clone()),
                            description,
                            prompt: prompt.clone(),
                            background: false,
                            control,
                        });
                    }
                });
                // A `wait` (or any later call) can report that sub-agents started
                // by earlier calls have now finished: close those calls.
                self.close_finished_spawns(&finished, id);
                for child in adopted {
                    self.set_parent(&child, id.to_string());
                }
            }
            _ => {}
        }
    }

    /// Record the sub-agent states a collaborator call reports; returns the
    /// threads that are no longer working.
    fn record_sub_states(&self, states: &Value) -> Vec<String> {
        let mut finished = Vec::new();
        let Some(map) = states.as_object() else {
            return finished;
        };
        let mut running = self.sub_running.lock();
        for (thread, st) in map {
            let working = sub_state_working(st["status"].as_str());
            running.insert(thread.clone(), working);
            if !working {
                finished.push(thread.clone());
            }
        }
        finished
    }

    fn any_running(&self, threads: &[String]) -> bool {
        let running = self.sub_running.lock();
        threads
            .iter()
            .any(|t| running.get(t).copied().unwrap_or(false))
    }

    /// Mark spawn calls (other than `current`) completed once every thread they
    /// started has finished.
    fn close_finished_spawns(&self, finished: &[String], current: &str) {
        if finished.is_empty() {
            return;
        }
        let owners: Vec<(String, String)> = {
            let threads = self.sub_threads.lock();
            finished
                .iter()
                .filter_map(|t| threads.get(t).map(|c| (t.clone(), c.clone())))
                .collect()
        };
        for (_, call) in owners {
            if call == current {
                continue;
            }
            let siblings: Vec<String> = self
                .sub_threads
                .lock()
                .iter()
                .filter(|(_, c)| **c == call)
                .map(|(t, _)| t.clone())
                .collect();
            if self.any_running(&siblings) || self.ctx.tool_call_body(&call).is_none() {
                continue;
            }
            self.ctx.tool_call(&call, |b| {
                if let ItemBody::ToolCall { status, .. } = b {
                    if matches!(status, ToolStatus::InProgress | ToolStatus::Pending) {
                        *status = ToolStatus::Completed;
                    }
                }
            });
        }
    }

    fn on_notification(self: &Arc<Self>, method: &str, p: &Value) {
        let ctx = &self.ctx;
        // Turn-level events from sub-agent threads must not end or alter our turn,
        // and their text deltas aren't part of the main conversation.
        let other_thread = p["threadId"].as_str().is_some_and(|t| t != self.thread_id);
        if other_thread
            && !matches!(
                method,
                "item/started" | "item/completed" | "item/commandExecution/outputDelta"
            )
        {
            return;
        }
        match method {
            "item/started" => self.on_item(&p["item"], false, p["threadId"].as_str()),
            "item/completed" => self.on_item(&p["item"], true, p["threadId"].as_str()),
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
                // Spawn calls are kept open while their sub-agents run; none may outlive
                // the turn, or its card would spin on an idle agent.
                let mut calls: Vec<String> = self.sub_threads.lock().values().cloned().collect();
                calls.sort();
                calls.dedup();
                // (`tool_call` would create an item for an unknown id: only patch known ones.)
                for call in calls {
                    if self.ctx.tool_call_body(&call).is_none() {
                        continue;
                    }
                    self.ctx.tool_call(&call, |b| {
                        if let ItemBody::ToolCall { status, .. } = b {
                            if matches!(status, ToolStatus::InProgress | ToolStatus::Pending) {
                                *status = ToolStatus::Completed;
                            }
                        }
                    });
                }
                // Approvals from the finished turn can't be answered anymore.
                self.perms.lock().clear();
                let turn = &p["turn"];
                let outcome = match turn["status"].as_str() {
                    Some("interrupted") => TurnOutcome::Cancelled,
                    Some("failed") => TurnOutcome::Failed(error_message(&turn["error"])),
                    _ => TurnOutcome::Completed,
                };
                if let Some(next) = ctx.turn_finished_by(self.generation, outcome) {
                    tokio::spawn(self.clone().start_turn(next));
                }
            }
            "error" if !p["willRetry"].as_bool().unwrap_or(false) => {
                tracing::info!("codex error: {}", error_message(&p["error"]));
            }
            _ => {}
        }
    }

    fn on_request(&self, rpc_id: Value, method: &str, p: &Value) -> RequestReply {
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
                self.ask(
                    rpc_id,
                    PermKind::Decision,
                    title,
                    Some(ToolKind::Execute),
                    command,
                    Vec::new(),
                    options(true),
                );
                RequestReply::Deferred
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
                self.ask(
                    rpc_id,
                    PermKind::Decision,
                    title,
                    Some(ToolKind::Edit),
                    None,
                    diffs,
                    options(false),
                );
                RequestReply::Deferred
            }
            "item/permissions/requestApproval" => {
                let requested = p["permissions"].clone();
                let title = describe_permissions(&requested, reason.as_deref());
                let mut opts = options(true);
                // Granting can't be "deny and stop": the turn continues either way.
                opts.retain(|o| o.id != "cancel");
                self.ask(
                    rpc_id,
                    PermKind::Permissions(requested),
                    title,
                    None,
                    None,
                    Vec::new(),
                    opts,
                );
                RequestReply::Deferred
            }
            "execCommandApproval" => {
                let command = match &p["command"] {
                    Value::Array(a) => Some(
                        a.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(" "),
                    ),
                    Value::String(s) => Some(s.clone()),
                    _ => None,
                };
                let title = match (&command, &reason) {
                    (Some(c), _) => format!("Run {}", short(c, 120)),
                    (None, Some(r)) => r.clone(),
                    _ => "Run a command".into(),
                };
                self.ask(
                    rpc_id,
                    PermKind::Legacy,
                    title,
                    Some(ToolKind::Execute),
                    command,
                    Vec::new(),
                    options(true),
                );
                RequestReply::Deferred
            }
            "applyPatchApproval" => {
                let mut diffs = Vec::new();
                if let Some(changes) = p["fileChanges"].as_object() {
                    for (path, c) in changes {
                        let (old_text, new_text, unified) = match c["type"].as_str() {
                            Some("add") => (None, c["content"].as_str().map(str::to_string), None),
                            Some("delete") => {
                                (c["content"].as_str().map(str::to_string), None, None)
                            }
                            _ => (None, None, c["unified_diff"].as_str().map(str::to_string)),
                        };
                        diffs.push(FileDiff {
                            path: path.clone(),
                            old_text,
                            new_text,
                            unified,
                        });
                    }
                }
                let title = match diffs.as_slice() {
                    [] => reason.unwrap_or_else(|| "Edit files".into()),
                    [one] => format!("Edit {}", file_name(&one.path)),
                    many => format!("Edit {} files", many.len()),
                };
                self.ask(
                    rpc_id,
                    PermKind::Legacy,
                    title,
                    Some(ToolKind::Edit),
                    None,
                    diffs,
                    options(false),
                );
                RequestReply::Deferred
            }
            "item/tool/requestUserInput" => {
                let questions: Vec<String> = p["questions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|q| q["question"].as_str().or_else(|| q["header"].as_str()))
                    .map(|q| short(q, 200))
                    .collect();
                self.ctx.notice(
                    NoticeLevel::Warn,
                    format!(
                        "Codex asked for input Armada can't show yet: {}. It was answered with no input; tell the agent in your next message.",
                        if questions.is_empty() { "(no question text)".to_string() } else { questions.join(" / ") }
                    ),
                );
                RequestReply::Now(json!({ "answers": {} }))
            }
            "mcpServer/elicitation/request" => {
                let server = p["serverName"].as_str().unwrap_or("an MCP server");
                let message = p["message"].as_str().unwrap_or("");
                self.ctx.notice(
                    NoticeLevel::Warn,
                    format!(
                        "Codex asked for input Armada can't show yet: {server} wants {}. Armada declined it.",
                        if message.is_empty() { "more information".to_string() } else { format!("\u{201c}{}\u{201d}", short(message, 200)) }
                    ),
                );
                RequestReply::Now(json!({ "action": "decline", "content": null }))
            }
            _ => RequestReply::Unsupported,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn ask(
        &self,
        rpc_id: Value,
        kind: PermKind,
        title: String,
        tool_kind: Option<ToolKind>,
        command: Option<String>,
        diffs: Vec<FileDiff>,
        options: Vec<PermissionOption>,
    ) {
        let request_id = uuid::Uuid::new_v4().to_string();
        self.perms.lock().insert(request_id.clone(), (rpc_id, kind));
        self.ctx
            .permission_requested(&request_id, title, tool_kind, command, diffs, options);
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
        // A retired process's leftovers must not touch the current turn.
        if !ctx.is_current(generation) && !matches!(msg, Incoming::Closed | Incoming::Barrier(_)) {
            continue;
        }
        match msg {
            Incoming::Notification { method, params } => {
                if let Some(d) = driver.upgrade() {
                    d.on_notification(&method, &params);
                }
            }
            Incoming::Request { id, method, params } => {
                let reply = match driver.upgrade() {
                    Some(d) => d.on_request(id.clone(), &method, &params),
                    None => RequestReply::Unsupported,
                };
                match reply {
                    RequestReply::Deferred => {}
                    RequestReply::Now(result) => {
                        let _ = peer.respond(id, result).await;
                    }
                    RequestReply::Unsupported => {
                        let _ = peer
                            .respond_error(
                                id,
                                -32601,
                                &format!("{method} is not supported by Armada"),
                            )
                            .await;
                    }
                }
            }
            Incoming::Barrier(_) => {}
            Incoming::Closed => {
                ctx.process_exited(generation, peer.turn_stderr(8));
                // The agent exited on its own: make sure nothing it started lives on.
                peer.kill().await;
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
                let (command, args) = crate::childenv::mcp_launch(&s.command, &s.args);
                json!({ "command": command, "args": args, "env": kv(&s.env) })
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
/// Run at startup (blocking; call from `spawn_blocking`).
pub(crate) fn prune_old_attachments(dir: &Path) {
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

/// Writes an image for Codex to read into `dir` (private to the user: 0700).
async fn write_attachment(dir: &Path, a: &Attachment) -> anyhow::Result<String> {
    use base64::Engine;
    let data = a.data.clone();
    let bytes = tokio::task::spawn_blocking(move || {
        base64::engine::general_purpose::STANDARD.decode(data.as_bytes())
    })
    .await??;
    let ext = match a.mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "img",
    };
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(dir).await?;
    let path = dir.join(format!("{}.{ext}", uuid::Uuid::new_v4()));
    tokio::fs::write(&path, bytes).await?;
    Ok(path.to_string_lossy().into_owned())
}

/// Whether a Codex collaborator-agent state means the sub-agent is still working.
fn sub_state_working(status: Option<&str>) -> bool {
    matches!(status, Some("pendingInit" | "running"))
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
    if looks_like_auth_error(&msg) {
        format!("Sign-in required: open Accounts and sign in to this Codex account.\n\n{msg}")
    } else {
        msg
    }
}

fn auth_hint(e: anyhow::Error) -> anyhow::Error {
    if looks_like_auth_error(&format!("{e:#}")) {
        e.context("Sign-in required: open Accounts and sign in to this Codex account")
    } else {
        e
    }
}

/// Card title for an `item/permissions/requestApproval` (network / file access).
fn describe_permissions(p: &Value, reason: Option<&str>) -> String {
    let mut wants = Vec::new();
    if p["network"]["enabled"].as_bool() == Some(true) {
        wants.push("network access".to_string());
    }
    let fs = &p["fileSystem"];
    let paths = |key: &str| -> Vec<String> {
        fs[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    };
    let mut write = paths("write");
    let mut read = paths("read");
    for e in fs["entries"].as_array().into_iter().flatten() {
        let path = e["path"]["path"]
            .as_str()
            .or_else(|| e["path"]["pattern"].as_str())
            .map(str::to_string)
            .unwrap_or_else(|| "a special folder".into());
        match e["access"].as_str() {
            Some("write") => write.push(path),
            Some("read") => read.push(path),
            _ => {}
        }
    }
    if !write.is_empty() {
        wants.push(format!("write access to {}", short(&write.join(", "), 120)));
    }
    if !read.is_empty() {
        wants.push(format!("read access to {}", short(&read.join(", "), 120)));
    }
    match (wants.is_empty(), reason) {
        (true, Some(r)) => r.to_string(),
        (true, None) => "Allow more access".into(),
        (false, _) => format!("Allow {}", wants.join(" and ")),
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

#[cfg(test)]
mod subagent_state_tests {
    use super::*;

    #[test]
    fn working_states() {
        for s in ["pendingInit", "running"] {
            assert!(sub_state_working(Some(s)), "{s}");
        }
        for s in [
            "completed",
            "errored",
            "shutdown",
            "interrupted",
            "notFound",
        ] {
            assert!(!sub_state_working(Some(s)), "{s}");
        }
        assert!(!sub_state_working(None));
    }
}
