//! OS notifications. On Linux (freedesktop, over D-Bus) permission requests get
//! Approve / Deny / Open actions and other alerts open their agent when clicked;
//! macOS and Windows get plain notifications via notify-rust.

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

/// Shows the notification on its own short-lived thread (showing is a blocking
/// platform call).
pub fn show(app: AppHandle, icon: Option<PathBuf>, toast: Toast) {
    let spawned = std::thread::Builder::new()
        .name("armada-notify".into())
        .spawn(move || show_blocking(app, icon, toast));
    if let Err(e) = spawned {
        warn!("could not spawn notification thread: {e}");
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
use xdg::show_blocking;

/// Takes the notification for permission request `request_id` off the screen (it was
/// answered elsewhere, so its Approve/Deny buttons would do nothing). Returns at once;
/// a no-op where notifications have no buttons (macOS, Windows).
pub fn close_for_request(request_id: &str) {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let request_id = request_id.to_string();
        let spawned = std::thread::Builder::new()
            .name("armada-notify-close".into())
            .spawn(move || xdg::close_for_request(&request_id));
        if let Err(e) = spawned {
            warn!("could not spawn notification thread: {e}");
        }
    }
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    let _ = request_id;
}

/// Most characters of a permission request's command shown in its notification.
/// Servers wrap long bodies (some cut them); this keeps a whole command readable
/// before Approve, without sending megabytes over D-Bus.
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
const MAX_COMMAND_CHARS: usize = 1500;

/// The notification body for a permission request: the request's title plus the
/// full command it would run, so Approve is never pressed on a truncated command.
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
fn request_body(title: &str, command: Option<&str>) -> String {
    let Some(command) = command.map(str::trim).filter(|c| !c.is_empty()) else {
        return title.to_string();
    };
    let shown: String = if command.chars().count() > MAX_COMMAND_CHARS {
        let mut cut: String = command.chars().take(MAX_COMMAND_CHARS - 1).collect();
        cut.push('…');
        cut
    } else {
        command.to_string()
    };
    if title.contains(command) {
        title.to_string()
    } else {
        format!("{title}\n$ {shown}")
    }
}

/// The command of pending permission request `request_id`, from the transcript.
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
fn request_command(app: &AppHandle, agent_id: &str, request_id: &str) -> Option<String> {
    let core = app.try_state::<Core>()?;
    core.items(agent_id)
        .ok()?
        .iter()
        .rev()
        .find_map(|item| match &item.body {
            ItemBody::Permission {
                request_id: r,
                command,
                ..
            } if r == request_id => command.clone(),
            _ => None,
        })
}

/// Linux (freedesktop notifications over D-Bus, without notify-rust).
///
/// One session-bus connection both shows every notification and receives the
/// action/closed signals, on one listener thread: some servers (GNOME) only send a
/// notification's signals to the connection that created it, and a thread per
/// notification waiting for its action piles up threads and connections. Actions are
/// routed by the id the server assigned. Each agent has at most one notification on
/// screen: a new alert replaces the previous one.
///
/// The connection is re-established (at most every [`RETRY_EVERY`]) if the bus
/// wasn't there at first or went away (notification daemon or session bus restarted).
#[cfg(all(unix, not(target_os = "macos")))]
mod xdg {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, OnceLock};
    use std::time::{Duration, Instant};

    use armada_core::{AttentionReason, NavigateTarget};
    use parking_lot::Mutex;
    use tauri::AppHandle;
    use tracing::{debug, warn};
    use zbus::zvariant::Value;

    use super::{request_body, request_command, respond_in_background, Toast};
    use crate::window;

    const DEST: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";
    /// Least time between two connection attempts.
    const RETRY_EVERY: Duration = Duration::from_secs(30);
    /// A click that arrives before its notification's buttons are registered (the
    /// `Notify` reply and the click race) is kept this long.
    const EARLY_ACTION_TTL: Duration = Duration::from_secs(10);

    /// What a notification's buttons act on.
    #[derive(Clone)]
    struct Target {
        app: AppHandle,
        agent_id: String,
        /// Set for permission requests: Approve/Deny answer exactly this request.
        request_id: Option<String>,
    }

    #[derive(Default)]
    struct State {
        /// Notifications on screen that have actions, by server-assigned id.
        targets: HashMap<u32, Target>,
        /// Each agent's latest notification id (to replace it).
        by_agent: HashMap<String, u32>,
        /// Actions for ids not registered yet (see [`EARLY_ACTION_TTL`]).
        early: Vec<(u32, String, Instant)>,
    }

    /// Only ever locked briefly, never across a D-Bus call: the signal listener needs it
    /// for every click, and a blocked listener can stall the connection.
    fn state() -> &'static Mutex<State> {
        static STATE: OnceLock<Mutex<State>> = OnceLock::new();
        STATE.get_or_init(Default::default)
    }

    /// Serializes `Notify` calls so alerts for the same agent replace each other in
    /// order. The signal listener never takes it.
    fn show_order() -> &'static Mutex<()> {
        static ORDER: OnceLock<Mutex<()>> = OnceLock::new();
        ORDER.get_or_init(Default::default)
    }

    struct Bus {
        conn: zbus::blocking::Connection,
        /// The server renders body markup, so agent text must be escaped.
        markup: bool,
        /// Cleared when the listener stops (connection gone): reconnect next time.
        alive: Arc<AtomicBool>,
    }

    #[derive(Default)]
    struct Slot {
        bus: Option<Arc<Bus>>,
        last_attempt: Option<Instant>,
    }

    fn slot() -> &'static Mutex<Slot> {
        static SLOT: OnceLock<Mutex<Slot>> = OnceLock::new();
        SLOT.get_or_init(Default::default)
    }

    /// The live connection, connecting if there's none and the last attempt was more
    /// than [`RETRY_EVERY`] ago. `None` without a session bus (headless, sandbox):
    /// notifications are skipped.
    fn bus() -> Option<Arc<Bus>> {
        let mut slot = slot().lock();
        if let Some(bus) = &slot.bus {
            if bus.alive.load(Ordering::SeqCst) {
                return Some(bus.clone());
            }
            slot.bus = None;
        }
        if slot.last_attempt.is_some_and(|t| t.elapsed() < RETRY_EVERY) {
            return None;
        }
        slot.last_attempt = Some(Instant::now());
        match connect() {
            Ok(bus) => {
                let bus = Arc::new(bus);
                slot.bus = Some(bus.clone());
                Some(bus)
            }
            Err(e) => {
                warn!("desktop notifications unavailable: {e}");
                None
            }
        }
    }

    /// Forgets `bus` after a failed call, so the next notification reconnects.
    fn drop_bus(bus: &Arc<Bus>) {
        let mut slot = slot().lock();
        if slot.bus.as_ref().is_some_and(|b| Arc::ptr_eq(b, bus)) {
            slot.bus = None;
        }
    }

    fn connect() -> anyhow::Result<Bus> {
        let conn = zbus::blocking::Connection::session()?;
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface(DEST)?
            .path(PATH)?
            .build();
        // Subscribed before any notification is shown, so no click is missed.
        let signals = zbus::blocking::MessageIterator::for_match_rule(rule, &conn, Some(256))?;
        let alive = Arc::new(AtomicBool::new(true));
        let listener_alive = alive.clone();
        std::thread::Builder::new()
            .name("armada-notify-actions".into())
            .spawn(move || {
                for msg in signals {
                    match msg {
                        Ok(msg) => on_signal(&msg),
                        Err(e) => debug!("notification signal: {e}"),
                    }
                }
                listener_alive.store(false, Ordering::SeqCst);
                warn!("stopped listening for notification actions; will reconnect");
            })?;
        let markup = conn
            .call_method(Some(DEST), PATH, Some(DEST), "GetCapabilities", &())
            .and_then(|reply| reply.body().deserialize::<Vec<String>>())
            .map(|caps| caps.iter().any(|c| c == "body-markup"))
            .unwrap_or(true);
        Ok(Bus {
            conn,
            markup,
            alive,
        })
    }

    fn on_signal(msg: &zbus::Message) {
        let header = msg.header();
        let Some(member) = header.member() else {
            return;
        };
        match member.as_str() {
            "ActionInvoked" => {
                let Ok((id, action)) = msg.body().deserialize::<(u32, String)>() else {
                    return;
                };
                let target = {
                    let mut state = state().lock();
                    if !state.targets.contains_key(&id) {
                        // Possibly ours, its registration still in flight.
                        state
                            .early
                            .retain(|(_, _, at)| at.elapsed() < EARLY_ACTION_TTL);
                        state.early.push((id, action, Instant::now()));
                        return;
                    }
                    take_target(&mut state, id, &action)
                };
                if let Some(target) = target {
                    act(target, &action);
                }
            }
            "NotificationClosed" => {
                let Ok((id, _reason)) = msg.body().deserialize::<(u32, u32)>() else {
                    return;
                };
                let mut state = state().lock();
                state.targets.remove(&id);
                state.by_agent.retain(|_, shown| *shown != id);
            }
            _ => {}
        }
    }

    /// The target `action` on notification `id` acts on.
    fn take_target(state: &mut State, id: u32, action: &str) -> Option<Target> {
        if matches!(action, "approve" | "deny") {
            // Answer at most once, even if the server keeps it on screen.
            state.targets.remove(&id)
        } else {
            state.targets.get(&id).cloned()
        }
    }

    fn act(target: Target, action: &str) {
        let Target {
            app,
            agent_id,
            request_id,
        } = target;
        match (action, request_id) {
            ("approve" | "deny", Some(request_id)) => {
                respond_in_background(app, agent_id, request_id, action == "approve")
            }
            ("approve" | "deny" | "open" | "default", _) => {
                window::navigate(&app, NavigateTarget::Agent { agent_id })
            }
            _ => {}
        }
    }

    #[cfg(test)]
    pub(super) fn notify_for_test(title: &str, body: &str) -> anyhow::Result<u32> {
        let bus = bus().ok_or_else(|| anyhow::anyhow!("no session bus"))?;
        let id = notify(&bus, 0, "", title, body, &["default", "Open"])?;
        bus.conn
            .call_method(Some(DEST), PATH, Some(DEST), "CloseNotification", &(id,))?;
        Ok(id)
    }

    /// Minimal escaping for servers that render the body as markup.
    pub(super) fn escape_markup(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    /// `org.freedesktop.Notifications.Notify`; returns the server-assigned id.
    fn notify(
        bus: &Bus,
        replaces: u32,
        icon: &str,
        title: &str,
        body: &str,
        actions: &[&str],
    ) -> zbus::Result<u32> {
        let mut hints: HashMap<&str, Value> = HashMap::new();
        // Normal (not critical) so the user's Do-Not-Disturb is respected.
        hints.insert("urgency", Value::U8(1));
        hints.insert("category", Value::from("im.received"));
        let body = if bus.markup {
            escape_markup(body)
        } else {
            body.to_string()
        };
        bus.conn
            .call_method(
                Some(DEST),
                PATH,
                Some(DEST),
                "Notify",
                &(
                    "Armada",
                    replaces,
                    icon,
                    title,
                    body.as_str(),
                    actions,
                    hints,
                    -1i32,
                ),
            )?
            .body()
            .deserialize::<u32>()
    }

    pub(super) fn close_for_request(request_id: &str) {
        let ids: Vec<u32> = {
            let mut state = state().lock();
            let ids: Vec<u32> = state
                .targets
                .iter()
                .filter(|(_, t)| t.request_id.as_deref() == Some(request_id))
                .map(|(id, _)| *id)
                .collect();
            for id in &ids {
                state.targets.remove(id);
            }
            state.by_agent.retain(|_, shown| !ids.contains(shown));
            ids
        };
        if ids.is_empty() {
            return;
        }
        // Never reconnects just to close something (a new connection didn't show it).
        let Some(bus) = slot().lock().bus.clone() else {
            return;
        };
        for id in ids {
            if let Err(e) =
                bus.conn
                    .call_method(Some(DEST), PATH, Some(DEST), "CloseNotification", &(id,))
            {
                debug!("could not close notification {id}: {e}");
            }
        }
    }

    pub(super) fn show_blocking(app: AppHandle, icon: Option<PathBuf>, toast: Toast) {
        let Some(bus) = bus() else {
            return;
        };
        let is_request =
            toast.reason == Some(AttentionReason::Permission) && toast.request_id.is_some();
        let mut actions: Vec<&str> = Vec::new();
        if toast.agent_id.is_some() {
            if is_request {
                actions.extend(["approve", "Approve", "deny", "Deny"]);
            }
            // "default" = clicking the notification body on most servers.
            actions.extend(["default", "Open Armada", "open", "Open"]);
        }
        // Approve must never be pressed on a cut-off command: show all of it.
        let body = match (&toast.agent_id, &toast.request_id) {
            (Some(agent_id), Some(request_id)) if is_request => request_body(
                &toast.body,
                request_command(&app, agent_id, request_id).as_deref(),
            ),
            _ => toast.body.clone(),
        };
        let icon = icon
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();

        // Alerts for the same agent replace each other in order; the state lock itself
        // is only held for the lookups, never across the D-Bus call.
        let _order = show_order().lock();
        let replaces = toast
            .agent_id
            .as_ref()
            .and_then(|agent| state().lock().by_agent.get(agent).copied())
            .unwrap_or(0);
        let id = match notify(&bus, replaces, &icon, &toast.title, &body, &actions) {
            Ok(id) => id,
            Err(e) => {
                warn!("could not show notification: {e}");
                // Possibly a dead connection: reconnect on the next one.
                drop_bus(&bus);
                return;
            }
        };
        let Some(agent_id) = toast.agent_id else {
            return;
        };
        let early: Vec<(String, Option<Target>)> = {
            let mut state = state().lock();
            state.by_agent.insert(agent_id.clone(), id);
            // Replaces whatever the previous notification with this id would do.
            state.targets.insert(
                id,
                Target {
                    app,
                    agent_id,
                    request_id: toast.request_id.filter(|_| is_request),
                },
            );
            // Clicks that beat the registration.
            let mut clicked = Vec::new();
            state.early.retain(|(early_id, action, at)| {
                if *early_id == id && at.elapsed() < EARLY_ACTION_TTL {
                    clicked.push(action.clone());
                    false
                } else {
                    at.elapsed() < EARLY_ACTION_TTL
                }
            });
            clicked
                .into_iter()
                .map(|action| {
                    let target = take_target(&mut state, id, &action);
                    (action, target)
                })
                .collect()
        };
        for (action, target) in early {
            if let Some(target) = target {
                act(target, &action);
            }
        }
    }
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

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn markup_is_escaped() {
        assert_eq!(
            xdg::escape_markup("<a href=\"x\">a & b</a>"),
            "&lt;a href=\"x\"&gt;a &amp; b&lt;/a&gt;"
        );
    }

    /// Shows (and immediately closes) a real notification: `cargo test -- --ignored`
    /// on a desktop session.
    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    #[ignore = "needs a desktop session"]
    fn notify_call_round_trip() {
        let id = xdg::notify_for_test("Armada test", "Notification check").unwrap();
        assert!(id > 0);
    }

    #[test]
    fn request_notifications_show_the_whole_command() {
        let cmd = "rm -rf ./build && git push --force origin main";
        assert_eq!(
            request_body("Run rm -rf ./build && git pu…", Some(cmd)),
            format!("Run rm -rf ./build && git pu…\n$ {cmd}")
        );
        // Already fully in the title: not repeated.
        assert_eq!(
            request_body(&format!("Run `{cmd}`"), Some(cmd)),
            format!("Run `{cmd}`")
        );
        assert_eq!(request_body("Edit a.txt", None), "Edit a.txt");
        assert_eq!(request_body("Edit a.txt", Some("  ")), "Edit a.txt");
        let huge = "x".repeat(MAX_COMMAND_CHARS * 2);
        let body = request_body("Run", Some(&huge));
        assert_eq!(body.chars().count(), "Run\n$ ".len() + MAX_COMMAND_CHARS);
        assert!(body.ends_with('…'));
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
