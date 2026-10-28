//! Update checks against GitHub Releases.
//!
//! Where the app can replace itself (Windows, macOS, Linux AppImage) we use Tauri's
//! updater: it reads `latest.json` from the latest release and verifies the download
//! against the public key in tauri.conf.json before installing. Elsewhere (deb/rpm
//! installs, or if the updater manifest is missing) we ask the GitHub Releases API
//! for the latest version and point the user at the release page.

use std::time::Duration;

use anyhow::{anyhow, Context};
use armada_core::{ArmadaEvent, Core, UpdateInfo};
use parking_lot::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;
use tracing::{error, info, warn};

const REPO: &str = "pl0xuee/armada";
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(15);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Last version we told the UI about, so background checks don't repeat themselves.
#[derive(Default)]
pub struct UpdateState {
    notified: Mutex<Option<String>>,
}

fn releases_page() -> String {
    format!("https://github.com/{REPO}/releases/latest")
}

/// Whether this install can update itself in place.
fn can_self_update() -> bool {
    if cfg!(target_os = "linux") {
        // Only AppImages can be swapped in place; deb/rpm belong to the package manager.
        std::env::var_os("APPIMAGE").is_some()
    } else {
        cfg!(any(target_os = "windows", target_os = "macos"))
    }
}

fn parse_version(v: &str) -> Option<(u64, u64, u64, bool)> {
    let v = v.trim().trim_start_matches('v');
    let (core, pre) = match v.split_once('-') {
        Some((c, _)) => (c, true),
        None => (v, false),
    };
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    Some((
        parts.next()??,
        parts.next().flatten().unwrap_or(0),
        parts.next().flatten().unwrap_or(0),
        pre,
    ))
}

/// `candidate` > `current`, treating a prerelease as older than its release.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some((a, b, c, pa)), Some((x, y, z, px))) => {
            (a, b, c) > (x, y, z) || ((a, b, c) == (x, y, z) && px && !pa)
        }
        _ => false,
    }
}

struct GithubRelease {
    version: String,
    notes: Option<String>,
    date: Option<String>,
    url: String,
}

fn github_latest() -> anyhow::Result<GithubRelease> {
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(20)))
            .build(),
    );
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let mut resp = agent
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", concat!("Armada/", env!("CARGO_PKG_VERSION")))
        .call()
        .context("asking GitHub for the latest release")?;
    let body: serde_json::Value = serde_json::from_str(&resp.body_mut().read_to_string()?)?;
    let tag = body["tag_name"]
        .as_str()
        .ok_or_else(|| anyhow!("GitHub returned no release tag"))?;
    Ok(GithubRelease {
        version: tag.trim_start_matches('v').to_string(),
        notes: body["body"]
            .as_str()
            .map(str::to_string)
            .filter(|s| !s.trim().is_empty()),
        date: body["published_at"].as_str().map(str::to_string),
        url: body["html_url"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(releases_page),
    })
}

/// Returns the newer release, if there is one.
pub async fn check(app: &AppHandle) -> anyhow::Result<Option<UpdateInfo>> {
    let current = app.package_info().version.to_string();
    let github = tauri::async_runtime::spawn_blocking(github_latest)
        .await
        .map_err(|e| anyhow!("{e}"))?;

    if can_self_update() {
        match app.updater()?.check().await {
            Ok(Some(update)) => {
                let gh = github.as_ref().ok();
                return Ok(Some(UpdateInfo {
                    current_version: current,
                    version: update.version.clone(),
                    notes: update
                        .body
                        .clone()
                        .or_else(|| gh.and_then(|g| g.notes.clone())),
                    date: update
                        .date
                        .map(|d| d.to_string())
                        .or_else(|| gh.and_then(|g| g.date.clone())),
                    url: gh.map(|g| g.url.clone()).unwrap_or_else(releases_page),
                    can_install: true,
                }));
            }
            Ok(None) => return Ok(None),
            // e.g. a release without updater artifacts: fall back to the API below.
            Err(e) => warn!("updater check failed, falling back to the GitHub API: {e}"),
        }
    }

    let gh = github?;
    if !is_newer(&gh.version, &current) {
        return Ok(None);
    }
    Ok(Some(UpdateInfo {
        current_version: current,
        version: gh.version,
        notes: gh.notes,
        date: gh.date,
        url: gh.url,
        can_install: false,
    }))
}

/// Downloads and verifies the update, shuts Armada down cleanly, installs, restarts.
///
/// The download happens while everything is still running (a failed download leaves
/// the app untouched). Shutdown must come *before* `install`: on Windows the updater
/// launches the NSIS installer and exits the process from inside `install`, so nothing
/// after it would run there.
pub async fn install(app: &AppHandle) -> anyhow::Result<()> {
    if !can_self_update() {
        anyhow::bail!(
            "This copy of Armada was installed by your package manager. Download the new version from {}",
            releases_page()
        );
    }
    let update = app
        .updater()?
        .check()
        .await?
        .ok_or_else(|| anyhow!("Armada is already up to date"))?;
    info!(version = %update.version, "downloading update");
    let progress_core = app.state::<Core>().inner().clone();
    let mut downloaded: u64 = 0;
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                progress_core.emit(ArmadaEvent::UpdateProgress { downloaded, total });
            },
            || info!("update downloaded"),
        )
        .await
        .context("downloading the update")?;

    // Record busy agents as interrupted (so they resume after the restart), end PTYs
    // and stop the remote server before the binary is replaced.
    crate::shutdown_services(app).await;

    info!(version = %update.version, "installing update");
    let installed = tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|e| anyhow!("{e}"))
        .and_then(|r| r.context("installing the update"));
    if let Err(e) = installed {
        // The core is already shut down, so the app can't carry on as is: restart the
        // current version (agents resume from the interrupted state).
        error!("update failed, restarting the current version: {e:#}");
    }
    app.restart();
}

/// Checks shortly after launch and then every few hours, when enabled.
pub fn spawn_background_checks(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            let enabled = app
                .state::<Core>()
                .settings()
                .map(|s| s.auto_check_updates)
                .unwrap_or(true);
            if enabled {
                match check(&app).await {
                    Ok(Some(update)) => {
                        let state = app.state::<UpdateState>();
                        let mut notified = state.notified.lock();
                        if notified.as_deref() != Some(update.version.as_str()) {
                            info!(version = %update.version, "update available");
                            *notified = Some(update.version.clone());
                            app.state::<Core>()
                                .emit(ArmadaEvent::UpdateAvailable { update });
                        }
                    }
                    Ok(None) => {}
                    Err(e) => warn!("update check failed: {e:#}"),
                }
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn version_ordering() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(is_newer("v1.0.0", "0.9.9"));
        assert!(is_newer("0.1.1", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.0.9", "0.1.0"));
        assert!(is_newer("0.2.0", "0.2.0-beta.1"));
        assert!(!is_newer("0.2.0-beta.1", "0.2.0"));
        assert!(!is_newer("garbage", "0.1.0"));
    }
}
