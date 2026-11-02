//! Main-window helpers shared by the tray, notifications, hotkey and commands.

use crate::{AppHandle, Rt};
use kvistcode_core::{Core, KvistcodeEvent, NavigateTarget};
use tauri::{Manager, WindowEvent};
type WebviewWindow = tauri::WebviewWindow<Rt>;
type Window = tauri::Window<Rt>;

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
    let mut builder = tauri::WebviewWindowBuilder::from_config(app, &config)?
        // Login launches start in the tray; building hidden avoids a visible flash.
        .visible(!crate::autostart_launch())
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny);
    // The configured 1440x900 is more than a 1280x720 work area (a 1080p laptop at 150%
    // scaling): with no title bar, the window controls would sit past the screen edge.
    if let Some((w, h, min_w, min_h)) = work_area_logical(app).map(|(area_w, area_h)| {
        fit_to_work_area(
            (config.width, config.height),
            (
                config.min_width.unwrap_or(0.0),
                config.min_height.unwrap_or(0.0),
            ),
            (
                area_w,
                area_h - if config.decorations { TITLE_BAR } else { 0.0 },
            ),
        )
    }) {
        builder = builder.inner_size(w, h).min_inner_size(min_w, min_h);
    }
    builder.build()?;
    Ok(())
}

/// Room the OS title bar takes from the work area when the window has one (macOS).
const TITLE_BAR: f64 = 40.0;

/// The primary monitor's usable area (without taskbar/dock/menu bar) in logical pixels.
fn work_area_logical(app: &AppHandle) -> Option<(f64, f64)> {
    let monitor = app
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| app.available_monitors().ok()?.into_iter().next())?;
    let scale = monitor.scale_factor();
    let size = monitor.work_area().size;
    if !(scale.is_finite() && scale > 0.0) || size.width == 0 || size.height == 0 {
        return None;
    }
    Some((
        f64::from(size.width) / scale,
        f64::from(size.height) / scale,
    ))
}

/// `(width, height, min_width, min_height)` for a window that wants `want` (never below
/// `min`) on a work area of `area`: the size is cut down to the area, and so is the
/// minimum, which would otherwise keep the window from fitting.
fn fit_to_work_area(want: (f64, f64), min: (f64, f64), area: (f64, f64)) -> (f64, f64, f64, f64) {
    let min_w = min.0.min(area.0);
    let min_h = min.1.min(area.1);
    (
        want.0.min(area.0).max(min_w),
        want.1.min(area.1).max(min_h),
        min_w,
        min_h,
    )
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
        core.emit(KvistcodeEvent::Navigate { to });
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

#[cfg(test)]
mod tests {
    use super::fit_to_work_area;

    #[test]
    fn window_fits_the_work_area() {
        // Roomy screen: the configured size and minimum are kept.
        assert_eq!(
            fit_to_work_area((1440.0, 900.0), (1000.0, 640.0), (2560.0, 1400.0)),
            (1440.0, 900.0, 1000.0, 640.0)
        );
        // 1080p at 150% scaling (1280x680 usable): cut down, minimum still fits.
        assert_eq!(
            fit_to_work_area((1440.0, 900.0), (1000.0, 640.0), (1280.0, 680.0)),
            (1280.0, 680.0, 1000.0, 640.0)
        );
        // A screen smaller than the minimum: the minimum shrinks with it.
        assert_eq!(
            fit_to_work_area((1440.0, 900.0), (1000.0, 640.0), (800.0, 560.0)),
            (800.0, 560.0, 800.0, 560.0)
        );
    }
}
