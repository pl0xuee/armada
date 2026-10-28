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

use armada_core::{now_ms, Agent, ArmadaEvent, Core, RemoteSettings};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::Stream;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, oneshot, watch};
use tracing::{info, warn};

static REMOTE_HTML: &str = include_str!(concat!(env!("OUT_DIR"), "/remote.html"));
static ICON_PNG: &[u8] = include_bytes!("../icons/128x128@2x.png");

const MAX_FAILURES: u32 = 10;
const LOCKOUT: Duration = Duration::from_secs(10 * 60);
const MIN_PORT: u16 = 1024;

/// Agent fields a read-only viewer doesn't need (local paths, ids, branches).
const VIEWER_HIDDEN_FIELDS: &[&str] = &[
    "projectPath",
    "cwd",
    "accountId",
    "sessionId",
    "baseCommit",
    "branch",
    "baseBranch",
    "customAgentId",
    "scheduleId",
    "groupId",
    "configOptions",
    "availableCommands",
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
    events: broadcast::Sender<String>,
    tokens: Mutex<Tokens>,
    running: Mutex<Option<Running>>,
    /// Bumped whenever credentials change or the server stops/starts; live event
    /// streams re-check their token and server epoch when it moves.
    generation: watch::Sender<u64>,
    epoch: Mutex<u64>,
    /// Serializes start/stop so concurrent settings saves can't race.
    apply_lock: tokio::sync::Mutex<()>,
    error: Mutex<Option<String>>,
    failures: Mutex<HashMap<IpAddr, (u32, Instant)>>,
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
        for field in VIEWER_HIDDEN_FIELDS {
            obj.remove(*field);
        }
    }
}

impl Remote {
    pub fn new(core: Core, version: String, data_dir: PathBuf) -> Arc<Remote> {
        let path = data_dir.join("remote.json");
        let mut tokens: Tokens = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let fresh = tokens.owner.len() < 32;
        if fresh {
            tokens.owner = new_token();
        }
        let (events, _) = broadcast::channel(1024);
        let (generation, _) = watch::channel(0);
        let remote = Arc::new(Remote {
            core,
            version,
            path,
            events,
            tokens: Mutex::new(tokens),
            running: Mutex::new(None),
            generation,
            epoch: Mutex::new(0),
            apply_lock: tokio::sync::Mutex::new(()),
            error: Mutex::new(None),
            failures: Mutex::new(HashMap::new()),
        });
        // Always rewrite so existing files get owner-only permissions too.
        remote.save_tokens();
        remote
    }

    fn save_tokens(&self) {
        let data = match serde_json::to_vec_pretty(&*self.tokens.lock()) {
            Ok(d) => d,
            Err(e) => return warn!("serializing remote tokens: {e}"),
        };
        if let Err(e) = write_private(&self.path, &data) {
            warn!("saving remote tokens: {e}");
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
        );
        if relevant {
            if let Ok(json) = serde_json::to_string(event) {
                let _ = self.events.send(json);
            }
        }
    }

    fn core(&self) -> Core {
        self.core.clone()
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
            error: self.error.lock().clone(),
            shares,
        }
    }

    /// Unpairs every device by issuing a new owner token.
    pub fn rotate_owner_token(&self) {
        self.tokens.lock().owner = new_token();
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

    /// Starts, restarts or stops the server to match `settings`.
    pub async fn apply(self: &Arc<Self>, settings: &RemoteSettings) {
        let _serialized = self.apply_lock.lock().await;
        let unchanged =
            self.running.lock().as_ref().is_some_and(|r| {
                r.settings.lan == settings.lan && r.settings.port == settings.port
            });
        if settings.enabled && unchanged {
            return;
        }
        self.stop_and_wait().await;
        if !settings.enabled {
            *self.error.lock() = None;
            return;
        }
        match self.start(settings).await {
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

    async fn start(self: &Arc<Self>, settings: &RemoteSettings) -> Result<SocketAddr, String> {
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
                Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && attempt < 10 => {
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
        let task = tauri::async_runtime::spawn(async move {
            let server = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            });
            if let Err(e) = server.await {
                warn!("remote server stopped: {e}");
            }
        });
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

    async fn stop_and_wait(&self) {
        if let Some(task) = self.stop() {
            // Streams end via the generation bump, so this is normally quick.
            if tokio::time::timeout(Duration::from_secs(3), task)
                .await
                .is_err()
            {
                warn!("remote server took too long to stop");
            }
        }
    }

    fn current_epoch(&self) -> Option<u64> {
        self.running.lock().as_ref().map(|r| r.epoch)
    }

    fn router(self: &Arc<Self>, epoch: u64) -> Router {
        Router::new()
            .route("/", get(index))
            .route("/index.html", get(index))
            .route("/manifest.webmanifest", get(manifest))
            .route("/icon.png", get(icon))
            .route("/api/session", get(session))
            .route("/api/state", get(state))
            .route("/api/agents/{id}/items", get(items))
            .route("/api/agents/{id}/prompt", post(prompt))
            .route("/api/agents/{id}/permission", post(permission))
            .route("/api/agents/{id}/cancel", post(cancel))
            .route("/api/agents/{id}/resume", post(resume))
            .route("/api/events", get(events))
            .layer(DefaultBodyLimit::max(256 * 1024))
            .layer(axum::middleware::map_response(no_store))
            .with_state(Ctx {
                remote: self.clone(),
                epoch,
            })
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
        query_token: Option<&str>,
    ) -> Result<(Scope, String), ApiError> {
        self.check_origin(epoch, headers)?;
        let token = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .or(query_token)
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

#[cfg(unix)]
fn write_private(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    // `mode` only applies when the file is created; tighten existing files too.
    f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    f.write_all(data)
}

#[cfg(not(unix))]
fn write_private(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    // Per-user app data dirs on Windows/macOS aren't readable by other users.
    std::fs::write(path, data)
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
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

#[derive(Clone)]
struct Ctx {
    remote: Arc<Remote>,
    epoch: u64,
}

impl Ctx {
    fn auth(&self, peer: &SocketAddr, headers: &HeaderMap) -> Result<Scope, ApiError> {
        self.remote
            .authorize(self.epoch, peer.ip(), headers, None)
            .map(|(s, _)| s)
    }
}

type Peer = ConnectInfo<SocketAddr>;

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

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

async fn index() -> Response {
    let mut res = (
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
            "icons": [{ "src": "/icon.png", "sizes": "256x256", "type": "image/png" }]
        })),
    )
}

async fn icon() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "image/png")], ICON_PNG)
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
                    "label": a.status.and_then(|s| s.label),
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
        .map(|c| json!({ "id": c.id, "name": c.name, "color": c.color }))
        .collect();
    Ok(Json(
        json!({ "agents": agents, "accounts": accounts, "customAgents": custom_agents }),
    ))
}

async fn items(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let scope = c.auth(&peer, &headers)?;
    visible(&scope, &id)?;
    let core = c.remote.core();
    core.agent(&id)?;
    Ok(Json(core.items(&id)?).into_response())
}

#[derive(Deserialize)]
struct PromptBody {
    text: String,
}

async fn prompt(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<PromptBody>,
) -> Result<StatusCode, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    c.remote
        .core()
        .send_prompt(&id, &body.text, Vec::new())
        .await?;
    Ok(StatusCode::NO_CONTENT)
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
    core.resume_agent(&id, interrupted).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Which agent an event is about (None = not forwarded).
fn event_agent(json: &Value) -> Option<&str> {
    json["agent"]["id"]
        .as_str()
        .or_else(|| json["agentId"].as_str())
        .or_else(|| json["item"]["agentId"].as_str())
}

/// Per-connection state of a live event stream.
struct Stream_ {
    rx: broadcast::Receiver<String>,
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
                changed = self.generation.changed() => {
                    if changed.is_err() || !self.still_valid() {
                        return None;
                    }
                }
                msg = self.rx.recv() => match msg {
                    Ok(json) => {
                        let Scope::Viewer(id) = &self.scope else {
                            return Some(json);
                        };
                        let mut v: Value = serde_json::from_str(&json).unwrap_or_default();
                        if event_agent(&v) != Some(id.as_str()) {
                            continue;
                        }
                        if v["type"] == "agent_removed" {
                            return None;
                        }
                        if v["type"] == "agent_updated" {
                            trim_agent(&mut v["agent"]);
                        }
                        return Some(v.to_string());
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
    Query(q): Query<TokenQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    // EventSource can't send headers, so this route also accepts `?token=`.
    let (scope, token) = c
        .remote
        .authorize(c.epoch, peer.ip(), &headers, q.token.as_deref())?;
    let state = Stream_ {
        rx: c.remote.events.subscribe(),
        generation: c.remote.generation.subscribe(),
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
    fn open_stream(url: String) -> tokio::sync::mpsc::UnboundedReceiver<String> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        std::thread::spawn(move || {
            let res = http().get(&url).call().unwrap();
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

        let port = std::net::TcpListener::bind("127.0.0.1:0")
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
                attachments: vec![],
            })
            .await
            .unwrap();

        // Open the event stream before answering so we see the turn finish.
        let mut events = open_stream(format!("{base}/api/events?token={owner}"));

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
        assert!(state["agents"][0]["title"].is_string());
        // Query tokens only work for the event stream.
        let (code, _) = call(
            "GET",
            format!("{base}/api/state?token={}", share.token),
            None,
            None,
        )
        .await;
        assert_eq!(code, 401);
        let mut viewer_stream = open_stream(format!("{base}/api/events?token={}", share.token));
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
        let mut owner_stream = open_stream(format!("{base}/api/events?token={owner}"));
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
        let mut old_stream = open_stream(format!("{base}/api/events?token={owner}"));
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
        core.shutdown().await;
    }
}
