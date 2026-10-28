//! PTY terminals for provider login flows and installs. Output is streamed to the
//! UI as `ArmadaEvent::TerminalOutput`, exit as `ArmadaEvent::TerminalExit`.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context};
use armada_core::{ArmadaEvent, Core};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tracing::{debug, warn};

pub const DEFAULT_COLS: u16 = 100;
pub const DEFAULT_ROWS: u16 = 30;

/// How long each polite signal gets before the next, harsher one.
const KILL_GRACE: Duration = Duration::from_millis(1500);
/// At app exit everything gets one short grace period, then is killed.
const EXIT_GRACE: Duration = Duration::from_millis(800);
/// Output arriving within this window is sent as one event (~60 events a second).
const BATCH_WINDOW: Duration = Duration::from_millis(16);
/// Largest `TerminalOutput` event (a flood is split into several).
const MAX_EVENT_BYTES: usize = 64 * 1024;
/// How long the reader waits for output before checking whether to stop.
const IDLE_POLL: Duration = Duration::from_millis(250);
/// Largest single `terminal_write` (a paste); bigger input is refused.
pub const MAX_INPUT_BYTES: usize = 64 * 1024;
/// Writes queued for a terminal that isn't reading its input.
const INPUT_QUEUE: usize = 256;

struct Term {
    master: Box<dyn MasterPty + Send>,
    /// Input for the terminal's writer thread. A PTY write blocks while the child isn't
    /// reading its input, so writes never happen under the map lock or on an async
    /// worker; the channel also keeps keystrokes in order. Bounded, so a process that
    /// never reads can't make us buffer without limit.
    input: mpsc::SyncSender<Vec<u8>>,
    proc: Arc<Proc>,
}

/// The terminal's process, for signalling it (and on Unix its whole process group:
/// the PTY child is a session leader, so its pid is the group id).
struct Proc {
    pid: Option<u32>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// Set by the waiter once the child has been reaped; no signals after that.
    exited: AtomicBool,
}

impl Proc {
    fn exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }

    /// Waits up to `limit` for the process to exit.
    fn wait_exit(&self, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while !self.exited() {
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        true
    }

    /// Unix: SIGHUP (what closing a terminal sends), then SIGTERM, then SIGKILL, each
    /// to the whole process group. Windows: `taskkill /T /F` ends the process tree,
    /// with TerminateProcess as the fallback. Blocks until the process is gone or
    /// every step has been tried.
    fn terminate(&self, grace: Duration) {
        #[cfg(unix)]
        {
            for signal in [libc::SIGHUP, libc::SIGTERM] {
                if self.exited() {
                    return;
                }
                self.signal(signal);
                if self.wait_exit(grace) {
                    return;
                }
            }
            if !self.exited() {
                self.signal(libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        {
            if self.exited() {
                return;
            }
            if let Some(pid) = self.pid {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &pid.to_string()])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .creation_flags(0x0800_0000)
                    .status();
            }
            if !self.wait_exit(grace) {
                let _ = self.killer.lock().kill();
            }
        }
    }

    /// Signals the process group and the process itself.
    #[cfg(unix)]
    fn signal(&self, signal: libc::c_int) {
        let Some(pid) = self.pid.and_then(|p| libc::pid_t::try_from(p).ok()) else {
            let _ = self.killer.lock().kill();
            return;
        };
        // SAFETY: plain kill(2) calls; no memory is involved.
        unsafe {
            libc::kill(-pid, signal);
            libc::kill(pid, signal);
        }
    }

    /// After the child has exited: signals what it left behind in its process group.
    /// The group id stays reserved while the group exists, so this can't hit an
    /// unrelated process.
    #[cfg(unix)]
    fn signal_leftover_group(&self, signal: libc::c_int) {
        if let Some(pid) = self.pid.and_then(|p| libc::pid_t::try_from(p).ok()) {
            // SAFETY: plain kill(2) call.
            unsafe {
                libc::kill(-pid, signal);
            }
        }
    }

    /// Whether anything is still running in the exited child's process group.
    #[cfg(unix)]
    fn leftover_group_alive(&self) -> bool {
        self.pid
            .and_then(|p| libc::pid_t::try_from(p).ok())
            // SAFETY: signal 0 only checks for existence.
            .is_some_and(|pid| unsafe { libc::kill(-pid, 0) } == 0)
    }
}

/// Runs an `on_exit` hook exactly once, whichever path (job finished, job killed)
/// gets there first.
type ExitHook = Arc<Mutex<Option<Box<dyn FnOnce(Option<i32>) + Send>>>>;

fn fire(hook: &ExitHook, code: Option<i32>) {
    let hook = hook.lock().take();
    if let Some(hook) = hook {
        hook(code);
    }
}

struct Task {
    abort: tokio::task::AbortHandle,
    on_exit: ExitHook,
}

#[derive(Clone, Default)]
pub struct Terminals {
    inner: Arc<Mutex<HashMap<String, Term>>>,
    /// `spawn_unique` keys (e.g. one login per account) → terminal id.
    keys: Arc<Mutex<HashMap<String, String>>>,
    /// In-process jobs (e.g. the toolchain installer) shown in the same terminal UI.
    tasks: Arc<Mutex<HashMap<String, Task>>>,
}

/// Colors a log line for xterm: ✓ green, ✗ red, ! amber, ▸ cyan.
fn colorize(line: &str) -> String {
    let color = match line.chars().next() {
        Some('✓') => "32",
        Some('✗') => "31",
        Some('!') => "33",
        Some('▸') => "36",
        _ => return format!("{line}\r\n"),
    };
    format!("\x1b[{color}m{line}\x1b[0m\r\n")
}

pub struct SpawnSpec {
    pub program: OsString,
    pub args: Vec<OsString>,
    /// Variables removed from the inherited environment before `env` is applied
    /// (e.g. the user's exported provider API keys, for per-account isolation).
    pub env_remove: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: Option<PathBuf>,
}

/// What the reader thread reads from: on Unix a dup of the PTY master that it polls;
/// elsewhere a helper thread doing blocking reads, handed over through a channel.
/// Either way reads can time out, so output can be batched and the reader can stop
/// even if something still holds the terminal open.
struct PtyReader {
    #[cfg(unix)]
    file: std::fs::File,
    #[cfg(not(unix))]
    chunks: mpsc::Receiver<Vec<u8>>,
}

enum ReadOutcome {
    Data,
    Timeout,
    Eof,
}

impl PtyReader {
    fn new(master: &dyn MasterPty) -> anyhow::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::fd::FromRawFd;
            let fd = master
                .as_raw_fd()
                .ok_or_else(|| anyhow!("the pseudo-terminal has no file descriptor"))?;
            // SAFETY: `fd` is the open master; dup gives us our own descriptor, which
            // the File then owns (and closes).
            let dup = unsafe { libc::dup(fd) };
            if dup < 0 {
                return Err(std::io::Error::last_os_error()).context("duplicating the PTY");
            }
            Ok(PtyReader {
                file: unsafe { std::fs::File::from_raw_fd(dup) },
            })
        }
        #[cfg(not(unix))]
        {
            let mut inner = master.try_clone_reader()?;
            let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(64);
            std::thread::Builder::new()
                .name("armada-pty-pipe".into())
                .spawn(move || {
                    let mut buf = [0u8; 8192];
                    loop {
                        match inner.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                if tx.send(buf[..n].to_vec()).is_err() {
                                    break;
                                }
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                            Err(_) => break,
                        }
                    }
                })
                .context("starting the terminal pipe thread")?;
            Ok(PtyReader { chunks: rx })
        }
    }

    /// Appends what's available to `out`, waiting at most `timeout` for something.
    fn read(&mut self, out: &mut Vec<u8>, timeout: Duration) -> std::io::Result<ReadOutcome> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let mut pfd = libc::pollfd {
                fd: self.file.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let millis = libc::c_int::try_from(timeout.as_millis()).unwrap_or(libc::c_int::MAX);
            // SAFETY: one valid pollfd for the duration of the call.
            let ready = unsafe { libc::poll(&mut pfd, 1, millis) };
            if ready < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if ready == 0 {
                return Ok(ReadOutcome::Timeout);
            }
            let mut buf = [0u8; 8192];
            match self.file.read(&mut buf)? {
                0 => Ok(ReadOutcome::Eof),
                n => {
                    out.extend_from_slice(&buf[..n]);
                    Ok(ReadOutcome::Data)
                }
            }
        }
        #[cfg(not(unix))]
        {
            match self.chunks.recv_timeout(timeout) {
                Ok(chunk) => {
                    out.extend_from_slice(&chunk);
                    Ok(ReadOutcome::Data)
                }
                Err(mpsc::RecvTimeoutError::Timeout) => Ok(ReadOutcome::Timeout),
                Err(mpsc::RecvTimeoutError::Disconnected) => Ok(ReadOutcome::Eof),
            }
        }
    }
}

/// Decodes `pending` (keeping an incomplete UTF-8 tail) and emits it as
/// `TerminalOutput` events of at most [`MAX_EVENT_BYTES`] each.
fn flush_output(core: &Core, id: &str, pending: &mut Vec<u8>) {
    let data = decode_utf8_chunk(pending);
    for chunk in split_at_char_boundaries(&data, MAX_EVENT_BYTES) {
        core.emit(ArmadaEvent::TerminalOutput {
            terminal_id: id.to_string(),
            data: chunk.to_string(),
        });
    }
}

/// `s` in pieces of at most `max` bytes (more for a single char wider than `max`),
/// never splitting a character.
fn split_at_char_boundaries(s: &str, max: usize) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut rest = s;
    while !rest.is_empty() {
        let mut end = rest.len().min(max);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        if end == 0 {
            // One character wider than `max`: it goes out whole.
            end = rest.chars().next().map_or(rest.len(), char::len_utf8);
        }
        let (piece, tail) = rest.split_at(end);
        pieces.push(piece);
        rest = tail;
    }
    pieces
}

impl Terminals {
    /// Spawns `spec` in a new PTY and returns its terminal id. `on_exit` runs on a
    /// background thread after `TerminalExit` has been emitted.
    pub fn spawn(
        &self,
        core: Core,
        spec: SpawnSpec,
        on_exit: impl FnOnce(Option<i32>) + Send + 'static,
    ) -> anyhow::Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: DEFAULT_ROWS,
                cols: DEFAULT_COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("opening a pseudo-terminal")?;

        let mut cmd = command_for(&spec)?;
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for k in &spec.env_remove {
            cmd.env_remove(k);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let cwd = spec.cwd.clone().or_else(armada_core::providers::home_dir);
        if let Some(cwd) = cwd.filter(|p| p.is_dir()) {
            cmd.cwd(cwd);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("starting {}", spec.program.to_string_lossy()))?;
        // Drop our copy of the slave so reads hit EOF once the child exits.
        drop(pair.slave);
        let proc = Arc::new(Proc {
            pid: child.process_id(),
            killer: Mutex::new(child.clone_killer()),
            exited: AtomicBool::new(false),
        });

        // From here on, any failure must not leave the child running unsupervised.
        let (done_rx, stop) = match self.start_io(&core, &id, pair.master, proc.clone()) {
            Ok(io) => io,
            Err(e) => {
                abandon(child, &proc);
                return Err(e);
            }
        };

        // Waiter: exit status -> TerminalExit -> on_exit hook. The child is handed over
        // through a slot so it can still be reaped here if the thread can't start.
        let slot = Arc::new(Mutex::new(Some(child)));
        let terminals = self.clone();
        let waiter_id = id.clone();
        let waiter_proc = proc.clone();
        let waiter_stop = stop.clone();
        let waiter_slot = slot.clone();
        let spawned = std::thread::Builder::new()
            .name("armada-pty-wait".into())
            .spawn(move || {
                let Some(mut child) = waiter_slot.lock().take() else {
                    return;
                };
                let code = match child.wait() {
                    Ok(status) if status.signal().is_none() => {
                        Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX))
                    }
                    Ok(_) => None,
                    Err(e) => {
                        warn!("waiting for terminal process failed: {e}");
                        None
                    }
                };
                waiter_proc.exited.store(true, Ordering::SeqCst);
                finish_io(
                    &terminals,
                    &waiter_id,
                    &waiter_proc,
                    &waiter_stop,
                    &done_rx,
                    code,
                );
                debug!(terminal = %waiter_id, ?code, "terminal exited");
                core.emit(ArmadaEvent::TerminalExit {
                    terminal_id: waiter_id,
                    code,
                });
                on_exit(code);
            });
        if let Err(e) = spawned {
            stop.store(true, Ordering::SeqCst);
            self.inner.lock().remove(&id);
            if let Some(child) = slot.lock().take() {
                abandon(child, &proc);
            }
            return Err(e).context("starting the terminal waiter thread");
        }
        Ok(id)
    }

    /// Like [`spawn`](Self::spawn), but while a terminal started under `key` is still
    /// running, returns its id instead of starting another (e.g. one login per account).
    pub fn spawn_unique(
        &self,
        key: &str,
        core: Core,
        spec: SpawnSpec,
        on_exit: impl FnOnce(Option<i32>) + Send + 'static,
    ) -> anyhow::Result<(String, bool)> {
        // Held across the spawn so two calls can't both start one. Lock order: keys,
        // then inner (nothing takes them the other way round).
        let mut keys = self.keys.lock();
        {
            let live = self.inner.lock();
            keys.retain(|_, id| live.contains_key(id));
            if let Some(id) = keys.get(key) {
                return Ok((id.clone(), true));
            }
        }
        let id = self.spawn(core, spec, on_exit)?;
        keys.insert(key.to_string(), id.clone());
        Ok((id, false))
    }

    /// Starts the writer and reader threads and registers the terminal. Returns the
    /// reader's "done" receiver and its stop flag.
    fn start_io(
        &self,
        core: &Core,
        id: &str,
        master: Box<dyn MasterPty + Send>,
        proc: Arc<Proc>,
    ) -> anyhow::Result<(mpsc::Receiver<()>, Arc<AtomicBool>)> {
        let mut reader = PtyReader::new(master.as_ref())?;
        let mut writer = master.take_writer()?;

        // Writer: UI input -> PTY. Ends when the terminal is removed (sender dropped) or
        // the PTY stops accepting input.
        let (input_tx, input_rx) = mpsc::sync_channel::<Vec<u8>>(INPUT_QUEUE);
        std::thread::Builder::new()
            .name("armada-pty-write".into())
            .spawn(move || {
                for data in input_rx {
                    if let Err(e) = writer.write_all(&data).and_then(|()| writer.flush()) {
                        debug!("terminal input closed: {e}");
                        break;
                    }
                }
            })
            .context("starting the terminal input thread")?;

        // Reader: PTY bytes -> UTF-8 text events, batched: output arriving within
        // BATCH_WINDOW of the first byte goes out as one event (a chatty CLI otherwise
        // floods the window with tiny messages).
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let stop = Arc::new(AtomicBool::new(false));
        {
            let core = core.clone();
            let id = id.to_string();
            let stop = stop.clone();
            std::thread::Builder::new()
                .name("armada-pty-read".into())
                .spawn(move || {
                    // Give the UI a moment to learn the terminal id (returned by the
                    // command) before the first bytes arrive; the PTY buffers meanwhile.
                    std::thread::sleep(Duration::from_millis(150));
                    let mut pending = Vec::new();
                    let mut batch_since: Option<Instant> = None;
                    while !stop.load(Ordering::SeqCst) {
                        let wait = match batch_since {
                            Some(since) => BATCH_WINDOW.saturating_sub(since.elapsed()),
                            None => IDLE_POLL,
                        };
                        match reader.read(&mut pending, wait) {
                            Ok(ReadOutcome::Data) => {
                                let since = *batch_since.get_or_insert_with(Instant::now);
                                if pending.len() >= MAX_EVENT_BYTES
                                    || since.elapsed() >= BATCH_WINDOW
                                {
                                    flush_output(&core, &id, &mut pending);
                                    batch_since = None;
                                }
                            }
                            Ok(ReadOutcome::Timeout) => {
                                if batch_since.take().is_some() {
                                    flush_output(&core, &id, &mut pending);
                                }
                            }
                            Ok(ReadOutcome::Eof) => break,
                            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                            // EIO on Linux once the child side closes.
                            Err(_) => break,
                        }
                    }
                    flush_output(&core, &id, &mut pending);
                    if !pending.is_empty() {
                        // An incomplete UTF-8 sequence at the very end.
                        core.emit(ArmadaEvent::TerminalOutput {
                            terminal_id: id.clone(),
                            data: String::from_utf8_lossy(&pending).into_owned(),
                        });
                    }
                    let _ = done_tx.send(());
                })
                .context("starting the terminal output thread")?;
        }

        self.inner.lock().insert(
            id.to_string(),
            Term {
                master,
                input: input_tx,
                proc,
            },
        );
        Ok((done_rx, stop))
    }

    /// Runs an in-process job whose log lines stream to a terminal view, so the UI
    /// treats it exactly like a PTY (output, exit code, kill). `on_exit` runs once,
    /// also when the job is cancelled (with `None`).
    pub fn spawn_task<F>(
        &self,
        core: Core,
        job: impl FnOnce(armada_core::toolchain::Log) -> F,
        on_exit: impl FnOnce(Option<i32>) + Send + 'static,
    ) -> String
    where
        F: std::future::Future<Output = anyhow::Result<()>> + Send + 'static,
    {
        let id = uuid::Uuid::new_v4().to_string();
        let log: armada_core::toolchain::Log = {
            let core = core.clone();
            let id = id.clone();
            Arc::new(move |line: &str| {
                core.emit(ArmadaEvent::TerminalOutput {
                    terminal_id: id.clone(),
                    data: colorize(line),
                })
            })
        };
        let fut = job(log.clone());
        let on_exit: ExitHook = Arc::new(Mutex::new(Some(Box::new(on_exit))));
        let tasks = self.tasks.clone();
        let task_id = id.clone();
        let hook = on_exit.clone();
        // Hold the lock across spawn + insert so the task can't finish (and try to
        // remove itself) before it is registered.
        let mut map = self.tasks.lock();
        let handle = tokio::spawn(async move {
            // Same grace period as PTYs: let the UI learn the id first.
            tokio::time::sleep(Duration::from_millis(150)).await;
            let code = match fut.await {
                Ok(()) => 0,
                Err(e) => {
                    log(&format!("✗ {e:#}"));
                    1
                }
            };
            tasks.lock().remove(&task_id);
            core.emit(ArmadaEvent::TerminalExit {
                terminal_id: task_id,
                code: Some(code),
            });
            fire(&hook, Some(code));
        });
        map.insert(
            id.clone(),
            Task {
                abort: handle.abort_handle(),
                on_exit,
            },
        );
        id
    }

    fn kill_task(&self, core: &Core, id: &str) -> bool {
        let Some(task) = self.tasks.lock().remove(id) else {
            return false;
        };
        task.abort.abort();
        core.emit(ArmadaEvent::TerminalExit {
            terminal_id: id.to_string(),
            code: None,
        });
        // A cancelled install may still have changed things (e.g. installed Node).
        fire(&task.on_exit, None);
        true
    }

    pub fn write(&self, id: &str, data: &str) -> anyhow::Result<()> {
        if self.tasks.lock().contains_key(id) {
            return Ok(());
        }
        if data.len() > MAX_INPUT_BYTES {
            anyhow::bail!(
                "That's too much to type into the terminal at once (over {} KB)",
                MAX_INPUT_BYTES / 1024
            );
        }
        let map = self.inner.lock();
        let term = map.get(id).ok_or_else(|| anyhow!("terminal not found"))?;
        // Never blocks: the terminal's writer thread does the (possibly blocking) write.
        term.input
            .try_send(data.as_bytes().to_vec())
            .map_err(|e| match e {
                mpsc::TrySendError::Full(_) => {
                    anyhow!("the terminal isn't reading its input right now; try again")
                }
                mpsc::TrySendError::Disconnected(_) => {
                    anyhow!("the terminal no longer accepts input")
                }
            })
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        if self.tasks.lock().contains_key(id) {
            return Ok(());
        }
        let map = self.inner.lock();
        let term = map.get(id).ok_or_else(|| anyhow!("terminal not found"))?;
        term.master.resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// Ends the process, escalating if it doesn't exit (the waiter thread then emits
    /// `TerminalExit`), or aborts a job. Returns immediately.
    pub fn kill(&self, core: &Core, id: &str) -> anyhow::Result<()> {
        if self.kill_task(core, id) {
            return Ok(());
        }
        let proc = self
            .inner
            .lock()
            .get(id)
            .map(|t| t.proc.clone())
            .ok_or_else(|| anyhow!("terminal not found"))?;
        std::thread::Builder::new()
            .name("armada-pty-kill".into())
            .spawn(move || proc.terminate(KILL_GRACE))
            .context("starting the terminal kill thread")?;
        Ok(())
    }

    /// At exit: aborts jobs and ends every terminal process (one short grace period
    /// for all of them, then a hard kill). Blocks for at most about a second.
    pub fn kill_all(&self) {
        let tasks: Vec<Task> = self.tasks.lock().drain().map(|(_, t)| t).collect();
        for task in tasks {
            task.abort.abort();
        }
        let procs: Vec<Arc<Proc>> = self.inner.lock().values().map(|t| t.proc.clone()).collect();
        #[cfg(unix)]
        {
            for proc in &procs {
                if !proc.exited() {
                    proc.signal(libc::SIGHUP);
                }
            }
            let deadline = Instant::now() + EXIT_GRACE;
            for proc in &procs {
                proc.wait_exit(deadline.saturating_duration_since(Instant::now()));
            }
            for proc in &procs {
                if !proc.exited() {
                    proc.signal(libc::SIGKILL);
                }
            }
        }
        #[cfg(not(unix))]
        for proc in &procs {
            proc.terminate(EXIT_GRACE);
        }
    }
}

/// After the terminal's process exited: lets the reader flush trailing output, then
/// closes the terminal.
///
/// Unix: if something the process started still holds the terminal open after a
/// moment, a successful exit (code 0: e.g. a login CLI that opened the browser) leaves
/// it alone: closing our side of the terminal is enough for the reader to stop, and
/// killing the group could take the user's browser with it. After a failure the
/// leftovers are asked to hang up, then to terminate, and only then killed.
///
/// Windows: the ConPTY reader only sees EOF once the pseudo-console closes, so the
/// exit isn't held up waiting for it: a short drain, then the console is closed on a
/// separate thread (closing it can block until its host process ends).
fn finish_io(
    terminals: &Terminals,
    id: &str,
    proc: &Proc,
    stop: &AtomicBool,
    done_rx: &mpsc::Receiver<()>,
    code: Option<i32>,
) {
    #[cfg(unix)]
    {
        let closed = done_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        // macOS hangs up the terminal when its session leader exits, so the reader
        // can see EOF while leftovers that ignore SIGHUP still run: check the group
        // itself, not just whether the terminal closed.
        if code != Some(0) && (!closed || proc.leftover_group_alive()) {
            for signal in [libc::SIGHUP, libc::SIGTERM, libc::SIGKILL] {
                proc.signal_leftover_group(signal);
                let deadline = Instant::now() + Duration::from_millis(500);
                while proc.leftover_group_alive() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(25));
                }
                if !proc.leftover_group_alive() {
                    break;
                }
            }
        }
        stop.store(true, Ordering::SeqCst);
        terminals.inner.lock().remove(id);
        let _ = done_rx.recv_timeout(Duration::from_secs(1));
    }
    #[cfg(not(unix))]
    {
        let _ = (proc, code);
        let _ = done_rx.recv_timeout(Duration::from_millis(300));
        stop.store(true, Ordering::SeqCst);
        let term = terminals.inner.lock().remove(id);
        if let Some(term) = term {
            let _ = std::thread::Builder::new()
                .name("armada-pty-close".into())
                .spawn(move || drop(term));
        }
        let _ = done_rx.recv_timeout(Duration::from_millis(200));
    }
}

/// Setup failed after the child started: kill and reap it.
fn abandon(mut child: Box<dyn Child + Send + Sync>, proc: &Proc) {
    #[cfg(unix)]
    proc.signal(libc::SIGKILL);
    #[cfg(not(unix))]
    let _ = proc.killer.lock().kill();
    let _ = child.kill();
    let _ = child.wait();
    proc.exited.store(true, Ordering::SeqCst);
}

/// The command to run `spec` in a PTY.
fn command_for(spec: &SpawnSpec) -> anyhow::Result<CommandBuilder> {
    #[cfg(windows)]
    {
        let lower = spec.program.to_string_lossy().to_ascii_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            return windows_script_command(spec);
        }
    }
    let mut cmd = CommandBuilder::new(&spec.program);
    cmd.args(&spec.args);
    Ok(cmd)
}

/// npm installs CLIs on Windows as `.cmd` shims that run `node <script>`. cmd.exe
/// re-parses its command line (`&`, `^`, `(`… in a path would split or inject
/// commands), so shims are resolved to `node.exe <script> <args>` and run directly.
/// Other batch files only run through cmd.exe when nothing in the command line needs
/// quoting or escaping.
#[cfg(windows)]
fn windows_script_command(spec: &SpawnSpec) -> anyhow::Result<CommandBuilder> {
    let program = std::path::Path::new(&spec.program);
    if let Some(script) = std::fs::read_to_string(program)
        .ok()
        .and_then(|shim| npm_shim_script(&shim))
    {
        let dir = program.parent().unwrap_or(std::path::Path::new("."));
        let script = dir.join(script);
        // Native CLIs (Claude Code, Grok) ship an .exe the shim just forwards to.
        let is_exe = script
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("exe"));
        if is_exe && script.is_file() {
            let mut cmd = CommandBuilder::new(script);
            cmd.args(&spec.args);
            return Ok(cmd);
        }
        let local_node = dir.join("node.exe");
        let node = if local_node.is_file() {
            Some(local_node)
        } else {
            which::which("node").ok()
        };
        if let (Some(node), true) = (node, script.is_file()) {
            let mut cmd = CommandBuilder::new(node);
            cmd.arg(script);
            cmd.args(&spec.args);
            return Ok(cmd);
        }
    }
    let all_safe = std::iter::once(&spec.program)
        .chain(&spec.args)
        .all(|a| a.to_str().is_some_and(cmd_safe));
    if !all_safe {
        anyhow::bail!(
            "Can't run {} safely: its path contains characters cmd.exe would misinterpret",
            program.display()
        );
    }
    let mut cmd = CommandBuilder::new("cmd.exe");
    cmd.args(["/D", "/C"]);
    cmd.arg(&spec.program);
    cmd.args(&spec.args);
    Ok(cmd)
}

/// The script an npm `.cmd` shim runs, relative to the shim's folder, e.g.
/// `node_modules\@openai\codex\bin\codex.js` from
/// `"%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*`, or the native
/// binary a shim forwards to (`"%dp0%\node_modules\…\claude.exe"   %*`).
#[cfg_attr(not(windows), allow(dead_code))]
fn npm_shim_script(shim: &str) -> Option<String> {
    for prefix in ["\"%dp0%\\", "\"%~dp0\\"] {
        let mut rest = shim;
        while let Some(at) = rest.find(prefix) {
            let after = &rest[at + prefix.len()..];
            let end = after.find('"')?;
            let path = &after[..end];
            let lower = path.to_ascii_lowercase();
            let is_script = [".js", ".cjs", ".mjs", ".exe"]
                .iter()
                .any(|e| lower.ends_with(e));
            // The shim's own `IF EXIST "%dp0%\node.exe"` check isn't the target.
            let is_node = lower == "node.exe" || lower.ends_with("\\node.exe");
            let clean = !path.contains("..") && !path.contains('%') && !path.is_empty() && !is_node;
            if is_script && clean {
                return Some(path.to_string());
            }
            rest = &after[end..];
        }
    }
    None
}

/// Whether `s` reaches a program unchanged through cmd.exe without quoting.
#[cfg_attr(not(windows), allow(dead_code))]
fn cmd_safe(s: &str) -> bool {
    !s.is_empty()
        && !s
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "&|<>()^%!\"',;=`".contains(c))
}

/// Decodes as much of `pending` as is valid UTF-8, keeping an incomplete
/// trailing sequence for the next chunk. Invalid bytes become U+FFFD.
pub fn decode_utf8_chunk(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    let mut start = 0;
    loop {
        match std::str::from_utf8(&pending[start..]) {
            Ok(s) => {
                out.push_str(s);
                pending.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                // SAFETY-free: the prefix was just validated.
                out.push_str(std::str::from_utf8(&pending[start..start + valid]).unwrap_or(""));
                match e.error_len() {
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        start += valid + bad;
                    }
                    None => {
                        // Incomplete sequence at the end: keep it for next time.
                        pending.drain(..start + valid);
                        return out;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
// Most PTY tests drive /bin/sh, so their helpers are unused elsewhere.
#[cfg_attr(not(unix), allow(dead_code, unused_imports))]
mod tests {
    use super::*;
    use armada_core::EventSink;

    #[test]
    fn finds_the_script_behind_npm_shims() {
        // npm 7+ (cmd-shim 4+)
        let modern = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n";
        assert_eq!(
            npm_shim_script(modern).as_deref(),
            Some("node_modules\\@openai\\codex\\bin\\codex.js")
        );
        // npm 6
        let legacy = "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\node_modules\\x\\cli.js\" %*\r\n) ELSE (\r\n  node  \"%~dp0\\node_modules\\x\\cli.js\" %*\r\n)";
        assert_eq!(
            npm_shim_script(legacy).as_deref(),
            Some("node_modules\\x\\cli.js")
        );
        // Native binaries (Claude Code, Grok): the .exe the shim forwards to.
        let native = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n";
        assert_eq!(
            npm_shim_script(native).as_deref(),
            Some("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe")
        );
        assert_eq!(npm_shim_script("@echo off\r\ncall foo.exe %*"), None);
        assert_eq!(npm_shim_script("\"%dp0%\\..\\evil.js\""), None);
    }

    #[test]
    fn cmd_safety() {
        assert!(cmd_safe(
            "C:\\Users\\sam\\AppData\\Roaming\\npm\\claude.cmd"
        ));
        assert!(cmd_safe("login"));
        for bad in [
            "C:\\Program Files\\x.cmd",
            "C:\\a&b\\x.cmd",
            "C:\\(x)\\y.cmd",
            "a^b",
            "%PATH%",
            "x|y",
            "",
        ] {
            assert!(!cmd_safe(bad), "{bad}");
        }
    }

    struct Events(Mutex<Vec<ArmadaEvent>>);
    impl EventSink for Events {
        fn emit(&self, event: ArmadaEvent) {
            self.0.lock().push(event);
        }
    }

    fn test_core() -> (Core, Arc<Events>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("armada-term-{}", uuid::Uuid::new_v4()));
        let events = Arc::new(Events(Mutex::new(Vec::new())));
        let core = Core::open(dir.join("data"), events.clone()).unwrap();
        (core, events, dir)
    }

    fn exited(events: &Events, id: &str) -> bool {
        events.0.lock().iter().any(
            |e| matches!(e, ArmadaEvent::TerminalExit { terminal_id, .. } if terminal_id == id),
        )
    }

    fn wait_for(limit: Duration, mut done: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if done() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        done()
    }

    /// A process ignoring SIGHUP/SIGTERM is still ended; its child too.
    #[cfg(unix)]
    #[test]
    fn kill_escalates() {
        let (core, events, dir) = test_core();
        let terminals = Terminals::default();
        let marker = dir.join("child-pid");
        let script = format!(
            "trap '' HUP TERM; sleep 60 & echo $! > '{}'; while :; do sleep 1; done",
            marker.display()
        );
        let id = terminals
            .spawn(
                core.clone(),
                SpawnSpec {
                    program: "/bin/sh".into(),
                    args: vec!["-c".into(), script.into()],
                    env_remove: vec![],
                    env: vec![],
                    cwd: None,
                },
                |_| {},
            )
            .unwrap();
        assert!(wait_for(Duration::from_secs(5), || marker.exists()));
        std::thread::sleep(Duration::from_millis(200));
        let grandchild: i32 = std::fs::read_to_string(&marker)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        terminals.kill(&core, &id).unwrap();
        assert!(
            wait_for(Duration::from_secs(10), || exited(&events, &id)),
            "terminal didn't exit"
        );
        // SAFETY: probing with signal 0.
        let alive = unsafe { libc::kill(grandchild, 0) } == 0;
        assert!(!alive, "background child survived");
        assert!(terminals.inner.lock().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The process exits but leaves something holding the terminal open: the reader
    /// must still finish and the exit be reported.
    #[cfg(unix)]
    #[test]
    fn exits_even_if_a_background_process_holds_the_terminal() {
        let (core, events, dir) = test_core();
        let terminals = Terminals::default();
        let id = terminals
            .spawn(
                core,
                SpawnSpec {
                    program: "/bin/sh".into(),
                    args: vec!["-c".into(), "sleep 60 & echo started".into()],
                    env_remove: vec![],
                    env: vec![],
                    cwd: None,
                },
                |_| {},
            )
            .unwrap();
        assert!(
            wait_for(Duration::from_secs(10), || exited(&events, &id)),
            "terminal didn't exit"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn sh(script: &str) -> SpawnSpec {
        SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env_remove: vec![],
            env: vec![],
            cwd: None,
        }
    }

    #[cfg(unix)]
    fn alive(pid: i32) -> bool {
        // SAFETY: probing with signal 0.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// A login CLI that succeeds after opening the browser: the browser (still holding
    /// the terminal, ignoring SIGHUP like a daemonized app) must survive.
    #[cfg(unix)]
    #[test]
    fn successful_exit_leaves_launched_programs_alone() {
        let (core, events, dir) = test_core();
        let terminals = Terminals::default();
        let marker = dir.join("pid");
        let script = format!(
            "(trap '' HUP; exec sleep 30) & echo $! > '{}'; exit 0",
            marker.display()
        );
        let id = terminals.spawn(core, sh(&script), |_| {}).unwrap();
        assert!(
            wait_for(Duration::from_secs(10), || exited(&events, &id)),
            "terminal didn't exit"
        );
        let pid: i32 = std::fs::read_to_string(&marker)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let survived = alive(pid);
        // SAFETY: plain kill(2) of the process this test started.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
        assert!(
            survived,
            "a program launched by a successful login was killed"
        );
        assert!(terminals.inner.lock().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// After a failure, leftovers are ended (politely first: SIGTERM suffices here).
    #[cfg(unix)]
    #[test]
    fn failed_exit_ends_leftovers() {
        let (core, events, dir) = test_core();
        let terminals = Terminals::default();
        let marker = dir.join("pid");
        let script = format!(
            "(trap '' HUP; exec sleep 30) & echo $! > '{}'; exit 3",
            marker.display()
        );
        let id = terminals.spawn(core, sh(&script), |_| {}).unwrap();
        assert!(
            wait_for(Duration::from_secs(10), || exited(&events, &id)),
            "terminal didn't exit"
        );
        let pid: i32 = std::fs::read_to_string(&marker)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(
            wait_for(Duration::from_secs(2), || !alive(pid)),
            "leftover survived"
        );
        let code = events.0.lock().iter().find_map(|e| match e {
            ArmadaEvent::TerminalExit { terminal_id, code } if *terminal_id == id => Some(*code),
            _ => None,
        });
        assert_eq!(code, Some(Some(3)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn output_is_batched() {
        let (core, events, dir) = test_core();
        let terminals = Terminals::default();
        let id = terminals
            .spawn(
                core,
                sh("i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done"),
                |_| {},
            )
            .unwrap();
        assert!(wait_for(Duration::from_secs(10), || exited(&events, &id)));
        let chunks: Vec<String> = events
            .0
            .lock()
            .iter()
            .filter_map(|e| match e {
                ArmadaEvent::TerminalOutput { terminal_id, data } if *terminal_id == id => {
                    Some(data.clone())
                }
                _ => None,
            })
            .collect();
        let all = chunks.concat();
        assert!(all.contains("line0\r\n") && all.contains("line1999\r\n"));
        assert!(chunks.len() < 100, "{} events for 2000 lines", chunks.len());
        assert!(chunks.iter().all(|c| c.len() <= MAX_EVENT_BYTES));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn input_is_capped_and_logins_are_deduplicated() {
        let (core, events, dir) = test_core();
        let terminals = Terminals::default();
        let (first, reused) = terminals
            .spawn_unique("login:acc", core.clone(), sh("read x"), |_| {})
            .unwrap();
        assert!(!reused);
        let (again, reused) = terminals
            .spawn_unique("login:acc", core.clone(), sh("read x"), |_| {})
            .unwrap();
        assert_eq!(first, again);
        assert!(reused);
        let (other, _) = terminals
            .spawn_unique("login:other", core.clone(), sh("read x"), |_| {})
            .unwrap();
        assert_ne!(first, other);

        let big = "x".repeat(MAX_INPUT_BYTES + 1);
        assert!(terminals.write(&first, &big).is_err());
        terminals.write(&first, "done\n").unwrap();
        terminals.write(&other, "done\n").unwrap();
        assert!(wait_for(Duration::from_secs(10), || exited(
            &events, &first
        ) && exited(
            &events, &other
        )));
        // Finished: a new login starts a new terminal.
        let (next, _) = terminals
            .spawn_unique("login:acc", core.clone(), sh("exit 0"), |_| {})
            .unwrap();
        assert_ne!(next, first);
        assert!(wait_for(Duration::from_secs(10), || exited(&events, &next)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn splits_output_on_char_boundaries() {
        let s = "aé✓🎉".repeat(3);
        for max in 1..12 {
            let pieces = split_at_char_boundaries(&s, max);
            assert_eq!(pieces.concat(), s);
            assert!(pieces.iter().all(|p| p.len() <= max.max(4)));
        }
        assert!(split_at_char_boundaries("", 4).is_empty());
    }

    #[tokio::test]
    async fn cancelled_jobs_still_run_their_exit_hook() {
        let (core, events, dir) = test_core();
        let terminals = Terminals::default();
        let (tx, rx) = std::sync::mpsc::channel();
        let id = terminals.spawn_task(
            core.clone(),
            |_log| async {
                tokio::time::sleep(Duration::from_secs(3600)).await;
                Ok(())
            },
            move |code| {
                let _ = tx.send(code);
            },
        );
        terminals.kill(&core, &id).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), None);
        assert!(exited(&events, &id));
        // Runs once only.
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_split_multibyte_sequences() {
        let bytes = "héllo ✓".as_bytes();
        let mut pending = Vec::new();
        let mut out = String::new();
        for b in bytes {
            pending.push(*b);
            out.push_str(&decode_utf8_chunk(&mut pending));
        }
        assert_eq!(out, "héllo ✓");
        assert!(pending.is_empty());
    }

    #[test]
    fn replaces_invalid_bytes() {
        let mut pending = vec![b'a', 0xFF, b'b', 0xE2, 0x9C];
        assert_eq!(decode_utf8_chunk(&mut pending), "a\u{FFFD}b");
        assert_eq!(pending, vec![0xE2, 0x9C]);
        pending.push(0x93);
        assert_eq!(decode_utf8_chunk(&mut pending), "✓");
    }
}
