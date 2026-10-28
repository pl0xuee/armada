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
use super::cost::Usage;
use super::protocol::{self as p, ServerEvent};

const TOOL_TIMEOUT: Duration = Duration::from_secs(25);
const TICK: Duration = Duration::from_millis(60);

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
}

pub struct ToolOutcome {
    /// What the model receives (already sanitized/wrapped).
    pub output: String,
    pub action: Option<ActionLog>,
}

pub type ToolFuture = Pin<Box<dyn Future<Output = ToolOutcome> + Send>>;

pub trait ToolHost: Send + Sync {
    fn call(&self, name: String, arguments: String) -> ToolFuture;
}

#[derive(Debug)]
pub enum Control {
    Stop,
    Mute(bool),
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
    devices: &mut dyn AudioDevices,
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
    let mut io = match devices.open() {
        Ok(io) => io,
        Err(e) => return finish(EndReason::Error(e), usage),
    };
    let mut muted = false;
    let mut attempt = 0;
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
        )
        .await;
        match end {
            ConnEnd::Done(reason) => return finish(reason, usage),
            ConnEnd::Dropped(msg) => {
                warn!("realtime connection dropped: {msg}");
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

    loop {
        tokio::select! {
            biased;
            c = control.recv() => match c {
                Some(Control::Mute(m)) => { *muted = m; if m { in_level = 0.0; } }
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
                    }
                    ServerEvent::Error { error } => {
                        let code = error.code.clone().unwrap_or_default();
                        if BENIGN_CODES.contains(&code.as_str()) {
                            debug!("benign realtime error: {code}");
                        } else if FATAL_CODES.contains(&code.as_str()) {
                            return ConnEnd::Done(EndReason::Error(fatal_message(&code, &error.message)));
                        } else {
                            warn!("realtime error {code}: {}", error.message);
                            ui.emit(VaEvent::State { state: VaState::Error, message: Some(clip(&error.message)) });
                            state = VaState::Error;
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
                            let outcome = match tokio::time::timeout(TOOL_TIMEOUT, host.call(name, arguments)).await {
                                Ok(o) => o,
                                Err(_) => ToolOutcome {
                                    output: super::tools::wrap_error("The action timed out."),
                                    action: None,
                                },
                            };
                            let _ = out.send((call_id, outcome));
                        });
                    }
                    ServerEvent::ResponseDone { response } => {
                        response_active = false;
                        if let Some(u) = &response.usage { usage.add(u); }
                        emit_usage(ui, started, usage);
                        if need_followup && calls_in_flight == 0 {
                            need_followup = false;
                            response_active = true;
                            send!(p::response_create());
                        }
                    }
                    ServerEvent::RateLimits | ServerEvent::Other => {}
                }
            },
            Some((call_id, outcome)) = tool_rx.recv() => {
                last_activity = Instant::now();
                calls_in_flight = calls_in_flight.saturating_sub(1);
                if let Some(a) = outcome.action { ui.emit(VaEvent::Action(a)); }
                send!(p::function_call_output(&call_id, &outcome.output));
                if need_followup && calls_in_flight == 0 && !response_active {
                    need_followup = false;
                    response_active = true;
                    send!(p::response_create());
                }
            },
            chunk = mic.recv() => {
                let Some(chunk) = chunk else {
                    return ConnEnd::Done(EndReason::Error("The microphone stopped working. Check your system's sound settings.".into()));
                };
                if !*muted {
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
                if started.elapsed().as_secs() >= cfg.max_secs {
                    let _ = tx.send(Message::Close(None)).await;
                    return ConnEnd::Done(EndReason::MaxLength);
                }
                let busy = response_active || calls_in_flight > 0 || speaker.queued() > 0;
                if !busy && last_activity.elapsed().as_secs() >= cfg.silence_secs {
                    let _ = tx.send(Message::Close(None)).await;
                    return ConnEnd::Done(EndReason::Silence);
                }
            }
        }
    }
}

fn emit_usage(ui: &Arc<dyn VaSink>, started: Instant, usage: &Usage) {
    ui.emit(VaEvent::Usage {
        elapsed_secs: started.elapsed().as_secs(),
        cost_usd: usage.cost_usd(),
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
