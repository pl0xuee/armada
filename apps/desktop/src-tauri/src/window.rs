//! Main-window helpers shared by the tray, notifications, hotkey and commands.

use armada_core::{ArmadaEvent, Core, NavigateTarget};
use tauri::{AppHandle, Manager, WebviewWindow, Window, WindowEvent};

use crate::attention::Attention;

pub const MAIN: &str = "main";

/// Creates the main window from its config entry (`create: false`), so it can refuse
/// `window.open` / `target=_blank` popups: links go to the OS browser via open_path instead.
pub fn create_main(app: &AppHandle) -> tauri::Result<()> {
    // A platform config without `create: false` (platform files replace the whole
    // `windows` list) would have created it already; never fail startup over that.
    if main_window(app).is_some() {
        tracing::warn!("main window was created from config; popup blocking is off");
        return Ok(());
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN)
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    tauri::WebviewWindowBuilder::from_config(app, &config)?
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny)
        .build()?;
    Ok(())
}

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn hide_main(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.hide();
    }
    if let Some(att) = app.try_state::<std::sync::Arc<Attention>>() {
        att.set_window_focused(false);
    }
}

/// Tray left-click: hide when the window is in front, otherwise bring it up.
pub fn toggle_main(app: &AppHandle) {
    let Some(w) = main_window(app) else { return };
    let visible = w.is_visible().unwrap_or(false);
    let minimized = w.is_minimized().unwrap_or(false);
    let focused = w.is_focused().unwrap_or(false);
    if visible && !minimized && focused {
        hide_main(app);
    } else {
        show_main(app);
    }
}

/// Brings the window up and asks the UI to switch views.
pub fn navigate(app: &AppHandle, to: NavigateTarget) {
    show_main(app);
    if let Some(core) = app.try_state::<Core>() {
        core.emit(ArmadaEvent::Navigate { to });
    }
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != MAIN {
        return;
    }
    let app = window.app_handle();
    match event {
        WindowEvent::Focused(focused) => {
            if let Some(att) = app.try_state::<std::sync::Arc<Attention>>() {
                att.set_window_focused(*focused);
            }
        }
        WindowEvent::CloseRequested { api, .. } => {
            let close_to_tray = app
                .try_state::<Core>()
                .and_then(|core| core.settings().ok())
                .map(|s| s.close_to_tray)
                .unwrap_or(true)
                && crate::tray::available();
            if close_to_tray {
                api.prevent_close();
                hide_main(app);
            }
            // Otherwise the window closes and RunEvent::ExitRequested shuts the core down.
        }
        _ => {}
    }
}
