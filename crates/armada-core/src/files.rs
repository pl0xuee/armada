//! Project file listing + fuzzy matching for @-mentions in the composer.

use std::path::Path;
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

/// Relative paths of the files in `root`. Uses git (respects .gitignore) when it can.
pub fn project_files(root: &Path) -> anyhow::Result<Vec<String>> {
    let mut cmd = Command::new("git");
    cmd.args([
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
    ])
    .current_dir(root)
    .stdin(Stdio::null())
    .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    if let Ok(out) = cmd.output() {
        if out.status.success() {
            let mut files: Vec<String> = out
                .stdout
                .split(|b| *b == 0)
                .filter(|p| !p.is_empty())
                .take(MAX_FILES)
                .map(|p| String::from_utf8_lossy(p).into_owned())
                .collect();
            files.sort();
            files.dedup();
            return Ok(files);
        }
    }
    let mut files = Vec::new();
    walk(root, root, 0, &mut files);
    files.sort();
    Ok(files)
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
    use super::*;

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
