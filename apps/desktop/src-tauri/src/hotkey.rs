//! Global quick-launch hotkey (`settings.globalHotkey`).

use armada_core::NavigateTarget;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};
use tracing::{info, warn};

use crate::state::Shell;
use crate::window;

pub fn on_shortcut(app: &AppHandle, _shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state == ShortcutState::Pressed {
        window::navigate(app, NavigateTarget::NewAgent);
    }
}

/// (Re-)registers the hotkey if it changed. Failure (e.g. Wayland compositors that
/// don't allow global grabs, or a combo taken by another app) is logged, not fatal.
pub fn apply(app: &AppHandle, hotkey: &str) {
    let hotkey = hotkey.trim();
    let shell = app.state::<Shell>();
    let mut current = shell.hotkey.lock();
    if current.as_deref() == Some(hotkey) {
        return;
    }
    let gs = app.global_shortcut();
    if let Some(old) = current.take() {
        if let Err(e) = gs.unregister(old.as_str()) {
            warn!(hotkey = %old, "could not unregister global hotkey: {e}");
        }
    }
    if hotkey.is_empty() {
        return;
    }
    match gs.register(hotkey) {
        Ok(()) => {
            info!(%hotkey, "registered global hotkey");
            *current = Some(hotkey.to_string());
        }
        Err(e) => warn!(%hotkey, "could not register global hotkey: {e}"),
    }
}
