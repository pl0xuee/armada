//! Environment hygiene for processes Armada starts.
//!
//! An AppImage runs Armada with its own bundled libraries and data on
//! `LD_LIBRARY_PATH`, `PATH`, `XDG_DATA_DIRS` and friends. Children inherit
//! them, which breaks the system's git, node, curl and xdg-open. When
//! `APPIMAGE` is set, these helpers strip the AppImage's additions; otherwise
//! they do nothing.

use std::ffi::OsString;

/// Variables an AppImage runtime (or its AppRun) sets for Armada itself only.
const APPIMAGE_VARS: &[&str] = &[
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
    "GSETTINGS_SCHEMA_DIR",
    "PYTHONHOME",
    "PYTHONPATH",
    "PERLLIB",
    "QT_PLUGIN_PATH",
];

/// Variable name prefixes set by AppRun for bundled GTK/GLib.
const APPIMAGE_PREFIXES: &[&str] = &["GIO_", "GDK_PIXBUF_", "GTK_", "GST_"];

/// Pre-launch values saved by some AppImage runtimes as `APPIMAGE_ORIGINAL_<NAME>`.
const ORIGINAL_PREFIX: &str = "APPIMAGE_ORIGINAL_";

/// Where the AppImage runtime mounts the image.
const MOUNT_PREFIX: &str = "/tmp/.mount_";

/// Path-list variables whose `$APPDIR` entries are removed (the rest is kept).
const PATH_LISTS: &[&str] = &[
    "PATH",
    "LD_LIBRARY_PATH",
    "XDG_DATA_DIRS",
    "PERL5LIB",
    "XDG_CONFIG_DIRS",
];

/// What to change in a child's environment: `(name, None)` removes the variable,
/// `(name, Some(value))` sets it. Pure, for testing.
pub fn appimage_env_changes(
    vars: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, Option<OsString>)> {
    let vars: Vec<(OsString, OsString)> = vars.into_iter().collect();
    let get = |name: &str| vars.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
    if get("APPIMAGE").is_none() && get("APPDIR").is_none() {
        return Vec::new();
    }
    let appdir = get("APPDIR")
        .map(|d| d.to_string_lossy().trim_end_matches('/').to_string())
        .filter(|d| !d.is_empty());
    let mut changes = Vec::new();
    // Values from before the AppImage launched win over any filtering.
    let mut restored: Vec<String> = Vec::new();
    for (name, value) in &vars {
        let key = name.to_string_lossy();
        if let Some(orig) = key.strip_prefix(ORIGINAL_PREFIX) {
            restored.push(orig.to_string());
            changes.push((name.clone(), None));
            changes.push((
                OsString::from(orig),
                (!value.is_empty()).then(|| value.clone()),
            ));
        }
    }
    for (name, value) in &vars {
        let key = name.to_string_lossy();
        if key.starts_with(ORIGINAL_PREFIX) || restored.iter().any(|r| r == key.as_ref()) {
            continue;
        }
        if APPIMAGE_VARS.contains(&key.as_ref())
            || APPIMAGE_PREFIXES.iter().any(|p| key.starts_with(p))
        {
            changes.push((name.clone(), None));
            continue;
        }
        if !PATH_LISTS.contains(&key.as_ref()) {
            continue;
        }
        let inside = |p: &std::path::Path| {
            let s = p.to_string_lossy();
            s.starts_with(MOUNT_PREFIX)
                || appdir.as_ref().is_some_and(|appdir| {
                    s == appdir.as_str() || s.starts_with(&format!("{appdir}/"))
                })
        };
        let entries: Vec<std::path::PathBuf> = std::env::split_paths(value).collect();
        let kept: Vec<&std::path::PathBuf> = entries.iter().filter(|p| !inside(p)).collect();
        if kept.len() == entries.len() {
            continue;
        }
        if kept.iter().all(|p| p.as_os_str().is_empty()) {
            changes.push((name.clone(), None));
        } else {
            let joined = std::env::join_paths(kept).unwrap_or_else(|_| value.clone());
            changes.push((name.clone(), Some(joined)));
        }
    }
    changes
}

fn changes() -> Vec<(OsString, Option<OsString>)> {
    appimage_env_changes(std::env::vars_os())
}

/// Removes the AppImage's environment from a child (no-op outside an AppImage).
/// Call before applying the child's own variables.
pub fn sanitize_child_env(cmd: &mut tokio::process::Command) {
    for (name, value) in changes() {
        match value {
            Some(v) => cmd.env(name, v),
            None => cmd.env_remove(name),
        };
    }
}

/// `sanitize_child_env` for `std::process::Command`.
pub fn sanitize_std_command(cmd: &mut std::process::Command) {
    for (name, value) in changes() {
        match value {
            Some(v) => cmd.env(name, v),
            None => cmd.env_remove(name),
        };
    }
}

/// Launchers that are `.cmd` shims on Windows (npm installs them that way).
const CMD_SHIMS: &[&str] = &["npx", "npm", "pnpm", "yarn", "uvx", "bunx"];

/// Whether `command` has to go through `cmd /c` on Windows: Node and most agent
/// SDKs spawn without a shell, which can't run `.cmd`/`.bat` files. `resolved`
/// is what a PATH lookup found for it, if anything. Pure, for testing.
pub fn needs_cmd_shell(command: &str, resolved: Option<&std::path::Path>) -> bool {
    let is_script = |p: &std::path::Path| {
        p.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
    };
    if resolved.is_some_and(is_script) || is_script(std::path::Path::new(command)) {
        return true;
    }
    let path = std::path::Path::new(command);
    path.extension().is_none()
        && path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| CMD_SHIMS.iter().any(|s| n.eq_ignore_ascii_case(s)))
}

/// `command args…` wrapped as `cmd /d /c command args…`.
pub fn wrap_in_cmd(command: &str, args: &[String]) -> (String, Vec<String>) {
    let mut all = vec!["/d".to_string(), "/c".to_string(), command.to_string()];
    all.extend(args.iter().cloned());
    ("cmd".to_string(), all)
}

/// How an agent should launch an MCP server's `command`: unchanged everywhere
/// except Windows, where `.cmd` launchers (npx, npm, …) run through `cmd /c`.
pub fn mcp_launch(command: &str, args: &[String]) -> (String, Vec<String>) {
    if cfg!(windows) {
        let resolved = which::which(command).ok();
        if needs_cmd_shell(command, resolved.as_deref()) {
            return wrap_in_cmd(command, args);
        }
    }
    (command.to_string(), args.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmd_shims_go_through_cmd() {
        use std::path::Path;
        assert!(needs_cmd_shell("npx", None));
        assert!(needs_cmd_shell("NPX", None));
        assert!(needs_cmd_shell(
            "mytool",
            Some(Path::new(r"C:\Users\u\AppData\Roaming\npm\mytool.cmd"))
        ));
        assert!(needs_cmd_shell("run.BAT", None));
        assert!(!needs_cmd_shell("npx.exe", None));
        assert!(!needs_cmd_shell(
            "node",
            Some(Path::new(r"C:\node\node.exe"))
        ));
        assert!(!needs_cmd_shell("python", None));
        let (cmd, args) = wrap_in_cmd("npx", &["-y".into(), "server".into()]);
        assert_eq!(cmd, "cmd");
        assert_eq!(args, ["/d", "/c", "npx", "-y", "server"]);
        if !cfg!(windows) {
            assert_eq!(
                mcp_launch("npx", &["-y".into()]),
                ("npx".to_string(), vec!["-y".to_string()])
            );
        }
    }

    fn vars(list: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        list.iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    #[test]
    fn no_op_outside_an_appimage() {
        let v = vars(&[("PATH", "/tmp/.mount_x/usr/bin:/usr/bin")]);
        assert!(appimage_env_changes(v).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn keeps_system_library_path_entries() {
        let v = vars(&[
            ("APPDIR", "/tmp/.mount_ArmadaX"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_ArmadaX/usr/lib:/opt/lib"),
            ("GST_PLUGIN_PATH", "/tmp/.mount_ArmadaX/gst"),
        ]);
        let c = appimage_env_changes(v);
        assert!(c.contains(&("LD_LIBRARY_PATH".into(), Some("/opt/lib".into()))));
        assert!(c.contains(&("GST_PLUGIN_PATH".into(), None)));
    }

    #[cfg(unix)]
    #[test]
    fn restores_original_values() {
        let v = vars(&[
            ("APPIMAGE", "/x.AppImage"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_a/usr/lib"),
            ("APPIMAGE_ORIGINAL_LD_LIBRARY_PATH", "/opt/orig"),
        ]);
        let c = appimage_env_changes(v);
        assert!(c.contains(&("LD_LIBRARY_PATH".into(), Some("/opt/orig".into()))));
        assert!(c.contains(&("APPIMAGE_ORIGINAL_LD_LIBRARY_PATH".into(), None)));
    }

    #[cfg(unix)]
    #[test]
    fn strips_appimage_additions() {
        let v = vars(&[
            ("APPIMAGE", "/home/u/Armada.AppImage"),
            ("APPDIR", "/tmp/.mount_abc"),
            ("ARGV0", "Armada"),
            ("GTK_PATH", "/tmp/.mount_abc/usr/lib/gtk"),
            ("GIO_MODULE_DIR", "/tmp/.mount_abc/x"),
            ("PATH", "/tmp/.mount_abc/usr/bin:/usr/local/bin:/usr/bin"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_abc/usr/lib"),
            ("XDG_DATA_DIRS", "/tmp/.mount_abc/usr/share:/usr/share"),
            ("HOME", "/home/u"),
            ("PATHEXT", "/tmp/.mount_abc"),
        ]);
        let mut changes = appimage_env_changes(v);
        changes.sort();
        let shown: Vec<(String, Option<String>)> = changes
            .into_iter()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert_eq!(
            shown,
            [
                ("APPDIR".into(), None),
                ("APPIMAGE".into(), None),
                ("ARGV0".into(), None),
                ("GIO_MODULE_DIR".into(), None),
                ("GTK_PATH".into(), None),
                ("LD_LIBRARY_PATH".into(), None),
                ("PATH".into(), Some("/usr/local/bin:/usr/bin".into())),
                ("XDG_DATA_DIRS".into(), Some("/usr/share".into())),
            ]
        );
    }
}
