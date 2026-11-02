//! Removes the login item the app registered under its old name.
//!
//! The launch-at-login entry is keyed on the product name ("Armada" before 0.3.0, now
//! "Kvistcode"), so after the rename the old entry stays behind and keeps starting the old
//! executable at login. On Windows that old copy would also take the single-instance lock
//! (the app id is unchanged) and win over the new one. The current entry is (re)created
//! from the saved "launch at login" setting by `apply_autostart`.

use tracing::{info, warn};

/// Name of the old login item (the product name it was registered under).
const LEGACY_NAME: &str = "Armada";

/// Deletes the old login item, if there is one that starts the old app.
pub fn remove_legacy() {
    #[cfg(target_os = "linux")]
    if let Some(home) = dirs::home_dir() {
        remove_legacy_file(
            &home
                .join(".config")
                .join("autostart")
                .join(format!("{LEGACY_NAME}.desktop")),
        );
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = dirs::home_dir() {
        remove_legacy_file(
            &home
                .join("Library")
                .join("LaunchAgents")
                .join(format!("{LEGACY_NAME}.plist")),
        );
    }
    #[cfg(windows)]
    remove_legacy_run_value();
}

/// Whether `entry` (a `.desktop` or launch-agent file, or a Run value) starts the old
/// Armada rather than something else that happens to share its name.
fn starts_legacy_app(entry: &str) -> bool {
    let entry = entry.to_ascii_lowercase();
    entry.contains("armada") && !entry.contains("kvistcode")
}

/// Deletes `path` when it is a login item for the old app.
#[cfg(unix)]
fn remove_legacy_file(path: &std::path::Path) -> bool {
    // Login items are tiny; never read something big that merely has the name.
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() > 64 * 1024 {
        return false;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    if !starts_legacy_app(&text) {
        return false;
    }
    match std::fs::remove_file(path) {
        Ok(()) => {
            info!(path = %path.display(), "removed the old Armada login item");
            true
        }
        Err(e) => {
            warn!(path = %path.display(), "could not remove the old Armada login item: {e}");
            false
        }
    }
}

#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

/// Deletes the `Armada` value under the per-user Run key when it starts `armada.exe`.
#[cfg(windows)]
fn remove_legacy_run_value() {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    // CREATE_NO_WINDOW: no console flash from a GUI app.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let reg = |args: &[&str]| {
        Command::new("reg")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    };
    // `reg query` fails when the value doesn't exist: the usual case.
    let Ok(out) = reg(&["query", RUN_KEY, "/v", LEGACY_NAME]) else {
        return;
    };
    if !out.status.success() || !starts_legacy_app(&String::from_utf8_lossy(&out.stdout)) {
        return;
    }
    match reg(&["delete", RUN_KEY, "/v", LEGACY_NAME, "/f"]) {
        Ok(out) if out.status.success() => info!("removed the old Armada login item"),
        Ok(out) => warn!(code = ?out.status.code(), "could not remove the old Armada login item"),
        Err(e) => warn!("could not remove the old Armada login item: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_the_old_app() {
        assert!(starts_legacy_app(
            "[Desktop Entry]\nExec=/usr/bin/armada --autostart\n"
        ));
        assert!(starts_legacy_app(
            r"    Armada    REG_SZ    C:\Users\me\AppData\Local\Armada\armada.exe  --autostart"
        ));
        assert!(!starts_legacy_app("Exec=/usr/bin/kvistcode --autostart"));
        assert!(!starts_legacy_app("Exec=/usr/bin/something-else"));
        // A Kvistcode started from a folder that still says armada is not the old app.
        assert!(!starts_legacy_app("Exec=/home/me/armada/target/kvistcode"));
    }

    /// A scratch folder that removes itself, even when the test fails.
    #[cfg(unix)]
    struct Scratch(std::path::PathBuf);

    #[cfg(unix)]
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn removes_only_the_old_apps_login_item() {
        let scratch =
            Scratch(std::env::temp_dir().join(format!("kvistcode-login-{}", uuid::Uuid::new_v4())));
        std::fs::create_dir_all(&scratch.0).unwrap();
        let dir = &scratch.0;
        let old = dir.join("Armada.desktop");
        std::fs::write(
            &old,
            "[Desktop Entry]\nName=Armada\nExec=/opt/armada/armada --autostart\n",
        )
        .unwrap();
        assert!(remove_legacy_file(&old));
        assert!(!old.exists());

        // Someone else's file that happens to be called Armada.desktop stays.
        let other = dir.join("Other.desktop");
        std::fs::write(&other, "[Desktop Entry]\nExec=/usr/bin/fleet-manager\n").unwrap();
        assert!(!remove_legacy_file(&other));
        assert!(other.exists());

        // Missing file and directories are left alone.
        assert!(!remove_legacy_file(&dir.join("missing.desktop")));
        assert!(!remove_legacy_file(dir));
    }
}
