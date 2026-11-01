//! Alerts to Slack, Discord and any webhook, next to the desktop notification and ntfy.
//!
//! * A target has a kind, a URL (a secret: it lives in the OS keychain and is never
//!   logged or put in an error) and the events it wants: needs you, finished, failed,
//!   budget.
//! * What goes out is the agent's name, its project, the event and a one-line summary.
//!   Never file contents or prompts; the summary is cut to one short line with secrets
//!   scrubbed.
//! * A burst is coalesced: the first alert goes at once, the rest within the next
//!   `MIN_GAP` leave together as one message, and a target gets at most `HOURLY_CAP`
//!   messages an hour.
//! * One request, a short timeout, no redirects, and at most two retries (network
//!   errors, 429 and 5xx only).

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use kvistcode_core::redact::redact_secrets;
use kvistcode_core::{AlertKind, AlertTarget, AttentionReason};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tracing::{debug, warn};

/// Alerts for one target closer together than this leave as one message.
const MIN_GAP: Duration = Duration::from_secs(15);
/// Messages one target gets per hour at most.
const HOURLY_CAP: usize = 40;
/// Events held while waiting for the gap to pass.
const MAX_PENDING: usize = 50;
/// Waits before the first and second retry.
const RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(4)];
const TIMEOUT: Duration = Duration::from_secs(8);
const MAX_URL_LEN: usize = 2048;
/// Longest summary line sent.
const MAX_SUMMARY_CHARS: usize = 140;
/// Longest Discord message is 2000 characters.
const MAX_MESSAGE_CHARS: usize = 1800;
/// Lines listed in a coalesced message.
const BATCH_LINES: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    NeedsYou,
    Finished,
    Failed,
    Budget,
    Test,
}

impl Event {
    /// The event an attention alert is. `held` = the agent is paused at a spending limit.
    pub fn from_attention(reason: AttentionReason, held: bool) -> Event {
        match reason {
            _ if held && reason != AttentionReason::Done => Event::Budget,
            AttentionReason::Permission => Event::NeedsYou,
            AttentionReason::Done => Event::Finished,
            AttentionReason::Error => Event::Failed,
        }
    }

    fn key(self) -> &'static str {
        match self {
            Event::NeedsYou => "needs_you",
            Event::Finished => "finished",
            Event::Failed => "failed",
            Event::Budget => "budget",
            Event::Test => "test",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Event::NeedsYou => "Needs you",
            Event::Finished => "Finished",
            Event::Failed => "Failed",
            Event::Budget => "Budget limit",
            Event::Test => "Test",
        }
    }

    fn wanted_by(self, target: &AlertTarget) -> bool {
        match self {
            Event::NeedsYou => target.events.needs_you,
            Event::Finished => target.events.finished,
            Event::Failed => target.events.failed,
            Event::Budget => target.events.budget,
            Event::Test => true,
        }
    }
}

/// What one alert says: who, where, what happened, in a line.
#[derive(Debug, Clone, PartialEq)]
pub struct AlertEvent {
    pub event: Event,
    pub agent: String,
    pub project: String,
    pub summary: String,
    pub at: chrono::DateTime<chrono::Utc>,
}

impl AlertEvent {
    pub fn new(event: Event, agent: &str, project: &str, text: &str) -> Self {
        AlertEvent {
            event,
            agent: short(agent, 80),
            project: short(project, 80),
            summary: short(text, MAX_SUMMARY_CHARS),
            at: chrono::Utc::now(),
        }
    }

    fn who(&self) -> String {
        match (self.agent.is_empty(), self.project.is_empty()) {
            (_, true) => self.agent.clone(),
            (true, false) => self.project.clone(),
            (false, false) => format!("{} ({})", self.agent, self.project),
        }
    }

    fn as_json(&self) -> Value {
        json!({
            "event": self.event.key(),
            "agent": self.agent,
            "project": self.project,
            "summary": self.summary,
            "at": self.at.to_rfc3339(),
        })
    }
}

/// The first non-empty line of `text`, secrets scrubbed, cut to `max` characters.
fn short(text: &str, max: usize) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    let line: String = redact_secrets(line)
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    if line.chars().count() <= max {
        return line;
    }
    let mut out: String = line.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

// ---- URLs ---------------------------------------------------------------------

/// Checks a webhook URL for `kind`: https always (plain http only to this computer for
/// a generic webhook), no user name or password, and the shape the service uses.
pub fn validate_url(kind: AlertKind, raw: &str) -> Result<(), String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("enter the webhook URL".into());
    }
    if raw.len() > MAX_URL_LEN {
        return Err("that URL is too long".into());
    }
    let url = tauri::Url::parse(raw).map_err(|_| "that isn't a valid URL".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("don't put a user name or password in the URL".into());
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if host.is_empty() {
        return Err("the URL needs a server name".into());
    }
    match (url.scheme(), kind) {
        ("https", _) => {}
        ("http", AlertKind::Webhook) if is_loopback(&host) => {}
        ("http", AlertKind::Webhook) => {
            return Err("use https:// (plain http is only allowed for localhost)".into())
        }
        _ => return Err("the URL must start with https://".into()),
    }
    let path = url.path();
    match kind {
        AlertKind::Slack => {
            if host != "hooks.slack.com"
                || !["/services/", "/workflows/", "/triggers/"]
                    .iter()
                    .any(|p| path.starts_with(p) && path.len() > p.len() + 6)
            {
                return Err(
                    "a Slack incoming webhook looks like https://hooks.slack.com/services/…".into(),
                );
            }
        }
        AlertKind::Discord => {
            let known = [
                "discord.com",
                "ptb.discord.com",
                "canary.discord.com",
                "discordapp.com",
            ];
            let parts = path
                .strip_prefix("/api/webhooks/")
                .map(|p| p.split('/').filter(|s| !s.is_empty()).count())
                .unwrap_or(0);
            if !known.contains(&host.as_str()) || parts < 2 {
                return Err(
                    "a Discord webhook looks like https://discord.com/api/webhooks/…".into(),
                );
            }
        }
        AlertKind::Webhook => {}
    }
    Ok(())
}

fn is_loopback(host: &str) -> bool {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    bare == "localhost"
        || bare
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// `https://hooks.slack.com/…` for logs and messages: the path and query hold the secret.
pub fn mask_url(raw: &str) -> String {
    match tauri::Url::parse(raw.trim()) {
        Ok(url) => format!(
            "{}://{}/…",
            url.scheme(),
            url.host_str().unwrap_or_default()
        ),
        Err(_) => "the webhook".into(),
    }
}

/// `message` with the URL (or its secret path and query) blanked out.
fn scrub(message: &str, raw: &str) -> String {
    let mut out = message.replace(raw.trim(), &mask_url(raw));
    if let Ok(url) = tauri::Url::parse(raw.trim()) {
        let query_values: Vec<String> = url.query_pairs().map(|(_, v)| v.into_owned()).collect();
        let pieces = std::iter::once(url.path().trim_matches('/'))
            .chain(url.path().split('/'))
            .chain(url.query())
            .chain(query_values.iter().map(String::as_str));
        for secret in pieces {
            if secret.len() >= 4 {
                out = out.replace(secret, "…");
            }
        }
    }
    out
}

// ---- payloads -----------------------------------------------------------------

/// The message text for a batch: one alert, or a short list of several.
fn text_of(batch: &[AlertEvent]) -> String {
    if let [one] = batch {
        let mut s = format!("{} · {}", one.event.label(), one.who());
        if !one.summary.is_empty() {
            s.push('\n');
            s.push_str(&one.summary);
        }
        return s;
    }
    let mut s = format!("{} updates from Kvistcode", batch.len());
    for e in batch.iter().take(BATCH_LINES) {
        s.push_str(&format!("\n• {} · {}", e.event.label(), e.who()));
        if !e.summary.is_empty() {
            s.push_str(&format!(": {}", e.summary));
        }
    }
    if batch.len() > BATCH_LINES {
        s.push_str(&format!("\n…and {} more", batch.len() - BATCH_LINES));
    }
    s
}

fn clip(mut s: String, max: usize) -> String {
    if s.chars().count() > max {
        s = s.chars().take(max - 1).collect();
        s.push('…');
    }
    s
}

/// The JSON body for `kind`.
fn payload(kind: AlertKind, batch: &[AlertEvent]) -> Value {
    let text = text_of(batch);
    match kind {
        AlertKind::Slack => {
            // Slack treats & < > as markup.
            let escaped = text
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            json!({ "text": clip(escaped, MAX_MESSAGE_CHARS) })
        }
        AlertKind::Discord => json!({
            "content": clip(text, MAX_MESSAGE_CHARS),
            // Never ping @everyone, roles or users from agent text.
            "allowed_mentions": { "parse": [] },
        }),
        AlertKind::Webhook => match batch {
            [one] => {
                let mut v = one.as_json();
                v["app"] = "kvistcode".into();
                v
            }
            _ => json!({
                "app": "kvistcode",
                "event": "batch",
                "summary": format!("{} updates", batch.len()),
                "at": chrono::Utc::now().to_rfc3339(),
                "events": batch.iter().map(AlertEvent::as_json).collect::<Vec<_>>(),
            }),
        },
    }
}

// ---- sending ------------------------------------------------------------------

/// POSTs `body` as JSON, retrying a few times on errors that may pass. Errors never
/// contain the URL.
fn post_json(url: &str, body: &Value, retry_delays: &[Duration]) -> Result<(), String> {
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .tls_config(kvistcode_core::toolchain::platform_tls())
            .timeout_global(Some(TIMEOUT))
            // A redirect could carry the message (and the secret URL) anywhere.
            .max_redirects(0)
            .http_status_as_error(false)
            .build(),
    );
    let bytes = serde_json::to_vec(body).map_err(|e| e.to_string())?;
    let mut attempt = 0;
    loop {
        let outcome = agent
            .post(url.trim())
            .header("Content-Type", "application/json")
            .send(&bytes[..]);
        let (retry, error) = match outcome {
            Ok(r) if r.status().is_success() => return Ok(()),
            Ok(r) => {
                let code = r.status().as_u16();
                (
                    code == 429 || code >= 500,
                    if (300..400).contains(&code) {
                        "the server redirected the request (redirects are not followed)".to_string()
                    } else {
                        format!("the server answered {code}")
                    },
                )
            }
            Err(e) => (true, scrub(&e.to_string(), url)),
        };
        match retry_delays.get(attempt) {
            Some(wait) if retry => {
                std::thread::sleep(*wait);
                attempt += 1;
            }
            _ => return Err(format!("{}: {error}", mask_url(url))),
        }
    }
}

/// Sends a test message to a URL (Settings → "Send test"). Blocking.
pub fn send_test(kind: AlertKind, url: &str) -> Result<(), String> {
    validate_url(kind, url).map_err(|e| format!("Webhook URL: {e}"))?;
    let event = AlertEvent::new(
        Event::Test,
        "Kvistcode",
        "",
        "Alerts are working. You'll hear from your fleet here.",
    );
    post_json(url, &payload(kind, &[event]), &RETRY_DELAYS[..1])
}

// ---- coalescing ---------------------------------------------------------------

/// What `Coalescer::offer` decided.
#[derive(Debug, PartialEq)]
pub enum Offer {
    /// Send these now.
    Send(Vec<AlertEvent>),
    /// Hold it; call `flush` after this long.
    FlushAfter(Duration),
    /// Held already; a flush is on its way.
    Held,
    /// Over the hourly cap: not sent.
    Dropped,
}

/// Per-target rate limit: the first alert goes at once, a burst after it waits for the
/// gap and leaves as one message, and an hour holds at most `cap` messages.
pub struct Coalescer {
    gap: Duration,
    cap: usize,
    last: Option<Instant>,
    sent: VecDeque<Instant>,
    pending: Vec<AlertEvent>,
    flush_due: bool,
}

impl Coalescer {
    pub fn new(gap: Duration, cap: usize) -> Self {
        Coalescer {
            gap,
            cap,
            last: None,
            sent: VecDeque::new(),
            pending: Vec::new(),
            flush_due: false,
        }
    }

    pub fn offer(&mut self, now: Instant, event: AlertEvent) -> Offer {
        if self.pending.len() >= MAX_PENDING {
            self.pending.remove(0);
        }
        self.pending.push(event);
        if self.flush_due {
            return Offer::Held;
        }
        match self.last.map(|t| now.saturating_duration_since(t)) {
            Some(since) if since < self.gap => {
                self.flush_due = true;
                Offer::FlushAfter(self.gap - since)
            }
            _ => self.take(now),
        }
    }

    /// The held alerts, once the gap has passed.
    pub fn flush(&mut self, now: Instant) -> Option<Vec<AlertEvent>> {
        self.flush_due = false;
        match self.take(now) {
            Offer::Send(batch) => Some(batch),
            _ => None,
        }
    }

    fn take(&mut self, now: Instant) -> Offer {
        let hour = Duration::from_secs(3600);
        while self
            .sent
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= hour)
        {
            self.sent.pop_front();
        }
        if self.pending.is_empty() {
            return Offer::Held;
        }
        if self.sent.len() >= self.cap {
            self.pending.clear();
            return Offer::Dropped;
        }
        self.last = Some(now);
        self.sent.push_back(now);
        Offer::Send(std::mem::take(&mut self.pending))
    }
}

// ---- the hub ------------------------------------------------------------------

/// Routes alerts to the targets that want them.
#[derive(Default)]
pub struct Hub {
    coalescers: Mutex<HashMap<String, Arc<Mutex<Coalescer>>>>,
}

impl Hub {
    /// Hands `event` to every enabled target that wants it. Returns at once; the
    /// requests run on their own threads.
    pub fn dispatch(&self, targets: &[AlertTarget], event: &AlertEvent) {
        for target in targets {
            if !target.enabled || !event.event.wanted_by(target) {
                continue;
            }
            if let Err(e) = validate_url(target.kind, &target.url) {
                debug!("alert target {} skipped: {e}", target.id);
                continue;
            }
            let coalescer = self
                .coalescers
                .lock()
                .entry(target.id.clone())
                .or_insert_with(|| Arc::new(Mutex::new(Coalescer::new(MIN_GAP, HOURLY_CAP))))
                .clone();
            let offer = coalescer.lock().offer(Instant::now(), event.clone());
            match offer {
                Offer::Send(batch) => spawn_send(target.clone(), batch),
                Offer::FlushAfter(wait) => {
                    let target = target.clone();
                    let spawned = std::thread::Builder::new()
                        .name("kvistcode-alert-flush".into())
                        .spawn(move || {
                            std::thread::sleep(wait);
                            let batch = coalescer.lock().flush(Instant::now());
                            if let Some(batch) = batch {
                                send_batch(&target, &batch);
                            }
                        });
                    if let Err(e) = spawned {
                        warn!("could not spawn the alert thread: {e}");
                    }
                }
                Offer::Held => {}
                Offer::Dropped => warn!(
                    "alerts to {} paused: more than {HOURLY_CAP} messages in an hour",
                    mask_url(&target.url)
                ),
            }
        }
    }
}

fn spawn_send(target: AlertTarget, batch: Vec<AlertEvent>) {
    let spawned = std::thread::Builder::new()
        .name("kvistcode-alert".into())
        .spawn(move || send_batch(&target, &batch));
    if let Err(e) = spawned {
        warn!("could not spawn the alert thread: {e}");
    }
}

fn send_batch(target: &AlertTarget, batch: &[AlertEvent]) {
    if let Err(e) = post_json(&target.url, &payload(target.kind, batch), &RETRY_DELAYS) {
        warn!("alert not delivered: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kvistcode_core::AlertEvents;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn ev(event: Event, agent: &str, text: &str) -> AlertEvent {
        AlertEvent::new(event, agent, "kvistcode", text)
    }

    #[test]
    fn urls_are_validated_per_kind() {
        use AlertKind::*;
        let ok = |k, u: &str| validate_url(k, u).unwrap_or_else(|e| panic!("{u}: {e}"));
        ok(
            Slack,
            "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX",
        );
        ok(
            Discord,
            "https://discord.com/api/webhooks/123456/abcdef-token",
        );
        ok(
            Discord,
            "https://canary.discord.com/api/webhooks/123456/abcdef",
        );
        ok(Webhook, "https://example.com/hooks/abc?token=1");
        ok(Webhook, "http://localhost:8080/hook");
        ok(Webhook, "http://127.0.0.1:9000/");
        ok(Webhook, "http://[::1]:9000/");

        for (kind, url) in [
            (Slack, ""),
            (Slack, "not a url"),
            (
                Slack,
                "http://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX",
            ),
            (Slack, "https://example.com/services/T000/B000/XXXXXXXXXXXX"),
            (
                Slack,
                "https://hooks.slack.com.evil.com/services/T000/B000/XXXX",
            ),
            (Slack, "https://hooks.slack.com/"),
            (
                Slack,
                "https://user:pw@hooks.slack.com/services/T000/B000/XXXXXXXXXXXX",
            ),
            (Discord, "https://discord.com/api/webhooks/123"),
            (Discord, "https://discord.com.evil.io/api/webhooks/1/2"),
            (Discord, "http://discord.com/api/webhooks/1/2"),
            (Webhook, "http://example.com/hook"),
            (Webhook, "http://192.168.1.5/hook"),
            (Webhook, "ftp://example.com/hook"),
            (Webhook, "https://user:pw@example.com/hook"),
            (Webhook, "javascript:alert(1)"),
        ] {
            assert!(validate_url(kind, url).is_err(), "{kind:?} {url}");
        }
        assert!(validate_url(Webhook, &format!("https://a.com/{}", "x".repeat(3000))).is_err());
    }

    #[test]
    fn masking_hides_the_secret_path() {
        let url = "https://hooks.slack.com/services/T000/B000/SECRETSECRET?x=tokentoken";
        assert_eq!(mask_url(url), "https://hooks.slack.com/…");
        let msg = scrub(&format!("error sending to {url}: boom SECRETSECRET"), url);
        assert!(
            !msg.contains("SECRET") && !msg.contains("tokentoken"),
            "{msg}"
        );
        assert_eq!(mask_url("garbage"), "the webhook");
    }

    #[test]
    fn summaries_are_one_scrubbed_line() {
        let e = ev(
            Event::Finished,
            "Fix tests",
            "\n  Done with the refactor\nsecond line with a password: hunter2\n",
        );
        assert_eq!(e.summary, "Done with the refactor");
        let long = ev(Event::Failed, "x", &"word ".repeat(100));
        assert!(long.summary.chars().count() <= MAX_SUMMARY_CHARS);
        assert!(long.summary.ends_with('…'));
        let secret = ev(
            Event::Failed,
            "x",
            "request failed with key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
        );
        assert!(
            !secret.summary.contains("abcdefghijkl"),
            "{}",
            secret.summary
        );
    }

    #[test]
    fn events_map_from_attention() {
        use AttentionReason::*;
        assert_eq!(Event::from_attention(Permission, false), Event::NeedsYou);
        assert_eq!(Event::from_attention(Done, false), Event::Finished);
        assert_eq!(Event::from_attention(Error, false), Event::Failed);
        assert_eq!(Event::from_attention(Permission, true), Event::Budget);
        assert_eq!(Event::from_attention(Error, true), Event::Budget);
        // A held agent that finishes a different way is still just finished.
        assert_eq!(Event::from_attention(Done, true), Event::Finished);
    }

    #[test]
    fn payloads_carry_only_the_summary_fields() {
        let one = [ev(Event::NeedsYou, "Fix tests", "Run npm test")];
        let slack = payload(AlertKind::Slack, &one);
        assert_eq!(
            slack["text"],
            "Needs you · Fix tests (kvistcode)\nRun npm test"
        );
        assert_eq!(slack.as_object().unwrap().len(), 1);

        let discord = payload(AlertKind::Discord, &one);
        assert_eq!(discord["allowed_mentions"]["parse"], json!([]));

        let hook = payload(AlertKind::Webhook, &one);
        let mut keys: Vec<_> = hook.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["agent", "app", "at", "event", "project", "summary"]);
        assert_eq!(hook["event"], "needs_you");

        let two = [one[0].clone(), ev(Event::Finished, "Other", "All done")];
        let batch = payload(AlertKind::Webhook, &two);
        assert_eq!(batch["event"], "batch");
        assert_eq!(batch["events"].as_array().unwrap().len(), 2);
        let text = payload(AlertKind::Slack, &two)["text"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            text.starts_with("2 updates from Kvistcode") && text.contains("• Finished · Other")
        );
    }

    #[test]
    fn markup_and_mentions_are_neutralized() {
        let e = [ev(
            Event::Failed,
            "a <b>",
            "see <https://evil.example|click> & @everyone",
        )];
        let slack = payload(AlertKind::Slack, &e)["text"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            slack.contains("&lt;https://evil.example|click&gt; &amp;"),
            "{slack}"
        );
        assert!(!slack.contains('<'));
        // Discord can't be told to ping: the allow-list is empty.
        assert_eq!(
            payload(AlertKind::Discord, &e)["allowed_mentions"]["parse"],
            json!([])
        );
    }

    #[test]
    fn long_batches_stay_within_message_limits() {
        let many: Vec<_> = (0..30)
            .map(|i| ev(Event::Finished, &format!("agent {i}"), &"x".repeat(200)))
            .collect();
        let text = payload(AlertKind::Discord, &many)["content"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(text.chars().count() <= MAX_MESSAGE_CHARS);
        assert!(text_of(&many).contains("…and 22 more"));
    }

    #[test]
    fn a_burst_is_coalesced_and_capped() {
        let t0 = Instant::now();
        let mut c = Coalescer::new(Duration::from_secs(15), 3);
        // The first alert goes at once.
        let Offer::Send(first) = c.offer(t0, ev(Event::Finished, "a", "1")) else {
            panic!("first alert should send")
        };
        assert_eq!(first.len(), 1);
        // The rest wait for the gap, with one flush scheduled.
        let wait = c.offer(t0 + Duration::from_secs(1), ev(Event::Finished, "b", "2"));
        assert_eq!(wait, Offer::FlushAfter(Duration::from_secs(14)));
        assert_eq!(
            c.offer(t0 + Duration::from_secs(2), ev(Event::Failed, "c", "3")),
            Offer::Held
        );
        let batch = c.flush(t0 + Duration::from_secs(15)).unwrap();
        assert_eq!(batch.len(), 2);
        assert!(c.flush(t0 + Duration::from_secs(16)).is_none());
        // After the gap a new alert sends at once again (third message this hour).
        assert!(matches!(
            c.offer(t0 + Duration::from_secs(40), ev(Event::Finished, "d", "4")),
            Offer::Send(_)
        ));
        // The hourly cap: nothing more until an hour has passed.
        assert_eq!(
            c.offer(t0 + Duration::from_secs(80), ev(Event::Finished, "e", "5")),
            Offer::Dropped
        );
        assert!(matches!(
            c.offer(
                t0 + Duration::from_secs(3700),
                ev(Event::Finished, "f", "6")
            ),
            Offer::Send(_)
        ));
    }

    #[test]
    fn dispatch_respects_event_toggles_and_enabled() {
        let hub = Hub::default();
        let mut target = AlertTarget {
            id: "t".into(),
            kind: AlertKind::Webhook,
            url: "http://127.0.0.1:1/never".into(),
            events: AlertEvents {
                needs_you: true,
                finished: false,
                failed: false,
                budget: false,
            },
            ..Default::default()
        };
        // Nothing is sent for events the target didn't ask for (no coalescer is even made).
        hub.dispatch(
            std::slice::from_ref(&target),
            &ev(Event::Finished, "a", "x"),
        );
        assert!(hub.coalescers.lock().is_empty());
        target.enabled = false;
        hub.dispatch(
            std::slice::from_ref(&target),
            &ev(Event::NeedsYou, "a", "x"),
        );
        assert!(hub.coalescers.lock().is_empty());
        // An invalid URL is skipped too.
        target.enabled = true;
        target.url = "http://example.com/x".into();
        hub.dispatch(
            std::slice::from_ref(&target),
            &ev(Event::NeedsYou, "a", "x"),
        );
        assert!(hub.coalescers.lock().is_empty());
    }

    /// A tiny HTTP server on localhost that answers each request with the next status
    /// and records the bodies. Returns its URL.
    fn serve(statuses: &[u16]) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/hook", listener.local_addr().unwrap());
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let seen = bodies.clone();
        let statuses = statuses.to_vec();
        std::thread::spawn(move || {
            for status in statuses {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let header_end = loop {
                    let n = stream.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break buf.len();
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break p + 4;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..header_end]).to_lowercase();
                let len = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                while buf.len() < header_end + len {
                    let n = stream.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                seen.lock()
                    .push(String::from_utf8_lossy(&buf[header_end..]).into_owned());
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
            }
        });
        (url, bodies)
    }

    const FAST: [Duration; 2] = [Duration::from_millis(5), Duration::from_millis(5)];

    #[test]
    fn a_post_carries_json_and_retries_server_errors() {
        let (url, bodies) = serve(&[503, 500, 200]);
        let body = payload(AlertKind::Webhook, &[ev(Event::Failed, "Fix", "boom")]);
        post_json(&url, &body, &FAST).unwrap();
        let seen = bodies.lock().clone();
        assert_eq!(seen.len(), 3, "two retries, then success");
        let sent: Value = serde_json::from_str(&seen[2]).unwrap();
        assert_eq!(sent["event"], "failed");
        assert_eq!(sent["agent"], "Fix");
    }

    #[test]
    fn retries_are_limited_and_client_errors_are_not_retried() {
        let (url, bodies) = serve(&[500, 500, 500, 500]);
        let err = post_json(&url, &json!({}), &FAST).unwrap_err();
        assert_eq!(bodies.lock().len(), 3, "one try and two retries");
        assert!(err.contains("500"), "{err}");

        let (url, bodies) = serve(&[400, 200]);
        let err = post_json(&url, &json!({}), &FAST).unwrap_err();
        assert_eq!(bodies.lock().len(), 1, "a 400 is final");
        assert!(err.contains("400") && !err.contains("/hook"), "{err}");
    }

    #[test]
    fn redirects_are_not_followed() {
        let (url, bodies) = serve(&[302, 200]);
        let err = post_json(&url, &json!({}), &[]).unwrap_err();
        assert!(err.contains("redirect"), "{err}");
        assert_eq!(bodies.lock().len(), 1);
    }

    #[test]
    fn a_dead_server_fails_without_leaking_the_url() {
        // Nothing listens on this port.
        let url = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}/secret-path-1234", l.local_addr().unwrap())
        };
        let err = post_json(&url, &json!({}), &FAST).unwrap_err();
        assert!(!err.contains("secret-path-1234"), "{err}");
    }

    #[test]
    fn send_test_validates_before_any_request() {
        let err = send_test(AlertKind::Slack, "https://example.com/x").unwrap_err();
        assert!(err.starts_with("Webhook URL:"), "{err}");
        let (url, bodies) = serve(&[200]);
        send_test(AlertKind::Webhook, &url).unwrap();
        let sent: Value = serde_json::from_str(&bodies.lock()[0]).unwrap();
        assert_eq!(sent["event"], "test");
    }
}
