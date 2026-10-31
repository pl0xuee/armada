// Shared contract between the React UI and the Rust core (crates/armada-core).
// Field names are camelCase on the wire; Rust uses #[serde(rename_all = "camelCase")].
// Keep this file in sync with crates/armada-core/src/model.rs.

export type Provider = "claude" | "codex" | "grok" | "local" | "custom";

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
  /** Rate-limit windows reported by the provider (Codex and Claude). */
  usage: AccountUsage | null;
  /** Provider "local": the model server this account talks to. */
  local?: LocalServer | null;
}

export type LocalKind = "ollama" | "lmstudio" | "custom";

/** baseUrl is the server root for Ollama / LM Studio, the OpenAI-compatible base for custom. */
export interface LocalServer {
  kind: LocalKind;
  baseUrl: string;
}

export interface LocalModel {
  id: string;
  sizeBytes: number | null;
  parameters: string | null;
  quantization: string | null;
  contextLength: number | null;
  /** null = the server doesn't say. */
  tools: boolean | null;
}

export interface LocalProbe {
  kind: LocalKind;
  baseUrl: string;
  running: boolean;
  models: LocalModel[];
  error: string | null;
  /** The server is not on this machine: prompts and code travel over the network. */
  remote: boolean;
}

export interface PullProgress {
  status: string;
  total: number | null;
  completed: number | null;
  done: boolean;
  error: string | null;
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
  /** The running agent takes messages into its current turn ("Send now" doesn't stop it). */
  steerable?: boolean;
  availableCommands: SlashCommand[];
  /** Last turn failed on a usage/rate limit. */
  rateLimited: boolean;
  /** Set when the agent was started by a schedule. */
  scheduleId: string | null;
  /** Set when provider === "custom". */
  customAgentId: string | null;
  /** Set when provider === "local": the model the server runs for this agent. */
  model?: string | null;
  /** Messages sent while a turn was running; they run in order right after it. */
  queuedPrompts: number;
  /** The queued messages themselves (not in the timeline until they run). */
  queue: QueuedPrompt[];
  /** Queue held after a stop/error; sending a new message resumes it. */
  queuePaused: boolean;
  /** When the user last marked this agent "Done" in triage (ms); dismissed while >= lastActivityAt. */
  acknowledgedAt: number | null;
  /** Permission mode chosen at launch ("auto" | "ask"), null = settings default at the time. */
  permissionMode: string | null;
  /** Backend-internal (handoff briefing pending); not shown in the UI. */
  needsBriefing: boolean;
  /** The user's last choice per composer option (model, effort, …); re-applied on restart. */
  configChoices: Record<string, string>;
  /** Set on a helper agent: the main agent it was started from. */
  parentId: string | null;
  /** Merge state with the main agent; only present on helpers. */
  helperSync: HelperSync | null;
}

export type HelperSyncState = "inSync" | "pendingToMain" | "pendingFromMain" | "merging" | "conflict";

export interface HelperSync {
  state: HelperSyncState;
  lastSyncAt: number | null;
  detail: string | null;
  /** Files differing from (or merged with) the main agent. */
  files: number;
}

/** What Enter does while the agent is busy. */
export type BusySend = "ask" | "queue" | "helper";

/** Where new helpers run; null = same as the main agent. */
export interface HelperDefaults {
  provider: Provider | null;
  accountId: string | null;
  customAgentId: string | null;
  model: string | null;
}

export interface QueuedPrompt {
  id: string;
  text: string;
  /** Number of image attachments. */
  attachments: number;
}

/** Set on tool calls that spawned a sub-agent (Claude Task tool, etc.). */
export interface SubagentInfo {
  kind?: string | null;
  description?: string | null;
  prompt?: string | null;
  /** The model it was asked to run on, when the launch names one (otherwise it inherits the agent's). */
  model?: string | null;
  /** Its reasoning effort, when the launch names one. */
  effort?: string | null;
  /** Launched in the background: the call completes at launch, the sub-agent keeps running. */
  background?: boolean;
  /** A management call (Codex wait/close/send), not a sub-agent of its own: never counted. */
  control?: boolean;
}

export type QuestionKind = "single" | "multi" | "text" | "boolean" | "number";

/**
 * One thing a question asks for. Answers are keyed by `id`: a string for `single`
 * and `text`, a string array for `multi`, a boolean for `boolean`, a number for `number`.
 */
export interface QuestionField {
  id: string;
  /** A short label (e.g. "Database"), if any. */
  title?: string | null;
  /** The question itself when several are asked at once, or help text. */
  description?: string | null;
  kind: QuestionKind;
  /** The choices of a `single` or `multi` field. */
  options?: QuestionOption[];
  /** A free-text "Other" box belonging to this choice field (its id): render it with that field. */
  otherFor?: string | null;
  required?: boolean;
  /** Typed text shouldn't be shown (a password or key). */
  secret?: boolean;
}

export interface QuestionOption {
  /** What the answer records. */
  value: string;
  label: string;
  description?: string | null;
}

/** Answers by field id (see QuestionField). Omitted fields are unanswered. */
export type QuestionAnswers = Record<string, string | string[] | boolean | number>;

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
    | {
        kind: "agent_message";
        text: string;
        /** Pictures the model put in its reply (usually with empty text). */
        images?: Attachment[];
      }
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
        /** Screenshots/images returned by the tool (omitted when empty). */
        images?: Attachment[];
        /** Present when this call runs a sub-agent. */
        subagent?: SubagentInfo;
        /** The sub-agent call this call ran inside. */
        parentToolCallId?: string;
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
        /** Set when this approves a plan (Claude's ExitPlanMode): the plan markdown. */
        plan?: string;
      }
    | {
        /**
         * A question the agent (or one of its MCP servers) asks: Claude's AskUserQuestion,
         * Codex's request_user_input, an MCP server's form. Waits like an approval.
         */
        kind: "question";
        requestId: string;
        /** The question (when there is one) or an introduction to the fields. */
        message: string;
        /** Who asks when it isn't the agent itself (an MCP server's name). */
        source?: string | null;
        fields: QuestionField[];
        /** "answered", "skipped" or "cancelled"; null while waiting. */
        resolution: string | null;
        /** What was answered, by field id, once answered. */
        answers?: QuestionAnswers | null;
      }
    | { kind: "plan"; entries: PlanEntry[] }
    | { kind: "notice"; level: "info" | "warn" | "error"; text: string }
    | {
        /** Pushed after a completed turn that used tools. */
        kind: "turn_summary";
        durationMs: number;
        files: string[];
        toolCalls: number;
        commands: number;
        costUsd: number;
        tokens: number;
      }
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
      /** Field length (UTF-16 code units) before this delta; see store/app.ts for the apply rules. */
      offset: number;
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
  | { type: "schedule_updated"; schedule: Schedule }
  | { type: "schedule_removed"; scheduleId: string }
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
  /** Armada's own copy is the one in use (false = a system install, or none). */
  managed: boolean;
  /** Version of Armada's own copy of the agent package (Claude: the ACP adapter); null if not installed. */
  managedVersion: string | null;
  /** The version Armada was tested with: the way back from a bad update. */
  testedVersion: string | null;
  /** Newest release found by the last update check. */
  latestVersion: string | null;
  updateAvailable: boolean;
  /** When the last update check finished (unix ms). */
  updatesCheckedAt: number | null;
  /** The version the CLI reports (Claude: Claude Code's). */
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
  /** Soft chime when the agent you are watching finishes a task longer than 30 s. */
  chimeWhenWatching: boolean;
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
  /** Interface zoom in percent, 75-150. */
  interfaceScale: number;
  sounds: SoundSettings;
  notifications: NotificationSettings;
  quietHours: QuietHours;
  closeToTray: boolean;
  autoResume: boolean; // resume interrupted agents on launch
  /** Install new releases of the agent tools in the background (checked every few hours). */
  autoUpdateTools: boolean;
  defaultWorktree: boolean;
  launchAtLogin: boolean;
  globalHotkey: string; // e.g. "CmdOrCtrl+Shift+Space"
  escalateAfterMins: number; // re-ping pending approvals; 0 = off
  ntfyUrl: string | null; // optional phone push, e.g. https://ntfy.sh/my-topic
  ntfyDetail: "minimal" | "full"; // what a phone push says: generic text, or the agent's own (scrubbed) text
  recentProjects: string[];
  autoCheckUpdates: boolean;
  templates: PromptTemplate[];
  mcpServers: McpServer[];
  failover: "off" | "ask" | "auto";
  /** How new agents start: the agent's own Auto mode, or its ask-first default. */
  defaultPermissionMode: "auto" | "ask";
  customAgents: CustomAgent[];
  remote: RemoteSettings;
  voice: VoiceSettings;
  voiceAssistant: VoiceAssistantSettings;
  /** Sending while an agent works: ask each time, queue it, or start a helper agent. */
  busySend: BusySend;
  helperDefaults: HelperDefaults;
  /** Cap on all agents' spend per local day, in USD; null = no cap. */
  dailyBudgetUsd: number | null;
  /** Cap on one agent's total spend, in USD; null = no cap. */
  agentBudgetUsd: number | null;
  /** What reaching a cap does: alert only, or also pause the agents. */
  budgetAction: BudgetAction;
}

export type BudgetAction = "notify" | "pause";
export type BudgetLevel = "under" | "warn" | "hit";

/** Today's spend (since local midnight) against the daily cap. */
export interface BudgetStatus {
  /** Local date, YYYY-MM-DD. */
  day: string;
  todayUsd: number;
  dailyBudgetUsd: number | null;
  level: BudgetLevel;
}

/** The OpenAI Realtime voice assistant (off by default; audio is sent to OpenAI). */
export interface VoiceAssistantSettings {
  enabled: boolean;
  /** The OpenAI API-key account that pays for sessions. */
  accountId: string | null;
  voice: string;
  model: string;
  maxSessionMins: number;
  silenceTimeoutSecs: number;
  /** Headphones on: keep the mic open while the assistant talks (allows interrupting). */
  headphones: boolean;
}

export interface VoiceAssistantUsage {
  /** "YYYY-MM" */
  month: string;
  seconds: number;
  costUsd: number;
  sessions: number;
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

/** Voice dictation (local speech-to-text). */
export interface VoiceSettings {
  /** Input device name; null = the system default. */
  inputDevice: string | null;
  /** Whisper model id (tiny.en, base.en, small.en, small). */
  model: string;
  /** "auto" or a language code; non-English needs a multilingual model. */
  language: string;
  /** Send the message as soon as dictation finishes. */
  autoSend: boolean;
}

export interface VoiceModel {
  id: string;
  label: string;
  description: string;
  sizeBytes: number;
  multilingual: boolean;
  installed: boolean;
  isDefault: boolean;
}

export interface VoiceStatus {
  models: VoiceModel[];
  /** [code, name] pairs for multilingual models. */
  languages: [string, string][];
  maxRecordingSecs: number;
  /** The model chosen in settings, and whether it's downloaded. */
  model: string;
  ready: boolean;
  downloading: string | null;
}

export interface VoiceInputDevice {
  name: string;
  isDefault: boolean;
}

export interface VoiceTranscript {
  text: string;
  autoSend: boolean;
}

export interface VoiceDownloadEvent {
  id: string;
  done: number;
  total: number;
  state: "progress" | "done" | "error" | "cancelled";
  error: string | null;
}

export interface RemoteSettings {
  enabled: boolean;
  lan: boolean;
  port: number;
  /** Reach Armada over Tailscale (Tailscale Serve, HTTPS); never together with `lan`. */
  tailscale?: boolean;
  /** The address LAN access listens on; null picks automatically (Wi-Fi/Ethernet first). */
  lanAddress?: string | null;
}

/** One of this computer's network addresses LAN access can listen on. */
export interface LanAddress {
  ip: string;
  /** Interface name (eno1, Wi-Fi, tailscale0, …). */
  interface: string;
  kind: "lan" | "tailscale" | "vpn" | "virtual";
  prefixLen: number;
}

export interface ShareLink {
  /** Identifies the link for revoking (the token itself is not kept). */
  id: string;
  agentId: string;
  agentTitle: string | null;
  /** The link; only present right after it is created (Armada keeps just a hash). */
  url: string | null;
  createdAt: number;
  /** Unix ms; the link stops working then. */
  expiresAt: number;
}

/** A paired phone or tablet. */
export interface RemoteDevice {
  id: string;
  name: string;
  createdAt: number;
  /** Unix ms of its last request; 0 when it hasn't connected since pairing. */
  lastSeen: number;
}

export interface RemoteStatus {
  enabled: boolean;
  running: boolean;
  lan: boolean;
  port: number;
  url: string | null;
  /** One-time pairing link (single use, valid 5 minutes). */
  pairingUrl: string | null;
  /** Server-generated SVG markup of a QR code for pairingUrl. */
  qrSvg: string | null;
  /** Unix ms when the pairing code stops working. */
  pairingExpiresAt: number | null;
  error: string | null;
  shares: ShareLink[];
  devices: RemoteDevice[];
  /** Addresses LAN access can listen on, best first (empty while LAN access is off). */
  lanAddresses: LanAddress[];
  /** Linux: a firewall blocking the LAN server, and the command that opens it. */
  firewall: { name: string; command: string } | null;
  /** Tailscale Serve, while remote access over Tailscale is on. */
  tailscale: TailscaleStatus | null;
}

export interface TailscaleStatus {
  state: "checking" | "notInstalled" | "notConnected" | "needsOperator" | "needsHttps" | "on" | "error";
  /** https://machine.tailnet.ts.net:port while on. */
  url: string | null;
  /** What the user has to fix, with a command and/or a page that fixes it. */
  message: string | null;
  command: string | null;
  link: string | null;
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
  /** Why the last scheduled run failed to start (null if it started). */
  lastError: string | null;
  /** Permission mode for the agents this schedule starts; null = settings default at run time. */
  permissionMode: "auto" | "ask" | null;
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
  /** null = settings.defaultPermissionMode. */
  permissionMode?: "auto" | "ask" | null;
}

export interface CreateAccountRequest {
  provider: Provider;
  name: string;
  color: string;
  authKind: AuthKind; // "oauth" -> isolated profile + browser login; "api_key" -> key in OS keychain
  apiKey: string | null;
  /** Provider "local": the server (apiKey is then an optional bearer token for it). */
  local?: LocalServer | null;
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  /** Tracked by Git LFS (a pointer file in git; the real content is a large asset). */
  lfs: boolean;
}

/** Git LFS state of the repository behind a diff. */
export interface LfsInfo {
  /** The repo uses LFS but `git-lfs` isn't installed, so asset files can't be compared reliably. */
  toolMissing: boolean;
  /** Files that only looked changed (LFS pointers vs. content) and were left out of the list. */
  hidden: number;
}

export interface AgentDiff {
  files: ChangedFile[];
  patch: string; // full unified diff vs. baseCommit (includes uncommitted work)
  ahead: number; // commits on the agent branch not in base
  uncommitted: number; // dirty (uncommitted) files in the worktree
  /** The patch was cut at 8 MB (the file list is still complete). */
  truncated: boolean;
  /** Set when the repo uses Git LFS; null otherwise. */
  lfs: LfsInfo | null;
}

/** A snapshot of the agent's folder taken before a message ("turn") or before a restore ("safety"). */
export interface Checkpoint {
  id: string;
  agentId: string;
  seq: number;
  /** The user message this checkpoint precedes. */
  itemId: string | null;
  createdAt: number;
  kind: "turn" | "safety";
}

export interface CheckpointList {
  /** False when the folder isn't (the root of) a git repository. */
  available: boolean;
  checkpoints: Checkpoint[];
}

export interface RestoreFile {
  path: string;
  /** "added": comes back; "deleted": created since, so removed; "modified". */
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
}

export interface RestorePreview {
  files: RestoreFile[];
  totalFiles: number;
  additions: number;
  deletions: number;
}

export interface RestoreResult {
  /** Restore this checkpoint to undo the restore. */
  safetyId: string;
  filesChanged: number;
}

export interface SearchHit {
  agentId: string;
  itemId: string;
  kind: TimelineKind;
  snippet: string;
  ts: number;
}

export interface CommitSummary {
  hash: string;
  files: string[];
  leftUncommitted: number;
  skipped: string[];
  /** Human summary, e.g. "Committed 3 files (abc1234); 5 other changed files were left uncommitted". */
  message: string;
}

/** ship_agent result. A rejection means nothing changed; `error` means the commit landed but the merge failed. */
export interface ShipResult {
  committed: string | null;
  merged: string | null;
  error: string | null;
  /** Base branch vs its upstream after a successful merge (the merge itself is local-only). */
  baseStatus: BaseBranchStatus | null;
}

/** Where an agent's base branch stands against its upstream (as last fetched). */
export interface BaseBranchStatus {
  branch: string;
  /** e.g. "origin/master"; null when the base branch has no upstream. */
  upstream: string | null;
  ahead: number;
  behind: number;
}

/** Whether `gh` is installed and signed in, and whether git can use that sign-in. */
export interface GithubStatus {
  ghInstalled: boolean;
  loggedIn: boolean;
  user: string | null;
  /** git has a credential helper, so HTTPS pushes can authenticate without a prompt. */
  gitReady: boolean;
}

export interface GitRemote {
  name: string;
  url: string;
}

/** What publishing a folder to GitHub would start from. */
export interface RepoInfo {
  isRepo: boolean;
  hasCommits: boolean;
  branch: string | null;
  remotes: GitRemote[];
  /** A valid repository name derived from the folder name. */
  suggestedName: string;
}

export interface PublishResult {
  url: string;
  /** Short hash of the first commit, when Armada had to make one. */
  committed: string | null;
  /** Secret-looking files left out of that first commit. */
  leftOut: string[];
}

/** A runnable project command detected in an agent's folder. */
export interface ProjectScript {
  id: string;
  /** Group: npm, pnpm, yarn, bun, cargo, make, just, python, go. */
  source: string;
  name: string;
  command: string;
}

/** PR + CI status of an agent's branch (pr_status). Problems are quiet "unknown"/"none" states. */
/** An editable prompt built from third-party text (CI logs, review comments). */
export interface PrPrompt {
  text: string;
  /** Review comments left out because their authors are outside the project. */
  omitted: number;
}

export interface PrStatus {
  /** ok: a PR exists · none: the branch has no PR · unknown: couldn't ask (see reason). */
  state: "ok" | "none" | "unknown";
  reason: "gh_missing" | "not_authenticated" | "no_remote" | "rate_limited" | "error" | null;
  pr: PrInfo | null;
  fetchedAt: number;
}

export interface PrInfo {
  number: number;
  url: string;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  review: "approved" | "changes_requested" | "review_required" | null;
  mergeable: "mergeable" | "conflicting" | null;
  checks: PrCheck[];
  summary: { passing: number; failing: number; pending: number; overall: "none" | "passing" | "failing" | "pending" };
}

export interface PrCheck {
  name: string;
  workflow: string | null;
  status: "passing" | "failing" | "pending" | "skipped";
  url: string | null;
  runId: string | null;
  durationSecs: number | null;
}
