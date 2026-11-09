//! Pictures in the timeline live as files under `<data dir>/pictures`, not as base64
//! inside the stored item. Items are written to SQLite and sent to the window on every
//! update, so inline pictures made a page of history tens of megabytes.
//!
//! An `Attachment` then carries a `path` (the bare file name in that folder) and no
//! `data`. Older rows keep their inline `data` and load as before; a stored picture is
//! never rewritten, and is deleted only when the agent that held the last reference is
//! deleted (`unused_after_delete`). Files are named after a hash of the picture, so the
//! same picture is written once, and shared by every item that shows it.

use std::path::{Path, PathBuf};

use base64::Engine;
use sha2::{Digest, Sha256};

use crate::files::MAX_IMAGE_BASE64;
use crate::model::{Attachment, ItemBody, TimelineItem};

/// Picture types stored as files (mime type, file extension).
const TYPES: &[(&str, &str)] = &[
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
    ("image/bmp", "bmp"),
    ("image/avif", "avif"),
];

/// The folder pictures are kept in.
pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("pictures")
}

fn extension(mime: &str) -> Option<&'static str> {
    TYPES.iter().find(|(m, _)| *m == mime).map(|(_, e)| *e)
}

fn mime_of(name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.')?.1;
    TYPES.iter().find(|(_, e)| *e == ext).map(|(m, _)| *m)
}

/// A file name this module writes: 32 lowercase hex characters and a known extension.
/// Anything else (a path from a client, `..`, a separator) is refused, so a `path` can
/// never point outside the folder.
pub fn valid_name(name: &str) -> bool {
    let Some((stem, _)) = name.rsplit_once('.') else {
        return false;
    };
    stem.len() == 32
        && stem.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        && mime_of(name).is_some()
}

fn decode(data: &str) -> Option<Vec<u8>> {
    let engine = base64::engine::general_purpose::STANDARD;
    engine.decode(data.as_bytes()).ok().or_else(|| {
        // Some agents wrap their base64 in line breaks.
        let clean: String = data.split_whitespace().collect();
        engine.decode(clean.as_bytes()).ok()
    })
}

/// Writes the picture's bytes to a file (unless it is already there) and returns the
/// file name. None when it can't be stored; the caller then keeps it inline.
fn store(dir: &Path, a: &Attachment) -> Option<String> {
    let ext = extension(&a.mime_type)?;
    if a.data.is_empty() || a.data.len() > MAX_IMAGE_BASE64 {
        return None;
    }
    let hash = crate::toolchain::hex_lower(&Sha256::digest(a.data.as_bytes()));
    let name = format!("{}.{ext}", &hash[..32]);
    let path = dir.join(&name);
    if path.is_file() {
        return Some(name);
    }
    let bytes = decode(&a.data)?;
    create_private_dir(dir).ok()?;
    // Written whole, then moved into place: a crash never leaves a half picture under
    // the real name.
    let tmp = dir.join(format!("{name}.{}.tmp", uuid::Uuid::new_v4()));
    let done = std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, &path));
    if let Err(e) = done {
        tracing::warn!("storing a picture: {e}");
        let _ = std::fs::remove_file(&tmp);
        return None;
    }
    Some(name)
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

fn pictures_of(body: &mut ItemBody) -> &mut [Attachment] {
    match body {
        ItemBody::UserMessage { attachments, .. } => attachments,
        ItemBody::AgentMessage { images, .. } | ItemBody::ToolCall { images, .. } => images,
        _ => &mut [],
    }
}

/// The item with its inline pictures moved to files, for storing and sending. None when
/// there is nothing to move. A picture that can't be written stays inline.
pub fn slim(dir: &Path, item: &TimelineItem) -> Option<TimelineItem> {
    if item.body.pictures().iter().all(|a| a.data.is_empty()) {
        return None;
    }
    let mut out = item.clone();
    for a in pictures_of(&mut out.body) {
        if a.data.is_empty() {
            continue;
        }
        if let Some(name) = store(dir, a) {
            a.path = Some(name);
            a.data = String::new();
        }
    }
    Some(out)
}

/// The stored picture files these items refer to.
pub fn names_of(items: &[TimelineItem]) -> Vec<String> {
    let mut names: Vec<String> = items
        .iter()
        .flat_map(|i| i.body.pictures())
        .filter_map(|a| a.path.clone())
        .filter(|n| valid_name(n))
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Deletes the named picture files that `in_use` says nothing refers to any more (the
/// agent that showed them was just deleted).
pub fn unused_after_delete(dir: &Path, names: &[String], in_use: impl Fn(&str) -> bool) {
    for name in names {
        if valid_name(name) && !in_use(name) {
            let _ = std::fs::remove_file(dir.join(name));
        }
    }
}

/// Reads a stored picture by file name.
pub fn read(dir: &Path, name: &str) -> anyhow::Result<Attachment> {
    let mime = mime_of(name)
        .filter(|_| valid_name(name))
        .ok_or_else(|| anyhow::anyhow!("not a stored picture"))?;
    let path = dir.join(name);
    let meta = std::fs::metadata(&path)?;
    if !meta.is_file() || meta.len() > crate::files::MAX_IMAGE_BYTES {
        anyhow::bail!("the picture can't be read");
    }
    let bytes = std::fs::read(&path)?;
    Ok(Attachment {
        name: name.to_string(),
        mime_type: mime.to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        path: Some(name.to_string()),
    })
}

/// Fills in the bytes of pictures that are only a file (for readers that need them
/// inline: the phone, a JSON export). A picture that can't be read is left as it is.
pub fn hydrate(dir: &Path, item: &mut TimelineItem) {
    for a in pictures_of(&mut item.body) {
        let Some(name) = a.path.as_deref().filter(|_| a.data.is_empty()) else {
            continue;
        };
        if let Ok(full) = read(dir, name) {
            a.data = full.data;
        }
    }
}

/// Makes a prompt's pictures carry their bytes. One that is only a stored file (a
/// retried message) is read back from it; for any other the client's `path` is ignored,
/// so a client can never make Kvistcode read an arbitrary file.
pub fn load_for_prompt(dir: &Path, list: &mut [Attachment]) -> anyhow::Result<()> {
    for a in list {
        if !a.data.is_empty() {
            a.path = None;
            continue;
        }
        let name = a.path.take().unwrap_or_default();
        let full = read(dir, &name)
            .map_err(|_| anyhow::anyhow!("{} is no longer available; attach it again", a.name))?;
        a.data = full.data;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kvistcode-pictures-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn message(data: &str, mime: &str) -> TimelineItem {
        TimelineItem {
            id: "i1".into(),
            agent_id: "a".into(),
            seq: 1,
            ts: 1,
            body: ItemBody::UserMessage {
                text: "hi".into(),
                attachments: vec![Attachment {
                    name: "p".into(),
                    mime_type: mime.into(),
                    data: data.into(),
                    path: None,
                }],
                mid_turn: false,
                automatic: false,
            },
        }
    }

    #[test]
    fn rows_from_before_pictures_were_files_still_load() {
        let old = r#"{"id":"i","agentId":"a","seq":1,"ts":1,"kind":"user_message","text":"x",
            "attachments":[{"name":"p.png","mimeType":"image/png","data":"AAAA"}]}"#;
        let item: TimelineItem = serde_json::from_str(old).unwrap();
        let pics = item.body.pictures();
        assert_eq!(pics[0].data, "AAAA");
        assert!(pics[0].path.is_none());
        // A stored picture serializes without data; an inline one without a path.
        let stored = Attachment {
            name: "p".into(),
            mime_type: "image/png".into(),
            data: String::new(),
            path: Some("0".repeat(32) + ".png"),
        };
        let json = serde_json::to_string(&stored).unwrap();
        assert!(!json.contains("\"data\"") && json.contains("\"path\""));
        let json = serde_json::to_string(&pics[0]).unwrap();
        assert!(json.contains("\"data\"") && !json.contains("\"path\""));
    }

    #[test]
    fn names_are_checked() {
        let ok = format!("{}.png", "a1".repeat(16));
        assert!(valid_name(&ok));
        for bad in [
            "",
            "..",
            "../x.png",
            "a/b.png",
            "abc.png",
            &format!("{}.exe", "a1".repeat(16)),
            &format!("{}.png", "A1".repeat(16)),
            &format!("{}.png.tmp", "a1".repeat(16)),
        ] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn slim_writes_once_and_keeps_unstorable_pictures_inline() {
        let dir = scratch("slim").join("pictures");
        let slim_item = slim(&dir, &message(PNG, "image/png")).unwrap();
        let ItemBody::UserMessage { attachments, .. } = &slim_item.body else {
            unreachable!()
        };
        assert!(attachments[0].data.is_empty());
        let name = attachments[0].path.clone().unwrap();
        assert!(valid_name(&name));
        assert_eq!(read(&dir, &name).unwrap().data, PNG);
        // Again: same file, nothing more written.
        slim(&dir, &message(PNG, "image/png")).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        // Nothing inline: nothing to do.
        assert!(slim(&dir, &slim_item).is_none());

        // Not valid base64, or a type that isn't stored: stays inline, still readable.
        let broken = slim(&dir, &message("not base64!", "image/png")).unwrap();
        assert_eq!(broken.body.pictures()[0].data, "not base64!");
        let svg = slim(&dir, &message(PNG, "image/svg+xml")).unwrap();
        assert_eq!(svg.body.pictures()[0].data, PNG);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);

        let mut back = slim_item.clone();
        hydrate(&dir, &mut back);
        assert_eq!(back.body.pictures()[0].data, PNG);
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn prompts_ignore_a_client_supplied_path() {
        let dir = scratch("prompt").join("pictures");
        let mut inline = vec![Attachment {
            name: "p".into(),
            mime_type: "image/png".into(),
            data: PNG.into(),
            path: Some("../../etc/passwd".into()),
        }];
        load_for_prompt(&dir, &mut inline).unwrap();
        assert!(inline[0].path.is_none());
        let mut missing = vec![Attachment {
            name: "p".into(),
            mime_type: "image/png".into(),
            data: String::new(),
            path: Some("../../etc/passwd".into()),
        }];
        assert!(load_for_prompt(&dir, &mut missing).is_err());
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn a_deleted_agents_pictures_go_unless_something_else_shows_them() {
        let dir = scratch("unused").join("pictures");
        let item = slim(&dir, &message(PNG, "image/png")).unwrap();
        let names = names_of(&[item]);
        assert_eq!(names.len(), 1);
        // Another agent still shows it: kept.
        unused_after_delete(&dir, &names, |_| true);
        assert!(dir.join(&names[0]).is_file());
        unused_after_delete(&dir, &names, |_| false);
        assert!(!dir.join(&names[0]).exists());
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }
}
