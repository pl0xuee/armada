use super::*;
use std::time::Duration;

struct Tmp(PathBuf);
impl Tmp {
    fn new() -> Tmp {
        let p = std::env::temp_dir().join(format!("kvistcode-wf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p.canonicalize().unwrap())
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `<tmp>/cfg/projects/-proj/sess/subagents/workflows/wf_abc-123`, with the config dir.
fn run_dir(tmp: &Tmp) -> (PathBuf, PathBuf) {
    let cfg = tmp.0.join("cfg");
    let dir = cfg.join("projects/-proj/sess/subagents/workflows/wf_abc-123");
    std::fs::create_dir_all(&dir).unwrap();
    (cfg, dir)
}

fn jl(lines: &[Value]) -> String {
    lines.iter().map(|l| format!("{l}\n")).collect()
}

fn tool_use(name: &str, input: Value, stop: &str) -> Value {
    json!({"type": "assistant", "cwd": "/work/wt-1", "message": {"role": "assistant",
        "stop_reason": stop, "content": [{"type": "tool_use", "id": "t", "name": name, "input": input}]}})
}

fn text(role: &str, stop: &str, t: &str) -> Value {
    json!({"type": role, "cwd": "/work/wt-1", "message": {"role": role, "stop_reason": stop,
        "content": [{"type": "text", "text": t}]}})
}

fn result() -> Value {
    json!({"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "t", "content": "SECRET-OUTPUT"}]}})
}

fn write(dir: &Path, name: &str, body: &str) {
    std::fs::write(dir.join(name), body).unwrap();
}

fn age(path: &Path, secs: u64) {
    let f = File::options().write(true).open(path).unwrap();
    f.set_modified(SystemTime::now() - Duration::from_secs(secs))
        .unwrap();
}

use serde_json::json;

const LAUNCH: &str = "Workflow launched in background. Task ID: w4cpfsvul\nSummary: Five parallel agents build things\nTranscript dir: /home/x/.claude/projects/-p/sess/subagents/workflows/wf_d5cc071f-a40\nScript file: /x/s.js\nRun ID: wf_d5cc071f-a40\nYou will be notified when it completes.";

#[test]
fn launch_output_is_parsed() {
    let (l, summary) = parse_launch(LAUNCH).unwrap();
    assert_eq!(l.task_id.as_deref(), Some("w4cpfsvul"));
    assert_eq!(l.run_id.as_deref(), Some("wf_d5cc071f-a40"));
    assert_eq!(
        l.transcript_dir,
        "/home/x/.claude/projects/-p/sess/subagents/workflows/wf_d5cc071f-a40"
    );
    assert_eq!(
        summary.as_deref(),
        Some("Five parallel agents build things")
    );
}

#[test]
fn run_id_falls_back_to_the_directory_name() {
    let out = "Workflow launched in background. Task ID: t1\nTranscript dir: /a/b/wf_zz-1";
    assert_eq!(
        parse_launch(out).unwrap().0.run_id.as_deref(),
        Some("wf_zz-1")
    );
}

#[test]
fn anything_else_is_not_a_launch() {
    assert!(parse_launch("").is_none());
    assert!(parse_launch("Workflow failed: bad script").is_none());
    // A launch without a transcript folder can't be followed.
    assert!(parse_launch("Workflow launched in background. Task ID: t1").is_none());
}

#[test]
fn directory_must_be_a_run_inside_the_projects_tree() {
    let tmp = Tmp::new();
    let (cfg, dir) = run_dir(&tmp);
    let roots = vec![cfg.clone()];
    assert_eq!(resolve_dir(dir.to_str().unwrap(), &roots).unwrap(), dir);

    // Relative, missing, and not a run id.
    assert!(resolve_dir("projects/-proj", &roots).is_err());
    assert!(resolve_dir(cfg.join("nope").to_str().unwrap(), &roots).is_err());
    let not_run = cfg.join("projects/-proj/sess/subagents/workflows/other");
    std::fs::create_dir_all(&not_run).unwrap();
    assert!(resolve_dir(not_run.to_str().unwrap(), &roots).is_err());
    // Too shallow / too deep.
    let shallow = cfg.join("projects/-proj/sess");
    assert!(resolve_dir(shallow.to_str().unwrap(), &roots).is_err());
    let deep = dir.join("wf_inner-1");
    std::fs::create_dir_all(&deep).unwrap();
    assert!(resolve_dir(deep.to_str().unwrap(), &roots).is_err());
    // A run-shaped folder under another root is refused.
    let other = Tmp::new();
    let (_, foreign) = run_dir(&other);
    assert!(resolve_dir(foreign.to_str().unwrap(), &roots).is_err());
    // No roots, nothing allowed.
    assert!(resolve_dir(dir.to_str().unwrap(), &[]).is_err());
}

#[test]
fn dot_dot_cannot_climb_out() {
    let tmp = Tmp::new();
    let (cfg, dir) = run_dir(&tmp);
    let roots = vec![cfg.clone()];
    // Lexically under the run dir, really somewhere else.
    let outside = tmp.0.join("outside/projects/a/b/subagents/workflows/wf_x");
    std::fs::create_dir_all(&outside).unwrap();
    let sneaky = format!(
        "{}/../../../../../../../../outside/projects/a/b/subagents/workflows/wf_x",
        dir.display()
    );
    assert!(resolve_dir(&sneaky, &roots).is_err());
    let up = format!("{}/../../..", dir.display());
    assert!(resolve_dir(&up, &roots).is_err());
}

#[cfg(unix)]
#[test]
fn symlinked_run_dir_out_of_the_tree_is_refused() {
    let tmp = Tmp::new();
    let (cfg, dir) = run_dir(&tmp);
    let outside = tmp.0.join("elsewhere/wf_evil-1");
    std::fs::create_dir_all(&outside).unwrap();
    let link = dir.parent().unwrap().join("wf_link-1");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    assert!(resolve_dir(link.to_str().unwrap(), &[cfg]).is_err());
}

#[cfg(unix)]
#[test]
fn symlinked_files_are_never_followed() {
    let tmp = Tmp::new();
    let (_, dir) = run_dir(&tmp);
    let secret = tmp.0.join("secret.jsonl");
    std::fs::write(
        &secret,
        jl(&[tool_use(
            "Bash",
            json!({"command": "echo LEAKED"}),
            "tool_use",
        )]),
    )
    .unwrap();
    std::os::unix::fs::symlink(&secret, dir.join("agent-a1.jsonl")).unwrap();
    let meta = tmp.0.join("meta.json");
    std::fs::write(&meta, r#"{"description":"LEAKED-LABEL"}"#).unwrap();
    std::os::unix::fs::symlink(&meta, dir.join("agent-a1.meta.json")).unwrap();
    let journal = tmp.0.join("journal.jsonl");
    std::fs::write(
        &journal,
        r#"{"type":"started","agentId":"a1","label":"LEAKED-J"}"#,
    )
    .unwrap();
    std::os::unix::fs::symlink(&journal, dir.join("journal.jsonl")).unwrap();

    let p = progress(&dir, SystemTime::now());
    let json = serde_json::to_string(&p).unwrap();
    assert!(!json.contains("LEAKED"), "{json}");
    assert!(p
        .agents
        .iter()
        .all(|a| a.tool_calls == 0 && a.latest.is_none()));
}

#[test]
fn working_agent_shows_its_latest_action_and_count() {
    let tmp = Tmp::new();
    let (_, dir) = run_dir(&tmp);
    write(
        &dir,
        "journal.jsonl",
        &jl(&[
            json!({"type": "launched"}),
            json!({"type": "started", "agentId": "a1", "label": "build:phone", "phase": "Build"}),
        ]),
    );
    write(
        &dir,
        "agent-a1.jsonl",
        &jl(&[
            json!({"type": "user", "message": {"role": "user", "content": "SECRET-PROMPT do things"}}),
            json!({"type": "api-request-blob", "message": {"role": "system", "content": "SECRET-BLOB"}}),
            tool_use(
                "Read",
                json!({"file_path": "/work/wt-1/src/a.rs"}),
                "tool_use",
            ),
            result(),
            tool_use(
                "Edit",
                json!({"file_path": "/work/wt-1/src/lib/x.ts", "old_string": "SECRET-OLD", "new_string": "SECRET-NEW"}),
                "tool_use",
            ),
        ]),
    );
    let p = progress(&dir, SystemTime::now());
    assert_eq!(p.run_id.as_deref(), Some("wf_abc-123"));
    assert_eq!(p.state, WorkflowState::Running);
    let a = &p.agents[0];
    assert_eq!(a.label, "build:phone");
    assert_eq!(a.phase.as_deref(), Some("Build"));
    assert_eq!(a.status, WorkflowAgentStatus::Working);
    assert_eq!(a.tool_calls, 2);
    assert_eq!(a.latest.as_deref(), Some("Editing src/lib/x.ts"));
    assert!(a.idle_secs.unwrap() < 5);
    let json = serde_json::to_string(&p).unwrap();
    assert!(!json.contains("SECRET"), "{json}");
}

#[test]
fn bash_is_described_by_its_command_without_the_cd_or_secrets() {
    let d = |cmd: &str| describe_tool("Bash", &json!({ "command": cmd }), None);
    assert_eq!(
        d("cd /work/wt-1 && cargo test --workspace"),
        "Running cargo test --workspace"
    );
    assert_eq!(d("git status\ngit diff"), "Running git status");
    let long = d(&format!("echo {}", "x".repeat(300)));
    assert!(
        long.chars().count() <= MAX_LINE_CHARS + "Running ".len(),
        "{long}"
    );
    assert!(!d(
        "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' x"
    )
    .contains("abcdefghijklmnopqrstuvwxyz0123456789"));
    assert_eq!(
        describe_tool("Grep", &json!({"pattern": "fn main"}), None),
        "Searching for fn main"
    );
    assert_eq!(
        describe_tool("mcp__srv__lookup", &json!({}), None),
        "Using lookup"
    );
    assert_eq!(
        describe_tool("Write", &json!({"file_path": "/a/b/c/d/e.rs"}), None),
        "Writing c/d/e.rs"
    );
}

#[test]
fn finished_when_the_last_message_ended_the_turn() {
    let tmp = Tmp::new();
    let (_, dir) = run_dir(&tmp);
    write(
        &dir,
        "journal.jsonl",
        &jl(&[
            json!({"type": "started", "agentId": "a1", "label": "one"}),
            json!({"type": "started", "agentId": "a2", "label": "two"}),
        ]),
    );
    write(
        &dir,
        "agent-a1.jsonl",
        &jl(&[
            tool_use("Bash", json!({"command": "ls"}), "tool_use"),
            result(),
            text("assistant", "end_turn", "All done."),
        ]),
    );
    write(
        &dir,
        "agent-a2.jsonl",
        &jl(&[tool_use("Bash", json!({"command": "ls"}), "tool_use")]),
    );
    let p = progress(&dir, SystemTime::now());
    assert_eq!(p.agents[0].status, WorkflowAgentStatus::Finished);
    assert!(p.agents[0].latest.is_none());
    assert_eq!(p.agents[1].status, WorkflowAgentStatus::Working);
    assert_eq!(p.state, WorkflowState::Running);
}

#[test]
fn run_finishes_only_after_everything_settled() {
    let tmp = Tmp::new();
    let (_, dir) = run_dir(&tmp);
    write(
        &dir,
        "journal.jsonl",
        &jl(&[json!({"type": "started", "agentId": "a1", "label": "one"})]),
    );
    write(
        &dir,
        "agent-a1.jsonl",
        &jl(&[text("assistant", "end_turn", "done")]),
    );
    // Just finished: a next phase might still start.
    assert_eq!(
        progress(&dir, SystemTime::now()).state,
        WorkflowState::Running
    );
    age(&dir.join("agent-a1.jsonl"), SETTLE_SECS + 30);
    age(&dir.join("journal.jsonl"), SETTLE_SECS + 30);
    let p = progress(&dir, SystemTime::now());
    assert_eq!(p.state, WorkflowState::Finished);
    assert_eq!(p.agents[0].status, WorkflowAgentStatus::Finished);
}

#[test]
fn quiet_agents_are_unknown_not_finished() {
    let tmp = Tmp::new();
    let (_, dir) = run_dir(&tmp);
    write(
        &dir,
        "journal.jsonl",
        &jl(&[json!({"type": "started", "agentId": "a1", "label": "one"})]),
    );
    write(
        &dir,
        "agent-a1.jsonl",
        &jl(&[
            tool_use("Read", json!({"file_path": "/x"}), "tool_use"),
            result(),
        ]),
    );
    age(&dir.join("agent-a1.jsonl"), QUIET_SECS + 60);
    age(&dir.join("journal.jsonl"), QUIET_SECS + 60);
    let p = progress(&dir, SystemTime::now());
    assert_eq!(p.agents[0].status, WorkflowAgentStatus::Unknown);
    assert_eq!(p.state, WorkflowState::Unknown);
}

#[test]
fn journal_end_events_and_agents_missing_from_the_journal() {
    let tmp = Tmp::new();
    let (_, dir) = run_dir(&tmp);
    write(
        &dir,
        "journal.jsonl",
        &jl(&[
            json!({"type": "started", "agentId": "a1", "label": "one"}),
            json!({"type": "failed", "agentId": "a1"}),
            json!({"type": "started", "agentId": "a3", "label": "three"}),
            // What Claude Code writes when an agent is done; the report is never read out.
            json!({"type": "result", "agentId": "a3", "result": "SECRET-REPORT", "toolsUsed": 3}),
        ]),
    );
    write(
        &dir,
        "agent-a1.jsonl",
        &jl(&[tool_use("Read", json!({}), "tool_use")]),
    );
    write(
        &dir,
        "agent-a3.jsonl",
        &jl(&[tool_use("Read", json!({}), "tool_use")]),
    );
    // Not in the journal: labelled from its meta file.
    write(&dir, "agent-b2.meta.json", r#"{"description":"from-meta"}"#);
    write(
        &dir,
        "agent-b2.jsonl",
        &jl(&[tool_use("Read", json!({}), "tool_use")]),
    );
    // Odd file names are ignored.
    write(&dir, "agent-a b.jsonl", "");
    let p = progress(&dir, SystemTime::now());
    assert_eq!(p.agents.len(), 3);
    assert_eq!(p.agents[0].status, WorkflowAgentStatus::Failed);
    assert_eq!(p.agents[1].status, WorkflowAgentStatus::Finished);
    assert_eq!(p.agents[2].label, "from-meta");
    assert_eq!(p.agents[2].status, WorkflowAgentStatus::Working);
    assert!(!serde_json::to_string(&p).unwrap().contains("SECRET"));
}

#[test]
fn fresh_run_dir_without_agents_is_starting() {
    let tmp = Tmp::new();
    let (_, dir) = run_dir(&tmp);
    write(&dir, "journal.jsonl", &jl(&[json!({"type": "launched"})]));
    let p = progress(&dir, SystemTime::now());
    assert!(p.agents.is_empty());
    assert_eq!(p.state, WorkflowState::Running);
    age(&dir.join("journal.jsonl"), STARTING_SECS + 60);
    assert_eq!(
        progress(&dir, SystemTime::now()).state,
        WorkflowState::Unknown
    );
}

#[test]
fn big_transcripts_are_read_from_the_tail_and_counted_incrementally() {
    let tmp = Tmp::new();
    let (_, dir) = run_dir(&tmp);
    write(
        &dir,
        "journal.jsonl",
        &jl(&[json!({"type": "started", "agentId": "a1", "label": "big"})]),
    );
    let path = dir.join("agent-a1.jsonl");
    let pad = "p".repeat(2000);
    let mut body = String::new();
    // A huge first line (cut mid-way by the tail window), then ~800 KB of calls.
    body.push_str(&jl(&[
        json!({"type": "api-request-blob", "blob": "z".repeat(300_000)}),
    ]));
    for i in 0..400 {
        body.push_str(&jl(&[tool_use(
            "Read",
            json!({"file_path": format!("/work/wt-1/f{i}.rs"), "pad": pad}),
            "tool_use",
        )]));
    }
    write(&dir, "agent-a1.jsonl", &body);
    assert!(std::fs::metadata(&path).unwrap().len() > 2 * TAIL_BYTES);
    let p = progress(&dir, SystemTime::now());
    assert_eq!(p.agents[0].tool_calls, 400);
    assert_eq!(p.agents[0].latest.as_deref(), Some("Reading f399.rs"));
    // Appending is picked up without a rescan from the start.
    let mut more = body.clone();
    more.push_str(&jl(&[tool_use(
        "Bash",
        json!({"command": "cargo test"}),
        "tool_use",
    )]));
    write(&dir, "agent-a1.jsonl", &more);
    let p = progress(&dir, SystemTime::now());
    assert_eq!(p.agents[0].tool_calls, 401);
    assert_eq!(p.agents[0].latest.as_deref(), Some("Running cargo test"));
}

// ---- the turn ends while a run goes on ----------------------------------------------

fn run_progress(state: WorkflowState, agents: usize) -> anyhow::Result<WorkflowProgress> {
    Ok(WorkflowProgress {
        run_id: None,
        state,
        agents: (0..agents)
            .map(|i| WorkflowAgent {
                id: format!("a{i}"),
                label: format!("a{i}"),
                phase: None,
                status: WorkflowAgentStatus::Working,
                tool_calls: 0,
                latest: None,
                idle_secs: None,
            })
            .collect(),
    })
}

#[test]
fn a_running_workflow_is_named_in_the_turn_end_text() {
    let one = [LaunchedRun::Running { agents: 5 }];
    assert_eq!(
        turn_end_body(&one).as_deref(),
        Some("Finished its turn. A workflow is still running (5 agents).")
    );
    let single = [LaunchedRun::Running { agents: 1 }];
    assert_eq!(
        turn_end_body(&single).as_deref(),
        Some("Finished its turn. A workflow is still running (1 agent).")
    );
    let starting = [LaunchedRun::Running { agents: 0 }];
    assert_eq!(
        turn_end_body(&starting).as_deref(),
        Some("Finished its turn. A workflow is still running.")
    );
    let two = [
        LaunchedRun::Running { agents: 3 },
        LaunchedRun::Running { agents: 2 },
    ];
    assert_eq!(
        turn_end_body(&two).as_deref(),
        Some("Finished its turn. 2 workflows are still running (5 agents).")
    );
}

#[test]
fn an_unreadable_run_only_may_still_be_running() {
    let maybe = [LaunchedRun::Unreadable];
    assert_eq!(
        turn_end_body(&maybe).as_deref(),
        Some("Finished its turn. A workflow may still be running.")
    );
    // A run that is known to run wins over one that can't be read.
    let mixed = [LaunchedRun::Unreadable, LaunchedRun::Running { agents: 2 }];
    assert_eq!(
        turn_end_body(&mixed).as_deref(),
        Some("Finished its turn. A workflow is still running (2 agents).")
    );
    assert!(turn_end_body(&[]).is_none());
    assert!(turn_end_body(&maybe).unwrap().starts_with(TURN_ONLY_PREFIX));
}

#[test]
fn only_a_run_that_says_running_is_claimed() {
    let running = run_progress(WorkflowState::Running, 4);
    assert_eq!(
        launched_run(&running, false),
        Some(LaunchedRun::Running { agents: 4 })
    );
    // Finished and quiet runs are not claimed.
    assert_eq!(
        launched_run(&run_progress(WorkflowState::Finished, 4), true),
        None
    );
    assert_eq!(
        launched_run(&run_progress(WorkflowState::Unknown, 4), true),
        None
    );
    // A folder that can't be read counts only for a run launched in this turn.
    let err: anyhow::Result<WorkflowProgress> = Err(anyhow!("not allowed"));
    assert_eq!(launched_run(&err, true), Some(LaunchedRun::Unreadable));
    assert_eq!(launched_run(&err, false), None);
}

fn launch_item(id: &str, seq: i64, ts: i64, workflow: bool) -> TimelineItem {
    TimelineItem {
        id: id.into(),
        agent_id: "a".into(),
        seq,
        ts,
        body: ItemBody::ToolCall {
            tool_call_id: id.into(),
            title: "Workflow".into(),
            tool_kind: crate::model::ToolKind::Think,
            status: crate::model::ToolStatus::Completed,
            locations: Vec::new(),
            diffs: Vec::new(),
            output: String::new(),
            command: None,
            images: Vec::new(),
            subagent: workflow.then(|| SubAgent {
                kind: Some("workflow".into()),
                workflow: Some(Box::new(WorkflowLaunch {
                    transcript_dir: format!("/x/{id}"),
                    ..Default::default()
                })),
                ..SubAgent::default()
            }),
            parent_tool_call_id: None,
        },
    }
}

#[test]
fn recent_launches_are_the_newest_few_and_flag_this_turn() {
    let now = 100 * 3600 * 1000;
    let items = [
        launch_item("ancient", 1, now - 20 * 3600 * 1000, true),
        launch_item("w1", 2, now - 5000, true),
        launch_item("plain", 3, now - 4000, false),
        launch_item("w2", 4, now - 2000, true),
        launch_item("w3", 5, now - 1000, true),
        launch_item("w4", 6, now - 500, true),
    ];
    let found = recent_launches(items.iter(), now - 1500, now);
    let dirs: Vec<_> = found
        .iter()
        .map(|(l, t)| (l.transcript_dir.as_str(), *t))
        .collect();
    assert_eq!(dirs, [("/x/w4", true), ("/x/w3", true), ("/x/w2", false)]);
    assert!(recent_launches(std::iter::empty(), 0, now).is_empty());
}

#[test]
fn the_quiet_finished_alert_names_what_ended() {
    assert_eq!(
        everything_finished_body(Some(5)),
        "Everything finished. Its workflow (5 agents) is done."
    );
    assert_eq!(
        everything_finished_body(Some(1)),
        "Everything finished. Its workflow (1 agent) is done."
    );
    assert_eq!(
        everything_finished_body(None),
        "Everything finished. Its workflow is done."
    );
}

#[test]
fn the_finished_alert_says_what_finished_and_is_one_short_clean_line() {
    let said = finished_alert_body(
        Some(5),
        Some("Workflow finished: “Review”.\n All 5 agents completed."),
        Some("ignored: the interface already said what finished"),
    );
    assert_eq!(said, "Workflow finished: “Review”. All 5 agents completed.");
    // No detail and nothing said: the generic line.
    assert_eq!(
        finished_alert_body(Some(5), None, None),
        "Everything finished. Its workflow (5 agents) is done."
    );
    assert_eq!(
        finished_alert_body(None, Some("   "), Some("  ")),
        "Everything finished. Its workflow is done."
    );
    let long = finished_alert_body(None, Some(&"word ".repeat(200)), None);
    assert!(long.chars().count() <= 240 && long.ends_with('…'));
}

#[test]
fn a_finished_alert_without_a_summary_says_what_the_agent_last_said() {
    assert_eq!(
        finished_alert_body(
            None,
            None,
            Some("Launched five reviewers\non the login flow.")
        ),
        "Everything finished. Its workflow is done. Last message: “Launched five reviewers on the login flow.”"
    );
    // Long messages are cut, and secrets never reach the alert.
    let long = finished_alert_body(Some(2), None, Some(&"step ".repeat(100)));
    assert!(long.chars().count() <= 240, "{long}");
    assert!(long.contains("…”"), "{long}");
    let secret = finished_alert_body(
        None,
        None,
        Some("Pushed with token ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
    );
    assert!(!secret.contains("ghp_abcdefghij"), "{secret}");
}

#[test]
fn the_turn_end_alert_with_work_still_running_says_what_the_agent_last_said() {
    let note = "Finished its turn. A workflow is still running (5 agents).";
    assert_eq!(turn_end_alert_body(note, None), note);
    assert_eq!(turn_end_alert_body(note, Some("   ")), note);
    let body = turn_end_alert_body(note, Some("Started the review of\nthe login flow."));
    assert_eq!(
        body,
        "Finished its turn. A workflow is still running (5 agents). Last message: “Started the review of the login flow.”"
    );
    assert!(body.starts_with(TURN_ONLY_PREFIX));
}
