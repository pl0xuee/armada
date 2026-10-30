//! Locating, launching and installing the official agent runtimes.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::model::{Provider, ProviderInfo};

/// ACP adapter that wraps Claude Code. Pinned to a version verified against Armada.
pub const CLAUDE_ADAPTER_PKG: &str = "@agentclientprotocol/claude-agent-acp";
pub const CLAUDE_ADAPTER_VERSION: &str = "0.98.0";

// Agent CLIs installed by Armada: exact, known-good versions (never `@latest`).
// To bump: `npm view <pkg> version`, test Armada against it (the Codex driver needs
// the app-server features of codex-cli >= 0.164), then update the constant and, if
// a package gains install scripts, `SCRIPTED_PKGS` in toolchain.rs.
pub const CLAUDE_CODE_PKG: &str = "@anthropic-ai/claude-code";
pub const CLAUDE_CODE_VERSION: &str = "2.1.312";
pub const CODEX_PKG: &str = "@openai/codex";
pub const CODEX_VERSION: &str = "0.166.0";
pub const GROK_PKG: &str = "@xai-official/grok";
pub const GROK_VERSION: &str = "1.0.70";

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

/// The adapter is installed *and* at least the version this Armada build was tested
/// with (a newer one, from the update check, is fine). Missing or older is reinstalled.
pub fn claude_adapter_current(data_dir: &Path) -> bool {
    claude_adapter_entry(data_dir).is_some()
        && claude_adapter_version(data_dir).is_some_and(|v| {
            crate::toolchain::version_cmp(&v, CLAUDE_ADAPTER_VERSION) != std::cmp::Ordering::Less
        })
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

static DATA_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Tells this module where Armada's own tools live (set once at startup), so
/// [`find_cli`] can prefer Armada's copies of the agent CLIs.
pub fn set_data_dir(dir: &Path) {
    let _ = DATA_DIR.set(dir.to_path_buf());
}

/// Armada's own copy of a provider's CLI, installed by Armada into its data folder
/// (see `toolchain::install`): Claude Code ships inside the Claude Agent SDK package,
/// Codex and Grok are their pinned npm packages. `None` until it is installed.
pub fn managed_cli_in(provider: Provider, data_dir: &Path) -> Option<PathBuf> {
    match provider {
        Provider::Claude => bundled_claude(data_dir),
        Provider::Codex | Provider::Grok => {
            let bin = crate::toolchain::tools_bin_dir(data_dir);
            which::which_in(cli_name(provider), Some(&bin), data_dir).ok()
        }
        Provider::Local | Provider::Custom => None,
    }
}

/// The version of Armada's installed copy of an npm-installed CLI package (`None` when
/// it isn't installed). The pinned version is what Armada was tested against.
pub fn managed_pkg_version(data_dir: &Path, pkg: &str) -> Option<String> {
    let manifest = adapter_dir(data_dir)
        .join("node_modules")
        .join(pkg)
        .join("package.json");
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(manifest).ok()?).ok()?;
    json["version"].as_str().map(str::to_string)
}

/// The CLI to run for `provider`: Armada's own copy when it has one, otherwise
/// whatever is installed on the system (never a launcher script, see [`resolve_program`]).
/// Armada's copy comes first so agents, sign-in and status don't depend on the system's
/// PATH, wrappers or versions.
pub fn find_cli(provider: Provider) -> Option<PathBuf> {
    DATA_DIR
        .get()
        .and_then(|d| managed_cli_in(provider, d))
        .or_else(|| resolve_program(cli_name(provider)))
}

/// Whether the CLI [`find_cli`] returns is Armada's own copy.
pub fn is_managed(provider: Provider) -> bool {
    DATA_DIR
        .get()
        .is_some_and(|d| managed_cli_in(provider, d).is_some())
}

/// Whether `path` is one of those tiny launcher scripts that run `mise` (to install or
/// update the tool) before every start, e.g. Omarchy's `~/.local/bin/claude`:
/// `mise use -g claude && exec mise x claude -- claude "$@"`. They re-check the network
/// each time, so a command through one can take a minute or hang, and a sign-in window
/// stays blank meanwhile.
fn is_mise_wrapper(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = [0u8; 512];
    let n = file.read(&mut head).unwrap_or(0);
    let text = String::from_utf8_lossy(&head[..n]);
    text.starts_with("#!")
        && (text.contains("mise use") || text.contains("mise x ") || text.contains("mise exec"))
}

/// mise's shims folder (`mise` itself resolves the tool's real version, quickly).
fn mise_shims_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("MISE_DATA_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d).join("shims"));
    }
    let data = std::env::var_os("XDG_DATA_HOME")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".local").join("share")))?;
    Some(data.join("mise").join("shims"))
}

/// Finds `name` on PATH like `which`, but never picks a mise launcher script (see
/// [`is_mise_wrapper`]) when anything else is available: the next match on PATH, or the
/// mise shim, is used instead. A launcher is only returned when it is all there is.
pub fn resolve_program(name: &str) -> Option<PathBuf> {
    // A full path (the bundled Claude Code) is used as given.
    if Path::new(name).is_absolute() {
        return Path::new(name).is_file().then(|| PathBuf::from(name));
    }
    let path = std::env::var_os("PATH")?;
    let cwd = std::env::current_dir().unwrap_or_default();
    resolve_program_in(name, &path, &cwd, mise_shims_dir().as_deref())
}

fn resolve_program_in(
    name: &str,
    path: &std::ffi::OsStr,
    cwd: &Path,
    shims: Option<&Path>,
) -> Option<PathBuf> {
    let all: Vec<PathBuf> = which::which_in_all(name, Some(path), cwd).ok()?.collect();
    if let Some(good) = all.iter().find(|p| !is_mise_wrapper(p)) {
        return Some(good.clone());
    }
    let first = all.first()?.clone();
    // Only a launcher on PATH: the shim does the same job without the update check.
    if let Some(shim) = shims.map(|d| d.join(name)).filter(|s| s.is_file()) {
        return Some(shim);
    }
    Some(first)
}

/// The Claude Code binary that ships with the Claude Agent SDK under Armada's
/// tools (`@anthropic-ai/claude-agent-sdk-<platform>`): what Claude agents run.
pub fn bundled_claude(data_dir: &Path) -> Option<PathBuf> {
    let scope = adapter_dir(data_dir)
        .join("node_modules")
        .join("@anthropic-ai");
    let name = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(scope)
        .ok()?
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("claude-agent-sdk-")
        })
        .map(|e| e.path())
        .collect();
    dirs.sort();
    dirs.into_iter().map(|d| d.join(name)).find(|b| b.is_file())
}

/// The Claude Code binary for Armada's own commands (sign-in, account status):
/// the bundled one first. A `claude` on PATH may be a wrapper (e.g. Omarchy's,
/// which runs `mise use` first) that takes longer to start than these allow.
pub fn claude_binary(data_dir: &Path) -> Option<PathBuf> {
    bundled_claude(data_dir).or_else(|| find_cli(Provider::Claude))
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
            if claude_binary(data_dir).is_none() {
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
        Provider::Local => launch_spec(Provider::Codex, data_dir),
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
        Provider::Codex | Provider::Local => "npm install -g @openai/codex".into(),
        Provider::Grok => "npm install -g @xai-official/grok".into(),
        Provider::Custom => String::new(),
    }
}

pub fn docs_url(provider: Provider) -> &'static str {
    match provider {
        Provider::Claude => "https://docs.claude.com/en/docs/claude-code/overview",
        Provider::Codex => "https://developers.openai.com/codex/cli",
        Provider::Local => "https://ollama.com/download",
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
    for ((provider, path), mut version) in Provider::ALL.into_iter().zip(paths).zip(versions) {
        // A `claude` that's slow to answer (a wrapper): show the version Armada runs.
        if provider == Provider::Claude && version.is_none() {
            if let Some(bundled) = bundled_claude(data_dir) {
                version = version_of(bundled).await;
            }
        }
        let adapter_required = provider == Provider::Claude;
        out.push(ProviderInfo {
            provider,
            display_name: provider.display_name().into(),
            cli_name: cli_name(provider).into(),
            installed: path.is_some(),
            managed: is_managed(provider),
            managed_version: crate::toolchain::installed_version(provider, data_dir),
            tested_version: crate::toolchain::tool_package(provider).map(|(_, v)| v.to_string()),
            latest_version: crate::toolchain::latest_known(provider),
            update_available: crate::toolchain::update_available(provider, data_dir),
            updates_checked_at: crate::toolchain::updates_checked_at(),
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

    /// What this machine resolves (run with --ignored --nocapture to see).
    #[test]
    #[ignore]
    fn print_resolved_programs() {
        for name in ["codex", "claude", "grok", "gh", "git"] {
            println!("{name}: {:?}", resolve_program(name));
        }
    }

    #[cfg(unix)]
    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    /// Omarchy's `~/.local/bin/codex` runs `mise use -g codex` before every start (a
    /// network check that can take a minute): a sign-in through it stays blank. It is
    /// skipped in favour of the shim, or any other real executable on PATH.
    #[cfg(unix)]
    #[test]
    fn mise_launcher_scripts_are_skipped() {
        let root = std::env::temp_dir().join(format!("armada-wrap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let wrapper_body =
            "#!/bin/bash\nexport MISE_MINIMUM_RELEASE_AGE=0\nmise use -g --quiet \"codex\" || exit 1\nexec mise x \"codex\" -- \"codex\" \"$@\"\n";
        let local = root.join("local-bin");
        let shims = root.join("shims");
        let wrapper = script(&local, "codex", wrapper_body);
        let shim = script(&shims, "codex", "#!/bin/sh\nexit 0\n");
        let cwd = root.clone();
        let both = std::env::join_paths([&local, &shims]).unwrap();
        // The wrapper comes first on PATH, but the real one is chosen.
        assert_eq!(
            resolve_program_in("codex", &both, &cwd, Some(&shims)),
            Some(shim.clone())
        );
        assert!(is_mise_wrapper(&wrapper) && !is_mise_wrapper(&shim));
        // Only the wrapper on PATH: the mise shim folder is used.
        let only = std::env::join_paths([&local]).unwrap();
        assert_eq!(
            resolve_program_in("codex", &only, &cwd, Some(&shims)),
            Some(shim)
        );
        // Nothing else exists: the launcher is better than nothing.
        assert_eq!(
            resolve_program_in("codex", &only, &cwd, None),
            Some(wrapper)
        );
        // A normal program is untouched, and a missing one is missing.
        let other = script(&local, "tool", "#!/bin/sh\nexit 0\n");
        assert_eq!(
            resolve_program_in("tool", &only, &cwd, Some(&shims)),
            Some(other)
        );
        assert_eq!(
            resolve_program_in("nonexistent-xyz", &only, &cwd, Some(&shims)),
            None
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn finds_the_bundled_claude_code() {
        let data = std::env::temp_dir().join(format!("armada-bundled-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        assert_eq!(bundled_claude(&data), None);
        let scope = adapter_dir(&data)
            .join("node_modules")
            .join("@anthropic-ai");
        let name = if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        };
        // The SDK itself and other packages don't count; the platform package does.
        std::fs::create_dir_all(scope.join("claude-agent-sdk")).unwrap();
        std::fs::write(scope.join("claude-agent-sdk").join(name), "").unwrap();
        assert_eq!(bundled_claude(&data), None);
        let platform = scope.join("claude-agent-sdk-linux-x64");
        std::fs::create_dir_all(&platform).unwrap();
        std::fs::write(platform.join(name), "").unwrap();
        assert_eq!(bundled_claude(&data), Some(platform.join(name)));
        assert_eq!(claude_binary(&data), Some(platform.join(name)));
        let _ = std::fs::remove_dir_all(&data);
    }

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
