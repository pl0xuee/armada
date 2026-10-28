//! Locating, launching and installing the official agent runtimes.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::model::{Provider, ProviderInfo};

/// ACP adapter that wraps Claude Code. Pinned to a version verified against Armada.
pub const CLAUDE_ADAPTER_PKG: &str = "@agentclientprotocol/claude-agent-acp";
pub const CLAUDE_ADAPTER_VERSION: &str = "0.98.0";

pub fn cli_name(provider: Provider) -> &'static str {
    provider.as_str()
}

/// npm prefix the Claude adapter is installed into (shared with managed CLIs).
pub fn adapter_dir(data_dir: &Path) -> PathBuf {
    crate::toolchain::tools_dir(data_dir)
}

fn claude_adapter_pkg_dir(data_dir: &Path) -> PathBuf {
    adapter_dir(data_dir)
        .join("node_modules")
        .join(CLAUDE_ADAPTER_PKG)
}

fn claude_adapter_manifest(data_dir: &Path) -> Option<serde_json::Value> {
    let bytes = std::fs::read(claude_adapter_pkg_dir(data_dir).join("package.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Entry script of the installed Claude ACP adapter, if present.
pub fn claude_adapter_entry(data_dir: &Path) -> Option<PathBuf> {
    let manifest = claude_adapter_manifest(data_dir)?;
    let bin = match &manifest["bin"] {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(m) => m.values().next()?.as_str()?.to_string(),
        _ => manifest["main"].as_str()?.to_string(),
    };
    let entry = claude_adapter_pkg_dir(data_dir).join(bin);
    entry.exists().then_some(entry)
}

/// Version of the installed Claude ACP adapter, if present.
pub fn claude_adapter_version(data_dir: &Path) -> Option<String> {
    claude_adapter_manifest(data_dir)?["version"]
        .as_str()
        .map(str::to_string)
}

/// The adapter is installed *and* is the version this Armada build is pinned to.
/// Anything else (missing, older, newer) is reinstalled by the installer.
pub fn claude_adapter_current(data_dir: &Path) -> bool {
    claude_adapter_entry(data_dir).is_some()
        && claude_adapter_version(data_dir).as_deref() == Some(CLAUDE_ADAPTER_VERSION)
}

/// How long the login shell may take to report its PATH.
#[cfg(unix)]
const LOGIN_SHELL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[cfg(unix)]
fn login_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".into()
            } else {
                "/bin/sh".into()
            }
        })
}

/// GUI apps (especially on macOS) start with a minimal PATH, so the agent CLIs
/// installed via Homebrew, npm, mise or the vendors' install scripts are not
/// found. Runs the user's login shell to read its PATH, giving up after a few
/// seconds so a slow or interactive shell profile can't stall startup.
#[cfg(unix)]
fn login_shell_path() -> Option<Vec<u8>> {
    capture_output(
        &login_shell(),
        &["-ilc", "printf '__ARMADA_PATH__%s' \"$PATH\""],
        LOGIN_SHELL_TIMEOUT,
    )
}

/// Runs `program` and returns what it wrote to stdout, or None if it didn't finish
/// within `timeout`. Bounded no matter what the program does:
/// - stdout goes to a private temp file, not a pipe, so a daemon started by a
///   shell profile that inherits stdout can't keep us reading forever, and a chatty
///   profile can't fill a pipe buffer and deadlock;
/// - the program runs in its own session (no controlling terminal, so an
///   interactive shell can't stop on terminal I/O), and on timeout the whole
///   process group is killed, not just the shell.
#[cfg(unix)]
fn capture_output(program: &str, args: &[&str], timeout: std::time::Duration) -> Option<Vec<u8>> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::process::CommandExt;

    struct RemoveOnDrop(PathBuf);
    impl Drop for RemoveOnDrop {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    let path = std::env::temp_dir().join(format!(
        "armada-shell-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .ok()?;
    let _cleanup = RemoveOnDrop(path.clone());
    let mut cmd = std::process::Command::new(program);
    crate::childenv::sanitize_std_command(&mut cmd);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(file))
        .stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe and touches no memory of this process.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().ok()?;
    // The child leads its own session and process group.
    let pgid = child.id() as libc::pid_t;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            _ => {
                // SAFETY: plain syscall; pgid is the group we created above.
                unsafe {
                    libc::killpg(pgid, libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = Vec::new();
    std::fs::File::open(&path)
        .ok()?
        .take(1024 * 1024)
        .read_to_end(&mut out)
        .ok()?;
    Some(out)
}

/// The login shell's PATH entries, from its marked output.
#[cfg_attr(not(unix), allow(dead_code))]
fn parse_shell_path(stdout: &[u8]) -> Vec<PathBuf> {
    let s = String::from_utf8_lossy(stdout);
    if !s.contains("__ARMADA_PATH__") {
        return Vec::new();
    }
    let p = s.rsplit("__ARMADA_PATH__").next().unwrap_or("");
    std::env::split_paths(p.trim())
        .filter(|d| !d.as_os_str().is_empty())
        .collect()
}

/// PATH order: the login shell's entries first (so e.g. Homebrew's git beats the
/// /usr/bin shim macOS gives GUI apps), then what Armada inherited, then the usual
/// install locations that exist. Empty entries and duplicates are dropped.
fn merge_paths(login: Vec<PathBuf>, inherited: Vec<PathBuf>, extra: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut parts: Vec<PathBuf> = Vec::new();
    for dir in login.into_iter().chain(inherited) {
        if !dir.as_os_str().is_empty() && !parts.contains(&dir) {
            parts.push(dir);
        }
    }
    for dir in extra {
        if dir.is_dir() && !parts.contains(&dir) {
            parts.push(dir);
        }
    }
    parts
}

pub fn augment_path() {
    let inherited: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();

    #[cfg(unix)]
    let login = login_shell_path()
        .map(|out| parse_shell_path(&out))
        .unwrap_or_default();
    #[cfg(not(unix))]
    let login: Vec<PathBuf> = Vec::new();

    let mut extra = Vec::new();
    if let Some(home) = home_dir() {
        extra.extend([
            home.join(".local/bin"),
            home.join(".claude/local"),
            home.join(".npm-global/bin"),
            home.join(".bun/bin"),
            home.join(".local/share/mise/shims"),
        ]);
    }
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA").filter(|v| !v.is_empty()) {
            extra.push(PathBuf::from(appdata).join("npm"));
        }
    } else {
        extra.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]);
    }

    let parts = merge_paths(login, inherited, extra);
    if let Ok(joined) = std::env::join_paths(parts) {
        std::env::set_var("PATH", joined);
    }
}

/// The user's home folder: USERPROFILE on Windows (HOME there is often set by
/// Git Bash/MSYS to something else), HOME elsewhere.
pub fn home_dir() -> Option<PathBuf> {
    let non_empty = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty());
    let found = if cfg!(windows) {
        non_empty("USERPROFILE").or_else(|| non_empty("HOME"))
    } else {
        non_empty("HOME").or_else(|| non_empty("USERPROFILE"))
    };
    found.map(PathBuf::from)
}

/// Expands a leading `~`, `~/` or `~\` to the home folder.
pub fn expand_home(path: &str) -> PathBuf {
    let rest = if path == "~" {
        Some("")
    } else {
        path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\"))
    };
    match (rest, home_dir()) {
        (Some(""), Some(home)) => home,
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

pub fn find_cli(provider: Provider) -> Option<PathBuf> {
    which::which(cli_name(provider)).ok()
}

pub fn find_node() -> Option<PathBuf> {
    which::which("node").ok()
}

/// Program + args that start the provider's agent speaking JSON-RPC on stdio.
/// `ARMADA_<PROVIDER>_COMMAND` (e.g. `ARMADA_GROK_COMMAND="python3 mock.py"`) overrides
/// the command, for development builds of an agent and for tests.
pub fn launch_spec(provider: Provider, data_dir: &Path) -> anyhow::Result<(PathBuf, Vec<String>)> {
    let var = format!("ARMADA_{}_COMMAND", provider.as_str().to_uppercase());
    if let Ok(cmd) = std::env::var(&var) {
        let mut parts = cmd.split_whitespace().map(str::to_string);
        if let Some(program) = parts.next() {
            let program = which::which(&program).unwrap_or_else(|_| PathBuf::from(program));
            return Ok((program, parts.collect()));
        }
    }
    match provider {
        Provider::Claude => {
            if find_cli(Provider::Claude).is_none() {
                anyhow::bail!(
                    "Claude Code is not installed. Install it from Settings → Providers."
                );
            }
            let entry = claude_adapter_entry(data_dir).ok_or_else(|| {
                anyhow::anyhow!("The Claude ACP adapter is not installed. Install it from Settings → Providers.")
            })?;
            let node = find_node()
                .ok_or_else(|| anyhow::anyhow!("Node.js is required for the Claude adapter."))?;
            Ok((node, vec![entry.to_string_lossy().into_owned()]))
        }
        Provider::Codex => {
            let cli = find_cli(Provider::Codex).ok_or_else(|| {
                anyhow::anyhow!("Codex CLI is not installed. Install it from Settings → Providers.")
            })?;
            Ok((cli, vec!["app-server".into()]))
        }
        Provider::Grok => {
            let cli = find_cli(Provider::Grok).ok_or_else(|| {
                anyhow::anyhow!(
                    "Grok Build is not installed. Install it from Settings → Providers."
                )
            })?;
            Ok((cli, vec!["agent".into(), "stdio".into()]))
        }
        Provider::Custom => anyhow::bail!("Custom agents are launched from their own definition"),
    }
}

/// Manual equivalent of what Armada's one-click installer does (shown in the UI
/// for people who prefer to install things themselves).
pub fn install_command(provider: Provider, data_dir: &Path) -> String {
    match provider {
        Provider::Claude => {
            let adapter = format!(
                "npm install --prefix \"{}\" {}@{}",
                adapter_dir(data_dir).display(),
                CLAUDE_ADAPTER_PKG,
                CLAUDE_ADAPTER_VERSION
            );
            if find_cli(Provider::Claude).is_some() {
                adapter
            } else {
                format!("npm install -g @anthropic-ai/claude-code && {adapter}")
            }
        }
        Provider::Codex => "npm install -g @openai/codex".into(),
        Provider::Grok => "npm install -g @xai-official/grok".into(),
        Provider::Custom => String::new(),
    }
}

pub fn docs_url(provider: Provider) -> &'static str {
    match provider {
        Provider::Claude => "https://docs.claude.com/en/docs/claude-code/overview",
        Provider::Codex => "https://developers.openai.com/codex/cli",
        Provider::Grok => "https://docs.x.ai",
        Provider::Custom => "https://agentclientprotocol.com/overview/agents",
    }
}

async fn version_of(cli: PathBuf) -> Option<String> {
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        crate::accounts::quiet_command(&cli)
            .arg("--version")
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let line = s.lines().next()?.trim();
    // "2.1.312 (Claude Code)", "codex-cli 0.164.0", "grok 1.0.70 (sha) [stable]"
    line.split_whitespace()
        .find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(str::to_string)
}

pub async fn detect(data_dir: &Path) -> Vec<ProviderInfo> {
    // Every probe runs a CLI (some take seconds to start), so run them all at once.
    let paths: Vec<Option<PathBuf>> = Provider::ALL.iter().map(|p| find_cli(*p)).collect();
    let mut probes = tokio::task::JoinSet::new();
    for (i, path) in paths.iter().enumerate() {
        if let Some(path) = path.clone() {
            probes.spawn(async move { (i, version_of(path).await) });
        }
    }
    let (node_available, versions) = tokio::join!(
        async { crate::toolchain::usable_node(data_dir).await.is_some() },
        async {
            let mut versions: Vec<Option<String>> = vec![None; Provider::ALL.len()];
            while let Some(res) = probes.join_next().await {
                if let Ok((i, v)) = res {
                    versions[i] = v;
                }
            }
            versions
        }
    );
    let mut out = Vec::new();
    for ((provider, path), version) in Provider::ALL.into_iter().zip(paths).zip(versions) {
        let adapter_required = provider == Provider::Claude;
        out.push(ProviderInfo {
            provider,
            display_name: provider.display_name().into(),
            cli_name: cli_name(provider).into(),
            installed: path.is_some(),
            version,
            path: path.map(|p| p.to_string_lossy().into_owned()),
            adapter_required,
            // An adapter other than the pinned version counts as missing, so the
            // UI offers the install that brings it to the pinned version.
            adapter_installed: !adapter_required || claude_adapter_current(data_dir),
            node_available,
            install_command: install_command(provider, data_dir),
            docs_url: docs_url(provider).into(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // The login-shell PATH lookup is Unix-only (and uses ':' separators).
    #[cfg(unix)]
    #[test]
    fn login_shell_entries_come_first() {
        let login = parse_shell_path(b"motd noise\n__ARMADA_PATH__/opt/homebrew/bin::/usr/bin\n");
        assert_eq!(
            login,
            vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/bin")
            ]
        );
        let merged = merge_paths(
            login,
            vec![
                PathBuf::from("/usr/bin"),
                PathBuf::new(),
                PathBuf::from("/bin"),
            ],
            vec![PathBuf::from("/definitely/not/a/dir")],
        );
        assert_eq!(
            merged,
            vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/bin")
            ]
        );
        assert!(parse_shell_path(b"no marker").is_empty());
    }

    #[test]
    fn expands_tilde() {
        let Some(home) = home_dir() else { return };
        assert_eq!(expand_home("~"), home);
        assert_eq!(expand_home("~/code/x"), home.join("code/x"));
        assert_eq!(expand_home("/abs/~/x"), PathBuf::from("/abs/~/x"));
        assert_eq!(expand_home("~other"), PathBuf::from("~other"));
    }

    #[cfg(unix)]
    #[test]
    fn shell_capture_survives_daemons_and_hangs() {
        // A profile that starts a daemon holding stdout must not block the read.
        let started = std::time::Instant::now();
        let out = capture_output(
            "/bin/sh",
            &["-c", "sleep 30 & printf '__ARMADA_PATH__/x/bin'"],
            std::time::Duration::from_secs(5),
        )
        .expect("finished");
        assert_eq!(parse_shell_path(&out), vec![PathBuf::from("/x/bin")]);
        assert!(started.elapsed() < std::time::Duration::from_secs(4));

        // A profile that never finishes is abandoned at the deadline, children included.
        let marker =
            std::env::temp_dir().join(format!("armada-capture-{}", uuid::Uuid::new_v4().simple()));
        let script = format!("(sleep 2; touch '{}') & sleep 30", marker.display());
        let started = std::time::Instant::now();
        let out = capture_output(
            "/bin/sh",
            &["-c", &script],
            std::time::Duration::from_millis(300),
        );
        assert!(out.is_none());
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        std::thread::sleep(std::time::Duration::from_millis(2500));
        assert!(
            !marker.exists(),
            "the timed-out shell's children were killed"
        );
    }
}
