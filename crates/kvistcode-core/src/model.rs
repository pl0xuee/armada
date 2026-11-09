//! Domain types shared with the UI. Mirrors apps/desktop/src/lib/types.ts.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Claude,
    Codex,
    Grok,
    /// A model running on this machine (or a LAN box) behind an OpenAI-compatible
    /// server. Driven by the Codex CLI, pointed at the server instead of OpenAI.
    Local,
    /// Any other Agent Client Protocol agent, defined in `Settings::custom_agents`.
    Custom,
}

impl Provider {
    /// The built-in providers (custom agents are configured separately).
    pub const ALL: [Provider; 3] = [Provider::Claude, Provider::Codex, Provider::Grok];

    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::Grok => "grok",
            Provider::Local => "local",
            Provider::Custom => "custom",
        }
    }

    pub fn parse(s: &str) -> Option<Provider> {
        match s {
            "claude" => Some(Provider::Claude),
            "codex" => Some(Provider::Codex),
            "grok" => Some(Provider::Grok),
            "local" => Some(Provider::Local),
            "custom" => Some(Provider::Custom),
            _ => None,
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Provider::Claude => "Claude",
            Provider::Codex => "ChatGPT (Codex)",
            Provider::Grok => "Grok",
            Provider::Local => "Local model",
            Provider::Custom => "Custom agent",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    Default,
    Oauth,
    ApiKey,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub logged_in: bool,
    pub label: Option<String>,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub checked_at: i64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub provider: Provider,
    pub name: String,
    pub color: String,
    pub auth_kind: AuthKind,
    pub is_system: bool,
    pub config_dir: Option<String>,
    pub created_at: i64,
    pub status: Option<AccountStatus>,
    /// Latest usage-window snapshot, where the provider reports one (Codex, Claude).
    #[serde(default)]
    pub usage: Option<AccountUsage>,
    /// For `Provider::Local`: the model server this account talks to.
    #[serde(default)]
    pub local: Option<LocalServer>,
}

/// Which kind of local model server an account points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalKind {
    Ollama,
    Lmstudio,
    /// Any OpenAI-compatible server (llama.cpp, vLLM, ...), by URL.
    Custom,
}

/// A local model server. `base_url` is the server root for Ollama / LM Studio
/// (e.g. `http://127.0.0.1:11434`) and the OpenAI-compatible base for custom
/// servers (e.g. `http://gpu-box:8000/v1`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServer {
    pub kind: LocalKind,
    pub base_url: String,
}

/// One model a local server offers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub id: String,
    pub size_bytes: Option<u64>,
    /// e.g. "30.5B"
    pub parameters: Option<String>,
    /// e.g. "Q4_K_M"
    pub quantization: Option<String>,
    pub context_length: Option<i64>,
    /// Whether the server says the model supports tool calling (None = unknown).
    pub tools: Option<bool>,
}

/// The result of probing a local model server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProbe {
    pub kind: LocalKind,
    pub base_url: String,
    pub running: bool,
    pub models: Vec<LocalModel>,
    pub error: Option<String>,
    /// The server isn't on this machine: prompts and code are sent over the network.
    pub remote: bool,
}

/// One progress update of an Ollama model download.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullProgress {
    pub status: String,
    pub total: Option<u64>,
    pub completed: Option<u64>,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub used_percent: f64,
    pub window_mins: Option<i64>,
    /// Unix ms.
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub primary: Option<UsageWindow>,
    pub secondary: Option<UsageWindow>,
    pub plan: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Starting,
    Working,
    NeedsPermission,
    Idle,
    Error,
    Interrupted,
    Stopped,
}

impl AgentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentStatus::Starting => "starting",
            AgentStatus::Working => "working",
            AgentStatus::NeedsPermission => "needs_permission",
            AgentStatus::Idle => "idle",
            AgentStatus::Error => "error",
            AgentStatus::Interrupted => "interrupted",
            AgentStatus::Stopped => "stopped",
        }
    }

    pub fn parse(s: &str) -> AgentStatus {
        match s {
            "starting" => AgentStatus::Starting,
            "working" => AgentStatus::Working,
            "needs_permission" => AgentStatus::NeedsPermission,
            "idle" => AgentStatus::Idle,
            "error" => AgentStatus::Error,
            "interrupted" => AgentStatus::Interrupted,
            _ => AgentStatus::Stopped,
        }
    }

    /// True while a turn is in flight (what "interrupted" means after a crash).
    pub fn is_busy(self) -> bool {
        matches!(
            self,
            AgentStatus::Starting | AgentStatus::Working | AgentStatus::NeedsPermission
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigOptionChoice {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigOption {
    pub id: String,
    pub name: String,
    pub category: Option<String>,
    pub current_value: String,
    pub options: Vec<ConfigOptionChoice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub title: String,
    pub provider: Provider,
    pub account_id: String,
    pub project_path: String,
    pub cwd: String,
    pub worktree: bool,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub base_commit: Option<String>,
    pub session_id: Option<String>,
    pub status: AgentStatus,
    pub running: bool,
    pub group_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_activity_at: i64,
    pub cost_usd: f64,
    pub tokens_used: i64,
    pub context_used: Option<i64>,
    pub context_size: Option<i64>,
    pub unread: bool,
    pub archived: bool,
    pub last_message: Option<String>,
    pub pending_permissions: i64,
    #[serde(default)]
    pub config_options: Vec<ConfigOption>,
    /// The running agent takes a message while it works and reads it at its next
    /// step (Claude's queued prompts, Codex's turn/steer), so "Send now" doesn't
    /// stop it. Without this "Send now" only moves the message to the front of
    /// the queue; stopping the turn is always the separate "Stop and send".
    #[serde(default)]
    pub steerable: bool,
    /// Slash commands the agent advertises (ACP `available_commands_update`).
    #[serde(default)]
    pub available_commands: Vec<SlashCommand>,
    /// The last turn failed on a usage/rate limit; the UI offers switching accounts.
    #[serde(default)]
    pub rate_limited: bool,
    /// When the usage limit that stopped this agent is expected to lift, or the next time
    /// Kvistcode will try again after a failed resume (unix ms). None = not waiting or unknown.
    #[serde(default)]
    pub limit_resets_at: Option<i64>,
    /// The automatic resume of this agent after a usage limit: present while it waits.
    #[serde(default)]
    pub limit_resume: Option<crate::limit_resume::LimitResume>,
    /// Set when the agent was started by a schedule.
    #[serde(default)]
    pub schedule_id: Option<String>,
    /// For `Provider::Custom`: which `CustomAgent` definition runs this agent.
    #[serde(default)]
    pub custom_agent_id: Option<String>,
    /// For `Provider::Local`: the model the server runs for this agent.
    #[serde(default)]
    pub model: Option<String>,
    /// Messages sent while a turn was running; they run, in order, right after it.
    #[serde(default)]
    pub queued_prompts: i64,
    /// The queued messages themselves (oldest first), so the UI can show/edit them.
    #[serde(default)]
    pub queue: Vec<QueuedPrompt>,
    /// The queue is paused (the turn was cancelled/stopped/failed); nothing runs
    /// until the user sends one of them or a new message.
    #[serde(default)]
    pub queue_paused: bool,
    /// How this agent's sessions start: "auto" or "ask" (None = the settings default).
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// When the user last marked this agent "done" in triage; attention from
    /// before this time is dismissed.
    #[serde(default)]
    pub acknowledged_at: Option<i64>,
    /// The next session must be briefed with the conversation so far (set when the
    /// agent moved to another account; survives restarts until the brief is sent).
    #[serde(default)]
    pub needs_briefing: bool,
    /// Which version of Kvistcode's guidance (see `guidance::tag`: it can show pictures, how to
    /// write replies) the agent has been given, as its system prompt or as a note ahead of a
    /// prompt when its session was resumed. Empty = none yet.
    #[serde(default)]
    pub guide_tag: String,
    /// The user's last choice per composer option (model, effort, …), re-applied
    /// whenever this agent's adapter restarts. Never holds permission options.
    #[serde(default)]
    pub config_choices: std::collections::BTreeMap<String, String>,
    /// This agent's own spending limits, set by "Raise limit"; they win over the
    /// per-agent defaults in settings.
    #[serde(default)]
    pub budget: Option<crate::budget::BudgetCap>,
    /// Set while the agent waits at a spending limit (see `manager/budgets.rs`).
    #[serde(default)]
    pub budget_hold: Option<crate::budget::BudgetHold>,
    /// Turns this agent has completed, for turn limits. None = not counted yet (an agent
    /// from before turn limits): startup counts it from the stored messages.
    #[serde(default)]
    pub turns: Option<i64>,
    /// For a helper agent: the main agent it works for.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Present only on helpers: how their files relate to the main agent's.
    #[serde(default)]
    pub helper_sync: Option<HelperSync>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HelperSyncState {
    InSync,
    PendingToMain,
    PendingFromMain,
    Merging,
    Conflict,
}

/// How a helper's files relate to its main agent's. (The sync bases are private
/// git refs, `refs/kvistcode/helpers/<helper>/...`, not fields.)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperSync {
    pub state: HelperSyncState,
    /// When the last merge in either direction happened (ms).
    #[serde(default)]
    pub last_sync_at: Option<i64>,
    /// User-facing detail, e.g. the files that conflicted.
    #[serde(default)]
    pub detail: Option<String>,
    /// Files merged in the last sync.
    #[serde(default)]
    pub files: i64,
}

/// What the composer's send does while the agent is busy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BusySend {
    /// Like Claude Code: hand the message to the running turn when the agent can take
    /// it (it reads it at its next step), else queue it behind the turn. Older
    /// settings called this "ask".
    #[default]
    #[serde(alias = "ask")]
    Deliver,
    /// Hold it until the running turn ends.
    Queue,
    /// Start a helper agent right away.
    Helper,
}

/// How agents are told to write their replies. It shapes the reply, not the work done.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResponseStyle {
    /// The outcome first, then only what the reader needs to decide, verify or act on.
    #[default]
    Concise,
    /// The outcome, then a short account of what changed, how it was checked and what is left.
    Balanced,
    /// A structured, richer account: reasoning, verification and next steps.
    Detailed,
}

/// Which agent a helper runs as; unset parts mean "same as the main agent".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HelperDefaults {
    pub provider: Option<Provider>,
    pub account_id: Option<String>,
    pub custom_agent_id: Option<String>,
    pub model: Option<String>,
}

/// Prefix of the error `delete_agent` returns when removing the agent's worktree
/// would lose uncommitted changes or unmerged commits. The UI can offer to delete
/// anyway (`force: true`). Full text: "Unsaved work: <details>. Delete anyway to
/// discard them."
pub const UNSAVED_WORK_ERROR: &str = "Unsaved work";

/// Non-archived agent tallies (for the tray), computed without cloning agents.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCounts {
    /// Non-archived agents.
    pub total: usize,
    /// Starting or working.
    pub working: usize,
    /// Waiting on a permission answer.
    pub needs_permission: usize,
    /// Pending approvals (at least one per agent waiting on a permission).
    pub pending_permissions: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedPrompt {
    pub id: String,
    pub text: String,
    pub attachments: usize,
}

/// A queued message taken back out of the queue (so the composer can edit it).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedPrompt {
    pub text: String,
    pub attachments: Vec<Attachment>,
}

/// A user-defined ACP agent (Gemini CLI, Goose, OpenCode, an in-house agent, …).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgent {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<KeyValue>,
    #[serde(default = "default_custom_color")]
    pub color: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// A sub-agent an agent delegated work to (Claude's Agent/Task tool, Codex
/// collaborator threads).
/// How Claude Code's result for a background sub-agent launch begins.
pub const ASYNC_LAUNCH_PREFIX: &str = "Async agent launched";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubAgent {
    /// e.g. "general-purpose", "Explore", or the Codex tool name.
    pub kind: Option<String>,
    pub description: Option<String>,
    pub prompt: Option<String>,
    /// The model it was asked to run on, when the launch names one (otherwise it inherits the agent's).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Its reasoning effort, when the launch names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Launched in the background (Claude `run_in_background`): the call
    /// completes as soon as the sub-agent starts, but the sub-agent keeps
    /// running. The adapter reports no per-sub-agent end to us, so the UI treats
    /// it as running until the turn ends (the adapter holds the turn open while
    /// background sub-agents live).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub background: bool,
    /// A management call on existing sub-agents (Codex wait / close / send
    /// input), not a sub-agent of its own: shown, but never counted as running.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub control: bool,
    /// Set when this is a Claude Code "Workflow" run (several agents in parallel) rather
    /// than a single sub-agent; `kind` is then "workflow".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<Box<WorkflowLaunch>>,
}

/// Where a launched Workflow keeps its transcripts, read from the launch call's output.
/// The directory is never trusted blindly: `workflow::progress` re-validates it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowLaunch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default)]
    pub transcript_dir: String,
}

/// An image attached to a prompt or shown in the timeline. Inline it is a base64
/// payload (no data: prefix); stored in the timeline it is a file in the pictures
/// folder named by `path`, with `data` empty. Older rows keep their inline `data`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub name: String,
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub data: String,
    /// File name of the stored picture (see `pictures.rs`), when it isn't inline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    pub name: String,
    pub description: Option<String>,
    /// Placeholder for the command's argument, if it takes one.
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    Other,
}

impl ToolKind {
    pub fn parse(s: &str) -> ToolKind {
        match s {
            "read" => ToolKind::Read,
            "edit" => ToolKind::Edit,
            "delete" => ToolKind::Delete,
            "move" => ToolKind::Move,
            "search" => ToolKind::Search,
            "execute" => ToolKind::Execute,
            "think" => ToolKind::Think,
            "fetch" => ToolKind::Fetch,
            _ => ToolKind::Other,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

impl ToolStatus {
    pub fn parse(s: &str) -> ToolStatus {
        match s {
            "in_progress" | "inProgress" => ToolStatus::InProgress,
            "completed" => ToolStatus::Completed,
            "failed" | "declined" => ToolStatus::Failed,
            _ => ToolStatus::Pending,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub unified: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionOptionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
}

impl PermissionOptionKind {
    pub fn parse(s: &str) -> PermissionOptionKind {
        match s {
            "allow_always" => PermissionOptionKind::AllowAlways,
            "reject_once" => PermissionOptionKind::RejectOnce,
            "reject_always" => PermissionOptionKind::RejectAlways,
            _ => PermissionOptionKind::AllowOnce,
        }
    }

    pub fn is_allow(self) -> bool {
        matches!(
            self,
            PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub id: String,
    pub name: String,
    pub kind: PermissionOptionKind,
}

/// One thing a question asks for. Answers are keyed by `id`: a string for
/// `single` and `text`, an array of strings for `multi`, a bool for `boolean`
/// and a number for `number`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionField {
    pub id: String,
    /// A short label (e.g. "Database"), if any.
    #[serde(default)]
    pub title: Option<String>,
    /// The question itself when several are asked at once, or help text.
    #[serde(default)]
    pub description: Option<String>,
    pub kind: QuestionKind,
    /// The choices of a `single` or `multi` field.
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    /// A free-text "Other" box belonging to this choice field (its id): shown
    /// with that field rather than on its own.
    #[serde(default)]
    pub other_for: Option<String>,
    #[serde(default)]
    pub required: bool,
    /// Typed text shouldn't be shown (a password or key).
    #[serde(default)]
    pub secret: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionKind {
    Single,
    Multi,
    Text,
    Boolean,
    Number,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    /// What the answer records.
    pub value: String,
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanPriority {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub content: String,
    pub status: PlanStatus,
    pub priority: Option<PlanPriority>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeLevel {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ItemBody {
    UserMessage {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<Attachment>,
        /// Sent while the agent was working: it reads this at its next step.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        mid_turn: bool,
        /// Sent by Kvistcode, not typed: the "continue" after a usage limit reset.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        automatic: bool,
    },
    AgentMessage {
        text: String,
        /// Pictures the model put in its reply (an image block; Kvistcode never fetches
        /// remote images itself). Usually with empty `text`: the text that follows
        /// starts a new message.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<Attachment>,
    },
    Thought {
        text: String,
    },
    ToolCall {
        tool_call_id: String,
        title: String,
        tool_kind: ToolKind,
        status: ToolStatus,
        locations: Vec<String>,
        diffs: Vec<FileDiff>,
        output: String,
        command: Option<String>,
        /// Images the tool produced or looked at (screenshots, renders, …).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<Attachment>,
        /// Set when this call launched a sub-agent; its own tool calls name this
        /// call's `tool_call_id` as their parent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subagent: Option<SubAgent>,
        /// The sub-agent call this tool call ran under, if any.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_tool_call_id: Option<String>,
    },
    Permission {
        request_id: String,
        title: String,
        tool_kind: Option<ToolKind>,
        command: Option<String>,
        diffs: Vec<FileDiff>,
        options: Vec<PermissionOption>,
        resolution: Option<String>,
        /// Set when this approves a plan (Claude's ExitPlanMode): the plan markdown.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plan: Option<String>,
    },
    /// A question the agent (or one of its MCP servers) asks you: Claude's
    /// AskUserQuestion, Codex's request_user_input, an MCP server's form. It waits
    /// like an approval until answered or skipped.
    Question {
        request_id: String,
        /// The question (when there is one) or an introduction to the fields.
        message: String,
        /// Who asks when it isn't the agent itself (an MCP server's name).
        #[serde(default)]
        source: Option<String>,
        fields: Vec<QuestionField>,
        /// "answered", "skipped" or "cancelled"; `None` while waiting.
        resolution: Option<String>,
        /// What was answered, by field id (see `QuestionField`), once answered.
        #[serde(default)]
        answers: Option<serde_json::Map<String, serde_json::Value>>,
    },
    Plan {
        entries: Vec<PlanEntry>,
    },
    Notice {
        level: NoticeLevel,
        text: String,
    },
    /// What a finished turn did: the "review" shown when an agent is done.
    TurnSummary {
        duration_ms: i64,
        files: Vec<String>,
        tool_calls: i64,
        commands: i64,
        cost_usd: f64,
        tokens: i64,
    },
}

impl ItemBody {
    /// A sub-agent launch whose result says "Async agent launched" runs in the background even when
    /// the request did not carry `run_in_background` (a custom agent that always runs that way, or
    /// Claude Code backgrounding it): the call completes at once but the sub-agent keeps working.
    pub fn adopt_async_launch(&mut self) {
        if let ItemBody::ToolCall {
            subagent: Some(sa),
            output,
            ..
        } = self
        {
            if !sa.control && sa.workflow.is_none() && output.starts_with(ASYNC_LAUNCH_PREFIX) {
                sa.background = true;
            }
        }
    }

    /// The item's pictures: a message's attachments, a reply's or tool call's images.
    pub fn pictures(&self) -> &[Attachment] {
        match self {
            ItemBody::UserMessage { attachments, .. } => attachments,
            ItemBody::AgentMessage { images, .. } | ItemBody::ToolCall { images, .. } => images,
            _ => &[],
        }
    }

    pub fn kind_str(&self) -> &'static str {
        match self {
            ItemBody::UserMessage { .. } => "user_message",
            ItemBody::AgentMessage { .. } => "agent_message",
            ItemBody::Thought { .. } => "thought",
            ItemBody::ToolCall { .. } => "tool_call",
            ItemBody::Permission { .. } => "permission",
            ItemBody::Question { .. } => "question",
            ItemBody::Plan { .. } => "plan",
            ItemBody::Notice { .. } => "notice",
            ItemBody::TurnSummary { .. } => "turn_summary",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineItem {
    pub id: String,
    pub agent_id: String,
    pub seq: i64,
    pub ts: i64,
    #[serde(flatten)]
    pub body: ItemBody,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionReason {
    Permission,
    Done,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeltaField {
    Text,
    Output,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "view",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum NavigateTarget {
    Agent { agent_id: String },
    Inbox,
    NewAgent,
    MissionControl,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub provider: Provider,
    pub display_name: String,
    pub cli_name: String,
    pub installed: bool,
    /// Kvistcode's own copy is in use (not one found on the system's PATH).
    #[serde(default)]
    pub managed: bool,
    /// Version of Kvistcode's own copy of the agent package (Claude: the ACP adapter, which
    /// brings Claude Code); `None` until it's installed.
    #[serde(default)]
    pub managed_version: Option<String>,
    /// The version Kvistcode was tested with: the way back from a bad update.
    #[serde(default)]
    pub tested_version: Option<String>,
    /// The newest release found by the last update check.
    #[serde(default)]
    pub latest_version: Option<String>,
    /// A newer release than Kvistcode's own copy exists.
    #[serde(default)]
    pub update_available: bool,
    /// When the last update check finished (unix ms).
    #[serde(default)]
    pub updates_checked_at: Option<i64>,
    pub version: Option<String>,
    pub path: Option<String>,
    pub adapter_required: bool,
    pub adapter_installed: bool,
    pub node_available: bool,
    pub install_command: String,
    pub docs_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
// Events are short-lived and queued, so the size of the `Agent` variant is harmless.
#[allow(clippy::large_enum_variant)]
pub enum KvistcodeEvent {
    AgentUpdated {
        agent: Agent,
    },
    AgentRemoved {
        agent_id: String,
    },
    ItemUpserted {
        item: TimelineItem,
    },
    TextDelta {
        agent_id: String,
        item_id: String,
        field: DeltaField,
        delta: String,
        /// Length of the field before this delta, in UTF-16 code units (JavaScript
        /// string length). Clients apply a delta only when it matches their copy:
        /// smaller means already applied, larger means a gap (refetch). Every stream
        /// also ends with a full `ItemUpserted`, which heals any gap.
        offset: usize,
    },
    AccountUpdated {
        account: Account,
    },
    AccountRemoved {
        account_id: String,
    },
    Attention {
        agent_id: String,
        reason: AttentionReason,
        title: String,
        body: String,
        /// Set for `Permission`: the exact request this alert is about.
        request_id: Option<String>,
    },
    TerminalOutput {
        terminal_id: String,
        data: String,
    },
    TerminalExit {
        terminal_id: String,
        code: Option<i32>,
    },
    ProvidersChanged {
        providers: Vec<ProviderInfo>,
    },
    Navigate {
        to: NavigateTarget,
    },
    UpdateAvailable {
        update: UpdateInfo,
    },
    ScheduleUpdated {
        schedule: Schedule,
    },
    ScheduleRemoved {
        schedule_id: String,
    },
    UpdateProgress {
        downloaded: u64,
        total: Option<u64>,
    },
    /// The settings were changed from somewhere other than the desktop window (the phone),
    /// so the window shows the new values and doesn't save an older copy over them.
    SettingsChanged {
        settings: Box<Settings>,
    },
}

/// A newer Kvistcode release on GitHub.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
    /// GitHub release page.
    pub url: String,
    /// True when a signed in-place update can be installed (Windows, macOS, AppImage).
    pub can_install: bool,
}

/// Which built-in set of attention sounds plays (custom files override per event).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SoundPack {
    /// Warm mallet tones (the default).
    #[default]
    Soft,
    /// Brighter bell and crystal tones with a longer shimmer.
    Glass,
    /// The original plain synthesized tones.
    Classic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SoundSettings {
    pub enabled: bool,
    pub volume: f32,
    /// Built-in sound set; old settings files without it get the default.
    #[serde(default)]
    pub pack: SoundPack,
    pub on_permission: bool,
    pub on_done: bool,
    pub on_error: bool,
    /// Custom sound files (wav/ogg/mp3/flac); None = Kvistcode's built-in sound.
    #[serde(default)]
    pub custom_permission: Option<String>,
    #[serde(default)]
    pub custom_done: Option<String>,
    #[serde(default)]
    pub custom_error: Option<String>,
    /// A soft chime when the agent you're watching finishes a long task (smart mute
    /// otherwise keeps that silent).
    pub chime_when_watching: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationSettings {
    pub enabled: bool,
    pub on_permission: bool,
    pub on_done: bool,
    pub on_error: bool,
    pub smart_mute: bool,
}

/// Where an alert target posts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlertKind {
    /// A Slack incoming webhook.
    #[default]
    Slack,
    /// A Discord channel webhook.
    Discord,
    /// Any endpoint: Kvistcode POSTs JSON.
    Webhook,
}

/// Which events an alert target hears about.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AlertEvents {
    /// An agent waits for an approval or an answer.
    pub needs_you: bool,
    pub finished: bool,
    pub failed: bool,
    /// A spending limit paused an agent.
    pub budget: bool,
}

impl Default for AlertEvents {
    fn default() -> Self {
        AlertEvents {
            needs_you: true,
            finished: false,
            failed: true,
            budget: true,
        }
    }
}

/// A place alerts are posted besides the desktop and ntfy: a Slack or Discord
/// incoming webhook, or any URL that takes a JSON POST.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AlertTarget {
    pub id: String,
    /// A label shown in Settings (optional).
    pub name: String,
    pub kind: AlertKind,
    /// The webhook URL. A secret: the database keeps a `keychain:` reference and the
    /// URL itself lives in the OS keychain.
    pub url: String,
    pub enabled: bool,
    pub events: AlertEvents,
}

impl Default for AlertTarget {
    fn default() -> Self {
        AlertTarget {
            id: String::new(),
            name: String::new(),
            kind: AlertKind::default(),
            url: String::new(),
            enabled: true,
            events: AlertEvents::default(),
        }
    }
}

/// Most alert targets one installation keeps.
pub const MAX_ALERT_TARGETS: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QuietHours {
    pub enabled: bool,
    pub start: String,
    pub end: String,
}

/// How the sidebar lists projects: the user's own order and named sections.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectLayout {
    /// Projects follow the order below instead of recent activity.
    pub custom_order: bool,
    /// Project paths outside any section, in the user's order (projects not listed sort by activity).
    pub order: Vec<String>,
    /// Named sections in the user's order.
    pub sections: Vec<ProjectSection>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectSection {
    pub id: String,
    pub name: String,
    /// Project paths in this section, in order.
    pub projects: Vec<String>,
}

/// Most sections the sidebar can have.
pub const MAX_PROJECT_SECTIONS: usize = 100;
/// Most project paths `ProjectLayout` lists, in `order` and every section together.
pub const MAX_LAYOUT_PROJECTS: usize = 2000;
pub const MAX_SECTION_NAME_LEN: usize = 60;
pub const MAX_SECTION_ID_LEN: usize = 64;
pub const MAX_LAYOUT_PATH_LEN: usize = 4096;

impl ProjectLayout {
    /// Every path in the layout: `order` first, then each section in turn.
    pub(crate) fn paths(&self) -> impl Iterator<Item = &String> {
        self.order
            .iter()
            .chain(self.sections.iter().flat_map(|s| &s.projects))
    }

    /// What is wrong with the layout, in words for the user (None = fine).
    pub fn problem(&self) -> Option<String> {
        if self.sections.len() > MAX_PROJECT_SECTIONS {
            return Some(format!(
                "You can have up to {MAX_PROJECT_SECTIONS} sections."
            ));
        }
        let mut ids = std::collections::HashSet::new();
        for section in &self.sections {
            if section.id.trim().is_empty() || section.id.chars().count() > MAX_SECTION_ID_LEN {
                return Some(format!(
                    "A section needs an id of up to {MAX_SECTION_ID_LEN} characters."
                ));
            }
            if !ids.insert(section.id.as_str()) {
                return Some("Two sections have the same id.".into());
            }
            if section.name.trim().is_empty() {
                return Some("A section needs a name.".into());
            }
            if section.name.chars().count() > MAX_SECTION_NAME_LEN {
                return Some(format!(
                    "Section names can be up to {MAX_SECTION_NAME_LEN} characters."
                ));
            }
        }
        if self.paths().count() > MAX_LAYOUT_PROJECTS {
            return Some(format!(
                "The sidebar can list up to {MAX_LAYOUT_PROJECTS} projects in its order and sections."
            ));
        }
        let mut seen = std::collections::HashSet::new();
        for path in self.paths() {
            if path.trim().is_empty() {
                return Some("A project in the sidebar order has no folder.".into());
            }
            if path.chars().count() > MAX_LAYOUT_PATH_LEN {
                return Some(format!(
                    "A project folder in the sidebar order is longer than {MAX_LAYOUT_PATH_LEN} characters."
                ));
            }
            if !seen.insert(path.as_str()) {
                return Some(format!("The sidebar lists {path} more than once."));
            }
        }
        None
    }

    /// Repairs what `problem` rejects where that is simple: drops empty, over-long and repeated
    /// paths (the first one stays), drops sections with a bad or repeated id, trims and shortens
    /// names (an empty one becomes "Section") and cuts the counts to their limits. Returns whether
    /// anything changed. Resets the whole layout only if something is left that can't be repaired.
    pub fn sanitize(&mut self) -> bool {
        let before = self.clone();
        let mut ids = std::collections::HashSet::new();
        self.sections.retain(|s| {
            !s.id.trim().is_empty()
                && s.id.chars().count() <= MAX_SECTION_ID_LEN
                && ids.insert(s.id.clone())
        });
        self.sections.truncate(MAX_PROJECT_SECTIONS);
        for section in &mut self.sections {
            let name: String = section
                .name
                .trim()
                .chars()
                .take(MAX_SECTION_NAME_LEN)
                .collect();
            let name = name.trim_end();
            section.name = if name.is_empty() { "Section" } else { name }.into();
        }
        let mut seen = std::collections::HashSet::new();
        let mut room = MAX_LAYOUT_PROJECTS;
        for list in std::iter::once(&mut self.order)
            .chain(self.sections.iter_mut().map(|s| &mut s.projects))
        {
            list.retain(|p| {
                let keep = !p.trim().is_empty()
                    && p.chars().count() <= MAX_LAYOUT_PATH_LEN
                    && room > 0
                    && seen.insert(p.clone());
                room -= usize::from(keep);
                keep
            });
        }
        if self.problem().is_some() {
            *self = ProjectLayout::default();
        }
        *self != before
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub onboarded: bool,
    pub theme: String,
    /// Interface zoom in percent (`MIN_INTERFACE_SCALE`..=`MAX_INTERFACE_SCALE`).
    pub interface_scale: u32,
    pub sounds: SoundSettings,
    pub notifications: NotificationSettings,
    pub quiet_hours: QuietHours,
    pub close_to_tray: bool,
    pub auto_resume: bool,
    /// When a usage limit stops agents, continue them by themselves once it resets.
    pub resume_after_limit: bool,
    /// Keep Kvistcode's own copies of the agent tools (Claude Code, Codex, Grok) up to date
    /// by itself; otherwise updates wait for a click in Settings → Agent tools.
    pub auto_update_tools: bool,
    pub default_worktree: bool,
    pub launch_at_login: bool,
    pub global_hotkey: String,
    pub escalate_after_mins: u32,
    pub ntfy_url: Option<String>,
    /// How much a phone push (ntfy) says: "minimal" (generic text) or "full"
    /// (the agent's own text, secrets scrubbed).
    pub ntfy_detail: String,
    pub recent_projects: Vec<String>,
    pub auto_check_updates: bool,
    /// One-letter keys (A/Y/D/N to answer an approval, J/K/E in Needs you) work window-wide.
    pub single_key_shortcuts: bool,
    pub templates: Vec<PromptTemplate>,
    pub mcp_servers: Vec<McpServer>,
    /// What to do when an account hits a usage/rate limit: "off" | "ask" | "auto".
    pub failover: String,
    pub custom_agents: Vec<CustomAgent>,
    /// How new agents start: "auto" (the agent's own Auto mode, where it has one)
    /// or "ask" (the agent's default, which asks before acting).
    pub default_permission_mode: String,
    pub remote: RemoteSettings,
    pub voice: VoiceSettings,
    /// The OpenAI Realtime voice assistant (off by default).
    pub voice_assistant: VoiceAssistantSettings,
    /// The last composer choices per provider identity (`claude`, `custom:<id>`, …),
    /// applied to new agents of that provider. Never holds permission options.
    pub config_defaults:
        std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>>,
    /// What sending does while an agent is busy: "deliver" | "queue" | "helper".
    pub busy_send: BusySend,
    /// How agents are told to write their replies: "concise" | "balanced" | "detailed".
    /// Read whenever an agent is briefed: new agents get it from the start, existing ones
    /// the next time their session is resumed.
    pub response_style: ResponseStyle,
    /// The language agents and the voice assistant reply in: a name from `guidance::LANGUAGES`,
    /// or empty to follow whatever language the user writes in. Applied like the response style.
    pub default_language: String,
    /// Which agent a helper runs as (unset = same as the main agent).
    pub helper_defaults: HelperDefaults,
    /// Cap on what all agents together spend per local day, in USD (None = no cap).
    pub daily_budget_usd: Option<f64>,
    /// Cap on what one agent spends in total, in USD (None = no cap).
    pub agent_budget_usd: Option<f64>,
    /// What reaching a cap does: alert only, or also hold the agents at their next turn end.
    pub budget_action: crate::budget::BudgetAction,
    /// Token caps, like the dollar ones (None = no cap).
    pub daily_budget_tokens: Option<i64>,
    pub agent_budget_tokens: Option<i64>,
    /// Turn caps (completed turns), for accounts with no per-token cost (None = no cap).
    pub daily_budget_turns: Option<i64>,
    pub agent_budget_turns: Option<i64>,
    /// Caps on everything the agents of one project spend, by project folder.
    pub project_budgets: std::collections::BTreeMap<String, crate::budget::BudgetCap>,
    /// The order of the sidebar's projects and the named sections they are filed under.
    pub project_layout: ProjectLayout,
    /// Slack, Discord and generic webhook targets for alerts (ntfy has its own field).
    pub alert_targets: Vec<AlertTarget>,
    /// Claude agents summarize their conversation once it reaches this many tokens, instead of
    /// at Claude Code's own (much later, on 1M-context models) threshold. Every step an agent
    /// takes re-reads its whole context, so a shorter one is the biggest token saver
    /// (None = leave Claude Code's default; the default is `token_saver::DEFAULT_COMPACT_WINDOW`).
    /// See `token_saver`.
    pub auto_compact_window: Option<u32>,
    /// The other "Save tokens" options (output tidying, command output limit, helper model).
    pub token_saver: crate::token_saver::TokenSaverOptions,
}

/// The voice assistant: talk to Kvistcode through OpenAI's Realtime API. Off by default;
/// audio and the agent information it reads are sent to OpenAI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VoiceAssistantSettings {
    pub enabled: bool,
    /// The OpenAI API-key account (provider Codex) that pays for the sessions.
    pub account_id: Option<String>,
    pub voice: String,
    pub model: String,
    pub max_session_mins: u32,
    /// End the session after this long without anyone speaking.
    pub silence_timeout_secs: u32,
    /// The user wears headphones, so the microphone stays open while the assistant
    /// talks and they can interrupt it. Off: the mic is muted during playback so the
    /// speakers don't feed the assistant its own voice.
    pub headphones: bool,
    /// Run what the assistant proposes (start an agent, send a message, rename) at once,
    /// without the confirmation card. Off by default. Agents' own permission requests are
    /// never answered by the assistant, whatever this says.
    pub auto_confirm: bool,
    /// System-wide shortcut that starts or stops the assistant while Kvistcode is in the
    /// background (a Tauri accelerator like `CmdOrCtrl+Shift+V`). Empty: off.
    pub hotkey: String,
    /// Listen (on this device, with the dictation speech model) for `wake_phrase`, which
    /// starts the assistant or wakes a paused one. Off by default.
    pub wake_word: bool,
    pub wake_phrase: String,
}

impl Default for VoiceAssistantSettings {
    fn default() -> Self {
        VoiceAssistantSettings {
            enabled: false,
            account_id: None,
            voice: "marin".into(),
            model: "gpt-realtime".into(),
            max_session_mins: 10,
            silence_timeout_secs: 60,
            headphones: false,
            auto_confirm: false,
            hotkey: String::new(),
            wake_word: false,
            wake_phrase: crate::wake::DEFAULT_WAKE_PHRASE.into(),
        }
    }
}

/// A shortcut with case and spaces ignored, to spot two settings that mean the same keys.
fn hotkey_key(hotkey: &str) -> String {
    hotkey
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Voice dictation (local speech-to-text).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VoiceSettings {
    /// Input device name; `None` is the system default.
    pub input_device: Option<String>,
    /// Whisper model id (see `voice::MODELS`).
    pub model: String,
    /// "auto" or a language code (non-English needs a multilingual model).
    pub language: String,
    /// Send the message as soon as dictation finishes.
    pub auto_send: bool,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        VoiceSettings {
            input_device: None,
            model: crate::voice::DEFAULT_MODEL.into(),
            language: "auto".into(),
            auto_send: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteSettings {
    /// Serve the mobile companion / remote control API.
    pub enabled: bool,
    /// Listen on all interfaces (LAN) instead of only this computer.
    pub lan: bool,
    pub port: u16,
    /// Reach Kvistcode over Tailscale: listen on this computer only and publish it to the
    /// tailnet with Tailscale Serve (HTTPS). Not combined with `lan`.
    pub tailscale: bool,
    /// The network address to listen on for LAN access (one of this computer's own);
    /// `None` picks automatically (Wi-Fi/Ethernet before Tailscale before other VPNs).
    pub lan_address: Option<String>,
}

impl Default for RemoteSettings {
    fn default() -> Self {
        RemoteSettings {
            enabled: false,
            lan: false,
            port: 47821,
            tailscale: false,
            lan_address: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplate {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValue {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpTransport {
    #[default]
    Stdio,
    /// Streamable HTTP. Unknown transports (e.g. "sse", or one a newer Kvistcode
    /// added) read as HTTP: every transport other than stdio is URL-based.
    #[serde(other)]
    Http,
}

/// An MCP server made available to agents of every provider: all projects, or just one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub transport: McpTransport,
    /// stdio
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<KeyValue>,
    /// http
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: Vec<KeyValue>,
    /// Empty: available to every project. Otherwise only to agents in that project folder.
    #[serde(default)]
    pub project_path: String,
}

/// A project whose folder was found at a new place.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMove {
    pub from: String,
    pub to: String,
}

/// What "refresh projects" did: folders it re-pointed, and folders it couldn't find
/// (the user picks those by hand).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRefresh {
    pub moved: Vec<ProjectMove>,
    pub missing: Vec<String>,
}

/// Starts an agent automatically at `time` (local, "HH:MM") on the given weekdays.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub provider: Provider,
    pub account_id: String,
    pub project_path: String,
    pub prompt: String,
    pub worktree: bool,
    pub time: String,
    /// 0 = Sunday … 6 = Saturday. Empty means every day.
    pub days: Vec<u8>,
    pub last_run_at: Option<i64>,
    pub last_agent_id: Option<String>,
    #[serde(default)]
    pub custom_agent_id: Option<String>,
    /// When the schedule was created or last edited; runs before this are skipped so
    /// saving a schedule never fires it retroactively.
    #[serde(default)]
    pub updated_at: i64,
    /// Why the last run failed to start (None after a successful run or an edit).
    #[serde(default)]
    pub last_error: Option<String>,
    /// "auto" or "ask" for the agents this schedule starts (None = settings default).
    #[serde(default)]
    pub permission_mode: Option<String>,
}

impl Default for SoundSettings {
    fn default() -> Self {
        SoundSettings {
            enabled: true,
            volume: 0.7,
            pack: SoundPack::default(),
            on_permission: true,
            on_done: true,
            on_error: true,
            custom_permission: None,
            custom_done: None,
            custom_error: None,
            chime_when_watching: true,
        }
    }
}

impl Default for NotificationSettings {
    fn default() -> Self {
        NotificationSettings {
            enabled: true,
            on_permission: true,
            on_done: true,
            on_error: true,
            smart_mute: true,
        }
    }
}

impl Default for QuietHours {
    fn default() -> Self {
        QuietHours {
            enabled: false,
            start: "22:00".into(),
            end: "08:00".into(),
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_custom_color() -> String {
    "#B39DDB".into()
}

pub const MIN_INTERFACE_SCALE: u32 = 75;
pub const MAX_INTERFACE_SCALE: u32 = 150;
/// Longest shortcut string accepted for a hotkey setting.
pub const MAX_HOTKEY_LEN: usize = 64;

impl Settings {
    /// Rejects values the rest of Kvistcode can't act on.
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.failover.as_str(), "off" | "ask" | "auto") {
            return Err(format!(
                "Unknown failover setting \u{201c}{}\u{201d} (use off, ask or auto)",
                self.failover
            ));
        }
        if !matches!(self.default_permission_mode.as_str(), "auto" | "ask") {
            return Err(format!(
                "Unknown permission mode \u{201c}{}\u{201d} (use auto or ask)",
                self.default_permission_mode
            ));
        }
        if !(MIN_INTERFACE_SCALE..=MAX_INTERFACE_SCALE).contains(&self.interface_scale) {
            return Err(format!(
                "Interface scale must be between {MIN_INTERFACE_SCALE}% and {MAX_INTERFACE_SCALE}%"
            ));
        }
        if self.remote.port == 0 {
            return Err("The remote control port must be between 1 and 65535".into());
        }
        if self.remote.lan && self.remote.tailscale {
            return Err("Choose either Tailscale or your local network for remote access".into());
        }
        if let Some(addr) = &self.remote.lan_address {
            if addr.parse::<std::net::IpAddr>().is_err() {
                return Err(format!("\u{201c}{addr}\u{201d} isn't a network address"));
            }
        }
        for (name, cap) in [
            ("daily budget", self.daily_budget_usd),
            ("agent budget", self.agent_budget_usd),
        ] {
            if cap.is_some_and(|c| !c.is_finite() || c <= 0.0) {
                return Err(format!(
                    "The {name} must be more than $0 (or empty for no cap)"
                ));
            }
        }
        for (name, cap) in [
            ("daily token budget", self.daily_budget_tokens),
            ("agent token budget", self.agent_budget_tokens),
            ("daily turn budget", self.daily_budget_turns),
            ("agent turn budget", self.agent_budget_turns),
        ] {
            if cap.is_some_and(|c| c <= 0) {
                return Err(format!(
                    "The {name} must be more than 0 (or empty for no cap)"
                ));
            }
        }
        for (project, cap) in &self.project_budgets {
            if let Some(problem) = cap.problem() {
                return Err(format!("Project budget for {project}: {problem}"));
            }
        }
        if let Some(problem) = self.project_layout.problem() {
            return Err(problem);
        }
        crate::voice::validate_voice(&self.voice.model, &self.voice.language)?;
        if !crate::guidance::valid_language(&self.default_language) {
            return Err(format!(
                "Unknown language \u{201c}{}\u{201d}",
                self.default_language
            ));
        }
        if self.voice_assistant.hotkey.chars().count() > MAX_HOTKEY_LEN {
            return Err("The voice assistant hotkey is too long".into());
        }
        if let Some(problem) = crate::wake::wake_phrase_problem(&self.voice_assistant.wake_phrase) {
            return Err(problem);
        }
        if self.voice_assistant_hotkey_clashes() {
            return Err(
                "The voice assistant hotkey must differ from the global hotkey (which brings Kvistcode forward)"
                    .into(),
            );
        }
        if let Some(w) = self.auto_compact_window {
            if !crate::token_saver::COMPACT_WINDOW_RANGE.contains(&w) {
                return Err("The auto-compact size must be between 100,000 and 1,000,000 tokens (or empty for Claude's default)".into());
            }
        }
        if let Some(problem) = self.token_saver.problem() {
            return Err(problem);
        }
        Ok(())
    }

    /// The voice assistant hotkey is set and is the same keys as the global hotkey.
    fn voice_assistant_hotkey_clashes(&self) -> bool {
        let va = hotkey_key(&self.voice_assistant.hotkey);
        !va.is_empty() && va == hotkey_key(&self.global_hotkey)
    }

    /// Resets values `validate` would reject to their defaults (for settings read
    /// from storage, so one bad value can't block every later save). Returns the
    /// names of the fields that were reset.
    pub fn sanitize(&mut self) -> Vec<&'static str> {
        let defaults = Settings::default();
        let mut reset = Vec::new();
        if !matches!(self.failover.as_str(), "off" | "ask" | "auto") {
            self.failover = defaults.failover;
            reset.push("failover");
        }
        if !matches!(self.default_permission_mode.as_str(), "auto" | "ask") {
            self.default_permission_mode = defaults.default_permission_mode;
            reset.push("defaultPermissionMode");
        }
        if !(MIN_INTERFACE_SCALE..=MAX_INTERFACE_SCALE).contains(&self.interface_scale) {
            self.interface_scale = defaults.interface_scale;
            reset.push("interfaceScale");
        }
        if self.remote.port == 0 {
            self.remote.port = defaults.remote.port;
            reset.push("remote.port");
        }
        if self
            .voice
            .input_device
            .as_deref()
            .is_some_and(|d| d.trim().is_empty())
        {
            self.voice.input_device = None;
            reset.push("voice.inputDevice");
        }
        for (cap, name) in [
            (&mut self.daily_budget_usd, "dailyBudgetUsd"),
            (&mut self.agent_budget_usd, "agentBudgetUsd"),
        ] {
            if cap.is_some_and(|c| !c.is_finite() || c <= 0.0) {
                *cap = None;
                reset.push(name);
            }
        }
        for (cap, name) in [
            (&mut self.daily_budget_tokens, "dailyBudgetTokens"),
            (&mut self.agent_budget_tokens, "agentBudgetTokens"),
            (&mut self.daily_budget_turns, "dailyBudgetTurns"),
            (&mut self.agent_budget_turns, "agentBudgetTurns"),
        ] {
            if cap.is_some_and(|c| c <= 0) {
                *cap = None;
                reset.push(name);
            }
        }
        let mut bad_project = false;
        for cap in self.project_budgets.values_mut() {
            bad_project |= cap.sanitize();
        }
        self.project_budgets.retain(|_, cap| !cap.is_empty());
        if bad_project {
            reset.push("projectBudgets");
        }
        if self.project_layout.sanitize() {
            reset.push("projectLayout");
        }
        if self.voice_assistant.hotkey.chars().count() > MAX_HOTKEY_LEN
            || self.voice_assistant_hotkey_clashes()
        {
            self.voice_assistant.hotkey = String::new();
            reset.push("voiceAssistant.hotkey");
        }
        if crate::wake::wake_phrase_problem(&self.voice_assistant.wake_phrase).is_some() {
            self.voice_assistant.wake_phrase = defaults.voice_assistant.wake_phrase.clone();
            reset.push("voiceAssistant.wakePhrase");
        }
        if crate::voice::model_spec(&self.voice.model).is_none() {
            self.voice.model = defaults.voice.model.clone();
            reset.push("voice.model");
        }
        if crate::voice::validate_voice(&self.voice.model, &self.voice.language).is_err() {
            self.voice.language = defaults.voice.language;
            reset.push("voice.language");
        }
        if !crate::guidance::valid_language(&self.default_language) {
            self.default_language = String::new();
            reset.push("defaultLanguage");
        }
        if self
            .auto_compact_window
            .is_some_and(|w| !crate::token_saver::COMPACT_WINDOW_RANGE.contains(&w))
        {
            self.auto_compact_window = None;
            reset.push("autoCompactWindow");
        }
        reset.extend(self.token_saver.sanitize());
        let hd = &mut self.helper_defaults;
        for (field, name) in [
            (&mut hd.account_id, "helperDefaults.accountId"),
            (&mut hd.custom_agent_id, "helperDefaults.customAgentId"),
            (&mut hd.model, "helperDefaults.model"),
        ] {
            if field.as_deref().is_some_and(|v| v.trim().is_empty()) {
                *field = None;
                reset.push(name);
            }
        }
        reset
    }
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            onboarded: false,
            theme: "gunmetal".into(),
            interface_scale: 100,
            sounds: SoundSettings::default(),
            notifications: NotificationSettings::default(),
            quiet_hours: QuietHours::default(),
            close_to_tray: true,
            auto_resume: false,
            resume_after_limit: true,
            auto_update_tools: true,
            default_worktree: true,
            launch_at_login: false,
            global_hotkey: "CmdOrCtrl+Shift+Space".into(),
            escalate_after_mins: 5,
            ntfy_url: None,
            ntfy_detail: "minimal".into(),
            recent_projects: Vec::new(),
            auto_check_updates: true,
            single_key_shortcuts: true,
            templates: vec![
                PromptTemplate {
                    id: "tpl-tests".into(),
                    name: "Write tests".into(),
                    body: "Write thorough tests for {{file}}. Cover edge cases and failure modes, and run them.".into(),
                },
                PromptTemplate {
                    id: "tpl-review".into(),
                    name: "Review my changes".into(),
                    body: "Review the uncommitted changes in this repository for bugs, security issues and readability. List concrete problems with file:line references, most severe first.".into(),
                },
                PromptTemplate {
                    id: "tpl-explain".into(),
                    name: "Explain this codebase".into(),
                    body: "Give me a guided tour of this codebase: its architecture, the main modules and how data flows between them.".into(),
                },
            ],
            mcp_servers: Vec::new(),
            failover: "ask".into(),
            custom_agents: Vec::new(),
            default_permission_mode: "auto".into(),
            remote: RemoteSettings::default(),
            voice: VoiceSettings::default(),
            voice_assistant: VoiceAssistantSettings::default(),
            config_defaults: Default::default(),
            busy_send: BusySend::Deliver,
            response_style: ResponseStyle::Concise,
            default_language: String::new(),
            helper_defaults: HelperDefaults::default(),
            daily_budget_usd: None,
            agent_budget_usd: None,
            budget_action: Default::default(),
            daily_budget_tokens: None,
            agent_budget_tokens: None,
            daily_budget_turns: None,
            agent_budget_turns: None,
            project_budgets: Default::default(),
            project_layout: ProjectLayout::default(),
            alert_targets: Vec::new(),
            // On by default: measured as the biggest saver (see docs/TOKEN-SAVING.md). Anyone who
            // chooses "Claude's default" in Settings saves an explicit null, which stays off.
            auto_compact_window: Some(crate::token_saver::PRESET_COMPACT_WINDOW),
            token_saver: Default::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentRequest {
    pub provider: Provider,
    pub account_id: String,
    pub project_path: String,
    pub prompt: String,
    pub title: Option<String>,
    pub worktree: bool,
    pub model: Option<String>,
    pub group_id: Option<String>,
    #[serde(default)]
    pub custom_agent_id: Option<String>,
    /// "auto" or "ask" for this agent; None uses `Settings::default_permission_mode`.
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAccountRequest {
    pub provider: Provider,
    pub name: String,
    pub color: String,
    pub auth_kind: AuthKind,
    pub api_key: Option<String>,
    /// For `Provider::Local`: the server to talk to (`api_key` is then an optional
    /// bearer token for it).
    #[serde(default)]
    pub local: Option<LocalServer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub agent_id: String,
    pub item_id: String,
    pub kind: String,
    /// A short excerpt; each matched word is wrapped in `\u{1}` and `\u{2}`.
    pub snippet: String,
    pub ts: i64,
    /// The item's place in its agent's timeline, so the UI can load back to it.
    pub seq: i64,
}

/// The best matches in one agent's conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchGroup {
    pub agent_id: String,
    /// Best match first, at most a handful.
    pub hits: Vec<SearchHit>,
    /// How many items in this conversation matched (of those searched).
    pub total: usize,
}

/// Conversation search results, best conversation first.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub groups: Vec<SearchGroup>,
    /// Older conversations are still being indexed in the background, so the
    /// results may be incomplete.
    pub indexing: bool,
    /// More items matched than were looked at.
    pub truncated: bool,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod sound_settings_tests {
    use super::*;

    #[test]
    fn sound_pack_defaults_to_soft_for_old_settings() {
        assert_eq!(SoundSettings::default().pack, SoundPack::Soft);
        let old: SoundSettings =
            serde_json::from_str(r#"{"enabled":false,"volume":0.3,"onDone":false}"#).unwrap();
        assert_eq!(old.pack, SoundPack::Soft);
        assert!(!old.enabled && !old.on_done);
        assert_eq!(old.volume, 0.3);
    }

    #[test]
    fn sound_pack_round_trips_as_lowercase() {
        for (pack, name) in [
            (SoundPack::Soft, "soft"),
            (SoundPack::Glass, "glass"),
            (SoundPack::Classic, "classic"),
        ] {
            let s = SoundSettings {
                pack,
                ..SoundSettings::default()
            };
            let json = serde_json::to_value(&s).unwrap();
            assert_eq!(json["pack"], name);
            let back: SoundSettings = serde_json::from_value(json).unwrap();
            assert_eq!(back.pack, pack);
        }
        assert!(serde_json::from_str::<SoundPack>("\"loud\"").is_err());
    }
}

#[cfg(test)]
mod voice_settings_tests {
    use super::*;

    #[test]
    fn wake_phrase_defaults_off_loads_from_old_settings_and_is_checked() {
        // Saved before the wake phrase existed.
        let old: Settings =
            serde_json::from_str(r#"{"voiceAssistant":{"enabled":true,"hotkey":""}}"#).unwrap();
        assert!(!old.voice_assistant.wake_word);
        assert_eq!(old.voice_assistant.wake_phrase, "Hey Kvistcode");
        let mut s = Settings::default();
        s.voice_assistant.wake_phrase = "Kvistcode".into();
        assert!(s.validate().unwrap_err().contains("at least two words"));
        assert_eq!(s.sanitize(), vec!["voiceAssistant.wakePhrase"]);
        assert_eq!(s.voice_assistant.wake_phrase, "Hey Kvistcode");
        assert!(s.validate().is_ok());
    }

    #[test]
    fn defaults_validate() {
        let s = Settings::default();
        assert!(s.validate().is_ok());
        assert_eq!(s.voice.model, "base.en");
        assert!(!s.voice.auto_send);
    }

    #[test]
    fn voice_assistant_hotkey_is_optional_and_must_differ_from_the_global_one() {
        let mut s = Settings::default();
        assert!(s.voice_assistant.hotkey.is_empty());
        s.voice_assistant.hotkey = "CmdOrCtrl+Shift+V".into();
        assert!(s.validate().is_ok());
        // Same keys, written differently.
        s.voice_assistant.hotkey = " cmdorctrl + shift+space ".into();
        assert!(s.validate().is_err());
        assert_eq!(s.sanitize(), vec!["voiceAssistant.hotkey"]);
        assert!(s.voice_assistant.hotkey.is_empty());
        // With the global hotkey off, any shortcut is fine.
        s.global_hotkey.clear();
        s.voice_assistant.hotkey = "CmdOrCtrl+Shift+Space".into();
        assert!(s.validate().is_ok());
        s.voice_assistant.hotkey = "A".repeat(MAX_HOTKEY_LEN + 1);
        assert!(s.validate().is_err());
    }

    #[test]
    fn old_voice_assistant_settings_load_without_a_hotkey() {
        let va: VoiceAssistantSettings =
            serde_json::from_str(r#"{"enabled":true,"voice":"marin"}"#).unwrap();
        assert!(va.enabled);
        assert!(va.hotkey.is_empty());
    }

    #[test]
    fn voice_settings_are_validated_and_sanitized() {
        let mut s = Settings::default();
        s.voice.language = "fr".into();
        assert!(s.validate().is_err(), "English-only model with French");
        s.voice.model = "small".into();
        assert!(s.validate().is_ok());
        s.voice.model = "gone".into();
        assert!(s.validate().is_err());

        // Sanitizing repairs it so one bad value can't block later saves.
        s.voice.input_device = Some("  ".into());
        let reset = s.sanitize();
        assert!(reset.contains(&"voice.model"));
        assert!(reset.contains(&"voice.language"));
        assert!(reset.contains(&"voice.inputDevice"));
        assert!(s.validate().is_ok());
        assert_eq!(s.voice.language, "auto");
    }

    #[test]
    fn old_settings_files_get_voice_defaults() {
        let s: Settings = serde_json::from_str(r#"{"theme":"gunmetal"}"#).unwrap();
        assert_eq!(s.voice.model, "base.en");
    }

    #[test]
    fn old_files_load_without_remembered_choices() {
        let s: Settings = serde_json::from_str(r#"{"theme":"gunmetal"}"#).unwrap();
        assert!(s.config_defaults.is_empty());
        let mut s = Settings::default();
        s.config_defaults
            .entry("claude".into())
            .or_default()
            .insert("model".into(), "opus".into());
        let back: Settings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back.config_defaults["claude"]["model"], "opus");
        assert!(back.validate().is_ok());
    }

    #[test]
    fn default_language_is_empty_by_default_and_must_be_listed() {
        let old: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(old.default_language, "");
        let mut s = Settings {
            default_language: "German".into(),
            ..Settings::default()
        };
        assert!(s.validate().is_ok());
        s.default_language = "Elvish".into();
        assert!(s.validate().unwrap_err().contains("Unknown language"));
        // A stored value that is no longer listed falls back instead of breaking startup.
        let reset = s.sanitize();
        assert_eq!(s.default_language, "");
        assert!(reset.contains(&"defaultLanguage"));
    }

    #[test]
    fn response_style_defaults_to_concise_and_round_trips() {
        let old: Settings = serde_json::from_str(r#"{"theme":"gunmetal"}"#).unwrap();
        assert_eq!(old.response_style, ResponseStyle::Concise);
        assert_eq!(
            serde_json::to_value(&old).unwrap()["responseStyle"],
            "concise"
        );
        for (word, style) in [
            ("concise", ResponseStyle::Concise),
            ("balanced", ResponseStyle::Balanced),
            ("detailed", ResponseStyle::Detailed),
        ] {
            let s: Settings =
                serde_json::from_str(&format!(r#"{{"responseStyle":"{word}"}}"#)).unwrap();
            assert_eq!(s.response_style, style);
            let back: Settings = serde_json::from_value(serde_json::to_value(&s).unwrap()).unwrap();
            assert_eq!(back.response_style, style);
            assert!(back.validate().is_ok());
        }
        assert!(serde_json::from_str::<Settings>(r#"{"responseStyle":"nope"}"#).is_err());
    }

    #[test]
    fn helper_settings_round_trip_and_old_files_load() {
        let s: Settings = serde_json::from_str(r#"{"theme":"gunmetal"}"#).unwrap();
        assert_eq!(s.busy_send, BusySend::Deliver);
        assert_eq!(s.helper_defaults, HelperDefaults::default());
        // The old default "ask" (a chooser each time) now means deliver mid-turn.
        let old: Settings = serde_json::from_str(r#"{"busySend":"ask"}"#).unwrap();
        assert_eq!(old.busy_send, BusySend::Deliver);
        assert_eq!(serde_json::to_value(&old).unwrap()["busySend"], "deliver");
        // An explicit choice survives untouched.
        let q: Settings = serde_json::from_str(r#"{"busySend":"queue"}"#).unwrap();
        assert_eq!(q.busy_send, BusySend::Queue);
        let mut s = Settings {
            busy_send: BusySend::Helper,
            ..Settings::default()
        };
        s.helper_defaults.provider = Some(Provider::Codex);
        s.helper_defaults.model = Some("gpt".into());
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["busySend"], "helper");
        assert_eq!(json["helperDefaults"]["provider"], "codex");
        assert!(json["helperDefaults"]["accountId"].is_null());
        let back: Settings = serde_json::from_value(json).unwrap();
        assert_eq!(back.busy_send, BusySend::Helper);
        assert_eq!(back.helper_defaults.model.as_deref(), Some("gpt"));
        assert!(back.validate().is_ok());
        assert!(serde_json::from_str::<Settings>(r#"{"busySend":"nope"}"#).is_err());
        let mut blank = Settings::default();
        blank.helper_defaults.model = Some("  ".into());
        assert!(blank.sanitize().contains(&"helperDefaults.model"));
    }

    #[test]
    fn helper_sync_serializes_camel_case_and_old_agents_load() {
        let mut a = sample_agent();
        assert!(a.parent_id.is_none() && a.helper_sync.is_none());
        a.parent_id = Some("m".into());
        a.helper_sync = Some(HelperSync {
            state: HelperSyncState::PendingToMain,
            last_sync_at: Some(5),
            detail: None,
            files: 2,
        });
        let v = serde_json::to_value(&a).unwrap();
        assert_eq!(v["parentId"], "m");
        assert_eq!(v["helperSync"]["state"], "pendingToMain");
        assert_eq!(v["helperSync"]["lastSyncAt"], 5);
        assert_eq!(v["helperSync"]["files"], 2);
        assert!(v["helperSync"]["detail"].is_null());
        for (s, n) in [
            (HelperSyncState::InSync, "inSync"),
            (HelperSyncState::PendingFromMain, "pendingFromMain"),
            (HelperSyncState::Merging, "merging"),
            (HelperSyncState::Conflict, "conflict"),
        ] {
            assert_eq!(serde_json::to_value(s).unwrap(), n);
        }
        let mut old = v;
        old.as_object_mut().unwrap().remove("parentId");
        old.as_object_mut().unwrap().remove("helperSync");
        let back: Agent = serde_json::from_value(old).unwrap();
        assert!(back.parent_id.is_none() && back.helper_sync.is_none());
    }

    #[test]
    fn old_agent_json_loads_without_config_choices() {
        let mut a = serde_json::to_value(sample_agent()).unwrap();
        a.as_object_mut().unwrap().remove("configChoices");
        let a: Agent = serde_json::from_value(a).unwrap();
        assert!(a.config_choices.is_empty());
        let mut b = a.clone();
        b.config_choices.insert("effort".into(), "high".into());
        let back: Agent = serde_json::from_str(&serde_json::to_string(&b).unwrap()).unwrap();
        assert_eq!(back.config_choices["effort"], "high");
    }

    fn sample_agent() -> Agent {
        serde_json::from_value(serde_json::json!({
            "id": "a", "title": "t", "provider": "claude", "accountId": "x",
            "projectPath": "/p", "cwd": "/p", "worktree": false, "branch": null,
            "baseBranch": null, "baseCommit": null, "sessionId": null,
            "status": "idle", "running": false, "groupId": null, "createdAt": 0,
            "updatedAt": 0, "lastActivityAt": 0, "costUsd": 0.0, "tokensUsed": 0,
            "contextUsed": null, "contextSize": null, "unread": false, "archived": false,
            "lastMessage": null, "pendingPermissions": 0
        }))
        .unwrap()
    }
}

#[cfg(test)]
mod project_layout_tests {
    use super::*;

    fn section(id: &str, name: &str, projects: &[&str]) -> ProjectSection {
        ProjectSection {
            id: id.into(),
            name: name.into(),
            projects: projects.iter().map(|p| p.to_string()).collect(),
        }
    }

    fn layout(order: &[&str], sections: Vec<ProjectSection>) -> Settings {
        Settings {
            project_layout: ProjectLayout {
                custom_order: true,
                order: order.iter().map(|p| p.to_string()).collect(),
                sections,
            },
            ..Settings::default()
        }
    }

    #[test]
    fn old_settings_load_without_a_layout_and_a_layout_round_trips() {
        let old: Settings = serde_json::from_str(r#"{"theme":"gunmetal"}"#).unwrap();
        assert_eq!(old.project_layout, ProjectLayout::default());
        assert!(!old.project_layout.custom_order);
        assert!(old.validate().is_ok());
        // The shape the interface reads and writes.
        let json = serde_json::to_value(&old).unwrap();
        assert_eq!(
            json["projectLayout"],
            serde_json::json!({ "customOrder": false, "order": [], "sections": [] })
        );

        let s = layout(
            &["/b", "/a"],
            vec![
                section("s1", "Websites", &["/c"]),
                section("s2", "Games", &[]),
            ],
        );
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(
            json["projectLayout"],
            serde_json::json!({
                "customOrder": true,
                "order": ["/b", "/a"],
                "sections": [
                    { "id": "s1", "name": "Websites", "projects": ["/c"] },
                    { "id": "s2", "name": "Games", "projects": [] },
                ],
            })
        );
        let back: Settings = serde_json::from_value(json).unwrap();
        assert_eq!(back.project_layout, s.project_layout);
        assert!(back.validate().is_ok());
        // A section written without a project list still loads.
        let sparse: Settings =
            serde_json::from_str(r#"{"projectLayout":{"sections":[{"id":"s1","name":"Games"}]}}"#)
                .unwrap();
        assert!(sparse.project_layout.sections[0].projects.is_empty());
        assert!(sparse.validate().is_ok());
    }

    #[test]
    fn validate_accepts_a_good_layout_and_names_each_problem() {
        let good = layout(&["/b", "/a"], vec![section("s1", "Websites", &["/c"])]);
        assert!(good.validate().is_ok());
        let err = |s: Settings| s.validate().unwrap_err();

        let nameless = layout(&[], vec![section("s1", "  ", &[])]);
        assert_eq!(err(nameless), "A section needs a name.");
        let long = layout(&[], vec![section("s1", &"é".repeat(61), &[])]);
        assert_eq!(err(long), "Section names can be up to 60 characters.");
        // Characters are counted, not bytes: 60 two-byte characters are fine.
        assert!(layout(&[], vec![section("s1", &"é".repeat(60), &[])])
            .validate()
            .is_ok());

        let no_id = layout(&[], vec![section("", "A", &[])]);
        assert!(err(no_id).contains("id"));
        let long_id = layout(&[], vec![section(&"i".repeat(65), "A", &[])]);
        assert!(err(long_id).contains("id"));
        assert!(layout(&[], vec![section(&"i".repeat(64), "A", &[])])
            .validate()
            .is_ok());
        let same_id = layout(&[], vec![section("s", "A", &[]), section("s", "B", &[])]);
        assert_eq!(err(same_id), "Two sections have the same id.");

        let many: Vec<_> = (0..=MAX_PROJECT_SECTIONS)
            .map(|i| section(&format!("s{i}"), "A", &[]))
            .collect();
        assert_eq!(err(layout(&[], many)), "You can have up to 100 sections.");
        let many: Vec<_> = (0..MAX_PROJECT_SECTIONS)
            .map(|i| section(&format!("s{i}"), "A", &[]))
            .collect();
        assert!(layout(&[], many).validate().is_ok());

        let empty_path = layout(&["/a", " "], vec![]);
        assert!(err(empty_path).contains("has no folder"));
        let empty_in_section = layout(&[], vec![section("s", "A", &[""])]);
        assert!(err(empty_in_section).contains("has no folder"));
        let long_path = "/".repeat(MAX_LAYOUT_PATH_LEN + 1);
        assert!(err(layout(&[&long_path], vec![])).contains("4096"));
        let ok_path = "/".repeat(MAX_LAYOUT_PATH_LEN);
        assert!(layout(&[&ok_path], vec![]).validate().is_ok());

        // A path may be listed once across the order and every section.
        assert!(err(layout(&["/a", "/a"], vec![])).contains("/a more than once"));
        let across = layout(&["/a"], vec![section("s", "A", &["/b", "/a"])]);
        assert!(err(across).contains("/a more than once"));
        let two_sections = layout(
            &[],
            vec![section("s1", "A", &["/a"]), section("s2", "B", &["/a"])],
        );
        assert!(err(two_sections).contains("more than once"));

        // At most 2000 paths in all.
        let paths: Vec<String> = (0..MAX_LAYOUT_PROJECTS).map(|i| format!("/p{i}")).collect();
        let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        assert!(layout(&refs, vec![]).validate().is_ok());
        let over = layout(&refs, vec![section("s", "A", &["/one-more"])]);
        assert!(err(over).contains("2000"));
    }

    #[test]
    fn sanitize_repairs_what_it_can_and_leaves_a_good_layout_alone() {
        let mut good = layout(&["/b", "/a"], vec![section("s1", "Websites", &["/c"])]);
        let before = good.project_layout.clone();
        assert!(good.sanitize().is_empty());
        assert_eq!(good.project_layout, before);

        let mut s = layout(
            &[
                "/a",
                "",
                "  ",
                "/b",
                "/a",
                &"/".repeat(MAX_LAYOUT_PATH_LEN + 1),
            ],
            vec![
                section("s1", "  Websites  ", &["/b", "/c", "/c", ""]),
                section("", "No id", &["/x"]),
                section("s1", "Same id", &["/y"]),
                section("s2", "   ", &["/a", "/d"]),
                section("s3", &"é".repeat(70), &[]),
                section(&"i".repeat(65), "Long id", &["/z"]),
            ],
        );
        assert!(s.validate().is_err());
        assert_eq!(s.sanitize(), vec!["projectLayout"]);
        assert!(s.validate().is_ok());
        let l = &s.project_layout;
        assert!(l.custom_order, "the switch is kept");
        // Empty and over-long entries go and the first copy of a path stays.
        assert_eq!(l.order, vec!["/a", "/b"]);
        let ids: Vec<&str> = l.sections.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["s1", "s2", "s3"]);
        assert_eq!(l.sections[0].name, "Websites");
        assert_eq!(l.sections[0].projects, vec!["/c"]);
        assert_eq!(l.sections[1].name, "Section");
        assert_eq!(l.sections[1].projects, vec!["/d"]);
        assert_eq!(l.sections[2].name, "é".repeat(60));
        // Already repaired: nothing more to do.
        assert!(s.sanitize().is_empty());

        // Counts are cut to their limits.
        let many: Vec<_> = (0..MAX_PROJECT_SECTIONS + 5)
            .map(|i| section(&format!("s{i}"), "A", &[]))
            .collect();
        let mut s = layout(&[], many);
        assert_eq!(s.sanitize(), vec!["projectLayout"]);
        assert_eq!(s.project_layout.sections.len(), MAX_PROJECT_SECTIONS);
        let paths: Vec<String> = (0..MAX_LAYOUT_PROJECTS + 10)
            .map(|i| format!("/p{i}"))
            .collect();
        let (head, tail) = paths.split_at(MAX_LAYOUT_PROJECTS - 1);
        let mut s = Settings::default();
        s.project_layout.order = head.to_vec();
        s.project_layout.sections = vec![ProjectSection {
            id: "s".into(),
            name: "A".into(),
            projects: tail.to_vec(),
        }];
        assert_eq!(s.sanitize(), vec!["projectLayout"]);
        assert_eq!(s.project_layout.order.len(), MAX_LAYOUT_PROJECTS - 1);
        assert_eq!(s.project_layout.sections[0].projects, vec![tail[0].clone()]);
        assert!(s.validate().is_ok());
    }
}
