//! Executes the assistant's tools against the running app, through the same `Core`
//! calls the UI uses, so they behave exactly like clicking.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::AppHandle;
use kvistcode_core::{
    Agent, AgentStatus, Core, CreateAgentRequest, ItemBody, Provider, TimelineItem, ToolStatus,
};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::Manager;

use super::session::{
    ActionLog, PendingAction, ToolFuture, ToolHost, ToolOutcome, VaEvent, VaSink,
};
use super::tools::{
    self, basename, clean, project_key, AgentRef, Numbering, OpenView, OrderKey, Resolved, ToolCall,
};

/// A voice-started agent with the same project and prompt inside this window is the
/// same request retried (a tool timeout makes the model ask again), not a new one.
/// Highlighted text handed to the model is cut to this many characters.
const MAX_SELECTION_CHARS: usize = 500;

const DUPLICATE_WINDOW: Duration = Duration::from_secs(120);

#[derive(Clone)]
pub struct KvistcodeTools {
    app: AppHandle,
    core: Core,
    sink: Arc<dyn VaSink>,
    /// What the window shows, as last reported by the UI.
    screen: Arc<Mutex<super::ScreenContext>>,
    /// (project path + prompt, when, agent id) of agents this session started.
    recent: Arc<Mutex<Vec<(String, Instant, String)>>>,
    /// What "agent 2" and "project 3" mean: the last lists given to the model.
    numbers: Arc<Mutex<Numbering>>,
}

impl KvistcodeTools {
    pub fn new(
        app: AppHandle,
        core: Core,
        sink: Arc<dyn VaSink>,
        screen: Arc<Mutex<super::ScreenContext>>,
    ) -> Self {
        KvistcodeTools {
            app,
            core,
            sink,
            screen,
            recent: Arc::default(),
            numbers: Arc::default(),
        }
    }
}

impl ToolHost for KvistcodeTools {
    fn call(&self, name: String, arguments: String) -> ToolFuture {
        let host = self.clone();
        Box::pin(async move {
            match tools::parse_call(&name, &arguments) {
                Err(e) => fail(&e),
                Ok(call) => host.run(&name, call).await,
            }
        })
    }
}

/// The id of an agent started from this exact request within [`DUPLICATE_WINDOW`].
pub fn find_duplicate(
    recent: &mut Vec<(String, Instant, String)>,
    key: &str,
    now: Instant,
) -> Option<String> {
    recent.retain(|(_, at, _)| now.duration_since(*at) < DUPLICATE_WINDOW);
    recent
        .iter()
        .find(|(k, _, _)| k == key)
        .map(|(_, _, id)| id.clone())
}

fn ok(data: Value) -> ToolOutcome {
    ToolOutcome {
        output: tools::wrap_data(data),
        action: None,
        pending: None,
    }
}

fn fail(msg: &str) -> ToolOutcome {
    ToolOutcome::error(msg)
}

/// A side effect the user must confirm on screen before it runs.
fn propose(kind: &str, summary: String, run: ToolFuture) -> ToolOutcome {
    ToolOutcome {
        output: String::new(),
        action: None,
        pending: Some(PendingAction {
            kind: kind.into(),
            summary,
            run,
        }),
    }
}

fn done(data: Value, kind: &str, summary: String, agent_id: Option<String>) -> ToolOutcome {
    ToolOutcome {
        output: tools::wrap_data(data),
        action: Some(ActionLog {
            id: uuid::Uuid::new_v4().to_string(),
            kind: kind.into(),
            summary: clean(&summary, 160),
            agent_id,
            ok: true,
        }),
        pending: None,
    }
}

/// Permission mode for every agent the assistant starts (`CreateAgentRequest`).
pub const ASSISTANT_AGENT_MODE: &str = "ask";
/// Longest prompt or message shown on the confirmation card (and then sent).
const MAX_SHOWN_PROMPT: usize = 4000;

fn provider_label(p: Provider) -> &'static str {
    match p {
        Provider::Claude => "Claude",
        Provider::Codex => "Codex",
        Provider::Grok => "Grok",
        Provider::Local => "Local",
        Provider::Custom => "Custom",
    }
}

/// Why an agent wants the user, if it does.
pub fn needs_you(a: &Agent) -> Option<String> {
    if a.status == AgentStatus::NeedsPermission || a.pending_permissions > 0 {
        return Some(format!(
            "waiting for approval ({})",
            a.pending_permissions.max(1)
        ));
    }
    if a.status == AgentStatus::Error {
        return Some("error".into());
    }
    if a.rate_limited {
        return Some("hit its rate limit".into());
    }
    if a.queue_paused && a.queued_prompts > 0 {
        return Some("queued messages paused".into());
    }
    if a.unread && a.status == AgentStatus::Idle {
        return Some("finished, not yet read".into());
    }
    None
}

/// Where an agent sorts in the sidebar: 0..=4 it needs the user (most urgent first), 5 working,
/// 6 the rest. Mirrors the window's own `needsAttention`.
fn order_rank(a: &Agent) -> u8 {
    if a.pending_permissions > 0 || a.status == AgentStatus::NeedsPermission {
        return 0;
    }
    if a.budget_hold.is_some() {
        return 1;
    }
    let dismissed = a.acknowledged_at.is_some_and(|t| t >= a.last_activity_at);
    if !dismissed {
        if a.rate_limited {
            return 2;
        }
        if a.status == AgentStatus::Error {
            return 3;
        }
        if a.unread
            && matches!(
                a.status,
                AgentStatus::Idle | AgentStatus::Stopped | AgentStatus::Interrupted
            )
        {
            return 4;
        }
    }
    if matches!(a.status, AgentStatus::Working | AgentStatus::Starting) {
        5
    } else {
        6
    }
}

/// Sub-agents still working: in-flight calls, plus background ones while the turn runs.
pub fn running_subagents(items: &[TimelineItem], agent_running: bool) -> usize {
    items
        .iter()
        .filter(|i| match &i.body {
            ItemBody::ToolCall {
                subagent: Some(s),
                status,
                ..
            } if !s.control => {
                matches!(status, ToolStatus::Pending | ToolStatus::InProgress)
                    || (s.background && agent_running)
            }
            _ => false,
        })
        .count()
}

fn ago(now: i64, then: i64) -> String {
    let s = ((now - then) / 1000).max(0);
    match s {
        0..=59 => "just now".into(),
        60..=3599 => format!("{} min ago", s / 60),
        3600..=86_399 => format!("{} h ago", s / 3600),
        _ => format!("{} days ago", s / 86_400),
    }
}

/// How an account is paid for: "subscription", "api" (billed per token on a key) or "local" (free).
fn billing_mode(a: &kvistcode_core::Account) -> &'static str {
    if a.provider == kvistcode_core::Provider::Local {
        "local"
    } else if a.auth_kind == kvistcode_core::AuthKind::ApiKey {
        "api"
    } else {
        "subscription"
    }
}

/// Today's spend against the daily cost limit; `leftUsd` is null when no limit is set.
fn daily_budget(s: &kvistcode_core::budget::BudgetStatus) -> Value {
    let cents = |v: f64| (v * 100.0).round() / 100.0;
    let limit = s.daily_budget_usd.filter(|b| *b > 0.0);
    json!({
        "spentTodayUsd": cents(s.today_usd),
        "limitUsd": limit.map(cents),
        "leftUsd": limit.map(|b| cents((b - s.today_usd).max(0.0))),
    })
}

/// Said with the usage numbers so the model doesn't mistake the daily budget for a bill.
const USAGE_NOTE: &str = "Cost is the API-equivalent estimate; subscriptions are limited by the \
percent used, not by cost. dailyBudget counts every agent's usage at API prices, subscription agents \
included, so it is not what any key is billed; the assistant's own OpenAI spend is the month ledger \
(shown in the assistant panel). The remaining prepaid credit on an API key can't be read.";

/// "in 2 h" for a reset time (or "now" when it has passed).
fn ago_until(now: i64, at: i64) -> String {
    let s = ((at - now) / 1000).max(0);
    match s {
        0 => "now".into(),
        1..=3599 => format!("in {} min", (s + 59) / 60),
        3600..=86_399 => format!("in {} h", s / 3600),
        _ => format!("in {} days", s / 86_400),
    }
}

impl KvistcodeTools {
    async fn run(&self, name: &str, call: ToolCall) -> ToolOutcome {
        match call {
            ToolCall::ListAgents => self.list_agents(),
            ToolCall::GetAgent { agent } => self.get_agent(&agent).await,
            ToolCall::StartAgent {
                provider,
                project,
                prompt,
                account,
            } => {
                self.start_agent(&provider, &project, &prompt, account.as_deref())
                    .await
            }
            ToolCall::SendMessage { agent, text } => self.send_message(&agent, &text).await,
            ToolCall::StopAgent { agent } => self.stop_agent(&agent).await,
            ToolCall::Open {
                view,
                agent,
                project,
                section,
            } => {
                self.open(view, agent.as_deref(), project.as_deref(), section)
                    .await
            }
            ToolCall::GetScreen => self.get_screen().await,
            ToolCall::RequestApprovalReview { agent } => self.request_approval(&agent),
            ToolCall::ListProjects => self.list_projects().await,
            ToolCall::GetUsage => self.get_usage(),
            ToolCall::SearchHistory { query } => self.search_history(&query),
            ToolCall::RenameAgent { agent, title } => self.rename_agent(&agent, &title),
            ToolCall::MarkDone { agent } => self.mark_done(&agent),
        }
        .with_kind(name)
    }

    /// The agent open on screen, as last reported by the UI.
    fn screen_agent(&self) -> Option<String> {
        let s = self.screen.lock();
        s.agent_id.clone().or_else(|| s.review_agent_id.clone())
    }

    /// An empty query means "this agent": the one open on screen.
    fn resolve(&self, query: &str) -> Result<Agent, Box<ToolOutcome>> {
        let on_screen;
        let query = if query.trim().is_empty() {
            on_screen = self.screen_agent().ok_or_else(|| {
                Box::new(fail(
                    "No agent is open on screen. Ask the user which agent they mean.",
                ))
            })?;
            on_screen.as_str()
        } else {
            query
        };
        if let Some(n) = tools::parse_number(query, "agent") {
            return self.agent_by_number(n);
        }
        let agents = self
            .core
            .agents()
            .map_err(|e| Box::new(fail(&format!("{e:#}"))))?;
        let live: Vec<&Agent> = agents.iter().filter(|a| !a.archived).collect();
        let projects: Vec<String> = live.iter().map(|a| basename(&a.project_path)).collect();
        let refs: Vec<AgentRef> = live
            .iter()
            .zip(&projects)
            .map(|(a, p)| AgentRef {
                id: &a.id,
                title: &a.title,
                project: p,
            })
            .collect();
        match tools::resolve_agent(&refs, query) {
            Resolved::One(id) => Ok(live
                .iter()
                .find(|a| a.id == id)
                .map(|a| (*a).clone())
                .expect("resolved")),
            Resolved::Ambiguous(c) => Err(Box::new(ToolOutcome {
                output: tools::wrap_ambiguous("agents", &c),
                action: None,
                pending: None,
            })),
            Resolved::None => Err(Box::new(fail(
                "No agent matches that. Use list_agents to see them.",
            ))),
        }
    }

    /// The agents that are not archived, in the order the user sees them: the window's own
    /// order when it has reported one, the same rules otherwise.
    fn ordered_agents(&self) -> Result<Vec<Agent>, String> {
        let mut agents = self.core.agents().map_err(|e| format!("{e:#}"))?;
        agents.retain(|a| !a.archived);
        let fallback = tools::sidebar_order(
            agents
                .iter()
                .map(|a| OrderKey {
                    id: a.id.clone(),
                    project: a.project_path.clone(),
                    rank: order_rank(a),
                    last_activity: a.last_activity_at,
                })
                .collect(),
        );
        let order = tools::merge_order(&self.screen.lock().agent_order, fallback);
        let mut by_id: std::collections::HashMap<String, Agent> =
            agents.into_iter().map(|a| (a.id.clone(), a)).collect();
        Ok(order.iter().filter_map(|id| by_id.remove(id)).collect())
    }

    /// Makes `ordered` the numbered list the model knows.
    fn number_agents(&self, ordered: &[Agent]) {
        let ids = ordered
            .iter()
            .take(tools::MAX_LISTED_AGENTS)
            .map(|a| a.id.clone())
            .collect();
        self.numbers.lock().agents.set(ids, Instant::now());
    }

    /// "Agent 2": the agent that had that number in the last list. With no list yet it is the
    /// same order the user sees. Never a guess: a number that is out of range, old, or whose
    /// agent is gone is an error that says to list again.
    fn agent_by_number(&self, n: usize) -> Result<Agent, Box<ToolOutcome>> {
        let ordered = self.ordered_agents().map_err(|e| Box::new(fail(&e)))?;
        let now = Instant::now();
        let id = {
            let mut nums = self.numbers.lock();
            if !nums.agents.is_set() {
                let ids = ordered
                    .iter()
                    .take(tools::MAX_LISTED_AGENTS)
                    .map(|a| a.id.clone())
                    .collect();
                nums.agents.set(ids, now);
            }
            nums.agents
                .get(n, now)
                .map(str::to_string)
                .map_err(|e| Box::new(fail(&tools::number_error("agent", n, &e))))?
        };
        ordered
            .into_iter()
            .find(|a| a.id == id)
            .ok_or_else(|| Box::new(fail(&tools::number_gone("agent", n))))
    }

    /// The number of an agent in the list the model has, if it is in it.
    fn agent_number(&self, id: &str) -> Option<usize> {
        self.numbers.lock().agents.number_of(id, Instant::now())
    }

    fn list_agents(&self) -> ToolOutcome {
        let agents = match self.ordered_agents() {
            Ok(a) => a,
            Err(e) => return fail(&e),
        };
        self.number_agents(&agents);
        let now = kvistcode_core::now_ms();
        let rows: Vec<Value> = agents
            .iter()
            .take(tools::MAX_LISTED_AGENTS)
            .enumerate()
            .map(|(i, a)| {
                let subs = if a.running {
                    self.core
                        .items(&a.id)
                        .map(|i| running_subagents(&i, true))
                        .unwrap_or(0)
                } else {
                    0
                };
                json!({
                    "number": i + 1,
                    "id": a.id,
                    "title": a.title,
                    "provider": a.provider.as_str(),
                    "project": basename(&a.project_path),
                    "status": a.status.as_str(),
                    "needsYou": needs_you(a),
                    "runningSubagents": subs,
                    "lastActivity": ago(now, a.last_activity_at),
                })
            })
            .collect();
        ok(json!({ "count": agents.len(), "agents": rows }))
    }

    async fn get_agent(&self, query: &str) -> ToolOutcome {
        let agent = match self.resolve(query) {
            Ok(a) => a,
            Err(o) => return *o,
        };
        let items = self.core.items(&agent.id).unwrap_or_default();
        let last_message = items
            .iter()
            .rev()
            .find_map(|i| match &i.body {
                ItemBody::AgentMessage { text, .. } if !text.trim().is_empty() => {
                    Some(text.clone())
                }
                _ => None,
            })
            .or_else(|| agent.last_message.clone())
            .map(|t| t.chars().take(600).collect::<String>());
        let files: Vec<String> = items
            .iter()
            .rev()
            .find_map(|i| match &i.body {
                ItemBody::TurnSummary { files, .. } => Some(files.clone()),
                _ => None,
            })
            .unwrap_or_else(|| self.core.touched_files(&agent.id))
            .into_iter()
            .take(10)
            .collect();
        let commands: Vec<String> = items
            .iter()
            .rev()
            .filter_map(|i| match &i.body {
                ItemBody::ToolCall {
                    command: Some(c), ..
                } => Some(c.chars().take(120).collect()),
                _ => None,
            })
            .take(3)
            .collect();
        let pending: Vec<String> = items
            .iter()
            .filter_map(|i| match &i.body {
                ItemBody::Permission {
                    title,
                    resolution: None,
                    ..
                } => Some(title.clone()),
                _ => None,
            })
            .take(3)
            .collect();
        let pr = match self.app.try_state::<crate::pr_status::PrCache>() {
            Some(cache) if agent.branch.is_some() => {
                match tokio::time::timeout(Duration::from_secs(3), cache.status(&agent, false))
                    .await
                {
                    Ok(s) => s.pr.map(|p| {
                        json!({ "number": p.number, "state": p.state, "review": p.review,
                                "mergeable": p.mergeable, "checks": p.summary })
                    }),
                    Err(_) => None,
                }
            }
            _ => None,
        };
        ok(json!({
            "number": self.agent_number(&agent.id),
            "id": agent.id,
            "title": agent.title,
            "provider": agent.provider.as_str(),
            "project": basename(&agent.project_path),
            "status": agent.status.as_str(),
            "needsYou": needs_you(&agent),
            "runningSubagents": running_subagents(&items, agent.running),
            "queuedMessages": agent.queued_prompts,
            "lastAssistantMessage": last_message,
            "filesChanged": files,
            "recentCommands": commands,
            "pendingApprovals": pending,
            "pullRequest": pr,
            "lastActivity": ago(kvistcode_core::now_ms(), agent.last_activity_at),
        }))
    }

    async fn known_projects(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        if let Ok(s) = self.core.settings() {
            out.extend(s.recent_projects);
        }
        if let Ok(a) = self.core.agents() {
            out.extend(a.into_iter().map(|a| a.project_path));
        }
        if let Ok(found) = self.core.discover_projects().await {
            out.extend(found);
        }
        let mut seen = std::collections::HashSet::new();
        out.retain(|p| seen.insert(p.clone()));
        out.retain(|p| std::path::Path::new(p).is_dir());
        out
    }

    /// A project by number (from the last `list_projects`) or by name. Only ever a path in
    /// `known`: a number is looked up host-side and checked against the folders still known.
    fn project_by_query(&self, known: &[String], q: &str) -> Result<String, Box<ToolOutcome>> {
        if let Some(n) = tools::parse_number(q, "project") {
            let now = Instant::now();
            let path = {
                let mut nums = self.numbers.lock();
                if !nums.projects.is_set() {
                    let shown = known.iter().take(tools::MAX_LISTED_PROJECTS).cloned();
                    nums.projects.set(shown.collect(), now);
                }
                nums.projects
                    .get(n, now)
                    .map(str::to_string)
                    .map_err(|e| Box::new(fail(&tools::number_error("project", n, &e))))?
            };
            return if known.contains(&path) {
                Ok(path)
            } else {
                Err(Box::new(fail(&tools::number_gone("project", n))))
            };
        }
        match tools::resolve_project(known, q) {
            Resolved::One(p) => Ok(p),
            Resolved::Ambiguous(c) => Err(Box::new(ToolOutcome {
                output: tools::wrap_ambiguous("projects", &c),
                action: None,
                pending: None,
            })),
            Resolved::None => Err(Box::new(fail(
                "That isn't a project Kvistcode knows. Use list_projects to see them, or open it once in the New Agent dialog first.",
            ))),
        }
    }

    async fn start_agent(
        &self,
        provider: &str,
        project: &str,
        prompt: &str,
        account: Option<&str>,
    ) -> ToolOutcome {
        let provider = match provider {
            "codex" => Provider::Codex,
            "grok" => Provider::Grok,
            _ => Provider::Claude,
        };
        let known = self.known_projects().await;
        let path = match self.project_by_query(&known, project) {
            Ok(p) => p,
            Err(o) => return *o,
        };
        let accounts = match self.core.accounts() {
            Ok(a) => a,
            Err(e) => return fail(&format!("{e:#}")),
        };
        let mine: Vec<_> = accounts.iter().filter(|a| a.provider == provider).collect();
        let chosen = match account {
            Some(q) => {
                let q = q.to_lowercase();
                mine.iter()
                    .find(|a| a.name.to_lowercase().contains(&q))
                    .copied()
            }
            None => mine.iter().find(|a| a.is_system).or(mine.first()).copied(),
        };
        let Some(chosen) = chosen else {
            return fail(&format!(
                "No {} account is set up.",
                provider_label(provider)
            ));
        };
        let worktree = self
            .core
            .settings()
            .map(|s| s.default_worktree)
            .unwrap_or(true);
        // The card shows exactly this text and this is what runs: no invisible
        // characters or secrets ride along.
        let prompt = clean(prompt, MAX_SHOWN_PROMPT);
        let key = format!("{path}\u{0}{prompt}");
        if let Some(existing) = self.duplicate(&key) {
            return existing;
        }
        let summary = format!(
            "Start {} agent in {}: {}",
            provider_label(provider),
            basename(&path),
            prompt
        );
        let host = self.clone();
        let account_id = chosen.id.clone();
        propose(
            "start_agent",
            summary,
            Box::pin(async move {
                if let Some(existing) = host.duplicate(&key) {
                    return existing;
                }
                let req = CreateAgentRequest {
                    provider,
                    account_id,
                    project_path: path.clone(),
                    prompt,
                    title: None,
                    worktree,
                    model: None,
                    group_id: None,
                    custom_agent_id: None,
                    // Agents the assistant starts always ask before acting.
                    permission_mode: Some(ASSISTANT_AGENT_MODE.into()),
                    attachments: Vec::new(),
                };
                match host.core.create_agent(req).await {
                    Ok(agent) => {
                        host.recent
                            .lock()
                            .push((key, Instant::now(), agent.id.clone()));
                        if let Err(e) =
                            crate::commands::remember_project(&host.core, &agent.project_path)
                        {
                            tracing::warn!("could not update recent projects: {e:#}");
                        }
                        let project = basename(&agent.project_path);
                        done(
                            json!({ "started": true, "id": agent.id, "title": agent.title,
                                    "provider": agent.provider.as_str(), "project": project,
                                    "worktree": agent.worktree }),
                            "start_agent",
                            format!(
                                "Started {} agent '{}' in {}",
                                provider_label(agent.provider),
                                agent.title,
                                project
                            ),
                            Some(agent.id.clone()),
                        )
                    }
                    Err(e) => fail(&format!("Couldn't start the agent: {e:#}")),
                }
            }),
        )
    }

    /// The earlier outcome for an identical start request, if there was one.
    fn duplicate(&self, key: &str) -> Option<ToolOutcome> {
        let id = find_duplicate(&mut self.recent.lock(), key, Instant::now())?;
        let agent = self.core.agents().ok()?.into_iter().find(|a| a.id == id)?;
        Some(ok(json!({
            "started": true, "alreadyStarted": true, "id": agent.id, "title": agent.title,
            "provider": agent.provider.as_str(), "project": basename(&agent.project_path),
            "note": "An identical request already started this agent; nothing new was started."
        })))
    }

    async fn send_message(&self, query: &str, text: &str) -> ToolOutcome {
        let agent = match self.resolve(query) {
            Ok(a) => a,
            Err(o) => return *o,
        };
        let text = clean(text, MAX_SHOWN_PROMPT);
        let summary = format!(
            "Send to '{}' ({}): {}",
            clean(&agent.title, 80),
            basename(&agent.project_path),
            text
        );
        let core = self.core.clone();
        propose(
            "send_message",
            summary,
            Box::pin(async move {
                match core.send_prompt(&agent.id, &text, Vec::new()).await {
                    Ok(()) => done(
                        json!({ "sent": true, "agent": agent.title, "queued": agent.running }),
                        "send_message",
                        format!(
                            "Sent to '{}': \u{201c}{}\u{201d}",
                            agent.title,
                            text.chars().take(80).collect::<String>()
                        ),
                        Some(agent.id),
                    ),
                    Err(e) => fail(&format!("Couldn't send the message: {e:#}")),
                }
            }),
        )
    }

    async fn stop_agent(&self, query: &str) -> ToolOutcome {
        let agent = match self.resolve(query) {
            Ok(a) => a,
            Err(o) => return *o,
        };
        if !agent.running {
            return ok(json!({ "stopped": false, "reason": "The agent isn't running a turn." }));
        }
        match self.core.cancel_turn(&agent.id).await {
            Ok(()) => done(
                json!({ "stopped": true, "agent": agent.title }),
                "stop_agent",
                format!("Stopped the current turn of '{}'", agent.title),
                Some(agent.id),
            ),
            Err(e) => fail(&format!("Couldn't stop the agent: {e:#}")),
        }
    }

    async fn open(
        &self,
        view: OpenView,
        agent: Option<&str>,
        project: Option<&str>,
        section: Option<String>,
    ) -> ToolOutcome {
        // A project opens its most urgent agent (the first of it in the sidebar).
        let from_project =
            match project {
                Some(q) => {
                    let known = self.known_projects().await;
                    let path = match self.project_by_query(&known, q) {
                        Ok(p) => p,
                        Err(o) => return *o,
                    };
                    let key = project_key(&path).to_string();
                    let found = match self.ordered_agents() {
                        Ok(list) => list
                            .into_iter()
                            .find(|a| project_key(&a.project_path) == key),
                        Err(e) => return fail(&e),
                    };
                    match found {
                        Some(a) => Some(a),
                        None => return fail(
                            "That project has no agents yet. Use start_agent to begin one there.",
                        ),
                    }
                }
                None => None,
            };
        // The diff review is always of an agent: without one named, the one on screen.
        let agent = if view == OpenView::Review && agent.is_none() && from_project.is_none() {
            Some("")
        } else {
            agent
        };
        let agent = match (from_project, agent) {
            (Some(a), _) => Some(a),
            (None, Some(q)) => match self.resolve(q) {
                Ok(a) => Some(a),
                Err(o) => return *o,
            },
            (None, None) => None,
        };
        if view == OpenView::Compare {
            if let Some(a) = &agent {
                if a.group_id.is_none() {
                    return fail("That agent isn't part of a comparison.");
                }
            }
        }
        let label = match view {
            OpenView::Agents => "agents",
            OpenView::MissionControl => "Mission Control",
            OpenView::Inbox => "the inbox",
            OpenView::Review => "the diff review",
            OpenView::Usage => "usage",
            OpenView::Schedules => "schedules",
            OpenView::Accounts => "accounts",
            OpenView::Settings => "settings",
            OpenView::Compare => "compare",
        };
        self.sink.emit(VaEvent::Navigate {
            view: view.as_str().into(),
            agent_id: agent.as_ref().map(|a| a.id.clone()),
            section: section.clone(),
        });
        let label = match &section {
            Some(sec) => format!("{label} ({sec})"),
            None => label.to_string(),
        };
        let summary = match &agent {
            Some(a) => format!("Opened {label} for '{}'", a.title),
            None => format!("Opened {label}"),
        };
        let agent_number = agent.as_ref().and_then(|a| self.agent_number(&a.id));
        done(
            json!({ "opened": view.as_str(), "section": section, "agentNumber": agent_number }),
            "open",
            summary,
            agent.map(|a| a.id),
        )
    }

    async fn get_screen(&self) -> ToolOutcome {
        let s = self.screen.lock().clone();
        if s.view.is_empty() {
            return ok(
                json!({ "known": false, "note": "The window hasn't reported what it shows." }),
            );
        }
        let ordered = match self.ordered_agents() {
            Ok(a) => a,
            Err(e) => return fail(&e),
        };
        let focus = s.agent_id.clone().or_else(|| s.review_agent_id.clone());
        let focus_path = focus
            .as_ref()
            .and_then(|id| ordered.iter().find(|a| &a.id == id))
            .map(|a| a.project_path.clone());
        // Numbers come from the lists the model already has; with none yet, from the order
        // the user sees now.
        if !self.numbers.lock().agents.is_set() {
            self.number_agents(&ordered);
        }
        if focus_path.is_some() && !self.numbers.lock().projects.is_set() {
            self.number_projects(&self.known_projects().await);
        }
        let project_number = |path: &str| {
            let key = project_key(path);
            let nums = self.numbers.lock();
            nums.projects
                .number_where(Instant::now(), |p| project_key(p) == key)
        };
        let describe = |id: &Option<String>| {
            id.as_ref()
                .and_then(|id| ordered.iter().find(|a| &a.id == id))
                .map(|a| {
                    json!({
                        "number": self.agent_number(&a.id),
                        "id": a.id,
                        "title": a.title,
                        "provider": a.provider.as_str(),
                        "status": serde_json::to_value(a.status).unwrap_or(Value::Null),
                        "project": basename(&a.project_path),
                        "projectNumber": project_number(&a.project_path),
                    })
                })
        };
        let comparison: Option<Vec<Value>> = s.compare_group_id.as_ref().map(|g| {
            ordered
                .iter()
                .filter(|a| a.group_id.as_ref() == Some(g))
                .take(8)
                .map(|a| {
                    json!({ "number": self.agent_number(&a.id), "id": a.id, "title": a.title,
                            "status": serde_json::to_value(a.status).unwrap_or(Value::Null) })
                })
                .collect()
        });
        let selected = s
            .selected_text
            .as_deref()
            .map(|t| clean(t, MAX_SELECTION_CHARS))
            .filter(|t| !t.trim().is_empty());
        ok(json!({
            "known": true,
            "screen": s.view,
            "agent": describe(&s.agent_id),
            "project": focus_path.as_deref().map(|p| json!({
                "name": basename(p),
                "number": project_number(p),
            })),
            "settingsSection": s.settings_section,
            "missionControlTab": s.mission_tab,
            "diffReviewOf": describe(&s.review_agent_id),
            "comparison": comparison,
            "highlightedText": selected,
            "numbersNote": "A null number means it is not in your last list: call list_agents or list_projects to number it.",
        }))
    }

    fn number_projects(&self, known: &[String]) {
        let shown = known.iter().take(tools::MAX_LISTED_PROJECTS).cloned();
        self.numbers
            .lock()
            .projects
            .set(shown.collect(), Instant::now());
    }

    async fn list_projects(&self) -> ToolOutcome {
        let known = self.known_projects().await;
        self.number_projects(&known);
        let agents = self.core.agents().unwrap_or_default();
        let rows: Vec<Value> = known
            .iter()
            .take(tools::MAX_LISTED_PROJECTS)
            .enumerate()
            .map(|(i, p)| {
                let key = project_key(p);
                let count = agents
                    .iter()
                    .filter(|a| !a.archived && project_key(&a.project_path) == key)
                    .count();
                json!({ "number": i + 1, "name": basename(p), "agents": count })
            })
            .collect();
        ok(json!({ "count": known.len(), "projects": rows }))
    }

    fn get_usage(&self) -> ToolOutcome {
        let accounts = match self.core.accounts() {
            Ok(a) => a,
            Err(e) => return fail(&format!("{e:#}")),
        };
        let now = kvistcode_core::now_ms();
        let window = |w: &Option<kvistcode_core::UsageWindow>| {
            w.as_ref().map(|w| {
                json!({
                    "usedPercent": w.used_percent.round(),
                    "windowHours": w.window_mins.map(|m| m / 60),
                    "resetsIn": w.resets_at.map(|r| ago_until(now, r)),
                })
            })
        };
        let rows: Vec<Value> = accounts
            .iter()
            .map(|a| {
                json!({
                    "account": a.name,
                    "provider": a.provider.as_str(),
                    "billing": billing_mode(a),
                    "plan": a.usage.as_ref().and_then(|u| u.plan.clone()),
                    "shortWindow": a.usage.as_ref().and_then(|u| window(&u.primary)),
                    "longWindow": a.usage.as_ref().and_then(|u| window(&u.secondary)),
                })
            })
            .collect();
        let agents = self.core.agents().unwrap_or_default();
        let live: Vec<&Agent> = agents.iter().filter(|a| !a.archived).collect();
        let cost: f64 = live.iter().map(|a| a.cost_usd).sum();
        let mut top: Vec<&&Agent> = live.iter().collect();
        top.sort_by(|a, b| b.cost_usd.total_cmp(&a.cost_usd));
        let top: Vec<Value> = top
            .iter()
            .take(3)
            .map(|a| json!({ "title": a.title, "costUsd": (a.cost_usd * 100.0).round() / 100.0 }))
            .collect();
        ok(json!({
            "accounts": rows,
            "agentsCostUsd": (cost * 100.0).round() / 100.0,
            "mostExpensive": top,
            "dailyBudget": daily_budget(&self.core.budget_status()),
            "note": USAGE_NOTE,
        }))
    }

    fn search_history(&self, query: &str) -> ToolOutcome {
        let hits = match self.core.search(query) {
            Ok(h) => h,
            Err(e) => return fail(&format!("{e:#}")),
        };
        let agents = self.core.agents().unwrap_or_default();
        let rows: Vec<Value> = hits
            .iter()
            .take(6)
            .map(|h| {
                let title = agents
                    .iter()
                    .find(|a| a.id == h.agent_id)
                    .map(|a| a.title.clone());
                let snippet: String = h
                    .snippet
                    .chars()
                    .filter(|c| *c != '\u{1}' && *c != '\u{2}')
                    .collect();
                json!({ "agentId": h.agent_id, "agent": title, "kind": h.kind, "excerpt": snippet })
            })
            .collect();
        ok(json!({ "matches": rows.len(), "results": rows }))
    }

    fn rename_agent(&self, query: &str, title: &str) -> ToolOutcome {
        let agent = match self.resolve(query) {
            Ok(a) => a,
            Err(o) => return *o,
        };
        let title = clean(title, tools::MAX_TITLE_CHARS).replace('\n', " ");
        let title = title.trim().to_string();
        if title.is_empty() {
            return fail("The new title is empty.");
        }
        let summary = format!("Rename '{}' to '{}'", clean(&agent.title, 80), title);
        let core = self.core.clone();
        propose(
            "rename_agent",
            summary,
            Box::pin(async move {
                match core.rename_agent(&agent.id, &title) {
                    Ok(()) => done(
                        json!({ "renamed": true, "title": title }),
                        "rename_agent",
                        format!("Renamed '{}' to '{}'", agent.title, title),
                        Some(agent.id),
                    ),
                    Err(e) => fail(&format!("Couldn't rename it: {e:#}")),
                }
            }),
        )
    }

    fn mark_done(&self, query: &str) -> ToolOutcome {
        let agent = match self.resolve(query) {
            Ok(a) => a,
            Err(o) => return *o,
        };
        match self.core.acknowledge_agent(&agent.id) {
            Ok(()) => done(
                json!({ "markedDone": true, "agent": agent.title }),
                "mark_done",
                format!("Marked '{}' done", agent.title),
                Some(agent.id),
            ),
            Err(e) => fail(&format!("Couldn't mark it done: {e:#}")),
        }
    }

    fn request_approval(&self, query: &str) -> ToolOutcome {
        let agent = match self.resolve(query) {
            Ok(a) => a,
            Err(o) => return *o,
        };
        let items = self.core.items(&agent.id).unwrap_or_default();
        let pending: Vec<Value> = items
            .iter()
            .filter_map(|i| match &i.body {
                ItemBody::Permission {
                    title,
                    command,
                    resolution: None,
                    ..
                } => Some(json!({ "request": title, "command": command })),
                _ => None,
            })
            .take(3)
            .collect();
        if pending.is_empty() {
            return ok(json!({ "pending": false, "note": "That agent has no pending approval." }));
        }
        self.sink.emit(VaEvent::Navigate {
            view: "agents".into(),
            agent_id: Some(agent.id.clone()),
            section: None,
        });
        done(
            json!({ "pending": true, "requests": pending,
                    "instruction": "Tell the user to review and confirm on screen. You cannot approve or deny." }),
            "request_approval_review",
            format!("Opened the pending approval for '{}'", agent.title),
            Some(agent.id),
        )
    }
}

trait WithKind {
    fn with_kind(self, kind: &str) -> Self;
}

impl WithKind for ToolOutcome {
    fn with_kind(mut self, kind: &str) -> Self {
        if let Some(a) = &mut self.action {
            a.kind = kind.into();
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kvistcode_core::SubAgent;

    fn call(status: ToolStatus, sub: Option<SubAgent>) -> TimelineItem {
        TimelineItem {
            id: "i".into(),
            agent_id: "a".into(),
            seq: 1,
            ts: 0,
            body: ItemBody::ToolCall {
                tool_call_id: "t".into(),
                title: "Task".into(),
                tool_kind: kvistcode_core::ToolKind::Other,
                status,
                locations: vec![],
                diffs: vec![],
                output: String::new(),
                command: None,
                images: vec![],
                subagent: sub,
                parent_tool_call_id: None,
            },
        }
    }

    fn status(spent: f64, limit: Option<f64>) -> kvistcode_core::budget::BudgetStatus {
        kvistcode_core::budget::BudgetStatus {
            day: "2026-11-01".into(),
            today_usd: spent,
            daily_budget_usd: limit,
            today_tokens: 0,
            daily_budget_tokens: None,
            today_turns: 0,
            daily_budget_turns: None,
            level: kvistcode_core::budget::level(spent, limit),
        }
    }

    #[test]
    fn the_daily_budget_left_never_goes_below_zero_and_is_null_without_a_limit() {
        let b = daily_budget(&status(3.456, Some(10.0)));
        assert_eq!(b["spentTodayUsd"], 3.46);
        assert_eq!(b["limitUsd"], 10.0);
        assert_eq!(b["leftUsd"], 6.54);
        assert_eq!(daily_budget(&status(12.0, Some(10.0)))["leftUsd"], 0.0);
        let none = daily_budget(&status(2.0, None));
        assert!(none["limitUsd"].is_null() && none["leftUsd"].is_null());
        assert!(daily_budget(&status(2.0, Some(0.0)))["leftUsd"].is_null());
    }

    #[test]
    fn the_usage_note_says_the_daily_budget_is_not_a_bill() {
        for must in [
            "dailyBudget counts every agent's usage at API prices",
            "subscription agents included",
            "not what any key is billed",
            "month ledger",
        ] {
            assert!(USAGE_NOTE.contains(must), "{must}");
        }
        // The old advice to report the daily budget as the API balance is gone.
        assert!(!USAGE_NOTE.contains("report the daily budget"));
    }

    fn agent_with(status: AgentStatus) -> Agent {
        serde_json::from_value(json!({
            "id": "a", "title": "t", "provider": "claude", "accountId": "acc",
            "projectPath": "/p", "cwd": "/p", "worktree": false, "status": status,
            "running": false, "createdAt": 0, "updatedAt": 0, "lastActivityAt": 0,
            "costUsd": 0.0, "tokensUsed": 0, "unread": false, "archived": false,
            "pendingPermissions": 0
        }))
        .expect("a minimal agent")
    }

    #[test]
    fn the_order_rank_follows_what_needs_the_user() {
        let mut waiting = agent_with(AgentStatus::Working);
        waiting.pending_permissions = 1;
        assert_eq!(order_rank(&waiting), 0);
        assert_eq!(order_rank(&agent_with(AgentStatus::NeedsPermission)), 0);
        assert_eq!(order_rank(&agent_with(AgentStatus::Error)), 3);
        let mut limited = agent_with(AgentStatus::Idle);
        limited.rate_limited = true;
        assert_eq!(order_rank(&limited), 2);
        let mut unread = agent_with(AgentStatus::Idle);
        unread.unread = true;
        assert_eq!(order_rank(&unread), 4);
        // "Done" in triage dismisses it until the agent does something new.
        unread.acknowledged_at = Some(10);
        unread.last_activity_at = 10;
        assert_eq!(order_rank(&unread), 6);
        assert_eq!(order_rank(&agent_with(AgentStatus::Working)), 5);
        assert_eq!(order_rank(&agent_with(AgentStatus::Starting)), 5);
        assert_eq!(order_rank(&agent_with(AgentStatus::Idle)), 6);
    }

    #[test]
    fn counts_running_subagents() {
        let plain = SubAgent::default();
        let bg = SubAgent {
            background: true,
            ..Default::default()
        };
        let ctl = SubAgent {
            control: true,
            ..Default::default()
        };
        let items = vec![
            call(ToolStatus::InProgress, Some(plain.clone())),
            call(ToolStatus::Completed, Some(plain)),
            call(ToolStatus::Completed, Some(bg)),
            call(ToolStatus::InProgress, Some(ctl)),
            call(ToolStatus::InProgress, None),
        ];
        assert_eq!(running_subagents(&items, true), 2);
        assert_eq!(running_subagents(&items, false), 1);
    }

    #[test]
    fn identical_starts_within_two_minutes_are_duplicates() {
        let t0 = Instant::now();
        let mut recent = vec![("p\0fix".to_string(), t0, "agent-1".to_string())];
        assert_eq!(
            find_duplicate(&mut recent, "p\0fix", t0).as_deref(),
            Some("agent-1")
        );
        assert_eq!(find_duplicate(&mut recent, "p\0other", t0), None);
        let later = t0 + DUPLICATE_WINDOW;
        assert_eq!(find_duplicate(&mut recent, "p\0fix", later), None);
        assert!(recent.is_empty());
    }

    #[test]
    fn assistant_agents_always_ask() {
        assert_eq!(ASSISTANT_AGENT_MODE, "ask");
    }

    #[test]
    fn relative_times() {
        assert_eq!(ago(100_000, 90_000), "just now");
        assert_eq!(ago(10 * 60_000, 0), "10 min ago");
        assert_eq!(ago(3 * 3_600_000, 0), "3 h ago");
    }
}
