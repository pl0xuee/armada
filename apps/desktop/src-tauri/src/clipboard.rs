//! Native clipboard image fallback. WebKitGTK on Wayland often exposes no image `File` in a
//! paste event (screenshots copied by grim/wl-copy, files copied in a file manager), so the
//! composer asks us to read the system clipboard directly. No-op on macOS/Windows, where the
//! webview handles image paste itself.

use armada_core::Attachment;
use serde::Serialize;

// Only the Linux reader uses these (macOS/Windows are a no-op).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const MAX_IMAGES: usize = 8;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const MAX_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Default, Serialize)]
pub struct ClipboardImages {
    pub attachments: Vec<Attachment>,
    /// Human-readable reasons something on the clipboard wasn't attached.
    pub problems: Vec<String>,
}

#[tauri::command]
pub async fn read_clipboard_images(
    core: tauri::State<'_, armada_core::Core>,
    agent_id: Option<String>,
) -> Result<ClipboardImages, String> {
    // Paths found in clipboard *text* are only trusted inside the agent's project.
    let root = agent_id
        .and_then(|id| core.agent(&id).ok())
        .map(|a| std::path::PathBuf::from(a.cwd));
    tauri::async_runtime::spawn_blocking(move || read_blocking(root))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
fn read_blocking(_root: Option<std::path::PathBuf>) -> ClipboardImages {
    ClipboardImages::default()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn read_blocking(root: Option<std::path::PathBuf>) -> ClipboardImages {
    let mut out = ClipboardImages::default();
    let mut paths: Vec<ClipPath> = Vec::new();

    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        wayland(&mut out, &mut paths);
    }
    if out.attachments.is_empty() && paths.is_empty() {
        arboard_read(&mut out, &mut paths);
    }
    for p in paths {
        // Text that merely looks like a path is only followed inside the project;
        // without an agent context it is ignored.
        if p.from_text && !root.as_deref().is_some_and(|r| inside(&p.path, r)) {
            continue;
        }
        let p = p.path;
        if out.attachments.len() >= MAX_IMAGES {
            out.problems.push(format!(
                "Only {MAX_IMAGES} images per message; the rest weren't attached"
            ));
            break;
        }
        match file_attachment(&p) {
            Ok(Some(a)) => out.attachments.push(a),
            Ok(None) => {}
            Err(msg) => out.problems.push(msg),
        }
    }
    out
}

/// A path found on the clipboard. `from_text` paths came from plain text (anything
/// could have put them there); the rest are real file copies from a file manager.
#[cfg(all(unix, not(target_os = "macos")))]
struct ClipPath {
    path: std::path::PathBuf,
    from_text: bool,
}

#[cfg(all(unix, not(target_os = "macos")))]
fn clip_paths(text: &str, from_text: bool) -> impl Iterator<Item = ClipPath> + '_ {
    parse_paths(text)
        .into_iter()
        .map(move |path| ClipPath { path, from_text })
}

/// Is `path` (resolved) inside directory `root` (resolved)?
#[cfg(any(all(unix, not(target_os = "macos")), test))]
fn inside(path: &std::path::Path, root: &std::path::Path) -> bool {
    match (path.canonicalize(), root.canonicalize()) {
        (Ok(p), Ok(r)) => p.starts_with(r),
        _ => false,
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn push_image(out: &mut ClipboardImages, mime: &str, bytes: Vec<u8>) {
    use base64::Engine as _;
    if bytes.len() > MAX_BYTES {
        out.problems
            .push("Clipboard image is larger than 5 MB".into());
        return;
    }
    let ext = mime.trim_start_matches("image/");
    out.attachments.push(Attachment {
        name: format!("pasted-image.{ext}"),
        mime_type: mime.to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    });
}

#[cfg(all(unix, not(target_os = "macos")))]
fn wayland(out: &mut ClipboardImages, paths: &mut Vec<ClipPath>) {
    fn wl_paste() -> std::process::Command {
        let mut cmd = std::process::Command::new("wl-paste");
        armada_core::childenv::sanitize_std_command(&mut cmd);
        cmd
    }
    let Ok(list) = wl_paste().arg("--list-types").output() else {
        return;
    };
    if !list.status.success() {
        return;
    }
    let types = String::from_utf8_lossy(&list.stdout).to_string();
    let has = |t: &str| types.lines().any(|l| l.trim() == t);
    if let Some(mime) = ["image/png", "image/jpeg", "image/webp", "image/gif"]
        .into_iter()
        .find(|m| has(m))
    {
        if let Ok(o) = wl_paste().args(["--no-newline", "--type", mime]).output() {
            if o.status.success() && !o.stdout.is_empty() {
                push_image(out, mime, o.stdout);
                return;
            }
        }
    }
    for (t, from_text) in [
        ("text/uri-list", false),
        ("x-special/gnome-copied-files", false),
        ("text/plain;charset=utf-8", true),
        ("text/plain", true),
    ] {
        if has(t) {
            if let Ok(o) = wl_paste().args(["--no-newline", "--type", t]).output() {
                if o.status.success() {
                    paths.extend(clip_paths(&String::from_utf8_lossy(&o.stdout), from_text));
                    if !paths.is_empty() {
                        return;
                    }
                }
            }
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn arboard_read(out: &mut ClipboardImages, paths: &mut Vec<ClipPath>) {
    let Ok(mut cb) = arboard::Clipboard::new() else {
        return;
    };
    if let Ok(img) = cb.get_image() {
        match encode_png(img.width as u32, img.height as u32, &img.bytes) {
            Some(png) => push_image(out, "image/png", png),
            None => out
                .problems
                .push("Couldn't encode the clipboard image".into()),
        }
        return;
    }
    if let Ok(text) = cb.get_text() {
        paths.extend(clip_paths(&text, true));
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut buf = Vec::new();
    let mut enc = png::Encoder::new(&mut buf, w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().ok()?.write_image_data(rgba).ok()?;
    Some(buf)
}

/// File paths from a `text/uri-list`, GNOME copied-files or plain-text clipboard. Only
/// `file://` URIs and absolute paths are accepted; everything else is ignored.
#[cfg(any(all(unix, not(target_os = "macos")), test))]
fn parse_paths(text: &str) -> Vec<std::path::PathBuf> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#') && *l != "copy" && *l != "cut")
        .filter_map(|l| {
            if let Some(rest) = l.strip_prefix("file://") {
                // Drop an optional "localhost" authority.
                let rest = rest.strip_prefix("localhost").unwrap_or(rest);
                rest.starts_with('/')
                    .then(|| std::path::PathBuf::from(percent_decode(rest)))
            } else if l.starts_with('/') {
                Some(std::path::PathBuf::from(l))
            } else {
                None
            }
        })
        .collect()
}

#[cfg(any(all(unix, not(target_os = "macos")), test))]
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// MIME type from the file's leading bytes (PNG, JPEG, GIF, WebP), not its name.
#[cfg(any(all(unix, not(target_os = "macos")), test))]
fn sniff_image(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Ok(None) = not an image file (silently skipped: it may just be copied text).
/// Symlinks are refused and the contents must really be an image.
#[cfg(any(all(unix, not(target_os = "macos")), test))]
fn file_attachment(path: &std::path::Path) -> Result<Option<Attachment>, String> {
    use base64::Engine as _;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
        return Ok(None);
    }
    let meta = std::fs::symlink_metadata(path).map_err(|_| format!("Couldn't read {name}"))?;
    if meta.file_type().is_symlink() {
        return Err(format!("{name} is a link; copy the image itself"));
    }
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > MAX_BYTES as u64 {
        return Err(format!("{name} is larger than 5 MB"));
    }
    let bytes = std::fs::read(path).map_err(|_| format!("Couldn't read {name}"))?;
    let Some(mime) = sniff_image(&bytes) else {
        return Err(format!("{name} isn't a PNG, JPEG, GIF or WebP image"));
    };
    Ok(Some(Attachment {
        name,
        mime_type: mime.into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_uri_lists() {
        let p = parse_paths("# c\r\nfile:///tmp/a%20b.png\r\nfile://localhost/x.jpg\nhttp://x/y.png\n/abs/z.gif\nhello");
        let p: Vec<_> = p.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        assert_eq!(p, ["/tmp/a b.png", "/x.jpg", "/abs/z.gif"]);
        assert_eq!(parse_paths("copy\nfile:///a.png").len(), 1);
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("armada-clip-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n0000";

    #[test]
    fn sniffs_magic_bytes() {
        assert_eq!(sniff_image(PNG), Some("image/png"));
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff_image(b"GIF89a.."), Some("image/gif"));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image(b"SECRET=hunter2"), None);
    }

    #[test]
    fn rejects_fake_images_and_symlinks() {
        let d = scratch("files");
        std::fs::write(d.join("ok.png"), PNG).unwrap();
        std::fs::write(d.join("fake.png"), b"API_KEY=abc").unwrap();
        assert!(file_attachment(&d.join("ok.png")).unwrap().is_some());
        assert!(file_attachment(&d.join("fake.png")).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(d.join("ok.png"), d.join("link.png")).unwrap();
            assert!(file_attachment(&d.join("link.png")).is_err());
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn text_paths_must_be_inside_the_project() {
        let d = scratch("root");
        let other = scratch("other");
        std::fs::write(d.join("a.png"), PNG).unwrap();
        std::fs::write(other.join("b.png"), PNG).unwrap();
        assert!(inside(&d.join("a.png"), &d));
        assert!(!inside(&other.join("b.png"), &d));
        assert!(!inside(&d.join("../escape.png"), &d));
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&other);
    }

    /// Reads the real clipboard (needs wl-copy). Run manually with `--ignored`.
    #[test]
    #[ignore]
    fn reads_real_clipboard() {
        let r = read_blocking(None);
        eprintln!(
            "{} attachments, problems {:?}",
            r.attachments.len(),
            r.problems
        );
        assert!(!r.attachments.is_empty());
    }
}
