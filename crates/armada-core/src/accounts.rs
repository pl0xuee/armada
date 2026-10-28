//! Account profiles: each non-system account gets its own config directory so
//! several logins per provider can coexist. API keys live in the OS keychain.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::Context;
use tokio::io::AsyncWriteExt;

use crate::model::{now_ms, Account, AccountStatus, AuthKind, Provider};
use crate::providers;

const KEYRING_SERVICE: &str = "dev.armada.app";

pub fn profile_dir(data_dir: &Path, account_id: &str) -> PathBuf {
    data_dir.join("profiles").join(account_id)
}

pub fn set_api_key(account_id: &str, key: &str) -> anyhow::Result<()> {
    keyring::Entry::new(KEYRING_SERVICE, account_id)?
        .set_password(key)
        .context("saving API key to the OS keychain")
}

pub fn get_api_key(account_id: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, account_id)
        .ok()?
        .get_password()
        .ok()
}

pub fn delete_api_key(account_id: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, account_id) {
        let _ = entry.delete_credential();
    }
}

/// Credential and config variables each provider CLI reads from the environment.
/// Armada's own environment (and so every child it spawns) may carry the user's
/// exported values; for a dedicated account they'd override its own login.
fn provider_env_vars(provider: Provider) -> &'static [&'static str] {
    match provider {
        Provider::Claude => &[
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
        ],
        Provider::Codex => &["OPENAI_API_KEY", "CODEX_HOME"],
        Provider::Grok => &["XAI_API_KEY", "GROK_HOME"],
        Provider::Custom => &[],
    }
}

/// Inherited environment variables to remove before starting a provider CLI for
/// this account (apply with `Command::env_remove` *before* `account_env`).
///
/// Dedicated (non-system) accounts are isolated from whatever the user exported:
/// an `ANTHROPIC_API_KEY` in the shell must not silently bill an OAuth account's
/// agents to that key. The system account is "whatever the CLI does by default",
/// which includes the user's own environment, so nothing is removed for it.
/// Custom agents keep their inherited environment.
pub fn env_to_remove(account: &Account) -> Vec<String> {
    if account.is_system {
        return Vec::new();
    }
    provider_env_vars(account.provider)
        .iter()
        .map(|v| v.to_string())
        .collect()
}

/// Environment variables that point a provider CLI at this account. Pair with
/// `env_to_remove` so inherited credentials can't take precedence.
pub fn account_env(account: &Account) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(dir) = account.config_dir.as_deref().filter(|_| !account.is_system) {
        let var = match account.provider {
            Provider::Claude => Some("CLAUDE_CONFIG_DIR"),
            Provider::Codex => Some("CODEX_HOME"),
            Provider::Grok => Some("GROK_HOME"),
            Provider::Custom => None,
        };
        if let Some(var) = var {
            env.push((var.to_string(), dir.to_string()));
        }
    }
    if account.auth_kind == AuthKind::ApiKey {
        if let Some(key) = get_api_key(&account.id) {
            match account.provider {
                Provider::Claude => env.push(("ANTHROPIC_API_KEY".into(), key)),
                Provider::Grok => env.push(("XAI_API_KEY".into(), key)),
                // Codex reads the key stored by `codex login --with-api-key` in CODEX_HOME.
                Provider::Codex => env.push(("OPENAI_API_KEY".into(), key)),
                Provider::Custom => {}
            }
        }
    }
    env
}

/// A helper command for a provider CLI running as `account`: inherited provider
/// credentials removed, then the account's own environment applied.
fn account_command(
    program: impl AsRef<std::ffi::OsStr>,
    account: &Account,
    env: Vec<(String, String)>,
) -> tokio::process::Command {
    let mut cmd = quiet_command(program);
    for var in env_to_remove(account) {
        cmd.env_remove(var);
    }
    cmd.envs(env);
    cmd
}

/// The provider's own interactive login command (run in a PTY by the shell).
/// Custom agents handle sign-in themselves.
pub fn login_command(provider: Provider) -> Option<(String, Vec<String>)> {
    match provider {
        Provider::Claude => Some(("claude".into(), vec!["auth".into(), "login".into()])),
        Provider::Codex => Some(("codex".into(), vec!["login".into()])),
        Provider::Grok => Some(("grok".into(), vec!["login".into()])),
        Provider::Custom => None,
    }
}

/// How long `codex login --with-api-key` may take before it's killed.
const CODEX_LOGIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Codex stores API keys in CODEX_HOME rather than reading them from the environment.
pub async fn codex_store_api_key(account: &Account, key: &str) -> anyhow::Result<()> {
    let cli = providers::find_cli(Provider::Codex).context("Codex CLI is not installed")?;
    // Only CODEX_HOME: the key itself goes over stdin, never through the environment.
    let env: Vec<(String, String)> = account_env(account)
        .into_iter()
        .filter(|(k, _)| k != "OPENAI_API_KEY")
        .collect();
    let mut child = account_command(cli, account, env)
        .args(["login", "--with-api-key"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("starting codex login")?;
    let mut stdin = child.stdin.take().context("codex stdin")?;
    let key = key.to_string();
    let run = async move {
        stdin.write_all(key.as_bytes()).await?;
        // Close stdin so codex sees the end of the key.
        drop(stdin);
        child.wait_with_output().await
    };
    // `kill_on_drop` stops codex if the timeout drops the future.
    let out = tokio::time::timeout(CODEX_LOGIN_TIMEOUT, run)
        .await
        .map_err(|_| anyhow::anyhow!("codex login --with-api-key timed out"))??;
    if !out.status.success() {
        anyhow::bail!(
            "codex login failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

/// A helper command: no console window on Windows, killed if it times out.
pub(crate) fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    crate::childenv::sanitize_child_env(&mut cmd);
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd
}

/// Runs a status command; returns (success, stdout, stderr).
async fn run(program: &str, args: &[&str], account: &Account) -> Option<(bool, String, String)> {
    let cli = which::which(program).ok()?;
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        account_command(cli, account, account_env(account))
            .args(args)
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    Some((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

/// Ask the provider CLI whether this account is signed in.
pub async fn check_status(account: &Account) -> AccountStatus {
    let mut status = AccountStatus {
        logged_in: false,
        label: None,
        email: None,
        plan: None,
        checked_at: now_ms(),
        error: None,
    };
    if account.auth_kind == AuthKind::ApiKey {
        status.logged_in = get_api_key(&account.id).is_some();
        status.label = Some("API key".into());
        if !status.logged_in {
            status.error = Some("No API key found in the OS keychain".into());
        }
        return status;
    }
    match account.provider {
        Provider::Custom => {
            status.logged_in = true;
            status.label = Some("Managed by each agent".into());
        }
        Provider::Claude => match run("claude", &["auth", "status", "--json"], account).await {
            Some((_, stdout, stderr)) => {
                // Parse the first JSON value on stdout; tolerate log lines around it.
                let json = stdout.find('{').and_then(|i| {
                    serde_json::Deserializer::from_str(&stdout[i..])
                        .into_iter::<serde_json::Value>()
                        .next()
                        .and_then(Result::ok)
                });
                let text = if stderr.trim().is_empty() {
                    stdout.clone()
                } else {
                    stderr
                };
                if let Some(v) = json {
                    status.logged_in = v["loggedIn"].as_bool().unwrap_or(false);
                    status.email = v["email"].as_str().map(str::to_string);
                    status.plan = v["subscriptionType"].as_str().map(str::to_string);
                    status.label = status.plan.as_deref().map(|p| match p {
                        "max" => "Claude Max".to_string(),
                        "pro" => "Claude Pro".to_string(),
                        other => format!("Claude {other}"),
                    });
                    if status.label.is_none() && status.logged_in {
                        status.label = v["authMethod"].as_str().map(str::to_string);
                    }
                } else {
                    status.error = Some(text.trim().to_string());
                }
            }
            None => status.error = Some("Claude Code is not installed".into()),
        },
        Provider::Codex => match run("codex", &["login", "status"], account).await {
            Some((ok, stdout, stderr)) => {
                let text = format!("{stdout}{stderr}");
                let t = text.trim();
                status.logged_in = ok && !t.to_lowercase().contains("not logged in");
                if status.logged_in {
                    status.label = Some(t.lines().next().unwrap_or("Signed in").trim().to_string());
                }
            }
            None => status.error = Some("Codex CLI is not installed".into()),
        },
        Provider::Grok => {
            let home = account
                .config_dir
                .clone()
                .filter(|_| !account.is_system)
                .map(PathBuf::from)
                .or_else(|| providers::home_dir().map(|h| h.join(".grok")));
            let auth = home.map(|h| h.join("auth.json"));
            match auth.and_then(|p| std::fs::read(p).ok()) {
                Some(bytes) => {
                    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
                    status.logged_in = !v.is_null();
                    status.email = find_str(&v, "email");
                    status.label = Some("Grok".into());
                }
                None => status.logged_in = false,
            }
        }
    }
    status
}

fn find_str(v: &serde_json::Value, key: &str) -> Option<String> {
    match v {
        serde_json::Value::Object(m) => m
            .get(key)
            .and_then(|x| x.as_str().map(str::to_string))
            .or_else(|| m.values().find_map(|x| find_str(x, key))),
        serde_json::Value::Array(a) => a.iter().find_map(|x| find_str(x, key)),
        _ => None,
    }
}
