//! Makes sure the agent runtimes can be installed on any machine, without admin
//! rights: if there is no usable Node.js, Armada downloads the current LTS from
//! nodejs.org (verified against the published SHA-256 sums) into its own data dir,
//! then npm-installs the agent CLIs into `<data>/tools`. Existing installs on the
//! user's PATH are respected and preferred.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{anyhow, bail, Context};
use sha2::{Digest, Sha256};

use crate::model::Provider;
use crate::providers;

/// Oldest Node.js the agent CLIs and the Claude adapter support.
pub const MIN_NODE_MAJOR: u32 = 20;

const NODE_DIST: &str = "https://nodejs.org/dist";

/// Node.js release Armada downloads. Pinned (never "latest") together with the
/// SHA-256 of each archive, so a compromised mirror or CDN can't swap the runtime.
/// To bump: pick a new LTS from https://nodejs.org/dist/index.json, copy the six
/// matching lines from https://nodejs.org/dist/<version>/SHASUMS256.txt below, and
/// cross-check at least one by downloading the archive and running `sha256sum`.
const NODE_VERSION: &str = "v24.22.1";
const NODE_SHA256: &[(&str, &str)] = &[
    (
        "node-v24.22.1-darwin-arm64.tar.gz",
        "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7",
    ),
    (
        "node-v24.22.1-darwin-x64.tar.gz",
        "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035",
    ),
    (
        "node-v24.22.1-linux-arm64.tar.gz",
        "33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3",
    ),
    (
        "node-v24.22.1-linux-x64.tar.gz",
        "eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c",
    ),
    (
        "node-v24.22.1-win-arm64.zip",
        "a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171",
    ),
    (
        "node-v24.22.1-win-x64.zip",
        "d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5",
    ),
];

pub type Log = Arc<dyn Fn(&str) + Send + Sync>;

pub fn runtime_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("runtime")
}

/// npm prefix for Armada-managed agent CLIs and adapters.
pub fn tools_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("tools")
}

pub fn tools_bin_dir(data_dir: &Path) -> PathBuf {
    tools_dir(data_dir).join("node_modules").join(".bin")
}

fn managed_node_home(data_dir: &Path) -> PathBuf {
    runtime_dir(data_dir).join("node")
}

fn managed_node_bin_dir(data_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        managed_node_home(data_dir)
    } else {
        managed_node_home(data_dir).join("bin")
    }
}

fn managed_node(data_dir: &Path) -> PathBuf {
    managed_node_bin_dir(data_dir).join(if cfg!(windows) { "node.exe" } else { "node" })
}

fn managed_npm_cli(data_dir: &Path) -> PathBuf {
    let home = managed_node_home(data_dir);
    let modules = if cfg!(windows) {
        home.join("node_modules")
    } else {
        home.join("lib").join("node_modules")
    };
    modules.join("npm").join("bin").join("npm-cli.js")
}

/// Puts Armada-managed Node (first: it only gets downloaded when the system one is
/// missing or too old) and managed agent CLIs (last, so the user's own installs
/// win) on PATH. Call once at startup, before any other threads exist: changing the
/// environment of a running multi-threaded process isn't safe.
pub fn add_managed_paths(data_dir: &Path) {
    let mut parts: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    // Added even before it exists so a later download needs no PATH change.
    let node_bin = managed_node_bin_dir(data_dir);
    if parts.first() != Some(&node_bin) {
        parts.retain(|p| p != &node_bin);
        parts.insert(0, node_bin);
    }
    let tools_bin = tools_bin_dir(data_dir);
    if !parts.contains(&tools_bin) {
        parts.push(tools_bin);
    }
    if let Ok(joined) = std::env::join_paths(parts) {
        std::env::set_var("PATH", joined);
    }
}

/// No console window on Windows; no AppImage library paths for npm/node.
fn hidden(cmd: &mut tokio::process::Command) {
    crate::childenv::sanitize_child_env(cmd);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
}

async fn node_major(node: &Path) -> Option<u32> {
    let mut cmd = tokio::process::Command::new(node);
    cmd.arg("--version").stdin(Stdio::null());
    hidden(&mut cmd);
    let out = tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output())
        .await
        .ok()?
        .ok()?;
    let v = String::from_utf8_lossy(&out.stdout);
    v.trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

/// A usable Node.js: the system one if new enough, else the Armada-managed one.
pub async fn usable_node(data_dir: &Path) -> Option<PathBuf> {
    let managed = managed_node(data_dir);
    if managed.exists()
        && node_major(&managed)
            .await
            .is_some_and(|m| m >= MIN_NODE_MAJOR)
    {
        return Some(managed);
    }
    let system = which::which("node").ok()?;
    node_major(&system)
        .await
        .is_some_and(|m| m >= MIN_NODE_MAJOR)
        .then_some(system)
}

/// How to invoke npm: (program, leading args).
struct Npm {
    program: PathBuf,
    args: Vec<String>,
}

async fn ensure_npm(data_dir: &Path, log: &Log) -> anyhow::Result<Npm> {
    if let Some(node) = usable_node(data_dir).await {
        if node == managed_node(data_dir) {
            log(&format!("✓ Using Armada's Node.js ({})", node.display()));
            return Ok(Npm {
                program: node,
                args: vec![managed_npm_cli(data_dir).to_string_lossy().into_owned()],
            });
        }
        if let Ok(npm) = which::which("npm") {
            log(&format!("✓ Using your Node.js ({})", node.display()));
            return Ok(Npm {
                program: npm,
                args: Vec::new(),
            });
        }
        log("! Node.js is installed but npm is missing; Armada will use its own copy.");
    } else {
        log(&format!(
            "! No Node.js {MIN_NODE_MAJOR}+ found; Armada will download its own private copy (no admin rights needed)."
        ));
    }
    let dir = data_dir.to_path_buf();
    let log2 = log.clone();
    tokio::task::spawn_blocking(move || download_node(&dir, &log2))
        .await
        .context("node download task")??;
    Ok(Npm {
        program: managed_node(data_dir),
        args: vec![managed_npm_cli(data_dir).to_string_lossy().into_owned()],
    })
}

fn node_platform() -> anyhow::Result<(&'static str, &'static str, &'static str)> {
    let os = match std::env::consts::OS {
        "linux" => {
            if Path::new("/etc/alpine-release").exists() {
                bail!("Alpine/musl Linux isn't covered by official Node.js builds. Install Node.js {MIN_NODE_MAJOR}+ with your package manager (apk add nodejs npm) and try again.");
            }
            "linux"
        }
        "macos" => "darwin",
        "windows" => "win",
        other => bail!("Unsupported OS for automatic Node.js install: {other}"),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => bail!("Unsupported CPU for automatic Node.js install: {other}"),
    };
    let ext = if os == "win" { "zip" } else { "tar.gz" };
    Ok((os, arch, ext))
}

/// TLS settings for Armada's own HTTPS requests: the OS certificate store, so
/// corporate TLS-inspecting proxies with a company root CA work.
pub fn platform_tls() -> ureq::tls::TlsConfig {
    ureq::tls::TlsConfig::builder()
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build()
}

fn http() -> ureq::Agent {
    // Proxy settings come from HTTP(S)_PROXY / ALL_PROXY / NO_PROXY (and the
    // Windows system proxy) by default.
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .tls_config(platform_tls())
            .timeout_connect(Some(std::time::Duration::from_secs(20)))
            .timeout_recv_response(Some(std::time::Duration::from_secs(60)))
            .timeout_recv_body(Some(std::time::Duration::from_secs(15 * 60)))
            .user_agent(concat!("Armada/", env!("CARGO_PKG_VERSION")))
            .build(),
    )
}

/// 8 hex characters for short unique names.
/// Lowercase hex encoding (digest 0.11 output no longer implements `LowerHex`).
pub(crate) fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

fn short_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// A scratch directory that is deleted when dropped (on success, error or panic).
struct TempDir(PathBuf);

impl TempDir {
    fn create(path: PathBuf) -> anyhow::Result<TempDir> {
        std::fs::create_dir_all(&path).with_context(|| format!("creating {}", path.display()))?;
        Ok(TempDir(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Whether `name` is one of the scratch names the installer uses in the runtime dir.
fn is_scratch_name(name: &str) -> bool {
    if name.starts_with(".staging-") {
        return true; // older builds
    }
    let short = name.strip_prefix(".s").or_else(|| name.strip_prefix(".o"));
    short.is_some_and(|h| h.len() == 8 && h.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Deletes scratch dirs left behind by an install that crashed or was killed.
/// Only called while holding the install lock, so no install is using them.
fn sweep_scratch(data_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(runtime_dir(data_dir)) else {
        return;
    };
    for entry in entries.flatten() {
        if is_scratch_name(&entry.file_name().to_string_lossy()) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Moves `new` to `dest`. An existing `dest` is first renamed aside and only deleted
/// once the new copy is in place; if that fails, the old copy is put back.
fn replace_dir(new: &Path, dest: &Path, scratch_parent: &Path, log: &Log) -> anyhow::Result<()> {
    let aside = scratch_parent.join(format!(".o{}", short_id()));
    let had_old = dest.exists();
    if had_old {
        std::fs::rename(dest, &aside).with_context(|| {
            format!(
                "couldn't move the previous Node.js at {} out of the way. If an agent is \
                 running on it, stop your agents and try again",
                dest.display()
            )
        })?;
    }
    if let Err(e) = std::fs::rename(new, dest) {
        if had_old {
            if let Err(restore) = std::fs::rename(&aside, dest) {
                tracing::error!(
                    "couldn't restore the previous Node.js from {}: {restore}",
                    aside.display()
                );
            }
        }
        return Err(e).with_context(|| format!("moving Node.js into {}", dest.display()));
    }
    if had_old {
        if let Err(e) = std::fs::remove_dir_all(&aside) {
            // Typically node.exe still running on Windows; swept on the next install.
            log(&format!(
                "! Couldn't delete the previous Node.js at {} ({e}); it will be removed next time.",
                aside.display()
            ));
        }
    }
    Ok(())
}

fn download_node(data_dir: &Path, log: &Log) -> anyhow::Result<()> {
    let (os, arch, ext) = node_platform()?;
    let agent = http();

    let version = NODE_VERSION;
    let name = format!("node-{version}-{os}-{arch}");
    let file = format!("{name}.{ext}");
    // Pinned in this binary, not read from the server that serves the archive.
    let expected = NODE_SHA256
        .iter()
        .find_map(|(f, h)| (*f == file).then_some(*h))
        .ok_or_else(|| anyhow!("no pinned checksum for {file}"))?
        .to_string();

    let runtime = runtime_dir(data_dir);
    // Unique per run so an abandoned download can't trample a newer one. Short, so
    // Node's deep node_modules paths stay under Windows' MAX_PATH. Deleted on drop.
    let staging = TempDir::create(runtime.join(format!(".s{}", short_id())))?;
    let archive = staging.path().join(&file);

    log(&format!("▸ Downloading Node.js {version} ({os}-{arch})…"));
    let resp = agent
        .get(&format!("{NODE_DIST}/{version}/{file}"))
        .call()
        .with_context(|| format!("downloading {file}"))?;
    let total: Option<u64> = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    let mut reader = resp.into_body().into_reader();
    let mut out = std::fs::File::create(&archive)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let (mut done, mut next_report) = (0u64, 10u64);
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        out.write_all(&buf[..n])?;
        done += n as u64;
        if let Some(total) = total.filter(|t| *t > 0) {
            let pct = done * 100 / total;
            if pct >= next_report {
                log(&format!(
                    "  {pct}%  ({:.1} / {:.1} MB)",
                    done as f64 / 1e6,
                    total as f64 / 1e6
                ));
                next_report = pct / 10 * 10 + 10;
            }
        }
    }
    out.flush()?;
    drop(out);

    let actual = hex_lower(&hasher.finalize());
    if actual != expected {
        bail!("checksum mismatch for {file} (expected {expected}, got {actual}); download aborted");
    }
    log("✓ Checksum verified (SHA-256)");

    log("▸ Unpacking…");
    let f = std::fs::File::open(&archive)?;
    if ext == "zip" {
        zip::ZipArchive::new(f)?.extract(staging.path())?;
    } else {
        tar::Archive::new(flate2::read::GzDecoder::new(f)).unpack(staging.path())?;
    }
    let home = managed_node_home(data_dir);
    replace_dir(&staging.path().join(&name), &home, &runtime, log)?;
    drop(staging);
    log(&format!(
        "✓ Node.js {version} installed in {}",
        home.display()
    ));
    Ok(())
}

/// npm packages to install for a provider (only what's missing).
fn packages_for(provider: Provider, data_dir: &Path) -> Vec<String> {
    let mut pkgs = Vec::new();
    match provider {
        Provider::Claude => {
            if providers::find_cli(Provider::Claude).is_none() {
                pkgs.push(format!(
                    "{}@{}",
                    providers::CLAUDE_CODE_PKG,
                    providers::CLAUDE_CODE_VERSION
                ));
            }
            // Missing, or not the pinned version: (re)install the pinned one.
            if !providers::claude_adapter_current(data_dir) {
                pkgs.push(format!(
                    "{}@{}",
                    providers::CLAUDE_ADAPTER_PKG,
                    providers::CLAUDE_ADAPTER_VERSION
                ));
            }
        }
        Provider::Codex => {
            if providers::find_cli(Provider::Codex).is_none() {
                pkgs.push(format!(
                    "{}@{}",
                    providers::CODEX_PKG,
                    providers::CODEX_VERSION
                ));
            }
        }
        Provider::Grok => {
            if providers::find_cli(Provider::Grok).is_none() {
                pkgs.push(format!(
                    "{}@{}",
                    providers::GROK_PKG,
                    providers::GROK_VERSION
                ));
            }
        }
        Provider::Custom => {}
        Provider::Local => return packages_for(Provider::Codex, data_dir),
    }
    pkgs
}

/// Whether anything is missing for this provider.
pub fn needs_install(provider: Provider, data_dir: &Path) -> bool {
    !packages_for(provider, data_dir).is_empty()
}

/// Packages whose own install script is needed and trusted: Claude Code and Grok
/// copy their native binary out of the platform optionalDependency in `postinstall`.
/// Everything else (Codex and the Claude adapter ship plain files or script-less
/// platform packages; Grok's only dependency, @iarna/toml, has no install script)
/// is installed with scripts disabled, and transitive scripts never run.
const SCRIPTED_PKGS: &[&str] = &[providers::CLAUDE_CODE_PKG, providers::GROK_PKG];

fn pkg_name(spec: &str) -> &str {
    match spec.rfind('@') {
        Some(i) if i > 0 => &spec[..i],
        _ => spec,
    }
}

/// Newer npm blocks dependency install scripts unless allow-listed in the project's
/// package.json; allow exactly the trusted packages being rebuilt (nothing else).
fn allow_install_scripts(prefix: &Path, names: &[&str]) -> anyhow::Result<()> {
    let path = prefix.join("package.json");
    let mut manifest: serde_json::Value = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    manifest["name"] = "armada-tools".into();
    manifest["private"] = true.into();
    manifest["allowScripts"] = serde_json::json!({});
    for name in names {
        manifest["allowScripts"][*name] = true.into();
    }
    std::fs::write(&path, serde_json::to_vec_pretty(&manifest)?)?;
    Ok(())
}

async fn npm_install(npm: &Npm, data_dir: &Path, pkgs: &[String], log: &Log) -> anyhow::Result<()> {
    let prefix = tools_dir(data_dir);
    std::fs::create_dir_all(&prefix)?;
    // Empty user config: a ~/.npmrc can't redirect the registry or inject auth/scripts.
    // Proxy settings still come from the HTTPS_PROXY/HTTP_PROXY environment.
    let userconfig = prefix.join(".armada-npmrc");
    std::fs::write(&userconfig, b"")?;
    let scripted: Vec<&str> = pkgs
        .iter()
        .map(|p| pkg_name(p))
        .filter(|n| SCRIPTED_PKGS.contains(n))
        .collect();
    allow_install_scripts(&prefix, &scripted)?;

    let common = |cmd: &mut tokio::process::Command| {
        cmd.arg(format!("--userconfig={}", userconfig.display()))
            .arg("--registry=https://registry.npmjs.org/")
            .args([
                "--no-fund",
                "--no-audit",
                "--update-notifier=false",
                "--loglevel=warn",
            ]);
    };
    let mut install = tokio::process::Command::new(&npm.program);
    install
        .args(&npm.args)
        .args(["install", "--prefix"])
        .arg(&prefix);
    common(&mut install);
    install.arg("--ignore-scripts").args(pkgs);
    run_npm(install, log).await?;

    // Run only the trusted packages' own install scripts, never transitive ones.
    if !scripted.is_empty() {
        let mut rebuild = tokio::process::Command::new(&npm.program);
        rebuild
            .args(&npm.args)
            .args(["rebuild", "--prefix"])
            .arg(&prefix);
        common(&mut rebuild);
        rebuild.arg("--foreground-scripts").args(&scripted);
        run_npm(rebuild, log).await?;
    }
    Ok(())
}

async fn run_npm(mut cmd: tokio::process::Command, log: &Log) -> anyhow::Result<()> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hidden(&mut cmd);
    // Own process group, so a timeout also stops the install scripts npm runs.
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().context("starting npm")?;
    let stdout = child.stdout.take().context("npm stdout")?;
    let stderr = child.stderr.take().context("npm stderr")?;
    // Lossy line reading: npm on Windows may print in the console code page.
    let l1 = log.clone();
    let out_task = tokio::spawn(async move {
        let _ =
            crate::jsonrpc::read_lines(stdout, 16 * 1024, |line| l1(&format!("  {line}"))).await;
    });
    let l2 = log.clone();
    let err_task = tokio::spawn(async move {
        let _ =
            crate::jsonrpc::read_lines(stderr, 16 * 1024, |line| l2(&format!("  {line}"))).await;
    });
    let status = match tokio::time::timeout(NPM_TIMEOUT, child.wait()).await {
        Ok(status) => status?,
        Err(_) => {
            kill_tree(&mut child).await;
            out_task.abort();
            err_task.abort();
            bail!(
                "npm install didn't finish within {} minutes and was stopped. Check your network connection and try again",
                NPM_TIMEOUT.as_secs() / 60
            );
        }
    };
    // A leftover grandchild may still hold the pipes; don't wait on it forever.
    let drain = async {
        let _ = tokio::join!(out_task, err_task);
    };
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), drain).await;
    if !status.success() {
        bail!("npm install failed ({status})");
    }
    Ok(())
}

/// How long `npm install` may run before it's stopped.
const NPM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Kills a child and everything it started.
async fn kill_tree(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY: plain syscall on the process group created at spawn.
        unsafe {
            libc::killpg(pid as libc::pid_t, libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let mut cmd = tokio::process::Command::new("taskkill");
        cmd.args(["/T", "/F", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hidden(&mut cmd);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(10), cmd.status()).await;
    }
    let _ = child.kill().await;
}

/// One install at a time: installs share the Node runtime dir and the npm prefix.
static INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Installs whatever this provider is missing and verifies the result.
pub async fn install(provider: Provider, data_dir: &Path, log: Log) -> anyhow::Result<()> {
    let _guard = lock_installs(&log).await;
    sweep_scratch(data_dir);
    install_unlocked(provider, data_dir, log).await
}

async fn lock_installs(log: &Log) -> tokio::sync::MutexGuard<'static, ()> {
    match INSTALL_LOCK.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            log("! Another install is running; waiting for it to finish…");
            INSTALL_LOCK.lock().await
        }
    }
}

async fn install_unlocked(provider: Provider, data_dir: &Path, log: Log) -> anyhow::Result<()> {
    let name = provider.display_name();
    let pkgs = packages_for(provider, data_dir);
    if pkgs.is_empty() {
        log(&format!("✓ {name} is already installed."));
        return Ok(());
    }
    log(&format!("Setting up {name}"));
    let npm = ensure_npm(data_dir, &log).await?;
    log(&format!("▸ Installing {}…", pkgs.join(", ")));
    npm_install(&npm, data_dir, &pkgs, &log).await?;

    let cli = providers::find_cli(provider).ok_or_else(|| {
        anyhow!(
            "{name} was installed but `{}` still can't be found",
            providers::cli_name(provider)
        )
    })?;
    let mut cmd = tokio::process::Command::new(&cli);
    cmd.arg("--version").stdin(Stdio::null());
    hidden(&mut cmd);
    let out = tokio::time::timeout(std::time::Duration::from_secs(120), cmd.output())
        .await
        .map_err(|_| anyhow!("`{} --version` timed out", cli.display()))??;
    if !out.status.success() {
        bail!(
            "{name} was installed but doesn't run: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let version = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if provider == Provider::Claude && !providers::claude_adapter_current(data_dir) {
        bail!(
            "The Claude ACP adapter didn't install correctly (expected version {}, found {})",
            providers::CLAUDE_ADAPTER_VERSION,
            providers::claude_adapter_version(data_dir).unwrap_or_else(|| "none".into())
        );
    }
    log(&format!("✓ {name} is ready ({version})"));
    Ok(())
}

/// Installs everything missing for all providers; keeps going past failures.
pub async fn install_missing(data_dir: &Path, log: Log) -> anyhow::Result<()> {
    let _guard = lock_installs(&log).await;
    sweep_scratch(data_dir);
    let mut failed = Vec::new();
    let mut any = false;
    for provider in Provider::ALL {
        if !needs_install(provider, data_dir) {
            continue;
        }
        any = true;
        if let Err(e) = install_unlocked(provider, data_dir, log.clone()).await {
            log(&format!("✗ {}: {e:#}", provider.display_name()));
            failed.push(provider.display_name());
        }
        log("");
    }
    if !any {
        log("✓ Everything is already installed.");
    }
    if failed.is_empty() {
        Ok(())
    } else {
        bail!("Some installs failed: {}", failed.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_matches_known_digest() {
        assert_eq!(
            hex_lower(&Sha256::digest(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn scratch_names() {
        assert!(is_scratch_name(".staging-0123456789abcdef"));
        assert!(is_scratch_name(".s1a2b3c4d"));
        assert!(is_scratch_name(".o1a2b3c4d"));
        assert!(!is_scratch_name("node"));
        assert!(!is_scratch_name(".settings"));
        assert!(!is_scratch_name(".s1a2b3c4"));
    }

    #[test]
    fn replace_dir_swaps_and_sweeps() {
        let data = std::env::temp_dir().join(format!("armada-tc-{}", short_id()));
        let runtime = runtime_dir(&data);
        let log: Log = Arc::new(|_| {});
        let home = managed_node_home(&data);
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("old"), "1").unwrap();
        {
            let staging = TempDir::create(runtime.join(format!(".s{}", short_id()))).unwrap();
            let new = staging.path().join("node-vX");
            std::fs::create_dir_all(&new).unwrap();
            std::fs::write(new.join("new"), "2").unwrap();
            replace_dir(&new, &home, &runtime, &log).unwrap();
            // A missing source leaves the current install in place.
            assert!(replace_dir(&staging.path().join("nope"), &home, &runtime, &log).is_err());
        }
        assert!(home.join("new").exists() && !home.join("old").exists());
        // Only `node` is left: the staging dir dropped, the old copy deleted.
        let names: Vec<String> = std::fs::read_dir(&runtime)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["node".to_string()]);
        // Leftovers from a crashed install are swept.
        std::fs::create_dir_all(runtime.join(".staging-abc")).unwrap();
        std::fs::create_dir_all(runtime.join(".s0000beef")).unwrap();
        sweep_scratch(&data);
        assert_eq!(std::fs::read_dir(&runtime).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&data);
    }
}
