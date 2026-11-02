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
use super::tools::{self, basename, clean, AgentRef, OpenView, Resolved, ToolCall};

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
                section,
            } => self.open(view, agent.as_deref(), section),
            ToolCall::GetScreen => self.get_screen(),
            ToolCall::RequestApprovalReview { agent } => self.request_approval(&agent),
            ToolCall::ListProjects => self.list_projects().await,
            ToolCall::GetUsage => self.get_usage(),
            ToolCall::SearchHistory { query } => self.search_history(&query),
            ToolCall::RenameAgent { agent, title } => self.rename_agent(&agent, &title),
            ToolCall::MarkDone { agent } => self.mark_done(&agent),
        }
        .with_kind(name)
    }

    fn resolve(&self, query: &str) -> Result<Agent, Box<ToolOutcome>> {
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

    fn list_agents(&self) -> ToolOutcome {
        let mut agents = match self.core.agents() {
            Ok(a) => a,
            Err(e) => return fail(&format!("{e:#}")),
        };
        agents.retain(|a| !a.archived);
        agents.sort_by_key(|a| std::cmp::Reverse(a.last_activity_at));
        let now = kvistcode_core::now_ms();
        let rows: Vec<Value> = agents
            .iter()
            .take(25)
            .map(|a| {
                let subs = if a.running {
                    self.core
                        .items(&a.id)
                        .map(|i| running_subagents(&i, true))
                        .unwrap_or(0)
                } else {
                    0
                };
                json!({
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
        let path = match tools::resolve_project(&known, project) {
            Resolved::One(p) => p,
            Resolved::Ambiguous(c) => {
                return ToolOutcome {
                    output: tools::wrap_ambiguous("projects", &c),
                    action: None,
                    pending: None,
                }
            }
            Resolved::None => return fail(
                "That isn't a project Kvistcode knows. Open it once in the New Agent dialog first.",
            ),
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

    fn open(&self, view: OpenView, agent: Option<&str>, section: Option<String>) -> ToolOutcome {
        let agent = match agent {
            Some(q) => match self.resolve(q) {
                Ok(a) => Some(a),
                Err(o) => return *o,
            },
            None => None,
        };
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
        done(
            json!({ "opened": view.as_str(), "section": section }),
            "open",
            summary,
            agent.map(|a| a.id),
        )
    }

    fn get_screen(&self) -> ToolOutcome {
        let s = self.screen.lock().clone();
        if s.view.is_empty() {
            return ok(
                json!({ "known": false, "note": "The window hasn't reported what it shows." }),
            );
        }
        let agents = self.core.agents().unwrap_or_default();
        let describe = |id: &Option<String>| {
            id.as_ref()
                .and_then(|id| agents.iter().find(|a| &a.id == id))
                .map(|a| {
                    json!({
                        "id": a.id,
                        "title": a.title,
                        "provider": a.provider.as_str(),
                        "status": serde_json::to_value(a.status).unwrap_or(Value::Null),
                        "project": basename(&a.project_path),
                    })
                })
        };
        let selected = s
            .selected_text
            .as_deref()
            .map(|t| clean(t, MAX_SELECTION_CHARS))
            .filter(|t| !t.trim().is_empty());
        ok(json!({
            "known": true,
            "screen": s.view,
            "agent": describe(&s.agent_id),
            "settingsSection": s.settings_section,
            "missionControlTab": s.mission_tab,
            "diffReviewOf": describe(&s.review_agent_id),
            "highlightedText": selected,
        }))
    }

    async fn list_projects(&self) -> ToolOutcome {
        let known = self.known_projects().await;
        let names: Vec<String> = known.iter().take(40).map(|p| basename(p)).collect();
        ok(json!({ "count": known.len(), "projects": names }))
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
            "note": "Cost is the API-equivalent estimate; subscriptions are limited by the percent used, not by cost. \
                     The remaining prepaid credit on an API key can't be read, so for API billing report the daily budget left, and say so.",
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
