//! "Copy diagnostics": a plain-text report for bug reports. Everything that goes in is
//! either non-sensitive by construction (versions, counts, flags) or has been through
//! [`scrub`]: the shared secret redactor plus a second pass for token-looking strings and
//! e-mail addresses. The home folder is shown as `~`. Account names/e-mails, prompts,
//! conversation text and project paths are left out entirely.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use armada_core::redact::redact_secrets;
use armada_core::{Agent, Core, Settings};
use tauri::State;
use tauri_plugin_opener::OpenerExt;

use crate::commands::CmdResult;
use crate::state::Shell;
use crate::AppHandle;

/// Largest report returned.
pub const MAX_REPORT_BYTES: usize = 200 * 1024;
const LOG_LINES: usize = 300;
const LOG_LINE_MAX: usize = 2000;
/// Bytes read from the end of one log file.
const LOG_TAIL_BYTES: u64 = 512 * 1024;
const LOG_PREFIX: &str = "armada.log";
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

// ---- scrubbing ------------------------------------------------------------------

/// Secrets, e-mail addresses and long token-like strings removed from `text`.
pub fn scrub(text: &str) -> String {
    let redacted = redact_secrets(text);
    let mut out = String::with_capacity(redacted.len());
    for (i, line) in redacted.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        scrub_line(line, &mut out);
    }
    out
}

fn is_tokenish(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '+' | '_' | '=' | '-')
}

fn is_email_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-' | '@')
}

fn scrub_line(line: &str, out: &mut String) {
    // Words separated by anything that can't be part of an e-mail address or a token.
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        if word.is_empty() {
            return;
        }
        out.push_str(&scrub_word(word));
        word.clear();
    };
    for c in line.chars() {
        if is_email_char(c) {
            word.push(c);
        } else {
            flush(&mut word, out);
            out.push(c);
        }
    }
    flush(&mut word, out);
}

fn scrub_word(word: &str) -> String {
    if let Some(at) = word.find('@') {
        let (local, domain) = (&word[..at], &word[at + 1..]);
        if !local.is_empty() && domain.contains('.') && !domain.starts_with('.') {
            return "[email]".into();
        }
    }
    // Sub-runs of base64/hex-looking characters of 32+ with a digit in them.
    let mut out = String::with_capacity(word.len());
    let mut run = String::new();
    let flush_run = |run: &mut String, out: &mut String| {
        let secret = run.chars().count() >= 32 && run.chars().any(|c| c.is_ascii_digit());
        if secret {
            out.push_str("[token]");
        } else {
            out.push_str(run);
        }
        run.clear();
    };
    for c in word.chars() {
        if is_tokenish(c) {
            run.push(c);
        } else {
            flush_run(&mut run, &mut out);
            out.push(c);
        }
    }
    flush_run(&mut run, &mut out);
    out
}

/// `home` replaced by `~` (also its forward-slash form on Windows).
pub fn tilde(text: &str, home: Option<&Path>) -> String {
    let Some(home) = home else {
        return text.to_string();
    };
    let h = home.to_string_lossy();
    let h = h.trim_end_matches(['/', '\\']);
    if h.len() < 2 {
        return text.to_string();
    }
    let mut out = text.replace(h, "~");
    let slashed = h.replace('\\', "/");
    if slashed != h {
        out = out.replace(&slashed, "~");
    }
    out
}

/// Keeps the last `max` bytes of `s`, cut at a line start when possible.
fn tail_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    match s[start..].find('\n') {
        Some(nl) => &s[start + nl + 1..],
        None => &s[start..],
    }
}

// ---- report pieces --------------------------------------------------------------

/// Settings as JSON with free-form, path-like and credential-bearing fields reduced to
/// counts or set/unset markers, then scrubbed.
pub fn settings_section(settings: &Settings) -> String {
    let mut v = serde_json::to_value(settings).unwrap_or(serde_json::Value::Null);
    if let Some(o) = v.as_object_mut() {
        if let Some(url) = o.get_mut("ntfyUrl") {
            // The topic in a push URL is the only thing protecting it.
            *url = if url.is_null() {
                "unset".into()
            } else {
                "set (hidden)".into()
            };
        }
        for key in ["templates", "mcpServers", "customAgents", "recentProjects"] {
            if let Some(slot) = o.get_mut(key) {
                let n = slot.as_array().map_or(0, Vec::len);
                *slot = format!("{n} configured (hidden)").into();
            }
        }
        if let Some(va) = o.get_mut("voiceAssistant").and_then(|x| x.as_object_mut()) {
            va.remove("accountId");
        }
        if let Some(voice) = o.get_mut("voice").and_then(|x| x.as_object_mut()) {
            voice.remove("inputDevice");
        }
        o.remove("helperDefaults");
        o.remove("configDefaults");
    }
    scrub(&serde_json::to_string_pretty(&v).unwrap_or_default())
}

fn count_by<T: Ord + Clone>(
    items: impl Iterator<Item = T>,
) -> std::collections::BTreeMap<T, usize> {
    let mut m = std::collections::BTreeMap::new();
    for i in items {
        *m.entry(i).or_insert(0) += 1;
    }
    m
}

fn fmt_counts<T: std::fmt::Display>(m: &std::collections::BTreeMap<T, usize>) -> String {
    if m.is_empty() {
        return "none".into();
    }
    m.iter()
        .map(|(k, n)| format!("{k} {n}"))
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn agents_section(agents: &[Agent]) -> String {
    let by_provider = count_by(agents.iter().map(|a| a.provider.as_str().to_string()));
    let by_status = count_by(agents.iter().map(|a| a.status.as_str().to_string()));
    let projects: std::collections::BTreeSet<&str> =
        agents.iter().map(|a| a.project_path.as_str()).collect();
    let mut s = String::new();
    let _ = writeln!(s, "total: {}", agents.len());
    let _ = writeln!(s, "by provider: {}", fmt_counts(&by_provider));
    let _ = writeln!(s, "by status: {}", fmt_counts(&by_status));
    let _ = writeln!(
        s,
        "running {}, worktree {}, archived {}, rate limited {}, distinct projects {}",
        agents.iter().filter(|a| a.running).count(),
        agents.iter().filter(|a| a.worktree).count(),
        agents.iter().filter(|a| a.archived).count(),
        agents.iter().filter(|a| a.rate_limited).count(),
        projects.len()
    );
    s
}

async fn probe(program: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = tokio::process::Command::new(program);
    armada_core::childenv::sanitize_child_env(&mut cmd);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("NO_COLOR", "1");
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: don't flash console windows from a GUI app.
        cmd.creation_flags(0x0800_0000);
    }
    let out = tokio::time::timeout(PROBE_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .next()
        .map(|l| l.trim().chars().take(120).collect())
}

async fn tools_section(data_dir: &Path) -> String {
    let mut s = String::new();
    let node = armada_core::toolchain::usable_node(data_dir).await;
    let mut entries: Vec<(&str, Option<PathBuf>, Vec<&str>)> = vec![
        ("node", node, vec!["--version"]),
        ("git", which::which("git").ok(), vec!["--version"]),
        ("git-lfs", which::which("git-lfs").ok(), vec!["version"]),
        ("gh", which::which("gh").ok(), vec!["--version"]),
    ];
    for (name, path, args) in entries.drain(..) {
        match path {
            None => {
                let _ = writeln!(s, "{name}: not found");
            }
            Some(p) => {
                let v = probe(&p, &args)
                    .await
                    .unwrap_or_else(|| "version unknown".into());
                let _ = writeln!(s, "{name}: {v} ({})", p.display());
            }
        }
    }
    s
}

fn dir_size(root: &Path) -> (u64, bool) {
    const MAX_ENTRIES: usize = 200_000;
    let (mut total, mut seen) = (0u64, 0usize);
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            seen += 1;
            if seen > MAX_ENTRIES {
                return (total, true);
            }
            let Ok(t) = e.file_type() else { continue };
            if t.is_symlink() {
                continue;
            }
            if t.is_dir() {
                stack.push(e.path());
            } else if let Ok(m) = e.metadata() {
                total += m.len();
            }
        }
    }
    (total, false)
}

fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let (mut v, mut u) = (n as f64, 0);
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[u])
    }
}

#[cfg(target_os = "linux")]
fn total_ram() -> Option<u64> {
    let s = std::fs::read_to_string("/proc/meminfo").ok()?;
    let kb = s
        .lines()
        .find_map(|l| l.strip_prefix("MemTotal:"))?
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?;
    Some(kb * 1024)
}

#[cfg(not(target_os = "linux"))]
fn total_ram() -> Option<u64> {
    None
}

#[cfg(target_os = "linux")]
fn kernel() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .ok()
        .map(|s| s.trim().to_string())
}

#[cfg(not(target_os = "linux"))]
fn kernel() -> Option<String> {
    None
}

#[cfg(target_os = "linux")]
fn os_name() -> Option<String> {
    let s = std::fs::read_to_string("/etc/os-release").ok()?;
    s.lines()
        .find_map(|l| l.strip_prefix("PRETTY_NAME="))
        .map(|v| v.trim_matches('"').to_string())
}

#[cfg(not(target_os = "linux"))]
fn os_name() -> Option<String> {
    None
}

fn env_nonempty(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

fn system_section(app_version: &str, data_dir: &Path) -> String {
    let mut s = String::new();
    let sha = option_env!("ARMADA_GIT_SHA").unwrap_or("unknown");
    let _ = writeln!(
        s,
        "Armada {app_version} ({}, git {sha})",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    );
    let _ = writeln!(
        s,
        "OS: {} {} {}",
        std::env::consts::OS,
        os_name().unwrap_or_default(),
        std::env::consts::ARCH
    );
    if let Some(k) = kernel() {
        let _ = writeln!(s, "Kernel: {k}");
    }
    if cfg!(target_os = "linux") {
        let session = env_nonempty("XDG_SESSION_TYPE").unwrap_or_else(|| {
            if env_nonempty("WAYLAND_DISPLAY").is_some() {
                "wayland".into()
            } else if env_nonempty("DISPLAY").is_some() {
                "x11".into()
            } else {
                "unknown".into()
            }
        });
        let desktop = env_nonempty("XDG_CURRENT_DESKTOP").unwrap_or_else(|| "unknown".into());
        let _ = writeln!(
            s,
            "Session: {session}, desktop {desktop}, AppImage {}",
            if env_nonempty("APPIMAGE").is_some() {
                "yes"
            } else {
                "no"
            }
        );
    }
    let webview = tauri::webview_version().unwrap_or_else(|_| "unknown".into());
    let engine = if cfg!(target_os = "windows") {
        "WebView2"
    } else if cfg!(target_os = "macos") {
        "WKWebView"
    } else {
        "WebKitGTK"
    };
    let _ = writeln!(s, "{engine}: {webview}");
    let cpus = std::thread::available_parallelism().map_or(0, |n| n.get());
    let ram = total_ram().map_or("unknown".into(), human_bytes);
    let _ = writeln!(s, "CPU threads: {cpus}, RAM: {ram}");
    let (size, partial) = dir_size(data_dir);
    let _ = writeln!(
        s,
        "Data dir: {} ({}{})",
        data_dir.display(),
        human_bytes(size),
        if partial { "+, partial" } else { "" }
    );
    s
}

/// The last `LOG_LINES` lines across Armada's own daily log files, scrubbed.
pub fn log_section(log_dir: &Path) -> String {
    let Ok(rd) = std::fs::read_dir(log_dir) else {
        return "(no log files)".into();
    };
    let mut files: Vec<PathBuf> = rd
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(LOG_PREFIX))
        .map(|e| e.path())
        .collect();
    files.sort();
    let mut lines: Vec<String> = Vec::new();
    for path in files.iter().rev() {
        let text = read_tail(path);
        let mut chunk: Vec<String> = text
            .lines()
            .map(|l| l.chars().take(LOG_LINE_MAX).collect())
            .collect();
        chunk.extend(lines);
        lines = chunk;
        if lines.len() >= LOG_LINES {
            break;
        }
    }
    if lines.len() > LOG_LINES {
        lines.drain(..lines.len() - LOG_LINES);
    }
    if lines.is_empty() {
        return "(log is empty)".into();
    }
    scrub(&lines.join("\n"))
}

fn read_tail(path: &Path) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map_or(0, |m| m.len());
    let skipped = len > LOG_TAIL_BYTES;
    if skipped && f.seek(SeekFrom::Start(len - LOG_TAIL_BYTES)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    let _ = f.take(LOG_TAIL_BYTES).read_to_end(&mut buf);
    let s = String::from_utf8_lossy(&buf).into_owned();
    if skipped {
        // The first line is probably cut in half.
        s.split_once('\n')
            .map_or(String::new(), |(_, rest)| rest.to_string())
    } else {
        s
    }
}

/// Everything the report is made of, already collected.
pub struct Inputs<'a> {
    pub system: String,
    pub providers: String,
    pub tools: String,
    pub accounts: String,
    pub agents: &'a [Agent],
    pub settings: &'a Settings,
    pub log: String,
    pub home: Option<PathBuf>,
}

/// Assembles the report and enforces the size cap (the log is what gets trimmed).
pub fn render(i: &Inputs) -> String {
    let mut head = String::new();
    let _ = writeln!(head, "# Armada diagnostics\n");
    let _ = writeln!(
        head,
        "Secrets, e-mail addresses and tokens are removed; home folder shown as ~.\n"
    );
    let _ = writeln!(head, "## System\n{}", scrub_keep_versions(&i.system));
    let _ = writeln!(head, "## Agent CLIs\n{}", i.providers);
    let _ = writeln!(head, "## Tools\n{}", i.tools);
    let _ = writeln!(head, "## Accounts\n{}", i.accounts);
    let _ = writeln!(head, "## Agents\n{}", agents_section(i.agents));
    let _ = writeln!(
        head,
        "## Settings\n```json\n{}\n```\n",
        settings_section(i.settings)
    );
    let head = tilde(&head, i.home.as_deref());
    let log = tilde(&i.log, i.home.as_deref());
    let title = "## Log (most recent lines)\n```\n";
    let tail = "\n```\n";
    let budget = MAX_REPORT_BYTES
        .saturating_sub(head.len() + title.len() + tail.len())
        .min(MAX_REPORT_BYTES);
    let mut out = head;
    if out.len() > MAX_REPORT_BYTES {
        out = tail_bytes(&out, MAX_REPORT_BYTES - 64).to_string();
        out.insert_str(0, "[report start truncated]\n");
        return out;
    }
    out.push_str(title);
    let log = tail_bytes(&log, budget);
    out.push_str(log);
    out.push_str(tail);
    out
}

/// System info is ours (versions, paths); only drop anything credential-shaped.
fn scrub_keep_versions(s: &str) -> String {
    redact_secrets(s).into_owned()
}

fn accounts_section(core: &Core) -> String {
    let accounts = core.accounts().unwrap_or_default();
    let by_kind = count_by(
        accounts
            .iter()
            .map(|a| format!("{}/{:?}", a.provider.as_str(), a.auth_kind)),
    );
    let logged_in = accounts
        .iter()
        .filter(|a| a.status.as_ref().is_some_and(|s| s.logged_in))
        .count();
    format!(
        "total: {}, logged in: {logged_in}\nby provider/kind: {}\n",
        accounts.len(),
        fmt_counts(&by_kind)
    )
}

async fn providers_section(shell: &Shell) -> String {
    let mut s = String::new();
    for p in shell.providers().await {
        let _ = writeln!(
            s,
            "{}: {}{}{}{}",
            p.cli_name,
            if p.installed { "installed" } else { "missing" },
            p.version.map(|v| format!(" {v}")).unwrap_or_default(),
            if p.adapter_required {
                if p.adapter_installed {
                    ", adapter ok"
                } else {
                    ", adapter missing"
                }
            } else {
                ""
            },
            p.path.map(|x| format!(" ({x})")).unwrap_or_default(),
        );
    }
    if s.is_empty() {
        s.push_str("none detected\n");
    }
    s
}

async fn build(app: &AppHandle, core: &Core, shell: &Shell) -> CmdResult<String> {
    let version = app.package_info().version.to_string();
    let agents = core.agents().map_err(|e| e.to_string())?;
    let settings = core.settings().map_err(|e| e.to_string())?;
    let data_dir = shell.data_dir.clone();
    let dd = data_dir.clone();
    let (system, log) = tokio::task::spawn_blocking(move || {
        (system_section(&version, &dd), log_section(&dd.join("logs")))
    })
    .await
    .map_err(|e| e.to_string())?;
    let inputs = Inputs {
        system,
        providers: providers_section(shell).await,
        tools: tools_section(&data_dir).await,
        accounts: accounts_section(core),
        agents: &agents,
        settings: &settings,
        log,
        home: armada_core::providers::home_dir(),
    };
    Ok(render(&inputs))
}

/// The diagnostics report, ready to paste into a bug report.
#[tauri::command]
pub async fn diagnostics(
    app: AppHandle,
    core: State<'_, Core>,
    shell: State<'_, Shell>,
) -> CmdResult<String> {
    build(&app, &core, &shell).await
}

/// Writes the report to the Downloads folder (or the data dir), reveals it and returns
/// its path.
#[tauri::command]
pub async fn save_diagnostics(
    app: AppHandle,
    core: State<'_, Core>,
    shell: State<'_, Shell>,
) -> CmdResult<String> {
    let report = build(&app, &core, &shell).await?;
    let dir = dirs::download_dir()
        .filter(|d| d.is_dir())
        .unwrap_or_else(|| shell.data_dir.clone());
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let path = dir.join(format!("armada-diagnostics-{stamp}.txt"));
    std::fs::write(&path, report).map_err(|e| format!("Couldn't write {}: {e}", path.display()))?;
    let _ = app.opener().reveal_item_in_dir(&path);
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRETS: &[&str] = &[
        "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd",
        "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "password=hunter2hunter2",
        "alice.example@gmail.com",
        "AbCdEf0123456789AbCdEf0123456789AbCdEf01",
        "https://user:p4ssw0rd@example.com/x",
    ];

    fn assert_clean(text: &str) {
        for s in SECRETS {
            assert!(!text.contains(s), "leaked {s}");
        }
        assert!(!text.contains("p4ssw0rd") && !text.contains("hunter2hunter2"));
        assert!(!text.contains("my-private-topic"));
    }

    fn planted_settings() -> Settings {
        Settings {
            ntfy_url: Some("https://ntfy.sh/my-private-topic-xyz".into()),
            recent_projects: vec!["/home/zed/secret-project".into()],
            global_hotkey: "password=hunter2hunter2".into(),
            theme: "alice.example@gmail.com".into(),
            default_permission_mode: "AbCdEf0123456789AbCdEf0123456789AbCdEf01".into(),
            failover: "https://user:p4ssw0rd@example.com/x".into(),
            ..Settings::default()
        }
    }

    #[test]
    fn scrub_removes_tokens_emails_and_credentials() {
        let text = SECRETS.join("\nnoise ");
        let out = scrub(&text);
        assert_clean(&out);
        assert!(out.contains("noise"));
    }

    #[test]
    fn scrub_keeps_ordinary_text() {
        let t = "INFO armada: agent started in 12 ms (pid 4411) path=/tmp/x/y";
        assert_eq!(scrub(t), t);
    }

    #[test]
    fn settings_hide_planted_values() {
        let out = settings_section(&planted_settings());
        assert_clean(&out);
        assert!(!out.contains("secret-project"));
        assert!(out.contains("ntfyUrl"));
    }

    #[test]
    fn home_becomes_tilde() {
        let out = tilde(
            "at /home/zed/work and /home/zed",
            Some(Path::new("/home/zed")),
        );
        assert_eq!(out, "at ~/work and ~");
        assert_eq!(tilde("/x", Some(Path::new("/"))), "/x");
    }

    #[test]
    fn report_is_clean_tilded_and_capped() {
        let dir = std::env::temp_dir().join(format!("armada-diag-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut log = String::new();
        for i in 0..2000 {
            log.push_str(&format!(
                "INFO line {i} /home/zed/proj token={}\n",
                SECRETS[0]
            ));
        }
        log.push_str(&format!(
            "WARN mail {} {} {}\n",
            SECRETS[3], SECRETS[4], SECRETS[5]
        ));
        std::fs::write(dir.join("armada.log.2026-01-01"), &log).unwrap();
        let log_text = log_section(&dir);
        assert!(log_text.lines().count() <= LOG_LINES);
        assert_clean(&log_text);
        let _ = std::fs::remove_dir_all(&dir);

        let settings = planted_settings();
        let big = "x ".repeat(400 * 1024);
        let inputs = Inputs {
            system: "Armada 1.0\nData dir: /home/zed/.local/share/x (1 MB)".into(),
            providers: String::new(),
            tools: String::new(),
            accounts: String::new(),
            agents: &[],
            settings: &settings,
            log: format!("{log_text}\n{big}"),
            home: Some(PathBuf::from("/home/zed")),
        };
        let out = render(&inputs);
        assert!(out.len() <= MAX_REPORT_BYTES, "{}", out.len());
        assert_clean(&out);
        assert!(!out.contains("/home/zed"));
        assert!(out.contains("~/.local/share/x"));
    }
}
