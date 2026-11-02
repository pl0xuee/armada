//! Claude Code's background "Workflow" tool: several agents working in parallel, each
//! in its own worktree, started by one tool call that returns at launch.
//!
//! The call's output names a transcript directory
//! (`<config>/projects/<project>/<session>/subagents/workflows/wf_<id>/`) that Claude
//! Code fills while the run goes on: `journal.jsonl` (who started), and per agent an
//! `agent-<id>.meta.json` and an `agent-<id>.jsonl` transcript. This module
//!
//!  * parses the launch output into a [`WorkflowLaunch`] (defensively; anything that
//!    doesn't look like a launch stays a plain tool call), and
//!  * reads that directory into a [`WorkflowProgress`]: per agent a label, a status,
//!    a tool-call count and one short human line for the latest action.
//!
//! Safety: the directory comes out of agent output, so it is untrusted. [`resolve_dir`]
//! canonicalizes it and requires it to sit exactly at
//! `<claude config dir>/projects/*/*/subagents/workflows/wf_*`; files inside are only
//! read when they are regular files (a symlink is skipped, never followed), at most
//! [`TAIL_BYTES`] of an agent transcript's end (plus a bounded incremental scan for the
//! tool-call count), and nothing but the short fields above ever leaves this module:
//! no prompts, no file contents, no tool output.
//!
//! Completion: the journal gets a `{"type":"result","agentId":…}` line when an agent is
//! done (observed on a real run; the line also carries the agent's report, which is
//! never read out), and its transcript then ends on an assistant message with
//! `stop_reason: end_turn`. Either marks an agent finished, as does a last message that
//! only talks followed by quiet; an agent silent far too long to be working is
//! "unknown". Nothing marks the run itself as over (no run-level line was observed), so
//! a run is finished only after every agent is done and everything has been quiet for
//! [`SETTLE_SECS`], which keeps a later phase starting from looking like the end. How a
//! failed agent is recorded has not been observed; the failure names below are guesses.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

use anyhow::{anyhow, bail};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

use crate::model::{ItemBody, SubAgent, TimelineItem, WorkflowLaunch};

/// How much of the end of an agent transcript is read for its latest action.
pub const TAIL_BYTES: u64 = 256 * 1024;
/// Most bytes of new transcript scanned per call for the tool-call count.
const SCAN_BYTES: u64 = 2 * 1024 * 1024;
/// Journal and meta files are small; never read more than this of them.
const JOURNAL_BYTES: u64 = 256 * 1024;
const META_BYTES: u64 = 16 * 1024;
const MAX_AGENTS: usize = 64;
const MAX_LINE_CHARS: usize = 80;
/// Silent this long with nothing pending: not working any more (status "unknown").
const QUIET_SECS: u64 = 15 * 60;
/// ... or this long when its last event was a tool call still waiting for its result.
const QUIET_PENDING_SECS: u64 = 60 * 60;
/// An agent whose last message was only text, and has been quiet this long, is done.
const TALKED_SECS: u64 = 60;
/// Everything done and quiet this long: the run is finished (a next phase may still start).
const SETTLE_SECS: u64 = 45;
/// A run directory with no agents yet counts as starting for this long.
const STARTING_SECS: u64 = 5 * 60;

// ---- launch output ------------------------------------------------------------

/// The launch call's output → its summary line and where the run keeps its transcripts.
/// `None` when it isn't a recognisable launch (then it stays a plain tool call).
pub fn parse_launch(output: &str) -> Option<(WorkflowLaunch, Option<String>)> {
    let output = output.trim_start();
    if !output.starts_with("Workflow launched in background") {
        return None;
    }
    let mut launch = WorkflowLaunch::default();
    let mut summary = None;
    for line in output.lines().take(40) {
        let line = line.trim();
        let field = |key: &str| {
            line.strip_prefix(key)
                .map(str::trim)
                .filter(|v| !v.is_empty())
        };
        // "Workflow launched in background. Task ID: abc" is one line.
        let task = line
            .split_once("Task ID:")
            .map(|(_, v)| v.trim())
            .filter(|v| !v.is_empty() && launch.task_id.is_none());
        if let Some(v) = task {
            launch.task_id = Some(
                v.split_whitespace()
                    .next()
                    .unwrap_or(v)
                    .chars()
                    .take(64)
                    .collect(),
            );
        } else if let Some(v) = field("Run ID:") {
            launch.run_id = Some(v.chars().take(64).collect());
        } else if let Some(v) = field("Summary:") {
            summary = Some(v.chars().take(300).collect());
        } else if let Some(v) = field("Transcript dir:") {
            if launch.transcript_dir.is_empty() {
                launch.transcript_dir = v.to_string();
            }
        }
    }
    if launch.transcript_dir.is_empty() {
        return None;
    }
    if launch.run_id.is_none() {
        launch.run_id = Path::new(&launch.transcript_dir)
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|n| is_run_id(n))
            .map(str::to_string);
    }
    Some((launch, summary))
}

fn is_run_id(name: &str) -> bool {
    name.strip_prefix("wf_").is_some_and(|rest| {
        !rest.is_empty()
            && rest.len() <= 64
            && rest
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    })
}

fn is_agent_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Canonicalizes `dir` and checks it is a workflow run directory inside one of the
/// Claude config dirs in `roots`: `<root>/projects/<project>/<session>/subagents/workflows/wf_*`.
pub fn resolve_dir(dir: &str, roots: &[PathBuf]) -> anyhow::Result<PathBuf> {
    let given = Path::new(dir);
    if !given.is_absolute() {
        bail!("the workflow's transcript folder isn't an absolute path");
    }
    let canon = given
        .canonicalize()
        .map_err(|_| anyhow!("the workflow's transcript folder wasn't found"))?;
    for root in roots {
        let Ok(projects) = root.join("projects").canonicalize() else {
            continue;
        };
        let Ok(rel) = canon.strip_prefix(&projects) else {
            continue;
        };
        let names: Vec<&str> = rel
            .components()
            .filter_map(|c| match c {
                Component::Normal(n) => n.to_str(),
                _ => None,
            })
            .collect();
        if names.len() == 5
            && names[2] == "subagents"
            && names[3] == "workflows"
            && is_run_id(names[4])
            && rel.components().count() == 5
        {
            return Ok(canon);
        }
    }
    bail!("the workflow's transcript folder isn't inside this account's Claude projects folder")
}

// ---- progress -----------------------------------------------------------------

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowAgentStatus {
    Working,
    Finished,
    Failed,
    Unknown,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowState {
    /// At least one agent is working, or the run just started / is between phases.
    Running,
    Finished,
    /// Nothing readable, or every agent went quiet without finishing.
    Unknown,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAgent {
    pub id: String,
    pub label: String,
    pub phase: Option<String>,
    pub status: WorkflowAgentStatus,
    /// Tool calls the agent has made so far.
    pub tool_calls: u32,
    /// What it did last, as one short line ("Editing src/lib/x.ts").
    pub latest: Option<String>,
    /// Seconds since its transcript last changed.
    pub idle_secs: Option<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowProgress {
    pub run_id: Option<String>,
    pub state: WorkflowState,
    pub agents: Vec<WorkflowAgent>,
}

/// Per transcript: (bytes already scanned, tool calls counted in them).
fn counts() -> &'static Mutex<HashMap<PathBuf, (u64, u32)>> {
    static COUNTS: OnceLock<Mutex<HashMap<PathBuf, (u64, u32)>>> = OnceLock::new();
    COUNTS.get_or_init(Mutex::default)
}

fn secs_since(now: SystemTime, then: SystemTime) -> u64 {
    now.duration_since(then).map(|d| d.as_secs()).unwrap_or(0)
}

/// Reads at most `cap` bytes from the start of a regular file (never through a symlink).
fn read_capped(path: &Path, cap: u64) -> Option<Vec<u8>> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    let mut buf = Vec::new();
    File::open(path)
        .ok()?
        .take(cap)
        .read_to_end(&mut buf)
        .ok()?;
    Some(buf)
}

/// The last `cap` bytes of a regular file, whole lines only.
fn read_tail(path: &Path, cap: u64) -> Option<Vec<u8>> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(cap);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.take(cap).read_to_end(&mut buf).ok()?;
    if start > 0 {
        // The window starts mid-line: drop the partial first line.
        match buf.iter().position(|b| *b == b'\n') {
            Some(i) => buf.drain(..=i),
            None => buf.drain(..),
        };
    }
    Some(buf)
}

fn short(s: &str) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= MAX_LINE_CHARS {
        return one;
    }
    let cut: String = one.chars().take(MAX_LINE_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

#[derive(Default)]
struct JournalAgent {
    id: String,
    label: Option<String>,
    phase: Option<String>,
    end: Option<WorkflowAgentStatus>,
}

/// What a journal line says about the end of an agent or of the whole run. Observed:
/// `launched`, `started` and `result` (an agent finished); the failure names are best
/// guesses and anything unrecognised is ignored.
fn journal_end(kind: &str) -> Option<WorkflowAgentStatus> {
    match kind {
        "finished" | "completed" | "complete" | "done" | "ended" | "result" | "succeeded" => {
            Some(WorkflowAgentStatus::Finished)
        }
        "failed" | "error" | "errored" | "cancelled" | "canceled" | "aborted" | "killed" => {
            Some(WorkflowAgentStatus::Failed)
        }
        _ => None,
    }
}

/// Journal agents in start order, and whether the journal marks the whole run ended.
fn read_journal(dir: &Path) -> (Vec<JournalAgent>, bool) {
    let mut agents: Vec<JournalAgent> = Vec::new();
    let mut run_ended = false;
    let Some(bytes) = read_capped(&dir.join("journal.jsonl"), JOURNAL_BYTES) else {
        return (agents, run_ended);
    };
    for line in bytes.split(|b| *b == b'\n') {
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let kind = v["type"].as_str().unwrap_or("");
        let id = v["agentId"].as_str().filter(|i| is_agent_id(i));
        match (kind, id) {
            ("started", Some(id)) => {
                if agents.len() < MAX_AGENTS && !agents.iter().any(|a| a.id == id) {
                    agents.push(JournalAgent {
                        id: id.to_string(),
                        label: v["label"].as_str().map(short).filter(|l| !l.is_empty()),
                        phase: v["phase"].as_str().map(short).filter(|l| !l.is_empty()),
                        end: None,
                    });
                }
            }
            (k, Some(id)) => {
                if let (Some(end), Some(a)) =
                    (journal_end(k), agents.iter_mut().find(|a| a.id == id))
                {
                    a.end = Some(end);
                }
            }
            (k, None) => {
                if journal_end(k).is_some() {
                    run_ended = true;
                }
            }
        }
    }
    (agents, run_ended)
}

fn meta_label(dir: &Path, id: &str) -> Option<String> {
    let bytes = read_capped(&dir.join(format!("agent-{id}.meta.json")), META_BYTES)?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v["description"]
        .as_str()
        .or_else(|| v["label"].as_str())
        .map(short)
        .filter(|l| !l.is_empty())
}

/// Agent ids that have a transcript or meta file but are missing from the journal.
fn unlisted_agents(dir: &Path, known: &[JournalAgent]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in entries.flatten() {
        if !e.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(rest) = name.strip_prefix("agent-") else {
            continue;
        };
        let id = rest
            .strip_suffix(".jsonl")
            .or_else(|| rest.strip_suffix(".meta.json"));
        if let Some(id) = id.filter(|i| is_agent_id(i)) {
            if !known.iter().any(|a| a.id == id) && !out.iter().any(|o| o == id) {
                out.push(id.to_string());
            }
        }
    }
    out.sort();
    out.truncate(MAX_AGENTS.saturating_sub(known.len()));
    out
}

/// What the end of a transcript says.
#[derive(Default)]
struct Tail {
    latest: Option<String>,
    /// The newest assistant/user line is an assistant message that ended its turn.
    ended_turn: bool,
    /// It has no tool call in it (the agent is only talking).
    text_only: bool,
    /// It is a tool call whose result hasn't come back.
    pending_tool: bool,
    api_error: bool,
}

fn read_tail_state(path: &Path) -> Tail {
    let mut t = Tail::default();
    let Some(bytes) = read_tail(path, TAIL_BYTES) else {
        return t;
    };
    let mut newest_seen = false;
    let mut cwd: Option<String> = None;
    for line in bytes.rsplit(|b| *b == b'\n') {
        if t.latest.is_some() && newest_seen {
            break;
        }
        // Skip the huge request blobs without parsing them.
        if line.is_empty() || find(line, b"\"type\":\"api-request") {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let kind = v["type"].as_str().unwrap_or("");
        if kind != "assistant" && kind != "user" {
            continue;
        }
        cwd = cwd.or_else(|| v["cwd"].as_str().map(str::to_string));
        if !newest_seen {
            newest_seen = true;
            if kind == "assistant" {
                let m = &v["message"];
                let blocks = m["content"].as_array();
                let has_tool = blocks.is_some_and(|b| b.iter().any(|c| c["type"] == "tool_use"));
                t.text_only = !has_tool;
                t.pending_tool = has_tool;
                t.ended_turn = matches!(
                    m["stop_reason"].as_str(),
                    Some("end_turn" | "stop_sequence" | "max_tokens")
                );
                t.api_error = v["isApiErrorMessage"].as_bool() == Some(true);
            }
        }
        if kind == "assistant" && t.latest.is_none() {
            if let Some(blocks) = v["message"]["content"].as_array() {
                if let Some(call) = blocks.iter().rev().find(|c| c["type"] == "tool_use") {
                    t.latest = Some(describe_tool(
                        call["name"].as_str().unwrap_or(""),
                        &call["input"],
                        cwd.as_deref().or_else(|| v["cwd"].as_str()),
                    ));
                } else if blocks.iter().any(|c| c["type"] == "text") && t.text_only {
                    t.latest = Some("Writing a reply".into());
                }
            }
        }
    }
    t
}

fn find(hay: &[u8], needle: &[u8]) -> bool {
    needle.len() <= hay.len() && hay.windows(needle.len()).any(|w| w == needle)
}

/// `path` relative to the agent's working directory when it is inside it, else its tail.
fn short_path(p: &str, cwd: Option<&str>) -> String {
    let rel = cwd
        .and_then(|c| p.strip_prefix(c.trim_end_matches('/')))
        .map(|r| r.trim_start_matches('/'))
        .filter(|r| !r.is_empty());
    match rel {
        Some(r) => short(r),
        None => {
            let parts: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();
            let from = parts.len().saturating_sub(3);
            short(&parts[from..].join("/"))
        }
    }
}

/// One tool call as a short sentence. Only the tool's name and the one argument that
/// says what it is doing (path, pattern, command line) are used; bodies never are.
fn describe_tool(name: &str, input: &Value, cwd: Option<&str>) -> String {
    let s = |k: &str| input[k].as_str().unwrap_or("").trim();
    let path = || {
        let p = s("file_path");
        let p = if p.is_empty() { s("notebook_path") } else { p };
        short_path(p, cwd)
    };
    match name {
        "Edit" | "MultiEdit" | "NotebookEdit" => format!("Editing {}", path()),
        "Write" => format!("Writing {}", path()),
        "Read" => format!("Reading {}", path()),
        "Grep" => format!("Searching for {}", short(s("pattern"))),
        "Glob" => format!("Finding files {}", short(s("pattern"))),
        "Bash" => {
            let cmd = s("command");
            // "cd <dir> && cargo test": the cd is noise.
            let cmd = cmd
                .strip_prefix("cd ")
                .and_then(|r| r.split_once("&&").or_else(|| r.split_once(';')))
                .map(|(_, rest)| rest.trim())
                .unwrap_or(cmd);
            let first = cmd.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
            if first.is_empty() {
                let d = s("description");
                if d.is_empty() {
                    "Running a command".into()
                } else {
                    short(&crate::redact::redact_secrets(d))
                }
            } else {
                format!("Running {}", short(&crate::redact::redact_secrets(first)))
            }
        }
        "Agent" | "Task" => {
            let d = s("description");
            if d.is_empty() {
                "Delegating to a sub-agent".into()
            } else {
                format!("Delegating: {}", short(d))
            }
        }
        "WebFetch" => "Fetching a web page".into(),
        "WebSearch" => "Searching the web".into(),
        "TodoWrite" | "TaskCreate" | "TaskUpdate" => "Updating its to-do list".into(),
        "" => "Working".into(),
        other => match other.strip_prefix("mcp__") {
            Some(rest) => format!("Using {}", short(rest.rsplit("__").next().unwrap_or(rest))),
            None => format!("Using {}", short(other)),
        },
    }
}

/// Counts tool calls in a chunk of transcript bytes (complete lines).
fn tool_calls_in(chunk: &[u8]) -> u32 {
    let mut n = 0;
    for line in chunk.split(|b| *b == b'\n') {
        if !find(line, b"\"type\":\"tool_use\"") || find(line, b"\"type\":\"api-request") {
            continue;
        }
        if let Ok(v) = serde_json::from_slice::<Value>(line) {
            if v["type"] == "assistant" {
                n += v["message"]["content"].as_array().map_or(0, |b| {
                    b.iter().filter(|c| c["type"] == "tool_use").count() as u32
                });
            }
        }
    }
    n
}

/// Tool calls so far: counted incrementally (at most [`SCAN_BYTES`] of new data per
/// call; a very large transcript catches up over a few calls).
fn count_calls(path: &Path, len: u64) -> u32 {
    let (mut offset, mut calls) = counts().lock().get(path).copied().unwrap_or((0, 0));
    if len < offset {
        (offset, calls) = (0, 0);
    }
    let want = (len - offset).min(SCAN_BYTES);
    if want > 0 {
        let mut buf = Vec::new();
        let read = File::open(path).ok().and_then(|mut f| {
            f.seek(SeekFrom::Start(offset)).ok()?;
            f.take(want).read_to_end(&mut buf).ok()
        });
        if read.is_some() {
            let end = match buf.iter().rposition(|b| *b == b'\n') {
                Some(i) => i + 1,
                // One line bigger than the scan window: skip it rather than stall.
                None if want == SCAN_BYTES => buf.len(),
                None => 0,
            };
            calls = calls.saturating_add(tool_calls_in(&buf[..end]));
            offset += end as u64;
        }
    }
    let mut map = counts().lock();
    if map.len() > 512 {
        map.clear();
    }
    map.insert(path.to_path_buf(), (offset, calls));
    calls
}

fn agent_status(
    tail: &Tail,
    journal_end: Option<WorkflowAgentStatus>,
    idle: Option<u64>,
) -> WorkflowAgentStatus {
    if let Some(end) = journal_end {
        return end;
    }
    let Some(idle) = idle else {
        return WorkflowAgentStatus::Unknown;
    };
    if tail.api_error && idle >= TALKED_SECS {
        return WorkflowAgentStatus::Failed;
    }
    if (tail.ended_turn && !tail.pending_tool) || (tail.text_only && idle >= TALKED_SECS) {
        return WorkflowAgentStatus::Finished;
    }
    let limit = if tail.pending_tool {
        QUIET_PENDING_SECS
    } else {
        QUIET_SECS
    };
    if idle > limit {
        WorkflowAgentStatus::Unknown
    } else {
        WorkflowAgentStatus::Working
    }
}

/// Reads a (validated, see [`resolve_dir`]) run directory.
pub fn progress(dir: &Path, now: SystemTime) -> WorkflowProgress {
    let run_id = dir
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| is_run_id(n))
        .map(str::to_string);
    let (listed, run_ended) = read_journal(dir);
    let mut ids: Vec<JournalAgent> = listed;
    for id in unlisted_agents(dir, &ids) {
        ids.push(JournalAgent {
            id,
            ..Default::default()
        });
    }
    let mut newest_activity: Option<SystemTime> =
        std::fs::symlink_metadata(dir.join("journal.jsonl"))
            .ok()
            .and_then(|m| m.modified().ok());
    let mut agents = Vec::new();
    for j in ids {
        let path = dir.join(format!("agent-{}.jsonl", j.id));
        let meta = std::fs::symlink_metadata(&path)
            .ok()
            .filter(|m| m.file_type().is_file());
        let modified = meta.as_ref().and_then(|m| m.modified().ok());
        if let Some(m) = modified {
            newest_activity = Some(newest_activity.map_or(m, |n| n.max(m)));
        }
        let idle = modified.map(|m| secs_since(now, m));
        let tail = match &meta {
            Some(_) => read_tail_state(&path),
            None => Tail::default(),
        };
        let tool_calls = meta.as_ref().map_or(0, |m| count_calls(&path, m.len()));
        let status = agent_status(&tail, j.end, idle);
        agents.push(WorkflowAgent {
            label: j
                .label
                .or_else(|| meta_label(dir, &j.id))
                .unwrap_or_else(|| format!("Agent {}", j.id.chars().take(6).collect::<String>())),
            phase: j.phase,
            id: j.id,
            status,
            tool_calls,
            // A finished agent has no "latest action" any more.
            latest: tail.latest.filter(|_| {
                matches!(
                    status,
                    WorkflowAgentStatus::Working | WorkflowAgentStatus::Unknown
                )
            }),
            idle_secs: idle,
        });
    }
    let working = agents
        .iter()
        .any(|a| a.status == WorkflowAgentStatus::Working);
    let quiet = newest_activity.map(|n| secs_since(now, n));
    let any_done = agents.iter().any(|a| {
        matches!(
            a.status,
            WorkflowAgentStatus::Finished | WorkflowAgentStatus::Failed
        )
    });
    let state = if run_ended && !working {
        WorkflowState::Finished
    } else if working {
        WorkflowState::Running
    } else if agents.is_empty() {
        match quiet {
            Some(q) if q <= STARTING_SECS => WorkflowState::Running,
            _ => WorkflowState::Unknown,
        }
    } else if any_done {
        // All done (or gone quiet): finished once nothing has moved for a while.
        match quiet {
            Some(q) if q < SETTLE_SECS => WorkflowState::Running,
            _ => WorkflowState::Finished,
        }
    } else {
        WorkflowState::Unknown
    };
    WorkflowProgress {
        run_id,
        state,
        agents,
    }
}

/// The Claude config dirs a run may live in: the account's own, or for the system
/// account `CLAUDE_CONFIG_DIR` and `~/.claude`.
pub fn config_roots(account_config_dir: Option<&str>) -> Vec<PathBuf> {
    if let Some(dir) = account_config_dir.filter(|d| !d.is_empty()) {
        return vec![PathBuf::from(dir)];
    }
    let mut roots = Vec::new();
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        roots.push(PathBuf::from(dir));
    }
    if let Some(home) = crate::providers::home_dir() {
        roots.push(home.join(".claude"));
    }
    roots
}

/// [`resolve_dir`] + [`progress`] at the current time.
pub fn progress_for(
    launch: &WorkflowLaunch,
    roots: &[PathBuf],
) -> anyhow::Result<WorkflowProgress> {
    let dir = resolve_dir(&launch.transcript_dir, roots)?;
    Ok(progress(&dir, SystemTime::now()))
}

// ---- the turn ends while a run goes on ------------------------------------------------

/// How the "turn ended" alert starts when work the agent launched is still running. The UI
/// recognises it (`TURN_ONLY_PREFIX` in `lib/background.ts`), so keep the two in step.
pub const TURN_ONLY_PREFIX: &str = "Finished its turn.";

/// Only runs launched this recently are asked about at a turn's end.
const LAUNCH_MAX_AGE_MS: i64 = 12 * 3600 * 1000;
/// ... and at most this many of an agent's newest.
const LAUNCH_MAX: usize = 3;

/// What is known about one launched run when its agent's turn ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchedRun {
    /// Its folder says it is running, with this many agents so far.
    Running { agents: usize },
    /// Launched during the turn, but its folder can't be read: it may well be running.
    Unreadable,
}

/// The agent's newest Workflow launches among `items` (newest first), each flagged when it
/// happened at or after `turn_started_at`; ones older than 12 hours are left out.
pub fn recent_launches<'a>(
    items: impl Iterator<Item = &'a TimelineItem>,
    turn_started_at: i64,
    now_ms: i64,
) -> Vec<(WorkflowLaunch, bool)> {
    let mut found: Vec<(i64, &WorkflowLaunch, bool)> = items
        .filter_map(|it| match &it.body {
            ItemBody::ToolCall {
                subagent:
                    Some(SubAgent {
                        workflow: Some(launch),
                        ..
                    }),
                ..
            } if now_ms - it.ts < LAUNCH_MAX_AGE_MS => {
                Some((it.seq, &**launch, it.ts >= turn_started_at))
            }
            _ => None,
        })
        .collect();
    found.sort_by_key(|(seq, _, _)| std::cmp::Reverse(*seq));
    found
        .into_iter()
        .take(LAUNCH_MAX)
        .map(|(_, l, this_turn)| (l.clone(), this_turn))
        .collect()
}

/// What a read of a launched run means at a turn's end. Only a run that says `Running` is
/// claimed; a finished or quiet one is not, and a folder that can't be read counts (softly)
/// only for a run launched in the turn that just ended.
pub fn launched_run(
    read: &anyhow::Result<WorkflowProgress>,
    launched_this_turn: bool,
) -> Option<LaunchedRun> {
    match read {
        Ok(p) if p.state == WorkflowState::Running => Some(LaunchedRun::Running {
            agents: p.agents.len(),
        }),
        Ok(_) => None,
        Err(_) if launched_this_turn => Some(LaunchedRun::Unreadable),
        Err(_) => None,
    }
}

/// The body of the "turn ended" alert when launched work is still going, so it never reads as
/// "done": "Finished its turn. A workflow is still running (5 agents)." Runs that can't be
/// read say "may still be running". `None`: nothing is known to run.
pub fn turn_end_body(runs: &[LaunchedRun]) -> Option<String> {
    let mut known = 0;
    let mut agents = 0;
    let mut unreadable = 0;
    for r in runs {
        match r {
            LaunchedRun::Running { agents: n } => {
                known += 1;
                agents += n;
            }
            LaunchedRun::Unreadable => unreadable += 1,
        }
    }
    let plural = |n: usize, one: &str, many: &str| {
        if n == 1 {
            one.to_string()
        } else {
            many.to_string()
        }
    };
    if known > 0 {
        let subject = if known == 1 {
            "A workflow is".to_string()
        } else {
            format!("{known} workflows are")
        };
        let count = match agents {
            0 => String::new(),
            n => format!(" ({n} {})", plural(n, "agent", "agents")),
        };
        return Some(format!(
            "{TURN_ONLY_PREFIX} {subject} still running{count}."
        ));
    }
    (unreadable > 0).then(|| {
        let subject = plural(unreadable, "A workflow may", "Workflows may");
        format!("{TURN_ONLY_PREFIX} {subject} still be running.")
    })
}

/// The body of the "work finished" alert: the interface's own one-line summary of the run (what it
/// was and how it ended) when it sent one, else the generic line. One line, shortened, secrets removed.
pub fn finished_alert_body(agents: Option<u32>, detail: Option<&str>) -> String {
    let line = detail
        .map(|d| d.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|d| !d.is_empty());
    match line {
        Some(d) => {
            let d = crate::redact::redact_secrets(&d).into_owned();
            if d.chars().count() > 240 {
                format!("{}…", d.chars().take(239).collect::<String>())
            } else {
                d
            }
        }
        None => everything_finished_body(agents),
    }
}

/// The body of the quiet alert sent when an agent's last launched work ended after its turn did.
pub fn everything_finished_body(agents: Option<u32>) -> String {
    match agents {
        Some(n) if n > 0 => format!(
            "Everything finished. Its workflow ({n} {}) is done.",
            if n == 1 { "agent" } else { "agents" }
        ),
        _ => "Everything finished. Its workflow is done.".to_string(),
    }
}

#[cfg(test)]
#[path = "workflow_tests.rs"]
mod tests;
