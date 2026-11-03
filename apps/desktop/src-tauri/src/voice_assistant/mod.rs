//! Voice assistant: talk to Kvistcode through OpenAI's Realtime API (`gpt-realtime`).
//!
//! Audio goes to OpenAI and the assistant reads agent information through tools, so
//! the feature is off until the user enables it in Settings and picks the OpenAI API
//! key account that pays for it. The key is read from the OS keychain here in Rust and
//! never reaches the webview.

mod audio;
mod cost;
mod host;
mod news;
mod protocol;
mod screen;
mod session;
#[cfg(test)]
mod tests;
mod tools;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::AppHandle;
use kvistcode_core::{accounts, AuthKind, Core, Provider};
use parking_lot::Mutex;
use tauri::{Emitter, State};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tracing::warn;

use crate::commands::CmdResult;
use crate::state::Shell;
pub use screen::ScreenContext;
use session::{ApiKey, Control, EndReason, SessionConfig, VaEvent, VaSink, VaState};

pub const EVENT: &str = "va-event";
/// Most agents of the window's order that are kept (more than a person has open).
const MAX_REPORTED_AGENTS: usize = 200;

#[derive(Default)]
pub struct VoiceAssistant {
    control: Mutex<Option<UnboundedSender<Control>>>,
    screen: Arc<Mutex<ScreenContext>>,
    /// What the agents did while a session is live (see `news.rs`).
    news: Arc<Mutex<news::Feed>>,
    /// The live session is paused (its microphone is closed).
    paused: Arc<AtomicBool>,
}

impl VoiceAssistant {
    /// Core says an agent finished, needs the user or failed: remember it for the live
    /// session. Only the kind and the id are kept, never what the agent wrote.
    pub fn on_attention(&self, agent_id: &str, reason: kvistcode_core::AttentionReason) {
        if self.active() {
            self.news.lock().record(
                agent_id,
                news::Kind::from_reason(reason),
                std::time::Instant::now(),
            );
        }
    }

    /// Takes the single session slot; check and set happen under one lock.
    fn claim(&self, tx: &UnboundedSender<Control>) -> Result<(), String> {
        let mut slot = self.control.lock();
        if slot.is_some() {
            return Err("The voice assistant is already running.".into());
        }
        *slot = Some(tx.clone());
        Ok(())
    }

    /// Frees the slot, but only if `tx` is the session that holds it.
    fn release(&self, tx: &UnboundedSender<Control>) {
        let mut slot = self.control.lock();
        if slot.as_ref().is_some_and(|t| t.same_channel(tx)) {
            *slot = None;
        }
    }

    fn send(&self, c: Control) {
        if let Some(tx) = self.control.lock().as_ref() {
            let _ = tx.send(c);
        }
    }

    fn active(&self) -> bool {
        self.control.lock().is_some()
    }

    /// A session is running with its microphone open (not paused).
    pub fn holds_mic(&self) -> bool {
        self.active() && !self.paused.load(Ordering::Relaxed)
    }

    /// The wake phrase was heard: a paused session listens again and is asked `request`.
    /// `false` when no session is running.
    pub fn wake(&self, request: Option<String>) -> bool {
        let slot = self.control.lock();
        let Some(tx) = slot.as_ref() else {
            return false;
        };
        let _ = tx.send(match request {
            Some(text) => Control::Request(text),
            None => Control::Resume,
        });
        true
    }
}

/// Owns the session slot for the lifetime of the session task. If the task panics, the
/// drop frees the slot and tells the UI, so the assistant can't stay "running" forever.
struct SessionGuard {
    app: AppHandle,
    tx: UnboundedSender<Control>,
    sink: Arc<dyn VaSink>,
    finished: bool,
}

impl SessionGuard {
    fn release(&self) {
        if let Some(va) = tauri::Manager::try_state::<VoiceAssistant>(&self.app) {
            va.release(&self.tx);
        }
    }

    /// Frees the slot first, so a start right after `Ended` is accepted.
    fn finish(mut self, reason: String, error: bool) {
        self.release();
        self.finished = true;
        self.sink.emit(VaEvent::Ended { reason, error });
    }
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.release();
        if !self.finished {
            self.sink.emit(VaEvent::Ended {
                reason: "The voice assistant stopped unexpectedly.".into(),
                error: true,
            });
        }
    }
}

struct TauriSink {
    app: AppHandle,
    ledger: Mutex<cost::SessionLedger>,
    paused: Arc<AtomicBool>,
}

impl VaSink for TauriSink {
    fn emit(&self, event: VaEvent) {
        match &event {
            VaEvent::State { state, .. } => {
                self.paused
                    .store(*state == VaState::Paused, Ordering::Relaxed);
            }
            VaEvent::Ended { .. } => self.paused.store(false, Ordering::Relaxed),
            _ => {}
        }
        let _ = self.app.emit(EVENT, event);
    }

    fn checkpoint_usage(&self, elapsed_secs: u64, cost_usd: f64) {
        if let Err(e) = self.ledger.lock().checkpoint(elapsed_secs, cost_usd) {
            warn!("could not record voice assistant usage: {e}");
        }
    }
}

/// The model name goes into a URL; keep it to what model ids look like.
fn valid_model(m: &str) -> bool {
    !m.is_empty()
        && m.len() <= 64
        && m.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._".contains(c))
}

/// With confirmations off the instructions above (which describe a confirmation card) are
/// corrected, so the assistant doesn't tell the user to press a button that isn't there.
fn with_auto_confirm(instructions: String, auto: bool) -> String {
    if auto {
        format!(
            "{instructions}\n- The user has turned confirmations off: start_agent, send_message and the \
other actions run at once, with no card to press. Say in a few words what you are doing, and \
never say they need to confirm on screen."
        )
    } else {
        instructions
    }
}

/// The user's default language, as one more line of the assistant's instructions (the model
/// speaks it, and understands them in any language).
fn with_language(instructions: String, language_note: &str) -> String {
    if language_note.is_empty() {
        instructions
    } else {
        format!("{instructions}\n- {language_note}")
    }
}

/// With the wake phrase on, a paused assistant can be woken by voice after all.
fn with_wake_phrase(instructions: String, phrase: Option<&str>) -> String {
    match phrase {
        Some(phrase) => format!(
            "{instructions}\n- Exception: the user has a wake phrase, \u{201c}{phrase}\u{201d}. While you are \
paused, Kvistcode listens on this computer for it and wakes you when they say it, so you may tell \
them they can say \u{201c}{phrase}\u{201d} to wake you."
        ),
        None => instructions,
    }
}

/// What the user said after the wake phrase, as the first thing to answer.
fn clean_request(request: Option<String>) -> Option<String> {
    let text = request?.split_whitespace().collect::<Vec<_>>().join(" ");
    let text: String = text.chars().take(MAX_REQUEST_CHARS).collect();
    (!text.is_empty()).then_some(text)
}

const MAX_REQUEST_CHARS: usize = 500;

fn build_config(
    core: &Core,
    data_dir: &std::path::Path,
    request: Option<String>,
) -> Result<SessionConfig, String> {
    let all = core.settings().map_err(|e| format!("{e:#}"))?;
    let language = kvistcode_core::guidance::language_note(&all.default_language);
    let wake_phrase = crate::wake::ready_phrase(&all, data_dir);
    let s = all.voice_assistant;
    if !s.enabled {
        return Err("The voice assistant is off. Turn it on in Settings > Voice assistant.".into());
    }
    let account_id = s.account_id.ok_or(
        "Pick the OpenAI API key account to use in Settings > Voice assistant.".to_string(),
    )?;
    let account = core.account(&account_id).map_err(|_| {
        "The selected OpenAI account no longer exists. Pick another in Settings.".to_string()
    })?;
    if account.provider != Provider::Codex || account.auth_kind != AuthKind::ApiKey {
        return Err("The voice assistant needs an OpenAI API key account.".into());
    }
    let key = accounts::get_api_key(&account.id)
        .filter(|k| !k.trim().is_empty())
        .ok_or(
            "That account's API key isn't in the keychain. Re-enter it in Accounts.".to_string(),
        )?;
    let model = if valid_model(&s.model) {
        s.model
    } else {
        "gpt-realtime".into()
    };
    let voice = if protocol::VOICES.contains(&s.voice.as_str()) {
        s.voice
    } else {
        "marin".into()
    };
    Ok(SessionConfig {
        url: protocol::realtime_url(protocol::REALTIME_BASE_URL, &model),
        api_key: ApiKey(key.trim().to_string()),
        model,
        voice,
        instructions: with_wake_phrase(
            with_auto_confirm(
                with_language(tools::instructions(), &language),
                s.auto_confirm,
            ),
            wake_phrase.as_deref(),
        ),
        tools: tools::tool_schemas(),
        max_secs: u64::from(s.max_session_mins.clamp(1, 60)) * 60,
        silence_secs: u64::from(s.silence_timeout_secs.clamp(10, 600)),
        reconnect_delay: Duration::from_millis(1200),
        headphones: s.headphones,
        auto_confirm: s.auto_confirm,
        confirm_ttl: session::CONFIRM_TTL,
        first_request: clean_request(request),
    })
}

/// `request`: what the user said after the wake phrase, asked as soon as the session is up.
#[tauri::command]
pub async fn va_start(
    app: AppHandle,
    core: State<'_, Core>,
    shell: State<'_, Shell>,
    va: State<'_, VoiceAssistant>,
    request: Option<String>,
) -> CmdResult<()> {
    let cfg = build_config(&core, &shell.data_dir, request)?;
    let input_device = core.settings().ok().and_then(|s| s.voice.input_device);
    let (ctl_tx, ctl_rx) = unbounded_channel();
    va.claim(&ctl_tx)?;
    // A new session starts from what the window shows now, not from where the last one ended.
    *va.screen.lock() = ScreenContext::default();
    va.news.lock().clear();
    va.paused.store(false, Ordering::Relaxed);

    let core = (*core).clone();
    let screen = va.screen.clone();
    let news = va.news.clone();
    let sink: Arc<dyn VaSink> = Arc::new(TauriSink {
        app: app.clone(),
        ledger: Mutex::new(cost::SessionLedger::new(core.data_dir())),
        paused: va.paused.clone(),
    });
    let guard = SessionGuard {
        app: app.clone(),
        tx: ctl_tx,
        sink: sink.clone(),
        finished: false,
    };
    let host = Arc::new(host::KvistcodeTools::new(
        app.clone(),
        core,
        sink.clone(),
        screen,
        news,
    ));
    tauri::async_runtime::spawn(async move {
        let devices = Box::new(audio::SystemAudio { input_device });
        let end = session::run(cfg, sink.clone(), host, devices, ctl_rx).await;
        // The ledger already holds what earlier `response.done`s reported; this adds
        // the remainder.
        if end.elapsed_secs > 0 {
            sink.checkpoint_usage(
                end.elapsed_secs,
                cost::session_cost(&end.usage, end.elapsed_secs),
            );
        }
        let error = matches!(end.reason, EndReason::Error(_));
        if error {
            sink.emit(VaEvent::State {
                state: VaState::Error,
                message: Some(end.reason.label()),
            });
        }
        guard.finish(end.reason.label(), error);
    });
    Ok(())
}

#[tauri::command]
pub fn va_stop(va: State<'_, VoiceAssistant>) {
    va.send(Control::Stop);
}

/// Mute / unmute. Muting is the same state as "pause listening" and "go to sleep": the
/// connection and the microphone are closed until unmuted.
#[tauri::command]
pub fn va_set_muted(va: State<'_, VoiceAssistant>, muted: bool) {
    va.send(if muted {
        Control::Pause
    } else {
        Control::Resume
    });
}

/// The UI reports what is on screen (view, open agent, highlighted text). When the user has
/// moved (another screen, agent or project) the model is told quietly, so it needn't be asked.
#[tauri::command]
pub fn va_set_screen(
    va: State<'_, VoiceAssistant>,
    core: State<'_, Core>,
    mut screen: ScreenContext,
) {
    screen.agent_order.truncate(MAX_REPORTED_AGENTS);
    // The folder of the agent in focus; kept while the user is on a screen without one, so
    // coming back to a different project counts as switching.
    let focus = screen
        .agent_id
        .clone()
        .or_else(|| screen.review_agent_id.clone());
    let project = focus.and_then(|id| {
        core.agents()
            .unwrap_or_default()
            .into_iter()
            .find(|a| a.id == id)
            .map(|a| a.project_path)
    });
    let prev = {
        let mut cur = va.screen.lock();
        screen.project = project.or_else(|| cur.project.clone());
        std::mem::replace(&mut *cur, screen.clone())
    };
    if let Some(note) = screen::screen_change_note(&prev, &screen) {
        va.send(Control::Screen(note));
    }
}

/// The user's answer to a confirmation card.
#[tauri::command]
pub fn va_confirm(va: State<'_, VoiceAssistant>, id: String, accept: bool) {
    va.send(Control::Confirm { id, accept });
}

#[tauri::command]
pub fn va_active(va: State<'_, VoiceAssistant>) -> bool {
    va.active()
}

/// Ends an active session and waits (at most 2 s) for its usage to be recorded.
pub async fn shutdown(app: &AppHandle) {
    let Some(va) = tauri::Manager::try_state::<VoiceAssistant>(app) else {
        return;
    };
    if !va.active() {
        return;
    }
    va.send(Control::Stop);
    for _ in 0..40 {
        if !va.active() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    warn!("voice assistant did not stop within 2 s of shutdown");
}

#[tauri::command]
pub fn va_usage(core: State<'_, Core>) -> cost::MonthUsage {
    cost::read_month(core.data_dir(), &cost::current_month())
}

#[tauri::command]
pub fn va_voices() -> Vec<&'static str> {
    protocol::VOICES.to_vec()
}

#[cfg(test)]
mod slot_tests {
    use super::*;

    #[test]
    fn only_one_session_holds_the_slot_and_it_can_be_retaken() {
        let va = VoiceAssistant::default();
        let (a, _ra) = unbounded_channel();
        let (b, _rb) = unbounded_channel();
        va.claim(&a).unwrap();
        assert!(va.claim(&b).is_err());
        // A stale holder can't free a newer session's slot.
        va.release(&b);
        assert!(va.active());
        va.release(&a);
        assert!(!va.active());
        va.claim(&b).unwrap();
    }
}
