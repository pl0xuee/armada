//! One voice-assistant session: the WebSocket conversation with the Realtime API,
//! wired to an [`AudioDevices`] implementation, a [`ToolHost`] and a [`VaSink`] for UI
//! events. Nothing here touches Tauri or real devices, so tests run it against a fake
//! server with a null audio device.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, warn};

use super::audio::{self, AudioDevices, SpeakerBuffer};
use super::cost::{session_cost, Usage};
use super::protocol::{self as p, ServerEvent};

const TOOL_TIMEOUT: Duration = Duration::from_secs(25);
const TICK: Duration = Duration::from_millis(60);
/// At most this many side-effect proposals (start_agent / send_message) per user turn,
/// a turn being the time since the last input transcript completed.
pub const MAX_PROPOSALS_PER_TURN: u32 = 3;
/// A confirmation the user doesn't answer expires after this long.
pub const CONFIRM_TTL: Duration = Duration::from_secs(60);
/// A connection that lasted this long counts as healthy, so a later drop gets a fresh
/// reconnect attempt.
const STABLE_AFTER: Duration = Duration::from_secs(30);
/// Keep the mic closed this long after the assistant's audio stops (room echo tail).
/// How long a non-fatal notice stays beside the live session.
const NOTICE_FOR: Duration = Duration::from_secs(8);
const ECHO_TAIL: Duration = Duration::from_millis(300);

/// Error codes that mean the request will never work; the session ends instead of
/// retrying.
const FATAL_CODES: &[&str] = &[
    "invalid_api_key",
    "insufficient_quota",
    "billing_hard_limit_reached",
    "model_not_found",
    "access_terminated",
];
/// Races inherent to barge-in; harmless.
const BENIGN_CODES: &[&str] = &[
    "response_cancel_not_active",
    "item_truncate_invalid_item_id",
    "conversation_already_has_active_response",
];

/// An API key that never prints.
#[derive(Clone)]
pub struct ApiKey(pub String);

impl std::fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ApiKey(***)")
    }
}

#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub url: String,
    pub api_key: ApiKey,
    pub model: String,
    pub voice: String,
    pub instructions: String,
    pub tools: Value,
    pub max_secs: u64,
    pub silence_secs: u64,
    pub reconnect_delay: Duration,
    /// Headphones: keep the mic open while the assistant speaks (allows barge-in).
    pub headphones: bool,
    pub confirm_ttl: Duration,
}

/// Everything the UI is told, as `va-event`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum VaEvent {
    State {
        state: VaState,
        message: Option<String>,
    },
    Level {
        input: f32,
        output: f32,
    },
    Caption {
        role: &'static str,
        item_id: String,
        text: String,
        done: bool,
    },
    Action(ActionLog),
    Usage {
        elapsed_secs: u64,
        cost_usd: f64,
    },
    Navigate {
        view: String,
        agent_id: Option<String>,
    },
    /// A side effect the model wants; runs only if the user confirms (`va_confirm`).
    ConfirmAction {
        id: String,
        kind: String,
        summary: String,
    },
    /// The confirmation card is settled: "confirmed", "cancelled" or "expired".
    ConfirmDone {
        id: String,
        status: &'static str,
    },
    /// A non-fatal message shown beside a live session; `None` clears it.
    Notice {
        message: Option<String>,
    },
    Ended {
        reason: String,
        error: bool,
    },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum VaState {
    Connecting,
    Listening,
    Thinking,
    Speaking,
    Error,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionLog {
    pub id: String,
    /// Tool name.
    pub kind: String,
    pub summary: String,
    pub agent_id: Option<String>,
    pub ok: bool,
}

pub trait VaSink: Send + Sync {
    fn emit(&self, event: VaEvent);
    /// Session totals so far, to be persisted so a crash loses little.
    fn checkpoint_usage(&self, _elapsed_secs: u64, _cost_usd: f64) {}
}

pub struct ToolOutcome {
    /// What the model receives (already sanitized/wrapped).
    pub output: String,
    pub action: Option<ActionLog>,
    /// A side effect that must not run until the user confirms; `output` is ignored
    /// in favour of a "waiting" message.
    pub pending: Option<PendingAction>,
}

pub struct PendingAction {
    /// Tool name.
    pub kind: String,
    /// What the confirmation card says, including the full prompt.
    pub summary: String,
    /// Executes the action; polled only after the user confirms.
    pub run: ToolFuture,
}

impl ToolOutcome {
    pub fn error(msg: &str) -> Self {
        ToolOutcome {
            output: super::tools::wrap_error(msg),
            action: None,
            pending: None,
        }
    }
}

pub type ToolFuture = Pin<Box<dyn Future<Output = ToolOutcome> + Send>>;

pub trait ToolHost: Send + Sync {
    fn call(&self, name: String, arguments: String) -> ToolFuture;
}

#[derive(Debug)]
pub enum Control {
    Stop,
    Mute(bool),
    /// The user answered a `ConfirmAction` card.
    Confirm {
        id: String,
        accept: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum EndReason {
    UserStopped,
    MaxLength,
    Silence,
    Error(String),
}

impl EndReason {
    pub fn label(&self) -> String {
        match self {
            EndReason::UserStopped => "ended".into(),
            EndReason::MaxLength => "maximum session length reached".into(),
            EndReason::Silence => "ended after silence".into(),
            EndReason::Error(m) => m.clone(),
        }
    }
}

pub struct SessionEnd {
    pub reason: EndReason,
    pub elapsed_secs: u64,
    pub usage: Usage,
}

enum ConnEnd {
    Done(EndReason),
    /// Connection lost; worth one retry.
    Dropped(String),
}

fn describe_ws_error(e: &tokio_tungstenite::tungstenite::Error) -> (String, bool) {
    use tokio_tungstenite::tungstenite::Error as E;
    match e {
        E::Http(resp) => match resp.status().as_u16() {
            401 => (
                "OpenAI rejected the API key. Check the account's key in Accounts.".into(),
                true,
            ),
            403 => (
                "OpenAI denied access to the Realtime API for this key or model.".into(),
                true,
            ),
            404 => (
                "OpenAI doesn't know this model. Pick another in Settings.".into(),
                true,
            ),
            429 => (
                "OpenAI rate limit or quota reached. Check billing on your OpenAI account.".into(),
                true,
            ),
            s => (
                format!("OpenAI refused the connection (HTTP {s})."),
                s < 500,
            ),
        },
        E::Io(_) | E::Tls(_) | E::Url(_) => (
            "Couldn't reach OpenAI. Check your internet connection.".into(),
            false,
        ),
        other => (format!("Connection to OpenAI failed: {other}"), false),
    }
}

/// Runs a session to completion.
pub async fn run(
    cfg: SessionConfig,
    sink: Arc<dyn VaSink>,
    host: Arc<dyn ToolHost>,
    mut devices: Box<dyn AudioDevices>,
    mut control: UnboundedReceiver<Control>,
) -> SessionEnd {
    let started = Instant::now();
    let mut usage = Usage::default();
    let finish = |reason: EndReason, usage: Usage| SessionEnd {
        reason,
        elapsed_secs: started.elapsed().as_secs(),
        usage,
    };
    sink.emit(VaEvent::State {
        state: VaState::Connecting,
        message: None,
    });
    // Opening the devices can block for seconds (the audio threads reply within 10 s).
    let opened = tokio::task::spawn_blocking(move || devices.open()).await;
    let mut io = match opened {
        Ok(Ok(io)) => io,
        Ok(Err(e)) => return finish(EndReason::Error(e), usage),
        Err(_) => {
            return finish(
                EndReason::Error("Couldn't open the audio devices.".into()),
                usage,
            )
        }
    };
    let mut muted = false;
    let mut attempt = 0;
    let mut reconnected = false;
    loop {
        let ws = match connect(&cfg).await {
            Ok(ws) => ws,
            Err(e) => {
                let (msg, fatal) = describe_ws_error(&e);
                warn!("realtime connect failed: {msg}");
                if fatal || attempt >= 1 {
                    return finish(EndReason::Error(msg), usage);
                }
                attempt += 1;
                sink.emit(VaEvent::State {
                    state: VaState::Connecting,
                    message: Some("Reconnecting".into()),
                });
                tokio::time::sleep(cfg.reconnect_delay).await;
                continue;
            }
        };
        let connected_at = Instant::now();
        let end = connection(
            &cfg,
            ws,
            &sink,
            &host,
            &mut io.mic,
            &io.speaker,
            &mut control,
            &mut muted,
            &mut usage,
            started,
            std::mem::replace(&mut reconnected, true),
        )
        .await;
        match end {
            ConnEnd::Done(reason) => return finish(reason, usage),
            ConnEnd::Dropped(msg) => {
                warn!("realtime connection dropped: {msg}");
                attempt = attempts_after_drop(attempt, connected_at.elapsed());
                if attempt >= 1 {
                    return finish(EndReason::Error(msg), usage);
                }
                attempt += 1;
                io.speaker.clear();
                sink.emit(VaEvent::State {
                    state: VaState::Connecting,
                    message: Some("Reconnecting".into()),
                });
                tokio::time::sleep(cfg.reconnect_delay).await;
            }
        }
    }
}

/// Reconnect attempts already used after a connection dropped: a connection that was
/// healthy for [`STABLE_AFTER`] earns a fresh attempt.
pub(super) fn attempts_after_drop(attempt: u32, connected_for: Duration) -> u32 {
    if connected_for >= STABLE_AFTER {
        0
    } else {
        attempt
    }
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(cfg: &SessionConfig) -> Result<Ws, tokio_tungstenite::tungstenite::Error> {
    let mut req = cfg.url.as_str().into_client_request()?;
    let mut auth = HeaderValue::from_str(&format!("Bearer {}", cfg.api_key.0)).map_err(|_| {
        tokio_tungstenite::tungstenite::Error::Utf8("invalid key characters".into())
    })?;
    auth.set_sensitive(true);
    req.headers_mut().insert("Authorization", auth);
    let (ws, _) = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async(req),
    )
    .await
    .map_err(|_| {
        tokio_tungstenite::tungstenite::Error::Io(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "connect timeout",
        ))
    })??;
    Ok(ws)
}

#[derive(Default)]
struct ItemAudio {
    start_pushed: u64,
    samples: u64,
}

struct PendingConfirm {
    run: ToolFuture,
    expires: Instant,
}

/// Runs a tool future with a deadline, turning a timeout or a panic into an error the
/// model can read, so a call can never stay "in flight" forever.
async fn run_guarded(fut: ToolFuture) -> ToolOutcome {
    match tokio::time::timeout(TOOL_TIMEOUT, tokio::spawn(fut)).await {
        Ok(Ok(o)) => o,
        Ok(Err(_)) => ToolOutcome::error("The action failed unexpectedly."),
        Err(_) => ToolOutcome::error(
            "The action timed out. It may still finish; check list_agents before retrying.",
        ),
    }
}

#[allow(clippy::too_many_arguments)]
async fn connection(
    cfg: &SessionConfig,
    ws: Ws,
    ui: &Arc<dyn VaSink>,
    host: &Arc<dyn ToolHost>,
    mic: &mut UnboundedReceiver<Vec<i16>>,
    speaker: &Arc<SpeakerBuffer>,
    control: &mut UnboundedReceiver<Control>,
    muted: &mut bool,
    usage: &mut Usage,
    started: Instant,
    reconnected: bool,
) -> ConnEnd {
    let mut pending: HashMap<String, PendingConfirm> = HashMap::new();
    let end = connection_inner(
        cfg,
        ws,
        ui,
        host,
        mic,
        speaker,
        control,
        muted,
        usage,
        started,
        reconnected,
        &mut pending,
    )
    .await;
    // Confirmations belong to this conversation; a new connection can't answer them.
    for id in pending.into_keys() {
        ui.emit(VaEvent::ConfirmDone {
            id,
            status: "cancelled",
        });
    }
    end
}

#[allow(clippy::too_many_arguments)]
async fn connection_inner(
    cfg: &SessionConfig,
    ws: Ws,
    ui: &Arc<dyn VaSink>,
    host: &Arc<dyn ToolHost>,
    mic: &mut UnboundedReceiver<Vec<i16>>,
    speaker: &Arc<SpeakerBuffer>,
    control: &mut UnboundedReceiver<Control>,
    muted: &mut bool,
    usage: &mut Usage,
    started: Instant,
    reconnected: bool,
    pending: &mut HashMap<String, PendingConfirm>,
) -> ConnEnd {
    let (mut tx, mut rx) = ws.split();
    macro_rules! send {
        ($v:expr) => {
            if let Err(e) = tx.send(Message::text($v.to_string())).await {
                return ConnEnd::Dropped(format!("Connection to OpenAI lost: {e}"));
            }
        };
    }
    send!(p::session_update(
        &cfg.model,
        &cfg.voice,
        &cfg.instructions,
        &cfg.tools
    ));

    let (tool_tx, mut tool_rx) = unbounded_channel::<(String, ToolOutcome)>();
    // Results of confirmed actions.
    let (late_tx, mut late_rx) = unbounded_channel::<ToolOutcome>();
    let mut late_in_flight = 0usize;
    let mut proposals = 0u32;
    let mut audio_items: HashMap<String, ItemAudio> = HashMap::new();
    let mut cancelled: HashSet<String> = HashSet::new();
    let mut user_text: HashMap<String, String> = HashMap::new();
    let mut bot_text: HashMap<String, String> = HashMap::new();
    let mut current_item: Option<String> = None;
    let mut response_active = false;
    let mut need_followup = false;
    let mut calls_in_flight = 0usize;
    let mut state = VaState::Connecting;
    let mut last_activity = Instant::now();
    let mut in_level = 0.0f32;
    let mut last_usage_emit = Instant::now() - Duration::from_secs(2);
    let mut ticker = tokio::time::interval(TICK);
    let mut echo_until: Option<Instant> = None;
    let mut notice_at: Option<Instant> = None;
    let mut announce_reconnect = reconnected;

    macro_rules! set_state {
        ($s:expr) => {
            if state != $s {
                state = $s;
                ui.emit(VaEvent::State {
                    state,
                    message: None,
                });
            }
        };
    }
    macro_rules! set_notice {
        ($m:expr) => {
            notice_at = Some(Instant::now());
            ui.emit(VaEvent::Notice {
                message: Some(String::from($m)),
            });
        };
    }
    // Tells the model something Armada knows (not the user, not a tool) and lets it speak.
    macro_rules! inform {
        ($text:expr) => {
            send!(p::system_note(&String::from($text)));
            if response_active {
                need_followup = true;
            } else {
                response_active = true;
                send!(p::response_create());
            }
        };
    }

    loop {
        tokio::select! {
            biased;
            c = control.recv() => match c {
                Some(Control::Mute(m)) => { *muted = m; if m { in_level = 0.0; } }
                Some(Control::Confirm { id, accept }) => {
                    if let Some(entry) = pending.remove(&id) {
                        ui.emit(VaEvent::ConfirmDone { id, status: if accept { "confirmed" } else { "cancelled" } });
                        last_activity = Instant::now();
                        if accept {
                            late_in_flight += 1;
                            let out = late_tx.clone();
                            tokio::spawn(async move {
                                let _ = out.send(run_guarded(entry.run).await);
                            });
                        } else {
                            inform!("Armada: the user declined the action on screen. It was not done.");
                        }
                    }
                }
                Some(Control::Stop) | None => {
                    let _ = tx.send(Message::Close(None)).await;
                    return ConnEnd::Done(EndReason::UserStopped);
                }
            },
            msg = rx.next() => {
                let text = match msg {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Close(_))) | None => {
                        return ConnEnd::Dropped("OpenAI closed the connection.".into());
                    }
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => return ConnEnd::Dropped(describe_ws_error(&e).0),
                };
                let Some(event) = p::parse_server_event(text.as_str()) else { continue };
                match event {
                    ServerEvent::SessionCreated | ServerEvent::SessionUpdated => {
                        if state == VaState::Connecting { set_state!(VaState::Listening); }
                        if std::mem::take(&mut announce_reconnect) {
                            set_notice!("Reconnected \u{2014} earlier context was lost");
                        }
                    }
                    ServerEvent::Error { error } => {
                        let code = error.code.clone().unwrap_or_default();
                        if BENIGN_CODES.contains(&code.as_str()) {
                            debug!("benign realtime error: {code}");
                        } else if FATAL_CODES.contains(&code.as_str()) {
                            return ConnEnd::Done(EndReason::Error(fatal_message(&code, &error.message)));
                        } else {
                            // The session is still open and billing: keep it live and
                            // say what happened beside it.
                            warn!("realtime error {code}: {}", error.message);
                            set_notice!(clip(&error.message));
                        }
                    }
                    ServerEvent::SpeechStarted => {
                        last_activity = Instant::now();
                        // Barge-in: stop what the listener is hearing and tell the server
                        // how much of it they actually heard.
                        if let Some(item) = current_item.take() {
                            let heard = audio_items.get(&item)
                                .map(|a| p::heard_ms(a.start_pushed, speaker.played(), a.samples))
                                .unwrap_or(0);
                            speaker.clear();
                            if response_active { send!(p::response_cancel()); }
                            send!(p::item_truncate(&item, heard));
                            cancelled.insert(item);
                        } else if response_active {
                            send!(p::response_cancel());
                        }
                        set_state!(VaState::Listening);
                    }
                    ServerEvent::SpeechStopped => {
                        if calls_in_flight == 0 { set_state!(VaState::Thinking); }
                    }
                    ServerEvent::InputTranscriptDelta { item_id, delta } => {
                        let t = user_text.entry(item_id.clone()).or_default();
                        t.push_str(&delta);
                        ui.emit(VaEvent::Caption { role: "user", item_id, text: t.clone(), done: false });
                    }
                    ServerEvent::InputTranscriptDone { item_id, transcript } => {
                        // A new user turn: side-effect proposals start from zero again.
                        proposals = 0;
                        user_text.insert(item_id.clone(), transcript.clone());
                        ui.emit(VaEvent::Caption { role: "user", item_id, text: transcript, done: true });
                    }
                    ServerEvent::ResponseCreated => response_active = true,
                    ServerEvent::AudioDelta { item_id, delta } => {
                        if cancelled.contains(&item_id) { continue; }
                        let Ok(pcm) = audio::base64_to_pcm16(&delta) else { continue };
                        last_activity = Instant::now();
                        let entry = audio_items.entry(item_id.clone()).or_insert_with(|| ItemAudio {
                            start_pushed: speaker.pushed(),
                            samples: 0,
                        });
                        entry.samples += pcm.len() as u64;
                        speaker.push(&pcm);
                        current_item = Some(item_id);
                        set_state!(VaState::Speaking);
                    }
                    ServerEvent::AudioDone => {}
                    ServerEvent::OutputTranscriptDelta { item_id, delta } => {
                        if cancelled.contains(&item_id) { continue; }
                        let t = bot_text.entry(item_id.clone()).or_default();
                        t.push_str(&delta);
                        ui.emit(VaEvent::Caption { role: "assistant", item_id, text: t.clone(), done: false });
                    }
                    ServerEvent::OutputTranscriptDone { item_id, transcript } => {
                        if !transcript.is_empty() && !cancelled.contains(&item_id) {
                            ui.emit(VaEvent::Caption { role: "assistant", item_id, text: transcript, done: true });
                        }
                    }
                    ServerEvent::FunctionCallDone { call_id, name, arguments } => {
                        last_activity = Instant::now();
                        need_followup = true;
                        calls_in_flight += 1;
                        set_state!(VaState::Thinking);
                        let (host, out) = (host.clone(), tool_tx.clone());
                        tokio::spawn(async move {
                            let outcome = run_guarded(host.call(name, arguments)).await;
                            let _ = out.send((call_id, outcome));
                        });
                    }
                    ServerEvent::ResponseDone { response } => {
                        response_active = false;
                        if let Some(u) = &response.usage { usage.add(u); }
                        emit_usage(ui, started, usage);
                        let elapsed = started.elapsed().as_secs();
                        ui.checkpoint_usage(elapsed, session_cost(usage, elapsed));
                        if need_followup && calls_in_flight == 0 {
                            need_followup = false;
                            response_active = true;
                            send!(p::response_create());
                        }
                    }
                    ServerEvent::RateLimits | ServerEvent::Other => {}
                }
            },
            Some((call_id, mut outcome)) = tool_rx.recv() => {
                last_activity = Instant::now();
                calls_in_flight = calls_in_flight.saturating_sub(1);
                if let Some(action) = outcome.pending.take() {
                    if proposals >= MAX_PROPOSALS_PER_TURN {
                        outcome = ToolOutcome::error(
                            "Too many actions were proposed in this turn. Do not propose more; ask the user what they want next.",
                        );
                    } else {
                        proposals += 1;
                        let id = uuid::Uuid::new_v4().to_string();
                        ui.emit(VaEvent::ConfirmAction {
                            id: id.clone(),
                            kind: action.kind,
                            summary: action.summary,
                        });
                        pending.insert(id, PendingConfirm {
                            run: action.run,
                            expires: Instant::now() + cfg.confirm_ttl,
                        });
                        outcome.output = super::tools::wrap_data(serde_json::json!({
                            "status": "waiting_for_user",
                            "note": "Waiting for the user to confirm on screen. Nothing has been done yet. Tell them briefly to confirm on screen."
                        }));
                    }
                }
                if let Some(a) = outcome.action { ui.emit(VaEvent::Action(a)); }
                send!(p::function_call_output(&call_id, &outcome.output));
                if need_followup && calls_in_flight == 0 && !response_active {
                    need_followup = false;
                    response_active = true;
                    send!(p::response_create());
                }
            },
            Some(outcome) = late_rx.recv() => {
                last_activity = Instant::now();
                late_in_flight = late_in_flight.saturating_sub(1);
                if let Some(a) = outcome.action { ui.emit(VaEvent::Action(a)); }
                inform!(format!(
                    "Armada: the user confirmed on screen and the action ran. Result (untrusted data): {}",
                    outcome.output
                ));
            },
            chunk = mic.recv() => {
                let Some(chunk) = chunk else {
                    return ConnEnd::Done(EndReason::Error("The microphone stopped working. Check your system's sound settings.".into()));
                };
                let now = Instant::now();
                if speaker.queued() > 0 || state == VaState::Speaking {
                    echo_until = Some(now + ECHO_TAIL);
                }
                // Without headphones the assistant's own voice would come back through
                // the mic, so it is not sent while that voice is playing.
                let echo_gate = !cfg.headphones && echo_until.is_some_and(|t| now < t);
                if !*muted && !echo_gate {
                    in_level = in_level.max(audio::level_i16(&chunk));
                    send!(p::audio_append(&audio::pcm16_to_base64(&chunk)));
                }
            },
            _ = ticker.tick() => {
                let out_level = speaker.level();
                ui.emit(VaEvent::Level { input: in_level, output: out_level });
                in_level = 0.0;
                if state == VaState::Speaking && !response_active && speaker.queued() == 0 && out_level == 0.0 {
                    set_state!(VaState::Listening);
                }
                if last_usage_emit.elapsed() >= Duration::from_secs(1) {
                    last_usage_emit = Instant::now();
                    emit_usage(ui, started, usage);
                }
                let now = Instant::now();
                if notice_at.is_some_and(|t| now.duration_since(t) >= NOTICE_FOR) {
                    notice_at = None;
                    ui.emit(VaEvent::Notice { message: None });
                }
                let expired: Vec<String> = pending
                    .iter()
                    .filter(|(_, e)| e.expires <= now)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in expired {
                    pending.remove(&id);
                    ui.emit(VaEvent::ConfirmDone { id, status: "expired" });
                    inform!("Armada: the user did not confirm in time. The action was cancelled and not done.");
                }
                if started.elapsed().as_secs() >= cfg.max_secs {
                    let _ = tx.send(Message::Close(None)).await;
                    return ConnEnd::Done(EndReason::MaxLength);
                }
                let busy = response_active || calls_in_flight > 0 || late_in_flight > 0
                    || !pending.is_empty() || speaker.queued() > 0;
                if !busy && last_activity.elapsed().as_secs() >= cfg.silence_secs {
                    let _ = tx.send(Message::Close(None)).await;
                    return ConnEnd::Done(EndReason::Silence);
                }
            }
        }
    }
}

fn emit_usage(ui: &Arc<dyn VaSink>, started: Instant, usage: &Usage) {
    let elapsed_secs = started.elapsed().as_secs();
    ui.emit(VaEvent::Usage {
        elapsed_secs,
        cost_usd: session_cost(usage, elapsed_secs),
    });
}

fn clip(s: &str) -> String {
    s.chars().take(200).collect()
}

fn fatal_message(code: &str, message: &str) -> String {
    match code {
        "invalid_api_key" => {
            "OpenAI rejected the API key. Check the account's key in Accounts.".into()
        }
        "insufficient_quota" | "billing_hard_limit_reached" => {
            "Your OpenAI account is out of quota. Check billing on platform.openai.com.".into()
        }
        _ => clip(message),
    }
}
