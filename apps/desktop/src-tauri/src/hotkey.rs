//! Global quick-launch hotkey (`settings.globalHotkey`).

use crate::AppHandle;
use armada_core::NavigateTarget;
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};
use tracing::{info, warn};

use crate::state::Shell;
use crate::window;

pub fn on_shortcut(app: &AppHandle, _shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state == ShortcutState::Pressed {
        window::navigate(app, NavigateTarget::NewAgent);
    }
}

pub const WAYLAND_MESSAGE: &str = "Global shortcuts aren't supported on Wayland. Bind `armada --new-agent` to a key in your compositor (e.g. Hyprland: bind = SUPER, A, exec, armada --new-agent).";

fn wayland_from(display: Option<&str>, session: Option<&str>) -> bool {
    display.is_some_and(|d| !d.is_empty())
        || session.is_some_and(|s| s.eq_ignore_ascii_case("wayland"))
}

/// X11 grabs "succeed" under Wayland but never fire.
fn is_wayland() -> bool {
    cfg!(target_os = "linux")
        && wayland_from(
            std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
            std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        )
}

/// (Re-)registers the hotkey if it changed; an empty hotkey disables it. Errors when
/// the combination is invalid or can't be grabbed (taken by another app, or a Wayland
/// compositor that doesn't allow global grabs); the old hotkey is released either way.
pub fn apply(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let hotkey = hotkey.trim();
    if !hotkey.is_empty() && is_wayland() {
        return Err(WAYLAND_MESSAGE.to_string());
    }
    let shell = app.state::<Shell>();
    let mut current = shell.hotkey.lock();
    if current.as_deref() == Some(hotkey) {
        return Ok(());
    }
    let gs = app.global_shortcut();
    if let Some(old) = current.take() {
        if let Err(e) = gs.unregister(old.as_str()) {
            warn!(hotkey = %old, "could not unregister global hotkey: {e}");
        }
    }
    if hotkey.is_empty() {
        return Ok(());
    }
    match gs.register(hotkey) {
        Ok(()) => {
            info!(%hotkey, "registered global hotkey");
            *current = Some(hotkey.to_string());
            Ok(())
        }
        Err(e) => {
            warn!(%hotkey, "could not register global hotkey: {e}");
            Err(e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_wayland() {
        assert!(wayland_from(Some("wayland-1"), None));
        assert!(wayland_from(None, Some("Wayland")));
        assert!(!wayland_from(None, Some("x11")));
        assert!(!wayland_from(Some(""), None));
    }
}
