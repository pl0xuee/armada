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
  AttentionReason,
  FileDiff,
  PermissionOption,
  PermissionOptionKind,
  PlanEntry,
  TimelineItem,
  ToolKind,
  ToolStatus,
};

/** `custom` = any other ACP agent (Rust `Provider::Custom`). */
export type Provider = CoreProvider | "custom";

export type Agent = Omit<CoreAgent, "provider"> & {
  provider: Provider;
  /** For custom agents: which custom agent definition runs it. */
  customAgentId?: string | null;
};

export interface RemoteAccount {
  id: string;
  name: string;
  provider: Provider;
  color: string;
  label: string | null;
}

/** Not part of the API yet; used when the server starts sending it. */
export interface RemoteCustomAgent {
  id: string;
  name: string;
  color: string;
}

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
}

export type PermissionItem = Extract<TimelineItem, { kind: "permission" }>;
export type ToolCallItem = Extract<TimelineItem, { kind: "tool_call" }>;

type Pick_<T extends ArmadaEvent["type"]> = Extract<ArmadaEvent, { type: T }>;

/** The subset of desktop events the remote server forwards, plus `resync`. */
export type RemoteEvent =
  | { type: "agent_updated"; agent: Agent }
  | Pick_<"agent_removed">
  | Pick_<"item_upserted">
  | Pick_<"text_delta">
  | Pick_<"attention">
  | { type: "resync" };

export type AttentionEvent = Pick_<"attention">;
