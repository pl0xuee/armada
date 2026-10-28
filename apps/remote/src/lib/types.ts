/**
 * Wire types for the remote API. Everything that also exists in the desktop
 * app comes from its `types.ts` (the single source of truth, kept in sync with
 * `crates/armada-core/src/model.rs`); this file only adds the remote-specific
 * envelopes and widens a couple of fields the Rust model already has.
 */
import type {
  Agent as CoreAgent,
  ArmadaEvent,
  AgentStatus,
  Attachment,
  AttentionReason,
  FileDiff,
  PermissionOption,
  PermissionOptionKind,
  PlanEntry,
  Provider as CoreProvider,
  TimelineItem,
  ToolKind,
  ToolStatus,
} from "@shared/types";

export type {
  AgentStatus,
  Attachment,
  AttentionReason,
  FileDiff,
  PermissionOption,
  PermissionOptionKind,
  PlanEntry,
  ToolKind,
  ToolStatus,
};

export type { TimelineItem };
export type { ConfigOption, ConfigOptionChoice, QueuedPrompt, SlashCommand, SubagentInfo } from "@shared/types";

export type Provider = CoreProvider;

/**
 * Fields the server strips from agents shown through a read-only share link
 * (so a viewer can't learn paths, accounts or session ids).
 */
export type ViewerTrimmedField =
  | "projectPath"
  | "cwd"
  | "accountId"
  | "sessionId"
  | "branch"
  | "baseBranch"
  | "baseCommit"
  | "scheduleId"
  | "groupId"
  | "configOptions"
  | "availableCommands";

/**
 * An agent as the remote API sends it. Viewer-trimmed fields are optional so
 * the compiler forces every use to cope with their absence; fields added by
 * newer servers are optional for compatibility with older ones.
 */
/** Fields newer servers added; optional so older servers keep working. */
type AddedLater = "customAgentId" | "queuedPrompts" | "queue" | "queuePaused" | "permissionMode" | "acknowledgedAt" | "needsBriefing";

export type Agent = Omit<CoreAgent, ViewerTrimmedField | AddedLater> & Partial<Pick<CoreAgent, ViewerTrimmedField | AddedLater>>;

export type ToolCallItem = Extract<TimelineItem, { kind: "tool_call" }>;
export type TurnSummaryItem = Extract<TimelineItem, { kind: "turn_summary" }>;

export interface RemoteAccount {
  id: string;
  name: string;
  provider: Provider;
  color: string;
  label: string | null;
  /** null/absent = unknown (not checked yet, or an older server). */
  loggedIn?: boolean | null;
  /** Last problem checking or using the account, if any. */
  error?: string | null;
}

/** A user-defined ACP agent (Gemini CLI, Goose, OpenCode, …) as /api/state lists it. */
export interface RemoteCustomAgent {
  id: string;
  name: string;
  color: string;
  /** Older servers omit it; treat missing as enabled. */
  enabled?: boolean;
}

export interface PromptTemplate {
  id: string;
  name: string;
  text: string;
}

/** POST /api/agents */
export interface CreateAgentRequest {
  provider: Provider;
  accountId: string;
  projectPath: string;
  prompt?: string;
  title?: string;
  worktree?: boolean;
  customAgentId?: string;
  attachments?: Attachment[];
  /** Provider-specific model id passed to the agent at start (optional). */
  model?: string;
  /** "auto" approves routine actions; "ask" asks first. Omit for the server default. */
  permissionMode?: PermissionMode;
}

export type PermissionMode = "auto" | "ask";

export type Scope = "owner" | "viewer";

export interface Session {
  scope: Scope;
  agentId: string | null;
  version: string;
}

export interface StateSnapshot {
  agents: Agent[];
  accounts: RemoteAccount[];
  customAgents?: RemoteCustomAgent[];
  /** Owner only: recent project folders that still exist. */
  projects?: string[];
  templates?: PromptTemplate[];
  defaultWorktree?: boolean;
  /** Absent on older servers (then the choice isn't offered). */
  defaultPermissionMode?: PermissionMode;
}

export type PermissionItem = Extract<TimelineItem, { kind: "permission" }>;
export type TextDeltaEvent = Extract<ArmadaEvent, { type: "text_delta" }>;

type Pick_<T extends ArmadaEvent["type"]> = Extract<ArmadaEvent, { type: T }>;

/** The subset of desktop events the remote server forwards, plus `resync`. */
export type RemoteEvent =
  | { type: "agent_updated"; agent: Agent }
  | Pick_<"agent_removed">
  | { type: "item_upserted"; item: TimelineItem }
  | Pick_<"text_delta">
  | Pick_<"attention">
  | Pick_<"account_updated">
  | Pick_<"account_removed">
  | { type: "resync" };

export type AttentionEvent = Pick_<"attention">;
