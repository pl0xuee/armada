//! Workspace panel backend: shells and project scripts in an agent's own folder,
//! reusing the PTY manager in `terminal.rs`.

use std::ffi::OsString;
use std::path::PathBuf;

use armada_core::scripts::{self, ProjectScript};
use armada_core::Core;
use tauri::State;

use crate::terminal::{SpawnSpec, Terminals};

type CmdResult<T> = Result<T, String>;

/// The agent's folder (its worktree if it has one); it must still exist.
fn agent_dir(core: &Core, agent_id: &str) -> CmdResult<PathBuf> {
    let agent = core.agent(agent_id).map_err(|e| format!("{e:#}"))?;
    let dir = PathBuf::from(&agent.cwd);
    if !dir.is_dir() {
        return Err(format!("{} no longer exists", agent.cwd));
    }
    Ok(dir)
}

/// The user's login shell, plus the arguments that run `command` (or an interactive
/// session when `None`) as a login shell so PATH setup in the profile applies.
fn shell_invocation(command: Option<&str>) -> (OsString, Vec<OsString>) {
    #[cfg(windows)]
    {
        let program = std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into());
        let args = command
            .map(|c| vec!["/C".into(), c.into()])
            .unwrap_or_default();
        (program, args)
    }
    #[cfg(not(windows))]
    {
        let program = std::env::var_os("SHELL")
            .filter(|s| std::path::Path::new(s).is_absolute() && std::path::Path::new(s).is_file())
            .unwrap_or_else(|| "/bin/sh".into());
        let mut args: Vec<OsString> = vec!["-l".into()];
        if let Some(c) = command {
            args.push("-c".into());
            args.push(c.into());
        }
        (program, args)
    }
}

/// Opens a terminal in the agent's folder: an interactive login shell, or, with
/// `script_id`, one of the project's detected scripts. Returns the terminal id.
#[tauri::command]
pub async fn workspace_terminal_open(
    core: State<'_, Core>,
    terminals: State<'_, Terminals>,
    agent_id: String,
    script_id: Option<String>,
) -> CmdResult<String> {
    let dir = agent_dir(&core, &agent_id)?;
    let command = match script_id {
        Some(id) => Some(
            scripts::find_script(&dir, &id)
                .ok_or_else(|| "That script isn't in this project any more".to_string())?
                .command,
        ),
        None => None,
    };
    let (program, args) = shell_invocation(command.as_deref());
    // Same environment hygiene as the agents: no AppImage runtime leaking into the shell.
    let mut env_remove = Vec::new();
    let mut env = Vec::new();
    for (name, value) in armada_core::childenv::appimage_env_changes(std::env::vars_os()) {
        let name = name.to_string_lossy().into_owned();
        match value {
            Some(v) => env.push((name, v.to_string_lossy().into_owned())),
            None => env_remove.push(name),
        }
    }
    let spec = SpawnSpec {
        program,
        args,
        env_remove,
        env,
        cwd: Some(dir),
    };
    terminals
        .spawn(core.inner().clone(), spec, |_| {})
        .map_err(|e| format!("{e:#}"))
}

/// Runnable commands detected in the agent's folder.
#[tauri::command]
pub async fn workspace_scripts(
    core: State<'_, Core>,
    agent_id: String,
) -> CmdResult<Vec<ProjectScript>> {
    let dir = agent_dir(&core, &agent_id)?;
    tauri::async_runtime::spawn_blocking(move || scripts::detect_scripts(&dir))
        .await
        .map_err(|e| e.to_string())
}

/// Which of `ports` accept a TCP connection on loopback right now (a quick connect with a
/// short timeout, IPv4 then IPv6). Backs the Preview tab: only servers that are really up
/// are offered. At most 32 ports are probed per call.
#[tauri::command]
pub async fn probe_ports(ports: Vec<u16>) -> Vec<u16> {
    tauri::async_runtime::spawn_blocking(move || {
        ports
            .into_iter()
            .take(32)
            .filter(|&p| p != 0 && port_is_listening(p))
            .collect()
    })
    .await
    .unwrap_or_default()
}

fn port_is_listening(port: u16) -> bool {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
    use std::time::Duration;
    [
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
    ]
    .into_iter()
    .any(|ip| {
        TcpStream::connect_timeout(&SocketAddr::new(ip, port), Duration::from_millis(250)).is_ok()
    })
}

#[cfg(test)]
mod tests {
    use super::port_is_listening;

    #[test]
    fn probe_sees_a_listener_and_a_closed_port() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        assert!(port_is_listening(port));
        drop(l);
        assert!(!port_is_listening(port));
    }
}
