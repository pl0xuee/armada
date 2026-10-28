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

/// Entry script of the installed Claude ACP adapter, if present.
pub fn claude_adapter_entry(data_dir: &Path) -> Option<PathBuf> {
    let pkg_dir = adapter_dir(data_dir)
        .join("node_modules")
        .join(CLAUDE_ADAPTER_PKG);
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(pkg_dir.join("package.json")).ok()?).ok()?;
    let bin = match &manifest["bin"] {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(m) => m.values().next()?.as_str()?.to_string(),
        _ => manifest["main"].as_str()?.to_string(),
    };
    let entry = pkg_dir.join(bin);
    entry.exists().then_some(entry)
}

/// GUI apps (especially on macOS) start with a minimal PATH, so the agent CLIs
/// installed via Homebrew, npm, mise or the vendors' install scripts are not
/// found. Pull PATH from the user's login shell and add the usual locations.
/// Runs the user's login shell to read its PATH, giving up after 3 seconds so a
/// slow or interactive shell profile can't stall startup.
#[cfg(unix)]
fn login_shell_path() -> Option<Vec<u8>> {
    use std::io::Read;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let mut child = std::process::Command::new(&shell)
        .args(["-ilc", "printf '__ARMADA_PATH__%s' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = Vec::new();
    child.stdout.take()?.read_to_end(&mut out).ok()?;
    Some(out)
}

pub fn augment_path() {
    let mut parts: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();

    #[cfg(unix)]
    {
        if let Some(stdout) = login_shell_path() {
            let s = String::from_utf8_lossy(&stdout);
            if let Some(p) = s.rsplit("__ARMADA_PATH__").next() {
                for dir in std::env::split_paths(p.trim()) {
                    if !parts.contains(&dir) {
                        parts.push(dir);
                    }
                }
            }
        }
    }

    if let Some(home) = home_dir() {
        let extra = [
            home.join(".local/bin"),
            home.join(".claude/local"),
            home.join(".npm-global/bin"),
            home.join(".bun/bin"),
            home.join(".local/share/mise/shims"),
            home.join("AppData/Roaming/npm"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ];
        for dir in extra {
            if dir.is_dir() && !parts.contains(&dir) {
                parts.push(dir);
            }
        }
    }

    if let Ok(joined) = std::env::join_paths(parts) {
        std::env::set_var("PATH", joined);
    }
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
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

async fn version_of(cli: &Path) -> Option<String> {
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        crate::accounts::quiet_command(cli)
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
    let node_available = crate::toolchain::usable_node(data_dir).await.is_some();
    let mut out = Vec::new();
    for provider in Provider::ALL {
        let path = find_cli(provider);
        let version = match &path {
            Some(p) => version_of(p).await,
            None => None,
        };
        let adapter_required = provider == Provider::Claude;
        out.push(ProviderInfo {
            provider,
            display_name: provider.display_name().into(),
            cli_name: cli_name(provider).into(),
            installed: path.is_some(),
            version,
            path: path.map(|p| p.to_string_lossy().into_owned()),
            adapter_required,
            adapter_installed: !adapter_required || claude_adapter_entry(data_dir).is_some(),
            node_available,
            install_command: install_command(provider, data_dir),
            docs_url: docs_url(provider).into(),
        });
    }
    out
}
