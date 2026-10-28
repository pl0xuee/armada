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

fn hidden(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    #[cfg(not(windows))]
    let _ = cmd;
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

fn http() -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(std::time::Duration::from_secs(20)))
            .timeout_recv_response(Some(std::time::Duration::from_secs(60)))
            .timeout_recv_body(Some(std::time::Duration::from_secs(15 * 60)))
            .user_agent(concat!("Armada/", env!("CARGO_PKG_VERSION")))
            .build(),
    )
}

fn get_text(agent: &ureq::Agent, url: &str) -> anyhow::Result<String> {
    let mut resp = agent
        .get(url)
        .call()
        .with_context(|| format!("GET {url}"))?;
    resp.body_mut()
        .with_config()
        .limit(16 * 1024 * 1024)
        .read_to_string()
        .with_context(|| format!("reading {url}"))
}

fn download_node(data_dir: &Path, log: &Log) -> anyhow::Result<()> {
    let (os, arch, ext) = node_platform()?;
    let agent = http();

    log("▸ Looking up the current Node.js LTS release…");
    let index: serde_json::Value =
        serde_json::from_str(&get_text(&agent, &format!("{NODE_DIST}/index.json"))?)?;
    let version = index
        .as_array()
        .and_then(|a| a.iter().find(|r| r["lts"].is_string()))
        .and_then(|r| r["version"].as_str())
        .ok_or_else(|| anyhow!("couldn't find an LTS release in the Node.js index"))?
        .to_string();
    let name = format!("node-{version}-{os}-{arch}");
    let file = format!("{name}.{ext}");

    let sums = get_text(&agent, &format!("{NODE_DIST}/{version}/SHASUMS256.txt"))?;
    let expected = sums
        .lines()
        .find_map(|l| {
            let (hash, f) = l.split_once("  ")?;
            (f.trim() == file).then(|| hash.trim().to_lowercase())
        })
        .ok_or_else(|| anyhow!("{file} isn't listed in SHASUMS256.txt"))?;

    let runtime = runtime_dir(data_dir);
    // Unique per run so an abandoned download can't trample a newer one.
    let staging = runtime.join(format!(".staging-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&staging)?;
    let archive = staging.join(&file);

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

    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        let _ = std::fs::remove_dir_all(&staging);
        bail!("checksum mismatch for {file} (expected {expected}, got {actual}); download aborted");
    }
    log("✓ Checksum verified (SHA-256)");

    log("▸ Unpacking…");
    let f = std::fs::File::open(&archive)?;
    if ext == "zip" {
        zip::ZipArchive::new(f)?.extract(&staging)?;
    } else {
        tar::Archive::new(flate2::read::GzDecoder::new(f)).unpack(&staging)?;
    }
    let home = managed_node_home(data_dir);
    let _ = std::fs::remove_dir_all(&home);
    std::fs::rename(staging.join(&name), &home)
        .with_context(|| format!("moving Node.js into {}", home.display()))?;
    let _ = std::fs::remove_dir_all(&staging);
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
                pkgs.push("@anthropic-ai/claude-code@latest".into());
            }
            if providers::claude_adapter_entry(data_dir).is_none() {
                pkgs.push(format!(
                    "{}@{}",
                    providers::CLAUDE_ADAPTER_PKG,
                    providers::CLAUDE_ADAPTER_VERSION
                ));
            }
        }
        Provider::Codex => {
            if providers::find_cli(Provider::Codex).is_none() {
                pkgs.push("@openai/codex@latest".into());
            }
        }
        Provider::Grok => {
            if providers::find_cli(Provider::Grok).is_none() {
                pkgs.push("@xai-official/grok@latest".into());
            }
        }
        Provider::Custom => {}
    }
    pkgs
}

/// Whether anything is missing for this provider.
pub fn needs_install(provider: Provider, data_dir: &Path) -> bool {
    !packages_for(provider, data_dir).is_empty()
}

/// Newer npm blocks dependency install scripts unless they're allow-listed in the
/// project's package.json. Claude Code and Grok fetch their native binaries in
/// postinstall, so allow exactly the packages Armada installs (nothing else).
fn allow_install_scripts(prefix: &Path, pkgs: &[String]) -> anyhow::Result<()> {
    let path = prefix.join("package.json");
    let mut manifest: serde_json::Value = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    manifest["name"] = "armada-tools".into();
    manifest["private"] = true.into();
    if !manifest["allowScripts"].is_object() {
        manifest["allowScripts"] = serde_json::json!({});
    }
    for pkg in pkgs {
        let name = match pkg.rfind('@') {
            Some(i) if i > 0 => &pkg[..i],
            _ => pkg.as_str(),
        };
        manifest["allowScripts"][name] = true.into();
    }
    std::fs::write(&path, serde_json::to_vec_pretty(&manifest)?)?;
    Ok(())
}

async fn npm_install(npm: &Npm, data_dir: &Path, pkgs: &[String], log: &Log) -> anyhow::Result<()> {
    let prefix = tools_dir(data_dir);
    std::fs::create_dir_all(&prefix)?;
    allow_install_scripts(&prefix, pkgs)?;
    let mut cmd = tokio::process::Command::new(&npm.program);
    cmd.args(&npm.args)
        .args(["install", "--prefix"])
        .arg(&prefix)
        .args([
            "--no-fund",
            "--no-audit",
            "--update-notifier=false",
            "--loglevel=warn",
            "--foreground-scripts",
        ])
        .args(pkgs)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hidden(&mut cmd);
    let mut child = cmd.spawn().context("starting npm")?;
    let stdout = child.stdout.take().context("npm stdout")?;
    let stderr = child.stderr.take().context("npm stderr")?;
    // Lossy line reading: npm on Windows may print in the console code page.
    let l1 = log.clone();
    let out_task = tokio::spawn(async move {
        let _ = crate::jsonrpc::read_lines(stdout, |line| l1(&format!("  {line}"))).await;
    });
    let l2 = log.clone();
    let err_task = tokio::spawn(async move {
        let _ = crate::jsonrpc::read_lines(stderr, |line| l2(&format!("  {line}"))).await;
    });
    let status = child.wait().await?;
    let _ = tokio::join!(out_task, err_task);
    if !status.success() {
        bail!("npm install failed ({status})");
    }
    Ok(())
}

/// One install at a time: installs share the Node runtime dir and the npm prefix.
static INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Installs whatever this provider is missing and verifies the result.
pub async fn install(provider: Provider, data_dir: &Path, log: Log) -> anyhow::Result<()> {
    let _guard = lock_installs(&log).await;
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
    if provider == Provider::Claude && providers::claude_adapter_entry(data_dir).is_none() {
        bail!("The Claude ACP adapter didn't install correctly");
    }
    log(&format!("✓ {name} is ready ({version})"));
    Ok(())
}

/// Installs everything missing for all providers; keeps going past failures.
pub async fn install_missing(data_dir: &Path, log: Log) -> anyhow::Result<()> {
    let _guard = lock_installs(&log).await;
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
