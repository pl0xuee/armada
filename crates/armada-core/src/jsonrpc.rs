//! Newline-delimited JSON-RPC 2.0 over a child process's stdio. Both ACP and the
//! Codex app-server speak this; requests flow in both directions.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};

#[derive(Debug)]
pub enum Incoming {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    /// Marker injected by `Peer::barrier`; arrives after every message read before it.
    Barrier(u64),
    /// The process closed stdout, exited, or was killed.
    Closed,
}

#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Value,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (code {})", self.message, self.code)?;
        if let Some(details) = self.data.as_str() {
            write!(f, ": {details}")?;
        }
        Ok(())
    }
}

impl std::error::Error for RpcError {}

type Pending = HashMap<String, oneshot::Sender<Result<Value, RpcError>>>;

/// Shared "the connection is over" bookkeeping, done exactly once.
struct Closer {
    closed: AtomicBool,
    pending: Mutex<Pending>,
    tx: mpsc::UnboundedSender<Incoming>,
}

impl Closer {
    fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        for (_, waiter) in self.pending.lock().drain() {
            let _ = waiter.send(Err(RpcError {
                code: -32099,
                message: "agent process exited".into(),
                data: Value::Null,
            }));
        }
        let _ = self.tx.send(Incoming::Closed);
    }
}

pub struct Peer {
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    next_id: AtomicI64,
    closer: Arc<Closer>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    child: Mutex<Option<Child>>,
    pid: Option<u32>,
}

fn id_key(id: &Value) -> String {
    id.to_string()
}

pub struct SpawnOptions<'a> {
    pub program: &'a Path,
    pub args: &'a [String],
    pub cwd: &'a Path,
    pub env: &'a [(String, String)],
    pub label: &'a str,
}

/// Reads `\n`-terminated lines as lossy UTF-8 so one bad byte can't end the stream.
pub(crate) async fn read_lines(
    reader: impl AsyncRead + Unpin,
    mut on_line: impl FnMut(String),
) -> std::io::Result<()> {
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::with_capacity(8 * 1024);
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => return Ok(()),
            Ok(_) => {
                while buf.last().is_some_and(|b| *b == b'\n' || *b == b'\r') {
                    buf.pop();
                }
                on_line(String::from_utf8_lossy(&buf).into_owned());
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
}

impl Peer {
    pub fn spawn(
        opts: SpawnOptions<'_>,
    ) -> anyhow::Result<(Arc<Peer>, mpsc::UnboundedReceiver<Incoming>)> {
        let mut cmd = Command::new(opts.program);
        cmd.args(opts.args)
            .current_dir(opts.cwd)
            .envs(opts.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Own process group: npm launchers (codex.js, grok bootstrap) spawn the real
        // agent as a child, and stopping must take the whole tree down.
        #[cfg(unix)]
        cmd.process_group(0);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .with_context(|| format!("starting {}", opts.program.display()))?;
        let pid = child.id();

        let stdin = child.stdin.take().context("child stdin")?;
        let stdout = child.stdout.take().context("child stdout")?;
        let stderr = child.stderr.take().context("child stderr")?;

        let stderr_tail: Arc<Mutex<VecDeque<String>>> = Arc::default();
        let (tx, rx) = mpsc::unbounded_channel();
        let closer = Arc::new(Closer {
            closed: AtomicBool::new(false),
            pending: Mutex::default(),
            tx: tx.clone(),
        });

        let label = opts.label.to_string();
        {
            let closer = closer.clone();
            let label = label.clone();
            tokio::spawn(async move {
                let result = read_lines(stdout, |line| {
                    if line.trim().is_empty() {
                        return;
                    }
                    match serde_json::from_str::<Value>(&line) {
                        Ok(msg) => route(msg, &closer.pending, &tx),
                        Err(_) => {
                            tracing::debug!(target: "armada::rpc", "[{label}] non-JSON stdout: {line}")
                        }
                    }
                })
                .await;
                if let Err(e) = result {
                    tracing::warn!(target: "armada::rpc", "[{label}] stdout read error: {e}");
                }
                closer.close();
            });
        }
        {
            let tail = stderr_tail.clone();
            tokio::spawn(async move {
                let _ = read_lines(stderr, |line| {
                    tracing::debug!(target: "armada::agent_stderr", "[{label}] {line}");
                    let mut t = tail.lock();
                    t.push_back(line);
                    if t.len() > 40 {
                        t.pop_front();
                    }
                })
                .await;
            });
        }

        Ok((
            Arc::new(Peer {
                stdin: tokio::sync::Mutex::new(Some(stdin)),
                next_id: AtomicI64::new(1),
                closer,
                stderr_tail,
                child: Mutex::new(Some(child)),
                pid,
            }),
            rx,
        ))
    }

    async fn write(&self, msg: &Value) -> anyhow::Result<()> {
        let mut line = serde_json::to_vec(msg)?;
        line.push(b'\n');
        let mut guard = self.stdin.lock().await;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| anyhow!("the agent process has been stopped"))?;
        stdin.write_all(&line).await.context("writing to agent")?;
        stdin.flush().await?;
        Ok(())
    }

    pub async fn request(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        self.request_timeout(method, params, None).await
    }

    pub async fn request_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> anyhow::Result<Value> {
        let id = json!(self.next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.closer.pending.lock().insert(id_key(&id), tx);
        // The reader may have drained `pending` just before we inserted.
        if self.is_closed() {
            self.closer.pending.lock().remove(&id_key(&id));
            return Err(anyhow!("{method}: the agent process exited"));
        }
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(e) = self.write(&msg).await {
            self.closer.pending.lock().remove(&id_key(&id));
            return Err(e);
        }
        let result = match timeout {
            Some(t) => match tokio::time::timeout(t, rx).await {
                Ok(r) => r,
                Err(_) => {
                    self.closer.pending.lock().remove(&id_key(&id));
                    return Err(anyhow!("{method} timed out"));
                }
            },
            None => rx.await,
        };
        match result {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(anyhow::Error::new(e).context(format!("{method} failed"))),
            Err(_) => Err(anyhow!("{method}: connection closed")),
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> anyhow::Result<()> {
        self.write(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
            .await
    }

    pub async fn respond(&self, id: Value, result: Value) -> anyhow::Result<()> {
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))
            .await
    }

    pub async fn respond_error(&self, id: Value, code: i64, message: &str) -> anyhow::Result<()> {
        self.write(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message }
        }))
        .await
    }

    /// Queues a marker behind every message already read from the agent.
    pub fn barrier(&self, n: u64) {
        let _ = self.closer.tx.send(Incoming::Barrier(n));
    }

    pub fn is_closed(&self) -> bool {
        self.closer.closed.load(Ordering::SeqCst)
    }

    /// Last lines the agent wrote to stderr, for error messages.
    pub fn stderr_tail(&self, lines: usize) -> String {
        let t = self.stderr_tail.lock();
        let skip = t.len().saturating_sub(lines);
        t.iter().skip(skip).cloned().collect::<Vec<_>>().join("\n")
    }

    /// Stops the agent and everything it started, then reports the connection closed
    /// (even if an orphaned grandchild still holds the pipe open).
    pub async fn kill(&self) {
        // Well-behaved agents exit on stdin EOF.
        self.stdin.lock().await.take();
        let child = self.child.lock().take();
        if let Some(mut child) = child {
            #[cfg(windows)]
            if let Some(pid) = self.pid {
                kill_tree_windows(pid).await;
            }
            #[cfg(unix)]
            signal_group(self.pid, libc::SIGTERM);
            if tokio::time::timeout(Duration::from_secs(2), child.wait())
                .await
                .is_err()
            {
                #[cfg(unix)]
                signal_group(self.pid, libc::SIGKILL);
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            }
            // The leader is gone; make sure nothing it started outlives it.
            #[cfg(unix)]
            signal_group(self.pid, libc::SIGKILL);
        }
        self.closer.close();
    }
}

#[cfg(unix)]
fn signal_group(pid: Option<u32>, signal: libc::c_int) {
    if let Some(pid) = pid.and_then(|p| i32::try_from(p).ok()).filter(|p| *p > 0) {
        // SAFETY: plain syscall; a negative pid addresses the process group we
        // created for this agent. ESRCH (already gone) is fine.
        unsafe {
            libc::kill(-pid, signal);
        }
    }
}

#[cfg(windows)]
async fn kill_tree_windows(pid: u32) {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000);
    let _ = tokio::time::timeout(Duration::from_secs(5), cmd.status()).await;
}

/// Finds an RPC error code anywhere in an anyhow chain.
pub fn error_code(err: &anyhow::Error) -> Option<i64> {
    err.chain()
        .find_map(|e| e.downcast_ref::<RpcError>())
        .map(|e| e.code)
}

fn route(msg: Value, pending: &Mutex<Pending>, tx: &mpsc::UnboundedSender<Incoming>) {
    let method = msg
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_string);
    let id = msg.get("id").cloned().filter(|v| !v.is_null());
    match (method, id) {
        (Some(method), Some(id)) => {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let _ = tx.send(Incoming::Request { id, method, params });
        }
        (Some(method), None) => {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let _ = tx.send(Incoming::Notification { method, params });
        }
        (None, Some(id)) => {
            let Some(waiter) = pending.lock().remove(&id_key(&id)) else {
                return;
            };
            let outcome = match msg.get("error") {
                Some(err) if !err.is_null() => Err(RpcError {
                    code: err["code"].as_i64().unwrap_or(-32000),
                    message: err["message"].as_str().unwrap_or("error").to_string(),
                    data: err.get("data").cloned().unwrap_or(Value::Null),
                }),
                _ => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = waiter.send(outcome);
        }
        (None, None) => {}
    }
}
