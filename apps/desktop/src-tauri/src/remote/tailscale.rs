//! Tailscale Serve: publishes the loopback-only remote server to the user's tailnet as
//! `https://<machine>.<tailnet>.ts.net:<port>`, so a phone running Tailscale reaches
//! Armada from anywhere without opening a port on the LAN or the firewall. Tailscale
//! terminates TLS with a real certificate and only lets the tailnet's own devices in;
//! Armada still requires pairing. Driven through the `tailscale` CLI.

use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::process::Output;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TailscaleState {
    Checking,
    NotInstalled,
    /// Installed, but the daemon isn't running or this computer isn't logged in.
    NotConnected,
    /// Linux: the CLI may only change Serve as root or the configured operator.
    NeedsOperator,
    /// The tailnet hasn't turned on HTTPS certificates (Serve needs them).
    NeedsHttps,
    On,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleStatus {
    pub state: TailscaleState,
    /// `https://machine.tailnet.ts.net:port` while `On`.
    pub url: Option<String>,
    /// What's wrong, for the states the user has to fix.
    pub message: Option<String>,
    /// A command that fixes it.
    pub command: Option<String>,
    /// A page that fixes it.
    pub link: Option<String>,
}

impl TailscaleStatus {
    pub fn checking() -> Self {
        Self::problem(TailscaleState::Checking, "", None, None)
    }

    fn problem(
        state: TailscaleState,
        message: &str,
        command: Option<&str>,
        link: Option<&str>,
    ) -> Self {
        TailscaleStatus {
            state,
            url: None,
            message: (!message.is_empty()).then(|| message.to_string()),
            command: command.map(str::to_string),
            link: link.map(str::to_string),
        }
    }
}

const DOWNLOAD: &str = "https://tailscale.com/download";
const ADMIN_DNS: &str = "https://login.tailscale.com/admin/dns";

/// The `tailscale` CLI: on PATH, or where the macOS and Windows apps install it (apps
/// started from the dock or Start menu don't get the shell's PATH).
fn cli() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "tailscale.exe"
    } else {
        "tailscale"
    };
    let on_path = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|dir| dir.join(name));
    let known: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "/opt/homebrew/bin/tailscale",
            "/usr/local/bin/tailscale",
        ]
    } else if cfg!(windows) {
        &[r"C:\Program Files\Tailscale\tailscale.exe"]
    } else {
        &[
            "/usr/bin/tailscale",
            "/usr/local/bin/tailscale",
            "/usr/sbin/tailscale",
        ]
    };
    on_path
        .chain(known.iter().map(PathBuf::from))
        .find(|p| p.is_file())
}

async fn run(cli: &PathBuf, args: &[&str], timeout: Duration) -> Result<Output, String> {
    let mut cmd = tokio::process::Command::new(cli);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash
    match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(out)) => Ok(out),
        Ok(Err(e)) => Err(format!("Couldn't run tailscale: {e}")),
        Err(_) => Err("Tailscale didn't answer in time.".into()),
    }
}

fn not_connected() -> TailscaleStatus {
    let (message, command) = if cfg!(target_os = "linux") {
        (
            "Tailscale is installed but not connected on this computer. Start it and sign in (the --operator part lets Armada manage Serve without sudo):",
            Some("sudo systemctl enable --now tailscaled && sudo tailscale up --operator=$USER"),
        )
    } else {
        (
            "Tailscale is installed but not connected. Open the Tailscale app on this computer and sign in.",
            None,
        )
    };
    TailscaleStatus::problem(TailscaleState::NotConnected, message, command, None)
}

/// This machine's tailnet DNS name, once Tailscale is up and can issue certificates.
async fn node(cli: &PathBuf) -> Result<String, TailscaleStatus> {
    let out = run(cli, &["status", "--json"], Duration::from_secs(5))
        .await
        .map_err(|e| TailscaleStatus::problem(TailscaleState::Error, &e, None, None))?;
    // `status --json` still prints JSON when logged out; it fails when the daemon is down.
    let json: Value = serde_json::from_slice(&out.stdout).map_err(|_| not_connected())?;
    parse_node(&json)
}

fn parse_node(json: &Value) -> Result<String, TailscaleStatus> {
    if json["BackendState"].as_str() != Some("Running") {
        let mut status = not_connected();
        if let Some(url) = json["AuthURL"]
            .as_str()
            .filter(|u| u.starts_with("https://"))
        {
            status.link = Some(url.to_string());
        }
        return Err(status);
    }
    let name = json["Self"]["DNSName"]
        .as_str()
        .unwrap_or("")
        .trim_end_matches('.');
    let https = json["CertDomains"]
        .as_array()
        .is_some_and(|d| !d.is_empty());
    if name.is_empty() || !https {
        return Err(TailscaleStatus::problem(
            TailscaleState::NeedsHttps,
            "Turn on MagicDNS and HTTPS Certificates on the DNS page of the Tailscale admin console (Tailscale Serve needs them), then check again.",
            None,
            Some(ADMIN_DNS),
        ));
    }
    Ok(name.to_string())
}

/// Whether the Serve config (`tailscale serve status --json`) proxies `port` to Armada.
fn serves(json: &Value, port: u16) -> bool {
    let target = format!("http://127.0.0.1:{port}");
    let suffix = format!(":{port}");
    json["Web"].as_object().is_some_and(|web| {
        web.iter().any(|(host_port, cfg)| {
            host_port.ends_with(&suffix)
                && cfg["Handlers"]["/"]["Proxy"].as_str() == Some(target.as_str())
        })
    })
}

fn url_for(name: &str, port: u16) -> String {
    if port == 443 {
        format!("https://{name}")
    } else {
        format!("https://{name}:{port}")
    }
}

/// Publishes `http://127.0.0.1:<port>` at `https://<machine>:<port>` on the tailnet
/// (a no-op when it already is), or says what the user has to fix first.
pub async fn serve(port: u16) -> TailscaleStatus {
    let Some(cli) = cli() else {
        return TailscaleStatus::problem(
            TailscaleState::NotInstalled,
            "Install Tailscale on this computer and on your phone, and sign both in to the same account.",
            None,
            Some(DOWNLOAD),
        );
    };
    let name = match node(&cli).await {
        Ok(name) => name,
        Err(status) => return status,
    };
    let on = TailscaleStatus {
        url: Some(url_for(&name, port)),
        ..TailscaleStatus::problem(TailscaleState::On, "", None, None)
    };
    if let Ok(out) = run(&cli, &["serve", "status", "--json"], Duration::from_secs(5)).await {
        if serde_json::from_slice::<Value>(&out.stdout).is_ok_and(|j| serves(&j, port)) {
            return on;
        }
    }
    let https = format!("--https={port}");
    let target = format!("http://127.0.0.1:{port}");
    let args = ["serve", "--bg", "--yes", https.as_str(), target.as_str()];
    match run(&cli, &args, Duration::from_secs(20)).await {
        Ok(out) if out.status.success() => on,
        Ok(out) => serve_failed(&String::from_utf8_lossy(&out.stderr)),
        Err(e) => TailscaleStatus::problem(TailscaleState::Error, &e, None, None),
    }
}

fn serve_failed(stderr: &str) -> TailscaleStatus {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("access denied") || lower.contains("serve config denied") {
        return TailscaleStatus::problem(
            TailscaleState::NeedsOperator,
            "Tailscale only lets its operator change Serve. Allow your user once, then check again:",
            Some("sudo tailscale set --operator=$USER"),
            None,
        );
    }
    if lower.contains("https") && (lower.contains("enable") || lower.contains("certificate")) {
        return TailscaleStatus::problem(
            TailscaleState::NeedsHttps,
            "Turn on HTTPS Certificates on the DNS page of the Tailscale admin console, then check again.",
            None,
            Some(ADMIN_DNS),
        );
    }
    let detail = stderr
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("unknown error");
    TailscaleStatus::problem(
        TailscaleState::Error,
        &format!("Tailscale couldn't share Armada: {detail}"),
        None,
        None,
    )
}

/// Stops publishing `port` (best effort: Armada is going away or changing modes).
pub async fn unserve(port: u16) {
    let Some(cli) = cli() else { return };
    let https = format!("--https={port}");
    if let Err(e) = run(
        &cli,
        &["serve", https.as_str(), "off"],
        Duration::from_secs(5),
    )
    .await
    {
        tracing::warn!("couldn't turn off Tailscale Serve on port {port}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn node_states() {
        let up = json!({
            "BackendState": "Running",
            "Self": { "DNSName": "armada-pc.tail1234.ts.net." },
            "CertDomains": ["armada-pc.tail1234.ts.net"],
        });
        assert_eq!(parse_node(&up).unwrap(), "armada-pc.tail1234.ts.net");

        let login =
            json!({ "BackendState": "NeedsLogin", "AuthURL": "https://login.tailscale.com/a/abc" });
        let status = parse_node(&login).unwrap_err();
        assert_eq!(status.state, TailscaleState::NotConnected);
        assert_eq!(
            status.link.as_deref(),
            Some("https://login.tailscale.com/a/abc")
        );
        assert_eq!(
            parse_node(&json!({ "BackendState": "Stopped" }))
                .unwrap_err()
                .state,
            TailscaleState::NotConnected
        );

        let no_certs = json!({ "BackendState": "Running", "Self": { "DNSName": "pc.tail1234.ts.net." }, "CertDomains": null });
        assert_eq!(
            parse_node(&no_certs).unwrap_err().state,
            TailscaleState::NeedsHttps
        );
    }

    #[test]
    fn serve_config_and_urls() {
        let cfg = json!({
            "TCP": { "47821": { "HTTPS": true } },
            "Web": { "armada-pc.tail1234.ts.net:47821": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:47821" } } } },
        });
        assert!(serves(&cfg, 47821));
        assert!(!serves(&cfg, 47822));
        let other = json!({ "Web": { "pc.ts.net:47821": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:3000" } } } } });
        assert!(!serves(&other, 47821));
        assert!(!serves(&json!({}), 47821));

        assert_eq!(
            url_for("pc.tail1234.ts.net", 47821),
            "https://pc.tail1234.ts.net:47821"
        );
        assert_eq!(
            url_for("pc.tail1234.ts.net", 443),
            "https://pc.tail1234.ts.net"
        );
    }

    #[test]
    fn serve_errors() {
        let denied = serve_failed(
            "Access denied: serve config denied\n\nUse 'sudo tailscale serve --bg ...'.",
        );
        assert_eq!(denied.state, TailscaleState::NeedsOperator);
        assert_eq!(
            denied.command.as_deref(),
            Some("sudo tailscale set --operator=$USER")
        );
        let other = serve_failed("error: something odd\n");
        assert_eq!(other.state, TailscaleState::Error);
        assert!(other.message.unwrap().ends_with("something odd"));
    }
}
