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

use armada_core::{accounts, AuthKind, Core, Provider};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tracing::warn;

use crate::commands::CmdResult;
use session::{ApiKey, Control, EndReason, SessionConfig, VaEvent, VaSink, VaState};

pub const EVENT: &str = "va-event";

#[derive(Default)]
pub struct VoiceAssistant {
    control: Mutex<Option<UnboundedSender<Control>>>,
}

struct TauriSink(AppHandle);

impl VaSink for TauriSink {
    fn emit(&self, event: VaEvent) {
        let _ = self.0.emit(EVENT, event);
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
    })
}

#[tauri::command]
pub async fn va_start(
    app: AppHandle,
    core: State<'_, Core>,
    va: State<'_, VoiceAssistant>,
) -> CmdResult<()> {
    if va.control.lock().is_some() {
        return Err("The voice assistant is already running.".into());
    }
    let cfg = build_config(&core)?;
    let input_device = core.settings().ok().and_then(|s| s.voice.input_device);
    let (ctl_tx, ctl_rx) = unbounded_channel();
    *va.control.lock() = Some(ctl_tx);

    let core = (*core).clone();
    let data_dir = core.data_dir().to_path_buf();
    let sink: Arc<dyn VaSink> = Arc::new(TauriSink(app.clone()));
    let host = Arc::new(host::ArmadaTools {
        app: app.clone(),
        core,
        sink: sink.clone(),
    });
    tauri::async_runtime::spawn(async move {
        let mut devices = audio::SystemAudio { input_device };
        let end = session::run(cfg, sink.clone(), host, &mut devices, ctl_rx).await;
        let cost = end.usage.cost_usd();
        if end.elapsed_secs > 0 {
            if let Err(e) =
                cost::record_session(&data_dir, &cost::current_month(), end.elapsed_secs, cost)
            {
                warn!("could not record voice assistant usage: {e}");
            }
        }
        let error = matches!(end.reason, EndReason::Error(_));
        if error {
            sink.emit(VaEvent::State {
                state: VaState::Error,
                message: Some(end.reason.label()),
            });
        }
        sink.emit(VaEvent::Ended {
            reason: end.reason.label(),
            error,
        });
        if let Some(va) = tauri::Manager::try_state::<VoiceAssistant>(&app) {
            *va.control.lock() = None;
        }
    });
    Ok(())
}

#[tauri::command]
pub fn va_stop(va: State<'_, VoiceAssistant>) {
    if let Some(tx) = va.control.lock().as_ref() {
        let _ = tx.send(Control::Stop);
    }
}

#[tauri::command]
pub fn va_set_muted(va: State<'_, VoiceAssistant>, muted: bool) {
    if let Some(tx) = va.control.lock().as_ref() {
        let _ = tx.send(Control::Mute(muted));
    }
}

#[tauri::command]
pub fn va_active(va: State<'_, VoiceAssistant>) -> bool {
    va.control.lock().is_some()
}

#[tauri::command]
pub fn va_usage(core: State<'_, Core>) -> cost::MonthUsage {
    cost::read_month(core.data_dir(), &cost::current_month())
}

#[tauri::command]
pub fn va_voices() -> Vec<&'static str> {
    protocol::VOICES.to_vec()
}
