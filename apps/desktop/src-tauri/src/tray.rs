//! System tray: quick navigation, waiting counts, quit.

use std::sync::Arc;
use std::time::Duration;

use armada_core::{AgentStatus, Core, NavigateTarget};
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;
use tracing::warn;

use crate::window;

const TRAY_ID: &str = "armada-tray";

pub struct TrayState {
    tray: TrayIcon,
    inbox: MenuItem<tauri::Wry>,
    dirty: Arc<Notify>,
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Armada", true, None::<&str>)?;
    let new_agent = MenuItem::with_id(app, "new_agent", "New Agent", true, None::<&str>)?;
    let inbox = MenuItem::with_id(app, "inbox", "Inbox", true, None::<&str>)?;
    let mission = MenuItem::with_id(
        app,
        "mission_control",
        "Mission Control",
        true,
        None::<&str>,
    )?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Armada", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &new_agent, &inbox, &mission, &sep, &quit])?;

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
        .tooltip("Armada")
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

    let dirty = Arc::new(Notify::new());
    app.manage(TrayState {
        tray,
        inbox,
        dirty: dirty.clone(),
    });
    spawn_updater(app.clone(), dirty);
    mark_dirty(app);
    Ok(())
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "show" => window::show_main(app),
        "new_agent" => window::navigate(app, NavigateTarget::NewAgent),
        "inbox" => window::navigate(app, NavigateTarget::Inbox),
        "mission_control" => window::navigate(app, NavigateTarget::MissionControl),
        // Goes through RunEvent::ExitRequested, which shuts the core down first.
        "quit" => app.exit(0),
        _ => {}
    }
}

/// Schedules a (debounced) refresh of the tooltip and menu counts.
pub fn mark_dirty(app: &AppHandle) {
    if let Some(state) = app.try_state::<TrayState>() {
        state.dirty.notify_one();
    }
}

fn spawn_updater(app: AppHandle, dirty: Arc<Notify>) {
    tauri::async_runtime::spawn(async move {
        loop {
            dirty.notified().await;
            // Coalesce bursts of agent updates (streaming turns update often).
            tokio::time::sleep(Duration::from_millis(400)).await;
            let app2 = app.clone();
            let counts = tauri::async_runtime::spawn_blocking(move || counts(&app2)).await;
            if let Ok(Some((waiting, inbox))) = counts {
                refresh(&app, waiting, inbox);
            }
        }
    });
}

/// (agents waiting on the user, pending approvals in the inbox)
fn counts(app: &AppHandle) -> Option<(usize, i64)> {
    let agents = match app.state::<Core>().agents() {
        Ok(a) => a,
        Err(e) => {
            warn!("tray: could not list agents: {e:#}");
            return None;
        }
    };
    let live = agents.iter().filter(|a| !a.archived);
    let waiting = live
        .clone()
        .filter(|a| a.status == AgentStatus::NeedsPermission)
        .count();
    let inbox = live
        .map(|a| {
            if a.status == AgentStatus::NeedsPermission {
                a.pending_permissions.max(1)
            } else {
                a.pending_permissions
            }
        })
        .sum();
    Some((waiting, inbox))
}

fn refresh(app: &AppHandle, waiting: usize, inbox: i64) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    let tooltip = if waiting == 0 {
        "Armada".to_string()
    } else {
        format!("Armada — {waiting} waiting")
    };
    let _ = state.tray.set_tooltip(Some(&tooltip));
    let label = if inbox > 0 {
        format!("Inbox ({inbox})")
    } else {
        "Inbox".to_string()
    };
    let _ = state.inbox.set_text(label);
    #[cfg(target_os = "macos")]
    {
        // Menu-bar count next to the icon.
        let title = (waiting > 0).then(|| waiting.to_string());
        let _ = state.tray.set_title(title.as_deref());
    }
}
