//! Newline-delimited JSON-RPC 2.0 over a child process's stdio. Both ACP and the
//! Codex app-server speak this; requests flow in both directions.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, watch};

/// Longest stdout line (one JSON message) we accept; images inline can be big.
const MAX_STDOUT_LINE: usize = 32 * 1024 * 1024;
/// Stderr lines are only kept for error messages and logs.
const MAX_STDERR_LINE: usize = 4 * 1024;
const STDERR_TAIL_LINES: usize = 40;

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

/// Code used for "the agent process went away" (our own, not the agent's).
pub const CODE_EXITED: i64 = -32099;

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
                code: CODE_EXITED,
                message: "agent process exited".into(),
                data: Value::Null,
            }));
        }
        let _ = self.tx.send(Incoming::Closed);
    }
}

/// The agent's recent stderr, numbered so errors only quote what is new.
#[derive(Default)]
struct StderrTail {
    lines: VecDeque<(u64, String)>,
    count: u64,
}

pub struct Peer {
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    next_id: AtomicI64,
    closer: Arc<Closer>,
    stderr: Arc<Mutex<StderrTail>>,
    /// Stderr position when the current turn started (see `mark_turn`).
    turn_mark: AtomicU64,
    child: Mutex<Option<Child>>,
    pid: Option<u32>,
    /// Set once the process has been killed and reaped; later `kill` callers wait on it.
    killed: watch::Sender<bool>,
}

fn id_key(id: &Value) -> String {
    id.to_string()
}

pub struct SpawnOptions<'a> {
    pub program: &'a Path,
    pub args: &'a [String],
    pub cwd: &'a Path,
    pub env: &'a [(String, String)],
    /// Inherited variables to drop before `env` is applied (e.g. credentials that
    /// would override the account's own).
    pub env_remove: &'a [String],
    pub label: &'a str,
    /// Where to record the child's process group for crash recovery
    /// (`<data>/children.json`); None for short-lived helpers.
    pub children_file: Option<&'a Path>,
}

/// Reads `\n`-terminated lines as UTF-8 (lossy for bad bytes, so one bad byte
/// can't end the stream). Lines longer than `max_len` bytes are cut there; the
/// rest of such a line is skipped.
pub(crate) async fn read_lines(
    reader: impl AsyncRead + Unpin,
    max_len: usize,
    mut on_line: impl FnMut(String),
) -> std::io::Result<()> {
    let mut reader = BufReader::with_capacity(64 * 1024, reader);
    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
    let mut overflow = false;
    let mut deliver = |buf: &mut Vec<u8>, overflow: &mut bool| {
        while buf.last().is_some_and(|b| *b == b'\n' || *b == b'\r') {
            buf.pop();
        }
        if *overflow {
            tracing::debug!(target: "armada::rpc", "line longer than {max_len} bytes was cut");
        }
        *overflow = false;
        let bytes = std::mem::take(buf);
        let line = String::from_utf8(bytes)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
        on_line(line);
    };
    loop {
        let available = match reader.fill_buf().await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if available.is_empty() {
            if !buf.is_empty() || overflow {
                deliver(&mut buf, &mut overflow);
            }
            return Ok(());
        }
        let (chunk, found) = match available.iter().position(|b| *b == b'\n') {
            Some(i) => (&available[..=i], true),
            None => (available, false),
        };
        let used = chunk.len();
        let room = max_len.saturating_sub(buf.len());
        if chunk.len() > room {
            buf.extend_from_slice(&chunk[..room]);
            overflow = true;
        } else {
            buf.extend_from_slice(chunk);
        }
        reader.consume(used);
        if found {
            deliver(&mut buf, &mut overflow);
        }
    }
}

/// True if an error text looks like "you need to sign in" (whole words only, so
/// "author" or "authority" don't count).
pub fn looks_like_auth_error(text: &str) -> bool {
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    const WORDS: [&str; 7] = [
        "auth",
        "authentication",
        "unauthenticated",
        "unauthorized",
        "login",
        "401",
        "reauthenticate",
    ];
    if words.iter().any(|w| WORDS.contains(w)) {
        return true;
    }
    let joined = format!(" {} ", words.join(" "));
    [
        "log in",
        "sign in",
        "not logged in",
        "invalid api key",
        "invalid x api key",
    ]
    .iter()
    .any(|p| joined.contains(&format!(" {p} ")))
}

impl Peer {
    pub fn spawn(
        opts: SpawnOptions<'_>,
    ) -> anyhow::Result<(Arc<Peer>, mpsc::UnboundedReceiver<Incoming>)> {
        let mut cmd = Command::new(opts.program);
        cmd.args(opts.args).current_dir(opts.cwd);
        crate::childenv::sanitize_child_env(&mut cmd);
        for var in opts.env_remove {
            cmd.env_remove(var);
        }
        cmd.envs(opts.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
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
        #[cfg(windows)]
        job::assign(&child);
        if let Some(pid) = pid {
            registry::register(pid, opts.program, opts.children_file);
        }

        let stdin = child.stdin.take().context("child stdin")?;
        let stdout = child.stdout.take().context("child stdout")?;
        let stderr = child.stderr.take().context("child stderr")?;

        let stderr_tail: Arc<Mutex<StderrTail>> = Arc::default();
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
                let result = read_lines(stdout, MAX_STDOUT_LINE, |line| {
                    if line.trim().is_empty() {
                        return;
                    }
                    match serde_json::from_str::<Value>(&line) {
                        Ok(msg) => route(msg, &closer.pending, &tx),
                        Err(_) => {
                            let shown: String = line.chars().take(400).collect();
                            tracing::debug!(target: "armada::rpc", "[{label}] non-JSON stdout: {shown}")
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
                let _ = read_lines(stderr, MAX_STDERR_LINE, |line| {
                    tracing::debug!(target: "armada::agent_stderr", "[{label}] {line}");
                    let mut t = tail.lock();
                    t.count += 1;
                    let n = t.count;
                    t.lines.push_back((n, line));
                    if t.lines.len() > STDERR_TAIL_LINES {
                        t.lines.pop_front();
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
                stderr: stderr_tail,
                turn_mark: AtomicU64::new(0),
                child: Mutex::new(Some(child)),
                pid,
                killed: watch::Sender::new(false),
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
        self.stderr_since(0, lines)
    }

    /// How many stderr lines the agent has written so far (a position for
    /// `stderr_since`).
    pub fn stderr_mark(&self) -> u64 {
        self.stderr.lock().count
    }

    /// Up to the last `lines` stderr lines written after `mark`.
    pub fn stderr_since(&self, mark: u64, lines: usize) -> String {
        let t = self.stderr.lock();
        let fresh: Vec<&str> = t
            .lines
            .iter()
            .filter(|(n, _)| *n > mark)
            .map(|(_, l)| l.as_str())
            .collect();
        let skip = fresh.len().saturating_sub(lines);
        fresh[skip..].join("\n")
    }

    /// Remembers where stderr is now, as the start of the current turn.
    pub fn mark_turn(&self) {
        self.turn_mark.store(self.stderr_mark(), Ordering::SeqCst);
    }

    /// Stderr written since the current turn started (see `mark_turn`).
    pub fn turn_stderr(&self, lines: usize) -> String {
        self.stderr_since(self.turn_mark.load(Ordering::SeqCst), lines)
    }

    /// Adds the stderr written since `mark` to an error, unless the agent itself
    /// answered with an RPC error (its message already says what happened).
    pub fn with_stderr(&self, e: anyhow::Error, mark: u64) -> anyhow::Error {
        let tail = self.stderr_since(mark, 6);
        if tail.trim().is_empty() || error_code(&e).is_some_and(|c| c != CODE_EXITED) {
            e
        } else {
            e.context(format!("agent output:\n{tail}"))
        }
    }

    /// Stops the agent and everything it started, then reports the connection closed
    /// (even if an orphaned grandchild still holds the pipe open). A second caller
    /// returns only once the first has finished.
    pub async fn kill(&self) {
        // Well-behaved agents exit on stdin EOF. Never wait for the stdin lock: a
        // write blocked on an agent that stopped reading would hang Stop forever
        // (the signals below make that write fail instead).
        if let Ok(mut stdin) = self.stdin.try_lock() {
            stdin.take();
        }
        let child = self.child.lock().take();
        match child {
            Some(mut child) => {
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
                if let Some(pid) = self.pid {
                    registry::unregister(pid);
                }
                self.killed.send_replace(true);
            }
            None => {
                let mut rx = self.killed.subscribe();
                let _ = rx.wait_for(|done| *done).await;
            }
        }
        self.closer.close();
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        // Dropped without `kill` (e.g. a cancelled task): `kill_on_drop` ends the
        // leader; take the rest of its group with it.
        if self.child.get_mut().take().is_some() {
            #[cfg(unix)]
            signal_group(self.pid, libc::SIGKILL);
            #[cfg(windows)]
            if let Some(pid) = self.pid {
                kill_tree_windows_blocking(pid);
            }
            if let Some(pid) = self.pid {
                registry::unregister(pid);
            }
            self.killed.send_replace(true);
        }
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

#[cfg(windows)]
fn kill_tree_windows_blocking(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000)
        .status();
}

/// Kills every agent process tree this process started that is still alive.
/// A last resort for the shell to call right before the process exits.
pub fn kill_all_children() {
    for pid in registry::take_all() {
        #[cfg(unix)]
        signal_group(Some(pid), libc::SIGKILL);
        #[cfg(windows)]
        kill_tree_windows_blocking(pid);
        #[cfg(not(any(unix, windows)))]
        let _ = pid;
    }
}

/// Live agent processes (pid = process group id on Unix), mirrored to each
/// core's `children.json` so a crashed run's leftovers can be reaped next start.
mod registry {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize, Clone)]
    pub(super) struct Record {
        pub pid: u32,
        pub program: String,
        /// Process start time (Linux: clock ticks since boot), to tell a reused pid apart.
        pub start_time: Option<u64>,
        #[serde(skip)]
        pub file: Option<PathBuf>,
    }

    static LIVE: std::sync::Mutex<Vec<Record>> = std::sync::Mutex::new(Vec::new());

    fn live() -> std::sync::MutexGuard<'static, Vec<Record>> {
        LIVE.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn persist(list: &[Record], file: &Path) {
        let mine: Vec<&Record> = list
            .iter()
            .filter(|r| r.file.as_deref() == Some(file))
            .collect();
        if let Ok(json) = serde_json::to_vec(&mine) {
            let _ = std::fs::write(file, json);
        }
    }

    pub(super) fn register(pid: u32, program: &Path, file: Option<&Path>) {
        let mut list = live();
        list.retain(|r| r.pid != pid);
        list.push(Record {
            pid,
            program: program.to_string_lossy().into_owned(),
            start_time: proc_info(pid).map(|i| i.start_time),
            file: file.map(Path::to_path_buf),
        });
        if let Some(f) = file {
            persist(&list, f);
        }
    }

    pub(super) fn unregister(pid: u32) {
        let mut list = live();
        let Some(pos) = list.iter().position(|r| r.pid == pid) else {
            return;
        };
        let rec = list.remove(pos);
        if let Some(f) = rec.file {
            persist(&list, &f);
        }
    }

    pub(super) fn take_all() -> Vec<u32> {
        let mut list = live();
        let mut files: Vec<PathBuf> = list.iter().filter_map(|r| r.file.clone()).collect();
        files.dedup();
        let pids = list.drain(..).map(|r| r.pid).collect();
        for f in files {
            persist(&list, &f);
        }
        pids
    }

    pub(super) struct ProcInfo {
        pub pgrp: u32,
        pub start_time: u64,
    }

    /// Process group and start time from /proc (Linux only).
    pub(super) fn proc_info(pid: u32) -> Option<ProcInfo> {
        if !cfg!(target_os = "linux") {
            return None;
        }
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // Fields after the parenthesized command name, which may contain spaces.
        let rest = &stat[stat.rfind(')')? + 1..];
        let fields: Vec<&str> = rest.split_whitespace().collect();
        Some(ProcInfo {
            pgrp: fields.get(2)?.parse().ok()?,
            start_time: fields.get(19)?.parse().ok()?,
        })
    }
}

/// Kills agent process groups a previous (crashed) run left behind, as recorded
/// in `file`. Conservative: only a group whose leader is still alive, is still
/// the same process (start time), still leads its group and still runs the
/// recorded program is killed. Linux only; elsewhere the record is just cleared.
/// Returns how many groups were killed.
pub(crate) fn reap_orphans(file: &Path) -> usize {
    let Ok(data) = std::fs::read(file) else {
        return 0;
    };
    let _ = std::fs::remove_file(file);
    let records: Vec<registry::Record> = serde_json::from_slice(&data).unwrap_or_default();
    let mut killed = 0;
    for rec in records {
        if orphan_matches(&rec) {
            #[cfg(unix)]
            signal_group(Some(rec.pid), libc::SIGKILL);
            killed += 1;
        }
    }
    killed
}

fn orphan_matches(rec: &registry::Record) -> bool {
    let (Some(expected), Some(info)) = (rec.start_time, registry::proc_info(rec.pid)) else {
        return false;
    };
    if info.start_time != expected || info.pgrp != rec.pid || rec.program.is_empty() {
        return false;
    }
    let Ok(cmdline) = std::fs::read(format!("/proc/{}/cmdline", rec.pid)) else {
        return false;
    };
    let cmdline = String::from_utf8_lossy(&cmdline);
    let name = Path::new(&rec.program)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    cmdline.contains(&rec.program) || (!name.is_empty() && cmdline.contains(&name))
}

/// Windows: every agent process joins one job that kills its members when Armada
/// exits (the job handle closes with the process), so nothing outlives a crash.
#[cfg(windows)]
mod job {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// The job handle as an integer (raw handles aren't Send/Sync); 0 = unavailable.
    static JOB: OnceLock<usize> = OnceLock::new();

    fn job() -> usize {
        *JOB.get_or_init(|| {
            // SAFETY: plain Win32 calls; the handle is intentionally never closed
            // (it closes when Armada exits, which is what kills the children).
            unsafe {
                let handle: HANDLE = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return 0;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION
                        as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    return 0;
                }
                handle as usize
            }
        })
    }

    pub(super) fn assign(child: &tokio::process::Child) {
        let job = job();
        let Some(process) = child.raw_handle() else {
            return;
        };
        if job == 0 {
            return;
        }
        // SAFETY: both handles are valid for the duration of the call.
        unsafe {
            AssignProcessToJobObject(job as HANDLE, process as HANDLE);
        }
    }
}

/// Finds an RPC error code anywhere in an anyhow chain.
pub fn error_code(err: &anyhow::Error) -> Option<i64> {
    err.chain()
        .find_map(|e| e.downcast_ref::<RpcError>())
        .map(|e| e.code)
}

fn route(mut msg: Value, pending: &Mutex<Pending>, tx: &mpsc::UnboundedSender<Incoming>) {
    let Some(obj) = msg.as_object_mut() else {
        return;
    };
    let method = match obj.remove("method") {
        Some(Value::String(m)) => Some(m),
        _ => None,
    };
    let id = obj.remove("id").filter(|v| !v.is_null());
    match (method, id) {
        (Some(method), Some(id)) => {
            let params = obj.remove("params").unwrap_or(Value::Null);
            let _ = tx.send(Incoming::Request { id, method, params });
        }
        (Some(method), None) => {
            let params = obj.remove("params").unwrap_or(Value::Null);
            let _ = tx.send(Incoming::Notification { method, params });
        }
        (None, Some(id)) => {
            let Some(waiter) = pending.lock().remove(&id_key(&id)) else {
                return;
            };
            let outcome = match obj.remove("error") {
                Some(mut err) if !err.is_null() => Err(RpcError {
                    code: err["code"].as_i64().unwrap_or(-32000),
                    message: err["message"].as_str().unwrap_or("error").to_string(),
                    data: err.get_mut("data").map(Value::take).unwrap_or(Value::Null),
                }),
                _ => Ok(obj.remove("result").unwrap_or(Value::Null)),
            };
            let _ = waiter.send(outcome);
        }
        (None, None) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn long_lines_are_cut_and_bad_bytes_survive() {
        let mut input = b"short\n".to_vec();
        input.extend(std::iter::repeat_n(b'x', 100));
        input.extend(b"\n\xff ok\r\nlast");
        let mut lines = Vec::new();
        read_lines(&input[..], 10, |l| lines.push(l)).await.unwrap();
        assert_eq!(lines, ["short", "xxxxxxxxxx", "\u{fffd} ok", "last"]);
    }

    #[test]
    fn auth_errors_need_whole_words() {
        assert!(looks_like_auth_error("Authentication required"));
        assert!(looks_like_auth_error("HTTP 401 Unauthorized"));
        assert!(looks_like_auth_error("Please log in again"));
        assert!(looks_like_auth_error("auth_required"));
        assert!(!looks_like_auth_error("the author of the file"));
        assert!(!looks_like_auth_error("authority record not found"));
        assert!(!looks_like_auth_error("line 4012 is wrong"));
        assert!(!looks_like_auth_error("blogin.rs failed"));
    }

    #[test]
    fn route_moves_params_out_of_the_message() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let pending = Mutex::new(Pending::new());
        route(
            json!({"jsonrpc":"2.0","method":"m","params":{"a":1}}),
            &pending,
            &tx,
        );
        match rx.try_recv().unwrap() {
            Incoming::Notification { method, params } => {
                assert_eq!(method, "m");
                assert_eq!(params["a"], 1);
            }
            other => panic!("{other:?}"),
        }
    }
}
