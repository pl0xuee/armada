// Shared contract between the React UI and the Rust core (crates/armada-core).
// Field names are camelCase on the wire; Rust uses #[serde(rename_all = "camelCase")].
// Keep this file in sync with crates/armada-core/src/model.rs.

export type Provider = "claude" | "codex" | "grok" | "custom";

export type AuthKind = "default" | "oauth" | "api_key";

export interface AccountStatus {
  loggedIn: boolean;
  label: string | null; // e.g. "Claude Max", "ChatGPT Pro"
  email: string | null;
  plan: string | null;
  checkedAt: number; // unix ms
  error: string | null;
}

export interface Account {
  id: string;
  provider: Provider;
  name: string; // user-facing, e.g. "Work", "Personal"
  color: string; // hex, used for avatar ring
  authKind: AuthKind;
  /** true = uses the CLI's normal config dir (~/.claude, ~/.codex, ~/.grok) */
  isSystem: boolean;
  configDir: string | null; // isolated dir for non-system profiles
  createdAt: number;
  status: AccountStatus | null;
  /** Rate-limit windows reported by the provider (Codex today). */
  usage: AccountUsage | null;
}

export interface UsageWindow {
  usedPercent: number;
  windowMins: number | null;
  resetsAt: number | null; // unix ms
}

export interface AccountUsage {
  primary: UsageWindow | null;
  secondary: UsageWindow | null;
  plan: string | null;
  updatedAt: number;
}

export type AgentStatus =
  | "starting" // process spawning / session handshake
  | "working" // a turn is in progress
  | "needs_permission" // blocked on an approval
  | "idle" // turn finished, waiting for the next prompt
  | "error" // last turn failed
  | "interrupted" // app closed/crashed mid-turn, resumable
  | "stopped"; // process stopped by the user, resumable

export interface ConfigOptionChoice {
  value: string;
  name: string;
  description: string | null;
}

/** Session settings the agent exposes (model, mode, reasoning effort, ...). */
export interface ConfigOption {
  id: string;
  name: string;
  category: string | null; // "model" | "mode" | "thought_level" | ...
  currentValue: string;
  options: ConfigOptionChoice[];
}

export interface Agent {
  id: string;
  title: string;
  provider: Provider;
  accountId: string;
  projectPath: string; // folder the user picked
  cwd: string; // where the agent actually runs (worktree path or projectPath)
  worktree: boolean;
  branch: string | null;
  baseBranch: string | null;
  baseCommit: string | null;
  sessionId: string | null; // provider session/thread id, used for resume
  status: AgentStatus;
  running: boolean; // adapter process alive
  groupId: string | null; // set for Compare-mode siblings
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  costUsd: number;
  tokensUsed: number;
  contextUsed: number | null;
  contextSize: number | null;
  unread: boolean;
  archived: boolean;
  lastMessage: string | null; // short preview of the latest agent text
  pendingPermissions: number;
  configOptions: ConfigOption[];
  availableCommands: SlashCommand[];
  /** Last turn failed on a usage/rate limit. */
  rateLimited: boolean;
  /** Set when the agent was started by a schedule. */
  scheduleId: string | null;
  /** Set when provider === "custom". */
  customAgentId: string | null;
}

export interface SlashCommand {
  name: string;
  description: string | null;
  hint: string | null;
}

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface FileDiff {
  path: string;
  /** Either old/new full text (ACP) ... */
  oldText: string | null;
  newText: string | null;
  /** ... or a unified diff (Codex). */
  unified: string | null;
}

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface PermissionOption {
  id: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low" | null;
}

interface ItemBase {
  id: string;
  agentId: string;
  seq: number;
  ts: number;
}

export type TimelineItem = ItemBase &
  (
    | { kind: "user_message"; text: string; attachments?: Attachment[] }
    | { kind: "agent_message"; text: string }
    | { kind: "thought"; text: string }
    | {
        kind: "tool_call";
        toolCallId: string;
        title: string;
        toolKind: ToolKind;
        status: ToolStatus;
        locations: string[];
        diffs: FileDiff[];
        output: string;
        command: string | null;
      }
    | {
        kind: "permission";
        requestId: string;
        title: string;
        toolKind: ToolKind | null;
        command: string | null;
        diffs: FileDiff[];
        options: PermissionOption[];
        /** optionId chosen, "cancelled", or null while pending */
        resolution: string | null;
      }
    | { kind: "plan"; entries: PlanEntry[] }
    | { kind: "notice"; level: "info" | "warn" | "error"; text: string }
  );

export type TimelineKind = TimelineItem["kind"];

export type AttentionReason = "permission" | "done" | "error";

export type ArmadaEvent =
  | { type: "agent_updated"; agent: Agent }
  | { type: "agent_removed"; agentId: string }
  | { type: "item_upserted"; item: TimelineItem }
  /** Streaming append: `text` for messages/thoughts, `output` for tool calls. */
  | {
      type: "text_delta";
      agentId: string;
      itemId: string;
      field: "text" | "output";
      delta: string;
    }
  | { type: "account_updated"; account: Account }
  | { type: "account_removed"; accountId: string }
  | {
      type: "attention";
      agentId: string;
      reason: AttentionReason;
      title: string;
      body: string;
      /** Set for permission alerts. */
      requestId: string | null;
    }
  | { type: "terminal_output"; terminalId: string; data: string }
  | { type: "terminal_exit"; terminalId: string; code: number | null }
  | { type: "providers_changed"; providers: ProviderInfo[] }
  /** Backend asks the UI to navigate (tray menu, notification click, hotkey). */
  | { type: "navigate"; to: NavigateTarget }
  | { type: "update_available"; update: UpdateInfo }
  | { type: "update_progress"; downloaded: number; total: number | null };

export interface UpdateInfo {
  currentVersion: string;
  version: string; // e.g. "0.2.0"
  notes: string | null; // release notes (markdown)
  date: string | null;
  url: string; // GitHub release page
  /** true = signed in-place update available (Win/macOS/AppImage); false = open `url` to download */
  canInstall: boolean;
}

export type NavigateTarget =
  { view: "agent"; agentId: string } | { view: "inbox" } | { view: "new_agent" } | { view: "mission_control" };

export interface ProviderInfo {
  provider: Provider;
  displayName: string; // "Claude", "ChatGPT (Codex)", "Grok"
  cliName: string; // "claude", "codex", "grok"
  installed: boolean;
  version: string | null;
  path: string | null;
  /** Claude needs the ACP adapter (npm package) in addition to the CLI. */
  adapterRequired: boolean;
  adapterInstalled: boolean;
  nodeAvailable: boolean;
  installCommand: string; // shown to the user and runnable in the built-in terminal
  docsUrl: string;
}

export interface SoundSettings {
  enabled: boolean;
  volume: number; // 0..1
  onPermission: boolean;
  onDone: boolean;
  onError: boolean;
  /** Custom sound file paths (wav/ogg/mp3/flac); null = Armada's sound. */
  customPermission: string | null;
  customDone: string | null;
  customError: string | null;
}

export interface NotificationSettings {
  enabled: boolean;
  onPermission: boolean;
  onDone: boolean;
  onError: boolean;
  /** Skip sound + notification when the window is focused on that agent. */
  smartMute: boolean;
}

export interface QuietHours {
  enabled: boolean;
  start: string; // "22:00"
  end: string; // "08:00"
}

export interface Settings {
  onboarded: boolean;
  theme: "gunmetal" | "carbon" | "titanium";
  sounds: SoundSettings;
  notifications: NotificationSettings;
  quietHours: QuietHours;
  closeToTray: boolean;
  autoResume: boolean; // resume interrupted agents on launch
  defaultWorktree: boolean;
  launchAtLogin: boolean;
  globalHotkey: string; // e.g. "CmdOrCtrl+Shift+Space"
  escalateAfterMins: number; // re-ping pending approvals; 0 = off
  ntfyUrl: string | null; // optional phone push, e.g. https://ntfy.sh/my-topic
  recentProjects: string[];
  autoCheckUpdates: boolean;
  templates: PromptTemplate[];
  mcpServers: McpServer[];
  failover: "off" | "ask" | "auto";
  customAgents: CustomAgent[];
  remote: RemoteSettings;
}

/** Any ACP agent the user configured (Gemini CLI, Goose, OpenCode, ...). */
export interface CustomAgent {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: KeyValue[];
  color: string;
  enabled: boolean;
}

/** Image attachment; `data` is base64 without the "data:" prefix. */
export interface Attachment {
  name: string;
  mimeType: string;
  data: string;
}

export interface RemoteSettings {
  enabled: boolean;
  lan: boolean;
  port: number;
}

export interface ShareLink {
  token: string;
  agentId: string;
  agentTitle: string | null;
  url: string | null;
  createdAt: number;
}

export interface RemoteStatus {
  enabled: boolean;
  running: boolean;
  lan: boolean;
  port: number;
  url: string | null;
  pairingUrl: string | null;
  /** Server-generated SVG markup of a QR code for pairingUrl. */
  qrSvg: string | null;
  error: string | null;
  shares: ShareLink[];
}

/** `body` may contain {{placeholders}}. */
export interface PromptTemplate {
  id: string;
  name: string;
  body: string;
}

export interface KeyValue {
  name: string;
  value: string;
}

export type McpTransport = "stdio" | "http";

export interface McpServer {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  // stdio
  command: string;
  args: string[];
  env: KeyValue[];
  // http
  url: string;
  headers: KeyValue[];
}

export interface Schedule {
  id: string; // "" when creating
  name: string;
  enabled: boolean;
  provider: Provider;
  accountId: string;
  projectPath: string;
  prompt: string;
  worktree: boolean;
  time: string; // "HH:MM" local
  days: number[]; // 0=Sun..6=Sat; [] = every day
  lastRunAt: number | null;
  lastAgentId: string | null;
  customAgentId: string | null;
  updatedAt: number;
}

export interface AppState {
  agents: Agent[];
  accounts: Account[];
  providers: ProviderInfo[];
  settings: Settings;
  version: string;
  platform: "linux" | "macos" | "windows";
}

export interface CreateAgentRequest {
  provider: Provider;
  accountId: string;
  projectPath: string;
  prompt: string;
  title: string | null;
  worktree: boolean;
  model: string | null;
  groupId: string | null;
  customAgentId: string | null;
  attachments: Attachment[];
}

export interface CreateAccountRequest {
  provider: Provider;
  name: string;
  color: string;
  authKind: AuthKind; // "oauth" -> isolated profile + browser login; "api_key" -> key in OS keychain
  apiKey: string | null;
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
}

export interface AgentDiff {
  files: ChangedFile[];
  patch: string; // full unified diff vs. baseCommit (includes uncommitted work)
  ahead: number; // commits on the agent branch not in base
}

export interface SearchHit {
  agentId: string;
  itemId: string;
  kind: TimelineKind;
  snippet: string;
  ts: number;
}
