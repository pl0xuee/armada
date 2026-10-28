//! The attention engine: turns `ArmadaEvent::Attention` into sounds, OS
//! notifications, taskbar flashing and phone pushes, according to settings.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use armada_core::{AgentStatus, AttentionReason, Core, ItemBody, QuietHours, Settings};
use chrono::{NaiveTime, Timelike};
use parking_lot::Mutex;
use tauri::{AppHandle, Manager, UserAttentionType};
use tracing::{debug, info, warn};

use crate::notify::{self, Toast};
use crate::sound::AudioPlayer;
use crate::window;

const ESCALATION_TICK: Duration = Duration::from_secs(30);

pub struct Attention {
    app: AppHandle,
    audio: AudioPlayer,
    icon: Option<PathBuf>,
    /// Agent the UI is showing (from `set_focus`).
    focused_agent: Mutex<Option<String>>,
    /// Whether the main window has OS focus (tracked from window events).
    window_focused: AtomicBool,
    /// needs_permission bookkeeping for escalation, keyed by agent id.
    pending: Mutex<HashMap<String, PendingApproval>>,
}

struct PendingApproval {
    request_id: Option<String>,
    first_seen: Instant,
    escalated: bool,
}

impl Attention {
    pub fn new(app: AppHandle, icon: Option<PathBuf>) -> Self {
        Attention {
            app,
            audio: AudioPlayer::new(),
            icon,
            focused_agent: Mutex::new(None),
            window_focused: AtomicBool::new(true),
            pending: Mutex::new(HashMap::new()),
        }
    }

    fn core(&self) -> Core {
        self.app.state::<Core>().inner().clone()
    }

    fn settings(&self) -> Settings {
        self.core().settings().unwrap_or_else(|e| {
            warn!("could not read settings: {e:#}");
            Settings::default()
        })
    }

    pub fn set_focus(&self, agent_id: Option<String>) {
        *self.focused_agent.lock() = agent_id;
    }

    pub fn set_window_focused(&self, focused: bool) {
        self.window_focused.store(focused, Ordering::Relaxed);
        if focused {
            // The user is back: drop the taskbar flash / urgency hint.
            if let Some(w) = window::main_window(&self.app) {
                let _ = w.request_user_attention(None);
            }
        }
    }

    /// A soft chime for a long task that finished in front of the user (the UI decides
    /// that and calls this). Honors the sound master switch, the setting and quiet hours.
    pub fn chime_watched(&self) {
        let settings = self.settings();
        if !settings.sounds.enabled
            || !settings.sounds.chime_when_watching
            || quiet_hours_active(&settings.quiet_hours, local_now())
            || !self.window_focused.load(Ordering::Relaxed)
        {
            return;
        }
        self.audio
            .play_scaled(AttentionReason::Done, &settings.sounds, 0.45);
    }

    /// Called (on a blocking thread) for every `ArmadaEvent::Attention`.
    pub fn on_attention(
        &self,
        agent_id: &str,
        reason: AttentionReason,
        title: &str,
        body: &str,
        request_id: Option<&str>,
    ) {
        if reason == AttentionReason::Permission {
            // Start the escalation clock now rather than at the next poll; a new
            // request for the same agent restarts it.
            let mut pending = self.pending.lock();
            let entry = pending.entry(agent_id.to_string());
            let fresh = PendingApproval {
                request_id: request_id.map(str::to_string),
                first_seen: Instant::now(),
                escalated: false,
            };
            match entry {
                std::collections::hash_map::Entry::Vacant(v) => {
                    v.insert(fresh);
                }
                std::collections::hash_map::Entry::Occupied(mut o) => {
                    if request_id.is_some() && o.get().request_id.as_deref() != request_id {
                        o.insert(fresh);
                    }
                }
            }
        }
        self.alert(agent_id, reason, title, body, request_id);
    }

    /// A permission request was answered (in the app, from the phone, from a
    /// notification, or by the agent giving up): stops its escalation and takes its
    /// notification (with now-pointless Approve/Deny buttons) off the screen.
    ///
    /// Called by events.rs for every `ItemUpserted` whose body is
    /// `ItemBody::Permission { resolution: Some(_), .. }`. As a fallback, the
    /// escalation tick also closes notifications of approvals no longer pending.
    pub fn on_permission_resolved(&self, agent_id: &str, request_id: &str) {
        {
            let mut pending = self.pending.lock();
            if pending
                .get(agent_id)
                .is_some_and(|p| p.request_id.as_deref() == Some(request_id))
            {
                pending.remove(agent_id);
            }
        }
        notify::close_for_request(request_id);
    }

    /// Plays/shows/pushes the alert. Returns false if it was suppressed (quiet hours,
    /// or smart mute because the user is looking at that agent).
    fn alert(
        &self,
        agent_id: &str,
        reason: AttentionReason,
        title: &str,
        body: &str,
        request_id: Option<&str>,
    ) -> bool {
        let settings = self.settings();
        let window_focused = self.window_focused.load(Ordering::Relaxed);

        // Quiet hours silence everything, including the taskbar flash / dock bounce.
        if quiet_hours_active(&settings.quiet_hours, local_now()) {
            debug!(%agent_id, ?reason, "attention suppressed: quiet hours");
            return false;
        }

        if !window_focused {
            // Taskbar flash (Windows) / dock bounce (macOS) / urgency hint (Linux).
            if let Some(w) = window::main_window(&self.app) {
                let _ = w.request_user_attention(Some(UserAttentionType::Informational));
            }
        }
        let looking_at_it =
            window_focused && self.focused_agent.lock().as_deref() == Some(agent_id);
        if settings.notifications.smart_mute && looking_at_it {
            debug!(%agent_id, ?reason, "attention suppressed: smart mute");
            return false;
        }

        let sound_on = settings.sounds.enabled
            && match reason {
                AttentionReason::Permission => settings.sounds.on_permission,
                AttentionReason::Done => settings.sounds.on_done,
                AttentionReason::Error => settings.sounds.on_error,
            };
        let notify_reason_on = match reason {
            AttentionReason::Permission => settings.notifications.on_permission,
            AttentionReason::Done => settings.notifications.on_done,
            AttentionReason::Error => settings.notifications.on_error,
        };

        if sound_on {
            self.audio.play(reason, &settings.sounds);
        }
        if settings.notifications.enabled && notify_reason_on {
            notify::show(
                self.app.clone(),
                self.icon.clone(),
                Toast {
                    agent_id: Some(agent_id.to_string()),
                    reason: Some(reason),
                    request_id: request_id.map(str::to_string),
                    title: title.to_string(),
                    body: body.to_string(),
                },
            );
        }
        // Phone push only makes sense when the user isn't at the window, and follows
        // the notifications master switch.
        if settings.notifications.enabled && notify_reason_on && !window_focused {
            if let Some(url) = settings.ntfy_url.as_deref().map(str::trim) {
                if !url.is_empty() {
                    push_ntfy(url.to_string(), reason, title.to_string(), body.to_string());
                }
            }
        }
        true
    }

    /// Settings → "Preview" button. Ignores quiet hours / mute on purpose.
    pub fn preview(&self, reason: AttentionReason) {
        self.audio.play(reason, &self.settings().sounds);
    }

    pub fn test_notification(&self) {
        notify::show(
            self.app.clone(),
            self.icon.clone(),
            Toast {
                agent_id: None,
                reason: None,
                request_id: None,
                title: "Armada".into(),
                body: "Notifications are working. You'll hear from your fleet here.".into(),
            },
        );
    }

    /// Settings → "Send test": pushes a test message to `url`, or to the saved ntfy URL.
    /// Blocking (HTTP). Ok(false) when no URL is configured (nothing to test).
    pub fn test_push(&self, url: Option<&str>) -> Result<bool, String> {
        let saved = self.settings().ntfy_url;
        let url = url
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .or(saved.as_deref().map(str::trim).filter(|u| !u.is_empty()));
        let Some(url) = url else {
            return Ok(false);
        };
        send_ntfy(
            url,
            AttentionReason::Done,
            "Armada",
            "Phone pushes are working. You'll hear from your fleet here.",
        )
        .map(|()| true)
    }

    /// Every 30 s: re-ping once per approval that has waited longer than
    /// `settings.escalateAfterMins`.
    pub fn spawn_escalation(self: &Arc<Self>) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(ESCALATION_TICK);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            tick.tick().await; // first tick is immediate
            loop {
                tick.tick().await;
                let this = this.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || this.escalation_tick()).await;
            }
        });
    }

    fn escalation_tick(&self) {
        let core = self.core();
        let settings = self.settings();
        let agents = match core.agents() {
            Ok(a) => a,
            Err(e) => {
                warn!("escalation: could not list agents: {e:#}");
                return;
            }
        };
        let waiting: Vec<_> = agents
            .into_iter()
            .filter(|a| a.status == AgentStatus::NeedsPermission && !a.archived)
            .collect();

        // Agents we haven't tracked yet (e.g. waiting since before a restart): find
        // their request once, outside the lock. Tracked agents learn about new
        // requests from `on_attention`, so their transcripts aren't reloaded.
        let untracked: Vec<(String, Option<String>)> = {
            let pending = self.pending.lock();
            waiting
                .iter()
                .filter(|a| !pending.contains_key(&a.id))
                .map(|a| a.id.clone())
                .collect::<Vec<_>>()
        }
        .into_iter()
        .map(|id| {
            let request = latest_pending_request(&core, &id);
            (id, request)
        })
        .collect();

        // While quiet hours suppress alerts, don't use up the one-time re-ping: it
        // fires on the first tick after they end.
        let quiet = quiet_hours_active(&settings.quiet_hours, local_now());
        let mut due = Vec::new();
        let mut answered = Vec::new();
        {
            let mut pending = self.pending.lock();
            pending.retain(|id, p| {
                let still_waiting = waiting.iter().any(|a| &a.id == id);
                if !still_waiting {
                    answered.extend(p.request_id.clone());
                }
                still_waiting
            });
            for (id, request_id) in untracked {
                pending.entry(id).or_insert_with(|| PendingApproval {
                    request_id,
                    first_seen: Instant::now(),
                    escalated: false,
                });
            }
            let threshold = Duration::from_secs(u64::from(settings.escalate_after_mins) * 60);
            for agent in &waiting {
                let Some(entry) = pending.get_mut(&agent.id) else {
                    continue;
                };
                if settings.escalate_after_mins > 0
                    && !quiet
                    && !entry.escalated
                    && entry.first_seen.elapsed() >= threshold
                {
                    due.push((agent.clone(), entry.request_id.clone()));
                }
            }
        }
        // Answered since: their notifications' buttons would do nothing now.
        for request_id in answered {
            notify::close_for_request(&request_id);
        }

        for (agent, request_id) in due {
            let mins = settings.escalate_after_mins;
            info!(agent = %agent.id, "escalating pending approval");
            let delivered = self.alert(
                &agent.id,
                AttentionReason::Permission,
                &format!("Still waiting: {}", agent.title),
                &format!(
                    "An approval has been pending for over {mins} minute{}.",
                    if mins == 1 { "" } else { "s" }
                ),
                request_id.as_deref(),
            );
            // Only a re-ping that actually went out uses up the one-time escalation; a
            // suppressed one (smart mute) is retried on a later tick.
            if delivered {
                if let Some(entry) = self.pending.lock().get_mut(&agent.id) {
                    if entry.request_id == request_id {
                        entry.escalated = true;
                    }
                }
            }
        }
    }
}

fn latest_pending_request(core: &Core, agent_id: &str) -> Option<String> {
    core.items(agent_id)
        .ok()?
        .iter()
        .rev()
        .find_map(|item| match &item.body {
            ItemBody::Permission {
                request_id,
                resolution: None,
                ..
            } => Some(request_id.clone()),
            _ => None,
        })
}

fn local_now() -> NaiveTime {
    let now = chrono::Local::now();
    NaiveTime::from_hms_opt(now.hour(), now.minute(), 0).unwrap_or_default()
}

fn parse_hhmm(s: &str) -> Option<NaiveTime> {
    let (h, m) = s.trim().split_once(':')?;
    NaiveTime::from_hms_opt(h.trim().parse().ok()?, m.trim().parse().ok()?, 0)
}

/// Validates one quiet-hours bound for the settings save path: exactly "HH:MM",
/// 00:00–23:59.
pub(crate) fn validate_hhmm(s: &str) -> Result<(), String> {
    let bytes = s.as_bytes();
    let well_formed = bytes.len() == 5
        && bytes[2] == b':'
        && [0, 1, 3, 4].iter().all(|&i| bytes[i].is_ascii_digit());
    let in_range = well_formed && {
        let h = (bytes[0] - b'0') * 10 + (bytes[1] - b'0');
        let m = (bytes[3] - b'0') * 10 + (bytes[4] - b'0');
        h < 24 && m < 60
    };
    if in_range {
        Ok(())
    } else {
        Err(format!(
            "Quiet hours must be times like 22:00 (00:00 to 23:59), not {s:?}"
        ))
    }
}

/// Validates quiet hours for the settings save path. Disabled quiet hours may hold
/// anything (they're never read).
pub(crate) fn validate_quiet_hours(q: &QuietHours) -> Result<(), String> {
    if !q.enabled {
        return Ok(());
    }
    validate_hhmm(&q.start)?;
    validate_hhmm(&q.end)
}

/// `start..end` in local time; ranges may wrap midnight ("22:00".."08:00").
/// start == end means "all day".
pub fn quiet_hours_active(q: &QuietHours, now: NaiveTime) -> bool {
    if !q.enabled {
        return false;
    }
    let (Some(start), Some(end)) = (parse_hhmm(&q.start), parse_hhmm(&q.end)) else {
        return false;
    };
    if start == end {
        true
    } else if start < end {
        now >= start && now < end
    } else {
        now >= start || now < end
    }
}

/// Longest message body pushed to the phone (agent text can be long; the push is a
/// nudge, the details are in the app).
const MAX_PUSH_BODY_CHARS: usize = 200;

fn push_ntfy(url: String, reason: AttentionReason, title: String, body: String) {
    let spawned = std::thread::Builder::new()
        .name("armada-ntfy".into())
        .spawn(move || {
            if let Err(e) = send_ntfy(&url, reason, &title, &body) {
                warn!("{e}");
            }
        });
    if let Err(e) = spawned {
        warn!("could not spawn ntfy thread: {e}");
    }
}

/// Sends one push (blocking). Errors never contain the topic: anyone who knows it can
/// read the pushes, so it stays out of logs and error messages.
fn send_ntfy(url: &str, reason: AttentionReason, title: &str, body: &str) -> Result<(), String> {
    validate_ntfy_url(url).map_err(|e| format!("ntfy push refused: {e}"))?;
    let shown = redact_url(url);
    let priority = match reason {
        AttentionReason::Permission => "high",
        AttentionReason::Error => "default",
        AttentionReason::Done => "default",
    };
    let tags = match reason {
        AttentionReason::Permission => "warning",
        AttentionReason::Error => "x",
        AttentionReason::Done => "white_check_mark",
    };
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .tls_config(armada_core::toolchain::platform_tls())
            .timeout_global(Some(Duration::from_secs(10)))
            // A redirect could send the message (and the topic in the URL) anywhere,
            // including plain http.
            .max_redirects(0)
            .build(),
    );
    let response = agent
        .post(url)
        .header(
            "Title",
            header_value(&truncate_chars(title, MAX_PUSH_BODY_CHARS)),
        )
        .header("Priority", priority)
        .header("Tags", tags)
        .send(truncate_chars(body, MAX_PUSH_BODY_CHARS).as_bytes())
        .map_err(|e| {
            format!(
                "ntfy push to {shown} failed: {}",
                redact_topic(&e.to_string(), url)
            )
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "ntfy push to {shown} failed: the server answered {status}"
        ));
    }
    Ok(())
}

/// Validates an ntfy topic URL (settings save path and before every push): https
/// (plain http only to this computer or a private network), no user name/password in
/// it, and a topic.
pub(crate) fn validate_ntfy_url(raw: &str) -> Result<(), String> {
    let raw = raw.trim();
    let url = tauri::Url::parse(raw).map_err(|e| format!("not a valid URL ({e})"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(
            "don't put a user name or password in the ntfy URL; use an access token (?auth=…)"
                .into(),
        );
    }
    let host = url.host_str().unwrap_or_default();
    if host.is_empty() {
        return Err("the ntfy URL needs a server, e.g. https://ntfy.sh/your-topic".into());
    }
    match url.scheme() {
        "https" => {}
        "http" if is_local_host(host) => {}
        "http" => {
            return Err("use https:// for the ntfy server (plain http only for this computer or a private network)".into())
        }
        _ => return Err("the ntfy URL must start with https://".into()),
    }
    if url.path().trim_matches('/').is_empty() {
        return Err("add your topic to the URL, e.g. https://ntfy.sh/your-topic".into());
    }
    Ok(())
}

/// Loopback, private, link-local and CGNAT (Tailscale) addresses, and names that only
/// resolve locally (localhost, single-label names, .local, .lan, .home.arpa,
/// .internal, Tailscale's .ts.net).
fn is_local_host(host: &str) -> bool {
    use std::net::IpAddr;
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        let v4_local = |v4: std::net::Ipv4Addr| {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || (o[0] == 100 && (o[1] & 0xc0) == 64)
        };
        return match ip {
            IpAddr::V4(v4) => v4_local(v4),
            IpAddr::V6(v6) => {
                let first = v6.segments()[0];
                v6.is_loopback()
                    || (first & 0xfe00) == 0xfc00
                    || (first & 0xffc0) == 0xfe80
                    || v6.to_ipv4_mapped().is_some_and(v4_local)
            }
        };
    }
    let name = bare.trim_end_matches('.').to_ascii_lowercase();
    !name.contains('.')
        || [
            ".localhost",
            ".local",
            ".lan",
            ".home.arpa",
            ".internal",
            ".ts.net",
        ]
        .iter()
        .any(|suffix| name.ends_with(suffix))
}

/// `https://ntfy.sh/…` for logs: the topic (a shared secret) is left out.
fn redact_url(raw: &str) -> String {
    match tauri::Url::parse(raw.trim()) {
        Ok(url) => format!(
            "{}://{}/…",
            url.scheme(),
            url.host_str().unwrap_or_default()
        ),
        Err(_) => "the ntfy server".into(),
    }
}

/// `message` with the URL's path and query (topic, token) blanked out.
fn redact_topic(message: &str, raw: &str) -> String {
    let mut out = message.replace(raw.trim(), &redact_url(raw));
    if let Ok(url) = tauri::Url::parse(raw.trim()) {
        let topic = url.path().trim_matches('/');
        if !topic.is_empty() {
            out = out.replace(topic, "…");
        }
        if let Some(query) = url.query().filter(|q| !q.is_empty()) {
            out = out.replace(query, "…");
        }
        // Tokens (`?auth=…`) also on their own, raw and decoded.
        for (_, value) in url.query_pairs() {
            if value.len() >= 4 {
                out = out.replace(value.as_ref(), "…");
            }
        }
        for (_, value) in url
            .query()
            .unwrap_or_default()
            .split('&')
            .filter_map(|kv| kv.split_once('='))
        {
            if value.len() >= 4 {
                out = out.replace(value, "…");
            }
        }
    }
    out
}

/// At most `max` characters, ending in "…" when cut.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// HTTP header values must be ASCII; ntfy accepts RFC 2047 encoded words for the rest.
fn header_value(s: &str) -> String {
    let clean: String = s.chars().filter(|c| !c.is_control()).collect();
    if clean.is_ascii() {
        clean
    } else {
        format!("=?UTF-8?B?{}?=", base64(clean.as_bytes()))
    }
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(start: &str, end: &str) -> QuietHours {
        QuietHours {
            enabled: true,
            start: start.into(),
            end: end.into(),
        }
    }

    fn t(s: &str) -> NaiveTime {
        parse_hhmm(s).unwrap()
    }

    #[test]
    fn quiet_hours_same_day() {
        let qh = q("12:00", "14:00");
        assert!(!quiet_hours_active(&qh, t("11:59")));
        assert!(quiet_hours_active(&qh, t("12:00")));
        assert!(quiet_hours_active(&qh, t("13:30")));
        assert!(!quiet_hours_active(&qh, t("14:00")));
    }

    #[test]
    fn quiet_hours_wrap_midnight() {
        let qh = q("22:00", "08:00");
        assert!(quiet_hours_active(&qh, t("23:15")));
        assert!(quiet_hours_active(&qh, t("00:00")));
        assert!(quiet_hours_active(&qh, t("07:59")));
        assert!(!quiet_hours_active(&qh, t("08:00")));
        assert!(!quiet_hours_active(&qh, t("21:59")));
    }

    #[test]
    fn quiet_hours_disabled_or_invalid() {
        let mut qh = q("22:00", "08:00");
        qh.enabled = false;
        assert!(!quiet_hours_active(&qh, t("23:00")));
        assert!(!quiet_hours_active(&q("nope", "08:00"), t("23:00")));
    }

    #[test]
    fn quiet_hours_strings_are_validated() {
        for ok in ["00:00", "08:30", "23:59"] {
            assert!(validate_hhmm(ok).is_ok(), "{ok}");
        }
        for bad in [
            "24:00", "12:60", "7:30", "07:3", " 07:30", "0730", "ab:cd", "", "07:30:00",
        ] {
            assert!(validate_hhmm(bad).is_err(), "{bad}");
        }
        let mut qh = q("22:00", "nope");
        assert!(validate_quiet_hours(&qh).is_err());
        qh.enabled = false;
        assert!(validate_quiet_hours(&qh).is_ok());
    }

    #[test]
    fn ntfy_urls_are_validated() {
        for ok in [
            "https://ntfy.sh/my-topic",
            "https://ntfy.example.com/alerts?auth=tk_abc",
            "http://localhost:8080/topic",
            "http://127.0.0.1/t",
            "http://192.168.1.20:2586/t",
            "http://10.0.0.5/t",
            "http://172.20.0.1/t",
            "http://100.101.102.103/t",
            "http://[::1]:80/t",
            "http://[fd12::1]/t",
            "http://nas/t",
            "http://pi.local/t",
            "http://ntfy.home.arpa/t",
            "  https://ntfy.sh/padded  ",
        ] {
            assert!(
                validate_ntfy_url(ok).is_ok(),
                "{ok}: {:?}",
                validate_ntfy_url(ok)
            );
        }
        for bad in [
            "http://ntfy.sh/topic",
            "http://8.8.8.8/topic",
            "http://172.32.0.1/t",
            "https://user:pass@ntfy.sh/topic",
            "https://user@ntfy.sh/topic",
            "https://ntfy.sh",
            "https://ntfy.sh/",
            "ftp://ntfy.sh/topic",
            "file:///etc/passwd",
            "ntfy.sh/topic",
            "",
        ] {
            assert!(validate_ntfy_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn ntfy_logs_never_show_the_topic() {
        let url = "https://ntfy.sh/secret-topic?auth=tok123";
        assert_eq!(redact_url(url), "https://ntfy.sh/…");
        let msg = redact_topic(
            &format!("io error connecting to {url}: refused (secret-topic, tok123)"),
            url,
        );
        assert!(
            !msg.contains("secret-topic") && !msg.contains("tok123"),
            "{msg}"
        );
        assert!(msg.contains("ntfy.sh"), "{msg}");
    }

    #[test]
    fn push_bodies_are_truncated() {
        assert_eq!(truncate_chars("short", 200), "short");
        let long = "é".repeat(500);
        let cut = truncate_chars(&long, MAX_PUSH_BODY_CHARS);
        assert_eq!(cut.chars().count(), MAX_PUSH_BODY_CHARS);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn rfc2047_titles() {
        assert_eq!(header_value("Fix auth bug"), "Fix auth bug");
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
        assert_eq!(header_value("é"), "=?UTF-8?B?w6k=?=");
    }
}
