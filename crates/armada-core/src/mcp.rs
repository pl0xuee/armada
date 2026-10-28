//! "Test connection" for MCP servers: does the MCP handshake and lists the tools.

use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use serde_json::{json, Value};

use crate::jsonrpc::{Peer, SpawnOptions};
use crate::model::{McpServer, McpTransport};

const PROTOCOL_VERSION: &str = "2025-06-18";
const TIMEOUT: Duration = Duration::from_secs(30);
/// `tools/list` pages followed before giving up on counting.
const MAX_TOOL_PAGES: usize = 10;

/// Follows `tools/list` pagination (`nextCursor`) and returns `{"tools": [...]}`
/// with every page's tools. `list` fetches one page for the given cursor.
fn collect_tool_pages(
    mut list: impl FnMut(Option<&str>) -> anyhow::Result<Value>,
) -> anyhow::Result<Value> {
    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_TOOL_PAGES {
        let page = list(cursor.as_deref())?;
        if let Some(list) = page["tools"].as_array() {
            tools.extend(list.iter().cloned());
        }
        match page["nextCursor"].as_str().filter(|c| !c.is_empty()) {
            Some(next) if cursor.as_deref() != Some(next) => cursor = Some(next.to_string()),
            _ => break,
        }
    }
    Ok(json!({ "tools": tools }))
}

fn tools_list_params(cursor: Option<&str>) -> Value {
    match cursor {
        Some(c) => json!({ "cursor": c }),
        None => json!({}),
    }
}

/// Env/header entries with a name (blank rows from the settings form are skipped).
fn named(list: &[crate::model::KeyValue]) -> impl Iterator<Item = (&str, &str)> {
    list.iter()
        .map(|kv| (kv.name.trim(), kv.value.as_str()))
        .filter(|(name, _)| !name.is_empty())
}

fn initialize_params() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "armada", "title": "Armada", "version": env!("CARGO_PKG_VERSION") }
    })
}

/// "name version · N tools" from the initialize result and tools/list result.
fn describe(init: &Value, tools: Option<&Value>) -> String {
    let info = &init["serverInfo"];
    let name = info["title"]
        .as_str()
        .or_else(|| info["name"].as_str())
        .unwrap_or("MCP server");
    let version = info["version"]
        .as_str()
        .map(|v| format!(" {v}"))
        .unwrap_or_default();
    match tools.and_then(|t| t["tools"].as_array()) {
        Some(list) if list.len() == 1 => format!("{name}{version} · 1 tool"),
        Some(list) => format!("{name}{version} · {} tools", list.len()),
        None => format!("{name}{version}"),
    }
}

pub async fn test_server(server: &McpServer, cwd: &Path) -> anyhow::Result<String> {
    match server.transport {
        McpTransport::Stdio => test_stdio(server, cwd).await,
        McpTransport::Http => {
            let server = server.clone();
            tokio::task::spawn_blocking(move || test_http(&server)).await?
        }
    }
}

async fn test_stdio(server: &McpServer, cwd: &Path) -> anyhow::Result<String> {
    let cmd = server.command.trim();
    if cmd.is_empty() {
        bail!("Enter the command that starts the server");
    }
    let program = which::which(cmd)
        .map_err(|_| anyhow!("Couldn't find `{cmd}`. Install it or use a full path."))?;
    let env: Vec<(String, String)> = named(&server.env)
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let (peer, _rx) = Peer::spawn(SpawnOptions {
        program: &program,
        args: &server.args,
        cwd,
        env: &env,
        env_remove: &[],
        label: "mcp-test",
        children_file: None,
    })?;
    let result = async {
        let init = peer
            .request_timeout("initialize", initialize_params(), Some(TIMEOUT))
            .await?;
        peer.notify("notifications/initialized", json!({})).await?;
        let tools = if init["capabilities"]["tools"].is_object() {
            let mut tools = Vec::new();
            let mut cursor: Option<String> = None;
            let mut ok = true;
            for _ in 0..MAX_TOOL_PAGES {
                let page = match peer
                    .request_timeout(
                        "tools/list",
                        tools_list_params(cursor.as_deref()),
                        Some(TIMEOUT),
                    )
                    .await
                {
                    Ok(page) => page,
                    Err(_) => {
                        ok = !tools.is_empty();
                        break;
                    }
                };
                if let Some(list) = page["tools"].as_array() {
                    tools.extend(list.iter().cloned());
                }
                match page["nextCursor"].as_str().filter(|c| !c.is_empty()) {
                    Some(next) if cursor.as_deref() != Some(next) => {
                        cursor = Some(next.to_string())
                    }
                    _ => break,
                }
            }
            ok.then(|| json!({ "tools": tools }))
        } else {
            None
        };
        anyhow::Ok(describe(&init, tools.as_ref()))
    }
    .await;
    let tail = peer.stderr_tail(4);
    peer.kill().await;
    result.map_err(|e| {
        if tail.trim().is_empty() {
            e
        } else {
            e.context(format!("server output:\n{tail}"))
        }
    })
}

/// One Streamable-HTTP JSON-RPC exchange. Returns the response (if `id` is set) and
/// the session id the server assigned.
fn http_call(
    agent: &ureq::Agent,
    server: &McpServer,
    session: Option<&str>,
    body: Value,
) -> anyhow::Result<(Option<Value>, Option<String>)> {
    let mut req = agent
        .post(server.url.trim())
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", PROTOCOL_VERSION);
    for (name, value) in named(&server.headers) {
        req = req.header(name, value);
    }
    if let Some(s) = session {
        req = req.header("Mcp-Session-Id", s);
    }
    let id = body.get("id").cloned();
    let mut res = req.send(serde_json::to_vec(&body)?.as_slice())?;
    let status = res.status().as_u16();
    let session = res
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let is_sse = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"));
    if status == 401 || status == 403 {
        bail!("The server refused the request (HTTP {status}). Check the auth headers.");
    }
    if !(200..300).contains(&status) {
        let text = res
            .body_mut()
            .with_config()
            .limit(4096)
            .read_to_string()
            .unwrap_or_default();
        bail!("HTTP {status}: {}", text.trim());
    }
    let Some(id) = id else {
        return Ok((None, session));
    };
    let reply = if is_sse {
        // Read events as they arrive and stop at the reply: servers may keep the
        // stream open afterwards.
        let reader = res.body_mut().with_config().limit(8 * 1024 * 1024).reader();
        find_sse_reply(std::io::BufReader::new(reader), &id)?
    } else {
        let text = res
            .body_mut()
            .with_config()
            .limit(8 * 1024 * 1024)
            .read_to_string()?;
        Some(serde_json::from_str::<Value>(&text).context("The server's reply isn't JSON")?)
            .filter(|m| m.get("id") == Some(&id))
    }
    .ok_or_else(|| anyhow!("The server didn't answer"))?;
    if let Some(err) = reply.get("error") {
        bail!(
            "{}",
            err["message"]
                .as_str()
                .unwrap_or("The server returned an error")
        );
    }
    Ok((Some(reply["result"].clone()), session))
}

/// Reads Server-Sent Events until one carries the JSON-RPC message with `id`.
/// An event's `data:` lines are joined with newlines and end at a blank line.
fn find_sse_reply(reader: impl std::io::BufRead, id: &Value) -> anyhow::Result<Option<Value>> {
    let mut data = String::new();
    let check = |data: &mut String| -> Option<Value> {
        let msg = serde_json::from_str::<Value>(data.trim()).ok();
        data.clear();
        msg.filter(|m| m.get("id") == Some(id))
    };
    for line in reader.lines() {
        let line = line.context("reading the server's event stream")?;
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            if let Some(reply) = check(&mut data) {
                return Ok(Some(reply));
            }
        } else if let Some(d) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(d.strip_prefix(' ').unwrap_or(d));
        }
    }
    Ok(check(&mut data))
}

fn test_http(server: &McpServer) -> anyhow::Result<String> {
    let url = server.url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        bail!("Enter the server's http:// or https:// URL");
    }
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .http_status_as_error(false)
            .tls_config(crate::toolchain::platform_tls())
            .timeout_global(Some(TIMEOUT))
            .build(),
    );
    let (init, session) = http_call(
        &agent,
        server,
        None,
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": initialize_params() }),
    )?;
    let init = init.unwrap_or_default();
    let session = session.as_deref();
    http_call(
        &agent,
        server,
        session,
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )?;
    let tools = if init["capabilities"]["tools"].is_object() {
        let mut next_id = 1;
        collect_tool_pages(|cursor| {
            next_id += 1;
            let (result, _) = http_call(
                &agent,
                server,
                session,
                json!({
                    "jsonrpc": "2.0",
                    "id": next_id,
                    "method": "tools/list",
                    "params": tools_list_params(cursor),
                }),
            )?;
            result.ok_or_else(|| anyhow!("The server didn't answer"))
        })
        .ok()
    } else {
        None
    };
    Ok(describe(&init, tools.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_servers() {
        let init = json!({ "serverInfo": { "name": "fs", "version": "1.2.0" } });
        let tools = json!({ "tools": [{ "name": "read" }, { "name": "write" }] });
        assert_eq!(describe(&init, Some(&tools)), "fs 1.2.0 · 2 tools");
        assert_eq!(describe(&json!({}), None), "MCP server");
    }

    #[test]
    fn pagination_and_sse() {
        let pages = [
            json!({ "tools": [{ "name": "a" }], "nextCursor": "p2" }),
            json!({ "tools": [{ "name": "b" }, { "name": "c" }] }),
        ];
        let mut seen = Vec::new();
        let all = collect_tool_pages(|cursor| {
            seen.push(cursor.map(str::to_string));
            Ok(pages[seen.len() - 1].clone())
        })
        .unwrap();
        assert_eq!(seen, vec![None, Some("p2".to_string())]);
        assert_eq!(describe(&json!({}), Some(&all)), "MCP server · 3 tools");
        // A server repeating its cursor doesn't loop forever.
        let mut calls = 0;
        collect_tool_pages(|_| {
            calls += 1;
            Ok(json!({ "tools": [], "nextCursor": "same" }))
        })
        .unwrap();
        assert_eq!(calls, 2);

        // The reply is found without reading to the end of the stream; multi-line
        // data is joined; other messages are skipped.
        struct Endless(std::io::Cursor<Vec<u8>>);
        impl std::io::Read for Endless {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                match self.0.read(buf)? {
                    0 => panic!("read past the reply"),
                    n => Ok(n),
                }
            }
        }
        let stream = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"note\"}\n\n\
                      data: {\"jsonrpc\":\"2.0\",\r\ndata: \"id\":7,\"result\":{}}\r\n\r\n";
        let reader =
            std::io::BufReader::new(Endless(std::io::Cursor::new(stream.as_bytes().to_vec())));
        let reply = find_sse_reply(reader, &json!(7)).unwrap().unwrap();
        assert_eq!(reply["id"], 7);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stdio_handshake() {
        let dir = std::env::temp_dir().join(format!("armada-mcp-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("server.py");
        std::fs::write(
            &script,
            r#"
import json, sys
for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg:
        continue
    if msg["method"] == "initialize":
        result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                  "serverInfo": {"name": "mock", "version": "0.1"}}
    else:
        result = {"tools": [{"name": "echo", "inputSchema": {"type": "object"}}]}
    print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}), flush=True)
"#,
        )
        .unwrap();
        let server = McpServer {
            id: "t".into(),
            name: "mock".into(),
            enabled: true,
            transport: McpTransport::Stdio,
            command: "python3".into(),
            args: vec![script.to_string_lossy().into_owned()],
            env: vec![],
            url: String::new(),
            headers: vec![],
        };
        assert_eq!(
            test_server(&server, &dir).await.unwrap(),
            "mock 0.1 · 1 tool"
        );
        let missing = McpServer {
            command: "armada-no-such-mcp".into(),
            ..server
        };
        assert!(test_server(&missing, &dir).await.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
