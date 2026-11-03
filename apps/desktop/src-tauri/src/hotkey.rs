//! Global hotkeys: quick-launch (`settings.globalHotkey`) and the voice assistant's
//! start/stop (`settings.voiceAssistant.hotkey`).

use std::str::FromStr;

use crate::AppHandle;
use kvistcode_core::{Core, NavigateTarget};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcut, Shortcut, ShortcutEvent, ShortcutState};
use tracing::{info, warn};

use crate::state::Shell;
use crate::window;

/// Tells the webview to run `toggleVoiceAssistant()`.
pub const VA_HOTKEY_EVENT: &str = "va-hotkey";

pub fn on_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state != ShortcutState::Pressed {
        return;
    }
    match is_voice_assistant_key(app, shortcut) {
        Some(true) => toggle_voice_assistant(app),
        Some(false) => window::navigate(app, NavigateTarget::NewAgent),
        // A hotkey is being (re)registered right now; ignore the press rather than wait
        // here, since registering waits for this thread.
        None => {}
    }
}

fn is_voice_assistant_key(app: &AppHandle, shortcut: &Shortcut) -> Option<bool> {
    let shell = app.state::<Shell>();
    let current = shell.va_hotkey.try_lock()?;
    Some(
        current
            .as_deref()
            .and_then(|h| Shortcut::from_str(h).ok())
            .is_some_and(|s| s == *shortcut),
    )
}

/// Start the assistant, or stop it if it is running. The webview does the work (so the
/// panel and the in-app shortcut behave the same); the window is only brought up when
/// there is something to see, and then without taking focus from the app in front.
pub fn toggle_voice_assistant(app: &AppHandle) {
    let enabled = app
        .try_state::<Core>()
        .and_then(|core| core.settings().ok())
        .is_some_and(|s| s.voice_assistant.enabled);
    if !enabled {
        // The UI opens Settings -> Voice assistant; that needs the window in front.
        window::show_main(app);
    } else if !crate::voice_assistant::va_active(app.state()) {
        window::reveal_main(app);
    }
    if let Err(e) = app.emit(VA_HOTKEY_EVENT, ()) {
        warn!("could not send the voice assistant hotkey to the window: {e}");
    }
}

pub const WAYLAND_MESSAGE: &str = "Global shortcuts aren't supported on Wayland. Bind `kvistcode --new-agent` to a key in your compositor (e.g. Hyprland: bind = SUPER, A, exec, kvistcode --new-agent).";

pub const VA_WAYLAND_MESSAGE: &str = "Global shortcuts aren't supported on Wayland. Bind `kvistcode --voice-assistant` to a key in your compositor (e.g. Hyprland: bind = SUPER, V, exec, kvistcode --voice-assistant).";

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

#[derive(Clone, Copy, PartialEq)]
enum Slot {
    QuickLaunch,
    VoiceAssistant,
}

/// (Re-)registers the quick-launch hotkey if it changed; an empty hotkey disables it.
/// Errors when the combination is invalid or can't be grabbed (taken by another app, or
/// a Wayland compositor that doesn't allow global grabs); the old hotkey is released
/// either way.
pub fn apply(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    apply_slot(app, Slot::QuickLaunch, hotkey)
}

/// The same for the voice assistant's hotkey.
pub fn apply_voice_assistant(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    apply_slot(app, Slot::VoiceAssistant, hotkey)
}

/// Checked before settings are saved: the voice assistant hotkey must be a real
/// shortcut and not the same keys as the quick-launch one (`Ctrl` and `CmdOrCtrl` count
/// as the same on Linux and Windows). Empty means off.
pub fn validate_voice_assistant_hotkey(global: &str, voice_assistant: &str) -> Result<(), String> {
    let voice_assistant = voice_assistant.trim();
    if voice_assistant.is_empty() {
        return Ok(());
    }
    let parsed = Shortcut::from_str(voice_assistant).map_err(|_| {
        format!("\u{201c}{voice_assistant}\u{201d} isn't a shortcut Kvistcode can use. Record one instead.")
    })?;
    if Shortcut::from_str(global.trim()).is_ok_and(|g| g == parsed) {
        return Err(
            "The voice assistant hotkey must differ from the global hotkey (which brings Kvistcode forward)"
                .into(),
        );
    }
    Ok(())
}

fn apply_slot(app: &AppHandle, slot: Slot, hotkey: &str) -> Result<(), String> {
    let hotkey = hotkey.trim();
    if !hotkey.is_empty() && is_wayland() {
        return Err(match slot {
            Slot::QuickLaunch => WAYLAND_MESSAGE,
            Slot::VoiceAssistant => VA_WAYLAND_MESSAGE,
        }
        .to_string());
    }
    let shell = app.state::<Shell>();
    let mut current = match slot {
        Slot::QuickLaunch => shell.hotkey.lock(),
        Slot::VoiceAssistant => shell.va_hotkey.lock(),
    };
    if current.as_deref() == Some(hotkey) {
        return Ok(());
    }
    // Not `global_shortcut()`: that panics if the plugin isn't registered (tests do not).
    let Some(gs) = app.try_state::<GlobalShortcut<crate::Rt>>() else {
        return Err("global shortcuts are unavailable".to_string());
    };
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
    fn voice_assistant_hotkey_is_checked_against_the_global_one() {
        let global = "CmdOrCtrl+Shift+Space";
        assert!(validate_voice_assistant_hotkey(global, "").is_ok());
        assert!(validate_voice_assistant_hotkey(global, "  ").is_ok());
        assert!(validate_voice_assistant_hotkey(global, "CmdOrCtrl+Shift+V").is_ok());
        assert!(validate_voice_assistant_hotkey("", "CmdOrCtrl+Shift+Space").is_ok());
        let clash = validate_voice_assistant_hotkey(global, "cmdorctrl+shift+space").unwrap_err();
        assert!(clash.contains("must differ"), "{clash}");
        // Written another way, still the same keys.
        assert!(validate_voice_assistant_hotkey("Shift+Alt+F9", "ALT+Shift+F9").is_err());
    }

    #[test]
    fn rejects_voice_assistant_hotkeys_that_are_not_shortcuts() {
        for bad in ["Banana", "Shift+", "Ctrl+Shift+NotAKey", "+", "Ctrl+A+B"] {
            let e = validate_voice_assistant_hotkey("", bad).unwrap_err();
            assert!(e.contains("isn't a shortcut"), "{bad}: {e}");
        }
    }

    #[test]
    fn detects_wayland() {
        assert!(wayland_from(Some("wayland-1"), None));
        assert!(wayland_from(None, Some("Wayland")));
        assert!(!wayland_from(None, Some("x11")));
        assert!(!wayland_from(Some(""), None));
    }
}
