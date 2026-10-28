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
            // Start the escalation clock now rather than at the next poll.
            self.pending
                .lock()
                .entry(agent_id.to_string())
                .or_insert_with(|| PendingApproval {
                    request_id: request_id.map(str::to_string),
                    first_seen: Instant::now(),
                    escalated: false,
                });
        }
        self.alert(agent_id, reason, title, body, request_id);
    }

    fn alert(
        &self,
        agent_id: &str,
        reason: AttentionReason,
        title: &str,
        body: &str,
        request_id: Option<&str>,
    ) {
        let settings = self.settings();
        let window_focused = self.window_focused.load(Ordering::Relaxed);

        // Quiet hours silence everything, including the taskbar flash / dock bounce.
        if quiet_hours_active(&settings.quiet_hours, local_now()) {
            debug!(%agent_id, ?reason, "attention suppressed: quiet hours");
            return;
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
            return;
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
        // Phone push only makes sense when the user isn't at the window.
        if notify_reason_on && !window_focused {
            if let Some(url) = settings.ntfy_url.as_deref().map(str::trim) {
                if !url.is_empty() {
                    push_ntfy(url.to_string(), reason, title.to_string(), body.to_string());
                }
            }
        }
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

        let mut due = Vec::new();
        {
            let mut pending = self.pending.lock();
            pending.retain(|id, _| waiting.iter().any(|a| &a.id == id));
            let threshold = Duration::from_secs(u64::from(settings.escalate_after_mins) * 60);
            for agent in &waiting {
                let request_id = latest_pending_request(&core, &agent.id);
                let entry = pending
                    .entry(agent.id.clone())
                    .or_insert_with(|| PendingApproval {
                        request_id: request_id.clone(),
                        first_seen: Instant::now(),
                        escalated: false,
                    });
                if entry.request_id.is_none() {
                    entry.request_id = request_id.clone();
                } else if request_id.is_some() && entry.request_id != request_id {
                    // A new request replaced the old one: restart the clock.
                    *entry = PendingApproval {
                        request_id,
                        first_seen: Instant::now(),
                        escalated: false,
                    };
                }
                if settings.escalate_after_mins > 0
                    && !entry.escalated
                    && entry.first_seen.elapsed() >= threshold
                {
                    entry.escalated = true;
                    due.push((agent.clone(), entry.request_id.clone()));
                }
            }
        }

        for (agent, request_id) in due {
            let mins = settings.escalate_after_mins;
            info!(agent = %agent.id, "escalating pending approval");
            self.alert(
                &agent.id,
                AttentionReason::Permission,
                &format!("Still waiting: {}", agent.title),
                &format!(
                    "An approval has been pending for over {mins} minute{}.",
                    if mins == 1 { "" } else { "s" }
                ),
                request_id.as_deref(),
            );
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

fn push_ntfy(url: String, reason: AttentionReason, title: String, body: String) {
    let spawned = std::thread::Builder::new()
        .name("armada-ntfy".into())
        .spawn(move || {
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
                    .timeout_global(Some(Duration::from_secs(10)))
                    .build(),
            );
            let result = agent
                .post(&url)
                .header("Title", header_value(&title))
                .header("Priority", priority)
                .header("Tags", tags)
                .send(body.as_bytes());
            if let Err(e) = result {
                warn!("ntfy push failed: {e}");
            }
        });
    if let Err(e) = spawned {
        warn!("could not spawn ntfy thread: {e}");
    }
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
    fn rfc2047_titles() {
        assert_eq!(header_value("Fix auth bug"), "Fix auth bug");
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
        assert_eq!(header_value("é"), "=?UTF-8?B?w6k=?=");
    }
}
