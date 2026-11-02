//! Tidies noisy shell output before a Claude agent reads it (what community tools like RTK do).
//!
//! Claude Code runs this as a `PostToolUse` hook for its Bash tool (`kvistcode filter-output`,
//! wired in `token_saver`): the command has already run, and we only change what the model
//! sees. Every line the agent reads is re-read on each later step of its conversation, so
//! dropping progress spam early is cheap and safe; dropping information is not, so the rules
//! are deliberately narrow:
//!
//! * only for build/test/install/git tools that print a lot (an allowlist), never for commands
//!   that print file contents or search results (`cat`, `sed`, `grep`, `git diff`...), where
//!   repeated or blank lines can matter;
//! * only lossless-ish rewrites: terminal colors, redrawn progress lines, runs of identical
//!   lines, runs of `Compiling x` / `Downloaded x` lines, runs of passing-test lines, git's
//!   `(use "git ...")` hints. Errors, warnings and failures are never removed.
//!
//! Measured on one real install (docs/TOKEN-SAVING.md): shell output is mostly file reads, so the
//! saving is modest there; it is larger for build/test-heavy projects.

use std::io::{Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Environment variable carrying the path of the stats file (set by Kvistcode for its agents).
pub const STATS_ENV: &str = "KVISTCODE_FILTER_STATS";

/// Smallest saving worth rewriting an output for.
const MIN_SAVED_CHARS: usize = 200;

/// Programs whose output is mostly progress and logs.
const NOISY: &[&str] = &[
    "cargo",
    "rustc",
    "npm",
    "npx",
    "pnpm",
    "yarn",
    "bun",
    "pip",
    "pip3",
    "pytest",
    "go",
    "make",
    "cmake",
    "ninja",
    "gradle",
    "gradlew",
    "mvn",
    "dotnet",
    "docker",
    "apt",
    "apt-get",
    "brew",
    "tsc",
    "jest",
    "vitest",
    "playwright",
    "eslint",
    "git",
];

/// Programs that print content the agent needs verbatim.
const CONTENT: &[&str] = &[
    "cat", "sed", "head", "tail", "nl", "bat", "less", "more", "grep", "egrep", "fgrep", "rg",
    "ag", "awk", "diff", "jq", "xxd", "od", "tr", "cut", "sort", "uniq", "wc", "find", "ls",
    "tree", "echo", "printf", "curl", "wget", "strings", "base64",
];

/// Git subcommands whose output is content, not progress.
const GIT_CONTENT: &[&str] = &[
    "diff", "show", "blame", "cat-file", "grep", "ls-files", "log",
];

/// Splits a shell command into the program names of its parts (`cd x && cargo test | tail`
/// gives `cd`, `cargo`, `tail`) and, for git, its subcommand (`git:diff`).
fn programs(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seg = String::new();
    let flush = |seg: &mut String, out: &mut Vec<String>| {
        let mut words = seg
            .split_whitespace()
            .skip_while(|w| w.contains('=') && !w.starts_with('-') && !w.contains('/'));
        if let Some(first) = words.next() {
            let name = first
                .trim_matches(|c| c == '(' || c == '{' || c == '"' || c == '\'')
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(first)
                .trim_end_matches(".exe")
                .to_ascii_lowercase();
            if name == "git" {
                // Skip global options such as `-C dir` / `--no-pager`.
                let mut rest = words.peekable();
                while let Some(w) = rest.peek() {
                    if *w == "-C" || *w == "-c" {
                        rest.next();
                        rest.next();
                    } else if w.starts_with('-') {
                        rest.next();
                    } else {
                        break;
                    }
                }
                out.push(format!("git:{}", rest.next().unwrap_or("")));
            } else {
                out.push(name);
            }
        }
        seg.clear();
    };
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            ';' | '|' | '&' | '\n' | '`' => flush(&mut seg, &mut out),
            '$' if chars.peek() == Some(&'(') => {
                chars.next();
                flush(&mut seg, &mut out);
            }
            _ => seg.push(c),
        }
    }
    flush(&mut seg, &mut out);
    out
}

/// Whether the output of `command` is safe and worthwhile to tidy.
pub fn applies_to(command: &str) -> bool {
    let progs = programs(command);
    let mut noisy = false;
    for p in &progs {
        if let Some(sub) = p.strip_prefix("git:") {
            if GIT_CONTENT.contains(&sub) {
                return false;
            }
            noisy = true;
        } else if CONTENT.contains(&p.as_str()) {
            return false;
        } else if NOISY.contains(&p.as_str())
            || (matches!(p.as_str(), "python" | "python3" | "py") && command.contains("pytest"))
        {
            noisy = true;
        }
    }
    noisy
}

/// Removes terminal escape sequences (colors, cursor moves, window titles).
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match it.peek() {
            Some('[') => {
                it.next();
                // Parameters and intermediates, then one final byte in 0x40..=0x7e.
                for n in it.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&n) {
                        break;
                    }
                }
            }
            Some(']') => {
                it.next();
                // OSC: ends at BEL or ESC \.
                while let Some(n) = it.next() {
                    if n == '\u{7}' {
                        break;
                    }
                    if n == '\u{1b}' {
                        if it.peek() == Some(&'\\') {
                            it.next();
                        }
                        break;
                    }
                }
            }
            Some(_) => {
                it.next();
            }
            None => {}
        }
    }
    out
}

fn is_progress_verb(line: &str) -> Option<&'static str> {
    let t = line.trim_start();
    [
        "Compiling",
        "Downloading",
        "Downloaded",
        "Fetching",
        "Updating",
        "Locking",
        "Adding",
        "Checking",
        "Documenting",
        "Installing",
        "Unpacking",
        "Collecting",
        "Using cached",
        "Requirement already satisfied",
        "Get:",
        "Hit:",
        "Reading package lists",
        "Selecting previously",
        "Preparing to unpack",
        "Setting up",
    ]
    .into_iter()
    .find(|verb| t.starts_with(verb))
}

fn is_passing_test(line: &str) -> bool {
    let t = line.trim();
    (t.starts_with("test ") && t.ends_with("... ok"))
        || (t.starts_with("PASS ") && !t.contains("FAIL"))
        || (t.contains(" PASSED") && (t.contains("::") || t.starts_with("PASSED")))
        || t.starts_with("--- PASS:")
        || t.starts_with("=== RUN")
        || t.starts_with("=== PAUSE")
        || t.starts_with("=== CONT")
}

fn is_git_hint(line: &str) -> bool {
    let t = line.trim();
    t.starts_with("(use \"git ") && t.ends_with(')')
}

/// Collapses a run of `n` lines of one kind into a single note (or keeps them when short).
fn push_run(
    out: &mut Vec<String>,
    run: &mut Vec<String>,
    note: impl Fn(usize) -> String,
    min: usize,
) {
    if run.len() >= min {
        out.push(note(run.len()));
    } else {
        out.append(run);
    }
    run.clear();
}

/// The tidied text, or `None` when nothing worth removing was found.
pub fn tidy(text: &str) -> Option<String> {
    if text.len() < MIN_SAVED_CHARS {
        return None;
    }
    let plain = strip_ansi(text);
    // A progress bar redraws its line with carriage returns: only the last drawing matters.
    let lines: Vec<String> = plain
        .split('\n')
        .map(|l| {
            let l = l.strip_suffix('\r').unwrap_or(l);
            match l.rfind('\r') {
                Some(i) if !l[i + 1..].trim().is_empty() => l[i + 1..].to_string(),
                _ => l.to_string(),
            }
        })
        .collect();

    #[derive(PartialEq, Clone)]
    enum Kind {
        Progress(String),
        Pass,
        Dup(String),
        Other,
    }
    let mut out: Vec<String> = Vec::new();
    let mut run: Vec<String> = Vec::new();
    let mut kind = Kind::Other;
    let mut blank = false;
    let flush = |out: &mut Vec<String>, run: &mut Vec<String>, kind: &Kind| match kind {
        Kind::Progress(v) => {
            let verb = v.clone();
            push_run(
                out,
                run,
                |n| format!("[{n} \"{verb}...\" lines omitted]"),
                6,
            )
        }
        Kind::Pass => push_run(out, run, |n| format!("[{n} passing-test lines omitted]"), 8),
        Kind::Dup(l) => {
            let l = l.clone();
            push_run(
                out,
                run,
                |n| format!("{l}\n[previous line repeated {} more times]", n - 1),
                4,
            )
        }
        Kind::Other => out.append(run),
    };
    for line in lines {
        if is_git_hint(&line) {
            continue;
        }
        if line.trim().is_empty() {
            // One blank line at most.
            if blank {
                continue;
            }
            blank = true;
        } else {
            blank = false;
        }
        let this = if let Some(v) = is_progress_verb(&line) {
            Kind::Progress(v.to_string())
        } else if is_passing_test(&line) {
            Kind::Pass
        } else if !line.trim().is_empty() && run.last().is_some_and(|p| *p == line) {
            Kind::Dup(line.clone())
        } else {
            Kind::Other
        };
        // A repeated line extends a duplicate run (or starts one from the previous line).
        match (&kind, &this) {
            (Kind::Progress(a), Kind::Progress(b)) if a == b => run.push(line),
            (Kind::Pass, Kind::Pass) => run.push(line),
            (Kind::Dup(a), Kind::Dup(b)) if a == b => run.push(line),
            (Kind::Other, Kind::Dup(l)) => {
                // The last kept line starts the run.
                let prev = run.pop().unwrap_or_else(|| l.clone());
                flush(&mut out, &mut run, &kind);
                run = vec![prev, line.clone()];
                kind = this;
            }
            _ => {
                flush(&mut out, &mut run, &kind);
                run = vec![line];
                kind = this;
            }
        }
    }
    flush(&mut out, &mut run, &kind);
    let mut result = out.join("\n");
    while result.ends_with("\n\n") {
        result.pop();
    }
    (text.len() >= result.len() + MIN_SAVED_CHARS).then_some(result)
}

/// One line of the stats file.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct Saved {
    pub calls: u64,
    pub before: u64,
    pub after: u64,
}

/// What the output filter has saved so far (characters; about 3.5 per token).
pub fn read_stats(path: &Path) -> Saved {
    let mut total = Saved::default();
    let Ok(text) = std::fs::read_to_string(path) else {
        return total;
    };
    for line in text.lines() {
        if let Ok(s) = serde_json::from_str::<Saved>(line) {
            total.calls += s.calls;
            total.before += s.before;
            total.after += s.after;
        }
    }
    total
}

/// The stats file inside the app data folder.
pub fn stats_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("output-filter-stats.jsonl")
}

fn record(path: &Path, before: usize, after: usize) {
    // Stats must never break a tool call: every failure is ignored.
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > 1_000_000 {
            let total = read_stats(path);
            let _ = std::fs::write(
                path,
                format!("{}\n", serde_json::to_string(&total).unwrap_or_default()),
            );
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let line = serde_json::to_string(&Saved {
            calls: 1,
            before: before as u64,
            after: after as u64,
        })
        .unwrap_or_default();
        let _ = writeln!(f, "{line}");
    }
}

/// The hook's answer for `input` (the hook's stdin JSON), plus the sizes for the stats.
/// `None` means "change nothing".
pub fn hook_reply(input: &Value) -> Option<(Value, usize, usize)> {
    if input["hook_event_name"] != "PostToolUse" || input["tool_name"] != "Bash" {
        return None;
    }
    let command = input["tool_input"]["command"].as_str()?;
    if !applies_to(command) {
        return None;
    }
    let resp = input["tool_response"].as_object()?;
    if resp.get("isImage").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let mut new = resp.clone();
    let (mut before, mut after) = (0, 0);
    for key in ["stdout", "stderr"] {
        if let Some(Value::String(s)) = resp.get(key) {
            before += s.len();
            match tidy(s) {
                Some(t) => {
                    after += t.len();
                    new.insert(key.into(), Value::String(t));
                }
                None => after += s.len(),
            }
        }
    }
    if before == after {
        return None;
    }
    Some((
        json!({ "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "updatedToolOutput": Value::Object(new),
        }}),
        before,
        after,
    ))
}

/// Entry point of `kvistcode filter-output`: reads the hook JSON on stdin and prints the
/// reply. Always exits 0 with nothing printed when anything is unexpected, so a bug here can
/// only mean "no filtering", never a failed tool call.
pub fn run_hook() -> i32 {
    let mut raw = String::new();
    if std::io::stdin()
        .take(64 * 1024 * 1024)
        .read_to_string(&mut raw)
        .is_err()
    {
        return 0;
    }
    let Ok(input) = serde_json::from_str::<Value>(&raw) else {
        return 0;
    };
    if let Some((reply, before, after)) = hook_reply(&input) {
        if let Ok(path) = std::env::var(STATS_ENV) {
            record(Path::new(&path), before, after);
        }
        println!("{reply}");
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_noisy_tools_and_never_content_commands() {
        assert!(applies_to("cargo test --workspace"));
        assert!(applies_to("cd /x && npm install"));
        assert!(applies_to("FOO=1 /usr/bin/git status"));
        assert!(applies_to("py -m pytest -q"));
        assert!(applies_to("git -C /repo fetch"));
        assert!(!applies_to("cat src/main.rs"));
        assert!(!applies_to("sed -n 1,80p a.rs"));
        assert!(!applies_to("cargo test 2>&1 | grep FAIL"));
        assert!(!applies_to("git diff HEAD"));
        assert!(!applies_to("git log --oneline"));
        assert!(!applies_to("ls -la"));
        assert!(!applies_to("py script.py"));
        assert!(!applies_to("cd src && cat $(git ls-files)"));
        assert!(!applies_to(""));
    }

    #[test]
    fn strips_colors_and_progress_redraws() {
        let mut s = String::new();
        for i in 0..40 {
            s.push_str(&format!("\x1b[32mDownloading\x1b[0m {i}%\r"));
        }
        s.push('\n');
        s.push_str("\x1b[1;31merror\x1b[0m: boom\n");
        s.push_str(&"x".repeat(300));
        let t = tidy(&s).unwrap();
        assert!(!t.contains('\x1b') && !t.contains('\r'));
        assert!(t.contains("error: boom"));
        assert!(t.contains("39%") && !t.contains("Downloading 3%"));
    }

    #[test]
    fn collapses_runs_but_keeps_errors_and_failures() {
        let mut s = String::new();
        for i in 0..30 {
            s.push_str(&format!("   Compiling crate{i} v1.0.{i}\n"));
        }
        s.push_str("warning: unused variable `x`\n");
        for i in 0..40 {
            s.push_str(&format!("test module::case_{i} ... ok\n"));
        }
        s.push_str("test module::broken ... FAILED\n");
        s.push_str("failures:\n\n---- module::broken stdout ----\nassertion failed\n");
        for _ in 0..10 {
            s.push_str("retrying connection\n");
        }
        let t = tidy(&s).unwrap();
        assert!(t.contains("[30 \"Compiling...\" lines omitted]"), "{t}");
        assert!(t.contains("warning: unused variable `x`"));
        assert!(t.contains("[40 passing-test lines omitted]"));
        assert!(t.contains("test module::broken ... FAILED"));
        assert!(t.contains("assertion failed"));
        assert!(t.contains("retrying connection\n[previous line repeated 9 more times]"));
        assert!(t.len() < s.len() / 3);
    }

    #[test]
    fn short_runs_and_small_outputs_are_left_alone() {
        assert!(tidy("hello\nworld\n").is_none());
        let few = "   Compiling a v1\n   Compiling b v1\nerror[E0308]: mismatched types\n"
            .repeat(2)
            + &"y".repeat(250);
        // Nothing to collapse: the few-line runs stay, so there is no saving to report.
        assert!(tidy(&few).is_none());
    }

    #[test]
    fn git_hints_go_but_changes_stay() {
        let mut s = String::from("On branch main\nChanges not staged for commit:\n");
        s.push_str("  (use \"git add <file>...\" to update what will be committed)\n");
        s.push_str("  (use \"git restore <file>...\" to discard changes in working directory)\n");
        s.push_str("\tmodified:   src/lib.rs\n");
        s.push_str(&"\tmodified:   a/very/long/path/name/file.rs\n".repeat(8));
        let t = tidy(&s).unwrap();
        assert!(!t.contains("(use \"git"));
        assert!(t.contains("modified:   src/lib.rs"));
    }

    #[test]
    fn hook_reply_keeps_other_fields_and_skips_content_commands() {
        let noisy = "   Compiling dep v1\n".repeat(50);
        let input = json!({
            "hook_event_name": "PostToolUse", "tool_name": "Bash",
            "tool_input": {"command": "cargo build"},
            "tool_response": {"stdout": noisy, "stderr": "", "interrupted": false, "isImage": false},
        });
        let (reply, before, after) = hook_reply(&input).unwrap();
        let new = &reply["hookSpecificOutput"]["updatedToolOutput"];
        assert_eq!(new["interrupted"], false);
        assert_eq!(new["isImage"], false);
        assert_eq!(new["stderr"], "");
        assert!(after < before);
        assert_eq!(reply["hookSpecificOutput"]["hookEventName"], "PostToolUse");

        let mut cat = input.clone();
        cat["tool_input"]["command"] = json!("cat build.log");
        assert!(hook_reply(&cat).is_none());
        let mut other = input.clone();
        other["tool_name"] = json!("Read");
        assert!(hook_reply(&other).is_none());
        let mut s = input.clone();
        s["tool_response"] = json!("plain string");
        assert!(hook_reply(&s).is_none());
    }

    #[test]
    fn stats_add_up_and_survive_garbage() {
        let dir = std::env::temp_dir().join(format!("kvist-filter-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = stats_path(&dir);
        assert_eq!(read_stats(&p), Saved::default());
        record(&p, 1000, 400);
        record(&p, 500, 500);
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        writeln!(f, "not json").unwrap();
        assert_eq!(
            read_stats(&p),
            Saved {
                calls: 2,
                before: 1500,
                after: 900
            }
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
