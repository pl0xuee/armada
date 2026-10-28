//! Voice assistant: talk to Armada through OpenAI's Realtime API (`gpt-realtime`).
//!
//! Audio goes to OpenAI and the assistant reads agent information through tools, so
//! the feature is off until the user enables it in Settings and picks the OpenAI API
//! key account that pays for it. The key is read from the OS keychain here in Rust and
//! never reaches the webview.

mod audio;
mod cost;
mod host;
mod protocol;
mod session;
#[cfg(test)]
mod tests;
mod tools;

use std::sync::Arc;
use std::time::Duration;

use crate::AppHandle;
use armada_core::{accounts, AuthKind, Core, Provider};
use parking_lot::Mutex;
use tauri::{Emitter, State};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tracing::warn;

use crate::commands::CmdResult;
use session::{ApiKey, Control, EndReason, SessionConfig, VaEvent, VaSink, VaState};

pub const EVENT: &str = "va-event";

#[derive(Default)]
pub struct VoiceAssistant {
    control: Mutex<Option<UnboundedSender<Control>>>,
}

impl VoiceAssistant {
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
}

impl VaSink for TauriSink {
    fn emit(&self, event: VaEvent) {
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

fn build_config(core: &Core) -> Result<SessionConfig, String> {
    let s = core
        .settings()
        .map_err(|e| format!("{e:#}"))?
        .voice_assistant;
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
        instructions: tools::instructions(),
        tools: tools::tool_schemas(),
        max_secs: u64::from(s.max_session_mins.clamp(1, 60)) * 60,
        silence_secs: u64::from(s.silence_timeout_secs.clamp(10, 600)),
        reconnect_delay: Duration::from_millis(1200),
        headphones: s.headphones,
        confirm_ttl: session::CONFIRM_TTL,
    })
}

#[tauri::command]
pub async fn va_start(
    app: AppHandle,
    core: State<'_, Core>,
    va: State<'_, VoiceAssistant>,
) -> CmdResult<()> {
    let cfg = build_config(&core)?;
    let input_device = core.settings().ok().and_then(|s| s.voice.input_device);
    let (ctl_tx, ctl_rx) = unbounded_channel();
    va.claim(&ctl_tx)?;

    let core = (*core).clone();
    let sink: Arc<dyn VaSink> = Arc::new(TauriSink {
        app: app.clone(),
        ledger: Mutex::new(cost::SessionLedger::new(core.data_dir())),
    });
    let guard = SessionGuard {
        app: app.clone(),
        tx: ctl_tx,
        sink: sink.clone(),
        finished: false,
    };
    let host = Arc::new(host::ArmadaTools::new(app.clone(), core, sink.clone()));
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

#[tauri::command]
pub fn va_set_muted(va: State<'_, VoiceAssistant>, muted: bool) {
    va.send(Control::Mute(muted));
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
