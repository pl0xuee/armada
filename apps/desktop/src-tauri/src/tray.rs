//! System tray: quick navigation, the "Needs you" count, quit.
//!
//! The count is pushed by the UI (`set_needs_you_count`), which is the single place that
//! decides which agents need the user. The rail badge, window title and this tray all show
//! that one number.

use std::sync::atomic::{AtomicUsize, Ordering};

use crate::AppHandle;
use kvistcode_core::NavigateTarget;
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

use crate::window;

const TRAY_ID: &str = "kvistcode-tray";

pub struct TrayState {
    tray: TrayIcon<crate::Rt>,
    needs: MenuItem<crate::Rt>,
}

/// The count last shown (`usize::MAX` before the first), so unchanged pushes do nothing.
static SHOWN: AtomicUsize = AtomicUsize::new(usize::MAX);

/// Whether the tray icon was created (some Linux desktops have no tray host or
/// lack the indicator library); without it, closing the window must quit.
pub static AVAILABLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn available() -> bool {
    AVAILABLE.load(std::sync::atomic::Ordering::Relaxed)
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Kvistcode", true, None::<&str>)?;
    let new_agent = MenuItem::with_id(app, "new_agent", "New Agent", true, None::<&str>)?;
    let needs = MenuItem::with_id(app, "needs_you", "Needs you", true, None::<&str>)?;
    let mission = MenuItem::with_id(
        app,
        "mission_control",
        "Mission Control",
        true,
        None::<&str>,
    )?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Kvistcode", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &new_agent, &needs, &mission, &sep, &quit])?;

    // macOS menu bar icons are template images (black + alpha, tinted by the OS);
    // elsewhere use the ice-blue mark, which reads on both light and dark panels.
    #[cfg(target_os = "macos")]
    let (icon, template) = (
        Image::from_bytes(include_bytes!("../icons/tray-template-64.png"))?,
        true,
    );
    #[cfg(not(target_os = "macos"))]
    let (icon, template) = (
        Image::from_bytes(include_bytes!("../icons/tray-64.png"))?,
        false,
    );

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(template)
        .tooltip("Kvistcode")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                window::toggle_main(tray.app_handle());
            }
        })
        .build(app)?;

    app.manage(TrayState { tray, needs });
    // A count pushed before the tray existed is shown now.
    SHOWN.store(usize::MAX, Ordering::Relaxed);
    Ok(())
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "show" => window::show_main(app),
        "new_agent" => window::navigate(app, NavigateTarget::NewAgent),
        // The wire name is still "inbox"; the UI opens Mission Control on its Needs you tab.
        "needs_you" => window::navigate(app, NavigateTarget::Inbox),
        "mission_control" => window::navigate(app, NavigateTarget::MissionControl),
        // Goes through RunEvent::ExitRequested, which shuts the core down first.
        "quit" => app.exit(0),
        _ => {}
    }
}

/// Shows how many agents need the user: tooltip, menu label and (macOS) the menu-bar count.
/// Does nothing when the count is unchanged or the tray doesn't exist.
pub fn set_needs_you(app: &AppHandle, count: usize) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    if SHOWN.swap(count, Ordering::Relaxed) == count {
        return;
    }
    let tooltip = if count == 0 {
        "Kvistcode".to_string()
    } else {
        format!(
            "Kvistcode — {count} need{} you",
            if count == 1 { "s" } else { "" }
        )
    };
    let _ = state.tray.set_tooltip(Some(&tooltip));
    let label = if count > 0 {
        format!("Needs you ({count})")
    } else {
        "Needs you".to_string()
    };
    let _ = state.needs.set_text(label);
    #[cfg(target_os = "macos")]
    {
        // Menu-bar count next to the icon.
        let title = (count > 0).then(|| count.to_string());
        let _ = state.tray.set_title(title.as_deref());
    }
}
