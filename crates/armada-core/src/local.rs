//! Local model servers (Ollama, LM Studio, any OpenAI-compatible endpoint).
//!
//! Armada drives them through the Codex CLI, which speaks the OpenAI Responses API
//! to whatever `model_providers.<id>.base_url` points at. This module finds the
//! servers, lists their models, builds the Codex config overrides and pulls Ollama
//! models. All network calls are blocking (`ureq`): call them from
//! `spawn_blocking`.

use std::io::BufRead;
use std::net::{IpAddr, Ipv6Addr, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use serde_json::Value;

use crate::model::{LocalKind, LocalModel, LocalProbe, LocalServer, PullProgress};

pub const OLLAMA_URL: &str = "http://127.0.0.1:11434";
pub const LMSTUDIO_URL: &str = "http://127.0.0.1:1234";
/// The Codex `model_providers` id Armada defines for local servers.
pub const PROVIDER_ID: &str = "armada_local";
/// Environment variable carrying an optional bearer token to the server.
pub const KEY_ENV: &str = "ARMADA_LOCAL_API_KEY";

const PROBE_CONNECT: Duration = Duration::from_millis(1200);
const PROBE_READ: Duration = Duration::from_secs(4);
/// At most this many models get a per-model `/api/show` lookup.
const MAX_SHOW: usize = 40;

impl LocalKind {
    pub fn label(self) -> &'static str {
        match self {
            LocalKind::Ollama => "Ollama",
            LocalKind::Lmstudio => "LM Studio",
            LocalKind::Custom => "Local server",
        }
    }

    pub fn default_url(self) -> Option<&'static str> {
        match self {
            LocalKind::Ollama => Some(OLLAMA_URL),
            LocalKind::Lmstudio => Some(LMSTUDIO_URL),
            LocalKind::Custom => None,
        }
    }
}

/// Accepts only http(s) URLs and returns them without a trailing slash.
pub fn normalize_url(raw: &str) -> anyhow::Result<String> {
    let url = raw.trim().trim_end_matches('/');
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .ok_or_else(|| anyhow!("The address must start with http:// or https://"))?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        bail!("That doesn't look like a server address");
    }
    if rest.contains('?') || rest.contains('#') {
        bail!("Leave the query string off the address");
    }
    if host.contains('@') {
        bail!("Leave the username and password off the address");
    }
    Ok(url.to_string())
}

/// Validates and normalizes a server definition (the URL is rewritten in place).
pub fn validate(server: &LocalServer) -> anyhow::Result<LocalServer> {
    Ok(LocalServer {
        kind: server.kind,
        base_url: normalize_url(&server.base_url)?,
    })
}

/// The host of an http(s) URL, lowercased, without brackets, port or userinfo.
fn url_host(base_url: &str) -> String {
    let rest = base_url
        .strip_prefix("http://")
        .or_else(|| base_url.strip_prefix("https://"))
        .unwrap_or(base_url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or("");
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next().unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    host.to_ascii_lowercase()
}

/// True when the server's host is this machine: a loopback IP literal, `localhost` or `*.localhost`.
pub fn is_loopback(base_url: &str) -> bool {
    let host = url_host(base_url);
    match host.parse::<IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        Err(_) => host == "localhost" || host.ends_with(".localhost"),
    }
}

/// Link-local (169.254/16, fe80::/10, incl. cloud metadata), unspecified and multicast addresses.
fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_link_local() || v4.is_unspecified() || v4.is_multicast() || v4.is_broadcast()
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_blocked_ip(IpAddr::V4(v4));
            }
            v6.is_unspecified()
                || v6.is_multicast()
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                // AWS IMDS over IPv6.
                || v6 == Ipv6Addr::new(0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254)
        }
    }
}

/// Loopback, RFC 1918, CGNAT (Tailscale) and unique-local addresses.
fn is_local_network_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_local_network_ip(IpAddr::V4(v4));
            }
            v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00
        }
    }
}

/// Vets a server address before any request: no link-local/metadata targets, and (when
/// `local_only`) only loopback/private ranges. Hostnames are resolved and every address
/// checked. Residual risk: the HTTP client resolves again at connect time.
pub fn check_target(base_url: &str, local_only: bool) -> anyhow::Result<()> {
    let host = url_host(base_url);
    let rest = base_url.split("://").nth(1).unwrap_or("");
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        bail!("Leave the username and password off the address");
    }
    let https = base_url.starts_with("https://");
    let port = authority
        .rsplit_once(':')
        .filter(|(h, _)| !h.ends_with(']') || h.starts_with('['))
        .and_then(|(_, p)| p.parse::<u16>().ok())
        .unwrap_or(if https { 443 } else { 80 });
    let ips: Vec<IpAddr> = match host.parse::<IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) if host == "localhost" || host.ends_with(".localhost") => vec![],
        Err(_) => (host.as_str(), port)
            .to_socket_addrs()
            .map(|a| a.map(|s| s.ip()).collect())
            .unwrap_or_default(),
    };
    for ip in ips {
        if is_blocked_ip(ip) {
            bail!("Addresses like {ip} (link-local or cloud metadata) aren't allowed");
        }
        if local_only && !is_local_network_ip(ip) {
            bail!("Downloads are only allowed from this machine or your local network");
        }
    }
    if local_only && !is_loopback(base_url) && host.parse::<IpAddr>().is_err() {
        // A hostname that resolved to nothing local was rejected above; unresolvable names fail here.
        let resolves = (host.as_str(), port).to_socket_addrs().is_ok();
        if !resolves {
            bail!("Couldn't resolve {host}");
        }
    }
    Ok(())
}

/// The OpenAI-compatible base URL (ending in `/v1` for Ollama and LM Studio).
pub fn openai_base(server: &LocalServer) -> String {
    let base = server.base_url.trim_end_matches('/');
    match server.kind {
        LocalKind::Custom => base.to_string(),
        _ if base.ends_with("/v1") => base.to_string(),
        _ => format!("{base}/v1"),
    }
}

/// The server root without a trailing `/v1` (Ollama / LM Studio native APIs).
fn root(server: &LocalServer) -> &str {
    let base = server.base_url.trim_end_matches('/');
    base.strip_suffix("/v1").unwrap_or(base)
}

/// `codex app-server` arguments (after the `app-server` subcommand) that point
/// Codex at the server and select the model. Codex only speaks the Responses API
/// (`wire_api = "chat"` was removed), which current Ollama, LM Studio, llama.cpp
/// and vLLM all serve.
pub fn codex_override_args(
    server: &LocalServer,
    model: Option<&str>,
    has_api_key: bool,
) -> Vec<String> {
    let mut args = Vec::new();
    let mut set = |kv: String| {
        args.push("-c".to_string());
        args.push(kv);
    };
    let q = |s: &str| serde_json::to_string(s).unwrap_or_default();
    set(format!("model_provider={}", q(PROVIDER_ID)));
    let mut table = format!(
        "{{ name = {}, base_url = {}, wire_api = \"responses\"",
        q(server.kind.label()),
        q(&openai_base(server))
    );
    if has_api_key {
        table.push_str(&format!(", env_key = {}", q(KEY_ENV)));
    }
    table.push_str(" }");
    set(format!("model_providers.{PROVIDER_ID}={table}"));
    if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
        set(format!("model={}", q(m)));
    }
    args
}

fn agent(read: Duration) -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            // Local and LAN servers are reached directly, never through a proxy.
            .proxy(None)
            .http_status_as_error(true)
            .timeout_connect(Some(PROBE_CONNECT))
            .timeout_recv_response(Some(read))
            .timeout_recv_body(Some(read))
            .user_agent(concat!("Armada/", env!("CARGO_PKG_VERSION")))
            .build(),
    )
}

fn get_json(url: &str, key: Option<&str>) -> anyhow::Result<Value> {
    check_target(url, false)?;
    let mut req = agent(PROBE_READ).get(url);
    if let Some(k) = key {
        req = req.header("Authorization", &format!("Bearer {k}"));
    }
    let mut resp = req.call().map_err(|e| anyhow!("{e}"))?;
    let text = resp
        .body_mut()
        .with_config()
        .limit(8 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| anyhow!("{e}"))?;
    serde_json::from_str(&text).context("the server didn't return JSON")
}

// ---- parsing -----------------------------------------------------------------

fn non_empty(s: Option<&str>) -> Option<String> {
    s.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Ollama `GET /api/tags`.
pub fn parse_ollama_tags(v: &Value) -> Vec<LocalModel> {
    let mut out: Vec<LocalModel> = v["models"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|m| {
            let id = non_empty(m["model"].as_str().or_else(|| m["name"].as_str()))?;
            Some(LocalModel {
                id,
                size_bytes: m["size"].as_u64(),
                parameters: non_empty(m["details"]["parameter_size"].as_str()),
                quantization: non_empty(m["details"]["quantization_level"].as_str()),
                context_length: None,
                tools: None,
            })
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Ollama `POST /api/show`: (context length, supports tools, is a chat model).
pub fn parse_ollama_show(v: &Value) -> (Option<i64>, Option<bool>, bool) {
    let context = v["model_info"].as_object().and_then(|info| {
        info.iter()
            .find(|(k, _)| k.ends_with(".context_length"))
            .and_then(|(_, v)| v.as_i64())
    });
    match v["capabilities"].as_array() {
        Some(caps) => {
            let has = |name: &str| caps.iter().any(|c| c.as_str() == Some(name));
            (context, Some(has("tools")), has("completion"))
        }
        // Older Ollama: no capability list.
        None => (context, None, true),
    }
}

/// LM Studio `GET /api/v0/models` (embedding models are left out).
pub fn parse_lmstudio_v0(v: &Value) -> Vec<LocalModel> {
    let mut out: Vec<LocalModel> = v["data"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|m| m["type"].as_str() != Some("embeddings"))
        .filter_map(|m| {
            Some(LocalModel {
                id: non_empty(m["id"].as_str())?,
                size_bytes: None,
                parameters: None,
                quantization: non_empty(m["quantization"].as_str()),
                context_length: m["loaded_context_length"]
                    .as_i64()
                    .or_else(|| m["max_context_length"].as_i64()),
                tools: None,
            })
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// OpenAI-style `GET /v1/models`, plus the extras vLLM (`max_model_len`) and
/// llama.cpp (`meta`) add. Embedding models are left out by name.
pub fn parse_openai_models(v: &Value) -> Vec<LocalModel> {
    let list = v["data"].as_array().or_else(|| v["models"].as_array());
    let mut out: Vec<LocalModel> = list
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|m| {
            let id = non_empty(m["id"].as_str().or_else(|| m["model"].as_str()))?;
            if id.to_ascii_lowercase().contains("embed") {
                return None;
            }
            let params = m["meta"]["n_params"].as_f64().map(|n| {
                if n >= 1e9 {
                    format!("{:.1}B", n / 1e9)
                } else {
                    format!("{:.0}M", n / 1e6)
                }
            });
            Some(LocalModel {
                id,
                size_bytes: m["meta"]["size"].as_u64(),
                parameters: params,
                quantization: None,
                context_length: m["max_model_len"]
                    .as_i64()
                    .or_else(|| m["meta"]["n_ctx_train"].as_i64()),
                tools: None,
            })
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

// ---- probing -----------------------------------------------------------------

fn ollama_models(root: &str) -> anyhow::Result<Vec<LocalModel>> {
    let mut models = parse_ollama_tags(&get_json(&format!("{root}/api/tags"), None)?);
    models.truncate(MAX_SHOW);
    // Context length and tool support come from one /api/show call per model.
    let shown: Vec<(Option<i64>, Option<bool>, bool)> = std::thread::scope(|s| {
        let handles: Vec<_> = models
            .iter()
            .map(|m| {
                let id = m.id.clone();
                s.spawn(move || {
                    let body = serde_json::json!({ "model": id });
                    let mut resp = agent(PROBE_READ)
                        .post(&format!("{root}/api/show"))
                        .header("Content-Type", "application/json")
                        .send(body.to_string())
                        .ok()?;
                    let text = resp.body_mut().read_to_string().ok()?;
                    let v: Value = serde_json::from_str(&text).ok()?;
                    Some(parse_ollama_show(&v))
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().ok().flatten().unwrap_or((None, None, true)))
            .collect()
    });
    let mut out = Vec::new();
    for (mut m, (ctx, tools, chat)) in models.into_iter().zip(shown) {
        if !chat {
            continue;
        }
        m.context_length = ctx;
        m.tools = tools;
        out.push(m);
    }
    Ok(out)
}

fn lmstudio_models(root: &str, key: Option<&str>) -> anyhow::Result<Vec<LocalModel>> {
    match get_json(&format!("{root}/api/v0/models"), key) {
        Ok(v) => Ok(parse_lmstudio_v0(&v)),
        // Older LM Studio: only the OpenAI-compatible list.
        Err(_) => Ok(parse_openai_models(&get_json(
            &format!("{root}/v1/models"),
            key,
        )?)),
    }
}

/// Asks the server which models it has. Never fails: an unreachable server is a
/// `running: false` result with a hint in `error`.
pub fn probe(server: &LocalServer, api_key: Option<&str>) -> LocalProbe {
    let remote = !is_loopback(&server.base_url);
    let result = match server.kind {
        LocalKind::Ollama => ollama_models(root(server)),
        LocalKind::Lmstudio => lmstudio_models(root(server), api_key),
        LocalKind::Custom => get_json(&format!("{}/models", openai_base(server)), api_key)
            .map(|v| parse_openai_models(&v)),
    };
    match result {
        Ok(models) => LocalProbe {
            kind: server.kind,
            base_url: server.base_url.clone(),
            running: true,
            models,
            error: None,
            remote,
        },
        Err(e) => LocalProbe {
            kind: server.kind,
            base_url: server.base_url.clone(),
            running: false,
            models: Vec::new(),
            error: Some(unreachable_hint(server.kind, &format!("{e:#}"))),
            remote,
        },
    }
}

fn unreachable_hint(kind: LocalKind, detail: &str) -> String {
    let lower = detail.to_ascii_lowercase();
    let refused = lower.contains("refused")
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("connect")
        || lower.contains("resolve");
    match kind {
        LocalKind::Ollama if refused => "Ollama isn't running. Start it, or install it from https://ollama.com/download".into(),
        LocalKind::Lmstudio if refused => "LM Studio's server isn't running. Open LM Studio and start the local server (https://lmstudio.ai)".into(),
        LocalKind::Custom if refused => "Couldn't reach the server. Check the address and that it's running".into(),
        _ => format!("The server answered, but not as expected: {detail}"),
    }
}

/// Probes the default Ollama and LM Studio addresses in parallel.
pub fn detect() -> Vec<LocalProbe> {
    let servers = [LocalKind::Ollama, LocalKind::Lmstudio].map(|kind| LocalServer {
        kind,
        base_url: kind.default_url().unwrap_or_default().to_string(),
    });
    std::thread::scope(|s| {
        let handles: Vec<_> = servers
            .iter()
            .map(|sv| s.spawn(|| probe(sv, None)))
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
}

// ---- pulling -----------------------------------------------------------------

/// Ollama model names: `name[:tag]` with an optional `namespace/` or host prefix.
pub fn valid_model_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/'))
}

/// One line of Ollama's `/api/pull` stream.
pub fn parse_pull_line(line: &str) -> Option<PullProgress> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if let Some(e) = v["error"].as_str() {
        return Some(PullProgress {
            status: "error".into(),
            total: None,
            completed: None,
            done: true,
            error: Some(e.to_string()),
        });
    }
    let status = v["status"].as_str()?.to_string();
    Some(PullProgress {
        done: status == "success",
        status,
        total: v["total"].as_u64(),
        completed: v["completed"].as_u64(),
        error: None,
    })
}

/// Downloads `model` into Ollama, reporting progress. Stops (leaving the partial
/// download for a later resume) when `cancel` is set.
pub fn pull_ollama(
    base_url: &str,
    model: &str,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(PullProgress),
) -> anyhow::Result<()> {
    if !valid_model_name(model) {
        bail!("That isn't a valid model name");
    }
    let server = LocalServer {
        kind: LocalKind::Ollama,
        base_url: normalize_url(base_url)?,
    };
    check_target(&server.base_url, true)?;
    let http = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .proxy(None)
            .http_status_as_error(false)
            .timeout_connect(Some(PROBE_CONNECT))
            .timeout_recv_response(Some(Duration::from_secs(60)))
            .build(),
    );
    let mut resp = http
        .post(&format!("{}/api/pull", root(&server)))
        .header("Content-Type", "application/json")
        .send(serde_json::json!({ "model": model, "stream": true }).to_string())
        .map_err(|e| anyhow!("{}", unreachable_hint(LocalKind::Ollama, &e.to_string())))?;
    let reader = std::io::BufReader::new(resp.body_mut().as_reader());
    for line in reader.lines() {
        if cancel.load(Ordering::SeqCst) {
            bail!("Cancelled");
        }
        let line = line.context("the download stream broke")?;
        if let Some(p) = parse_pull_line(&line) {
            let finished = p.done;
            let failed = p.error.clone();
            on_progress(p);
            if let Some(e) = failed {
                bail!("{e}");
            }
            if finished {
                return Ok(());
            }
        }
    }
    bail!("The download ended before Ollama said it finished")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn server(kind: LocalKind, url: &str) -> LocalServer {
        LocalServer {
            kind,
            base_url: url.into(),
        }
    }

    #[test]
    fn parses_ollama_tags() {
        // Shape from https://github.com/ollama/ollama/blob/main/docs/api.md#list-local-models
        let v = json!({"models":[
            {"name":"qwen3-coder:30b","model":"qwen3-coder:30b","modified_at":"2025-08-01T10:00:00Z",
             "size":18556701776u64,"digest":"abc",
             "details":{"parent_model":"","format":"gguf","family":"qwen3moe","families":["qwen3moe"],
                        "parameter_size":"30.5B","quantization_level":"Q4_K_M"}},
            {"name":"codellama:13b","size":7365960935u64,"details":{"parameter_size":"13B"}}
        ]});
        let m = parse_ollama_tags(&v);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].id, "codellama:13b");
        assert_eq!(m[0].quantization, None);
        assert_eq!(m[1].id, "qwen3-coder:30b");
        assert_eq!(m[1].size_bytes, Some(18556701776));
        assert_eq!(m[1].parameters.as_deref(), Some("30.5B"));
        assert_eq!(m[1].quantization.as_deref(), Some("Q4_K_M"));
        assert!(parse_ollama_tags(&json!({})).is_empty());
    }

    #[test]
    fn parses_ollama_show() {
        let v = json!({"capabilities":["completion","tools"],
            "model_info":{"general.architecture":"qwen3moe","qwen3moe.context_length":262144}});
        assert_eq!(parse_ollama_show(&v), (Some(262144), Some(true), true));
        let embed = json!({"capabilities":["embedding"],"model_info":{"bert.context_length":512}});
        assert_eq!(parse_ollama_show(&embed), (Some(512), Some(false), false));
        assert_eq!(parse_ollama_show(&json!({})), (None, None, true));
    }

    #[test]
    fn parses_lmstudio_models() {
        // Shape from https://lmstudio.ai/docs/app/api/endpoints/rest
        let v = json!({"object":"list","data":[
            {"id":"qwen2.5-7b-instruct","object":"model","type":"llm","publisher":"lmstudio-community",
             "arch":"qwen2","compatibility_type":"gguf","quantization":"Q4_K_M",
             "state":"not-loaded","max_context_length":32768},
            {"id":"text-embedding-nomic-embed-text-v1.5","type":"embeddings","max_context_length":2048},
            {"id":"loaded-one","type":"llm","state":"loaded","max_context_length":131072,"loaded_context_length":8192}
        ]});
        let m = parse_lmstudio_v0(&v);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].id, "loaded-one");
        assert_eq!(m[0].context_length, Some(8192));
        assert_eq!(m[1].context_length, Some(32768));
        assert_eq!(m[1].quantization.as_deref(), Some("Q4_K_M"));
    }

    #[test]
    fn parses_openai_models() {
        let v = json!({"object":"list","data":[
            {"id":"meta-llama/Llama-3.1-8B-Instruct","object":"model","owned_by":"vllm","max_model_len":131072},
            {"id":"BAAI/bge-embed","object":"model"},
            {"id":"gguf-model","object":"model","meta":{"n_params":8030261312u64,"size":4912898304u64,"n_ctx_train":131072}}
        ]});
        let m = parse_openai_models(&v);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].id, "gguf-model");
        assert_eq!(m[0].parameters.as_deref(), Some("8.0B"));
        assert_eq!(m[0].context_length, Some(131072));
        assert_eq!(m[0].size_bytes, Some(4912898304));
        assert_eq!(m[1].context_length, Some(131072));
        assert!(parse_openai_models(&json!({"error":"x"})).is_empty());
    }

    #[test]
    fn urls_are_normalized_and_restricted() {
        assert_eq!(
            normalize_url(" http://127.0.0.1:11434/ ").unwrap(),
            "http://127.0.0.1:11434"
        );
        assert!(normalize_url("ftp://x").is_err());
        assert!(normalize_url("file:///etc/passwd").is_err());
        assert!(normalize_url("http://").is_err());
        assert!(normalize_url("localhost:1234").is_err());
        assert!(normalize_url("http://a b").is_err());
        assert!(is_loopback("http://localhost:1234"));
        assert!(is_loopback("http://127.0.0.1:11434"));
        assert!(is_loopback("http://[::1]:8080/v1"));
        assert!(!is_loopback("http://192.168.1.20:8000/v1"));
        assert!(!is_loopback("https://gpu.example.com"));
        assert!(!is_loopback("http://localhost.evil.com"));
        assert!(!is_loopback("http://127.evil.com"));
        assert!(!is_loopback("http://0.0.0.0:11434"));
        assert!(is_loopback("http://127.1.2.3"));
        assert!(is_loopback("http://foo.localhost:1"));
        assert!(!is_loopback("http://localhost@evil.com"));
    }

    #[test]
    fn rejects_userinfo_and_metadata_targets() {
        assert!(normalize_url("http://user:pw@127.0.0.1:11434").is_err());
        assert!(normalize_url("http://localhost@evil.com").is_err());
        for u in [
            "http://169.254.169.254",
            "http://169.254.169.254/latest",
            "http://[fe80::1]:80",
            "http://[fd00:ec2::254]",
            "http://0.0.0.0:11434",
            "http://[::ffff:169.254.169.254]",
        ] {
            assert!(check_target(u, false).is_err(), "{u}");
        }
        assert!(check_target("http://127.0.0.1:11434", true).is_ok());
        assert!(check_target("http://192.168.1.20:11434", true).is_ok());
        assert!(check_target("http://[fd12::1]:11434", true).is_ok());
        assert!(check_target("http://100.64.0.5:11434", true).is_ok());
        assert!(check_target("http://8.8.8.8:11434", true).is_err());
        assert!(check_target("http://8.8.8.8:11434", false).is_ok());
        assert!(check_target("http://localhost:11434", true).is_ok());
    }

    #[test]
    fn builds_openai_base() {
        assert_eq!(
            openai_base(&server(LocalKind::Ollama, "http://127.0.0.1:11434")),
            "http://127.0.0.1:11434/v1"
        );
        assert_eq!(
            openai_base(&server(LocalKind::Lmstudio, "http://127.0.0.1:1234/v1")),
            "http://127.0.0.1:1234/v1"
        );
        assert_eq!(
            openai_base(&server(LocalKind::Custom, "http://box:8000/v1")),
            "http://box:8000/v1"
        );
    }

    #[test]
    fn builds_codex_overrides() {
        let args = codex_override_args(
            &server(LocalKind::Ollama, "http://127.0.0.1:11434"),
            Some("qwen3-coder:30b"),
            false,
        );
        assert_eq!(
            args,
            vec![
                "-c",
                "model_provider=\"armada_local\"",
                "-c",
                "model_providers.armada_local={ name = \"Ollama\", base_url = \"http://127.0.0.1:11434/v1\", wire_api = \"responses\" }",
                "-c",
                "model=\"qwen3-coder:30b\"",
            ]
        );
        let keyed =
            codex_override_args(&server(LocalKind::Custom, "http://box:8000/v1"), None, true);
        assert_eq!(keyed.len(), 4);
        assert!(keyed[3].contains("env_key = \"ARMADA_LOCAL_API_KEY\""));
        // A hostile model name stays one quoted TOML string.
        let odd = codex_override_args(
            &server(LocalKind::Custom, "http://box/v1"),
            Some("a\"b\nc"),
            false,
        );
        assert_eq!(odd[5], "model=\"a\\\"b\\nc\"");
    }

    #[test]
    fn parses_pull_stream() {
        let p = parse_pull_line(r#"{"status":"pulling 8934d96d3f08","digest":"sha256:8934","total":3826793677,"completed":559152128}"#).unwrap();
        assert_eq!(
            (p.total, p.completed, p.done),
            (Some(3826793677), Some(559152128), false)
        );
        assert!(parse_pull_line(r#"{"status":"success"}"#).unwrap().done);
        let e = parse_pull_line(r#"{"error":"pull model manifest: file does not exist"}"#).unwrap();
        assert!(e.done && e.error.is_some());
        assert!(parse_pull_line("garbage").is_none());
        assert!(valid_model_name("hf.co/org/repo:Q4_K_M"));
        assert!(!valid_model_name("a b"));
        assert!(!valid_model_name(""));
    }

    #[test]
    fn unreachable_server_reports_a_hint() {
        // Port 9 (discard) is never an Ollama.
        let p = probe(&server(LocalKind::Ollama, "http://127.0.0.1:9"), None);
        assert!(!p.running);
        assert!(p.error.unwrap().contains("Ollama"));
        assert!(!p.remote);
    }
}
