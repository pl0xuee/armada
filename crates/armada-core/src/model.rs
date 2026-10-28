//! Domain types shared with the UI. Mirrors apps/desktop/src/lib/types.ts.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Claude,
    Codex,
    Grok,
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
            Provider::Custom => "custom",
        }
    }

    pub fn parse(s: &str) -> Option<Provider> {
        match s {
            "claude" => Some(Provider::Claude),
            "codex" => Some(Provider::Codex),
            "grok" => Some(Provider::Grok),
            "custom" => Some(Provider::Custom),
            _ => None,
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Provider::Claude => "Claude",
            Provider::Codex => "ChatGPT (Codex)",
            Provider::Grok => "Grok",
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
    /// Latest usage-window snapshot, where the provider reports one (Codex).
    #[serde(default)]
    pub usage: Option<AccountUsage>,
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
    pub sounds: SoundSettings,
    pub notifications: NotificationSettings,
    pub quiet_hours: QuietHours,
    pub close_to_tray: bool,
    pub auto_resume: bool,
    pub default_worktree: bool,
    pub launch_at_login: bool,
    pub global_hotkey: String,
    pub escalate_after_mins: u32,
    pub ntfy_url: Option<String>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteSettings {
    /// Serve the mobile companion / remote control API.
    pub enabled: bool,
    /// Listen on all interfaces (LAN) instead of only this computer.
    pub lan: bool,
    pub port: u16,
}

impl Default for RemoteSettings {
    fn default() -> Self {
        RemoteSettings {
            enabled: false,
            lan: false,
            port: 47821,
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
        if self.remote.port == 0 {
            return Err("The remote control port must be between 1 and 65535".into());
        }
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
        if self.remote.port == 0 {
            self.remote.port = defaults.remote.port;
            reset.push("remote.port");
        }
        reset
    }
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            onboarded: false,
            theme: "gunmetal".into(),
            sounds: SoundSettings::default(),
            notifications: NotificationSettings::default(),
            quiet_hours: QuietHours::default(),
            close_to_tray: true,
            auto_resume: false,
            default_worktree: true,
            launch_at_login: false,
            global_hotkey: "CmdOrCtrl+Shift+Space".into(),
            escalate_after_mins: 5,
            ntfy_url: None,
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
