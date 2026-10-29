//! Preview pane reverse proxy.
//!
//! The Preview pane shows a local dev server in a cross-origin iframe, so the app can't see the page's
//! console, DOM or pixels. This module runs a small per-agent proxy on `127.0.0.1` in front of the
//! chosen dev server. It forwards HTTP (streaming, all methods, redirects rewritten) and WebSocket
//! upgrades (HMR keeps working), and injects one `<script>` into HTML responses: the preview agent
//! (`assets/preview-agent.js`), which reports console errors, runs the element picker and takes
//! screenshots, talking to the app only through `postMessage`.
//!
//! Security: the proxy binds loopback only; its upstream is fixed at start and must be a loopback
//! `http://` address (no open proxy, no SSRF to other hosts); requests whose `Host` isn't the proxy's own
//! address are refused (DNS rebinding); it stops with the pane.

use std::collections::HashMap;
use std::convert::Infallible;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::stream;
use http_body_util::{combinators::BoxBody, BodyExt, Empty, Full, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::State;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

type CmdResult<T> = Result<T, String>;
type Body = BoxBody<Bytes, io::Error>;

/// The agent script, built by `npm run build:preview-agent`.
const AGENT_JS: &str = include_str!("../assets/preview-agent.js");
const AGENT_PATH: &str = "/__armada/preview-agent.js";
const SCRIPT_TAG: &str = "<script src=\"/__armada/preview-agent.js\"></script>";
/// How much HTML is looked at for an insertion point before giving up on `<head>`.
const SNIFF_LIMIT: usize = 64 * 1024;
/// Compressed HTML is decoded in memory, up to this size (before and after decoding).
const DECODE_LIMIT: usize = 32 * 1024 * 1024;

/// A validated preview target: a loopback dev server speaking plain HTTP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// `localhost`, `127.0.0.1` or `[::1]`, as written (used for the Host header).
    pub host: String,
    pub port: u16,
    /// Path and query to open first.
    pub path: String,
}

impl Target {
    fn authority(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
    fn origin(&self) -> String {
        format!("http://{}", self.authority())
    }
    fn connect_host(&self) -> &str {
        self.host.trim_start_matches('[').trim_end_matches(']')
    }
}

/// Accepts only `http://localhost|127.0.0.1|[::1][:port][/path]`. Anything else (other hosts, https,
/// userinfo, other schemes) is refused before any socket is opened.
pub fn parse_target(raw: &str) -> Result<Target, String> {
    let raw = raw.trim();
    let rest = raw
        .strip_prefix("http://")
        .ok_or("Only http:// addresses on localhost can be previewed with page tools")?;
    let (authority, path) = match rest.find(['/', '?', '#']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if authority.contains('@') {
        return Err("Credentials in the address aren't supported".into());
    }
    let (host, port) = if let Some(after) = authority.strip_prefix('[') {
        let (h, tail) = after.split_once(']').ok_or("Invalid address")?;
        (format!("[{h}]"), tail.strip_prefix(':'))
    } else {
        match authority.split_once(':') {
            Some((h, p)) => (h.to_string(), Some(p)),
            None => (authority.to_string(), None),
        }
    };
    if !matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "[::1]"
    ) {
        return Err("Only localhost, 127.0.0.1 and [::1] can be previewed".into());
    }
    let port: u16 = match port {
        Some(p) => p.parse().map_err(|_| "Invalid port")?,
        None => 80,
    };
    if port == 0 {
        return Err("Invalid port".into());
    }
    let path = path.split('#').next().unwrap_or("");
    let path = if path.is_empty() {
        "/".to_string()
    } else if path.starts_with('?') {
        format!("/{path}")
    } else {
        path.to_string()
    };
    Ok(Target {
        host: host.to_ascii_lowercase(),
        port,
        path,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct ProxyInfo {
    /// Where the iframe should load (the target's path on the proxy origin).
    pub url: String,
    /// Per-session secret. The page never sees it before the app sends it over postMessage.
    pub token: String,
}

struct Running {
    target: Target,
    port: u16,
    token: String,
    shutdown: watch::Sender<bool>,
}

impl Running {
    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.port, path)
    }
}

/// One proxy per agent.
#[derive(Default)]
pub struct PreviewProxies(Mutex<HashMap<String, Running>>);

fn stable_port(agent_id: &str, target_port: u16) -> u16 {
    // FNV-1a: the same agent + dev server gets the same proxy port again, so the page keeps its
    // origin (localStorage, cookies) across pane reopenings.
    let mut h: u32 = 0x811c_9dc5;
    for b in agent_id.bytes().chain(target_port.to_be_bytes()) {
        h = (h ^ u32::from(b)).wrapping_mul(0x0100_0193);
    }
    49152 + (h % 16000) as u16
}

impl PreviewProxies {
    pub async fn start(&self, agent_id: &str, raw_target: &str) -> Result<ProxyInfo, String> {
        let target = parse_target(raw_target)?;
        let old = {
            let mut map = self.0.lock();
            if let Some(r) = map.get(agent_id) {
                if r.target.host == target.host
                    && r.target.port == target.port
                    && !*r.shutdown.borrow()
                {
                    return Ok(ProxyInfo {
                        url: r.url(&target.path),
                        token: r.token.clone(),
                    });
                }
            }
            map.remove(agent_id)
        };
        if let Some(r) = old {
            let _ = r.shutdown.send(true);
        }
        let first = stable_port(agent_id, target.port);
        let mut listener = None;
        for p in [first, first.wrapping_add(1).max(49152), 0] {
            if let Ok(l) = TcpListener::bind(("127.0.0.1", p)).await {
                listener = Some(l);
                break;
            }
        }
        let listener = listener.ok_or("Couldn't open a local port for the preview proxy")?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let (tx, rx) = watch::channel(false);
        let ctx = Arc::new(Ctx {
            target: target.clone(),
            proxy_port: port,
        });
        tokio::spawn(serve(listener, ctx, rx));
        let info = ProxyInfo {
            url: format!("http://127.0.0.1:{port}{}", target.path),
            token: token.clone(),
        };
        self.0.lock().insert(
            agent_id.to_string(),
            Running {
                target,
                port,
                token,
                shutdown: tx,
            },
        );
        Ok(info)
    }

    /// Stops the agent's proxy. With `token`, only if it is still that session (a pane that is
    /// re-opening must not have its new proxy stopped by the old pane's cleanup).
    pub fn stop(&self, agent_id: &str, token: Option<&str>) {
        let mut map = self.0.lock();
        if token.is_some_and(|t| map.get(agent_id).is_some_and(|r| r.token != t)) {
            return;
        }
        if let Some(r) = map.remove(agent_id) {
            let _ = r.shutdown.send(true);
        }
    }
}

#[tauri::command]
pub async fn preview_proxy_start(
    proxies: State<'_, PreviewProxies>,
    agent_id: String,
    target: String,
) -> CmdResult<ProxyInfo> {
    proxies.start(&agent_id, &target).await
}

#[tauri::command]
pub async fn preview_proxy_stop(
    proxies: State<'_, PreviewProxies>,
    agent_id: String,
    token: Option<String>,
) -> CmdResult<()> {
    proxies.stop(&agent_id, token.as_deref());
    Ok(())
}

struct Ctx {
    target: Target,
    proxy_port: u16,
}

async fn serve(listener: TcpListener, ctx: Arc<Ctx>, mut stop: watch::Receiver<bool>) {
    loop {
        let stream = tokio::select! {
            r = listener.accept() => match r {
                Ok((s, _)) => s,
                Err(_) => { tokio::time::sleep(Duration::from_millis(50)).await; continue; }
            },
            _ = stop.changed() => return,
        };
        let ctx = ctx.clone();
        let mut stop = stop.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req| handle(ctx.clone(), req));
            let conn = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), svc)
                .with_upgrades();
            tokio::pin!(conn);
            tokio::select! {
                _ = &mut conn => {}
                _ = stop.changed() => {}
            }
        });
    }
}

fn text(status: StatusCode, msg: &str) -> Response<Body> {
    let mut r = Response::new(
        Full::new(Bytes::from(msg.to_string()))
            .map_err(|never| match never {})
            .boxed(),
    );
    *r.status_mut() = status;
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    r
}

async fn handle(ctx: Arc<Ctx>, req: Request<Incoming>) -> Result<Response<Body>, Infallible> {
    Ok(route(ctx, req).await)
}

async fn route(ctx: Arc<Ctx>, req: Request<Incoming>) -> Response<Body> {
    // DNS-rebinding guard: only requests addressed to this proxy itself.
    let own = format!("127.0.0.1:{}", ctx.proxy_port);
    let host_ok = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.eq_ignore_ascii_case(&own));
    if !host_ok {
        return text(
            StatusCode::FORBIDDEN,
            "Armada preview proxy: unexpected Host",
        );
    }
    if req.uri().path() == AGENT_PATH {
        let mut r = Response::new(
            Full::new(Bytes::from_static(AGENT_JS.as_bytes()))
                .map_err(|n| match n {})
                .boxed(),
        );
        r.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/javascript; charset=utf-8"),
        );
        r.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return r;
    }
    match forward(&ctx, req).await {
        Ok(r) => r,
        Err(msg) => text(StatusCode::BAD_GATEWAY, &msg),
    }
}

const HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

fn is_upgrade(h: &HeaderMap) -> bool {
    let conn = h
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .any(|v| {
            v.split(',')
                .any(|t| t.trim().eq_ignore_ascii_case("upgrade"))
        });
    conn && h.contains_key(header::UPGRADE)
}

fn rewrite_request_url(value: &str, ctx: &Ctx) -> String {
    let own = format!("http://127.0.0.1:{}", ctx.proxy_port);
    match value.strip_prefix(&own) {
        Some(rest) => format!("{}{rest}", ctx.target.origin()),
        None => value.to_string(),
    }
}

/// Points an absolute redirect to the dev server back at the proxy; other targets stay as they are.
pub fn rewrite_location(loc: &str, target: &Target, proxy_port: u16) -> String {
    let Some(rest) = loc.strip_prefix("http://") else {
        return loc.to_string();
    };
    let (authority, tail) = match rest.find(['/', '?', '#']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    match parse_target(&format!("http://{authority}")) {
        Ok(t) if t.port == target.port => {
            let sep = if tail.is_empty() || tail.starts_with('/') {
                ""
            } else {
                "/"
            };
            format!("http://127.0.0.1:{proxy_port}{sep}{tail}")
        }
        _ => loc.to_string(),
    }
}

async fn forward(ctx: &Ctx, mut req: Request<Incoming>) -> Result<Response<Body>, String> {
    let upgrade = is_upgrade(req.headers());
    let client_up = upgrade.then(|| hyper::upgrade::on(&mut req));
    let is_head = req.method() == Method::HEAD;
    let (parts, body) = req.into_parts();

    let mut up = Request::builder()
        .method(parts.method.clone())
        .uri(parts.uri.path_and_query().map_or("/", |p| p.as_str()))
        .version(hyper::Version::HTTP_11);
    {
        let h = up.headers_mut().unwrap();
        for (k, v) in &parts.headers {
            let n = k.as_str();
            if n == "host"
                || n == "accept-encoding"
                || (HOP.contains(&n) && !(upgrade && (n == "connection" || n == "upgrade")))
            {
                continue;
            }
            if n == "origin" || n == "referer" {
                if let Ok(s) = v.to_str() {
                    if let Ok(nv) = HeaderValue::from_str(&rewrite_request_url(s, ctx)) {
                        h.append(k.clone(), nv);
                    }
                }
                continue;
            }
            h.append(k.clone(), v.clone());
        }
        h.insert(
            header::HOST,
            HeaderValue::from_str(&ctx.target.authority()).map_err(|e| e.to_string())?,
        );
        // Identity from upstream keeps HTML streamable and cheap to rewrite.
        h.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("identity"),
        );
    }
    let up = up.body(body).map_err(|e| e.to_string())?;

    let stream = tokio::time::timeout(
        Duration::from_secs(5),
        TcpStream::connect((ctx.target.connect_host(), ctx.target.port)),
    )
    .await
    .map_err(|_| format!("Timed out connecting to {}", ctx.target.authority()))?
    .map_err(|e| format!("Nothing is listening on {} ({e})", ctx.target.authority()))?;
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let _ = conn.with_upgrades().await;
    });
    let mut res = sender
        .send_request(up)
        .await
        .map_err(|e| format!("Dev server error: {e}"))?;

    if upgrade && res.status() == StatusCode::SWITCHING_PROTOCOLS {
        let up_up = hyper::upgrade::on(&mut res);
        let mut out = Response::new(Empty::<Bytes>::new().map_err(|n| match n {}).boxed());
        *out.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
        *out.headers_mut() = res.headers().clone();
        if let Some(cu) = client_up {
            tokio::spawn(async move {
                if let (Ok(c), Ok(u)) = (cu.await, up_up.await) {
                    let (mut c, mut u) = (TokioIo::new(c), TokioIo::new(u));
                    let _ = tokio::io::copy_bidirectional(&mut c, &mut u).await;
                }
            });
        }
        return Ok(out);
    }

    let (mut rp, rbody) = res.into_parts();
    let mut drop_names: Vec<HeaderName> = Vec::new();
    for k in rp.headers.keys() {
        if HOP.contains(&k.as_str()) {
            drop_names.push(k.clone());
        }
    }
    for k in drop_names {
        rp.headers.remove(k);
    }
    if let Some(loc) = rp
        .headers
        .get(header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
    {
        if let Ok(v) = HeaderValue::from_str(&rewrite_location(&loc, &ctx.target, ctx.proxy_port)) {
            rp.headers.insert(header::LOCATION, v);
        }
    }

    let is_html = rp
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            let v = v.trim().to_ascii_lowercase();
            v.starts_with("text/html") || v.starts_with("application/xhtml+xml")
        });
    let bodyless = is_head
        || rp.status == StatusCode::NO_CONTENT
        || rp.status == StatusCode::NOT_MODIFIED
        || rp.status.is_informational();
    if !is_html || bodyless {
        return Ok(Response::from_parts(
            rp,
            rbody.map_err(io::Error::other).boxed(),
        ));
    }

    let encoding = rp
        .headers
        .get(header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default();
    match encoding.as_str() {
        "" | "identity" => {
            rp.headers.remove(header::CONTENT_LENGTH);
            rp.headers.remove(header::CONTENT_ENCODING);
            Ok(Response::from_parts(rp, inject_stream(rbody)))
        }
        "gzip" | "x-gzip" | "deflate" | "br" => {
            let raw = Limited::new(rbody, DECODE_LIMIT)
                .collect()
                .await
                .map_err(|e| format!("Dev server error: {e}"))?
                .to_bytes();
            let (bytes, decoded) = match decode(&encoding, &raw) {
                Some(d) => (Bytes::from(inject_buffer(&d)), true),
                None => (raw, false),
            };
            if decoded {
                rp.headers.remove(header::CONTENT_ENCODING);
            }
            rp.headers
                .insert(header::CONTENT_LENGTH, HeaderValue::from(bytes.len()));
            Ok(Response::from_parts(
                rp,
                Full::new(bytes).map_err(|n| match n {}).boxed(),
            ))
        }
        _ => Ok(Response::from_parts(
            rp,
            rbody.map_err(io::Error::other).boxed(),
        )),
    }
}

fn decode(encoding: &str, raw: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut out = Vec::new();
    let limit = DECODE_LIMIT as u64 + 1;
    let n = match encoding {
        "gzip" | "x-gzip" => flate2::read::GzDecoder::new(raw)
            .take(limit)
            .read_to_end(&mut out),
        "deflate" => {
            // "deflate" is zlib-wrapped in practice, but some servers send raw deflate.
            let z = flate2::read::ZlibDecoder::new(raw)
                .take(limit)
                .read_to_end(&mut out);
            if z.is_err() {
                out.clear();
                flate2::read::DeflateDecoder::new(raw)
                    .take(limit)
                    .read_to_end(&mut out)
            } else {
                z
            }
        }
        "br" => brotli_decompressor::Decompressor::new(raw, 4096)
            .take(limit)
            .read_to_end(&mut out),
        _ => return None,
    };
    (n.is_ok() && out.len() <= DECODE_LIMIT).then_some(out)
}

/// Byte offset where the script tag goes: right after `<head …>`, else before `<body`, else (when
/// `eof`) after `<html …>` or at the very start of a document without a doctype. `None` = need more.
pub fn insertion_point(buf: &[u8], eof: bool) -> Option<usize> {
    let lower: Vec<u8> = buf
        .iter()
        .take(SNIFF_LIMIT)
        .map(u8::to_ascii_lowercase)
        .collect();
    let tag_end = |name: &[u8]| -> Option<Option<usize>> {
        // Some(Some(end)) = found and closed, Some(None) = found but not closed yet, None = absent.
        let mut from = 0;
        while let Some(i) = find(&lower[from..], name).map(|i| i + from) {
            let after = lower.get(i + name.len()).copied();
            if matches!(after, Some(b'>' | b' ' | b'\t' | b'\n' | b'\r' | b'/')) {
                return Some(
                    lower[i..]
                        .iter()
                        .position(|&c| c == b'>')
                        .map(|e| i + e + 1),
                );
            }
            if after.is_none() {
                return Some(None);
            }
            from = i + 1;
        }
        None
    };
    match tag_end(b"<head") {
        Some(Some(end)) => return Some(end),
        Some(None) if !eof => return None,
        _ => {}
    }
    if let Some(i) = find(&lower, b"<body") {
        return Some(i);
    }
    if !eof && buf.len() < SNIFF_LIMIT {
        return None;
    }
    if let Some(Some(end)) = tag_end(b"<html") {
        return Some(end);
    }
    let trimmed = lower
        .iter()
        .position(|c| !c.is_ascii_whitespace())
        .unwrap_or(lower.len());
    if lower[trimmed..].starts_with(b"<!doctype") || lower[trimmed..].starts_with(b"<?xml") {
        return Some(SKIP); // no safe place: leave the document alone
    }
    Some(0)
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// `insertion_point` result meaning "don't inject".
const SKIP: usize = usize::MAX;

fn splice(buf: &[u8], at: usize) -> Vec<u8> {
    if at == SKIP || at > buf.len() {
        return buf.to_vec();
    }
    let mut out = Vec::with_capacity(buf.len() + SCRIPT_TAG.len());
    out.extend_from_slice(&buf[..at]);
    out.extend_from_slice(SCRIPT_TAG.as_bytes());
    out.extend_from_slice(&buf[at..]);
    out
}

pub fn inject_buffer(html: &[u8]) -> Vec<u8> {
    splice(html, insertion_point(html, true).unwrap_or(SKIP))
}

struct Inj {
    body: Incoming,
    pending: Vec<u8>,
    injected: bool,
    failed: bool,
}

/// Streams the body through, inserting the script tag once at the first good spot; later chunks pass
/// untouched, so streaming SSR keeps streaming.
fn inject_stream(body: Incoming) -> Body {
    let st = Inj {
        body,
        pending: Vec::new(),
        injected: false,
        failed: false,
    };
    let s = stream::unfold(st, |mut s| async move {
        if s.failed {
            return None;
        }
        loop {
            let frame = s.body.frame().await;
            if s.injected {
                return match frame {
                    None => None,
                    Some(Ok(f)) => Some((Ok(f), s)),
                    Some(Err(e)) => {
                        s.failed = true;
                        Some((Err(io::Error::other(e)), s))
                    }
                };
            }
            match frame {
                Some(Ok(f)) => {
                    if let Ok(d) = f.into_data() {
                        s.pending.extend_from_slice(&d);
                    }
                    let eof = false;
                    if let Some(at) = insertion_point(&s.pending, eof) {
                        s.injected = true;
                        let out = splice(&s.pending, at);
                        s.pending = Vec::new();
                        return Some((Ok(Frame::data(Bytes::from(out))), s));
                    }
                }
                Some(Err(e)) => {
                    s.failed = true;
                    return Some((Err(io::Error::other(e)), s));
                }
                None => {
                    s.injected = true;
                    let at = insertion_point(&s.pending, true).unwrap_or(SKIP);
                    let out = splice(&s.pending, at);
                    s.pending = Vec::new();
                    if out.is_empty() {
                        return None;
                    }
                    return Some((Ok(Frame::data(Bytes::from(out))), s));
                }
            }
        }
    });
    StreamBody::new(s).boxed()
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use std::io::Write;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const PAGE: &str = "<!doctype html><html><head><title>t</title></head><body>hi</body></html>";

    #[test]
    fn target_validation() {
        let t = parse_target("http://localhost:3000/a?b=1#x").unwrap();
        assert_eq!(
            (t.host.as_str(), t.port, t.path.as_str()),
            ("localhost", 3000, "/a?b=1")
        );
        assert_eq!(parse_target("http://127.0.0.1").unwrap().port, 80);
        assert_eq!(
            parse_target("http://[::1]:5173/").unwrap().connect_host(),
            "::1"
        );
        for bad in [
            "x",
            "",
            "https://localhost:3000",
            "http://example.com:3000",
            "http://localhost.evil.com:3000",
            "http://127.0.0.1.nip.io:3000",
            "http://user@localhost:3000",
            "http://localhost:0",
            "http://localhost:99999",
            "http://192.168.1.5:3000",
            "http://0.0.0.0:3000",
            "file:///etc/passwd",
            "http://localhost@evil.com:3000",
        ] {
            assert!(parse_target(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn redirects_point_back_at_the_proxy() {
        let t = parse_target("http://localhost:3000").unwrap();
        assert_eq!(
            rewrite_location("http://localhost:3000/login?x=1", &t, 50000),
            "http://127.0.0.1:50000/login?x=1"
        );
        assert_eq!(
            rewrite_location("http://127.0.0.1:3000", &t, 50000),
            "http://127.0.0.1:50000"
        );
        assert_eq!(rewrite_location("/relative", &t, 50000), "/relative");
        assert_eq!(
            rewrite_location("http://example.com/x", &t, 50000),
            "http://example.com/x"
        );
        assert_eq!(
            rewrite_location("http://localhost:4000/x", &t, 50000),
            "http://localhost:4000/x"
        );
    }

    #[test]
    fn injection_points() {
        let tag = SCRIPT_TAG;
        let inj = |s: &str| String::from_utf8(inject_buffer(s.as_bytes())).unwrap();
        assert_eq!(
            inj("<!doctype html><HEAD class=a><title>x"),
            format!("<!doctype html><HEAD class=a>{tag}<title>x")
        );
        assert_eq!(inj("<html><body>x"), format!("<html>{tag}<body>x"));
        assert_eq!(
            inj("<!doctype html><header>x</header>"),
            "<!doctype html><header>x</header>"
        );
        assert_eq!(
            inj("<div>fragment</div>"),
            format!("{tag}<div>fragment</div>")
        );
        // `<head` split across chunks needs more data.
        assert_eq!(insertion_point(b"<!doctype html><he", false), None);
        assert_eq!(insertion_point(b"<!doctype html><head", false), None);
        assert_eq!(insertion_point(b"<!doctype html><head>", false), Some(21));
    }

    struct Up {
        port: u16,
    }

    fn gz(b: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(b).unwrap();
        e.finish().unwrap()
    }

    async fn upstream() -> Up {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (s, _) = l.accept().await.unwrap();
                tokio::spawn(async move {
                    let svc = service_fn(move |req: Request<Incoming>| async move {
                        let host = req
                            .headers()
                            .get("host")
                            .and_then(|h| h.to_str().ok())
                            .unwrap_or("")
                            .to_string();
                        let enc = req
                            .headers()
                            .get("accept-encoding")
                            .and_then(|h| h.to_str().ok())
                            .unwrap_or("")
                            .to_string();
                        let origin = req
                            .headers()
                            .get("origin")
                            .and_then(|h| h.to_str().ok())
                            .unwrap_or("")
                            .to_string();
                        let path = req.uri().path().to_string();
                        let body = req.into_body().collect().await.unwrap().to_bytes();
                        let mut r = Response::builder();
                        let out: Vec<u8> = match path.as_str() {
                            "/" => {
                                r = r
                                    .header("content-type", "text/html; charset=utf-8")
                                    .header("content-length", PAGE.len());
                                PAGE.as_bytes().to_vec()
                            }
                            "/gz" => {
                                r = r
                                    .header("content-type", "text/html")
                                    .header("content-encoding", "gzip");
                                gz(PAGE.as_bytes())
                            }
                            "/data.json" => {
                                r = r.header("content-type", "application/json");
                                b"{\"a\":1}".to_vec()
                            }
                            "/redir" => {
                                r = r.status(302).header(
                                    "location",
                                    format!(
                                        "http://localhost:{}/landed",
                                        host.rsplit(':').next().unwrap()
                                    ),
                                );
                                vec![]
                            }
                            _ => format!(
                                "host={host};enc={enc};origin={origin};body={}",
                                String::from_utf8_lossy(&body)
                            )
                            .into_bytes(),
                        };
                        Ok::<_, Infallible>(r.body(Full::new(Bytes::from(out))).unwrap())
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(s), svc)
                        .await;
                });
            }
        });
        Up { port }
    }

    /// Minimal HTTP/1.0 client: (status line, lowercase headers, body).
    async fn get(
        port: u16,
        host: &str,
        method: &str,
        path: &str,
        extra: &str,
        body: &str,
    ) -> (String, String, Vec<u8>) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let req = format!(
            "{method} {path} HTTP/1.0\r\nHost: {host}\r\n{extra}Content-Length: {}\r\n\r\n{body}",
            body.len()
        );
        s.write_all(req.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).await.unwrap();
        let at = find(&buf, b"\r\n\r\n").expect("response head");
        let head = String::from_utf8_lossy(&buf[..at]).to_string();
        let (status, headers) = head.split_once("\r\n").unwrap_or((&head, ""));
        (
            status.to_string(),
            headers.to_ascii_lowercase(),
            buf[at + 4..].to_vec(),
        )
    }

    fn proxy_port(info: &ProxyInfo) -> u16 {
        info.url
            .split(':')
            .nth(2)
            .unwrap()
            .split('/')
            .next()
            .unwrap()
            .parse()
            .unwrap()
    }

    #[tokio::test]
    async fn injects_into_html_and_passes_everything_else_through() {
        let up = upstream().await;
        let proxies = PreviewProxies::default();
        let info = proxies
            .start("agent-inject", &format!("http://localhost:{}/", up.port))
            .await
            .unwrap();
        let p = proxy_port(&info);
        let own = format!("127.0.0.1:{p}");

        let (st, h, body) = get(p, &own, "GET", "/", "Accept-Encoding: gzip, br\r\n", "").await;
        assert!(st.contains("200"), "{st}");
        let body = String::from_utf8(body).unwrap();
        assert!(
            body.contains(&format!("<head>{SCRIPT_TAG}<title>")),
            "{body}"
        );
        assert!(
            !h.contains(&format!("content-length: {}", PAGE.len())),
            "length must be recomputed: {h}"
        );

        // gzip upstream (ignoring the identity request) is decoded, injected and served plain.
        let (_, h, body) = get(p, &own, "GET", "/gz", "", "").await;
        assert!(!h.contains("content-encoding"), "{h}");
        assert!(String::from_utf8(body).unwrap().contains(SCRIPT_TAG));

        // Non-HTML is untouched.
        let (_, h, body) = get(p, &own, "GET", "/data.json", "", "").await;
        assert_eq!(body, b"{\"a\":1}");
        assert!(h.contains("application/json"));

        // Request rewriting: Host is the dev server's, upstream is asked for identity, Origin follows,
        // bodies are forwarded.
        let (_, _, body) = get(
            p,
            &own,
            "POST",
            "/echo",
            &format!("Accept-Encoding: br\r\nOrigin: http://{own}\r\n"),
            "payload",
        )
        .await;
        let body = String::from_utf8(body).unwrap();
        assert_eq!(
            body,
            format!(
                "host=localhost:{};enc=identity;origin=http://localhost:{};body=payload",
                up.port, up.port
            )
        );

        // Redirects to the dev server come back through the proxy.
        let (st, h, _) = get(p, &own, "GET", "/redir", "", "").await;
        assert!(st.contains("302"));
        assert!(
            h.contains(&format!("location: http://127.0.0.1:{p}/landed")),
            "{h}"
        );

        // The agent script is served by the proxy itself.
        let (_, h, body) = get(p, &own, "GET", AGENT_PATH, "", "").await;
        assert!(h.contains("no-store") && body.len() > 1000);

        // DNS rebinding: any other Host is refused.
        let (st, _, _) = get(p, "evil.example", "GET", "/", "", "").await;
        assert!(st.contains("403"), "{st}");

        proxies.stop("agent-inject", None);
    }

    #[tokio::test]
    async fn websocket_upgrades_pass_through() {
        // Upstream: a WebSocket echo server.
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((s, _)) = l.accept().await {
                tokio::spawn(async move {
                    let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
                    while let Some(Ok(m)) = ws.next().await {
                        if m.is_text() {
                            ws.send(m).await.unwrap();
                        }
                    }
                });
            }
        });
        let proxies = PreviewProxies::default();
        let info = proxies
            .start("agent-ws", &format!("http://localhost:{up}/"))
            .await
            .unwrap();
        let p = proxy_port(&info);
        let (mut ws, resp) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{p}/hmr"))
            .await
            .unwrap();
        assert_eq!(resp.status(), 101);
        ws.send("ping".into()).await.unwrap();
        let echoed = ws.next().await.unwrap().unwrap();
        assert_eq!(echoed.into_text().unwrap().as_str(), "ping");
        proxies.stop("agent-ws", None);
    }

    #[tokio::test]
    async fn refuses_non_loopback_targets_and_stops_cleanly() {
        let proxies = PreviewProxies::default();
        for bad in [
            "http://example.com",
            "http://10.0.0.5:3000",
            "https://localhost:3000",
            "x",
        ] {
            assert!(proxies.start("a", bad).await.is_err());
        }
        assert!(
            proxies.0.lock().is_empty(),
            "a refused target must not leave a listener"
        );

        let up = upstream().await;
        let a = proxies
            .start("a", &format!("http://127.0.0.1:{}", up.port))
            .await
            .unwrap();
        // Same target: same proxy. A stale token can't stop the new session.
        let again = proxies
            .start("a", &format!("http://127.0.0.1:{}", up.port))
            .await
            .unwrap();
        assert_eq!(
            (a.url.clone(), a.token.clone()),
            (again.url.clone(), again.token.clone())
        );
        proxies.stop("a", Some("stale"));
        assert!(TcpStream::connect(("127.0.0.1", proxy_port(&a)))
            .await
            .is_ok());
        proxies.stop("a", Some(&a.token));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            TcpStream::connect(("127.0.0.1", proxy_port(&a)))
                .await
                .is_err(),
            "stopped proxy must close its port"
        );
    }

    /// Manual: `ARMADA_PROXY_TARGET=http://localhost:5173 cargo test -p armada-desktop proxy_for_manual_checks -- --ignored --nocapture`
    /// runs a proxy in front of a real dev server and prints its URL (used to check Vite HMR).
    #[tokio::test]
    #[ignore]
    async fn proxy_for_manual_checks() {
        let target = std::env::var("ARMADA_PROXY_TARGET").expect("set ARMADA_PROXY_TARGET");
        let proxies = PreviewProxies::default();
        let info = proxies.start("manual", &target).await.unwrap();
        println!("PROXY {}", info.url);
        tokio::time::sleep(Duration::from_secs(90)).await;
        drop(proxies);
    }
}
