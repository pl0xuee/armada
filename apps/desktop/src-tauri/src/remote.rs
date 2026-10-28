//! Remote control / mobile companion: an opt-in HTTP server that serves the phone
//! web app (apps/remote) plus a small JSON + Server-Sent Events API.
//!
//! Security model:
//! - Off by default; binds to 127.0.0.1, or only to the machine's LAN address when
//!   the user enables LAN access (never every interface).
//! - Every API call needs a bearer token: the owner token (full control, shown as a
//!   QR code in Settings → Remote) or a share token (read-only, one agent, with a
//!   trimmed view of that agent). Tokens are 244-bit random values, compared in
//!   constant time and stored with owner-only permissions.
//! - Revoking a share, unpairing devices or stopping the server also ends live
//!   event streams that were opened with the old credentials.
//! - Requests must name this server in `Host` (DNS rebinding) and must not be
//!   cross-site browser requests. Invalid tokens from one address are rate limited;
//!   a valid token is never locked out.
//! - Traffic is plain HTTP; the UI explains that LAN use belongs on a trusted
//!   network or a VPN such as Tailscale.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use armada_core::{
    now_ms, Agent, ArmadaEvent, Attachment, Core, CreateAgentRequest, Provider, RemoteSettings,
};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use futures_util::stream::Stream;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, oneshot, watch};
use tracing::{info, warn};

static REMOTE_HTML: &str = include_str!(concat!(env!("OUT_DIR"), "/remote.html"));
static ICON_PNG: &[u8] = include_bytes!("../icons/128x128@2x.png");
static ICON_192: &[u8] = include_bytes!("../icons/pwa-192.png");
static ICON_512: &[u8] = include_bytes!("../icons/icon.png");

const MAX_FAILURES: u32 = 10;
/// Open connections at once (each SSE stream holds one).
const MAX_CONNECTIONS: usize = 64;
/// A client must send its request headers within this time (also closes idle
/// keep-alive connections), so slow or silent clients can't hold connections.
const HEADER_READ_TIMEOUT: Duration = if cfg!(test) {
    Duration::from_secs(1)
} else {
    Duration::from_secs(10)
};
const LOCKOUT: Duration = Duration::from_secs(10 * 60);
const MIN_PORT: u16 = 1024;

/// Agent fields a read-only viewer doesn't need (local paths, ids, branches).
/// Request-body cap for prompts with attachments (4 phone photos at core's 5 MB
/// per-image limit, base64-encoded, plus JSON).
const MAX_REMOTE_UPLOAD: usize = 28 * 1024 * 1024;
/// A request body must arrive within this time (stops slow-drip uploads holding
/// connection slots).
const BODY_READ_TIMEOUT: Duration = Duration::from_secs(150);
/// How long a finished request's result is replayed for a retried Idempotency-Key.
const IDEMPOTENCY_TTL: Duration = Duration::from_secs(10 * 60);
/// Live event streams per token: owners (several devices/tabs) and share links.
const MAX_OWNER_STREAMS: usize = 16;
const MAX_VIEWER_STREAMS: usize = 4;
/// Event streams end after this long; clients reconnect (and re-check access).
const STREAM_LIFETIME: Duration = Duration::from_secs(60 * 60);
/// Images per prompt sent from the phone.
const MAX_REMOTE_IMAGES: usize = 4;

/// The agent fields a read-only viewer gets (an allowlist, so new fields stay
/// private by default). No local paths, accounts, queued drafts or settings.
const VIEWER_FIELDS: &[&str] = &[
    "id",
    "title",
    "provider",
    "customAgentId",
    "status",
    "running",
    "worktree",
    "createdAt",
    "updatedAt",
    "lastActivityAt",
    "costUsd",
    "tokensUsed",
    "contextUsed",
    "contextSize",
    "archived",
    "lastMessage",
    "pendingPermissions",
    "rateLimited",
];

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Share {
    token: String,
    agent_id: String,
    created_at: i64,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    owner: String,
    shares: Vec<Share>,
}

struct Running {
    addr: SocketAddr,
    /// Identifies this server run; streams from an older run end when it changes.
    epoch: u64,
    settings: RemoteSettings,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShareLink {
    pub token: String,
    pub agent_id: String,
    pub agent_title: Option<String>,
    pub url: Option<String>,
    pub created_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub enabled: bool,
    pub running: bool,
    pub lan: bool,
    pub port: u16,
    /// e.g. http://192.168.1.20:47821
    pub url: Option<String>,
    /// Owner pairing link (contains the token in the URL fragment).
    pub pairing_url: Option<String>,
    /// QR code for `pairing_url`, as an SVG document.
    pub qr_svg: Option<String>,
    pub error: Option<String>,
    pub shares: Vec<ShareLink>,
}

pub struct Remote {
    core: Core,
    version: String,
    path: PathBuf,
    events: broadcast::Sender<Arc<Published>>,
    tokens: Mutex<Tokens>,
    running: Mutex<Option<Running>>,
    /// Bumped whenever credentials change or the server stops/starts; live event
    /// streams re-check their token and server epoch when it moves.
    generation: watch::Sender<u64>,
    epoch: Mutex<u64>,
    /// Serializes start/stop so concurrent settings saves can't race.
    apply_lock: tokio::sync::Mutex<()>,
    /// Set at app exit: later `apply` calls (e.g. the startup one) do nothing.
    shutting_down: std::sync::atomic::AtomicBool,
    error: Mutex<Option<String>>,
    /// Problem with the stored pairing data, shown until the user re-pairs.
    tokens_problem: Mutex<Option<String>>,
    /// Serializes writes of the token file.
    save_lock: Mutex<()>,
    /// False while the token file exists but couldn't be read: never overwrite it
    /// then (until the user explicitly unpairs).
    persist: std::sync::atomic::AtomicBool,
    failures: Mutex<HashMap<IpAddr, (u32, Instant)>>,
    /// Open event streams per token.
    streams: Arc<Mutex<HashMap<String, usize>>>,
    /// Idempotency-Key → result (None while in flight), so a phone retrying after a
    /// timeout doesn't start a second agent or send a prompt twice.
    idempotency: Mutex<HashMap<String, (Instant, Option<IdemResult>)>>,
}

/// A finished request's status and JSON body.
type IdemResult = (StatusCode, String);

enum IdemBegin {
    New,
    InFlight,
    Done(StatusCode, String),
}

#[derive(Clone, PartialEq, Debug)]
enum Scope {
    Owner,
    Viewer(String),
}

impl Scope {
    fn can_see(&self, agent_id: &str) -> bool {
        match self {
            Scope::Owner => true,
            Scope::Viewer(id) => id == agent_id,
        }
    }
}

fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The machine's primary LAN address (no packets are sent).
fn lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_unspecified() && !ip.is_loopback()).then_some(ip)
}

/// Removes fields a read-only viewer shouldn't see from a serialized agent.
fn trim_agent(agent: &mut Value) {
    if let Some(obj) = agent.as_object_mut() {
        obj.retain(|k, _| VIEWER_FIELDS.contains(&k.as_str()));
    }
}

impl Remote {
    pub fn new(core: Core, version: String, data_dir: PathBuf) -> Arc<Remote> {
        let path = data_dir.join("remote.json");
        let loaded = load_tokens(&path);
        let (events, _) = broadcast::channel(1024);
        let (generation, _) = watch::channel(0);
        let remote = Arc::new(Remote {
            core,
            version,
            path,
            events,
            tokens: Mutex::new(loaded.tokens),
            running: Mutex::new(None),
            generation,
            epoch: Mutex::new(0),
            apply_lock: tokio::sync::Mutex::new(()),
            shutting_down: std::sync::atomic::AtomicBool::new(false),
            error: Mutex::new(None),
            tokens_problem: Mutex::new(loaded.problem),
            save_lock: Mutex::new(()),
            persist: std::sync::atomic::AtomicBool::new(loaded.persist),
            failures: Mutex::new(HashMap::new()),
            streams: Arc::new(Mutex::new(HashMap::new())),
            idempotency: Mutex::new(HashMap::new()),
        });
        if let Some(problem) = remote.tokens_problem.lock().as_deref() {
            warn!("{problem}");
        }
        if loaded.dirty {
            // New or repaired tokens; also tightens permissions of existing files.
            remote.save_tokens();
        }
        remote
    }

    /// Writes the tokens atomically (temp file + rename), one writer at a time; the
    /// snapshot is taken under the same lock, so the last writer writes the latest.
    fn save_tokens(&self) {
        let _saving = self.save_lock.lock();
        if !self.persist.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let data = match serde_json::to_vec_pretty(&*self.tokens.lock()) {
            Ok(d) => d,
            Err(e) => return warn!("serializing remote tokens: {e}"),
        };
        if let Err(e) = write_private_atomic(&self.path, &data) {
            warn!("saving remote tokens: {e}");
            *self.tokens_problem.lock() = Some(format!(
                "Couldn't save remote pairing data ({}): {e}",
                self.path.display()
            ));
        }
    }

    fn bump_generation(&self) {
        self.generation.send_modify(|g| *g += 1);
    }

    /// Forwards agent events to connected remote clients.
    pub fn publish(&self, event: &ArmadaEvent) {
        if let ArmadaEvent::AgentRemoved { agent_id } = event {
            let removed = {
                let mut tokens = self.tokens.lock();
                let before = tokens.shares.len();
                tokens.shares.retain(|s| &s.agent_id != agent_id);
                before != tokens.shares.len()
            };
            if removed {
                self.save_tokens();
                self.bump_generation();
            }
        }
        if self.events.receiver_count() == 0 {
            return;
        }
        let relevant = matches!(
            event,
            ArmadaEvent::AgentUpdated { .. }
                | ArmadaEvent::AgentRemoved { .. }
                | ArmadaEvent::ItemUpserted { .. }
                | ArmadaEvent::TextDelta { .. }
                | ArmadaEvent::Attention { .. }
                // Owner-only (viewers only get events about their agent).
                | ArmadaEvent::AccountUpdated { .. }
                | ArmadaEvent::AccountRemoved { .. }
        );
        if relevant {
            if let Ok(json) = serde_json::to_string(event) {
                let agent_id = match event {
                    ArmadaEvent::AgentUpdated { agent } => Some(agent.id.clone()),
                    ArmadaEvent::AgentRemoved { agent_id }
                    | ArmadaEvent::TextDelta { agent_id, .. }
                    | ArmadaEvent::Attention { agent_id, .. } => Some(agent_id.clone()),
                    ArmadaEvent::ItemUpserted { item } => Some(item.agent_id.clone()),
                    _ => None,
                };
                let kind = match event {
                    ArmadaEvent::AgentUpdated { .. } => PublishedKind::AgentUpdated,
                    ArmadaEvent::AgentRemoved { .. } => PublishedKind::AgentRemoved,
                    _ => PublishedKind::Other,
                };
                let _ = self.events.send(Arc::new(Published {
                    agent_id,
                    kind,
                    json,
                }));
            }
        }
    }

    fn core(&self) -> Core {
        self.core.clone()
    }

    fn idem_begin(&self, key: &str) -> IdemBegin {
        let mut map = self.idempotency.lock();
        map.retain(|_, (at, _)| at.elapsed() < IDEMPOTENCY_TTL);
        match map.get(key) {
            Some((_, None)) => IdemBegin::InFlight,
            Some((_, Some((status, body)))) => IdemBegin::Done(*status, body.clone()),
            None => {
                map.insert(key.to_string(), (Instant::now(), None));
                IdemBegin::New
            }
        }
    }

    /// Records the outcome: successes are replayed, failures may be retried.
    fn idem_finish(&self, key: &str, result: Option<IdemResult>) {
        let mut map = self.idempotency.lock();
        match result {
            Some(done) => {
                map.insert(key.to_string(), (Instant::now(), Some(done)));
            }
            None => {
                map.remove(key);
            }
        }
    }

    fn base_url(&self) -> Option<String> {
        let running = self.running.lock();
        let r = running.as_ref()?;
        Some(format!("http://{}", r.addr))
    }

    pub fn status(&self) -> RemoteStatus {
        let settings = self.core().settings().map(|s| s.remote).unwrap_or_default();
        let base = self.base_url();
        let running = self.running.lock().is_some();
        let tokens = self.tokens.lock();
        let pairing_url = base
            .as_ref()
            .filter(|_| !tokens.owner.is_empty())
            .map(|b| format!("{b}/#token={}", tokens.owner));
        let qr_svg = pairing_url.as_deref().and_then(|u| {
            qrcode::QrCode::new(u.as_bytes()).ok().map(|code| {
                code.render::<qrcode::render::svg::Color<'_>>()
                    .min_dimensions(220, 220)
                    .quiet_zone(true)
                    .dark_color(qrcode::render::svg::Color("#0B0D10"))
                    .light_color(qrcode::render::svg::Color("#FFFFFF"))
                    .build()
            })
        });
        let core = self.core();
        let shares = tokens
            .shares
            .iter()
            .map(|s| ShareLink {
                token: s.token.clone(),
                agent_id: s.agent_id.clone(),
                agent_title: core.agent(&s.agent_id).ok().map(|a| a.title),
                url: base.as_ref().map(|b| format!("{b}/#token={}", s.token)),
                created_at: s.created_at,
            })
            .collect();
        RemoteStatus {
            enabled: settings.enabled,
            running,
            lan: settings.lan,
            port: settings.port,
            url: base,
            pairing_url,
            qr_svg,
            error: self
                .error
                .lock()
                .clone()
                .or_else(|| self.tokens_problem.lock().clone()),
            shares,
        }
    }

    /// Unpairs every device by issuing a new owner token.
    pub fn rotate_owner_token(&self) {
        self.tokens.lock().owner = new_token();
        // An explicit unpair replaces even an unreadable file.
        self.persist
            .store(true, std::sync::atomic::Ordering::SeqCst);
        *self.tokens_problem.lock() = None;
        self.save_tokens();
        self.bump_generation();
    }

    pub fn create_share(&self, agent_id: &str) -> anyhow::Result<ShareLink> {
        let agent = self.core().agent(agent_id)?;
        let share = Share {
            token: new_token(),
            agent_id: agent_id.to_string(),
            created_at: now_ms(),
        };
        self.tokens.lock().shares.push(share.clone());
        self.save_tokens();
        Ok(ShareLink {
            url: self
                .base_url()
                .map(|b| format!("{b}/#token={}", share.token)),
            token: share.token,
            agent_id: share.agent_id,
            agent_title: Some(agent.title),
            created_at: share.created_at,
        })
    }

    pub fn revoke_share(&self, token: &str) {
        self.tokens.lock().shares.retain(|s| s.token != token);
        self.save_tokens();
        self.bump_generation();
    }

    /// Starts, restarts or stops the server to match `settings`. Does nothing once the
    /// app is shutting down.
    pub async fn apply(self: &Arc<Self>, settings: &RemoteSettings) {
        let _serialized = self.apply_lock.lock().await;
        if self.is_shutting_down() {
            return;
        }
        let unchanged =
            self.running.lock().as_ref().is_some_and(|r| {
                r.settings.lan == settings.lan && r.settings.port == settings.port
            });
        if settings.enabled && unchanged {
            return;
        }
        let was_running = self.stop_and_wait().await;
        if !settings.enabled {
            *self.error.lock() = None;
            return;
        }
        self.start_reporting(settings, was_running).await;
    }

    /// Starts and records the outcome in `error`.
    async fn start_reporting(self: &Arc<Self>, settings: &RemoteSettings, was_running: bool) {
        // Only right after stopping our own server can the port still be in use by
        // it; otherwise "in use" means another program and retrying won't help.
        match self.start(settings, was_running).await {
            Ok(addr) => {
                info!(%addr, "remote server listening");
                *self.error.lock() = None;
            }
            Err(msg) => {
                warn!("{msg}");
                *self.error.lock() = Some(msg);
            }
        }
    }

    fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// At app exit: stops the server and keeps it stopped.
    pub async fn shutdown(&self) {
        self.shutting_down
            .store(true, std::sync::atomic::Ordering::SeqCst);
        // Waits for an in-flight `apply` (e.g. the startup one) to finish first.
        let _serialized = self.apply_lock.lock().await;
        self.stop_and_wait().await;
    }

    /// The LAN address can change (new Wi-Fi, DHCP); when it did, listen on the new
    /// one so the shown URL/QR code works. Called when the UI reads the status.
    pub async fn refresh_lan(self: &Arc<Self>) {
        let settings = match self.running.lock().as_ref() {
            Some(r) if r.settings.lan && lan_ip() != Some(r.addr.ip()) => r.settings.clone(),
            _ => return,
        };
        let _serialized = self.apply_lock.lock().await;
        if self.is_shutting_down() {
            return;
        }
        // Re-check under the lock: another apply may have handled it.
        let still_stale = self
            .running
            .lock()
            .as_ref()
            .is_some_and(|r| r.settings.lan && lan_ip() != Some(r.addr.ip()));
        if !still_stale {
            return;
        }
        info!("LAN address changed; restarting the remote server");
        let was_running = self.stop_and_wait().await;
        self.start_reporting(&settings, was_running).await;
    }

    async fn start(
        self: &Arc<Self>,
        settings: &RemoteSettings,
        retry_in_use: bool,
    ) -> Result<SocketAddr, String> {
        if self.tokens.lock().owner.is_empty() {
            return Err(self.tokens_problem.lock().clone().unwrap_or_else(|| {
                "Remote pairing data is unavailable; unpair devices to reset it.".into()
            }));
        }
        if settings.port < MIN_PORT {
            return Err(format!("Choose a port between {MIN_PORT} and 65535"));
        }
        let ip = if settings.lan {
            lan_ip().ok_or_else(|| {
                "No network connection found for LAN access. Connect to a network, or turn LAN access off.".to_string()
            })?
        } else {
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        };
        let addr = SocketAddr::new(ip, settings.port);
        // The previous listener may take a moment to release the port.
        let mut attempt = 0;
        let listener = loop {
            match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => break l,
                Err(e)
                    if retry_in_use
                        && e.kind() == std::io::ErrorKind::AddrInUse
                        && attempt < 10 =>
                {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                Err(e) => return Err(format!("Couldn't listen on {addr}: {e}")),
            }
        };
        let addr = listener.local_addr().unwrap_or(addr);
        let epoch = {
            let mut e = self.epoch.lock();
            *e += 1;
            *e
        };
        let (tx, rx) = oneshot::channel::<()>();
        let router = self.router(epoch);
        let task = tauri::async_runtime::spawn(serve(listener, router, rx));
        *self.running.lock() = Some(Running {
            addr,
            epoch,
            settings: settings.clone(),
            shutdown: Some(tx),
            task: Some(task),
        });
        self.bump_generation();
        Ok(addr)
    }

    /// Signals the server to stop and ends its live event streams.
    pub fn stop(&self) -> Option<tauri::async_runtime::JoinHandle<()>> {
        let mut running = self.running.lock().take()?;
        if let Some(tx) = running.shutdown.take() {
            let _ = tx.send(());
        }
        self.bump_generation();
        info!("remote server stopped");
        running.task.take()
    }

    /// Stops the server if it runs; returns whether it did.
    async fn stop_and_wait(&self) -> bool {
        let Some(task) = self.stop() else {
            return false;
        };
        // Streams end via the generation bump, so this is normally quick.
        if tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .is_err()
        {
            warn!("remote server took too long to stop");
        }
        true
    }

    fn current_epoch(&self) -> Option<u64> {
        self.running.lock().as_ref().map(|r| r.epoch)
    }

    fn router(self: &Arc<Self>, epoch: u64) -> Router {
        let ctx = Ctx {
            remote: self.clone(),
            epoch,
        };
        let api = Router::new()
            .route("/api/session", get(session))
            .route("/api/state", get(state))
            .route("/api/agents/{id}/items", get(items))
            .route("/api/agents/{id}/permission", post(permission))
            .route("/api/agents/{id}/cancel", post(cancel))
            .route("/api/agents/{id}/resume", post(resume))
            .route("/api/agents/{id}/stop", post(stop))
            .route("/api/agents/{id}/config", post(config))
            .route("/api/agents/{id}/account", post(switch_account))
            .route("/api/agents/{id}/archive", post(archive))
            .route("/api/agents/{id}/read", post(mark_read))
            .route("/api/agents/{id}/queue/{qid}", delete(remove_queued))
            .route("/api/agents/{id}/queue/{qid}/send", post(send_queued_now))
            .route("/api/agents/{id}/queue/resume", post(resume_queue))
            .route("/api/agents/{id}/queue", delete(clear_queue))
            .route("/api/agents/{id}/diff", get(diff_summary))
            .route("/api/agents/{id}/commit", post(commit))
            .route("/api/agents/{id}/ship", post(ship))
            .route("/api/agents/{id}/image", get(image))
            .route("/api/permissions", get(permissions))
            .route("/api/events", get(events))
            .layer(DefaultBodyLimit::max(256 * 1024))
            // Prompts may carry photos/screenshots from the phone.
            .merge(
                Router::new()
                    .route("/api/agents", post(create_agent))
                    .route("/api/agents/{id}/prompt", post(prompt))
                    .layer(DefaultBodyLimit::max(MAX_REMOTE_UPLOAD)),
            )
            // Authenticate before any body is read.
            .route_layer(axum::middleware::from_fn_with_state(ctx.clone(), guard));
        Router::new()
            .route("/", get(index))
            .route("/index.html", get(index))
            .route("/manifest.webmanifest", get(manifest))
            .route("/icon.png", get(icon))
            .route("/icon-192.png", get(icon_192))
            .route("/icon-512.png", get(icon_512))
            .merge(api)
            .layer(axum::middleware::map_response(no_store))
            .with_state(ctx)
    }

    /// Which credentials a token grants, without touching the failure counters.
    fn token_scope(&self, token: &str) -> Option<Scope> {
        if token.is_empty() {
            return None;
        }
        let tokens = self.tokens.lock();
        if constant_time_eq(token, &tokens.owner) {
            return Some(Scope::Owner);
        }
        tokens
            .shares
            .iter()
            .find(|s| constant_time_eq(token, &s.token))
            .map(|s| Scope::Viewer(s.agent_id.clone()))
    }

    /// Request checks shared by every API route: host, cross-site, token, rate limit.
    fn authorize(
        &self,
        epoch: u64,
        ip: IpAddr,
        headers: &HeaderMap,
    ) -> Result<(Scope, String), ApiError> {
        self.check_origin(epoch, headers)?;
        let token = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or("")
            .trim()
            .to_string();
        // A valid token is never rate limited (so others can't lock the owner out).
        if let Some(scope) = self.token_scope(&token) {
            return Ok((scope, token));
        }
        let mut failures = self.failures.lock();
        if failures.len() > 4096 {
            failures.retain(|_, (_, last)| last.elapsed() < LOCKOUT);
        }
        let entry = failures.entry(ip).or_insert((0, Instant::now()));
        if entry.1.elapsed() > LOCKOUT {
            *entry = (0, Instant::now());
        }
        if entry.0 >= MAX_FAILURES {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many failed attempts. Try again in a few minutes.".into(),
            ));
        }
        entry.0 += 1;
        entry.1 = Instant::now();
        Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "This device isn't paired with Armada (or was unpaired).".into(),
        ))
    }

    /// Rejects DNS-rebinding (unexpected Host) and cross-site browser requests.
    fn check_origin(&self, epoch: u64, headers: &HeaderMap) -> Result<(), ApiError> {
        if headers
            .get("sec-fetch-site")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v == "cross-site")
        {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "Cross-site requests aren't allowed.".into(),
            ));
        }
        let port = match self.running.lock().as_ref() {
            Some(r) if r.epoch == epoch => r.addr.port(),
            _ => {
                return Err(ApiError(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Remote access was turned off.".into(),
                ))
            }
        };
        let addr = self.running.lock().as_ref().map(|r| r.addr.ip());
        let host = headers
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let allowed = [
            format!("127.0.0.1:{port}"),
            format!("localhost:{port}"),
            format!("[::1]:{port}"),
        ];
        let lan = addr.map(|ip| SocketAddr::new(ip, port).to_string());
        let ok = allowed.iter().any(|a| a.eq_ignore_ascii_case(host))
            || lan.as_deref().is_some_and(|l| l == host);
        if ok {
            Ok(())
        } else {
            Err(ApiError(
                StatusCode::MISDIRECTED_REQUEST,
                "Unexpected host.".into(),
            ))
        }
    }
}

struct LoadedTokens {
    tokens: Tokens,
    /// Needs writing (new or repaired).
    dirty: bool,
    /// Safe to write the file.
    persist: bool,
    problem: Option<String>,
}

/// Reads the pairing tokens. Only a missing file means "first run, new owner token":
/// a damaged file is kept as a backup and reported (re-pairing is unavoidable), and an
/// unreadable one is left alone, with remote access unavailable until it's fixed or
/// the user unpairs, rather than silently unpairing every device.
fn load_tokens(path: &std::path::Path) -> LoadedTokens {
    let fresh = || Tokens {
        owner: new_token(),
        shares: Vec::new(),
    };
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return LoadedTokens {
                tokens: fresh(),
                dirty: true,
                persist: true,
                problem: None,
            }
        }
        Err(e) => {
            return LoadedTokens {
                tokens: Tokens::default(),
                dirty: false,
                persist: false,
                problem: Some(format!(
                    "Couldn't read remote pairing data ({}): {e}. Remote access stays off until the file is readable again, or unpair devices to reset it.",
                    path.display()
                )),
            }
        }
    };
    match serde_json::from_slice::<Tokens>(&bytes) {
        Ok(tokens) if tokens.owner.len() >= 32 => LoadedTokens {
            tokens,
            // Rewrite anyway so older files get owner-only permissions.
            dirty: true,
            persist: true,
            problem: None,
        },
        parsed => {
            let backup = path.with_extension(format!("json.damaged-{}", now_ms()));
            let kept = std::fs::copy(path, &backup).is_ok();
            let mut tokens = fresh();
            if let Ok(old) = parsed {
                tokens.shares = old.shares;
            }
            LoadedTokens {
                tokens,
                dirty: true,
                persist: true,
                problem: Some(format!(
                    "Remote pairing data was damaged and has been reset: pair your devices again.{}",
                    if kept {
                        format!(" (The old file was kept as {}.)", backup.display())
                    } else {
                        String::new()
                    }
                )),
            }
        }
    }
}

/// Writes `data` to `path` atomically, readable by the owner only: a crash mid-write
/// leaves the old file intact.
fn write_private_atomic(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        // Per-user app data dirs on Windows/macOS aren't readable by other users.
        let mut f = options.open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Accept loop for the remote server: at most `MAX_CONNECTIONS` at once, request
/// headers within `HEADER_READ_TIMEOUT`. On shutdown, stops accepting and lets open
/// connections finish (live streams end via the generation bump).
async fn serve(
    listener: tokio::net::TcpListener,
    router: Router,
    mut shutdown: oneshot::Receiver<()>,
) {
    use tower::ServiceExt;

    let permits = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
    let (closing_tx, closing_rx) = watch::channel(false);
    let mut connections = tokio::task::JoinSet::new();
    loop {
        let permit = tokio::select! {
            _ = &mut shutdown => break,
            permit = permits.clone().acquire_owned() => match permit {
                Ok(p) => p,
                Err(_) => break,
            },
        };
        let (stream, peer) = tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => match accepted {
                Ok(conn) => conn,
                Err(e) => {
                    // e.g. too many open files: back off instead of spinning.
                    warn!("remote server accept failed: {e}");
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    continue;
                }
            },
        };
        let router = router.clone();
        let mut closing = closing_rx.clone();
        connections.spawn(async move {
            let _permit = permit;
            let service = hyper::service::service_fn(
                move |mut req: axum::extract::Request<hyper::body::Incoming>| {
                    req.extensions_mut().insert(ConnectInfo(peer));
                    router.clone().oneshot(req)
                },
            );
            let conn = hyper::server::conn::http1::Builder::new()
                .timer(hyper_util::rt::TokioTimer::new())
                .header_read_timeout(HEADER_READ_TIMEOUT)
                .serve_connection(hyper_util::rt::TokioIo::new(stream), service);
            tokio::pin!(conn);
            tokio::select! {
                _ = conn.as_mut() => {}
                () = async {
                    // The returned guard must not live across the await below.
                    let _ = closing.wait_for(|c| *c).await;
                } => {
                    conn.as_mut().graceful_shutdown();
                    let _ = conn.await;
                }
            }
        });
        while connections.try_join_next().is_some() {}
    }
    drop(listener);
    let _ = closing_tx.send(true);
    while connections.join_next().await.is_some() {}
}

// ---- HTTP plumbing ------------------------------------------------------------------

#[derive(Debug)]
struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        let msg = format!("{e:#}");
        let status = if msg.contains("not found") {
            StatusCode::NOT_FOUND
        } else if msg.contains("no longer pending") || msg.contains("isn't running anymore") {
            StatusCode::CONFLICT
        } else {
            StatusCode::BAD_REQUEST
        };
        ApiError(status, msg)
    }
}

async fn no_store(mut res: Response) -> Response {
    let h = res.headers_mut();
    if !h.contains_key(header::CACHE_CONTROL) {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    res
}

/// Every API request: check the token (and Host/origin) before reading the body,
/// then read the body within `BODY_READ_TIMEOUT`.
async fn guard(
    State(c): State<Ctx>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let Some(ConnectInfo(peer)) = req.extensions().get::<ConnectInfo<SocketAddr>>().cloned() else {
        return ApiError(StatusCode::BAD_REQUEST, "No peer address".into()).into_response();
    };
    if let Err(e) = c.auth(&peer, req.headers()) {
        return e.into_response();
    }
    let (parts, body) = req.into_parts();
    let bytes = match tokio::time::timeout(
        BODY_READ_TIMEOUT,
        axum::body::to_bytes(body, MAX_REMOTE_UPLOAD),
    )
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => {
            return ApiError(
                StatusCode::PAYLOAD_TOO_LARGE,
                "That request is too large.".into(),
            )
            .into_response()
        }
        Err(_) => {
            return ApiError(
                StatusCode::REQUEST_TIMEOUT,
                "The upload took too long.".into(),
            )
            .into_response()
        }
    };
    next.run(axum::extract::Request::from_parts(
        parts,
        axum::body::Body::from(bytes),
    ))
    .await
}

#[derive(Clone)]
struct Ctx {
    remote: Arc<Remote>,
    epoch: u64,
}

impl Ctx {
    fn auth(&self, peer: &SocketAddr, headers: &HeaderMap) -> Result<Scope, ApiError> {
        self.remote
            .authorize(self.epoch, peer.ip(), headers)
            .map(|(s, _)| s)
    }
}

type Peer = ConnectInfo<SocketAddr>;

fn owner(scope: &Scope) -> Result<(), ApiError> {
    match scope {
        Scope::Owner => Ok(()),
        Scope::Viewer(_) => Err(ApiError(
            StatusCode::FORBIDDEN,
            "This is a read-only link.".into(),
        )),
    }
}

fn visible(scope: &Scope, agent_id: &str) -> Result<(), ApiError> {
    if scope.can_see(agent_id) {
        Ok(())
    } else {
        Err(ApiError(StatusCode::NOT_FOUND, "Agent not found".into()))
    }
}

/// The phone app's ETag: it changes only with a new Armada build.
fn index_etag() -> &'static str {
    static ETAG: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ETAG.get_or_init(|| {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        REMOTE_HTML.hash(&mut h);
        format!("\"{:016x}\"", h.finish())
    })
}

async fn index(headers: HeaderMap) -> Response {
    let etag = index_etag();
    // Revalidated on every launch (cheap 304), so updates show up right away.
    let cache = [
        (header::ETAG, HeaderValue::from_static(etag)),
        (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
    ];
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag))
    {
        return (StatusCode::NOT_MODIFIED, cache).into_response();
    }
    let mut res = (
        cache,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        REMOTE_HTML,
    )
        .into_response();
    let h = res.headers_mut();
    // The single-file build inlines its script and styles.
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; \
             img-src 'self' data:; connect-src 'self'; manifest-src 'self'; \
             base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    res
}

async fn manifest() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/manifest+json")],
        Json(json!({
            "name": "Armada",
            "short_name": "Armada",
            "start_url": "/",
            "display": "standalone",
            "background_color": "#0B0D10",
            "theme_color": "#0B0D10",
            "icons": [
                { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
                { "src": "/icon.png", "sizes": "256x256", "type": "image/png" },
                { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" }
            ]
        })),
    )
}

async fn icon() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "image/png")], ICON_PNG)
}

async fn icon_192() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "image/png")], ICON_192)
}

async fn icon_512() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "image/png")], ICON_512)
}

async fn session(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let scope = c.auth(&peer, &headers)?;
    let (name, agent_id) = match &scope {
        Scope::Owner => ("owner", None),
        Scope::Viewer(id) => ("viewer", Some(id.clone())),
    };
    Ok(Json(json!({
        "scope": name,
        "agentId": agent_id,
        "version": c.remote.version,
    })))
}

async fn state(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let scope = c.auth(&peer, &headers)?;
    let core = c.remote.core();
    let visible: Vec<Agent> = core
        .agents()?
        .into_iter()
        .filter(|a| scope.can_see(&a.id))
        .collect();
    let used_custom: Vec<String> = visible
        .iter()
        .filter_map(|a| a.custom_agent_id.clone())
        .collect();
    let agents: Vec<Value> = visible
        .into_iter()
        .map(|a: Agent| {
            let mut v = serde_json::to_value(a).unwrap_or_default();
            if scope != Scope::Owner {
                trim_agent(&mut v);
            }
            v
        })
        .collect();
    let accounts: Vec<Value> = if scope == Scope::Owner {
        core.accounts()?
            .into_iter()
            .map(|a| {
                json!({
                    "id": a.id,
                    "name": a.name,
                    "provider": a.provider,
                    "color": a.color,
                    "label": a.status.as_ref().and_then(|s| s.label.clone()),
                    "loggedIn": a.status.as_ref().map(|s| s.logged_in),
                    "error": a.status.and_then(|s| s.error),
                })
            })
            .collect()
    } else {
        Vec::new()
    };
    // Names/colors of custom ACP agents so their chips render (no commands or env).
    let custom_agents: Vec<Value> = core
        .settings()
        .map(|s| s.custom_agents)
        .unwrap_or_default()
        .into_iter()
        .filter(|c| scope == Scope::Owner || used_custom.contains(&c.id))
        .map(|c| json!({ "id": c.id, "name": c.name, "color": c.color, "enabled": c.enabled }))
        .collect();
    // What the phone needs to start new agents: recent folders and prompt templates.
    let (projects, templates, default_worktree, default_mode) = if scope == Scope::Owner {
        let settings = core.settings()?;
        let mut projects = settings.recent_projects.clone();
        for a in core.agents()? {
            if !a.archived && !projects.contains(&a.project_path) {
                projects.push(a.project_path);
            }
        }
        projects.retain(|p| std::path::Path::new(p).is_dir());
        let templates: Vec<Value> = settings
            .templates
            .iter()
            .map(|t| json!({ "id": t.id, "name": t.name, "text": t.body }))
            .collect();
        (
            projects,
            templates,
            settings.default_worktree,
            settings.default_permission_mode.clone(),
        )
    } else {
        (Vec::new(), Vec::new(), false, String::new())
    };
    Ok(Json(json!({
        "agents": agents,
        "accounts": accounts,
        "customAgents": custom_agents,
        "projects": projects,
        "templates": templates,
        "defaultWorktree": default_worktree,
        "defaultPermissionMode": default_mode,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemsQuery {
    before_seq: Option<i64>,
    limit: Option<usize>,
}

/// An agent's timeline; with `limit`, the last `limit` items before `beforeSeq`
/// (oldest first), so the phone can load the tail first and page back.
async fn items(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<ItemsQuery>,
) -> Result<Response, ApiError> {
    let scope = c.auth(&peer, &headers)?;
    visible(&scope, &id)?;
    let core = c.remote.core();
    core.agent(&id)?;
    let items = tokio::task::spawn_blocking(move || match q.limit {
        Some(limit) => core.items_page(&id, q.before_seq, limit.clamp(1, 1000)),
        None => core.items(&id),
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))??;
    Ok(Json(items).into_response())
}

#[derive(Deserialize)]
struct PromptBody {
    text: String,
    #[serde(default)]
    attachments: Vec<Attachment>,
}

/// The request's Idempotency-Key, scoped to its route.
fn idem_key(headers: &HeaderMap, route: &str) -> Option<String> {
    let key = headers.get("idempotency-key")?.to_str().ok()?.trim();
    (!key.is_empty() && key.len() <= 128).then(|| format!("{route}:{key}"))
}

/// Runs `work` at most once per Idempotency-Key; a retry gets the first result.
async fn once<F>(remote: &Remote, key: Option<String>, work: F) -> Result<Response, ApiError>
where
    F: std::future::Future<Output = Result<(StatusCode, String), ApiError>>,
{
    let Some(key) = key else {
        return work.await.map(json_response);
    };
    match remote.idem_begin(&key) {
        IdemBegin::Done(status, body) => return Ok(json_response((status, body))),
        IdemBegin::InFlight => {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "That request is still being processed.".into(),
            ))
        }
        IdemBegin::New => {}
    }
    let result = work.await;
    remote.idem_finish(&key, result.as_ref().ok().cloned());
    result.map(json_response)
}

fn json_response((status, body): (StatusCode, String)) -> Response {
    if body.is_empty() {
        return status.into_response();
    }
    (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
}

fn check_images(attachments: &[Attachment]) -> Result<(), ApiError> {
    if attachments.len() > MAX_REMOTE_IMAGES {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("Attach at most {MAX_REMOTE_IMAGES} images"),
        ));
    }
    if attachments
        .iter()
        .any(|a| !a.mime_type.starts_with("image/"))
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Only images can be attached".into(),
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBody {
    provider: Provider,
    account_id: String,
    project_path: String,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    worktree: Option<bool>,
    #[serde(default)]
    custom_agent_id: Option<String>,
    #[serde(default)]
    model: Option<String>,
    /// "auto" or "ask"; omitted uses the settings default.
    #[serde(default)]
    permission_mode: Option<String>,
    #[serde(default)]
    attachments: Vec<Attachment>,
}

/// Starts a new agent (any provider: Claude, Codex, Grok or a custom ACP agent).
async fn create_agent(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Json(body): Json<CreateBody>,
) -> Result<Response, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    check_images(&body.attachments)?;
    let core = c.remote.core();
    let key = idem_key(&headers, "create");
    once(&c.remote, key, async move {
        let worktree = match body.worktree {
            Some(w) => w,
            None => core.settings()?.default_worktree,
        };
        let project = body.project_path.clone();
        let agent = core
            .create_agent(CreateAgentRequest {
                provider: body.provider,
                account_id: body.account_id,
                project_path: body.project_path,
                prompt: body.prompt,
                title: body.title,
                worktree,
                model: body.model.filter(|m| !m.trim().is_empty()),
                group_id: None,
                custom_agent_id: body.custom_agent_id,
                permission_mode: body.permission_mode,
                attachments: body.attachments,
            })
            .await?;
        if let Err(e) = crate::commands::remember_project(&core, &project) {
            warn!("could not update recent projects: {e:#}");
        }
        let json = serde_json::to_string(&agent)
            .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        Ok((StatusCode::OK, json))
    })
    .await
}

async fn prompt(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<PromptBody>,
) -> Result<Response, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    check_images(&body.attachments)?;
    let core = c.remote.core();
    let key = idem_key(&headers, &format!("prompt:{id}"));
    once(&c.remote, key, async move {
        core.send_prompt(&id, &body.text, body.attachments).await?;
        Ok((StatusCode::NO_CONTENT, String::new()))
    })
    .await
}

/// Pending approvals across the agents this token can see (so the phone's inbox
/// doesn't need whole timelines).
async fn permissions(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
) -> Result<Json<Vec<armada_core::TimelineItem>>, ApiError> {
    let scope = c.auth(&peer, &headers)?;
    let core = c.remote.core();
    let pending = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let mut out = Vec::new();
        for agent in core.agents()? {
            if agent.pending_permissions == 0 || !scope.can_see(&agent.id) {
                continue;
            }
            out.extend(core.items(&agent.id)?.into_iter().filter(|i| {
                matches!(
                    i.body,
                    armada_core::ItemBody::Permission {
                        resolution: None,
                        ..
                    }
                )
            }));
        }
        Ok(out)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))??;
    Ok(Json(pending))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionBody {
    request_id: String,
    option_id: String,
}

async fn permission(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<PermissionBody>,
) -> Result<StatusCode, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    c.remote
        .core()
        .respond_permission(&id, &body.request_id, &body.option_id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn cancel(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    c.remote.core().cancel_turn(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn resume(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    let core = c.remote.core();
    let interrupted = core.agent(&id)?.status == armada_core::AgentStatus::Interrupted;
    // Starting an agent can take a while; answer now; progress and failures reach the
    // phone as agent updates and notices.
    tauri::async_runtime::spawn(async move {
        if let Err(e) = core.resume_agent(&id, interrupted).await {
            warn!(agent = %id, "remote resume failed: {e:#}");
        }
    });
    Ok(StatusCode::ACCEPTED)
}

async fn stop(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    c.remote.core().stop_agent(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigBody {
    option_id: String,
    value: String,
}

/// Mode / model / reasoning effort — whatever options the agent advertises.
async fn config(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ConfigBody>,
) -> Result<StatusCode, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    c.remote
        .core()
        .set_agent_config(&id, &body.option_id, &body.value)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountBody {
    account_id: String,
}

async fn switch_account(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<AccountBody>,
) -> Result<Json<Agent>, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    Ok(Json(
        c.remote
            .core()
            .switch_account(&id, &body.account_id)
            .await?,
    ))
}

#[derive(Deserialize)]
struct ArchiveBody {
    archived: bool,
}

async fn archive(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ArchiveBody>,
) -> Result<StatusCode, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    c.remote.core().archive_agent(&id, body.archived)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Patch text sent to the phone at most (the file list is always complete).
const MAX_REMOTE_PATCH: usize = 1024 * 1024;

/// What changed: file list, counts, and the patch (capped) for reviewing on the phone.
async fn diff_summary(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    let agent = c.remote.core().agent(&id)?;
    let diff = crate::git_review::get_diff(&agent).await?;
    let mut patch = diff.patch;
    let truncated = patch.len() > MAX_REMOTE_PATCH;
    if truncated {
        let mut cut = MAX_REMOTE_PATCH;
        while !patch.is_char_boundary(cut) {
            cut -= 1;
        }
        patch.truncate(cut);
    }
    Ok(Json(json!({
        "files": diff.files,
        "ahead": diff.ahead,
        "uncommitted": diff.uncommitted,
        "patch": patch,
        "truncated": truncated,
        "worktree": agent.worktree,
        "branch": agent.branch,
        "baseBranch": agent.base_branch,
    })))
}

#[derive(Deserialize)]
struct MessageBody {
    #[serde(default)]
    message: String,
}

async fn commit(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<MessageBody>,
) -> Result<Json<Value>, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    let result = crate::commands::commit_impl(&c.remote.core(), &id, &body.message).await?;
    Ok(Json(json!({ "result": result })))
}

/// "Commit & merge" from the phone.
async fn ship(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<MessageBody>,
) -> Result<Json<Value>, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    let result = crate::commands::ship_impl(&c.remote.core(), &id, &body.message).await?;
    Ok(Json(serde_json::to_value(result).unwrap_or_default()))
}

#[derive(Deserialize)]
struct ImageQuery {
    path: String,
}

/// An image the agent referenced by path (screenshots), with the same sandbox as
/// the desktop app (project/worktree and temp folders, image types, size cap).
async fn image(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<ImageQuery>,
) -> Result<Json<Attachment>, ApiError> {
    // Viewers too: screenshots are part of the agent's conversation they follow.
    visible(&c.auth(&peer, &headers)?, &id)?;
    let core = c.remote.core();
    let image = tokio::task::spawn_blocking(move || core.read_image(&id, &q.path))
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))??;
    Ok(Json(image))
}

async fn mark_read(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    c.remote.core().mark_read(&id)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Drops a queued message; returns it so the phone can put it back in the composer.
async fn remove_queued(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path((id, qid)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    let removed = c.remote.core().remove_queued(&id, &qid)?;
    Ok(Json(json!({
        "text": removed.as_ref().map(|r| &r.text),
        "attachments": removed.map(|r| r.attachments).unwrap_or_default(),
    })))
}

async fn send_queued_now(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path((id, qid)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    c.remote.core().send_queued_now(&id, &qid).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn resume_queue(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    c.remote.core().resume_queue(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn clear_queue(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    let removed = c.remote.core().clear_queue(&id)?;
    Ok(Json(json!({ "removed": removed })))
}

/// Which agent an event is about (None = not forwarded).
/// A serialized event, tagged so streams can filter without parsing it.
struct Published {
    /// The agent it's about; None for owner-only events (accounts).
    agent_id: Option<String>,
    kind: PublishedKind,
    json: String,
}

#[derive(PartialEq)]
enum PublishedKind {
    AgentUpdated,
    AgentRemoved,
    Other,
}

#[cfg(test)]
fn event_agent(json: &Value) -> Option<&str> {
    json["agent"]["id"]
        .as_str()
        .or_else(|| json["agentId"].as_str())
        .or_else(|| json["item"]["agentId"].as_str())
}

/// One counted event stream for a token; released on drop.
struct StreamSlot {
    streams: Arc<Mutex<HashMap<String, usize>>>,
    token: String,
}

impl StreamSlot {
    fn take(
        streams: &Arc<Mutex<HashMap<String, usize>>>,
        token: &str,
        scope: &Scope,
    ) -> Option<StreamSlot> {
        let max = match scope {
            Scope::Owner => MAX_OWNER_STREAMS,
            Scope::Viewer(_) => MAX_VIEWER_STREAMS,
        };
        let mut map = streams.lock();
        let n = map.entry(token.to_string()).or_insert(0);
        if *n >= max {
            return None;
        }
        *n += 1;
        Some(StreamSlot {
            streams: streams.clone(),
            token: token.to_string(),
        })
    }
}

impl Drop for StreamSlot {
    fn drop(&mut self) {
        let mut map = self.streams.lock();
        if let Some(n) = map.get_mut(&self.token) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                map.remove(&self.token);
            }
        }
    }
}

/// Per-connection state of a live event stream.
struct Stream_ {
    _slot: StreamSlot,
    deadline: tokio::time::Instant,
    rx: broadcast::Receiver<Arc<Published>>,
    generation: watch::Receiver<u64>,
    remote: Arc<Remote>,
    epoch: u64,
    token: String,
    scope: Scope,
}

impl Stream_ {
    /// Still allowed to receive events: same server run, token still valid.
    fn still_valid(&self) -> bool {
        self.remote.current_epoch() == Some(self.epoch)
            && self.remote.token_scope(&self.token).as_ref() == Some(&self.scope)
    }

    /// The next message for this client, or None when the stream must end.
    async fn next(&mut self) -> Option<String> {
        loop {
            tokio::select! {
                () = tokio::time::sleep_until(self.deadline) => return None,
                changed = self.generation.changed() => {
                    if changed.is_err() || !self.still_valid() {
                        return None;
                    }
                }
                msg = self.rx.recv() => match msg {
                    Ok(event) => {
                        let Scope::Viewer(id) = &self.scope else {
                            return Some(event.json.clone());
                        };
                        if event.agent_id.as_deref() != Some(id.as_str()) {
                            continue;
                        }
                        match event.kind {
                            PublishedKind::AgentRemoved => return None,
                            PublishedKind::AgentUpdated => {
                                let mut v: Value =
                                    serde_json::from_str(&event.json).unwrap_or_default();
                                trim_agent(&mut v["agent"]);
                                return Some(v.to_string());
                            }
                            PublishedKind::Other => return Some(event.json.clone()),
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        return Some(r#"{"type":"resync"}"#.to_string());
                    }
                    Err(broadcast::error::RecvError::Closed) => return None,
                },
            }
        }
    }
}

async fn events(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    // Subscribe before authorizing: a revoke that lands in between bumps the
    // generation after this point, so the stream re-checks and ends.
    let mut generation = c.remote.generation.subscribe();
    generation.mark_unchanged();
    let rx = c.remote.events.subscribe();
    let (scope, token) = c.remote.authorize(c.epoch, peer.ip(), &headers)?;
    let slot = StreamSlot::take(&c.remote.streams, &token, &scope).ok_or_else(|| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many open connections for this device or link.".into(),
        )
    })?;
    let state = Stream_ {
        _slot: slot,
        deadline: tokio::time::Instant::now() + STREAM_LIFETIME,
        rx,
        generation,
        remote: c.remote.clone(),
        epoch: c.epoch,
        token,
        scope,
    };
    let stream = futures_util::stream::unfold(state, |mut s| async move {
        let msg = s.next().await?;
        Some((Ok(Event::default().data(msg)), s))
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(20))))
}

#[cfg(test)]
// The end-to-end test (and its helpers) needs Unix mock agents.
#[cfg_attr(not(unix), allow(dead_code, unused_imports))]
mod tests {
    use super::*;
    use armada_core::{CreateAgentRequest, EventSink, ItemBody, Provider};
    use std::io::BufRead;

    #[test]
    fn tokens_and_scopes() {
        let a = new_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, new_token());
        assert!(constant_time_eq(&a, &a.clone()));
        assert!(!constant_time_eq(&a, &new_token()));
        assert!(!constant_time_eq(&a, ""));
        assert!(Scope::Owner.can_see("x"));
        assert!(Scope::Viewer("x".into()).can_see("x"));
        assert!(!Scope::Viewer("x".into()).can_see("y"));
    }

    #[test]
    fn event_routing() {
        let ev = json!({ "type": "text_delta", "agentId": "a1" });
        assert_eq!(event_agent(&ev), Some("a1"));
        let ev = json!({ "type": "item_upserted", "item": { "agentId": "a2" } });
        assert_eq!(event_agent(&ev), Some("a2"));
        let ev = json!({ "type": "agent_updated", "agent": { "id": "a3" } });
        assert_eq!(event_agent(&ev), Some("a3"));
    }

    /// Forwards core events to the remote server, like the app's dispatcher does.
    struct Forward(Mutex<Option<Arc<Remote>>>);
    impl EventSink for Forward {
        fn emit(&self, event: ArmadaEvent) {
            if let Some(r) = self.0.lock().as_ref() {
                r.publish(&event);
            }
        }
    }

    fn http() -> ureq::Agent {
        ureq::Agent::new_with_config(
            ureq::Agent::config_builder()
                .http_status_as_error(false)
                .timeout_global(Some(Duration::from_secs(20)))
                .build(),
        )
    }

    async fn call(
        method: &'static str,
        url: String,
        token: Option<String>,
        body: Option<serde_json::Value>,
    ) -> (u16, String) {
        tokio::task::spawn_blocking(move || {
            let agent = http();
            let auth = token.map(|t| format!("Bearer {t}"));
            let mut res = match (method, body) {
                ("GET", _) => {
                    let mut req = agent.get(&url);
                    if let Some(a) = &auth {
                        req = req.header("Authorization", a);
                    }
                    req.call().unwrap()
                }
                ("DELETE", _) => {
                    let mut req = agent.delete(&url);
                    if let Some(a) = &auth {
                        req = req.header("Authorization", a);
                    }
                    req.call().unwrap()
                }
                (_, body) => {
                    let mut req = agent.post(&url);
                    if let Some(a) = &auth {
                        req = req.header("Authorization", a);
                    }
                    let body = serde_json::to_vec(&body.unwrap_or(json!({}))).unwrap();
                    req.header("Content-Type", "application/json")
                        .send(&body[..])
                        .unwrap()
                }
            };
            let status = res.status().as_u16();
            (status, res.body_mut().read_to_string().unwrap_or_default())
        })
        .await
        .unwrap()
    }

    /// Raw request so tests can forge headers ureq would normalize (Host etc.).
    async fn raw(port: u16, request: String) -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buf = vec![0u8; 64];
        let n = stream.read(&mut buf).await.unwrap();
        let head = String::from_utf8_lossy(&buf[..n]);
        head.split_whitespace().nth(1).unwrap().parse().unwrap()
    }

    /// Opens an event stream; returns a channel of data lines that closes when the
    /// server ends the stream.
    fn open_stream(url: String, token: &str) -> tokio::sync::mpsc::UnboundedReceiver<String> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let auth = format!("Bearer {token}");
        std::thread::spawn(move || {
            let res = http()
                .get(&url)
                .header("Authorization", &auth)
                .call()
                .unwrap();
            let reader = std::io::BufReader::new(res.into_body().into_reader());
            for line in reader.lines().map_while(Result::ok) {
                if let Some(data) = line.strip_prefix("data: ") {
                    if tx.send(data.to_string()).is_err() {
                        break;
                    }
                }
            }
        });
        rx
    }

    async fn stream_ends(rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>) -> bool {
        tokio::time::timeout(Duration::from_secs(10), async {
            while rx.recv().await.is_some() {}
        })
        .await
        .is_ok()
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn remote_api_end_to_end() {
        let mock = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../crates/armada-core/tests/mock_acp.py"
        );
        std::env::set_var("ARMADA_GROK_COMMAND", format!("python3 {mock}"));
        let dir = std::env::temp_dir().join(format!("armada-remote-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let project = dir.join("project");
        std::fs::create_dir_all(&project).unwrap();

        let forward = Arc::new(Forward(Mutex::new(None)));
        let core = Core::open(dir.join("data"), forward.clone()).unwrap();
        let remote = Remote::new(core.clone(), "9.9.9".into(), dir.join("data"));
        *forward.0.lock() = Some(remote.clone());

        // A free port can be taken by a parallel test between probing and binding; retry.
        let mut port = 0;
        for _ in 0..5 {
            port = std::net::TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port();
            remote
                .apply(&RemoteSettings {
                    enabled: true,
                    lan: false,
                    port,
                })
                .await;
            if remote.status().running {
                break;
            }
        }
        let status = remote.status();
        assert!(status.running, "{:?}", status.error);
        let base = status.url.clone().unwrap();
        assert_eq!(base, format!("http://127.0.0.1:{port}"));
        assert!(status.qr_svg.as_deref().is_some_and(|s| s.contains("<svg")));
        let owner = remote.tokens.lock().owner.clone();
        assert_eq!(
            status.pairing_url.unwrap(),
            format!("{base}/#token={owner}")
        );

        // Static app with strict headers.
        let res = tokio::task::spawn_blocking({
            let base = base.clone();
            move || http().get(&base).call().unwrap()
        })
        .await
        .unwrap();
        assert_eq!(res.status().as_u16(), 200);
        let csp = res
            .headers()
            .get("content-security-policy")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(csp.contains("frame-ancestors 'none'"));

        // Auth.
        assert_eq!(
            call("GET", format!("{base}/api/session"), None, None)
                .await
                .0,
            401
        );
        let (code, body) = call(
            "GET",
            format!("{base}/api/session"),
            Some(owner.clone()),
            None,
        )
        .await;
        assert_eq!(code, 200);
        assert!(body.contains(r#""scope":"owner""#) && body.contains("9.9.9"));

        // Start an agent, then drive it remotely.
        let account = core
            .accounts()
            .unwrap()
            .into_iter()
            .find(|a| a.provider == Provider::Grok)
            .unwrap();
        let agent = core
            .create_agent(CreateAgentRequest {
                provider: Provider::Grok,
                account_id: account.id,
                project_path: project.to_string_lossy().into_owned(),
                prompt: "from the phone".into(),
                title: None,
                worktree: false,
                model: None,
                group_id: None,
                custom_agent_id: None,
                permission_mode: None,
                attachments: vec![],
            })
            .await
            .unwrap();

        // Open the event stream before answering so we see the turn finish.
        let mut events = open_stream(format!("{base}/api/events"), &owner);

        let request_id = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let (_, body) = call(
                    "GET",
                    format!("{base}/api/agents/{}/items", agent.id),
                    Some(owner.clone()),
                    None,
                )
                .await;
                let items: Vec<armada_core::TimelineItem> = serde_json::from_str(&body).unwrap();
                if let Some(id) = items.iter().find_map(|i| match &i.body {
                    ItemBody::Permission {
                        request_id,
                        resolution: None,
                        ..
                    } => Some(request_id.clone()),
                    _ => None,
                }) {
                    return id;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("permission request");
        let (code, _) = call(
            "POST",
            format!("{base}/api/agents/{}/permission", agent.id),
            Some(owner.clone()),
            Some(json!({ "requestId": request_id, "optionId": "yes" })),
        )
        .await;
        assert_eq!(code, 204);
        tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(ev) = events.recv().await {
                if ev.contains(r#""type":"attention""#) && ev.contains(r#""reason":"done""#) {
                    return;
                }
            }
            panic!("event stream ended");
        })
        .await
        .expect("done event over SSE");

        // The phone can start an agent of any provider, then stop it.
        let (code, body) = call(
            "POST",
            format!("{base}/api/agents"),
            Some(owner.clone()),
            Some(json!({
                "provider": "grok",
                "accountId": agent.account_id,
                "projectPath": project.to_string_lossy(),
            })),
        )
        .await;
        assert_eq!(code, 200, "{body}");
        let started: Agent = serde_json::from_str(&body).unwrap();
        assert_eq!(started.provider, Provider::Grok);
        let (_, body) = call(
            "GET",
            format!("{base}/api/state"),
            Some(owner.clone()),
            None,
        )
        .await;
        let state: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(state["projects"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p.as_str() == Some(&*project.to_string_lossy())));
        let (code, _) = call(
            "POST",
            format!("{base}/api/agents/{}/stop", started.id),
            Some(owner.clone()),
            None,
        )
        .await;
        assert_eq!(code, 204);
        let (code, _) = call(
            "DELETE",
            format!("{base}/api/agents/{}/queue/nope", started.id),
            Some(owner.clone()),
            None,
        )
        .await;
        assert_eq!(code, 200);
        let (code, _) = call(
            "POST",
            format!("{base}/api/agents/{}/queue/nope/send", started.id),
            Some(owner.clone()),
            None,
        )
        .await;
        assert_eq!(code, 400);
        let (code, _) = call(
            "POST",
            format!("{base}/api/agents"),
            Some(owner.clone()),
            Some(json!({
                "provider": "grok",
                "accountId": agent.account_id,
                "projectPath": project.to_string_lossy(),
                "attachments": [{ "name": "a.txt", "mimeType": "text/plain", "data": "" }],
            })),
        )
        .await;
        assert_eq!(code, 400, "only images can be attached");

        // Retrying with the same Idempotency-Key returns the first agent, not a new one.
        let create = |key: &'static str| {
            let url = format!("{base}/api/agents");
            let owner = owner.clone();
            let body = serde_json::to_vec(&json!({
                "provider": "grok",
                "accountId": agent.account_id,
                "projectPath": project.to_string_lossy(),
            }))
            .unwrap();
            tokio::task::spawn_blocking(move || {
                let mut res = http()
                    .post(&url)
                    .header("Authorization", &format!("Bearer {owner}"))
                    .header("Idempotency-Key", key)
                    .header("Content-Type", "application/json")
                    .send(&body[..])
                    .unwrap();
                (
                    res.status().as_u16(),
                    res.body_mut().read_to_string().unwrap_or_default(),
                )
            })
        };
        let (code, first) = create("k1").await.unwrap();
        assert_eq!(code, 200, "{first}");
        let (code, again) = create("k1").await.unwrap();
        assert_eq!(code, 200);
        let first: Agent = serde_json::from_str(&first).unwrap();
        let again: Agent = serde_json::from_str(&again).unwrap();
        assert_eq!(first.id, again.id, "a retried create is not a second agent");
        let (code, _) = call(
            "POST",
            format!("{base}/api/agents/{}/stop", first.id),
            Some(owner.clone()),
            None,
        )
        .await;
        assert_eq!(code, 204);

        // Pending approvals without whole timelines; paged timelines.
        let (code, body) = call(
            "GET",
            format!("{base}/api/permissions"),
            Some(owner.clone()),
            None,
        )
        .await;
        assert_eq!(code, 200, "{body}");
        let (code, body) = call(
            "GET",
            format!("{base}/api/agents/{}/items?limit=1", agent.id),
            Some(owner.clone()),
            None,
        )
        .await;
        assert_eq!(code, 200);
        let page: Vec<armada_core::TimelineItem> = serde_json::from_str(&body).unwrap();
        assert_eq!(page.len(), 1, "limit is honored");

        // Unauthenticated requests are refused before any body is read.
        assert_eq!(
            raw(port, format!("POST /api/agents HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: 20000000\r\nConnection: close\r\n\r\n{{")).await,
            401
        );

        // Read-only share link: sees only its agent, can't act.
        let share = remote.create_share(&agent.id).unwrap();
        let (code, body) = call(
            "GET",
            format!("{base}/api/session"),
            Some(share.token.clone()),
            None,
        )
        .await;
        assert_eq!(code, 200);
        assert!(body.contains(r#""scope":"viewer""#));
        let (_, body) = call(
            "GET",
            format!("{base}/api/state"),
            Some(share.token.clone()),
            None,
        )
        .await;
        let state: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(state["agents"].as_array().unwrap().len(), 1);
        assert!(state["accounts"].as_array().unwrap().is_empty());
        assert!(
            state["agents"][0]["cwd"].is_null(),
            "viewers don't see local paths"
        );
        assert!(
            state["agents"][0]["queue"].is_null() && state["agents"][0]["accountId"].is_null(),
            "viewers don't see queued drafts or accounts"
        );
        assert!(
            state["agents"][0]
                .as_object()
                .unwrap()
                .contains_key("customAgentId"),
            "viewers keep the custom agent id (for its name chip)"
        );
        assert!(state["agents"][0]["title"].is_string());
        // Tokens are only accepted in the Authorization header (never in URLs).
        for path in ["state", "events"] {
            let (code, _) = call(
                "GET",
                format!("{base}/api/{path}?token={}", share.token),
                None,
                None,
            )
            .await;
            assert_eq!(code, 401, "{path}");
        }
        let mut viewer_stream = open_stream(format!("{base}/api/events"), &share.token);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let (code, _) = call(
            "POST",
            format!("{base}/api/agents/{}/prompt", agent.id),
            Some(share.token.clone()),
            Some(json!({ "text": "hi" })),
        )
        .await;
        assert_eq!(code, 403);
        let (code, _) = call(
            "POST",
            format!("{base}/api/agents/{}/stop", agent.id),
            Some(share.token.clone()),
            None,
        )
        .await;
        assert_eq!(code, 403);
        let (code, _) = call(
            "GET",
            format!("{base}/api/agents/someone-else/items"),
            Some(share.token.clone()),
            None,
        )
        .await;
        assert_eq!(code, 404);
        remote.revoke_share(&share.token);
        assert_eq!(
            call(
                "GET",
                format!("{base}/api/session"),
                Some(share.token),
                None
            )
            .await
            .0,
            401
        );
        assert!(
            stream_ends(&mut viewer_stream).await,
            "revoking ends the live stream"
        );

        // DNS rebinding / cross-site requests are refused even with a valid token.
        assert_eq!(
            raw(port, format!("GET /api/session HTTP/1.1\r\nHost: evil.example:{port}\r\nAuthorization: Bearer {owner}\r\nConnection: close\r\n\r\n")).await,
            421
        );
        assert_eq!(
            raw(port, format!("GET /api/session HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nSec-Fetch-Site: cross-site\r\nAuthorization: Bearer {owner}\r\nConnection: close\r\n\r\n")).await,
            403
        );

        // Owner can prompt; rotating the token unpairs devices.
        let (code, _) = call(
            "POST",
            format!("{base}/api/agents/{}/prompt", agent.id),
            Some(owner.clone()),
            Some(json!({ "text": "again" })),
        )
        .await;
        assert_eq!(code, 204);
        // Resuming answers right away; the agent starts in the background.
        let (code, _) = call(
            "POST",
            format!("{base}/api/agents/{}/resume", agent.id),
            Some(owner.clone()),
            None,
        )
        .await;
        assert_eq!(code, 202);
        let mut owner_stream = open_stream(format!("{base}/api/events"), &owner);
        tokio::time::sleep(Duration::from_millis(300)).await;
        remote.rotate_owner_token();
        assert_eq!(
            call(
                "GET",
                format!("{base}/api/session"),
                Some(owner.clone()),
                None
            )
            .await
            .0,
            401
        );
        assert!(
            stream_ends(&mut owner_stream).await,
            "unpairing ends the live stream"
        );
        let owner = remote.tokens.lock().owner.clone();

        // Brute force gets locked out, but never the real owner.
        let mut last = 0;
        for _ in 0..12 {
            last = call(
                "GET",
                format!("{base}/api/session"),
                Some("guess".into()),
                None,
            )
            .await
            .0;
        }
        assert_eq!(last, 429);
        assert_eq!(
            call(
                "GET",
                format!("{base}/api/session"),
                Some(owner.clone()),
                None
            )
            .await
            .0,
            200
        );

        // Changing the port restarts cleanly and ends streams on the old server.
        let mut old_stream = open_stream(format!("{base}/api/events"), &owner);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let port2 = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        remote
            .apply(&RemoteSettings {
                enabled: true,
                lan: false,
                port: port2,
            })
            .await;
        assert!(remote.status().running, "{:?}", remote.status().error);
        assert!(
            stream_ends(&mut old_stream).await,
            "restart ends old streams"
        );
        assert_eq!(
            call(
                "GET",
                format!("http://127.0.0.1:{port2}/api/session"),
                Some(owner.clone()),
                None
            )
            .await
            .0,
            200
        );
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err(),
            "old port released"
        );

        // A client that never finishes its request headers is disconnected.
        {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut slow = tokio::net::TcpStream::connect(("127.0.0.1", port2))
                .await
                .unwrap();
            slow.write_all(b"GET /api/session HTTP/1.1\r\nHost: 127.0.0.1\r\n")
                .await
                .unwrap();
            let mut buf = [0u8; 256];
            let closed = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    match slow.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(_) => continue,
                    }
                }
            })
            .await;
            assert!(closed.is_ok(), "slow client wasn't disconnected");
        }

        // A port taken by another program fails fast (no retry loop) on a fresh start.
        let squatter = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let taken = squatter.local_addr().unwrap().port();
        remote
            .apply(&RemoteSettings {
                enabled: false,
                lan: false,
                port: taken,
            })
            .await;
        let started = Instant::now();
        remote
            .apply(&RemoteSettings {
                enabled: true,
                lan: false,
                port: taken,
            })
            .await;
        let st = remote.status();
        assert!(!st.running && st.error.is_some());
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "{:?}",
            started.elapsed()
        );
        drop(squatter);

        // Privileged ports are refused with a clear error.
        remote
            .apply(&RemoteSettings {
                enabled: true,
                lan: false,
                port: 80,
            })
            .await;
        let st = remote.status();
        assert!(!st.running && st.error.unwrap().contains("1024"));

        remote
            .apply(&RemoteSettings {
                enabled: false,
                lan: false,
                port: 80,
            })
            .await;
        assert!(!remote.status().running);

        // After app shutdown, a late `apply` (e.g. the startup one) does nothing.
        remote.shutdown().await;
        remote
            .apply(&RemoteSettings {
                enabled: true,
                lan: false,
                port: port2,
            })
            .await;
        assert!(!remote.status().running);
        core.shutdown().await;
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("armada-tokens-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn token_file_lifecycle() {
        let dir = temp_dir();
        let path = dir.join("remote.json");

        // First run: new owner token.
        let first = load_tokens(&path);
        assert!(first.persist && first.dirty && first.problem.is_none());
        assert_eq!(first.tokens.owner.len(), 64);

        // Saved atomically, owner-only, no temp files left behind.
        let data = serde_json::to_vec(&first.tokens).unwrap();
        write_private_atomic(&path, &data).unwrap();
        write_private_atomic(&path, &data).unwrap();
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["remote.json"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let again = load_tokens(&path);
        assert_eq!(again.tokens.owner, first.tokens.owner);
        assert!(again.problem.is_none());

        // Damaged: reset, but the old file is kept and the user told.
        std::fs::write(&path, b"{not json").unwrap();
        let damaged = load_tokens(&path);
        assert!(damaged.persist);
        assert_ne!(damaged.tokens.owner, first.tokens.owner);
        assert!(damaged.problem.as_deref().unwrap().contains("damaged"));
        assert!(std::fs::read_dir(&dir).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("damaged")));

        // Unreadable (a directory here): nothing is overwritten, nothing authorizes.
        let unreadable = dir.join("dir.json");
        std::fs::create_dir_all(&unreadable).unwrap();
        let blocked = load_tokens(&unreadable);
        assert!(!blocked.persist && !blocked.dirty);
        assert!(blocked.tokens.owner.is_empty());
        assert!(blocked.problem.is_some());

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
