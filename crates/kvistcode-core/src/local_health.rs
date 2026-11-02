//! Is a local model server healthy, what is loaded on it, how fast is it, and what
//! should the user do about what's wrong. Plus model management (unload, delete).
//! Blocking: call from `spawn_blocking`.

use std::time::{Duration, Instant};

use anyhow::{anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::local::{agent, check_target, get_json, probe, root, valid_model_name};
use crate::local_ctx::{derived_copies, MIN_GOOD_CONTEXT};
use crate::model::{LocalKind, LocalModel, LocalProbe, LocalServer};

/// The first Ollama with `/v1/responses`, which Codex needs.
const OLLAMA_MIN_VERSION: (u32, u32, u32) = (0, 13, 3);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedModel {
    pub id: String,
    pub size_bytes: Option<u64>,
    /// How much of it sits in GPU memory.
    pub vram_bytes: Option<u64>,
    pub context_length: Option<i64>,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthIssue {
    /// "error", "warn" or "info".
    pub severity: String,
    pub code: String,
    pub message: String,
    /// What to do about it, in plain words.
    pub fix: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHealth {
    pub kind: LocalKind,
    pub base_url: String,
    pub running: bool,
    pub remote: bool,
    pub version: Option<String>,
    /// "Ollama", "LM Studio", "llama.cpp", "vLLM" or "OpenAI-compatible".
    pub flavor: String,
    pub loaded: Vec<LoadedModel>,
    pub models: Vec<LocalModel>,
    pub issues: Vec<HealthIssue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedResult {
    pub model: String,
    pub tokens_per_second: Option<f64>,
    pub completion_tokens: Option<i64>,
    pub prompt_tokens: Option<i64>,
    /// Time spent loading the model into memory first.
    pub load_ms: Option<i64>,
    pub total_ms: i64,
}

// ---- parsing (pure) ----------------------------------------------------------

pub fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let core = s.trim().trim_start_matches('v');
    let mut it = core.split(['.', '-', '+']).map(|p| p.parse::<u32>());
    Some((it.next()?.ok()?, it.next()?.ok()?, it.next()?.ok()?))
}

/// Ollama `GET /api/ps`.
pub fn parse_ps(v: &Value) -> Vec<LoadedModel> {
    v["models"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|m| {
            Some(LoadedModel {
                id: m["model"]
                    .as_str()
                    .or_else(|| m["name"].as_str())?
                    .to_string(),
                size_bytes: m["size"].as_u64(),
                vram_bytes: m["size_vram"].as_u64(),
                context_length: m["context_length"].as_i64(),
                expires_at: m["expires_at"].as_str().map(str::to_string),
            })
        })
        .collect()
}

/// LM Studio `/api/v0/models`: the loaded models.
pub fn parse_lmstudio_loaded(v: &Value) -> Vec<LoadedModel> {
    v["data"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|m| m["state"].as_str() == Some("loaded"))
        .filter_map(|m| {
            Some(LoadedModel {
                id: m["id"].as_str()?.to_string(),
                size_bytes: None,
                vram_bytes: None,
                context_length: m["loaded_context_length"].as_i64(),
                expires_at: None,
            })
        })
        .collect()
}

fn issue(sev: &str, code: &str, message: impl Into<String>, fix: Option<&str>) -> HealthIssue {
    HealthIssue {
        severity: sev.into(),
        code: code.into(),
        message: message.into(),
        fix: fix.map(str::to_string),
    }
}

/// Turns what was found into problems with a fix each, worst first.
pub fn diagnose(
    probe: &LocalProbe,
    version: Option<&str>,
    loaded: &[LoadedModel],
) -> Vec<HealthIssue> {
    let mut out = Vec::new();
    if !probe.running {
        let fix = match probe.kind {
            LocalKind::Ollama => "Open the Ollama app, or run `ollama serve` in a terminal. If Ollama is on another machine, start it there with OLLAMA_HOST=0.0.0.0 so it accepts connections from the network.",
            LocalKind::Lmstudio => "In LM Studio open the Developer tab and turn the server on. For another machine, also turn on \"Serve on local network\".",
            LocalKind::Custom => "Check the address (it should end in /v1) and that the server is running. A server on another machine must listen on 0.0.0.0, not only on 127.0.0.1.",
        };
        out.push(issue(
            "error",
            "not_running",
            probe
                .error
                .clone()
                .unwrap_or_else(|| "The server didn't answer.".into()),
            Some(fix),
        ));
        return out;
    }
    if let (LocalKind::Ollama, Some(v)) = (probe.kind, version.and_then(parse_version)) {
        if v < OLLAMA_MIN_VERSION {
            out.push(issue(
                "error",
                "old_version",
                format!(
                    "Ollama {} is too old: it has no /v1/responses endpoint, which Codex needs (added in 0.13.3).",
                    version.unwrap_or_default()
                ),
                Some("Update Ollama from https://ollama.com/download."),
            ));
        }
    }
    if probe.models.is_empty() {
        out.push(issue(
            "warn",
            "no_models",
            "The server has no models yet.",
            Some(match probe.kind {
                LocalKind::Ollama => "Use \"Get a model\" to download one.",
                _ => "Download a model in the server's app.",
            }),
        ));
    } else if !probe.models.iter().any(|m| m.tools == Some(true))
        && probe.models.iter().all(|m| m.tools == Some(false))
    {
        out.push(issue(
            "warn",
            "no_tool_models",
            "None of the models here support tool calling, so none can work as an agent.",
            Some("Download one that does, such as gpt-oss:20b or qwen3-coder:30b."),
        ));
    }
    for m in loaded {
        if let Some(c) = m.context_length.filter(|c| *c < MIN_GOOD_CONTEXT) {
            out.push(issue(
                "warn",
                "small_context",
                format!(
                    "{} is loaded with a {}k-token window. Agents lose earlier instructions and files when the window is that small.",
                    m.id,
                    c / 1024
                ),
                Some(match probe.kind {
                    LocalKind::Ollama => "Kvistcode starts its agents on a larger-window copy automatically. For other tools, start Ollama with OLLAMA_CONTEXT_LENGTH=65536.",
                    LocalKind::Lmstudio => "Reload the model with a larger context: `lms load <model> --context-length 65536`.",
                    LocalKind::Custom => "Restart the server with a larger context (llama.cpp: -c 65536, vLLM: --max-model-len).",
                }),
            ));
        }
        if let (Some(size), Some(vram)) = (m.size_bytes, m.vram_bytes) {
            if size > 0 && vram < size / 100 * 95 {
                out.push(issue(
                    "warn",
                    "cpu_offload",
                    format!(
                        "{} is only {}% in GPU memory; the rest runs on the CPU, which is several times slower.",
                        m.id,
                        vram * 100 / size
                    ),
                    Some("Use a smaller model or quantization, or a shorter context window. Closing other GPU-heavy apps also helps."),
                ));
            }
        }
    }
    if probe.models.iter().any(|m| m.tools == Some(false))
        && probe.models.iter().any(|m| m.tools == Some(true))
    {
        let names: Vec<&str> = probe
            .models
            .iter()
            .filter(|m| m.tools == Some(false))
            .map(|m| m.id.as_str())
            .take(3)
            .collect();
        out.push(issue(
            "info",
            "some_without_tools",
            format!(
                "Without tool support, so not usable as agents: {}.",
                names.join(", ")
            ),
            None,
        ));
    }
    if probe.remote {
        out.push(issue(
            "info",
            "remote",
            "This server is on another machine: prompts and code are sent to it over the network.",
            Some("Over the internet use Tailscale (`tailscale serve`) or another encrypted tunnel rather than opening a port."),
        ));
    }
    out.sort_by_key(|i| match i.severity.as_str() {
        "error" => 0,
        "warn" => 1,
        _ => 2,
    });
    out
}

// ---- network ------------------------------------------------------------------

fn flavor_of(server: &LocalServer, key: Option<&str>) -> (String, Option<String>) {
    match server.kind {
        LocalKind::Ollama => {
            let v = get_json(&format!("{}/api/version", root(server)), key)
                .ok()
                .and_then(|v| v["version"].as_str().map(str::to_string));
            ("Ollama".into(), v)
        }
        LocalKind::Lmstudio => ("LM Studio".into(), None),
        LocalKind::Custom => {
            let r = root(server);
            if get_json(&format!("{r}/props"), key)
                .is_ok_and(|v| v.get("default_generation_settings").is_some())
            {
                return ("llama.cpp".into(), None);
            }
            if let Ok(v) = get_json(&format!("{r}/version"), key) {
                if let Some(ver) = v["version"].as_str() {
                    return ("vLLM".into(), Some(ver.to_string()));
                }
            }
            ("OpenAI-compatible".into(), None)
        }
    }
}

/// Everything the health panel shows. Never fails: an unreachable server is a
/// `running: false` result with an error issue.
pub fn health(server: &LocalServer, key: Option<&str>) -> LocalHealth {
    let p = probe(server, key);
    let (mut flavor, mut version, mut loaded) = (server.kind.label().to_string(), None, Vec::new());
    if p.running {
        let (f, v) = flavor_of(server, key);
        flavor = f;
        version = v;
        loaded = match server.kind {
            LocalKind::Ollama => get_json(&format!("{}/api/ps", root(server)), key)
                .map(|v| parse_ps(&v))
                .unwrap_or_default(),
            LocalKind::Lmstudio => get_json(&format!("{}/api/v0/models", root(server)), key)
                .map(|v| parse_lmstudio_loaded(&v))
                .unwrap_or_default(),
            LocalKind::Custom => Vec::new(),
        };
    }
    let issues = diagnose(&p, version.as_deref(), &loaded);
    LocalHealth {
        kind: p.kind,
        base_url: p.base_url,
        running: p.running,
        remote: p.remote,
        version,
        flavor,
        loaded,
        models: p.models,
        issues,
    }
}

fn post(url: &str, key: Option<&str>, body: &Value, read: Duration) -> anyhow::Result<Value> {
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

/// One short generation, to measure how fast the model runs here.
pub fn speed_test(
    server: &LocalServer,
    key: Option<&str>,
    model: &str,
) -> anyhow::Result<SpeedResult> {
    let started = Instant::now();
    let prompt = "Write a four line poem about compilers.";
    let long = Duration::from_secs(300); // a cold start loads the whole model first
    let mut r = SpeedResult {
        model: model.into(),
        tokens_per_second: None,
        completion_tokens: None,
        prompt_tokens: None,
        load_ms: None,
        total_ms: 0,
    };
    if server.kind == LocalKind::Ollama {
        let v = post(
            &format!("{}/api/generate", root(server)),
            key,
            &json!({ "model": model, "prompt": prompt, "stream": false, "options": { "num_predict": 96 } }),
            long,
        )?;
        if let Some(e) = v["error"].as_str() {
            bail!("{e}");
        }
        let (n, ns) = (v["eval_count"].as_i64(), v["eval_duration"].as_f64());
        r.completion_tokens = n;
        r.prompt_tokens = v["prompt_eval_count"].as_i64();
        r.load_ms = v["load_duration"].as_f64().map(|d| (d / 1e6) as i64);
        r.tokens_per_second = n
            .zip(ns)
            .filter(|(_, ns)| *ns > 0.0)
            .map(|(n, ns)| n as f64 / (ns / 1e9));
    } else {
        let url = format!("{}/chat/completions", crate::local::openai_base(server));
        let v = post(
            &url,
            key,
            &json!({ "model": model, "messages": [{ "role": "user", "content": prompt }], "max_tokens": 96, "stream": false }),
            long,
        )?;
        if let Some(e) = v["error"]["message"]
            .as_str()
            .or_else(|| v["error"].as_str())
        {
            bail!("{e}");
        }
        r.completion_tokens = v["usage"]["completion_tokens"].as_i64();
        r.prompt_tokens = v["usage"]["prompt_tokens"].as_i64();
        let secs = started.elapsed().as_secs_f64();
        // Includes prompt processing (and any model load), so it reads a little low.
        r.tokens_per_second = r
            .completion_tokens
            .filter(|_| secs > 0.0)
            .map(|n| n as f64 / secs);
    }
    r.total_ms = started.elapsed().as_millis() as i64;
    Ok(r)
}

/// Frees the memory a loaded model uses right now.
pub fn unload(server: &LocalServer, key: Option<&str>, model: &str) -> anyhow::Result<()> {
    match server.kind {
        LocalKind::Ollama => {
            post(
                &format!("{}/api/generate", root(server)),
                key,
                &json!({ "model": model, "keep_alive": 0 }),
                Duration::from_secs(30),
            )?;
            Ok(())
        }
        LocalKind::Lmstudio => {
            post(
                &format!("{}/api/v1/models/unload", root(server)),
                key,
                &json!({ "instance_id": model }),
                Duration::from_secs(30),
            )?;
            Ok(())
        }
        LocalKind::Custom => bail!("This kind of server can't unload a model from here"),
    }
}

/// Deletes an Ollama model from disk, together with the larger-window copies
/// Kvistcode made of it.
pub fn delete_model(server: &LocalServer, model: &str) -> anyhow::Result<()> {
    if server.kind != LocalKind::Ollama {
        bail!("Only Ollama models can be deleted from here");
    }
    if !valid_model_name(model) {
        bail!("That isn't a valid model name");
    }
    let r = root(server);
    let tags = get_json(&format!("{r}/api/tags"), None).unwrap_or(Value::Null);
    let mut names = derived_copies(&tags, model);
    names.push(model.to_string());
    for name in names {
        let url = format!("{r}/api/delete");
        check_target(&url, false)?;
        let result = agent(Duration::from_secs(30))
            .delete(&url)
            .force_send_body()
            .header("Content-Type", "application/json")
            .send(json!({ "model": name }).to_string());
        match result {
            Ok(_) => {}
            // Already gone is fine for the copies.
            Err(ureq::Error::StatusCode(404)) if name != model => {}
            Err(e) => bail!("Couldn't delete {name}: {e}"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_ctx::fake;

    fn lm(id: &str, tools: Option<bool>) -> LocalModel {
        LocalModel {
            id: id.into(),
            size_bytes: None,
            parameters: None,
            quantization: None,
            context_length: None,
            tools,
        }
    }

    fn probe_of(
        kind: LocalKind,
        running: bool,
        models: Vec<LocalModel>,
        remote: bool,
    ) -> LocalProbe {
        LocalProbe {
            kind,
            base_url: "http://x".into(),
            running,
            models,
            error: (!running).then(|| "Ollama isn't running.".into()),
            remote,
        }
    }

    #[test]
    fn versions_compare() {
        assert_eq!(parse_version("0.13.3"), Some((0, 13, 3)));
        assert_eq!(parse_version("v0.12.11-rc1"), Some((0, 12, 11)));
        assert!(parse_version("0.12.9").unwrap() < OLLAMA_MIN_VERSION);
        assert!(parse_version("0.14.0").unwrap() >= OLLAMA_MIN_VERSION);
        assert_eq!(parse_version("dev"), None);
    }

    #[test]
    fn reads_ps() {
        let v = json!({"models":[{"name":"m:1","model":"m:1","size":1000,"size_vram":800,
            "context_length":4096,"expires_at":"2026-01-01T00:05:00Z"}]});
        let l = parse_ps(&v);
        assert_eq!(l[0].vram_bytes, Some(800));
        assert_eq!(l[0].context_length, Some(4096));
        assert!(parse_ps(&json!({})).is_empty());
    }

    #[test]
    fn a_stopped_server_gets_one_error_with_a_fix() {
        let i = diagnose(
            &probe_of(LocalKind::Ollama, false, vec![], false),
            None,
            &[],
        );
        assert_eq!(i.len(), 1);
        assert_eq!(i[0].code, "not_running");
        assert!(i[0].fix.as_deref().unwrap().contains("ollama serve"));
    }

    #[test]
    fn problems_come_with_fixes_worst_first() {
        let p = probe_of(
            LocalKind::Ollama,
            true,
            vec![lm("a", Some(false)), lm("b", Some(true))],
            true,
        );
        let loaded = vec![LoadedModel {
            id: "b".into(),
            size_bytes: Some(10_000),
            vram_bytes: Some(5_000),
            context_length: Some(4096),
            expires_at: None,
        }];
        let i = diagnose(&p, Some("0.12.0"), &loaded);
        let codes: Vec<&str> = i.iter().map(|x| x.code.as_str()).collect();
        assert_eq!(codes[0], "old_version");
        assert!(codes.contains(&"small_context") && codes.contains(&"cpu_offload"));
        assert!(codes.contains(&"some_without_tools") && codes.contains(&"remote"));
        assert_eq!(*codes.last().unwrap(), "remote");
        let offload = i.iter().find(|x| x.code == "cpu_offload").unwrap();
        assert!(offload.message.contains("50%"));
        // A healthy local server has nothing to say.
        let ok = probe_of(LocalKind::Ollama, true, vec![lm("b", Some(true))], false);
        assert!(diagnose(&ok, Some("0.13.4"), &[]).is_empty());
        let none = probe_of(LocalKind::Ollama, true, vec![lm("a", Some(false))], false);
        assert_eq!(diagnose(&none, None, &[])[0].code, "no_tool_models");
    }

    #[test]
    fn health_of_a_fake_ollama() {
        let f = fake::serve(vec![
            ("/api/tags", r#"{"models":[{"name":"gpt-oss:20b","size":14000000000}]}"#.into()),
            ("/api/show", r#"{"capabilities":["completion","tools"],"model_info":{"gptoss.context_length":131072}}"#.into()),
            ("/api/version", r#"{"version":"0.13.4"}"#.into()),
            ("/api/ps", r#"{"models":[{"model":"gpt-oss:20b","size":14000000000,"size_vram":14000000000,"context_length":65536}]}"#.into()),
        ]);
        let s = LocalServer {
            kind: LocalKind::Ollama,
            base_url: f.url.clone(),
        };
        let h = health(&s, None);
        assert!(h.running && h.version.as_deref() == Some("0.13.4"));
        assert_eq!(h.loaded.len(), 1);
        assert_eq!(h.models[0].tools, Some(true));
        assert!(h.issues.is_empty(), "{:?}", h.issues);
    }

    #[test]
    fn speed_test_reads_ollama_timings() {
        let f = fake::serve(vec![(
            "/api/generate",
            r#"{"eval_count":96,"eval_duration":2000000000,"prompt_eval_count":12,"load_duration":1500000000}"#.into(),
        )]);
        let s = LocalServer {
            kind: LocalKind::Ollama,
            base_url: f.url.clone(),
        };
        let r = speed_test(&s, None, "m:1").unwrap();
        assert_eq!(r.tokens_per_second, Some(48.0));
        assert_eq!(r.load_ms, Some(1500));
    }

    #[test]
    fn speed_test_on_an_openai_server_and_errors() {
        let f = fake::serve(vec![(
            "/v1/chat/completions",
            r#"{"usage":{"completion_tokens":50,"prompt_tokens":10}}"#.into(),
        )]);
        let s = LocalServer {
            kind: LocalKind::Custom,
            base_url: format!("{}/v1", f.url),
        };
        let r = speed_test(&s, None, "m").unwrap();
        assert_eq!(r.completion_tokens, Some(50));
        assert!(r.tokens_per_second.unwrap() > 0.0);
        let bad = fake::serve(vec![(
            "/api/generate",
            r#"{"error":"model not found"}"#.into(),
        )]);
        let s = LocalServer {
            kind: LocalKind::Ollama,
            base_url: bad.url.clone(),
        };
        assert!(speed_test(&s, None, "m")
            .unwrap_err()
            .to_string()
            .contains("model not found"));
    }

    #[test]
    fn deleting_takes_the_derived_copies_along() {
        let f = fake::serve(vec![
            (
                "/api/tags",
                r#"{"models":[{"name":"m:1"},{"name":"m:1-agent64k"}]}"#.into(),
            ),
            ("/api/delete", "{}".into()),
        ]);
        let s = LocalServer {
            kind: LocalKind::Ollama,
            base_url: f.url.clone(),
        };
        delete_model(&s, "m:1").unwrap();
        let seen = f.seen.lock().unwrap().clone();
        let dels: Vec<&String> = seen.iter().filter(|r| r.starts_with("DELETE")).collect();
        assert_eq!(dels.len(), 2);
        assert!(dels[0].contains("m:1-agent64k") && dels[1].contains("\"m:1\""));
        let lms = LocalServer {
            kind: LocalKind::Lmstudio,
            base_url: f.url.clone(),
        };
        assert!(delete_model(&lms, "m").is_err());
    }
}
