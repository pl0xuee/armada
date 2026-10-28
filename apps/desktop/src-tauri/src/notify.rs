//! OS notifications via notify-rust. On Linux (freedesktop) permission requests
//! get Approve / Deny / Open actions; macOS and Windows get plain notifications.

use std::path::PathBuf;

use anyhow::Context;
use armada_core::{
    AttentionReason, Core, ItemBody, NavigateTarget, PermissionOption, PermissionOptionKind,
};
use tauri::{AppHandle, Manager};
use tracing::{info, warn};

use crate::window;

pub struct Toast {
    /// The agent the notification is about (enables the actions).
    pub agent_id: Option<String>,
    pub reason: Option<AttentionReason>,
    /// The permission request this notification is about; Approve/Deny answer only it.
    pub request_id: Option<String>,
    pub title: String,
    pub body: String,
}

/// Shows the notification on its own thread (showing + waiting for an action
/// blocks on D-Bus).
pub fn show(app: AppHandle, icon: Option<PathBuf>, toast: Toast) {
    let spawned = std::thread::Builder::new()
        .name("armada-notify".into())
        .spawn(move || show_blocking(app, icon, toast));
    if let Err(e) = spawned {
        warn!("could not spawn notification thread: {e}");
    }
}

/// The notification currently shown for each agent (Linux). Each agent gets at most
/// one notification on screen: a new alert replaces the previous one, using the id
/// the notification server returned for it.
#[cfg(all(unix, not(target_os = "macos")))]
#[derive(Default)]
struct Slot {
    /// Server-assigned id of the agent's latest notification.
    id: Option<u32>,
    /// Bumped for every notification shown for the agent; a waiter whose generation is
    /// no longer current belongs to a replaced notification and must not act.
    generation: u64,
}

#[cfg(all(unix, not(target_os = "macos")))]
fn slots() -> &'static parking_lot::Mutex<std::collections::HashMap<String, Slot>> {
    static SLOTS: std::sync::OnceLock<parking_lot::Mutex<std::collections::HashMap<String, Slot>>> =
        std::sync::OnceLock::new();
    SLOTS.get_or_init(Default::default)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn show_blocking(app: AppHandle, icon: Option<PathBuf>, toast: Toast) {
    use notify_rust::{Hint, Notification, Urgency};

    let mut n = Notification::new();
    n.appname("Armada")
        .summary(&toast.title)
        .body(&toast.body)
        .hint(Hint::Category("im.received".into()));
    if let Some(icon) = &icon {
        n.icon(&icon.to_string_lossy());
    }
    // Normal (not Critical) so the user's Do-Not-Disturb is respected.
    n.urgency(Urgency::Normal);

    // Only permission requests carry actions. Waiting for an action holds a thread and
    // a D-Bus connection until the notification is closed (which some servers only do
    // when the user clears their history), so plain done/error alerts don't wait.
    let actionable = match (&toast.agent_id, &toast.request_id) {
        (Some(_), Some(_)) => toast.reason == Some(AttentionReason::Permission),
        _ => false,
    };
    if actionable {
        n.action("approve", "Approve");
        n.action("deny", "Deny");
        // "default" = clicking the notification body on most daemons.
        n.action("default", "Open Armada");
        n.action("open", "Open");
    }

    let generation = toast.agent_id.as_ref().map(|agent_id| {
        let mut slots = slots().lock();
        let slot = slots.entry(agent_id.clone()).or_default();
        slot.generation += 1;
        if let Some(id) = slot.id {
            // Replaces the agent's previous notification if it's still shown; servers
            // hand out a fresh id when it's already gone.
            n.id(id);
        }
        slot.generation
    });

    let handle = match n.show() {
        Ok(h) => h,
        Err(e) => {
            warn!("could not show notification: {e}");
            return;
        }
    };
    let (Some(agent_id), Some(generation)) = (toast.agent_id, generation) else {
        return;
    };
    if let Some(slot) = slots().lock().get_mut(&agent_id) {
        if slot.generation == generation {
            slot.id = Some(handle.id());
        }
    }
    if !actionable {
        // Dropping the handle closes our D-Bus connection; the notification stays up.
        return;
    }
    let request_id = toast.request_id;
    handle.wait_for_action(|action| {
        let current = slots()
            .lock()
            .get(&agent_id)
            .is_some_and(|slot| slot.generation == generation);
        if !current {
            // A newer notification for this agent replaced this one (same server id),
            // and its own waiter handles the action.
            return;
        }
        match action {
            "approve" | "deny" => match &request_id {
                Some(req) => respond_in_background(
                    app.clone(),
                    agent_id.clone(),
                    req.clone(),
                    action == "approve",
                ),
                None => window::navigate(
                    &app,
                    NavigateTarget::Agent {
                        agent_id: agent_id.clone(),
                    },
                ),
            },
            "open" | "default" => window::navigate(
                &app,
                NavigateTarget::Agent {
                    agent_id: agent_id.clone(),
                },
            ),
            _ => {}
        }
    });
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
fn show_blocking(app: AppHandle, _icon: Option<PathBuf>, toast: Toast) {
    use notify_rust::Notification;

    let mut n = Notification::new();
    n.appname("Armada").summary(&toast.title).body(&toast.body);
    #[cfg(target_os = "windows")]
    if !cfg!(debug_assertions) {
        // Installed builds are registered under the bundle identifier (AUMID);
        // dev builds fall back to notify-rust's default (PowerShell) so toasts still show.
        n.app_id(&app.config().identifier);
    }
    let _ = &app;
    if let Err(e) = n.show() {
        warn!("could not show notification: {e}");
    }
}

#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
fn respond_in_background(app: AppHandle, agent_id: String, request_id: String, allow: bool) {
    tauri::async_runtime::spawn(async move {
        let core = app.state::<Core>().inner().clone();
        match respond_to(&core, &agent_id, &request_id, allow).await {
            Ok(option) => info!(%agent_id, %option, "permission answered from notification"),
            Err(e) => {
                warn!(%agent_id, "could not answer permission from notification: {e:#}");
                // Fall back to showing the request in the app.
                window::navigate(&app, NavigateTarget::Agent { agent_id });
            }
        }
    });
}

#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
/// Answers exactly the request the notification showed (never a newer one) with its
/// one-time option: "allow once" for Approve, "reject once" for Deny. A notification
/// button never grants or denies permanently; if the request has no one-time option the
/// caller opens the agent so the user can choose in the app.
pub async fn respond_to(
    core: &Core,
    agent_id: &str,
    request_id: &str,
    allow: bool,
) -> anyhow::Result<String> {
    let items = core.items(agent_id)?;
    let options = items
        .iter()
        .find_map(|item| match &item.body {
            ItemBody::Permission {
                request_id: r,
                options,
                resolution: None,
                ..
            } if r == request_id => Some(options.clone()),
            _ => None,
        })
        .context("that request was already answered")?;
    let option = one_time_option(&options, allow)
        .context("the request has no one-time option; choose in the app")?;
    core.respond_permission(agent_id, request_id, &option.id)
        .await?;
    Ok(option.id.clone())
}

#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
fn one_time_option(options: &[PermissionOption], allow: bool) -> Option<&PermissionOption> {
    let wanted = if allow {
        PermissionOptionKind::AllowOnce
    } else {
        PermissionOptionKind::RejectOnce
    };
    options.iter().find(|o| o.kind == wanted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opt(id: &str, kind: PermissionOptionKind) -> PermissionOption {
        PermissionOption {
            id: id.into(),
            name: id.into(),
            kind,
        }
    }

    #[test]
    fn notification_buttons_never_answer_permanently() {
        use PermissionOptionKind::*;
        let all = [
            opt("always", AllowAlways),
            opt("once", AllowOnce),
            opt("never", RejectAlways),
            opt("no", RejectOnce),
        ];
        assert_eq!(one_time_option(&all, true).unwrap().id, "once");
        assert_eq!(one_time_option(&all, false).unwrap().id, "no");

        // Only permanent choices: nothing is picked, the app opens instead.
        let permanent = [opt("always", AllowAlways), opt("never", RejectAlways)];
        assert!(one_time_option(&permanent, true).is_none());
        assert!(one_time_option(&permanent, false).is_none());
    }
}
