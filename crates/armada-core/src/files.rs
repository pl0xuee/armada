//! Project file listing + fuzzy matching for @-mentions in the composer.

use std::path::{Path, PathBuf};

use crate::model::Attachment;

/// Largest image Armada will load or keep inline (raw bytes / base64 chars).
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_IMAGE_BASE64: usize = (MAX_IMAGE_BYTES as usize).div_ceil(3) * 4;
pub const MAX_IMAGES_PER_ITEM: usize = 8;
/// Pictures an agent can add to its replies in one turn (each is its own item).
pub const MAX_MESSAGE_PICTURES_PER_TURN: usize = 24;

/// MIME type for raster image files we display (SVG is excluded on purpose).
pub fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => return None,
    })
}

/// Reads an image file for display (regular file, known image type, size-capped).
pub fn read_image_file(path: &Path) -> anyhow::Result<Attachment> {
    use base64::Engine;
    use std::io::Read;
    let mime = image_mime(path).ok_or_else(|| anyhow::anyhow!("not an image file"))?;
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        anyhow::bail!("not a regular file");
    }
    if meta.len() > MAX_IMAGE_BYTES {
        anyhow::bail!("image is larger than 10 MB");
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    std::fs::File::open(path)?
        .take(MAX_IMAGE_BYTES)
        .read_to_end(&mut bytes)?;
    Ok(Attachment {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        mime_type: mime.to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}
use std::process::{Command, Stdio};

const MAX_FILES: usize = 50_000;
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".idea",
    ".gradle",
    "Pods",
];

/// How long `git ls-files` may take before falling back to walking the folder.
const LS_FILES_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// `git ls-files` output, or None if git isn't usable here or took too long.
fn git_ls_files(root: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut cmd = Command::new("git");
    crate::childenv::sanitize_std_command(&mut cmd);
    cmd.args([
        // A configured fsmonitor daemon would be started (and left running) by this.
        "-c",
        "core.fsmonitor=false",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
    ])
    .current_dir(root)
    .env("GIT_TERMINAL_PROMPT", "0")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    // Read on a thread so a huge listing can't fill the pipe while we wait.
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let deadline = std::time::Instant::now() + LS_FILES_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                tracing::warn!("git ls-files in {} timed out", root.display());
                return None;
            }
        }
    };
    let out = reader.join().ok()?;
    status.success().then_some(out)
}

/// Relative paths of the files in `root`. Uses git (respects .gitignore) when it can.
pub fn project_files(root: &Path) -> anyhow::Result<Vec<String>> {
    if let Some(out) = git_ls_files(root) {
        let mut files: Vec<String> = out
            .split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect();
        // Sorted before truncating, so a huge repo keeps a stable, predictable subset.
        files.sort();
        files.dedup();
        files.truncate(MAX_FILES);
        return Ok(files);
    }
    let mut files = Vec::new();
    walk(root, root, 0, &mut files);
    files.sort();
    Ok(files)
}

/// The local path a `file://` URI names (`file:///x`, `file://localhost/x`,
/// `file:///C:/x`, `file://server/share/x` on Windows), percent-decoded. None if `s`
/// isn't a file URI.
/// A path that names another machine (`\\server\share\x.png`, `//server/x.png`, or a
/// verbatim `\\?\` form). Opening one makes Windows contact that machine, so agent-given
/// image paths of this shape are refused before touching the filesystem.
pub fn is_network_path(path: &str) -> bool {
    let p = path.trim_start();
    p.starts_with("\\\\") || p.starts_with("//")
}

pub fn file_uri_to_path(s: &str) -> Option<std::path::PathBuf> {
    let rest = s
        .get(..7)
        .filter(|p| p.eq_ignore_ascii_case("file://"))
        .map(|_| &s[7..])?;
    // Drop any query/fragment.
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let path = percent_decode(path)?;
    let host = if host.eq_ignore_ascii_case("localhost") {
        ""
    } else {
        host
    };
    if cfg!(windows) {
        let bytes = path.as_bytes();
        // "/C:/x" -> "C:/x"
        let local = if bytes.len() >= 3
            && bytes[0] == b'/'
            && bytes[1].is_ascii_alphabetic()
            && (bytes[2] == b':' || bytes[2] == b'|')
        {
            format!("{}:{}", &path[1..2], &path[3..])
        } else {
            path
        };
        let local = local.replace('/', "\\");
        if host.is_empty() {
            Some(local.into())
        } else {
            Some(format!("\\\\{host}{local}").into())
        }
    } else if host.is_empty() {
        Some(path.into())
    } else {
        None
    }
}

/// Decodes `%XX` escapes; None if the result isn't UTF-8 or an escape is malformed.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Percent-encodes everything but unreserved URI characters (and `/`).
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) {
    if depth > 12 || out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            if !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
                walk(root, &entry.path(), depth + 1, out);
            }
        } else if kind.is_file() {
            if let Ok(rel) = entry.path().strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
                if out.len() >= MAX_FILES {
                    return;
                }
            }
        }
    }
}

/// Git repositories in the usual places under `home` (newest activity first), so
/// first-time users can pick a project instead of browsing for one.
pub fn discover_projects(home: &Path, limit: usize) -> Vec<String> {
    const ROOTS: &[&str] = &[
        "",
        "Projects",
        "projects",
        "Code",
        "code",
        "src",
        "dev",
        "Dev",
        "Developer",
        "work",
        "Work",
        "repos",
        "Repos",
        "git",
        "GitHub",
        "Documents/GitHub",
        "Documents/Projects",
        "source/repos",
        "workspace",
        "Workspace",
    ];
    let mut found: Vec<(std::time::SystemTime, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut visit = |dir: &Path, found: &mut Vec<(std::time::SystemTime, String)>| {
        let git = dir.join(".git");
        if let Ok(meta) = std::fs::metadata(&git) {
            let key = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
            if seen.insert(key) {
                // HEAD/index change on checkout and commit; fall back to the .git entry.
                let touched = ["index", "HEAD"]
                    .iter()
                    .filter_map(|f| std::fs::metadata(git.join(f)).ok()?.modified().ok())
                    .max()
                    .or_else(|| meta.modified().ok())
                    .unwrap_or(std::time::UNIX_EPOCH);
                found.push((touched, dir.to_string_lossy().into_owned()));
            }
            return true;
        }
        false
    };
    let mut roots_seen: Vec<PathBuf> = Vec::new();
    for root in ROOTS {
        // Case-insensitive file systems (macOS, Windows) match "Code" and "code"
        // to the same folder: use its real name, and visit it once.
        let Some(root) = actual_path(home, root) else {
            continue;
        };
        if roots_seen.contains(&root) {
            continue;
        }
        roots_seen.push(root.clone());
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten().take(500) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let path = entry.path();
            if visit(&path, &mut found) || root == home {
                continue;
            }
            // One level deeper for "Projects/<org>/<repo>" layouts.
            if let Ok(inner) = std::fs::read_dir(&path) {
                for sub in inner.flatten().take(200) {
                    if sub.file_type().is_ok_and(|t| t.is_dir())
                        && !sub.file_name().to_string_lossy().starts_with('.')
                    {
                        visit(&sub.path(), &mut found);
                    }
                }
            }
        }
    }
    found.sort_by_key(|f| std::cmp::Reverse(f.0));
    found.into_iter().take(limit).map(|(_, p)| p).collect()
}

/// `base/rel` with each component spelled as it is on disk (None if missing).
fn actual_path(base: &Path, rel: &str) -> Option<PathBuf> {
    let mut path = base.to_path_buf();
    for part in rel.split('/').filter(|p| !p.is_empty()) {
        let exact = path.join(part);
        let real = std::fs::read_dir(&path)
            .ok()?
            .flatten()
            .map(|e| e.file_name())
            .find(|n| n.to_string_lossy() == part)
            .or_else(|| {
                std::fs::read_dir(&path)
                    .ok()?
                    .flatten()
                    .map(|e| e.file_name())
                    .find(|n| n.to_string_lossy().eq_ignore_ascii_case(part))
            });
        path = match real {
            Some(name) => path.join(name),
            None if exact.is_dir() => exact,
            None => return None,
        };
        if !path.is_dir() {
            return None;
        }
    }
    Some(path)
}

/// Ranks paths against `query`: exact file name > file-name substring > path
/// substring > in-order subsequence. Shorter paths win ties.
pub fn fuzzy_filter(files: &[String], query: &str, limit: usize) -> Vec<String> {
    let q = query.trim().trim_start_matches('@').to_lowercase();
    if q.is_empty() {
        let mut by_len: Vec<&String> = files.iter().collect();
        by_len.sort_by_key(|f| (f.matches('/').count(), f.len()));
        return by_len.into_iter().take(limit).cloned().collect();
    }
    let mut scored: Vec<(i64, &String)> = files
        .iter()
        .filter_map(|f| score(f, &q).map(|s| (s, f)))
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.len().cmp(&b.1.len())));
    scored
        .into_iter()
        .take(limit)
        .map(|(_, f)| f.clone())
        .collect()
}

fn score(path: &str, q: &str) -> Option<i64> {
    let lower = path.to_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    let len_penalty = lower.len() as i64;
    if name == q {
        return Some(10_000 - len_penalty);
    }
    if let Some(i) = name.find(q) {
        return Some(8_000 - i as i64 * 10 - len_penalty);
    }
    if let Some(i) = lower.find(q) {
        return Some(6_000 - i as i64 - len_penalty);
    }
    // In-order subsequence; reward consecutive runs.
    let mut chars = lower.chars();
    let mut run = 0i64;
    let mut bonus = 0i64;
    for qc in q.chars() {
        let mut matched = false;
        for c in chars.by_ref() {
            if c == qc {
                matched = true;
                run += 1;
                bonus += run;
                break;
            }
            run = 0;
        }
        if !matched {
            return None;
        }
    }
    Some(2_000 + bonus * 10 - len_penalty)
}

#[cfg(test)]
mod tests {
    #[test]
    fn network_paths_are_recognized() {
        for p in [
            r"\\server\share\a.png",
            "//server/share/a.png",
            r"\\?\UNC\server\a.png",
            "  //x/y.png",
        ] {
            assert!(super::is_network_path(p), "{p}");
        }
        for p in [
            "/home/me/a.png",
            "shots/a.png",
            r"C:\shots\a.png",
            "a//b.png",
            "./a.png",
        ] {
            assert!(!super::is_network_path(p), "{p}");
        }
    }

    use super::*;

    #[test]
    fn discovers_repos() {
        let home = std::env::temp_dir().join(format!("armada-discover-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        for d in [
            "Projects/app/.git",
            "Projects/org/lib/.git",
            "code/tool/.git",
            "Projects/notes",
        ] {
            std::fs::create_dir_all(home.join(d)).unwrap();
        }
        let mut found = discover_projects(&home, 10);
        found.sort();
        let rel: Vec<String> = found
            .iter()
            .map(|p| {
                Path::new(p)
                    .strip_prefix(&home)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        assert_eq!(rel, vec!["Projects/app", "Projects/org/lib", "code/tool"]);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn file_uris() {
        assert_eq!(file_uri_to_path("/tmp/x.png"), None);
        assert_eq!(percent_encode("a b%.png"), "a%20b%25.png");
        assert_eq!(percent_decode("a%20b%25.png").as_deref(), Some("a b%.png"));
        assert_eq!(percent_decode("bad%2"), None);
        #[cfg(unix)]
        {
            use std::path::PathBuf;
            assert_eq!(
                file_uri_to_path("file:///tmp/my%20shot.png"),
                Some(PathBuf::from("/tmp/my shot.png"))
            );
            assert_eq!(
                file_uri_to_path("FILE://localhost/tmp/a.png#x"),
                Some(PathBuf::from("/tmp/a.png"))
            );
            assert_eq!(file_uri_to_path("file://server/share/a.png"), None);
        }
        #[cfg(windows)]
        {
            use std::path::PathBuf;
            assert_eq!(
                file_uri_to_path("file:///C:/Users/me/a%20b.png"),
                Some(PathBuf::from(r"C:\Users\me\a b.png"))
            );
            assert_eq!(
                file_uri_to_path("file://server/share/a.png"),
                Some(PathBuf::from(r"\\server\share\a.png"))
            );
        }
    }

    #[test]
    fn lists_git_files_sorted() {
        let dir =
            std::env::temp_dir().join(format!("armada-files-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        for f in ["b.txt", "a.txt", "src/c.rs"] {
            std::fs::write(dir.join(f), "x").unwrap();
        }
        let git_ok = Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .status()
            .is_ok_and(|s| s.success());
        if git_ok {
            std::fs::write(dir.join(".gitignore"), "b.txt\n").unwrap();
        }
        let files = project_files(&dir).unwrap();
        if git_ok {
            assert_eq!(files, vec![".gitignore", "a.txt", "src/c.rs"]);
        } else {
            assert_eq!(files, vec!["a.txt", "b.txt", "src/c.rs"]);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ranking() {
        let files: Vec<String> = [
            "src/components/AgentView.tsx",
            "src/lib/agent.ts",
            "docs/agents.md",
            "src/views/Inbox.tsx",
            "README.md",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let r = fuzzy_filter(&files, "agent.ts", 10);
        assert_eq!(r[0], "src/lib/agent.ts");
        let r = fuzzy_filter(&files, "@inbox", 10);
        assert_eq!(r[0], "src/views/Inbox.tsx");
        let r = fuzzy_filter(&files, "avtsx", 10);
        assert_eq!(r[0], "src/components/AgentView.tsx");
        assert!(fuzzy_filter(&files, "zzz", 10).is_empty());
        assert_eq!(
            fuzzy_filter(&files, "", 2),
            vec!["README.md", "docs/agents.md"]
        );
    }
}
