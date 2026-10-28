//! Native clipboard image fallback. WebKitGTK on Wayland often exposes no image `File` in a
//! paste event (screenshots copied by grim/wl-copy, files copied in a file manager), so the
//! composer asks us to read the system clipboard directly. No-op on macOS/Windows, where the
//! webview handles image paste itself.

use armada_core::Attachment;
use serde::Serialize;

pub const MAX_IMAGES: usize = 8;
pub const MAX_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Default, Serialize)]
pub struct ClipboardImages {
    pub attachments: Vec<Attachment>,
    /// Human-readable reasons something on the clipboard wasn't attached.
    pub problems: Vec<String>,
}

#[tauri::command]
pub async fn read_clipboard_images() -> Result<ClipboardImages, String> {
    tauri::async_runtime::spawn_blocking(read_blocking)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
fn read_blocking() -> ClipboardImages {
    ClipboardImages::default()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn read_blocking() -> ClipboardImages {
    let mut out = ClipboardImages::default();
    let mut paths: Vec<std::path::PathBuf> = Vec::new();

    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        wayland(&mut out, &mut paths);
    }
    if out.attachments.is_empty() && paths.is_empty() {
        arboard_read(&mut out, &mut paths);
    }
    for p in paths {
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
fn wayland(out: &mut ClipboardImages, paths: &mut Vec<std::path::PathBuf>) {
    use std::process::Command;
    let Ok(list) = Command::new("wl-paste").arg("--list-types").output() else {
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
        if let Ok(o) = Command::new("wl-paste")
            .args(["--no-newline", "--type", mime])
            .output()
        {
            if o.status.success() && !o.stdout.is_empty() {
                push_image(out, mime, o.stdout);
                return;
            }
        }
    }
    for t in [
        "text/uri-list",
        "x-special/gnome-copied-files",
        "text/plain;charset=utf-8",
        "text/plain",
    ] {
        if has(t) {
            if let Ok(o) = Command::new("wl-paste")
                .args(["--no-newline", "--type", t])
                .output()
            {
                if o.status.success() {
                    paths.extend(parse_paths(&String::from_utf8_lossy(&o.stdout)));
                    if !paths.is_empty() {
                        return;
                    }
                }
            }
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn arboard_read(out: &mut ClipboardImages, paths: &mut Vec<std::path::PathBuf>) {
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
        paths.extend(parse_paths(&text));
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

/// Ok(None) = not an image file (silently skipped: it may just be copied text).
#[cfg(all(unix, not(target_os = "macos")))]
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
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return Ok(None),
    };
    let meta = std::fs::metadata(path).map_err(|_| format!("Couldn't read {name}"))?;
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > MAX_BYTES as u64 {
        return Err(format!("{name} is larger than 5 MB"));
    }
    let bytes = std::fs::read(path).map_err(|_| format!("Couldn't read {name}"))?;
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

    /// Reads the real clipboard (needs wl-copy). Run manually with `--ignored`.
    #[test]
    #[ignore]
    fn reads_real_clipboard() {
        let r = read_blocking();
        eprintln!(
            "{} attachments, problems {:?}",
            r.attachments.len(),
            r.problems
        );
        assert!(!r.attachments.is_empty());
    }
}
