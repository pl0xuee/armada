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
    /// The running agent takes messages into its current turn (steering), so
    /// "Send now" doesn't have to stop it.
    #[serde(default)]
    pub steerable: bool,
    /// Slash commands the agent advertises (ACP `available_commands_update`).
    #[serde(default)]
    pub available_commands: Vec<SlashCommand>,
    /// The last turn failed on a usage/rate limit; the UI offers switching accounts.
    #[serde(default)]
    pub rate_limited: bool,
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
    /// The user's last choice per composer option (model, effort, …), re-applied
    /// whenever this agent's adapter restarts. Never holds permission options.
    #[serde(default)]
    pub config_choices: std::collections::BTreeMap<String, String>,
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
/// git refs, `refs/armada/helpers/<helper>/...`, not fields.)
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
    /// Ask each time.
    #[default]
    Ask,
    /// Queue behind the running turn.
    Queue,
    /// Start a helper agent right away.
    Helper,
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
}

/// An image attached to a prompt (base64 payload, no data: prefix).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub name: String,
    pub mime_type: String,
    pub data: String,
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
    },
    AgentMessage {
        text: String,
        /// Pictures the model put in its reply (an image block; Armada never fetches
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
    /// Armada's own copy is in use (not one found on the system's PATH).
    #[serde(default)]
    pub managed: bool,
    /// Version of Armada's own copy of the agent package (Claude: the ACP adapter, which
    /// brings Claude Code); `None` until it's installed.
    #[serde(default)]
    pub managed_version: Option<String>,
    /// The version Armada was tested with: the way back from a bad update.
    #[serde(default)]
    pub tested_version: Option<String>,
    /// The newest release found by the last update check.
    #[serde(default)]
    pub latest_version: Option<String>,
    /// A newer release than Armada's own copy exists.
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
pub enum ArmadaEvent {
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
}

/// A newer Armada release on GitHub.
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SoundSettings {
    pub enabled: bool,
    pub volume: f32,
    pub on_permission: bool,
    pub on_done: bool,
    pub on_error: bool,
    /// Custom sound files (wav/ogg/mp3/flac); None = Armada's built-in sound.
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QuietHours {
    pub enabled: bool,
    pub start: String,
    pub end: String,
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
    /// Keep Armada's own copies of the agent tools (Claude Code, Codex, Grok) up to date
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
    /// What sending does while an agent is busy: "ask" | "queue" | "helper".
    pub busy_send: BusySend,
    /// Which agent a helper runs as (unset = same as the main agent).
    pub helper_defaults: HelperDefaults,
    /// Cap on what all agents together spend per local day, in USD (None = no cap).
    pub daily_budget_usd: Option<f64>,
    /// Cap on what one agent spends in total, in USD (None = no cap).
    pub agent_budget_usd: Option<f64>,
    /// What reaching a cap does: alert only, or also pause the agents.
    pub budget_action: crate::budget::BudgetAction,
}

/// The voice assistant: talk to Armada through OpenAI's Realtime API. Off by default;
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
        }
    }
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
    /// Reach Armada over Tailscale: listen on this computer only and publish it to the
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
    /// Streamable HTTP. Unknown transports (e.g. "sse", or one a newer Armada
    /// added) read as HTTP: every transport other than stdio is URL-based.
    #[serde(other)]
    Http,
}

/// An MCP server made available to every agent (all providers).
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

impl Settings {
    /// Rejects values the rest of Armada can't act on.
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
        crate::voice::validate_voice(&self.voice.model, &self.voice.language)?;
        Ok(())
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
        if crate::voice::model_spec(&self.voice.model).is_none() {
            self.voice.model = defaults.voice.model.clone();
            reset.push("voice.model");
        }
        if crate::voice::validate_voice(&self.voice.model, &self.voice.language).is_err() {
            self.voice.language = defaults.voice.language;
            reset.push("voice.language");
        }
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
            auto_update_tools: true,
            default_worktree: true,
            launch_at_login: false,
            global_hotkey: "CmdOrCtrl+Shift+Space".into(),
            escalate_after_mins: 5,
            ntfy_url: None,
            ntfy_detail: "minimal".into(),
            recent_projects: Vec::new(),
            auto_check_updates: true,
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
            busy_send: BusySend::Ask,
            helper_defaults: HelperDefaults::default(),
            daily_budget_usd: None,
            agent_budget_usd: None,
            budget_action: Default::default(),
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
    pub snippet: String,
    pub ts: i64,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod voice_settings_tests {
    use super::*;

    #[test]
    fn defaults_validate() {
        let s = Settings::default();
        assert!(s.validate().is_ok());
        assert_eq!(s.voice.model, "base.en");
        assert!(!s.voice.auto_send);
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
    fn helper_settings_round_trip_and_old_files_load() {
        let s: Settings = serde_json::from_str(r#"{"theme":"gunmetal"}"#).unwrap();
        assert_eq!(s.busy_send, BusySend::Ask);
        assert_eq!(s.helper_defaults, HelperDefaults::default());
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
