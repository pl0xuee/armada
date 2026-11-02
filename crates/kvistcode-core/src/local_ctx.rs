//! Getting a local agent a context window it can actually work in.
//!
//! Ollama runs models with a small default window (4k tokens under 24 GiB of VRAM)
//! and silently drops the start of a prompt that doesn't fit; its OpenAI-compatible
//! API cannot set the size per request. So before a local agent starts Kvistcode
//! picks a window (64k, less when memory is short, never more than the model
//! supports), has Ollama make a tiny derived model with that `num_ctx` (a manifest
//! pointing at the same weights), and tells Codex the real window so its meter and
//! its automatic compaction work. LM Studio and llama.cpp get the same treatment
//! where their APIs allow it. Blocking: call from `spawn_blocking`.

use std::time::Duration;

use anyhow::{anyhow, bail};
use serde_json::{json, Value};

use crate::hardware::Hardware;
use crate::local::{agent, check_target, get_json, root, valid_model_name};
use crate::model::{LocalKind, LocalModel, LocalServer};

/// The window a local agent is given when memory allows.
pub const TARGET_CONTEXT: i64 = 65_536;
/// Below this an agent works badly: warn.
pub const MIN_GOOD_CONTEXT: i64 = 32_768;
/// The smallest window worth choosing automatically.
const FLOOR_CONTEXT: i64 = 8_192;
/// Memory a model server needs besides weights and the context cache.
const OVERHEAD_BYTES: u64 = 3 * (1 << 29); // 1.5 GiB

const DERIVED_MARK: &str = "-agent";
const ENSURE_TIMEOUT: Duration = Duration::from_secs(120);

// ---- memory arithmetic (pure) ---------------------------------------------------

/// Rough KV-cache bytes per token for a model, from its name and parameter count.
/// Known families use their real layer/KV-head numbers; anything else is scaled by
/// size. An estimate, used only to decide how much context fits.
pub fn kv_bytes_per_token(model_id: &str, parameters: Option<&str>) -> u64 {
    let id = model_id.to_ascii_lowercase();
    let known: &[(&str, u64)] = &[
        ("gpt-oss", 48 * 1024),
        ("qwen3-coder", 96 * 1024),
        ("devstral", 160 * 1024),
        ("gemma4", 100 * 1024),
        ("llama3.2", 112 * 1024),
    ];
    if let Some((_, b)) = known.iter().find(|(k, _)| id.contains(k)) {
        return *b;
    }
    let billions = parameters
        .and_then(|p| p.trim().trim_end_matches(['B', 'b']).parse::<f64>().ok())
        .unwrap_or(14.0);
    // ~4 KiB per token per billion parameters is typical of grouped-query models.
    ((billions * 4096.0) as u64).max(16 * 1024)
}

/// The window to run with. `requested` is the user's choice and is used as given
/// (bounded by the model); otherwise 64k, shrunk until weights + cache fit in
/// `memory`. Never below 8k unless the model itself supports less.
pub fn pick_context(
    model_max: Option<i64>,
    memory: Option<u64>,
    weights: Option<u64>,
    kv_per_token: u64,
    requested: Option<i64>,
) -> i64 {
    let cap = model_max.filter(|m| *m > 0).unwrap_or(i64::MAX);
    if let Some(r) = requested.filter(|r| *r > 0) {
        return r.min(cap);
    }
    let want = TARGET_CONTEXT.min(cap);
    let (Some(mem), Some(w)) = (memory, weights) else {
        return want;
    };
    let room = mem.saturating_sub(w).saturating_sub(OVERHEAD_BYTES);
    let fits = (room / kv_per_token.max(1)) as i64;
    [65_536, 49_152, 32_768, 24_576, 16_384, FLOOR_CONTEXT]
        .into_iter()
        .find(|c| *c <= want && *c <= fits)
        .unwrap_or(FLOOR_CONTEXT.min(want))
}

/// The line shown when the window is too small for agent work.
pub fn context_warning(ctx: i64) -> Option<String> {
    (ctx < MIN_GOOD_CONTEXT).then(|| {
        format!(
            "This agent has a {}k-token window, which is small for agent work: it may forget earlier files and instructions. A model with less memory pressure (or more memory) helps; 32k is the practical minimum.",
            ctx / 1024
        )
    })
}

/// Codex `-c` overrides that tell it the window the server really runs with, so its
/// meter is right and it compacts history before the server would truncate it.
pub fn codex_args(ctx: i64) -> Vec<String> {
    let compact = ctx / 5 * 4; // Codex ignores values above 90% of the window
    vec![
        "-c".into(),
        format!("model_context_window={ctx}"),
        "-c".into(),
        format!("model_auto_compact_token_limit={compact}"),
    ]
}

// ---- Ollama derived models ------------------------------------------------------

/// `qwen3-coder:30b` -> `qwen3-coder:30b-agent64k`.
pub fn derived_name(base: &str, ctx: i64) -> String {
    let (name, tag) = base.rsplit_once(':').unwrap_or((base, "latest"));
    format!("{name}:{tag}{DERIVED_MARK}{}k", ctx / 1024)
}

/// A model Kvistcode made (see `derived_name`).
pub fn is_derived(name: &str) -> bool {
    match name.rsplit_once(DERIVED_MARK) {
        Some((base, rest)) => {
            !base.is_empty()
                && rest.ends_with('k')
                && rest.len() > 1
                && rest[..rest.len() - 1].chars().all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

/// `PARAMETER num_ctx 4096` lines from `/api/show` `parameters`.
pub fn parse_num_ctx(parameters: &str) -> Option<i64> {
    parameters.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        (it.next() == Some("num_ctx")).then(|| it.next()?.parse().ok())?
    })
}

fn post_json(url: &str, key: Option<&str>, body: &Value, read: Duration) -> anyhow::Result<Value> {
    check_target(url, false)?;
    let mut req = agent(read)
        .post(url)
        .header("Content-Type", "application/json");
    if let Some(k) = key {
        req = req.header("Authorization", &format!("Bearer {k}"));
    }
    let mut resp = req.send(body.to_string()).map_err(|e| anyhow!("{e}"))?;
    let text = resp
        .body_mut()
        .with_config()
        .limit(8 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| anyhow!("{e}"))?;
    Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn show(root: &str, model: &str) -> anyhow::Result<Value> {
    post_json(
        &format!("{root}/api/show"),
        None,
        &json!({ "model": model }),
        Duration::from_secs(10),
    )
}

/// Makes sure Ollama has a copy of `base` that runs with `ctx` tokens; returns the
/// name to launch. A model that already carries a big enough `num_ctx` is used as is.
pub fn ensure_ollama_context(root: &str, base: &str, ctx: i64) -> anyhow::Result<String> {
    if !valid_model_name(base) {
        bail!("That isn't a valid model name");
    }
    if let Ok(v) = show(root, base) {
        if parse_num_ctx(v["parameters"].as_str().unwrap_or("")).is_some_and(|c| c >= ctx) {
            return Ok(base.to_string());
        }
    }
    let name = derived_name(base, ctx);
    if let Ok(v) = show(root, &name) {
        if parse_num_ctx(v["parameters"].as_str().unwrap_or("")) == Some(ctx) {
            return Ok(name);
        }
    }
    let v = post_json(
        &format!("{root}/api/create"),
        None,
        &json!({ "model": name, "from": base, "parameters": { "num_ctx": ctx }, "stream": false }),
        ENSURE_TIMEOUT,
    )?;
    if let Some(e) = v["error"].as_str() {
        bail!("{e}");
    }
    Ok(name)
}

/// Names of derived copies of `base` (any window), for deleting them with it.
pub fn derived_copies(tags: &Value, base: &str) -> Vec<String> {
    let (name, tag) = base.rsplit_once(':').unwrap_or((base, "latest"));
    let prefix = format!("{name}:{tag}{DERIVED_MARK}");
    tags["models"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|m| m["name"].as_str().or_else(|| m["model"].as_str()))
        .filter(|n| n.starts_with(&prefix) && is_derived(n))
        .map(str::to_string)
        .collect()
}

// ---- other servers -----------------------------------------------------------

/// LM Studio: the loaded window of `model`, if it is loaded (`Some(None)`: loaded,
/// size unknown; `None`: not loaded).
fn lmstudio_loaded(root: &str, key: Option<&str>, model: &str) -> Option<Option<i64>> {
    let v = get_json(&format!("{root}/api/v0/models"), key).ok()?;
    let m = v["data"]
        .as_array()?
        .iter()
        .find(|m| m["id"].as_str() == Some(model))?;
    (m["state"].as_str() == Some("loaded")).then(|| m["loaded_context_length"].as_i64())
}

/// llama.cpp: the per-slot window from `/props`.
pub fn parse_props_context(props: &Value) -> Option<i64> {
    let n_ctx = props["default_generation_settings"]["n_ctx"].as_i64()?;
    let slots = props["total_slots"].as_i64().unwrap_or(1).max(1);
    Some(n_ctx / slots)
}

// ---- the launch hook ---------------------------------------------------------

/// What a local agent should start with.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Prepared {
    /// The model name to launch with (differs from the chosen one on Ollama when a
    /// larger-window copy is used).
    pub model: Option<String>,
    /// The window the server runs with, when known.
    pub context: Option<i64>,
    /// Things to tell the user, in plain words.
    pub warnings: Vec<String>,
}

/// Why `model` can't run an agent, or `None` when it can (or the server didn't say).
pub fn tools_problem(model: &LocalModel, all: &[LocalModel]) -> Option<String> {
    if model.tools != Some(false) {
        return None;
    }
    let ok: Vec<&str> = all
        .iter()
        .filter(|m| m.tools == Some(true))
        .map(|m| m.id.as_str())
        .take(3)
        .collect();
    let alt = if ok.is_empty() {
        "Pick a model that supports tools (for example gpt-oss:20b or qwen3-coder:30b).".to_string()
    } else {
        format!("Installed models that do: {}.", ok.join(", "))
    };
    Some(format!(
        "{} doesn't support tool calling, so it can't read or edit files as an agent (it would print tool calls as text). {alt}",
        model.id
    ))
}

/// Checks the model can drive an agent and sorts out its context window. A model
/// that can't call tools is an error; trouble setting the window is only a warning
/// (the agent still starts, on the server's default).
pub fn prepare(
    server: &LocalServer,
    key: Option<&str>,
    model: Option<&str>,
    models: &[LocalModel],
    requested: Option<i64>,
    hw: &Hardware,
) -> anyhow::Result<Prepared> {
    let mut out = Prepared {
        model: model.map(str::to_string),
        ..Prepared::default()
    };
    let Some(id) = model else { return Ok(out) };
    let info = models.iter().find(|m| m.id == id);
    if let Some(m) = info {
        if let Some(problem) = tools_problem(m, models) {
            bail!(problem);
        }
    }
    let kv = kv_bytes_per_token(id, info.and_then(|m| m.parameters.as_deref()));
    let ctx = pick_context(
        info.and_then(|m| m.context_length),
        hw.model_memory_bytes
            .filter(|_| crate::local::is_loopback(&server.base_url)),
        info.and_then(|m| m.size_bytes),
        kv,
        requested,
    );
    match server.kind {
        LocalKind::Ollama => match ensure_ollama_context(root(server), id, ctx) {
            Ok(name) => {
                out.model = Some(name);
                out.context = Some(ctx);
            }
            Err(e) => out.warnings.push(format!(
                "Couldn't give {id} a larger context window ({e}). Ollama will use its own default, which may be only 4k tokens. Start Ollama with OLLAMA_CONTEXT_LENGTH=65536 to fix this."
            )),
        },
        LocalKind::Lmstudio => {
            let r = root(server);
            match lmstudio_loaded(r, key, id) {
                Some(Some(loaded)) => {
                    out.context = Some(loaded);
                    if loaded < MIN_GOOD_CONTEXT {
                        out.warnings.push(format!(
                            "{id} is loaded in LM Studio with a {}k window. Reload it with a larger one: lms load {id} --context-length {TARGET_CONTEXT}",
                            loaded / 1024
                        ));
                    }
                }
                Some(None) => {}
                None => {
                    let url = format!("{r}/api/v1/models/load");
                    match post_json(&url, key, &json!({ "model": id, "context_length": ctx }), ENSURE_TIMEOUT)
                    {
                        Ok(v) if v["error"].is_null() => out.context = Some(ctx),
                        _ => out.warnings.push(format!(
                            "Couldn't load {id} with a {}k window. Load it in LM Studio with a larger context length (65536 is a good size).",
                            ctx / 1024
                        )),
                    }
                }
            }
        }
        LocalKind::Custom => {
            let props = get_json(&format!("{}/props", root(server)), key).ok();
            out.context = props.as_ref().and_then(parse_props_context);
            if out.context.is_none() {
                // vLLM and friends report their limit as the model's context length.
                out.context = info.and_then(|m| m.context_length);
            }
        }
    }
    if let Some(c) = out.context {
        out.warnings.extend(context_warning(c));
    }
    Ok(out)
}

#[cfg(test)]
pub(crate) mod fake {
    //! A throwaway HTTP server for tests: answers by path, records requests.
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    pub struct Fake {
        pub url: String,
        pub seen: Arc<Mutex<Vec<String>>>,
    }

    /// `routes`: (path prefix, JSON body). First match wins; no match is a 404.
    pub fn serve(routes: Vec<(&'static str, String)>) -> Fake {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { return };
                let mut buf = vec![0u8; 65536];
                let mut n = 0;
                // Read the head, then the body by Content-Length.
                while let Ok(k) = s.read(&mut buf[n..]) {
                    n += k;
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    if let Some(h) = text.find("\r\n\r\n") {
                        let len = text[..h]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if n >= h + 4 + len {
                            break;
                        }
                    }
                    if k == 0 {
                        break;
                    }
                }
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let first = req.lines().next().unwrap_or("").to_string();
                let path = first.split_whitespace().nth(1).unwrap_or("").to_string();
                let body = req.split("\r\n\r\n").nth(1).unwrap_or("");
                log.lock().unwrap().push(format!("{first} {body}"));
                let (status, payload) = routes
                    .iter()
                    .find(|(p, _)| path.starts_with(p))
                    .map(|(_, b)| ("200 OK", b.clone()))
                    .unwrap_or(("404 Not Found", "{}".into()));
                let _ = write!(
                    s,
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
            }
        });
        Fake { url, seen }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str, ctx: Option<i64>, tools: Option<bool>) -> LocalModel {
        LocalModel {
            id: id.into(),
            size_bytes: Some(19_000_000_000),
            parameters: Some("30.5B".into()),
            quantization: None,
            context_length: ctx,
            tools,
        }
    }

    fn hw(mem: Option<u64>) -> Hardware {
        Hardware {
            os: "linux".into(),
            ram_bytes: None,
            gpus: vec![],
            unified_memory: false,
            accel: "gpu".into(),
            model_memory_bytes: mem,
            models_dir: None,
            disk_free_bytes: None,
        }
    }

    #[test]
    fn picks_the_window_by_memory() {
        let gib = 1u64 << 30;
        // Plenty of room: 64k, but never beyond what the model supports.
        assert_eq!(
            pick_context(
                Some(262_144),
                Some(48 * gib),
                Some(19 * gib),
                96 * 1024,
                None
            ),
            65_536
        );
        assert_eq!(
            pick_context(
                Some(32_768),
                Some(48 * gib),
                Some(19 * gib),
                96 * 1024,
                None
            ),
            32_768
        );
        // 24 GB card, 19 GB model: little room left, so a smaller window.
        let c = pick_context(
            Some(262_144),
            Some(24 * gib),
            Some(19 * gib),
            96 * 1024,
            None,
        );
        assert_eq!(c, 32_768);
        // 8 GB more weights than room: the smaller step.
        assert_eq!(
            pick_context(
                Some(262_144),
                Some(22 * gib),
                Some(19 * gib),
                96 * 1024,
                None
            ),
            16_384
        );
        // Unknown memory: the target.
        assert_eq!(pick_context(None, None, None, 1, None), 65_536);
        // The user's choice wins, bounded by the model.
        assert_eq!(
            pick_context(Some(131_072), Some(gib), Some(19 * gib), 1, Some(100_000)),
            100_000
        );
        assert_eq!(
            pick_context(Some(8_192), None, None, 1, Some(100_000)),
            8_192
        );
        // Doesn't fit at all: the floor, not zero.
        assert_eq!(
            pick_context(Some(262_144), Some(gib), Some(19 * gib), 96 * 1024, None),
            8_192
        );
    }

    #[test]
    fn estimates_kv_cache() {
        assert_eq!(kv_bytes_per_token("gpt-oss:20b", None), 48 * 1024);
        assert_eq!(
            kv_bytes_per_token("hf.co/x/Devstral-Small:Q4", None),
            160 * 1024
        );
        assert_eq!(kv_bytes_per_token("mystery:7b", Some("7.2B")), 29_491);
        assert!(kv_bytes_per_token("tiny", Some("0.5B")) >= 16 * 1024);
    }

    #[test]
    fn names_derived_models() {
        assert_eq!(
            derived_name("qwen3-coder:30b", 65_536),
            "qwen3-coder:30b-agent64k"
        );
        assert_eq!(derived_name("llama3.2", 32_768), "llama3.2:latest-agent32k");
        assert!(is_derived("qwen3-coder:30b-agent64k"));
        assert!(!is_derived("qwen3-coder:30b"));
        assert!(!is_derived("agent-smith:latest"));
        assert!(!is_derived("x:y-agentk"));
        assert_eq!(
            parse_num_ctx("num_ctx 65536\nstop \"<|im_end|>\""),
            Some(65_536)
        );
        assert_eq!(parse_num_ctx("stop x"), None);
    }

    #[test]
    fn codex_gets_the_real_window() {
        let a = codex_args(65_536);
        assert_eq!(a[1], "model_context_window=65536");
        assert_eq!(a[3], "model_auto_compact_token_limit=52428");
        assert!(context_warning(4096).is_some());
        assert!(context_warning(65_536).is_none());
    }

    #[test]
    fn refuses_models_without_tools_and_names_alternatives() {
        let all = vec![
            model("llama2:7b", Some(4096), Some(false)),
            model("gpt-oss:20b", Some(131_072), Some(true)),
        ];
        let msg = tools_problem(&all[0], &all).unwrap();
        assert!(msg.contains("llama2:7b") && msg.contains("gpt-oss:20b"));
        assert!(tools_problem(&all[1], &all).is_none());
        assert!(tools_problem(&model("x", None, None), &all).is_none());
        let s = LocalServer {
            kind: LocalKind::Ollama,
            base_url: "http://127.0.0.1:9".into(),
        };
        assert!(prepare(&s, None, Some("llama2:7b"), &all, None, &hw(None)).is_err());
    }

    #[test]
    fn reads_llamacpp_props() {
        let v = json!({"default_generation_settings":{"n_ctx":65536},"total_slots":4});
        assert_eq!(parse_props_context(&v), Some(16_384));
        assert_eq!(parse_props_context(&json!({})), None);
    }

    #[test]
    fn finds_derived_copies() {
        let tags = json!({"models":[
            {"name":"qwen3-coder:30b"},{"name":"qwen3-coder:30b-agent64k"},
            {"name":"qwen3-coder:30b-agent32k"},{"name":"qwen3-coder:480b-agent64k"}]});
        let mut c = derived_copies(&tags, "qwen3-coder:30b");
        c.sort();
        assert_eq!(
            c,
            vec!["qwen3-coder:30b-agent32k", "qwen3-coder:30b-agent64k"]
        );
    }

    #[test]
    fn ollama_gets_a_derived_model_with_the_window() {
        let f = fake::serve(vec![
            (
                "/api/show",
                r#"{"parameters":"stop x","capabilities":["tools"]}"#.into(),
            ),
            ("/api/create", r#"{"status":"success"}"#.into()),
        ]);
        let name = ensure_ollama_context(&f.url, "qwen3-coder:30b", 65_536).unwrap();
        assert_eq!(name, "qwen3-coder:30b-agent64k");
        let seen = f.seen.lock().unwrap().clone();
        let create = seen.iter().find(|r| r.contains("/api/create")).unwrap();
        assert!(
            create.contains("\"num_ctx\":65536") && create.contains("\"from\":\"qwen3-coder:30b\"")
        );
    }

    #[test]
    fn a_model_that_already_has_the_window_is_used_as_is() {
        let f = fake::serve(vec![(
            "/api/show",
            r#"{"parameters":"num_ctx 131072"}"#.into(),
        )]);
        assert_eq!(ensure_ollama_context(&f.url, "m:1", 65_536).unwrap(), "m:1");
        assert_eq!(f.seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn prepare_for_ollama_reports_a_failed_create_as_a_warning() {
        let f = fake::serve(vec![("/api/show", r#"{"parameters":""}"#.into())]);
        let s = LocalServer {
            kind: LocalKind::Ollama,
            base_url: f.url.clone(),
        };
        let all = vec![model("m:1", Some(131_072), Some(true))];
        // /api/create 404s: the agent still starts, on Ollama's default, with a warning.
        let p = prepare(&s, None, Some("m:1"), &all, None, &hw(None)).unwrap();
        assert_eq!(p.model.as_deref(), Some("m:1"));
        assert_eq!(p.context, None);
        assert!(p.warnings[0].contains("OLLAMA_CONTEXT_LENGTH"));
    }

    #[test]
    fn prepare_for_ollama_succeeds_end_to_end() {
        let f = fake::serve(vec![
            ("/api/show", r#"{"parameters":""}"#.into()),
            ("/api/create", r#"{"status":"success"}"#.into()),
        ]);
        let s = LocalServer {
            kind: LocalKind::Ollama,
            base_url: f.url.clone(),
        };
        let all = vec![model("m:1", Some(131_072), Some(true))];
        let p = prepare(&s, None, Some("m:1"), &all, Some(16_384), &hw(None)).unwrap();
        assert_eq!(p.model.as_deref(), Some("m:1-agent16k"));
        assert_eq!(p.context, Some(16_384));
        assert!(p.warnings[0].contains("small for agent work"));
    }
}
