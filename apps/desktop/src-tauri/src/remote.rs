//! Remote control / mobile companion: an opt-in HTTP server that serves the phone
//! web app (apps/remote) plus a small JSON + Server-Sent Events API.
//!
//! Security model:
//! - Off by default; binds to 127.0.0.1, or only to the machine's private LAN
//!   address when the user enables LAN access (never every interface, and never a
//!   public address).
//! - Pairing: Settings → Remote shows a QR code holding a one-time pairing code
//!   (valid 5 minutes, single use). The phone trades it at `POST /api/pair` for its
//!   own device token. The QR code never contains a long-lived credential.
//! - Every API call needs a bearer token: a device token (full control) or a share
//!   token (read-only, one agent, expires, and sees only a projection of that
//!   agent: messages with secrets redacted and a tool-call outline, see `view`).
//!   Tokens are 244-bit random values, compared in constant time; only their
//!   SHA-256 hashes are stored (owner-only file permissions).
//! - Revoking a device or share, unpairing all, or stopping the server also ends
//!   live event streams that were opened with the old credentials.
//! - Requests must name this server in `Host` (DNS rebinding), must not be
//!   cross-site browser requests and must not carry a foreign `Origin`. Invalid
//!   tokens or pairing codes from one address are rate limited; a valid token is
//!   never locked out. Connections are capped per peer address, with slots kept for
//!   peers that authenticated.
//! - Traffic is plain HTTP; the UI explains that it is not encrypted on the local
//!   network and recommends a VPN such as Tailscale away from home.

mod view;

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

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
/// Connections at once from one peer address that hasn't authenticated.
const MAX_PEER_CONNECTIONS: usize = 8;
/// Same for a peer that recently sent a valid token (a phone with several tabs).
const MAX_TRUSTED_PEER_CONNECTIONS: usize = 24;
/// Of `MAX_CONNECTIONS`, slots only authenticated peers may use, so unauthenticated
/// hosts on the network can't fill the server.
const RESERVED_CONNECTIONS: usize = 16;
/// How long an address counts as authenticated after its last valid request.
const TRUSTED_TTL: Duration = Duration::from_secs(10 * 60);
/// A pairing code works once, for this long.
const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);
/// Paired devices at most (bounds the token file).
const MAX_DEVICES: usize = 25;
/// Share link lifetimes the UI offers (hours); anything else becomes the default.
const SHARE_HOURS: [u32; 3] = [1, 24, 24 * 7];
const DEFAULT_SHARE_HOURS: u32 = 24;
/// `last_seen` is refreshed (and saved) at most this often.
const LAST_SEEN_STEP_MS: i64 = 60_000;
const PUBLIC_ADDRESS_MESSAGE: &str = "Your network address is public; remote access over it is disabled. Use Tailscale (or another VPN) and connect over its private address, or turn LAN access off.";
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

/// A read-only link to one agent. Only the token's hash is stored.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Share {
    /// Older files kept the token itself; `migrate` hashes it and clears this.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    token: String,
    #[serde(default)]
    token_hash: String,
    agent_id: String,
    created_at: i64,
    /// Unix ms; 0 = unset (older files), which `migrate` replaces.
    #[serde(default)]
    expires_at: i64,
}

impl Share {
    /// Stable identifier for the UI (the token itself is not stored).
    fn id(&self) -> String {
        self.token_hash.chars().take(16).collect()
    }
}

/// A paired phone or tablet. Only its token's hash is stored.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: String,
    name: String,
    token_hash: String,
    created_at: i64,
    last_seen: i64,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    /// Older files held one plaintext owner token for every phone. `migrate`
    /// turns it into a single legacy device (hashed) so already-paired phones keep
    /// working, then clears it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    owner: String,
    #[serde(default)]
    devices: Vec<Device>,
    #[serde(default)]
    shares: Vec<Share>,
}

/// SHA-256 of a token, lowercase hex.
fn hash_token(token: &str) -> String {
    use std::fmt::Write;
    Sha256::digest(token.as_bytes())
        .iter()
        .fold(String::with_capacity(64), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

impl Tokens {
    /// Upgrades older files in place; returns whether anything changed.
    fn migrate(&mut self, now: i64) -> bool {
        let mut changed = false;
        if !self.owner.is_empty() {
            // Keep the user's current phone(s) working: the old shared owner token
            // becomes one device. Revoke it (or unpair all) in Settings to cut it off.
            let hash = hash_token(&self.owner);
            if !self.devices.iter().any(|d| d.token_hash == hash) {
                self.devices.push(Device {
                    id: uuid::Uuid::new_v4().simple().to_string(),
                    name: "Previously paired phone".into(),
                    token_hash: hash,
                    created_at: now,
                    last_seen: 0,
                });
            }
            self.owner.clear();
            changed = true;
        }
        for share in &mut self.shares {
            if !share.token.is_empty() {
                share.token_hash = hash_token(&share.token);
                share.token.clear();
                changed = true;
            }
            if share.expires_at == 0 {
                share.expires_at = now + i64::from(DEFAULT_SHARE_HOURS) * 3_600_000;
                changed = true;
            }
        }
        let before = self.shares.len();
        self.shares.retain(|s| !s.token_hash.is_empty());
        changed || before != self.shares.len()
    }
}

/// The pairing code currently shown in Settings (memory only; never persisted).
struct PairingCode {
    hash: String,
    /// The server address it was minted for.
    base: String,
    url: String,
    qr_svg: Option<String>,
    expires: Instant,
    expires_at_ms: i64,
}

/// Decides which connections the server accepts: a total cap, a per-address cap,
/// and slots kept for addresses that sent a valid token recently.
struct ConnLimiter {
    max_total: usize,
    reserved: usize,
    per_peer: usize,
    per_trusted_peer: usize,
    state: Mutex<LimiterState>,
}

#[derive(Default)]
struct LimiterState {
    total: usize,
    per_ip: HashMap<IpAddr, usize>,
    trusted: HashMap<IpAddr, Instant>,
}

/// One admitted connection; released on drop.
struct ConnGuard {
    limiter: Arc<ConnLimiter>,
    ip: IpAddr,
}

impl ConnLimiter {
    fn new(max_total: usize, reserved: usize, per_peer: usize, per_trusted_peer: usize) -> Self {
        ConnLimiter {
            max_total,
            reserved,
            per_peer,
            per_trusted_peer,
            state: Mutex::new(LimiterState::default()),
        }
    }

    fn standard() -> Arc<Self> {
        Arc::new(Self::new(
            MAX_CONNECTIONS,
            RESERVED_CONNECTIONS,
            MAX_PEER_CONNECTIONS,
            MAX_TRUSTED_PEER_CONNECTIONS,
        ))
    }

    /// Records a valid request from `ip`.
    fn trust(&self, ip: IpAddr) {
        let mut st = self.state.lock();
        if st.trusted.len() > 1024 {
            st.trusted.retain(|_, at| at.elapsed() < TRUSTED_TTL);
        }
        st.trusted.insert(ip.to_canonical(), Instant::now());
    }

    fn is_trusted(st: &LimiterState, ip: &IpAddr) -> bool {
        st.trusted
            .get(ip)
            .is_some_and(|at| at.elapsed() < TRUSTED_TTL)
    }

    /// Admits a new connection from `ip`, or None when it must be refused.
    fn admit(self: &Arc<Self>, ip: IpAddr) -> Option<ConnGuard> {
        let ip = ip.to_canonical();
        let mut st = self.state.lock();
        if st.total >= self.max_total {
            return None;
        }
        // Loopback is this computer itself: only the total cap applies.
        if !ip.is_loopback() {
            let trusted = Self::is_trusted(&st, &ip);
            let cap = if trusted {
                self.per_trusted_peer
            } else {
                self.per_peer
            };
            if st.per_ip.get(&ip).copied().unwrap_or(0) >= cap {
                return None;
            }
            if !trusted && st.total >= self.max_total.saturating_sub(self.reserved) {
                return None;
            }
        }
        st.total += 1;
        *st.per_ip.entry(ip).or_insert(0) += 1;
        Some(ConnGuard {
            limiter: self.clone(),
            ip,
        })
    }
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        let mut st = self.limiter.state.lock();
        st.total = st.total.saturating_sub(1);
        if let Some(n) = st.per_ip.get_mut(&self.ip) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                st.per_ip.remove(&self.ip);
            }
        }
    }
}

/// Whether `ip` is a private (non-internet) address: RFC 1918, carrier-grade NAT
/// 100.64.0.0/10 (Tailscale), link-local, or IPv6 unique-local / link-local.
fn is_private_address(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_private() || v4.is_link_local() || (o[0] == 100 && (o[1] & 0xc0) == 64)
        }
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
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
    pub id: String,
    pub agent_id: String,
    pub agent_title: Option<String>,
    /// The link itself; only known when the share is created (just its hash is kept).
    pub url: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    /// Unix ms of the last request; 0 = never seen since pairing.
    pub last_seen: i64,
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
    /// One-time pairing link (`#pair=<code>`; valid 5 minutes, single use).
    pub pairing_url: Option<String>,
    /// QR code for `pairing_url`, as an SVG document.
    pub qr_svg: Option<String>,
    /// When the pairing code stops working (unix ms).
    pub pairing_expires_at: Option<i64>,
    pub error: Option<String>,
    pub shares: Vec<ShareLink>,
    pub devices: Vec<DeviceInfo>,
    /// Addresses LAN access can listen on, best first (empty while LAN access is off).
    pub lan_addresses: Vec<LanAddress>,
    /// A firewall that blocks the running LAN server, and how to open it.
    pub firewall: Option<FirewallHint>,
}

pub struct Remote {
    core: Core,
    version: String,
    path: PathBuf,
    events: broadcast::Sender<Arc<Published>>,
    tokens: Mutex<Tokens>,
    running: Mutex<Option<Running>>,
    /// The settings the user wants running (enabled), kept so a server that stopped on a
    /// network drop can come back; `None` when disabled by the user.
    wanted: Mutex<Option<RemoteSettings>>,
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
    /// The pairing code on display.
    pairing: Mutex<Option<PairingCode>>,
    limiter: Arc<ConnLimiter>,
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

/// What `refresh_lan` should (re)start, if anything: a running LAN server whose address
/// went stale, or (after a network drop stopped it) the wanted LAN settings once a
/// private address is back. A server the user turned off (`wanted` is `None`) stays off.
fn lan_refresh_target(
    running: Option<(RemoteSettings, IpAddr)>,
    wanted: Option<RemoteSettings>,
    current: Option<IpAddr>,
) -> Option<RemoteSettings> {
    match running {
        Some((s, addr)) => (s.lan && current != Some(addr)).then_some(s),
        None => {
            let w = wanted?;
            (w.enabled && w.lan && current.is_some_and(is_private_address)).then_some(w)
        }
    }
}

/// What kind of network one of this computer's addresses is on. Ordered by preference:
/// phones on the same Wi-Fi reach a `Lan` address; a full-tunnel VPN's address (which
/// is also where the default route points) is useless to them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NetworkKind {
    Lan,
    Tailscale,
    Vpn,
    /// Container and virtual machine bridges (Docker, libvirt, …).
    Virtual,
}

/// One of this computer's private IPv4 addresses the LAN server could listen on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanAddress {
    pub ip: IpAddr,
    /// The interface's name (`eno1`, `Wi-Fi`, `tailscale0`, …).
    pub interface: String,
    pub kind: NetworkKind,
    pub prefix_len: u8,
}

/// Classifies an interface by its name and flags; `None` for addresses a phone can never
/// use (loopback, link-local, public).
fn classify(name: &str, ip: Ipv4Addr, prefix_len: u8, p2p: bool) -> Option<NetworkKind> {
    if ip.is_loopback() || ip.is_link_local() || !is_private_address(IpAddr::V4(ip)) {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    let starts = |prefixes: &[&str]| prefixes.iter().any(|p| lower.starts_with(p));
    let has = |parts: &[&str]| parts.iter().any(|p| lower.contains(p));
    let cgnat = ip.octets()[0] == 100 && (ip.octets()[1] & 0xc0) == 64;
    if starts(&[
        "docker", "br-", "veth", "virbr", "vmnet", "vboxnet", "lxc", "lxd", "podman", "cni",
        "flannel", "cali", "kube", "incus",
    ]) || has(&["virtualbox", "vmware", "hyper-v", "(wsl"])
    {
        return Some(NetworkKind::Virtual);
    }
    if has(&["tailscale"]) || (cgnat && starts(&["utun"])) {
        return Some(NetworkKind::Tailscale);
    }
    // Tunnels: point-to-point links, a lone /32, well-known VPN interface names, and
    // anything else in the carrier-grade NAT range (Proton's kill switch uses it).
    if p2p
        || prefix_len == 32
        || cgnat
        || starts(&[
            "tun", "tap", "wg", "utun", "ppp", "ipsec", "zt", "nordlynx", "pvpn",
        ])
        || has(&[
            "vpn",
            "wireguard",
            "proton",
            "mullvad",
            "tunnel",
            "openconnect",
            "zerotier",
        ])
    {
        return Some(NetworkKind::Vpn);
    }
    Some(NetworkKind::Lan)
}

/// This computer's private IPv4 addresses, best first.
fn lan_addresses() -> Vec<LanAddress> {
    let mut list: Vec<LanAddress> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| i.oper_status != if_addrs::IfOperStatus::Down)
        .filter_map(|i| match i.addr {
            if_addrs::IfAddr::V4(v4) => Some(LanAddress {
                kind: classify(&i.name, v4.ip, v4.prefixlen, i.is_p2p)?,
                ip: IpAddr::V4(v4.ip),
                interface: i.name,
                prefix_len: v4.prefixlen,
            }),
            if_addrs::IfAddr::V6(_) => None,
        })
        .collect();
    rank_lan_addresses(&mut list, route_ip());
    list.dedup_by(|a, b| a.ip == b.ip);
    list
}

/// Best first: by kind, then the address the default route uses (the right one on a
/// computer with several networks and no VPN), then home-network ranges first.
fn rank_lan_addresses(list: &mut [LanAddress], route: Option<IpAddr>) {
    let range = |ip: IpAddr| match ip {
        IpAddr::V4(v4) => match v4.octets() {
            [192, 168, ..] => 0,
            [172, b, ..] if (16..32).contains(&b) => 1,
            [10, ..] => 2,
            _ => 3,
        },
        IpAddr::V6(_) => 4,
    };
    list.sort_by_key(|a| {
        (
            a.kind,
            Some(a.ip) != route,
            range(a.ip),
            a.interface.clone(),
        )
    });
}

/// The address the default route goes out of (no packets are sent). With a full-tunnel
/// VPN this is the VPN's own address, so it only breaks ties within a kind.
fn route_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_unspecified() && !ip.is_loopback()).then_some(ip)
}

/// The address to listen on: the user's choice while this computer still has it,
/// otherwise the best one.
fn choose_lan(list: &[LanAddress], preferred: Option<&str>) -> Option<IpAddr> {
    let preferred: Option<IpAddr> = preferred.and_then(|p| p.parse().ok());
    preferred
        .filter(|p| list.iter().any(|a| a.ip == *p))
        .or_else(|| list.first().map(|a| a.ip))
}

fn lan_ip(settings: &RemoteSettings) -> Option<IpAddr> {
    choose_lan(&lan_addresses(), settings.lan_address.as_deref())
}

/// Linux: a firewall that drops the phone's connections, and the command that lets them
/// in. (Windows and macOS ask the user themselves the first time Armada listens.)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirewallHint {
    pub name: String,
    pub command: String,
}

#[cfg(target_os = "linux")]
fn firewall_hint(addr: &LanAddress, port: u16) -> Option<FirewallHint> {
    let conf = std::fs::read_to_string("/etc/ufw/ufw.conf").ok()?;
    if !conf.lines().any(|l| l.trim() == "ENABLED=yes") {
        return None;
    }
    // The rules file is world-readable on stock installs; if it isn't, show the hint.
    if std::fs::read_to_string("/etc/ufw/user.rules").is_ok_and(|r| ufw_allows(&r, port)) {
        return None;
    }
    Some(FirewallHint {
        name: "ufw".into(),
        command: ufw_command(addr, port),
    })
}

/// Lets in TCP to `port` from the address's own network; a Tailscale/VPN address is a
/// single host (/32), so there it's whatever arrives on that interface instead.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn ufw_command(addr: &LanAddress, port: u16) -> String {
    match addr.kind {
        NetworkKind::Lan => format!(
            "sudo ufw allow from {} to any port {port} proto tcp",
            network_cidr(addr)
        ),
        _ => format!(
            "sudo ufw allow in on {} to any port {port} proto tcp",
            addr.interface
        ),
    }
}

#[cfg(not(target_os = "linux"))]
fn firewall_hint(_addr: &LanAddress, _port: u16) -> Option<FirewallHint> {
    None
}

/// Whether ufw's user rules accept TCP connections to `port` (from anywhere or a subnet).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn ufw_allows(rules: &str, port: u16) -> bool {
    rules.lines().any(|line| {
        let words: Vec<&str> = line.split_whitespace().collect();
        if !line.starts_with("-A ufw-user-input") || !words.ends_with(&["-j", "ACCEPT"]) {
            return false;
        }
        let after = |flag: &str| words.iter().position(|w| *w == flag).and_then(|i| words.get(i + 1));
        if after("-p").is_some_and(|p| *p != "tcp") {
            return false;
        }
        let Some(ports) = after("--dport").or_else(|| after("--dports")) else {
            return false;
        };
        ports.split(',').any(|p| match p.split_once(':') {
            Some((lo, hi)) => matches!((lo.parse::<u16>(), hi.parse::<u16>()), (Ok(lo), Ok(hi)) if (lo..=hi).contains(&port)),
            None => p.parse() == Ok(port),
        })
    })
}

/// `192.168.1.0/24` for 192.168.1.107/24.
fn network_cidr(addr: &LanAddress) -> String {
    match addr.ip {
        IpAddr::V4(v4) => {
            let len = addr.prefix_len.min(32);
            let mask = if len == 0 { 0 } else { u32::MAX << (32 - len) };
            format!("{}/{len}", Ipv4Addr::from(u32::from(v4) & mask))
        }
        IpAddr::V6(v6) => format!("{v6}"),
    }
}

/// Removes fields a read-only viewer shouldn't see from a serialized agent, and
/// redacts the free text that stays (title, last message).
fn trim_agent(agent: &mut Value, roots: &[String]) {
    if let Some(obj) = agent.as_object_mut() {
        obj.retain(|k, _| VIEWER_FIELDS.contains(&k.as_str()));
        for key in ["title", "lastMessage"] {
            if let Some(text) = obj.get(key).and_then(Value::as_str) {
                let safe = view::viewer_title(text, roots);
                obj.insert(key.into(), Value::String(safe));
            }
        }
    }
}

/// Folders an agent works in (what viewers see paths relative to).
fn agent_roots(agent: &Agent) -> Vec<String> {
    vec![agent.cwd.clone(), agent.project_path.clone()]
}

/// A one-time pairing code: 122 random bits.
fn new_pairing_code() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Clamps a device name from the phone to something safe to list in Settings.
fn clean_device_name(raw: &str) -> String {
    let name: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect::<String>()
        .trim()
        .to_string();
    if name.is_empty() {
        "Phone".into()
    } else {
        name
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
            wanted: Mutex::new(None),
            generation,
            epoch: Mutex::new(0),
            apply_lock: tokio::sync::Mutex::new(()),
            shutting_down: std::sync::atomic::AtomicBool::new(false),
            error: Mutex::new(None),
            tokens_problem: Mutex::new(loaded.problem),
            save_lock: Mutex::new(()),
            persist: std::sync::atomic::AtomicBool::new(loaded.persist),
            failures: Mutex::new(HashMap::new()),
            pairing: Mutex::new(None),
            limiter: ConnLimiter::standard(),
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
        // Share links die with their agent: when it is deleted or archived.
        match event {
            ArmadaEvent::AgentRemoved { agent_id } => self.drop_shares_for(agent_id),
            ArmadaEvent::AgentUpdated { agent } if agent.archived => {
                self.drop_shares_for(&agent.id)
            }
            _ => {}
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

    fn drop_shares_for(&self, agent_id: &str) {
        let removed = {
            let mut tokens = self.tokens.lock();
            let before = tokens.shares.len();
            tokens.shares.retain(|s| s.agent_id != agent_id);
            before != tokens.shares.len()
        };
        if removed {
            self.save_tokens();
            self.bump_generation();
        }
    }

    /// The code on display for `base`, minting a fresh one when there is none, it
    /// expired, was used, or the server address changed. Returns (url, qr, expiry).
    fn pairing_for(&self, base: &str) -> (String, Option<String>, i64) {
        let mut slot = self.pairing.lock();
        if let Some(c) = slot.as_ref() {
            if c.base == base && c.expires > Instant::now() {
                return (c.url.clone(), c.qr_svg.clone(), c.expires_at_ms);
            }
        }
        let code = new_pairing_code();
        let url = format!("{base}/#pair={code}");
        let qr_svg = qrcode::QrCode::new(url.as_bytes()).ok().map(|qr| {
            qr.render::<qrcode::render::svg::Color<'_>>()
                .min_dimensions(220, 220)
                .quiet_zone(true)
                .dark_color(qrcode::render::svg::Color("#0B0D10"))
                .light_color(qrcode::render::svg::Color("#FFFFFF"))
                .build()
        });
        let expires_at_ms = now_ms() + PAIRING_TTL.as_millis() as i64;
        *slot = Some(PairingCode {
            hash: hash_token(&code),
            base: base.to_string(),
            url: url.clone(),
            qr_svg: qr_svg.clone(),
            expires: Instant::now() + PAIRING_TTL,
            expires_at_ms,
        });
        (url, qr_svg, expires_at_ms)
    }

    /// Spends `code` if it is the live pairing code (single use, constant time).
    fn redeem_pairing(&self, code: &str) -> bool {
        let mut slot = self.pairing.lock();
        let given = hash_token(code.trim());
        let ok = slot.as_ref().is_some_and(|c| {
            let same = constant_time_eq(&given, &c.hash);
            same && c.expires > Instant::now()
        });
        if ok || slot.as_ref().is_some_and(|c| c.expires <= Instant::now()) {
            *slot = None;
        }
        ok
    }

    /// Registers a device and returns its token (shown to the phone once).
    fn add_device(&self, name: &str) -> Result<String, ApiError> {
        let token = new_token();
        {
            let mut tokens = self.tokens.lock();
            if tokens.devices.len() >= MAX_DEVICES {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "Too many paired devices. Remove one in Armada's Settings → Remote first."
                        .into(),
                ));
            }
            tokens.devices.push(Device {
                id: uuid::Uuid::new_v4().simple().to_string(),
                name: clean_device_name(name),
                token_hash: hash_token(&token),
                created_at: now_ms(),
                last_seen: now_ms(),
            });
        }
        self.save_tokens();
        Ok(token)
    }

    /// Notes that a device used its token (saved at most once a minute).
    fn touch_device(&self, token: &str) {
        let hash = hash_token(token);
        let now = now_ms();
        let changed = {
            let mut tokens = self.tokens.lock();
            match tokens.devices.iter_mut().find(|d| d.token_hash == hash) {
                Some(d) if now - d.last_seen >= LAST_SEEN_STEP_MS => {
                    d.last_seen = now;
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.save_tokens();
        }
    }

    /// When the share link for `token` stops working (unix ms).
    fn share_expiry(&self, token: &str) -> Option<i64> {
        let hash = hash_token(token);
        self.tokens
            .lock()
            .shares
            .iter()
            .find(|s| constant_time_eq(&hash, &s.token_hash))
            .map(|s| s.expires_at)
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
        let listening = self.running.lock().as_ref().map(|r| r.addr);
        let running = listening.is_some();
        let lan_addresses = if settings.lan {
            lan_addresses()
        } else {
            Vec::new()
        };
        let firewall = listening
            .filter(|_| settings.lan)
            .and_then(|addr| lan_addresses.iter().find(|a| a.ip == addr.ip()))
            .and_then(|a| firewall_hint(a, settings.port));
        // Forget expired share links (they no longer authenticate anyway).
        let pruned = {
            let mut tokens = self.tokens.lock();
            let before = tokens.shares.len();
            let now = now_ms();
            tokens.shares.retain(|s| s.expires_at > now);
            before != tokens.shares.len()
        };
        if pruned {
            self.save_tokens();
        }
        let pairing = base
            .as_ref()
            .filter(|_| self.persist.load(std::sync::atomic::Ordering::SeqCst))
            .map(|b| self.pairing_for(b));
        let (pairing_url, qr_svg, pairing_expires_at) = match pairing {
            Some((url, qr, exp)) => (Some(url), qr, Some(exp)),
            None => (None, None, None),
        };
        let core = self.core();
        let tokens = self.tokens.lock();
        let shares = tokens
            .shares
            .iter()
            .map(|s| ShareLink {
                id: s.id(),
                agent_id: s.agent_id.clone(),
                agent_title: core.agent(&s.agent_id).ok().map(|a| a.title),
                url: None,
                created_at: s.created_at,
                expires_at: s.expires_at,
            })
            .collect();
        let devices = tokens
            .devices
            .iter()
            .map(|d| DeviceInfo {
                id: d.id.clone(),
                name: d.name.clone(),
                created_at: d.created_at,
                last_seen: d.last_seen,
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
            pairing_expires_at,
            error: self
                .error
                .lock()
                .clone()
                .or_else(|| self.tokens_problem.lock().clone()),
            shares,
            devices,
            lan_addresses,
            firewall,
        }
    }

    /// Unpairs every device (their tokens stop working and live streams end).
    pub fn unpair_all(&self) {
        {
            let mut tokens = self.tokens.lock();
            tokens.devices.clear();
            tokens.owner.clear();
        }
        *self.pairing.lock() = None;
        // An explicit unpair replaces even an unreadable file.
        self.persist
            .store(true, std::sync::atomic::Ordering::SeqCst);
        *self.tokens_problem.lock() = None;
        self.save_tokens();
        self.bump_generation();
    }

    /// Unpairs one device and ends its live streams.
    pub fn revoke_device(&self, id: &str) {
        self.tokens.lock().devices.retain(|d| d.id != id);
        self.save_tokens();
        self.bump_generation();
    }

    /// A read-only link to one agent, valid for `hours` (1, 24 or 168; default 24).
    pub fn create_share(&self, agent_id: &str, hours: Option<u32>) -> anyhow::Result<ShareLink> {
        let agent = self.core().agent(agent_id)?;
        let hours = hours
            .filter(|h| SHARE_HOURS.contains(h))
            .unwrap_or(DEFAULT_SHARE_HOURS);
        let token = new_token();
        let now = now_ms();
        let share = Share {
            token: String::new(),
            token_hash: hash_token(&token),
            agent_id: agent_id.to_string(),
            created_at: now,
            expires_at: now + i64::from(hours) * 3_600_000,
        };
        self.tokens.lock().shares.push(share.clone());
        self.save_tokens();
        Ok(ShareLink {
            id: share.id(),
            url: self.base_url().map(|b| format!("{b}/#token={token}")),
            agent_id: share.agent_id,
            agent_title: Some(agent.title),
            created_at: share.created_at,
            expires_at: share.expires_at,
        })
    }

    pub fn revoke_share(&self, id: &str) {
        self.tokens.lock().shares.retain(|s| s.id() != id);
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
        *self.wanted.lock() = settings.enabled.then(|| settings.clone());
        let unchanged = self.running.lock().as_ref().is_some_and(|r| {
            r.settings.lan == settings.lan
                && r.settings.port == settings.port
                && r.settings.lan_address == settings.lan_address
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
        let check = |this: &Self| {
            let running = this
                .running
                .lock()
                .as_ref()
                .map(|r| (r.settings.clone(), r.addr.ip()));
            let wanted = this.wanted.lock().clone();
            let current = running
                .as_ref()
                .map(|(s, _)| s)
                .or(wanted.as_ref())
                .and_then(lan_ip);
            lan_refresh_target(running, wanted, current)
        };
        let Some(settings) = check(self) else {
            return;
        };
        let _serialized = self.apply_lock.lock().await;
        if self.is_shutting_down() {
            return;
        }
        // Re-check under the lock: another apply may have handled it.
        if check(self).is_none() {
            return;
        }
        info!("LAN address changed or returned; (re)starting the remote server");
        let was_running = self.stop_and_wait().await;
        self.start_reporting(&settings, was_running).await;
    }

    async fn start(
        self: &Arc<Self>,
        settings: &RemoteSettings,
        retry_in_use: bool,
    ) -> Result<SocketAddr, String> {
        if !self.persist.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(self.tokens_problem.lock().clone().unwrap_or_else(|| {
                "Remote pairing data is unavailable; unpair devices to reset it.".into()
            }));
        }
        if settings.port < MIN_PORT {
            return Err(format!("Choose a port between {MIN_PORT} and 65535"));
        }
        let ip = if settings.lan {
            // Only private addresses are candidates: online with none means a public one.
            lan_ip(settings).ok_or_else(|| {
                if route_ip().is_some() {
                    PUBLIC_ADDRESS_MESSAGE.to_string()
                } else {
                    "No network connection found for LAN access. Connect to a network, or turn LAN access off.".to_string()
                }
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
        let task = tauri::async_runtime::spawn(serve(listener, router, rx, self.limiter.clone()));
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
        *self.pairing.lock() = None;
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
            // Unauthenticated by design (it trades a one-time code for a token).
            .route(
                "/api/pair",
                post(pair).layer(DefaultBodyLimit::max(4 * 1024)),
            )
            .merge(api)
            .layer(axum::middleware::map_response(no_store))
            .with_state(ctx)
    }

    /// Which credentials a token grants, without touching the failure counters.
    /// Expired share links grant nothing.
    fn token_scope(&self, token: &str) -> Option<Scope> {
        if token.is_empty() {
            return None;
        }
        let hash = hash_token(token);
        let now = now_ms();
        let tokens = self.tokens.lock();
        if tokens
            .devices
            .iter()
            .any(|d| constant_time_eq(&hash, &d.token_hash))
        {
            return Some(Scope::Owner);
        }
        tokens
            .shares
            .iter()
            .find(|s| s.expires_at > now && constant_time_eq(&hash, &s.token_hash))
            .map(|s| Scope::Viewer(s.agent_id.clone()))
    }

    /// Counts a failed attempt from `ip`: 401, or 429 once it has failed too often.
    fn record_failure(&self, ip: IpAddr, message: &str) -> ApiError {
        let mut failures = self.failures.lock();
        if failures.len() > 4096 {
            failures.retain(|_, (_, last)| last.elapsed() < LOCKOUT);
        }
        let entry = failures.entry(ip).or_insert((0, Instant::now()));
        if entry.1.elapsed() > LOCKOUT {
            *entry = (0, Instant::now());
        }
        if entry.0 >= MAX_FAILURES {
            return ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many failed attempts. Try again in a few minutes.".into(),
            );
        }
        entry.0 += 1;
        entry.1 = Instant::now();
        ApiError(StatusCode::UNAUTHORIZED, message.into())
    }

    /// Whether `ip` has used up its failed attempts.
    fn locked_out(&self, ip: IpAddr) -> bool {
        self.failures
            .lock()
            .get(&ip)
            .is_some_and(|(n, last)| *n >= MAX_FAILURES && last.elapsed() <= LOCKOUT)
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
            self.limiter.trust(ip);
            if scope == Scope::Owner {
                self.touch_device(&token);
            }
            return Ok((scope, token));
        }
        Err(self.record_failure(
            ip,
            "This device isn't paired with Armada (or was unpaired).",
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
        if !ok {
            return Err(ApiError(
                StatusCode::MISDIRECTED_REQUEST,
                "Unexpected host.".into(),
            ));
        }
        // Browsers add `Origin` to cross-origin and POST requests: it must be us.
        if let Some(origin) = headers.get(header::ORIGIN) {
            let own = format!("http://{host}");
            if !origin.to_str().is_ok_and(|o| o.eq_ignore_ascii_case(&own)) {
                return Err(ApiError(
                    StatusCode::FORBIDDEN,
                    "Cross-site requests aren't allowed.".into(),
                ));
            }
        }
        Ok(())
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

/// Reads the pairing data. Only a missing file means "first run, nothing paired":
/// a damaged file is kept as a backup and reported (re-pairing is unavoidable), and an
/// unreadable one is left alone, with remote access unavailable until it's fixed or
/// the user unpairs, rather than silently unpairing every device. Files from older
/// versions (plaintext owner and share tokens) are upgraded: see `Tokens::migrate`.
fn load_tokens(path: &std::path::Path) -> LoadedTokens {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return LoadedTokens {
                tokens: Tokens::default(),
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
        Ok(mut tokens) if tokens.owner.is_empty() || tokens.owner.len() >= 32 => {
            tokens.migrate(now_ms());
            LoadedTokens {
                tokens,
                // Rewrite anyway so older files get owner-only permissions.
                dirty: true,
                persist: true,
                problem: None,
            }
        }
        _ => {
            let backup = path.with_extension(format!("json.damaged-{}", now_ms()));
            let kept = std::fs::copy(path, &backup).is_ok();
            LoadedTokens {
                tokens: Tokens::default(),
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

/// Accept loop for the remote server: connections are admitted by `limiter` (total,
/// per-address and reserved-for-authenticated caps; others are closed at once),
/// request headers within `HEADER_READ_TIMEOUT`. On shutdown, stops accepting and lets open
/// connections finish (live streams end via the generation bump).
async fn serve(
    listener: tokio::net::TcpListener,
    router: Router,
    mut shutdown: oneshot::Receiver<()>,
    limiter: Arc<ConnLimiter>,
) {
    use tower::ServiceExt;

    let (closing_tx, closing_rx) = watch::channel(false);
    let mut connections = tokio::task::JoinSet::new();
    loop {
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
        let Some(permit) = limiter.admit(peer.ip()) else {
            // Over a cap: drop the connection rather than queue it.
            drop(stream);
            continue;
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairBody {
    code: String,
    #[serde(default)]
    device_name: String,
}

/// Trades the one-time pairing code for this device's own token. Unauthenticated,
/// so it is rate limited per address and the code is compared in constant time.
async fn pair(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Json(body): Json<PairBody>,
) -> Result<Json<Value>, ApiError> {
    let remote = &c.remote;
    remote.check_origin(c.epoch, &headers)?;
    if remote.locked_out(peer.ip()) {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many failed attempts. Try again in a few minutes.".into(),
        ));
    }
    if !remote.redeem_pairing(&body.code) {
        return Err(remote.record_failure(
            peer.ip(),
            "That pairing code didn't work or has expired. Show a fresh QR code in Armada.",
        ));
    }
    let token = remote.add_device(&body.device_name)?;
    remote.limiter.trust(peer.ip());
    Ok(Json(json!({ "token": token, "scope": "owner" })))
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
            let roots = agent_roots(&a);
            let mut v = serde_json::to_value(a).unwrap_or_default();
            if scope != Scope::Owner {
                trim_agent(&mut v, &roots);
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
    let roots = agent_roots(&core.agent(&id)?);
    let viewer = scope != Scope::Owner;
    let items = tokio::task::spawn_blocking(move || {
        if viewer {
            return viewer_items(&core, &id, q.before_seq, q.limit, &roots);
        }
        match q.limit {
            Some(limit) => core.items_page(&id, q.before_seq, limit.clamp(1, 1000)),
            None => core.items(&id),
        }
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))??;
    Ok(Json(items).into_response())
}

/// A viewer's page of the timeline: only what `view::project_item` lets through.
/// Items viewers don't get are skipped, so older pages are read until `limit`
/// visible items are found (the phone treats a short page as "no more history").
fn viewer_items(
    core: &Core,
    id: &str,
    before_seq: Option<i64>,
    limit: Option<usize>,
    roots: &[String],
) -> anyhow::Result<Vec<armada_core::TimelineItem>> {
    let Some(limit) = limit else {
        return Ok(view::project_items(&core.items(id)?, roots));
    };
    let limit = limit.clamp(1, 1000);
    let mut before = before_seq;
    let mut out: Vec<armada_core::TimelineItem> = Vec::new();
    for _ in 0..20 {
        let raw = core.items_page(id, before, limit)?;
        let Some(oldest) = raw.iter().map(|i| i.seq).min() else {
            break;
        };
        before = Some(oldest);
        let mut page = view::project_items(&raw, roots);
        page.append(&mut out);
        out = page;
        if out.len() >= limit || raw.len() < limit {
            break;
        }
    }
    if out.len() > limit {
        out = out.split_off(out.len() - limit);
    }
    Ok(out)
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
    // Viewers never see approval requests (they hold raw commands and paths).
    if scope != Scope::Owner {
        return Ok(Json(Vec::new()));
    }
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

/// Viewers may fetch an image only if it is inside the agent's project and the
/// conversation they are shown mentions it.
fn check_viewer_image(core: &Core, id: &str, path: &str) -> anyhow::Result<()> {
    let denied = || anyhow::anyhow!("not found: that image isn't part of what this link shows");
    let agent = core.agent(id)?;
    let input = path.trim();
    if input.is_empty() || input.starts_with("file:") {
        return Err(denied());
    }
    let requested = std::path::PathBuf::from(input);
    let full = if requested.is_absolute() {
        requested
    } else {
        std::path::PathBuf::from(&agent.cwd).join(requested)
    };
    let real = full.canonicalize().map_err(|_| denied())?;
    let mut relative = None;
    let mut inside = false;
    for root in [&agent.cwd, &agent.project_path] {
        if let Ok(root) = std::path::Path::new(root).canonicalize() {
            if let Ok(rel) = real.strip_prefix(&root) {
                inside = true;
                relative.get_or_insert_with(|| rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    if !inside {
        return Err(denied());
    }
    let visible = view::project_items(&core.items(id)?, &agent_roots(&agent));
    if view::mentions_path(&visible, input, relative.as_deref()) {
        Ok(())
    } else {
        Err(denied())
    }
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
    let scope = c.auth(&peer, &headers)?;
    visible(&scope, &id)?;
    let core = c.remote.core();
    let viewer = scope != Scope::Owner;
    let image = tokio::task::spawn_blocking(move || {
        if viewer {
            check_viewer_image(&core, &id, &q.path)?;
        }
        core.read_image(&id, &q.path)
    })
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
    /// What a viewer sees paths relative to.
    roots: Vec<String>,
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
                                trim_agent(&mut v["agent"], &self.roots);
                                return Some(v.to_string());
                            }
                            // Messages and a tool outline only; no streamed text or output.
                            PublishedKind::Other => {
                                if let Some(msg) = view::project_event(&event.json, &self.roots) {
                                    return Some(msg);
                                }
                            }
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
    let mut lifetime = STREAM_LIFETIME;
    if let Scope::Viewer(_) = &scope {
        // A share link's stream ends when the link expires.
        if let Some(exp) = c.remote.share_expiry(&token) {
            let left = u64::try_from(exp - now_ms()).unwrap_or(0);
            lifetime = lifetime.min(Duration::from_millis(left));
        }
    }
    let roots = match &scope {
        Scope::Viewer(id) => c
            .remote
            .core()
            .agent(id)
            .map(|a| agent_roots(&a))
            .unwrap_or_default(),
        Scope::Owner => Vec::new(),
    };
    let state = Stream_ {
        _slot: slot,
        deadline: tokio::time::Instant::now() + lifetime,
        rx,
        generation,
        remote: c.remote.clone(),
        epoch: c.epoch,
        token,
        scope,
        roots,
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
    #[test]
    fn lan_refresh_decisions() {
        let rs = |enabled, lan| RemoteSettings {
            enabled,
            lan,
            port: 7000,
            ..Default::default()
        };
        let a: IpAddr = "192.168.1.5".parse().unwrap();
        let b: IpAddr = "192.168.1.9".parse().unwrap();
        let public: IpAddr = "8.8.8.8".parse().unwrap();
        // Running, address unchanged / changed / network gone.
        assert!(lan_refresh_target(Some((rs(true, true), a)), None, Some(a)).is_none());
        assert!(lan_refresh_target(Some((rs(true, true), a)), None, Some(b)).is_some());
        assert!(lan_refresh_target(Some((rs(true, true), a)), None, None).is_some());
        assert!(lan_refresh_target(Some((rs(true, false), a)), None, Some(b)).is_none());
        // Stopped by a network drop: recover once a private address is back.
        assert!(lan_refresh_target(None, Some(rs(true, true)), Some(b)).is_some());
        assert!(lan_refresh_target(None, Some(rs(true, true)), None).is_none());
        assert!(lan_refresh_target(None, Some(rs(true, true)), Some(public)).is_none());
        // Stopped by the user, or loopback-only: never auto-started.
        assert!(lan_refresh_target(None, None, Some(b)).is_none());
        assert!(lan_refresh_target(None, Some(rs(false, true)), Some(b)).is_none());
        assert!(lan_refresh_target(None, Some(rs(true, false)), Some(b)).is_none());
    }

    #[test]
    fn lan_address_kinds() {
        let kind = |name, ip: &str, prefix, p2p| classify(name, ip.parse().unwrap(), prefix, p2p);
        use NetworkKind::*;
        assert_eq!(kind("eno1", "192.168.1.107", 24, false), Some(Lan));
        assert_eq!(kind("wlan0", "10.0.0.12", 8, false), Some(Lan));
        assert_eq!(kind("Wi-Fi", "172.20.10.3", 28, false), Some(Lan));
        assert_eq!(kind("en0", "192.168.0.4", 24, false), Some(Lan));
        // Proton VPN: the WireGuard tunnel and its kill-switch dummy (100.85.0.1/24).
        assert_eq!(kind("proton0", "10.2.0.2", 32, true), Some(Vpn));
        assert_eq!(kind("pvpnksintrf0", "100.85.0.1", 24, false), Some(Vpn));
        assert_eq!(kind("ProtonVPN", "10.2.0.2", 32, false), Some(Vpn));
        assert_eq!(kind("wg0", "10.8.0.2", 24, false), Some(Vpn));
        assert_eq!(kind("tun0", "10.8.0.6", 24, false), Some(Vpn));
        assert_eq!(kind("tailscale0", "100.101.1.2", 32, true), Some(Tailscale));
        assert_eq!(kind("Tailscale", "100.101.1.2", 10, false), Some(Tailscale));
        assert_eq!(kind("utun4", "100.101.1.2", 32, true), Some(Tailscale));
        assert_eq!(kind("docker0", "172.17.0.1", 16, false), Some(Virtual));
        assert_eq!(
            kind(
                "vEthernet (WSL (Hyper-V firewall))",
                "172.29.0.1",
                20,
                false
            ),
            Some(Virtual)
        );
        assert_eq!(kind("eno1", "8.8.8.8", 24, false), None);
        assert_eq!(kind("lo", "127.0.0.1", 8, false), None);
        assert_eq!(kind("eno1", "169.254.3.4", 16, false), None);
    }

    #[test]
    fn lan_address_choice_skips_the_vpn() {
        let a = |interface: &str, ip: &str, kind| LanAddress {
            ip: ip.parse().unwrap(),
            interface: interface.into(),
            kind,
            prefix_len: 24,
        };
        let mut list = vec![
            a("pvpnksintrf0", "100.85.0.1", NetworkKind::Vpn),
            a("proton0", "10.2.0.2", NetworkKind::Vpn),
            a("docker0", "172.17.0.1", NetworkKind::Virtual),
            a("tailscale0", "100.101.1.2", NetworkKind::Tailscale),
            a("eno1", "192.168.1.107", NetworkKind::Lan),
        ];
        // The default route goes through the VPN; the Wi-Fi/Ethernet address still wins.
        rank_lan_addresses(&mut list, Some("10.2.0.2".parse().unwrap()));
        let order: Vec<&str> = list.iter().map(|a| a.interface.as_str()).collect();
        assert_eq!(
            order,
            ["eno1", "tailscale0", "proton0", "pvpnksintrf0", "docker0"]
        );
        let eno1: IpAddr = "192.168.1.107".parse().unwrap();
        assert_eq!(choose_lan(&list, None), Some(eno1));
        // The user's pick, while it still exists.
        assert_eq!(
            choose_lan(&list, Some("100.101.1.2")),
            Some("100.101.1.2".parse().unwrap())
        );
        assert_eq!(choose_lan(&list, Some("192.168.9.9")), Some(eno1));
        assert_eq!(choose_lan(&list, Some("nonsense")), Some(eno1));
        assert_eq!(choose_lan(&[], None), None);

        // Two real networks: the one the default route uses.
        let mut two = vec![
            a("eth0", "192.168.1.5", NetworkKind::Lan),
            a("wlan0", "192.168.50.7", NetworkKind::Lan),
        ];
        rank_lan_addresses(&mut two, Some("192.168.50.7".parse().unwrap()));
        assert_eq!(two[0].interface, "wlan0");
    }

    #[test]
    fn ufw_rules_and_subnets() {
        let rules = "\
### tuple ### allow tcp 53317 0.0.0.0/0 any 0.0.0.0/0 in
-A ufw-user-input -p tcp --dport 53317 -j ACCEPT
-A ufw-user-input -p udp --dport 47821 -j ACCEPT
-A ufw-user-input -p tcp --dport 47900 -s 192.168.1.0/24 -j DROP
-A ufw-user-input -p tcp -m multiport --dports 8000:8100,9000 -j ACCEPT
";
        assert!(ufw_allows(rules, 53317));
        assert!(!ufw_allows(rules, 47821), "udp only");
        assert!(!ufw_allows(rules, 47900), "denied");
        assert!(ufw_allows(rules, 8050) && ufw_allows(rules, 9000));
        assert!(!ufw_allows(rules, 8101));
        let subnet_rule =
            "-A ufw-user-input -p tcp -d 192.168.1.107 --dport 47821 -s 192.168.1.0/24 -j ACCEPT\n";
        assert!(ufw_allows(subnet_rule, 47821));
        assert!(
            ufw_allows("-A ufw-user-input --dport 47821 -j ACCEPT", 47821),
            "any protocol"
        );

        let cidr = |ip: &str, prefix_len| {
            network_cidr(&LanAddress {
                ip: ip.parse().unwrap(),
                interface: "x".into(),
                kind: NetworkKind::Lan,
                prefix_len,
            })
        };
        assert_eq!(cidr("192.168.1.107", 24), "192.168.1.0/24");
        assert_eq!(cidr("10.20.30.40", 8), "10.0.0.0/8");
        assert_eq!(cidr("172.20.10.3", 28), "172.20.10.0/28");
        assert_eq!(cidr("100.101.1.2", 32), "100.101.1.2/32");

        let lan = LanAddress {
            ip: "192.168.1.107".parse().unwrap(),
            interface: "eno1".into(),
            kind: NetworkKind::Lan,
            prefix_len: 24,
        };
        assert_eq!(
            ufw_command(&lan, 47821),
            "sudo ufw allow from 192.168.1.0/24 to any port 47821 proto tcp"
        );
        let ts = LanAddress {
            ip: "100.101.1.2".parse().unwrap(),
            interface: "tailscale0".into(),
            kind: NetworkKind::Tailscale,
            prefix_len: 32,
        };
        assert_eq!(
            ufw_command(&ts, 47821),
            "sudo ufw allow in on tailscale0 to any port 47821 proto tcp"
        );
        let in_on = "-A ufw-user-input -i tailscale0 -p tcp --dport 47821 -j ACCEPT";
        assert!(ufw_allows(in_on, 47821));
    }

    /// What this machine would pick (run with --ignored --nocapture to see).
    #[test]
    #[ignore]
    fn print_lan_addresses() {
        for a in lan_addresses() {
            println!("{a:?}");
        }
    }

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
                    ..Default::default()
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
        // The QR/link holds a one-time code, never a long-lived token.
        let pairing_url = status.pairing_url.clone().unwrap();
        assert!(
            pairing_url.starts_with(&format!("{base}/#pair=")),
            "{pairing_url}"
        );
        assert!(!pairing_url.contains("token"));
        assert!(status.pairing_expires_at.is_some());
        let pair_code = pairing_url.rsplit("#pair=").next().unwrap().to_string();
        // Wrong codes are refused; the right one works once and yields a device token.
        let (code, _) = call(
            "POST",
            format!("{base}/api/pair"),
            None,
            Some(json!({ "code": "not-the-code", "deviceName": "Pixel" })),
        )
        .await;
        assert_eq!(code, 401);
        let (code, body) = call(
            "POST",
            format!("{base}/api/pair"),
            None,
            Some(json!({ "code": pair_code, "deviceName": "Pixel 9" })),
        )
        .await;
        assert_eq!(code, 200, "{body}");
        let paired: Value = serde_json::from_str(&body).unwrap();
        let owner = paired["token"].as_str().unwrap().to_string();
        let (code, _) = call(
            "POST",
            format!("{base}/api/pair"),
            None,
            Some(json!({ "code": pair_code, "deviceName": "Again" })),
        )
        .await;
        assert_eq!(code, 401, "a pairing code works once");
        // The next status shows a fresh code and lists the device (by name, not token).
        let status2 = remote.status();
        assert_ne!(status2.pairing_url.as_deref(), Some(pairing_url.as_str()));
        assert_eq!(status2.devices.len(), 1);
        assert_eq!(status2.devices[0].name, "Pixel 9");
        let saved = std::fs::read_to_string(dir.join("data").join("remote.json")).unwrap();
        assert!(!saved.contains(&owner), "tokens are stored hashed");
        assert!(saved.contains(&hash_token(&owner)));

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
        let share = remote.create_share(&agent.id, Some(1)).unwrap();
        let share_token = share
            .url
            .as_deref()
            .and_then(|u| u.rsplit("#token=").next())
            .unwrap()
            .to_string();
        assert!(share.expires_at - share.created_at <= 3_600_000);
        let saved = std::fs::read_to_string(dir.join("data").join("remote.json")).unwrap();
        assert!(
            !saved.contains(&share_token),
            "share tokens are stored hashed"
        );
        let (code, body) = call(
            "GET",
            format!("{base}/api/session"),
            Some(share_token.clone()),
            None,
        )
        .await;
        assert_eq!(code, 200);
        assert!(body.contains(r#""scope":"viewer""#));
        let (_, body) = call(
            "GET",
            format!("{base}/api/state"),
            Some(share_token.clone()),
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
        // Viewers get no approval requests, tool output or permission items.
        let (code, body) = call(
            "GET",
            format!("{base}/api/permissions"),
            Some(share_token.clone()),
            None,
        )
        .await;
        assert_eq!((code, body.trim()), (200, "[]"));
        let (code, body) = call(
            "GET",
            format!("{base}/api/agents/{}/items", agent.id),
            Some(share_token.clone()),
            None,
        )
        .await;
        assert_eq!(code, 200);
        assert!(!body.contains(r#""kind":"permission""#), "{body}");
        assert!(!body.contains(r#""kind":"thought""#), "{body}");
        let (code, _) = call(
            "GET",
            format!("{base}/api/agents/{}/image?path=/etc/hostname", agent.id),
            Some(share_token.clone()),
            None,
        )
        .await;
        assert_eq!(code, 404, "viewers can't fetch arbitrary files");
        // Tokens are only accepted in the Authorization header (never in URLs).
        for path in ["state", "events"] {
            let (code, _) = call(
                "GET",
                format!("{base}/api/{path}?token={}", share_token),
                None,
                None,
            )
            .await;
            assert_eq!(code, 401, "{path}");
        }
        let mut viewer_stream = open_stream(format!("{base}/api/events"), &share_token);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let (code, _) = call(
            "POST",
            format!("{base}/api/agents/{}/prompt", agent.id),
            Some(share_token.clone()),
            Some(json!({ "text": "hi" })),
        )
        .await;
        assert_eq!(code, 403);
        let (code, _) = call(
            "POST",
            format!("{base}/api/agents/{}/stop", agent.id),
            Some(share_token.clone()),
            None,
        )
        .await;
        assert_eq!(code, 403);
        let (code, _) = call(
            "GET",
            format!("{base}/api/agents/someone-else/items"),
            Some(share_token.clone()),
            None,
        )
        .await;
        assert_eq!(code, 404);
        remote.revoke_share(&share.id);
        assert_eq!(
            call(
                "GET",
                format!("{base}/api/session"),
                Some(share_token.clone()),
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

        assert_eq!(
            raw(port, format!("GET /api/session HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://evil.example\r\nAuthorization: Bearer {owner}\r\nConnection: close\r\n\r\n")).await,
            403
        );
        assert_eq!(
            raw(port, format!("GET /api/session HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nAuthorization: Bearer {owner}\r\nConnection: close\r\n\r\n")).await,
            200
        );

        // Revoking one device ends its streams and leaves the others alone.
        let second = remote.add_device("Second phone").unwrap();
        let mut second_stream = open_stream(format!("{base}/api/events"), &second);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let second_id = remote
            .status()
            .devices
            .iter()
            .find(|d| d.name == "Second phone")
            .unwrap()
            .id
            .clone();
        remote.revoke_device(&second_id);
        assert!(
            stream_ends(&mut second_stream).await,
            "revoking a device ends its live stream"
        );
        assert_eq!(
            call("GET", format!("{base}/api/session"), Some(second), None)
                .await
                .0,
            401
        );
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

        // Owner can prompt; unpairing all devices ends their access.
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
        remote.unpair_all();
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
        let owner = remote.add_device("After unpair").unwrap();

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
                ..Default::default()
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
                ..Default::default()
            })
            .await;
        let started = Instant::now();
        remote
            .apply(&RemoteSettings {
                enabled: true,
                lan: false,
                port: taken,
                ..Default::default()
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
                ..Default::default()
            })
            .await;
        let st = remote.status();
        assert!(!st.running && st.error.unwrap().contains("1024"));

        remote
            .apply(&RemoteSettings {
                enabled: false,
                lan: false,
                port: 80,
                ..Default::default()
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
                ..Default::default()
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

        // First run: nothing paired yet.
        let mut first = load_tokens(&path);
        assert!(first.persist && first.dirty && first.problem.is_none());
        assert!(first.tokens.devices.is_empty() && first.tokens.owner.is_empty());
        first.tokens.devices.push(Device {
            id: "d1".into(),
            name: "Phone".into(),
            token_hash: hash_token("tok"),
            created_at: 1,
            last_seen: 2,
        });

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
        assert_eq!(again.tokens.devices.len(), 1);
        assert_eq!(again.tokens.devices[0].token_hash, hash_token("tok"));
        assert!(again.problem.is_none());

        // Damaged: reset, but the old file is kept and the user told.
        std::fs::write(&path, b"{not json").unwrap();
        let damaged = load_tokens(&path);
        assert!(damaged.persist);
        assert!(damaged.tokens.devices.is_empty());
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
        assert!(blocked.tokens.devices.is_empty());
        assert!(blocked.problem.is_some());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn legacy_plaintext_tokens_are_migrated_and_hashed() {
        let dir = temp_dir();
        let path = dir.join("remote.json");
        let owner = new_token();
        let share = new_token();
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({
                "owner": owner,
                "shares": [{ "token": share, "agentId": "a1", "createdAt": 5 }],
            }))
            .unwrap(),
        )
        .unwrap();
        let loaded = load_tokens(&path);
        assert!(loaded.persist && loaded.dirty && loaded.problem.is_none());
        let tokens = loaded.tokens;
        assert!(tokens.owner.is_empty());
        // The existing phone keeps working, as one legacy device.
        assert_eq!(tokens.devices.len(), 1);
        assert_eq!(tokens.devices[0].token_hash, hash_token(&owner));
        assert_eq!(tokens.shares[0].token_hash, hash_token(&share));
        assert!(tokens.shares[0].token.is_empty());
        assert!(
            tokens.shares[0].expires_at > now_ms(),
            "legacy shares get an expiry"
        );
        // What is written back has no plaintext.
        let written = serde_json::to_string(&tokens).unwrap();
        assert!(!written.contains(&owner) && !written.contains(&share));
        // Idempotent.
        let mut again = serde_json::from_str::<Tokens>(&written).unwrap();
        assert!(!again.migrate(now_ms()));
        assert_eq!(again.devices.len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    struct NullSink;
    impl EventSink for NullSink {
        fn emit(&self, _event: ArmadaEvent) {}
    }

    fn test_remote(dir: &std::path::Path) -> (Arc<Remote>, Core) {
        let core = Core::open(dir.join("core"), Arc::new(NullSink)).unwrap();
        std::fs::create_dir_all(dir.join("data")).unwrap();
        let remote = Remote::new(core.clone(), "0.0.0".into(), dir.join("data"));
        (remote, core)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn pairing_codes_are_single_use_and_expire() {
        let dir = temp_dir();
        let (remote, core) = test_remote(&dir);
        let base = "http://127.0.0.1:4000";
        let (url, qr, expires_at) = remote.pairing_for(base);
        let code = url
            .strip_prefix(&format!("{base}/#pair="))
            .unwrap()
            .to_string();
        assert!(qr.is_some_and(|q| q.contains("<svg")));
        assert!(code.len() >= 32, "high-entropy code");
        assert!(expires_at > now_ms() && expires_at <= now_ms() + 5 * 60 * 1000 + 1000);
        // Same code is shown until used.
        assert_eq!(remote.pairing_for(base).0, url);
        assert!(!remote.redeem_pairing("wrong"));
        assert!(remote.redeem_pairing(&code));
        assert!(!remote.redeem_pairing(&code), "single use");
        let (next, _, _) = remote.pairing_for(base);
        assert_ne!(next, url);
        // A different server address gets a different code.
        assert_ne!(remote.pairing_for("http://127.0.0.1:4001").0, next);

        // Expired codes are refused.
        let (url, _, _) = remote.pairing_for(base);
        let code = url.rsplit("#pair=").next().unwrap().to_string();
        remote.pairing.lock().as_mut().unwrap().expires = Instant::now() - Duration::from_secs(1);
        assert!(!remote.redeem_pairing(&code), "expired");
        assert!(remote.pairing.lock().is_none());
        core.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn device_tokens_are_hashed_at_rest_and_survive_restart() {
        let dir = temp_dir();
        let (remote, core) = test_remote(&dir);
        let token = remote.add_device("  Pixel \u{7}9  ").unwrap();
        assert_eq!(remote.tokens.lock().devices[0].name, "Pixel 9");
        assert_eq!(remote.token_scope(&token), Some(Scope::Owner));
        assert_eq!(
            remote.token_scope(&hash_token(&token)),
            None,
            "the hash is not a token"
        );
        let file = std::fs::read_to_string(dir.join("data").join("remote.json")).unwrap();
        assert!(!file.contains(&token));
        assert!(file.contains(&hash_token(&token)));
        // A restart (re-reading the file) keeps the device.
        let again = Remote::new(core.clone(), "0.0.0".into(), dir.join("data"));
        assert_eq!(again.token_scope(&token), Some(Scope::Owner));
        again.unpair_all();
        assert_eq!(again.token_scope(&token), None);
        assert!(again.status().devices.is_empty());
        core.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn share_links_expire() {
        let dir = temp_dir();
        let (remote, core) = test_remote(&dir);
        let project = dir.join("p");
        std::fs::create_dir_all(&project).unwrap();
        let token = new_token();
        {
            let mut tokens = remote.tokens.lock();
            for (i, expires_at) in [now_ms() + 60_000, now_ms() - 1].into_iter().enumerate() {
                tokens.shares.push(Share {
                    token: String::new(),
                    token_hash: hash_token(&format!("{token}{i}")),
                    agent_id: "a1".into(),
                    created_at: 1,
                    expires_at,
                });
            }
        }
        assert_eq!(
            remote.token_scope(&format!("{token}0")),
            Some(Scope::Viewer("a1".into()))
        );
        assert_eq!(remote.token_scope(&format!("{token}1")), None, "expired");
        assert!(remote.share_expiry(&format!("{token}0")).is_some());
        // Status forgets expired shares; archived or removed agents drop theirs.
        assert_eq!(remote.status().shares.len(), 1);
        remote.publish(&ArmadaEvent::AgentRemoved {
            agent_id: "a1".into(),
        });
        assert!(remote.status().shares.is_empty());
        assert_eq!(remote.token_scope(&format!("{token}0")), None);
        // Unknown lifetimes fall back to the default; known ones are honored.
        assert_eq!(SHARE_HOURS, [1, 24, 168]);
        core.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn private_addresses_only() {
        let yes = [
            "10.0.0.5",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.20",
            "100.64.0.1",
            "100.100.1.1",
            "100.127.255.254",
            "169.254.10.10",
            "fd12:3456::1",
            "fc00::1",
            "fe80::1",
            "::ffff:192.168.1.2",
        ];
        let no = [
            "8.8.8.8",
            "172.32.0.1",
            "100.63.255.255",
            "100.128.0.1",
            "11.0.0.1",
            "203.0.113.9",
            "2606:4700::1111",
            "::ffff:8.8.8.8",
        ];
        for ip in yes {
            assert!(is_private_address(ip.parse().unwrap()), "{ip}");
        }
        for ip in no {
            assert!(!is_private_address(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn connection_limiter_caps_peers_and_reserves_slots() {
        let limiter = Arc::new(ConnLimiter::new(10, 4, 2, 5));
        let a: IpAddr = "192.168.1.10".parse().unwrap();
        let b: IpAddr = "192.168.1.11".parse().unwrap();
        let c: IpAddr = "192.168.1.12".parse().unwrap();
        // One unauthenticated address can't take more than its share.
        let g1 = limiter.admit(a).unwrap();
        let _g2 = limiter.admit(a).unwrap();
        assert!(limiter.admit(a).is_none(), "per-address cap");
        drop(g1);
        let _g3 = limiter.admit(a).expect("slot released on drop");
        // Unauthenticated peers stop at max - reserved; authenticated ones keep going.
        let mut held = Vec::new();
        for ip in [b, b, c, c] {
            held.push(limiter.admit(ip).unwrap());
        }
        assert_eq!(limiter.state.lock().total, 6);
        let d: IpAddr = "192.168.1.13".parse().unwrap();
        assert!(
            limiter.admit(d).is_none(),
            "reserved slots are not for strangers"
        );
        limiter.trust(d);
        for _ in 0..4 {
            held.push(limiter.admit(d).unwrap());
        }
        assert!(limiter.admit(d).is_none(), "total cap");
        drop(held);
        // Loopback only counts toward the total.
        let lo: IpAddr = "127.0.0.1".parse().unwrap();
        let many: Vec<_> = (0..3).map(|_| limiter.admit(lo).unwrap()).collect();
        assert_eq!(many.len(), 3);
        // IPv4-mapped addresses are the same peer.
        let mapped: IpAddr = "::ffff:192.168.1.10".parse().unwrap();
        assert!(limiter.admit(mapped).is_none(), "same peer as {a}");
    }
}
