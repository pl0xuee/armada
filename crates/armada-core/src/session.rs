//! Per-agent timeline + status bookkeeping. Protocol drivers (ACP, Codex) translate
//! wire messages into calls on `AgentCtx`, which persists items, emits UI events and
//! raises attention.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::manager::WeakCore;
use crate::model::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamKind {
    Message,
    Thought,
}

/// Why the adapter process is going away, so its exit isn't reported as a crash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitIntent {
    None,
    Stop,
    Shutdown,
}

/// What the user asked for: text plus optional images.
#[derive(Debug, Clone)]
pub struct Prompt {
    pub text: String,
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Clone)]
pub enum TurnOutcome {
    Completed,
    /// Ended normally but with a caveat worth showing (e.g. max tokens).
    CompletedWithNote(String),
    Cancelled,
    Refused,
    Failed(String),
}

const FLUSH_EVERY: Duration = Duration::from_millis(400);
const MAX_OUTPUT: usize = 64 * 1024;

struct CtxState {
    seq: i64,
    /// Items created or touched while this app instance has been running.
    items: HashMap<String, TimelineItem>,
    /// Item currently receiving streamed text without a provider item id.
    stream: Option<(String, StreamKind)>,
    /// Provider-side ids (tool call ids, Codex item ids, permission ids) → our item ids.
    ext: HashMap<String, String>,
    dirty: HashSet<String>,
    last_flush: Instant,
    turn_active: bool,
    queue: VecDeque<Prompt>,
    pending_permissions: HashSet<String>,
    /// Context to prepend to the next prompt (used when a session could not be resumed).
    preamble: Option<String>,
    replaying: bool,
    /// Which adapter process is current; exits from older ones are ignored.
    generation: u64,
    exit_intent: ExitIntent,
    /// The current process is still in its handshake (start errors are reported
    /// by the starter, not by the exit handler).
    starting: bool,
    /// Stop/cancel arrived while the process was starting; don't run the prompt.
    start_cancelled: bool,
}

pub struct AgentCtx {
    pub agent_id: String,
    core: WeakCore,
    st: Mutex<CtxState>,
}

impl AgentCtx {
    pub(crate) fn new(core: WeakCore, agent_id: String, seq: i64) -> AgentCtx {
        AgentCtx {
            agent_id,
            core,
            st: Mutex::new(CtxState {
                seq,
                items: HashMap::new(),
                stream: None,
                ext: HashMap::new(),
                dirty: HashSet::new(),
                last_flush: Instant::now(),
                turn_active: false,
                queue: VecDeque::new(),
                pending_permissions: HashSet::new(),
                preamble: None,
                replaying: false,
                generation: 0,
                exit_intent: ExitIntent::None,
                starting: false,
                start_cancelled: false,
            }),
        }
    }

    fn persist(&self, item: &TimelineItem) {
        if let Some(core) = self.core.upgrade() {
            if let Err(e) = core.db().put_item(item) {
                tracing::warn!("persisting item: {e:#}");
            }
        }
    }

    fn emit(&self, event: ArmadaEvent) {
        if let Some(core) = self.core.upgrade() {
            core.emit(event);
        }
    }

    fn update_agent(&self, f: impl FnOnce(&mut Agent)) -> Option<Agent> {
        self.core.upgrade()?.update_agent(&self.agent_id, f).ok()
    }

    fn attention(&self, reason: AttentionReason, body: String, request_id: Option<&str>) {
        if let Some(core) = self.core.upgrade() {
            let title = core
                .agent(&self.agent_id)
                .map(|a| a.title)
                .unwrap_or_else(|_| "Agent".into());
            core.emit(ArmadaEvent::Attention {
                agent_id: self.agent_id.clone(),
                reason,
                title,
                body,
                request_id: request_id.map(str::to_string),
            });
        }
    }

    // ---- replay / preamble --------------------------------------------------

    pub fn set_replaying(&self, on: bool) {
        self.st.lock().replaying = on;
    }

    pub fn replaying(&self) -> bool {
        self.st.lock().replaying
    }

    pub fn set_preamble(&self, text: String) {
        self.st.lock().preamble = Some(text);
    }

    pub fn take_preamble(&self) -> Option<String> {
        self.st.lock().preamble.take()
    }

    // ---- items --------------------------------------------------------------

    fn flush_locked(&self, st: &mut CtxState) {
        for id in st.dirty.drain().collect::<Vec<_>>() {
            if let Some(item) = st.items.get(&id) {
                self.persist(item);
            }
        }
        st.last_flush = Instant::now();
    }

    pub fn flush(&self) {
        let mut st = self.st.lock();
        self.flush_locked(&mut st);
    }

    fn push_locked(&self, st: &mut CtxState, body: ItemBody) -> String {
        self.flush_locked(st);
        st.seq += 1;
        let item = TimelineItem {
            id: uuid::Uuid::new_v4().to_string(),
            agent_id: self.agent_id.clone(),
            seq: st.seq,
            ts: now_ms(),
            body,
        };
        let id = item.id.clone();
        self.persist(&item);
        self.emit(ArmadaEvent::ItemUpserted { item: item.clone() });
        st.items.insert(id.clone(), item);
        id
    }

    /// Appends a new item and ends any in-progress text stream.
    pub fn push(&self, body: ItemBody) -> String {
        let mut st = self.st.lock();
        st.stream = None;
        self.push_locked(&mut st, body)
    }

    pub fn notice(&self, level: NoticeLevel, text: impl Into<String>) {
        self.push(ItemBody::Notice {
            level,
            text: text.into(),
        });
    }

    fn update_locked(&self, st: &mut CtxState, id: &str, f: impl FnOnce(&mut ItemBody)) {
        if let Some(item) = st.items.get_mut(id) {
            f(&mut item.body);
            let item = item.clone();
            st.dirty.remove(id);
            self.persist(&item);
            self.emit(ArmadaEvent::ItemUpserted { item });
        }
    }

    /// Streams text into the current message/thought. `ext_id` (Codex item ids)
    /// pins the delta to a specific item; without it consecutive chunks of the same
    /// kind are merged.
    pub fn append_text(&self, kind: StreamKind, ext_id: Option<&str>, delta: &str) {
        if delta.is_empty() {
            return;
        }
        let mut st = self.st.lock();
        if st.replaying {
            return;
        }
        let existing = match ext_id {
            Some(ext) => st.ext.get(ext).cloned(),
            None => st
                .stream
                .as_ref()
                .filter(|(_, k)| *k == kind)
                .map(|(id, _)| id.clone()),
        };
        let id = match existing {
            Some(id) if st.items.contains_key(&id) => id,
            _ => {
                let body = match kind {
                    StreamKind::Message => ItemBody::AgentMessage {
                        text: String::new(),
                    },
                    StreamKind::Thought => ItemBody::Thought {
                        text: String::new(),
                    },
                };
                let id = self.push_locked(&mut st, body);
                if let Some(ext) = ext_id {
                    st.ext.insert(ext.to_string(), id.clone());
                }
                id
            }
        };
        st.stream = Some((id.clone(), kind));
        if let Some(item) = st.items.get_mut(&id) {
            if let ItemBody::AgentMessage { text } | ItemBody::Thought { text } = &mut item.body {
                text.push_str(delta);
            }
        }
        st.dirty.insert(id.clone());
        self.emit(ArmadaEvent::TextDelta {
            agent_id: self.agent_id.clone(),
            item_id: id,
            field: DeltaField::Text,
            delta: delta.to_string(),
        });
        if st.last_flush.elapsed() > FLUSH_EVERY {
            self.flush_locked(&mut st);
        }
        if kind == StreamKind::Message {
            drop(st);
            self.touch_preview(None);
        }
    }

    /// Replaces the full text of a streamed item (Codex sends the final text on completion).
    pub fn finish_text(&self, kind: StreamKind, ext_id: &str, full: &str) {
        let mut st = self.st.lock();
        let Some(id) = st.ext.get(ext_id).cloned() else {
            drop(st);
            if !full.is_empty() {
                self.append_text(kind, Some(ext_id), full);
            }
            return;
        };
        let changed = matches!(
            st.items.get(&id).map(|i| &i.body),
            Some(ItemBody::AgentMessage { text } | ItemBody::Thought { text }) if text != full
        );
        if changed && !full.is_empty() {
            let full = full.to_string();
            self.update_locked(&mut st, &id, |b| {
                if let ItemBody::AgentMessage { text } | ItemBody::Thought { text } = b {
                    *text = full;
                }
            });
        }
        if st.stream.as_ref().is_some_and(|(s, _)| *s == id) {
            st.stream = None;
        }
    }

    /// Creates the tool call item on first sight, then applies `patch`.
    pub fn tool_call(&self, ext_id: &str, patch: impl FnOnce(&mut ItemBody)) {
        let mut st = self.st.lock();
        if st.replaying {
            return;
        }
        let id = match st.ext.get(ext_id).cloned() {
            Some(id) if st.items.contains_key(&id) => id,
            _ => {
                st.stream = None;
                let id = self.push_locked(
                    &mut st,
                    ItemBody::ToolCall {
                        tool_call_id: ext_id.to_string(),
                        title: "Working…".into(),
                        tool_kind: ToolKind::Other,
                        status: ToolStatus::Pending,
                        locations: Vec::new(),
                        diffs: Vec::new(),
                        output: String::new(),
                        command: None,
                    },
                );
                st.ext.insert(ext_id.to_string(), id.clone());
                id
            }
        };
        self.update_locked(&mut st, &id, |b| {
            patch(b);
            if let ItemBody::ToolCall { output, .. } = b {
                truncate_output(output);
            }
        });
    }

    pub fn append_tool_output(&self, ext_id: &str, delta: &str) {
        let mut st = self.st.lock();
        let Some(id) = st.ext.get(ext_id).cloned() else {
            return;
        };
        let mut grew = false;
        if let Some(item) = st.items.get_mut(&id) {
            if let ItemBody::ToolCall { output, .. } = &mut item.body {
                if output.len() < MAX_OUTPUT {
                    output.push_str(delta);
                    grew = true;
                }
            }
        }
        if grew {
            st.dirty.insert(id.clone());
            self.emit(ArmadaEvent::TextDelta {
                agent_id: self.agent_id.clone(),
                item_id: id,
                field: DeltaField::Output,
                delta: delta.to_string(),
            });
            if st.last_flush.elapsed() > FLUSH_EVERY {
                self.flush_locked(&mut st);
            }
        }
    }

    pub fn tool_call_body(&self, ext_id: &str) -> Option<ItemBody> {
        let st = self.st.lock();
        let id = st.ext.get(ext_id)?;
        st.items.get(id).map(|i| i.body.clone())
    }

    /// One plan item per turn, updated in place.
    pub fn plan(&self, entries: Vec<PlanEntry>) {
        let mut st = self.st.lock();
        if st.replaying {
            return;
        }
        match st.ext.get("__plan__").cloned() {
            Some(id) if st.items.contains_key(&id) => {
                self.update_locked(&mut st, &id, |b| {
                    if let ItemBody::Plan { entries: e } = b {
                        *e = entries;
                    }
                });
            }
            _ => {
                st.stream = None;
                let id = self.push_locked(&mut st, ItemBody::Plan { entries });
                st.ext.insert("__plan__".into(), id);
            }
        }
    }

    // ---- permissions --------------------------------------------------------

    pub fn permission_requested(
        &self,
        request_id: &str,
        title: String,
        tool_kind: Option<ToolKind>,
        command: Option<String>,
        diffs: Vec<FileDiff>,
        options: Vec<PermissionOption>,
    ) {
        let pending = {
            let mut st = self.st.lock();
            st.stream = None;
            let id = self.push_locked(
                &mut st,
                ItemBody::Permission {
                    request_id: request_id.to_string(),
                    title: title.clone(),
                    tool_kind,
                    command,
                    diffs,
                    options,
                    resolution: None,
                },
            );
            st.ext.insert(format!("perm:{request_id}"), id);
            st.pending_permissions.insert(request_id.to_string());
            st.pending_permissions.len() as i64
        };
        self.update_agent(|a| {
            a.status = AgentStatus::NeedsPermission;
            a.pending_permissions = pending;
            a.unread = true;
            a.last_activity_at = now_ms();
        });
        self.attention(AttentionReason::Permission, title, Some(request_id));
    }

    pub fn permission_resolved(&self, request_id: &str, resolution: &str) {
        let (pending, turn_active) = {
            let mut st = self.st.lock();
            if let Some(id) = st.ext.get(&format!("perm:{request_id}")).cloned() {
                let resolution = resolution.to_string();
                self.update_locked(&mut st, &id, |b| {
                    if let ItemBody::Permission { resolution: r, .. } = b {
                        *r = Some(resolution);
                    }
                });
            }
            st.pending_permissions.remove(request_id);
            (st.pending_permissions.len() as i64, st.turn_active)
        };
        self.update_agent(|a| {
            a.pending_permissions = pending;
            if pending == 0 && a.status == AgentStatus::NeedsPermission {
                a.status = if turn_active {
                    AgentStatus::Working
                } else {
                    AgentStatus::Idle
                };
            }
        });
    }

    // ---- process lifecycle ----------------------------------------------------

    /// A new adapter process is starting. Returns its generation.
    pub fn begin_start(&self) -> u64 {
        let mut st = self.st.lock();
        st.generation += 1;
        st.exit_intent = ExitIntent::None;
        st.starting = true;
        st.generation
    }

    /// The handshake for `generation` finished (successfully or not).
    pub fn end_start(&self, generation: u64) {
        let mut st = self.st.lock();
        if st.generation == generation {
            st.starting = false;
        }
    }

    pub fn is_starting(&self) -> bool {
        self.st.lock().starting
    }

    pub fn request_cancel_start(&self) {
        self.st.lock().start_cancelled = true;
    }

    pub fn start_cancelled(&self) -> bool {
        self.st.lock().start_cancelled
    }

    /// Records why the current process is about to go away.
    pub fn set_exit_intent(&self, intent: ExitIntent) {
        self.st.lock().exit_intent = intent;
    }

    // ---- turns --------------------------------------------------------------

    /// Records the user's prompt. Returns the text to send now, or None if a turn
    /// is already running (the prompt is queued and sent when the turn ends).
    pub fn submit_prompt(&self, text: &str, attachments: Vec<Attachment>) -> Option<Prompt> {
        self.push(ItemBody::UserMessage {
            text: text.to_string(),
            attachments: attachments.clone(),
        });
        let prompt = Prompt {
            text: text.to_string(),
            attachments,
        };
        let mut st = self.st.lock();
        st.start_cancelled = false;
        if st.turn_active {
            st.queue.push_back(prompt);
            None
        } else {
            st.turn_active = true;
            Some(prompt)
        }
    }

    pub fn is_turn_active(&self) -> bool {
        self.st.lock().turn_active
    }

    /// Marks a turn as running (also used when a turn starts without `submit_prompt`).
    pub fn turn_started(&self) {
        {
            let mut st = self.st.lock();
            st.turn_active = true;
            // Earlier turns are finished: drop their in-memory bookkeeping.
            let pending: HashSet<String> = st.pending_permissions.clone();
            st.items.retain(|_, item| {
                matches!(&item.body, ItemBody::Permission { request_id, .. } if pending.contains(request_id))
            });
            st.ext.retain(|k, _| k.starts_with("perm:"));
            st.stream = None;
        }
        self.update_agent(|a| {
            a.status = AgentStatus::Working;
            a.running = true;
            a.rate_limited = false;
            a.last_activity_at = now_ms();
        });
    }

    /// Ends the turn. Returns the next queued prompt if there is one (the caller
    /// should start it immediately).
    pub fn turn_finished(&self, outcome: TurnOutcome) -> Option<Prompt> {
        let stale: Vec<String>;
        let dropped: usize;
        {
            let mut st = self.st.lock();
            if !st.turn_active {
                return None;
            }
            // A turn that ended because we stopped the process wasn't a failure.
            if st.exit_intent != ExitIntent::None
                && matches!(outcome, TurnOutcome::Failed(_) | TurnOutcome::Cancelled)
            {
                let intent = st.exit_intent;
                drop(st);
                self.end_turn_early(intent);
                return None;
            }
            self.flush_locked(&mut st);
            st.stream = None;
            stale = st.pending_permissions.iter().cloned().collect();
            if !matches!(outcome, TurnOutcome::Failed(_) | TurnOutcome::Cancelled) {
                if let Some(next) = st.queue.pop_front() {
                    st.ext.remove("__plan__");
                    return Some(next);
                }
            }
            dropped = st.queue.len();
            st.queue.clear();
            st.turn_active = false;
        }
        for id in stale {
            self.permission_resolved(&id, "cancelled");
        }
        if dropped > 0 {
            self.notice(NoticeLevel::Warn, unsent_notice(dropped));
        }
        match &outcome {
            TurnOutcome::Completed | TurnOutcome::CompletedWithNote(_) => {
                if let TurnOutcome::CompletedWithNote(note) = &outcome {
                    self.notice(NoticeLevel::Warn, note.clone());
                }
                let agent = self.update_agent(|a| {
                    a.status = AgentStatus::Idle;
                    a.unread = true;
                    a.last_activity_at = now_ms();
                });
                let body = agent
                    .and_then(|a| a.last_message)
                    .unwrap_or_else(|| "Finished".into());
                self.attention(AttentionReason::Done, body, None);
            }
            TurnOutcome::Cancelled => {
                self.notice(NoticeLevel::Info, "Turn cancelled");
                self.update_agent(|a| a.status = AgentStatus::Idle);
            }
            TurnOutcome::Refused => {
                self.notice(
                    NoticeLevel::Warn,
                    "The model declined to continue this request.",
                );
                self.update_agent(|a| {
                    a.status = AgentStatus::Idle;
                    a.unread = true;
                });
            }
            TurnOutcome::Failed(msg) => {
                self.notice(NoticeLevel::Error, msg.clone());
                let limited = is_rate_limit(msg);
                self.update_agent(|a| {
                    a.status = AgentStatus::Error;
                    a.unread = true;
                    a.rate_limited = limited;
                });
                if limited {
                    if let Some(core) = self.core.upgrade() {
                        let id = self.agent_id.clone();
                        tokio::spawn(async move { core.on_rate_limited(&id).await });
                    }
                }
                self.attention(
                    AttentionReason::Error,
                    msg.chars().take(200).collect(),
                    None,
                );
            }
        }
        None
    }

    /// Ends a running turn because the user stopped the agent (or the app is
    /// shutting down). Same result no matter which event notices first.
    pub fn end_turn_early(&self, intent: ExitIntent) {
        let (stale, dropped) = {
            let mut st = self.st.lock();
            if !st.turn_active {
                return;
            }
            self.flush_locked(&mut st);
            st.turn_active = false;
            st.stream = None;
            let dropped = st.queue.len();
            st.queue.clear();
            (
                st.pending_permissions.iter().cloned().collect::<Vec<_>>(),
                dropped,
            )
        };
        for id in stale {
            self.permission_resolved(&id, "cancelled");
        }
        match intent {
            ExitIntent::Shutdown => {
                self.update_agent(|a| a.status = AgentStatus::Interrupted);
            }
            _ => {
                if dropped > 0 {
                    self.notice(NoticeLevel::Warn, unsent_notice(dropped));
                }
                self.notice(NoticeLevel::Info, "Agent stopped");
                self.update_agent(|a| a.status = AgentStatus::Stopped);
            }
        }
    }

    /// The adapter process for `generation` went away.
    pub fn process_exited(&self, generation: u64, detail: String) {
        let (current, intent, busy, starting) = {
            let mut st = self.st.lock();
            let current = st.generation == generation;
            let starting = current && st.starting;
            if starting {
                st.starting = false;
            }
            (current, st.exit_intent, st.turn_active, starting)
        };
        if let Some(core) = self.core.upgrade() {
            core.driver_exited(&self.agent_id);
        }
        // A newer process owns the agent now; this exit is old news.
        if !current {
            return;
        }
        self.update_agent(|a| a.running = false);
        if starting {
            // The starter sees the failed handshake and reports it.
            return;
        }
        match intent {
            ExitIntent::None if busy => {
                let mut msg = "The agent process exited unexpectedly.".to_string();
                if !detail.trim().is_empty() {
                    msg.push_str("\n\n");
                    msg.push_str(detail.trim());
                }
                self.turn_finished(TurnOutcome::Failed(msg));
            }
            ExitIntent::Stop | ExitIntent::Shutdown => self.end_turn_early(intent),
            ExitIntent::None => {}
        }
    }

    // ---- agent-level metadata ----------------------------------------------

    fn touch_preview(&self, _: Option<()>) {
        let preview = {
            let st = self.st.lock();
            st.stream.as_ref().and_then(|(id, kind)| {
                (*kind == StreamKind::Message)
                    .then(|| st.items.get(id))
                    .flatten()
                    .and_then(|i| match &i.body {
                        ItemBody::AgentMessage { text } => Some(preview_of(text)),
                        _ => None,
                    })
            })
        };
        if let Some(p) = preview {
            if let Some(core) = self.core.upgrade() {
                core.set_preview_quiet(&self.agent_id, p);
            }
        }
    }

    pub fn usage(
        &self,
        context_used: Option<i64>,
        context_size: Option<i64>,
        cost_usd: Option<f64>,
    ) {
        self.update_agent(|a| {
            if context_used.is_some() {
                a.context_used = context_used;
            }
            if context_size.is_some() {
                a.context_size = context_size;
            }
            if let Some(c) = cost_usd {
                a.cost_usd = c;
            }
        });
    }

    pub fn add_tokens(&self, tokens: i64) {
        self.update_agent(|a| a.tokens_used += tokens);
    }

    pub fn set_tokens(&self, tokens: i64) {
        self.update_agent(|a| a.tokens_used = tokens);
    }

    pub fn set_title_suggestion(&self, title: &str) {
        if let Some(core) = self.core.upgrade() {
            core.suggest_title(&self.agent_id, title);
        }
    }

    pub fn account_usage(&self, usage: AccountUsage) {
        if let Some(core) = self.core.upgrade() {
            core.set_agent_account_usage(&self.agent_id, usage);
        }
    }

    pub fn set_commands(&self, commands: Vec<SlashCommand>) {
        self.update_agent(|a| a.available_commands = commands);
    }

    pub fn set_config_options(&self, options: Vec<ConfigOption>) {
        self.update_agent(|a| a.config_options = options);
    }

    pub fn set_config_value(&self, option_id: &str, value: &str) {
        self.update_agent(|a| {
            if let Some(o) = a.config_options.iter_mut().find(|o| o.id == option_id) {
                o.current_value = value.to_string();
            }
        });
    }
}

fn unsent_notice(n: usize) -> String {
    if n == 1 {
        "1 queued message wasn't sent because the turn ended early. Send it again when you're ready.".into()
    } else {
        format!("{n} queued messages weren't sent because the turn ended early. Send them again when you're ready.")
    }
}

/// Heuristic for "this account hit its usage/rate limit" across providers.
pub fn is_rate_limit(msg: &str) -> bool {
    let m = msg.to_lowercase();
    [
        "rate limit",
        "rate_limit",
        "ratelimit",
        "usage limit",
        "too many requests",
        "status 429",
        "status: 429",
        "code 429",
        "error 429",
        "http 429",
        "(429)",
        "exceeded your current quota",
        "insufficient_quota",
        "hit your limit",
        "out of credits",
    ]
    .iter()
    .any(|p| m.contains(p))
}

fn truncate_output(output: &mut String) {
    if output.len() > MAX_OUTPUT {
        let mut cut = MAX_OUTPUT;
        while !output.is_char_boundary(cut) {
            cut -= 1;
        }
        output.truncate(cut);
        output.push_str("\n… (output truncated)");
    }
}

pub fn preview_of(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 160 {
        let s: String = flat.chars().take(157).collect();
        format!("{s}…")
    } else {
        flat
    }
}
