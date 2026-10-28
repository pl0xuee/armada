//! Per-agent timeline + status bookkeeping. Protocol drivers (ACP, Codex) translate
//! wire messages into calls on `AgentCtx`, which persists items, emits UI events and
//! raises attention.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::jsonrpc::Peer;
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

/// The start was abandoned because the agent was stopped, cancelled or deleted
/// (or Armada is quitting). Never reported as an error.
#[derive(Debug)]
pub struct StartCancelled;

impl std::fmt::Display for StartCancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the agent was stopped before it finished starting")
    }
}

impl std::error::Error for StartCancelled {}

/// What the user asked for: text plus optional images.
#[derive(Debug, Clone)]
pub struct Prompt {
    pub text: String,
    pub attachments: Vec<Attachment>,
    /// The turn this prompt belongs to. Stop/cancel invalidate it, so a prompt
    /// still waiting for its process is never sent afterwards.
    pub token: u64,
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
/// Full re-sends of a tool call that keeps changing are limited to this rate.
const TOOL_EMIT_EVERY: Duration = Duration::from_millis(100);
const MAX_OUTPUT: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum LenField {
    Text,
    Output,
}

/// A queued message as stored in the database (so the queue survives restarts).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StoredPrompt {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

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
    /// Tool calls changed since their last full `ItemUpserted` (throttled).
    unsent: HashSet<String>,
    last_emit: HashMap<String, Instant>,
    turn_active: bool,
    /// Identifies the current turn; bumped whenever a turn is submitted, ends or
    /// is abandoned. A prompt runs only while its token equals this.
    turn_epoch: u64,
    /// The driver has actually started the current turn (`begin_turn`).
    turn_begun: bool,
    /// The user asked to cancel the current turn.
    cancel_requested: bool,
    queue: VecDeque<(String, Prompt)>,
    /// The queue doesn't advance until the user acts (after cancel/stop/failure).
    queue_paused: bool,
    /// When the current turn started, and the agent's cost/tokens at that point.
    turn_started_at: i64,
    turn_cost_start: f64,
    turn_tokens_start: i64,
    /// "Send now" interrupted the turn: when it ends, run the head of the queue.
    advance_on_cancel: bool,
    pending_permissions: HashSet<String>,
    /// Context to prepend to the next prompt (used when a session could not be resumed).
    preamble: Option<String>,
    /// Generation whose `session/load` history replay is in progress, if any.
    replaying: Option<u64>,
    /// UTF-16 length of each streamed field, so deltas carry offsets without
    /// rescanning the text.
    lens: HashMap<(String, LenField), usize>,
    /// Which adapter process is current; exits from older ones are ignored.
    generation: u64,
    exit_intent: ExitIntent,
    /// The current process is still in its handshake (start errors are reported
    /// by the starter, not by the exit handler).
    starting: bool,
    /// The process of this generation is mid-handshake; killing it aborts the start.
    start_peer: Option<(u64, Arc<Peer>)>,
    /// Stop/cancel arrived while this generation was starting: don't keep it.
    cancelled_start: Option<u64>,
    /// Cost bookkeeping: providers report a running total per process.
    cost_gen: u64,
    cost_base: f64,
    cost_last: f64,
}

pub struct AgentCtx {
    pub agent_id: String,
    core: WeakCore,
    st: Mutex<CtxState>,
    /// Serializes ending a turn early, so a second caller (e.g. Stop racing the
    /// exit handler) returns only after the first has fully settled the agent.
    settle: Mutex<()>,
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
                unsent: HashSet::new(),
                last_emit: HashMap::new(),
                turn_active: false,
                turn_epoch: 0,
                turn_begun: false,
                cancel_requested: false,
                queue: VecDeque::new(),
                queue_paused: false,
                turn_started_at: 0,
                turn_cost_start: 0.0,
                turn_tokens_start: 0,
                advance_on_cancel: false,
                pending_permissions: HashSet::new(),
                preamble: None,
                replaying: None,
                lens: HashMap::new(),
                generation: 0,
                exit_intent: ExitIntent::None,
                starting: false,
                start_peer: None,
                cancelled_start: None,
                cost_gen: 0,
                cost_base: 0.0,
                cost_last: 0.0,
            }),
            settle: Mutex::new(()),
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

    /// Updates the agent; `f` learns whether a turn is running *at that moment*
    /// (checked under the agent lock), so a late "idle" can't overwrite the
    /// "working" of a turn that started meanwhile.
    fn update_agent_settled(&self, f: impl FnOnce(&mut Agent, bool)) -> Option<Agent> {
        self.update_agent(|a| {
            let active = self.st.lock().turn_active;
            f(a, active)
        })
    }

    fn agent_snapshot(&self) -> Option<Agent> {
        self.core.upgrade()?.agent(&self.agent_id).ok()
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

    /// Marks `generation` as replaying history (or done, for the same generation).
    pub fn set_replaying(&self, generation: u64, on: bool) {
        let mut st = self.st.lock();
        if on {
            st.replaying = Some(generation);
        } else if st.replaying == Some(generation) {
            st.replaying = None;
        }
    }

    pub fn replaying(&self) -> bool {
        self.st.lock().replaying.is_some()
    }

    pub fn set_preamble(&self, text: String) {
        self.st.lock().preamble = Some(text);
    }

    pub fn take_preamble(&self) -> Option<String> {
        self.st.lock().preamble.take()
    }

    /// Puts a preamble back after the prompt carrying it failed to send (unless a
    /// newer one was set meanwhile).
    pub fn restore_preamble(&self, text: String) {
        let mut st = self.st.lock();
        if st.preamble.is_none() {
            st.preamble = Some(text);
        }
    }

    // ---- items --------------------------------------------------------------

    /// Persists and sends the full item, resetting its delta offsets.
    fn emit_item_locked(&self, st: &mut CtxState, id: &str) {
        st.lens.remove(&(id.to_string(), LenField::Text));
        st.lens.remove(&(id.to_string(), LenField::Output));
        st.dirty.remove(id);
        st.unsent.remove(id);
        if let Some(item) = st.items.get(id) {
            let item = item.clone();
            self.persist(&item);
            self.emit(ArmadaEvent::ItemUpserted { item });
            st.last_emit.insert(id.to_string(), Instant::now());
        }
    }

    /// Sends tool calls whose last change was held back by the throttle.
    fn send_unsent_locked(&self, st: &mut CtxState) {
        for id in st.unsent.drain().collect::<Vec<_>>() {
            self.emit_item_locked(st, &id);
        }
    }

    fn flush_locked(&self, st: &mut CtxState) {
        self.send_unsent_locked(st);
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

    /// Ends the current text stream, sending its full final item so clients that
    /// missed deltas (e.g. while reloading a timeline) end up with the exact text.
    fn end_stream_locked(&self, st: &mut CtxState) {
        if let Some((id, _)) = st.stream.take() {
            st.dirty.remove(&id);
            if let Some(item) = st.items.get(&id) {
                self.persist(item);
                self.emit(ArmadaEvent::ItemUpserted { item: item.clone() });
            }
        }
    }

    fn push_locked(&self, st: &mut CtxState, body: ItemBody) -> String {
        self.end_stream_locked(st);
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
        st.last_emit.insert(id.clone(), Instant::now());
        id
    }

    /// Appends a new item and ends any in-progress text stream.
    pub fn push(&self, body: ItemBody) -> String {
        let mut st = self.st.lock();
        self.end_stream_locked(&mut st);
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
            self.emit_item_locked(st, id);
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
        if st.replaying.is_some() {
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
        let mut offset = None;
        let CtxState { items, lens, .. } = &mut *st;
        if let Some(item) = items.get_mut(&id) {
            if let ItemBody::AgentMessage { text } | ItemBody::Thought { text } = &mut item.body {
                let len = lens
                    .entry((id.clone(), LenField::Text))
                    .or_insert_with(|| text.encode_utf16().count());
                offset = Some(*len);
                *len += delta.encode_utf16().count();
                text.push_str(delta);
            }
        }
        st.dirty.insert(id.clone());
        self.emit(ArmadaEvent::TextDelta {
            agent_id: self.agent_id.clone(),
            item_id: id,
            field: DeltaField::Text,
            delta: delta.to_string(),
            offset: offset.unwrap_or(0),
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
            self.end_stream_locked(&mut st);
        }
    }

    /// Creates the tool call item on first sight, then applies `patch`.
    ///
    /// A change that only extends the call's output is sent as an output delta;
    /// other changes re-send the whole item, at most every 100 ms per item
    /// (the final state, a terminal status, is always sent at once).
    pub fn tool_call(&self, ext_id: &str, patch: impl FnOnce(&mut ItemBody)) {
        let mut st = self.st.lock();
        if st.replaying.is_some() {
            return;
        }
        let (id, created) = match st.ext.get(ext_id).cloned() {
            Some(id) if st.items.contains_key(&id) => (id, false),
            _ => {
                self.end_stream_locked(&mut st);
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
                        images: Vec::new(),
                        subagent: None,
                        parent_tool_call_id: None,
                    },
                );
                st.ext.insert(ext_id.to_string(), id.clone());
                (id, true)
            }
        };
        let Some(item) = st.items.get_mut(&id) else {
            return;
        };
        let before = tool_shape(&item.body);
        let old_len = match &item.body {
            ItemBody::ToolCall { output, .. } => output.len(),
            _ => 0,
        };
        patch(&mut item.body);
        let mut appended: Option<String> = None;
        if let ItemBody::ToolCall { output, .. } = &mut item.body {
            truncate_output(output);
            if output.len() > old_len && output.is_char_boundary(old_len) {
                appended = Some(output[old_len..].to_string());
            }
        }
        let after = tool_shape(&item.body);
        let terminal = matches!(
            &item.body,
            ItemBody::ToolCall {
                status: ToolStatus::Completed | ToolStatus::Failed,
                ..
            }
        );
        let same_shape = before == after;
        // Was the old output a prefix of the new one? (Only then is a delta exact.)
        let extends = same_shape && appended.is_some() && !st.unsent.contains(&id);
        if extends && !created && !terminal {
            let delta = appended.unwrap_or_default();
            self.emit_output_delta_locked(&mut st, &id, old_len, &delta);
            return;
        }
        if created && same_shape && appended.is_none() {
            // Nothing beyond the creation that was just sent.
            return;
        }
        let recent = st
            .last_emit
            .get(&id)
            .is_some_and(|t| t.elapsed() < TOOL_EMIT_EVERY);
        if terminal || !recent {
            self.emit_item_locked(&mut st, &id);
        } else {
            st.dirty.insert(id.clone());
            st.unsent.insert(id);
        }
    }

    /// Sends `delta` (appended at byte `old_len` of the output) as a text delta.
    fn emit_output_delta_locked(&self, st: &mut CtxState, id: &str, old_len: usize, delta: &str) {
        let key = (id.to_string(), LenField::Output);
        let offset = match st.lens.get(&key) {
            Some(n) => *n,
            None => match st.items.get(id).map(|i| &i.body) {
                Some(ItemBody::ToolCall { output, .. }) => output[..old_len].encode_utf16().count(),
                _ => 0,
            },
        };
        st.lens.insert(key, offset + delta.encode_utf16().count());
        st.dirty.insert(id.to_string());
        self.emit(ArmadaEvent::TextDelta {
            agent_id: self.agent_id.clone(),
            item_id: id.to_string(),
            field: DeltaField::Output,
            delta: delta.to_string(),
            offset,
        });
        if st.last_flush.elapsed() > FLUSH_EVERY {
            self.flush_locked(st);
        }
    }

    pub fn append_tool_output(&self, ext_id: &str, delta: &str) {
        let mut st = self.st.lock();
        let Some(id) = st.ext.get(ext_id).cloned() else {
            return;
        };
        // A held-back full update goes first, so the delta's offset matches.
        if st.unsent.contains(&id) {
            self.emit_item_locked(&mut st, &id);
        }
        let old_len = match st.items.get_mut(&id).map(|i| &mut i.body) {
            Some(ItemBody::ToolCall { output, .. }) if output.len() < MAX_OUTPUT => {
                let n = output.len();
                output.push_str(delta);
                n
            }
            _ => return,
        };
        self.emit_output_delta_locked(&mut st, &id, old_len, delta);
    }

    pub fn tool_call_body(&self, ext_id: &str) -> Option<ItemBody> {
        let st = self.st.lock();
        let id = st.ext.get(ext_id)?;
        st.items.get(id).map(|i| i.body.clone())
    }

    /// One plan item per turn, updated in place.
    pub fn plan(&self, entries: Vec<PlanEntry>) {
        let mut st = self.st.lock();
        if st.replaying.is_some() {
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
                self.end_stream_locked(&mut st);
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
            self.end_stream_locked(&mut st);
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
        let pending = {
            let mut st = self.st.lock();
            if let Some(id) = st.ext.remove(&format!("perm:{request_id}")) {
                let resolution = resolution.to_string();
                self.update_locked(&mut st, &id, |b| {
                    if let ItemBody::Permission { resolution: r, .. } = b {
                        *r = Some(resolution);
                    }
                });
            }
            st.pending_permissions.remove(request_id);
            st.pending_permissions.len() as i64
        };
        self.update_agent_settled(|a, turn_active| {
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
        st.replaying = None;
        st.start_peer = None;
        st.generation
    }

    /// `begin_start` for a process whose handshake can be aborted by killing `peer`.
    pub fn begin_start_with(&self, peer: Arc<Peer>) -> u64 {
        let generation = self.begin_start();
        self.st.lock().start_peer = Some((generation, peer));
        generation
    }

    /// The handshake for `generation` finished (successfully or not).
    pub fn end_start(&self, generation: u64) {
        let mut st = self.st.lock();
        if st.generation == generation {
            st.starting = false;
        }
        if st
            .start_peer
            .as_ref()
            .is_some_and(|(g, _)| *g == generation)
        {
            st.start_peer = None;
        }
    }

    /// Whether `generation` is still the agent's current process.
    pub fn is_current(&self, generation: u64) -> bool {
        self.st.lock().generation == generation
    }

    /// The current process was stopped and its effects already settled: anything
    /// it still reports (late exit, failed prompt, queued output) is ignored.
    pub fn retire_generation(&self, generation: u64) {
        let mut st = self.st.lock();
        // Only the process being stopped; a newer one must not be retired.
        if st.generation != generation {
            return;
        }
        st.generation += 1;
        st.exit_intent = ExitIntent::None;
        st.starting = false;
        st.replaying = None;
        st.start_peer = None;
    }

    /// Abandons the in-progress start, if there is one. Returns whether there was.
    /// The process keeps running until `kill_starting_peer`.
    pub fn request_cancel_start(&self) -> bool {
        let mut st = self.st.lock();
        if st.starting {
            st.cancelled_start = Some(st.generation);
        }
        st.starting
    }

    /// Whether the start of `generation` was abandoned (stop/cancel/delete).
    pub fn start_cancelled(&self, generation: u64) -> bool {
        self.st.lock().cancelled_start == Some(generation)
    }

    /// Kills the process that is still in its handshake (after
    /// `request_cancel_start`), so the pending request fails at once instead of
    /// waiting out its timeout. Returns whether there was one.
    pub async fn kill_starting_peer(&self) -> bool {
        let peer = {
            let mut st = self.st.lock();
            match st.start_peer.take() {
                Some((generation, peer)) => {
                    st.cancelled_start = Some(generation);
                    Some(peer)
                }
                None => None,
            }
        };
        match peer {
            Some(peer) => {
                peer.kill().await;
                true
            }
            None => false,
        }
    }

    /// Records why the current process is about to go away.
    pub fn set_exit_intent(&self, intent: ExitIntent) {
        self.st.lock().exit_intent = intent;
    }

    // ---- turns --------------------------------------------------------------

    /// A new token for the turn about to run (invalidates older ones).
    fn next_token_locked(st: &mut CtxState) -> u64 {
        st.turn_epoch += 1;
        st.turn_begun = false;
        st.cancel_requested = false;
        st.advance_on_cancel = false;
        st.turn_epoch
    }

    /// Records the user's prompt. Returns the prompt to send now, or None if a turn
    /// is already running (the prompt is queued and sent when the turn ends).
    pub fn submit_prompt(&self, text: &str, attachments: Vec<Attachment>) -> Option<Prompt> {
        let mut prompt = Prompt {
            text: text.to_string(),
            attachments,
            token: 0,
        };
        {
            let mut st = self.st.lock();
            if st.turn_active {
                // Shown above the composer until it runs, not in the timeline yet.
                st.queue
                    .push_back((uuid::Uuid::new_v4().to_string(), prompt));
                drop(st);
                self.publish_queue();
                return None;
            }
            st.turn_active = true;
            prompt.token = Self::next_token_locked(&mut st);
            // Sending a new message resumes a paused queue (it runs after this).
            st.queue_paused = false;
            self.record_prompt_locked(&mut st, &prompt);
        }
        self.publish_queue();
        Some(prompt)
    }

    /// Adds the prompt to the timeline (when it actually starts running).
    fn record_prompt_locked(&self, st: &mut CtxState, prompt: &Prompt) {
        self.end_stream_locked(st);
        self.push_locked(
            st,
            ItemBody::UserMessage {
                text: prompt.text.clone(),
                attachments: prompt.attachments.clone(),
            },
        );
    }

    fn publish_queue(&self) {
        let (queue, paused, stored) = {
            let st = self.st.lock();
            let queue: Vec<QueuedPrompt> = st
                .queue
                .iter()
                .map(|(id, p)| QueuedPrompt {
                    id: id.clone(),
                    text: p.text.clone(),
                    attachments: p.attachments.len(),
                })
                .collect();
            let stored: Vec<StoredPrompt> = st
                .queue
                .iter()
                .map(|(id, p)| StoredPrompt {
                    id: id.clone(),
                    text: p.text.clone(),
                    attachments: p.attachments.clone(),
                })
                .collect();
            (queue, st.queue_paused && !st.queue.is_empty(), stored)
        };
        if let Some(core) = self.core.upgrade() {
            if let Err(e) = core.db().put_queue(&self.agent_id, &stored) {
                tracing::warn!("saving the queue: {e:#}");
            }
        }
        self.update_agent(|a| {
            a.queued_prompts = queue.len() as i64;
            a.queue = queue;
            a.queue_paused = paused;
        });
    }

    /// Puts back the queue saved by a previous run, paused (nothing runs until
    /// the user acts).
    pub fn restore_queue(&self, saved: Vec<StoredPrompt>) {
        if saved.is_empty() {
            return;
        }
        let n = saved.len();
        {
            let mut st = self.st.lock();
            for p in saved {
                st.queue.push_back((
                    p.id,
                    Prompt {
                        text: p.text,
                        attachments: p.attachments,
                        token: 0,
                    },
                ));
            }
            st.queue_paused = true;
        }
        self.publish_queue();
        let text = if n == 1 {
            "1 queued message was kept from before Armada closed. It's on hold: send it, edit it or remove it from the queue above the composer.".to_string()
        } else {
            format!("{n} queued messages were kept from before Armada closed. They're on hold: send, edit or remove them from the queue above the composer.")
        };
        self.notice(NoticeLevel::Info, text);
    }

    /// Removes a queued message (to edit or discard it); returns it.
    pub fn remove_queued(&self, id: &str) -> Option<Prompt> {
        let removed = {
            let mut st = self.st.lock();
            let pos = st.queue.iter().position(|(qid, _)| qid == id)?;
            st.queue.remove(pos).map(|(_, p)| p)
        };
        self.publish_queue();
        removed
    }

    /// Drops every queued message. Returns how many there were.
    pub fn clear_queue(&self) -> usize {
        let n = {
            let mut st = self.st.lock();
            let n = st.queue.len();
            st.queue.clear();
            st.queue_paused = false;
            n
        };
        self.publish_queue();
        n
    }

    /// Unpauses the queue. If no turn is running, its head starts now and is
    /// returned (the caller runs it).
    pub fn resume_queue(&self) -> Option<Prompt> {
        let next = {
            let mut st = self.st.lock();
            st.queue_paused = false;
            if st.turn_active {
                None
            } else {
                match st.queue.pop_front() {
                    Some((_, mut p)) => {
                        st.turn_active = true;
                        p.token = Self::next_token_locked(&mut st);
                        self.record_prompt_locked(&mut st, &p);
                        Some(p)
                    }
                    None => None,
                }
            }
        };
        self.publish_queue();
        next
    }

    /// Runs a queued message next. Returns it if no turn is running (the caller
    /// starts it now); otherwise it moves to the front and `true` is returned in
    /// the second slot, meaning the caller should cancel the current turn.
    pub fn send_queued_now(&self, id: &str) -> Option<(Option<Prompt>, bool)> {
        let result = {
            let mut st = self.st.lock();
            let pos = st.queue.iter().position(|(qid, _)| qid == id)?;
            let mut item = st.queue.remove(pos)?;
            st.queue_paused = false;
            if st.turn_active {
                st.queue.push_front(item);
                st.advance_on_cancel = true;
                (None, true)
            } else {
                st.turn_active = true;
                item.1.token = Self::next_token_locked(&mut st);
                self.record_prompt_locked(&mut st, &item.1);
                (Some(item.1), false)
            }
        };
        self.publish_queue();
        Some(result)
    }

    /// Pauses the queue after an abnormal end so nothing runs unexpectedly.
    fn pause_queue_locked(st: &mut CtxState) -> usize {
        if !st.queue.is_empty() {
            st.queue_paused = true;
        }
        st.queue.len()
    }

    pub fn is_turn_active(&self) -> bool {
        self.st.lock().turn_active
    }

    /// The current turn's token, if a turn is running.
    pub fn active_turn(&self) -> Option<u64> {
        let st = self.st.lock();
        st.turn_active.then_some(st.turn_epoch)
    }

    /// Whether the prompt with `token` may still run.
    pub fn prompt_is_current(&self, token: u64) -> bool {
        let st = self.st.lock();
        st.turn_active && st.turn_epoch == token
    }

    /// A turn is running but its driver hasn't started it yet.
    pub fn turn_pending(&self) -> bool {
        let st = self.st.lock();
        st.turn_active && !st.turn_begun
    }

    /// Records that the user asked to cancel the current turn.
    pub fn note_cancel(&self) {
        let mut st = self.st.lock();
        if st.turn_active {
            st.cancel_requested = true;
        }
    }

    pub fn cancel_was_requested(&self) -> bool {
        self.st.lock().cancel_requested
    }

    /// The driver is about to send the prompt with `token`. Returns false (and
    /// changes nothing) if that turn was stopped, cancelled or replaced meanwhile.
    pub fn begin_turn(&self, token: u64) -> bool {
        let (cost, tokens) = self
            .agent_snapshot()
            .map(|a| (a.cost_usd, a.tokens_used))
            .unwrap_or_default();
        {
            let mut st = self.st.lock();
            if !st.turn_active || st.turn_epoch != token || st.turn_begun {
                return false;
            }
            st.turn_begun = true;
            st.advance_on_cancel = false;
            st.turn_started_at = now_ms();
            st.turn_cost_start = cost;
            st.turn_tokens_start = tokens;
            // Persist anything still buffered before dropping it from memory.
            self.flush_locked(&mut st);
            self.end_stream_locked(&mut st);
            // Earlier turns are finished: drop their in-memory bookkeeping.
            let pending: HashSet<String> = st.pending_permissions.clone();
            st.items.retain(|_, item| {
                matches!(&item.body, ItemBody::Permission { request_id, .. } if pending.contains(request_id))
            });
            st.ext.retain(|k, _| {
                k.strip_prefix("perm:")
                    .is_some_and(|req| pending.contains(req))
            });
            st.lens.clear();
            st.last_emit.clear();
            st.unsent.clear();
        }
        self.update_agent(|a| {
            a.status = AgentStatus::Working;
            a.running = true;
            a.rate_limited = false;
            a.last_activity_at = now_ms();
        });
        true
    }

    /// Ends the turn. Returns the next queued prompt if there is one (the caller
    /// should start it immediately).
    pub fn turn_finished(&self, outcome: TurnOutcome) -> Option<Prompt> {
        self.finish_turn(None, outcome)
    }

    /// `turn_finished` reported by the process of `generation`: ignored if that
    /// process was retired meanwhile (checked atomically with the turn state).
    pub fn turn_finished_by(&self, generation: u64, outcome: TurnOutcome) -> Option<Prompt> {
        self.finish_turn(Some(generation), outcome)
    }

    fn finish_turn(&self, generation: Option<u64>, outcome: TurnOutcome) -> Option<Prompt> {
        let stale: Vec<String>;
        let dropped: usize;
        let next: Option<Prompt>;
        let summary;
        let finish_epoch: u64;
        {
            let mut st = self.st.lock();
            if !st.turn_active || generation.is_some_and(|g| g != st.generation) {
                return None;
            }
            // A turn that ended because we stopped the process wasn't a failure.
            if st.exit_intent != ExitIntent::None
                && matches!(outcome, TurnOutcome::Failed(_) | TurnOutcome::Cancelled)
            {
                let intent = st.exit_intent;
                drop(st);
                self.end_turn_early_for(generation, intent);
                return None;
            }
            self.flush_locked(&mut st);
            self.end_stream_locked(&mut st);
            stale = st.pending_permissions.iter().cloned().collect();
            let advance_on_cancel = std::mem::take(&mut st.advance_on_cancel);
            let completed = matches!(
                outcome,
                TurnOutcome::Completed | TurnOutcome::CompletedWithNote(_)
            );
            // Computed now, from this turn's items (the next turn clears them).
            summary = completed.then(|| self.turn_summary_locked(&st)).flatten();
            let normal = !matches!(outcome, TurnOutcome::Failed(_) | TurnOutcome::Cancelled);
            let advance =
                normal || (matches!(outcome, TurnOutcome::Cancelled) && advance_on_cancel);
            next = if advance && !st.queue_paused {
                st.queue.pop_front().map(|(_, p)| p)
            } else {
                None
            };
            // This turn is over either way; its token is spent.
            finish_epoch = Self::next_token_locked(&mut st);
            if next.is_none() {
                st.turn_active = false;
                dropped = Self::pause_queue_locked(&mut st);
            } else {
                dropped = 0;
            }
        }
        for id in &stale {
            self.permission_resolved(id, "cancelled");
        }
        // What the finished turn did comes before whatever runs next.
        match &outcome {
            TurnOutcome::CompletedWithNote(note) => self.notice(NoticeLevel::Warn, note.clone()),
            TurnOutcome::Refused => self.notice(
                NoticeLevel::Warn,
                "The model declined to continue this request.",
            ),
            _ => {}
        }
        if let Some((files, tool_calls, commands, duration_ms, cost0, tokens0)) = summary {
            let (cost, tokens) = self
                .agent_snapshot()
                .map(|a| (a.cost_usd, a.tokens_used))
                .unwrap_or_default();
            self.push(ItemBody::TurnSummary {
                duration_ms,
                files,
                tool_calls,
                commands,
                cost_usd: (cost - cost0).max(0.0),
                tokens: (tokens - tokens0).max(0),
            });
        }
        if let Some(mut next) = next {
            // Advance to the queued prompt, unless a stop got in meanwhile.
            let started = {
                let mut st = self.st.lock();
                if st.turn_active && st.turn_epoch == finish_epoch {
                    st.ext.remove("__plan__");
                    next.token = Self::next_token_locked(&mut st);
                    self.record_prompt_locked(&mut st, &next);
                    true
                } else {
                    false
                }
            };
            if started {
                self.publish_queue();
                return Some(next);
            }
            // Stopped in between: keep the message, on hold, at the front.
            {
                let mut st = self.st.lock();
                st.queue
                    .push_front((uuid::Uuid::new_v4().to_string(), next));
                st.queue_paused = true;
            }
            self.publish_queue();
            return None;
        }
        if dropped > 0 {
            self.notice(NoticeLevel::Info, paused_notice(dropped));
            self.publish_queue();
        }
        match &outcome {
            TurnOutcome::Completed | TurnOutcome::CompletedWithNote(_) => {
                let agent = self.update_agent_settled(|a, active| {
                    if !active {
                        a.status = AgentStatus::Idle;
                    }
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
                self.update_agent_settled(|a, active| {
                    if !active {
                        a.status = AgentStatus::Idle;
                    }
                });
            }
            TurnOutcome::Refused => {
                self.update_agent_settled(|a, active| {
                    if !active {
                        a.status = AgentStatus::Idle;
                    }
                    a.unread = true;
                });
            }
            TurnOutcome::Failed(msg) => {
                self.notice(NoticeLevel::Error, msg.clone());
                let limited = is_rate_limit(msg);
                self.update_agent_settled(|a, active| {
                    if !active {
                        a.status = AgentStatus::Error;
                        a.rate_limited = limited;
                    }
                    a.unread = true;
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

    /// The "review" of a turn that did real work (tool calls): files, steps,
    /// commands, duration and the cost/tokens baseline. Pure Q&A turns return
    /// None so the timeline doesn't fill with empty summaries. Only the agent's
    /// own steps count; a sub-agent's tool calls and commands are part of the
    /// sub-agent call that ran them (its files still count as edited).
    #[allow(clippy::type_complexity)]
    fn turn_summary_locked(&self, st: &CtxState) -> Option<(Vec<String>, i64, i64, i64, f64, i64)> {
        let mut files: Vec<String> = Vec::new();
        let (mut tool_calls, mut commands) = (0i64, 0i64);
        let mut items: Vec<&TimelineItem> = st.items.values().collect();
        items.sort_by_key(|i| i.seq);
        for item in items {
            if let ItemBody::ToolCall {
                tool_kind,
                status,
                locations,
                diffs,
                parent_tool_call_id,
                ..
            } = &item.body
            {
                if parent_tool_call_id.is_none() {
                    tool_calls += 1;
                    if *tool_kind == ToolKind::Execute {
                        commands += 1;
                    }
                }
                let edited = matches!(
                    tool_kind,
                    ToolKind::Edit | ToolKind::Delete | ToolKind::Move
                );
                if edited && *status == ToolStatus::Completed {
                    for p in locations.iter().chain(diffs.iter().map(|d| &d.path)) {
                        if !files.contains(p) {
                            files.push(p.clone());
                        }
                    }
                }
            }
        }
        if tool_calls == 0 {
            return None;
        }
        Some((
            files,
            tool_calls,
            commands,
            now_ms() - st.turn_started_at,
            st.turn_cost_start,
            st.turn_tokens_start,
        ))
    }

    /// Ends a running turn because the user stopped the agent (or the app is
    /// shutting down). Same result no matter which event notices first.
    pub fn end_turn_early(&self, intent: ExitIntent) {
        self.end_turn_early_for(None, intent);
    }

    /// `end_turn_early` on behalf of the process of `generation` (ignored if it was
    /// retired meanwhile — a newer turn must not be ended by an old process).
    fn end_turn_early_for(&self, generation: Option<u64>, intent: ExitIntent) {
        let _settling = self.settle.lock();
        let (stale, dropped) = {
            let mut st = self.st.lock();
            if !st.turn_active || generation.is_some_and(|g| g != st.generation) {
                return;
            }
            self.flush_locked(&mut st);
            st.turn_active = false;
            Self::next_token_locked(&mut st);
            self.end_stream_locked(&mut st);
            let dropped = Self::pause_queue_locked(&mut st);
            (
                st.pending_permissions.iter().cloned().collect::<Vec<_>>(),
                dropped,
            )
        };
        // Final status first: resolving the approvals below must not flash "idle",
        // and a concurrent stop that finds the turn already ended sees it settled.
        let status = match intent {
            ExitIntent::Shutdown => AgentStatus::Interrupted,
            _ => AgentStatus::Stopped,
        };
        self.update_agent_settled(|a, active| {
            if !active {
                a.status = status;
            }
            a.pending_permissions = 0;
            if dropped > 0 {
                a.queue_paused = true;
            }
        });
        for id in stale {
            self.permission_resolved(&id, "cancelled");
        }
        if dropped > 0 {
            self.publish_queue();
        }
        if intent != ExitIntent::Shutdown {
            if dropped > 0 {
                self.notice(NoticeLevel::Info, paused_notice(dropped));
            }
            self.notice(NoticeLevel::Info, "Agent stopped");
        }
    }

    /// The adapter process for `generation` went away.
    pub fn process_exited(&self, generation: u64, detail: String) {
        let (current, intent, busy, starting) = {
            let mut st = self.st.lock();
            if st.replaying == Some(generation) {
                st.replaying = None;
            }
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
                self.turn_finished_by(generation, TurnOutcome::Failed(msg));
            }
            ExitIntent::Stop | ExitIntent::Shutdown => {
                self.end_turn_early_for(Some(generation), intent)
            }
            ExitIntent::None => {
                // Idle: nothing was lost, but say so instead of failing silently later.
                self.notice(
                    NoticeLevel::Info,
                    "The agent process exited; it will restart with your next message.",
                );
            }
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

    /// Context window use and cost. `cost_usd` is the running total the current
    /// process reports; the agent's cost is the sum over all its processes
    /// (each starts counting from zero).
    pub fn usage(
        &self,
        context_used: Option<i64>,
        context_size: Option<i64>,
        cost_usd: Option<f64>,
    ) {
        let Some(agent) = self.agent_snapshot() else {
            return;
        };
        let total = cost_usd.map(|c| {
            let mut st = self.st.lock();
            if st.cost_gen != st.generation {
                st.cost_gen = st.generation;
                st.cost_base = agent.cost_usd;
                st.cost_last = 0.0;
            }
            if c < st.cost_last {
                // The process restarted its count; keep what it had reported.
                st.cost_base += st.cost_last;
            }
            st.cost_last = c;
            st.cost_base + c
        });
        let unchanged = context_used.is_none_or(|v| agent.context_used == Some(v))
            && context_size.is_none_or(|v| agent.context_size == Some(v))
            && total.is_none_or(|c| (agent.cost_usd - c).abs() < 1e-12);
        if unchanged {
            return;
        }
        self.update_agent(|a| {
            if context_used.is_some() {
                a.context_used = context_used;
            }
            if context_size.is_some() {
                a.context_size = context_size;
            }
            if let Some(c) = total {
                a.cost_usd = c;
            }
        });
    }

    pub fn add_tokens(&self, tokens: i64) {
        if tokens != 0 {
            self.update_agent(|a| a.tokens_used += tokens);
        }
    }

    pub fn set_tokens(&self, tokens: i64) {
        if self
            .agent_snapshot()
            .is_some_and(|a| a.tokens_used != tokens)
        {
            self.update_agent(|a| a.tokens_used = tokens);
        }
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

/// Everything about a tool call except its output, for "did only the output
/// grow?" checks.
type ToolShape = (
    String,
    ToolKind,
    ToolStatus,
    usize,
    usize,
    usize,
    bool,
    bool,
);

fn tool_shape(b: &ItemBody) -> Option<ToolShape> {
    match b {
        ItemBody::ToolCall {
            title,
            tool_kind,
            status,
            locations,
            diffs,
            images,
            command,
            subagent,
            parent_tool_call_id,
            ..
        } => Some((
            format!("{title}\u{0}{}", command.as_deref().unwrap_or("")),
            *tool_kind,
            *status,
            locations.len(),
            diffs.len(),
            images.len(),
            subagent.is_some(),
            parent_tool_call_id.is_some(),
        )),
        _ => None,
    }
}

fn paused_notice(n: usize) -> String {
    if n == 1 {
        "1 queued message is on hold. Send it, edit it or remove it from the queue above the composer.".into()
    } else {
        format!("{n} queued messages are on hold. Send, edit or remove them from the queue above the composer.")
    }
}

/// Heuristic for "this account hit its usage/rate limit" across providers.
pub fn is_rate_limit(msg: &str) -> bool {
    let m = msg.to_lowercase();
    [
        "rate limit",
        "rate_limit",
        "ratelimit",
        "rate-limited",
        "usage limit",
        "too many requests",
        "status 429",
        "status: 429",
        "status code 429",
        "code 429",
        "error 429",
        "http 429",
        "429 too many",
        "exceeded your current quota",
        "insufficient_quota",
        "quota exceeded",
        "resource_exhausted",
        "resource exhausted",
        "hit your limit",
        "reached your limit",
        "limit reached",
        "out of credits",
        "credit balance is too low",
        "insufficient credits",
        "insufficient balance",
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
    // Whitespace-collapsed, reading only as much of `text` as the preview needs
    // (this runs on every streamed chunk of long messages).
    const MAX: usize = 160;
    let mut flat = String::new();
    let mut count = 0;
    'words: for word in text.split_whitespace() {
        if count > 0 {
            flat.push(' ');
            count += 1;
        }
        for c in word.chars() {
            if count > MAX {
                break 'words;
            }
            flat.push(c);
            count += 1;
        }
    }
    if count > MAX {
        let s: String = flat.chars().take(MAX - 3).collect();
        format!("{s}…")
    } else {
        flat
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_matches_full_flatten() {
        let reference = |text: &str| {
            let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if flat.chars().count() > 160 {
                let s: String = flat.chars().take(157).collect();
                format!("{s}…")
            } else {
                flat
            }
        };
        let long_word = "x".repeat(400);
        let cases = [
            String::new(),
            "  hello \n\n world  ".to_string(),
            "a".repeat(160),
            "a".repeat(161),
            format!("{} b", "a".repeat(159)),
            format!("{} b", "a".repeat(160)),
            format!("{} bc", "a".repeat(158)),
            long_word,
            "héllo wörld 🎉 ".repeat(40),
        ];
        for case in &cases {
            assert_eq!(preview_of(case), reference(case), "{case:?}");
        }
    }

    fn ctx() -> AgentCtx {
        AgentCtx::new(WeakCore::dangling(), "agent".into(), 0)
    }

    /// Starts the turn of a freshly submitted prompt.
    fn run(ctx: &AgentCtx, text: &str) -> Prompt {
        let p = ctx.submit_prompt(text, vec![]).expect("runs now");
        assert!(ctx.begin_turn(p.token));
        p
    }

    /// The CI failure: stop, then a new prompt is accepted before the killed
    /// process's exit is processed. That late exit must not end the new turn.
    #[test]
    fn late_exit_of_a_stopped_process_is_ignored() {
        let ctx = ctx();
        let old = ctx.begin_start();
        ctx.end_start(old);
        run(&ctx, "one");

        // stop_agent: settle immediately and retire the old process.
        ctx.set_exit_intent(ExitIntent::Stop);
        ctx.end_turn_early(ExitIntent::Stop);
        ctx.retire_generation(old);
        assert!(!ctx.is_turn_active());

        // New prompt accepted before the new process registers…
        let two = ctx.submit_prompt("two", vec![]).unwrap();
        // …and only now does the old process's exit arrive.
        ctx.process_exited(old, String::new());
        assert!(ctx.is_turn_active(), "the late exit ended the new turn");
        assert!(!ctx.is_current(old));

        // The new process is unaffected by the old generation.
        let new = ctx.begin_start();
        assert!(ctx.is_current(new));
        ctx.end_start(new);
        assert!(ctx.begin_turn(two.token));
        assert!(ctx.turn_finished(TurnOutcome::Completed).is_none());
        assert!(!ctx.is_turn_active());
    }

    /// A retired process's late "stopped/failed" report must not end the new turn.
    #[test]
    fn stale_report_from_a_retired_process_is_ignored() {
        let ctx = ctx();
        let old = ctx.begin_start();
        ctx.end_start(old);
        run(&ctx, "one");
        ctx.set_exit_intent(ExitIntent::Stop);
        ctx.end_turn_early(ExitIntent::Stop);
        ctx.retire_generation(old);
        assert!(ctx.submit_prompt("two", vec![]).is_some());
        assert!(ctx
            .turn_finished_by(old, TurnOutcome::Failed("agent process exited".into()))
            .is_none());
        ctx.process_exited(old, String::new());
        assert!(ctx.is_turn_active(), "the old process ended the new turn");
    }

    /// An exit during the handshake is reported by the starter, not here.
    #[test]
    fn exit_while_starting_does_not_end_the_turn() {
        let ctx = ctx();
        assert!(ctx.submit_prompt("hi", vec![]).is_some());
        let g = ctx.begin_start();
        ctx.process_exited(g, "boom".into());
        assert!(ctx.is_turn_active(), "fail_start owns this report");
    }

    /// Stopping is idempotent: the second path to notice it does nothing.
    #[test]
    fn stop_settles_exactly_once() {
        let ctx = ctx();
        let g = ctx.begin_start();
        ctx.end_start(g);
        run(&ctx, "hi");
        ctx.set_exit_intent(ExitIntent::Stop);
        ctx.end_turn_early(ExitIntent::Stop);
        // The prompt task's failure and the exit both arrive afterwards.
        assert!(ctx
            .turn_finished(TurnOutcome::Failed("agent process exited".into()))
            .is_none());
        ctx.process_exited(g, String::new());
        assert!(!ctx.is_turn_active());
    }

    /// H1: a prompt parked while its process starts must not run after Stop, even
    /// if another prompt was sent (and started) in between.
    #[test]
    fn stop_invalidates_a_prompt_waiting_to_start() {
        let ctx = ctx();
        let a = ctx.submit_prompt("A", vec![]).unwrap();
        ctx.end_turn_early(ExitIntent::Stop);
        let b = ctx.submit_prompt("B", vec![]).unwrap();
        assert!(!ctx.prompt_is_current(a.token));
        assert!(!ctx.begin_turn(a.token), "the stopped prompt ran");
        assert!(ctx.begin_turn(b.token));
        assert!(!ctx.begin_turn(b.token), "a turn begins once");
    }

    /// M7: "send now" that loses the race to a normal finish must not make a
    /// later cancel advance the queue.
    #[test]
    fn advance_on_cancel_does_not_outlive_its_turn() {
        let ctx = ctx();
        run(&ctx, "one");
        assert!(ctx.submit_prompt("queued", vec![]).is_none());
        let id = ctx.st.lock().queue[0].0.clone();
        assert!(matches!(ctx.send_queued_now(&id), Some((None, true))));
        // The turn completes on its own before the cancel lands: head runs.
        let next = ctx.turn_finished(TurnOutcome::Completed).expect("advances");
        assert!(ctx.begin_turn(next.token));
        assert!(ctx.submit_prompt("later", vec![]).is_none());
        // A plain cancel of this turn must leave "later" queued (paused).
        assert!(ctx.turn_finished(TurnOutcome::Cancelled).is_none());
        assert_eq!(ctx.st.lock().queue.len(), 1);
        assert!(ctx.st.lock().queue_paused);
    }

    /// M1/L2: a turn cancelled before its driver started it can still advance.
    #[test]
    fn cancel_before_begin_advances_with_send_now() {
        let ctx = ctx();
        let first = ctx.submit_prompt("first", vec![]).unwrap();
        assert!(ctx.submit_prompt("second", vec![]).is_none());
        let id = ctx.st.lock().queue[0].0.clone();
        ctx.send_queued_now(&id);
        assert!(ctx.turn_pending());
        let next = ctx
            .turn_finished(TurnOutcome::Cancelled)
            .expect("runs next");
        assert_eq!(next.text, "second");
        assert!(!ctx.begin_turn(first.token));
        assert!(ctx.begin_turn(next.token));
    }

    #[test]
    fn resume_and_clear_queue() {
        let ctx = ctx();
        run(&ctx, "one");
        ctx.submit_prompt("two", vec![]);
        ctx.submit_prompt("three", vec![]);
        assert!(ctx.turn_finished(TurnOutcome::Cancelled).is_none());
        assert!(ctx.st.lock().queue_paused);
        let next = ctx.resume_queue().expect("head runs");
        assert_eq!(next.text, "two");
        assert!(ctx.begin_turn(next.token));
        assert_eq!(ctx.clear_queue(), 1);
        assert!(ctx.turn_finished(TurnOutcome::Completed).is_none());
    }

    /// L1: per-turn bookkeeping is dropped when a new turn begins.
    #[test]
    fn bookkeeping_is_freed_between_turns() {
        let ctx = ctx();
        run(&ctx, "one");
        ctx.append_text(StreamKind::Message, None, "hello");
        ctx.tool_call("t1", |_| {});
        ctx.append_tool_output("t1", "out");
        ctx.permission_requested("p1", "x".into(), None, None, vec![], vec![]);
        ctx.permission_resolved("p1", "yes");
        assert!(ctx.turn_finished(TurnOutcome::Completed).is_none());
        run(&ctx, "two");
        let st = ctx.st.lock();
        assert!(st.lens.is_empty());
        assert!(st.ext.is_empty(), "{:?}", st.ext);
        assert!(st.items.is_empty());
    }

    /// M2: the finished turn's summary and notes come before the queued prompt
    /// it advances to.
    #[test]
    fn summary_comes_before_the_next_queued_prompt() {
        let ctx = ctx();
        run(&ctx, "one");
        ctx.tool_call("t1", |b| {
            if let ItemBody::ToolCall { status, .. } = b {
                *status = ToolStatus::Completed;
            }
        });
        assert!(ctx.submit_prompt("two", vec![]).is_none());
        let next = ctx
            .turn_finished(TurnOutcome::CompletedWithNote("max tokens".into()))
            .expect("advances");
        let st = ctx.st.lock();
        let mut items: Vec<&TimelineItem> = st.items.values().collect();
        items.sort_by_key(|i| i.seq);
        let kinds: Vec<&str> = items.iter().map(|i| i.body.kind_str()).collect();
        assert_eq!(
            kinds,
            ["tool_call", "notice", "turn_summary", "user_message"]
        );
        drop(st);
        assert!(ctx.begin_turn(next.token));
    }

    #[test]
    fn rate_limit_phrasings() {
        assert!(is_rate_limit("Credit balance is too low"));
        assert!(is_rate_limit("RESOURCE_EXHAUSTED: quota"));
        assert!(!is_rate_limit("Exited with status (429) in file.rs:429"));
    }
}
