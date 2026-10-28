//! PTY terminals for provider login flows and installs. Output is streamed to the
//! UI as `ArmadaEvent::TerminalOutput`, exit as `ArmadaEvent::TerminalExit`.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context};
use armada_core::{ArmadaEvent, Core};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tracing::{debug, warn};

pub const DEFAULT_COLS: u16 = 100;
pub const DEFAULT_ROWS: u16 = 30;

struct Term {
    master: Box<dyn MasterPty + Send>,
    /// Input for the terminal's writer thread. A PTY write blocks while the child isn't
    /// reading its input, so writes never happen under the map lock or on an async
    /// worker; the channel also keeps keystrokes in order.
    input: mpsc::Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Clone, Default)]
pub struct Terminals {
    inner: Arc<Mutex<HashMap<String, Term>>>,
    /// In-process jobs (e.g. the toolchain installer) shown in the same terminal UI.
    tasks: Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>>,
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
    pub env: Vec<(String, String)>,
    pub cwd: Option<PathBuf>,
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

        let mut cmd = command_for(&spec);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let cwd = spec.cwd.clone().or_else(armada_core::providers::home_dir);
        if let Some(cwd) = cwd.filter(|p| p.is_dir()) {
            cmd.cwd(cwd);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("starting {}", spec.program.to_string_lossy()))?;
        // Drop our copy of the slave so reads hit EOF once the child exits.
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let mut killer = child.clone_killer();

        // Writer: UI input -> PTY. Ends when the terminal is removed (sender dropped) or
        // the PTY stops accepting input.
        let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>();
        let spawned = std::thread::Builder::new()
            .name("armada-pty-write".into())
            .spawn(move || {
                for data in input_rx {
                    if let Err(e) = writer.write_all(&data).and_then(|()| writer.flush()) {
                        debug!("terminal input closed: {e}");
                        break;
                    }
                }
            });
        if let Err(e) = spawned {
            let _ = killer.kill();
            return Err(e).context("starting the terminal input thread");
        }

        self.inner.lock().insert(
            id.clone(),
            Term {
                master: pair.master,
                input: input_tx,
                killer,
            },
        );

        // Reader: PTY bytes -> UTF-8 text events.
        let (done_tx, done_rx) = mpsc::channel::<()>();
        {
            let core = core.clone();
            let id = id.clone();
            std::thread::Builder::new()
                .name("armada-pty-read".into())
                .spawn(move || {
                    // Give the UI a moment to learn the terminal id (returned by the
                    // command) before the first bytes arrive; the PTY buffers meanwhile.
                    std::thread::sleep(Duration::from_millis(150));
                    let mut buf = [0u8; 8192];
                    let mut pending = Vec::new();
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                pending.extend_from_slice(&buf[..n]);
                                let data = decode_utf8_chunk(&mut pending);
                                if !data.is_empty() {
                                    core.emit(ArmadaEvent::TerminalOutput {
                                        terminal_id: id.clone(),
                                        data,
                                    });
                                }
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                            // EIO on Linux once the child side closes.
                            Err(_) => break,
                        }
                    }
                    if !pending.is_empty() {
                        core.emit(ArmadaEvent::TerminalOutput {
                            terminal_id: id.clone(),
                            data: String::from_utf8_lossy(&pending).into_owned(),
                        });
                    }
                    let _ = done_tx.send(());
                })?;
        }

        // Waiter: exit status -> TerminalExit -> on_exit hook.
        {
            let terminals = self.clone();
            let id = id.clone();
            std::thread::Builder::new()
                .name("armada-pty-wait".into())
                .spawn(move || {
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
                    // Let the reader flush trailing output. On Windows the reader only
                    // sees EOF once the ConPTY is closed (below), hence the timeout.
                    let _ = done_rx.recv_timeout(Duration::from_secs(2));
                    terminals.inner.lock().remove(&id);
                    debug!(terminal = %id, ?code, "terminal exited");
                    core.emit(ArmadaEvent::TerminalExit {
                        terminal_id: id,
                        code,
                    });
                    on_exit(code);
                })?;
        }

        Ok(id)
    }

    /// Runs an in-process job whose log lines stream to a terminal view, so the UI
    /// treats it exactly like a PTY (output, exit code, kill).
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
        let tasks = self.tasks.clone();
        let task_id = id.clone();
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
            on_exit(Some(code));
        });
        map.insert(id.clone(), handle.abort_handle());
        id
    }

    fn kill_task(&self, core: &Core, id: &str) -> bool {
        let Some(handle) = self.tasks.lock().remove(id) else {
            return false;
        };
        handle.abort();
        core.emit(ArmadaEvent::TerminalExit {
            terminal_id: id.to_string(),
            code: None,
        });
        true
    }

    pub fn write(&self, id: &str, data: &str) -> anyhow::Result<()> {
        if self.tasks.lock().contains_key(id) {
            return Ok(());
        }
        let map = self.inner.lock();
        let term = map.get(id).ok_or_else(|| anyhow!("terminal not found"))?;
        // Never blocks: the terminal's writer thread does the (possibly blocking) write.
        term.input
            .send(data.as_bytes().to_vec())
            .map_err(|_| anyhow!("the terminal no longer accepts input"))
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

    /// Kills the process (the waiter thread then emits `TerminalExit`) or aborts a job.
    pub fn kill(&self, core: &Core, id: &str) -> anyhow::Result<()> {
        if self.kill_task(core, id) {
            return Ok(());
        }
        let mut map = self.inner.lock();
        let term = map
            .get_mut(id)
            .ok_or_else(|| anyhow!("terminal not found"))?;
        term.killer.kill()?;
        Ok(())
    }

    pub fn kill_all(&self) {
        for (_, handle) in self.tasks.lock().drain() {
            handle.abort();
        }
        for term in self.inner.lock().values_mut() {
            let _ = term.killer.kill();
        }
    }
}

fn command_for(spec: &SpawnSpec) -> CommandBuilder {
    // npm shims on Windows are .cmd/.bat files, which need cmd.exe to run.
    #[cfg(windows)]
    {
        let lower = spec.program.to_string_lossy().to_ascii_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            let mut cmd = CommandBuilder::new("cmd.exe");
            cmd.arg("/C");
            cmd.arg(&spec.program);
            cmd.args(&spec.args);
            return cmd;
        }
    }
    let mut cmd = CommandBuilder::new(&spec.program);
    cmd.args(&spec.args);
    cmd
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
mod tests {
    use super::decode_utf8_chunk;

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
