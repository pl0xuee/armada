/**
 * Agents started together, and "Add agents": start more of the same agent in the same project.
 *
 * The desktop tiles them in a grid; a phone shows one conversation at a time, so they are a chip row
 * to hop between. "Together" is the agents sharing a `groupId`, plus (for the agent you added from, which
 * can't be re-grouped) the groups this device remembers.
 */
import { newIdempotencyKey } from "./api";
import { storage } from "./storage";
import type { Agent, CreateAgentRequest } from "./types";

/** Most agents shown together (the desktop's tile limit). */
export const MAX_TOGETHER = 8;

/** How many more can join `count` already together (at least the agent itself). */
export function addRoom(count: number): number {
  return Math.max(0, MAX_TOGETHER - Math.max(1, count));
}

export function clampCount(wanted: number, room: number): number {
  return Math.max(1, Math.min(Math.floor(Number.isFinite(wanted) ? wanted : 1), Math.max(1, room)));
}

/**
 * The agents together with `id` (itself included), oldest first: those with its `groupId`, and any
 * remembered group (a list of ids) that holds it. Archived ones drop out. Fewer than two: none.
 */
export function siblingsOf(agents: readonly Agent[], id: string, remembered: readonly (readonly string[])[] = []): Agent[] {
  const self = agents.find((a) => a.id === id);
  if (!self) return [];
  const ids = new Set<string>([id]);
  if (self.groupId) for (const a of agents) if (a.groupId === self.groupId) ids.add(a.id);
  for (const g of remembered) if (g.includes(id)) for (const x of g) ids.add(x);
  const out = agents.filter((a) => ids.has(a.id) && (a.id === id || !a.archived));
  out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return out.length >= 2 ? out : [];
}

/**
 * The requests for "Add agents": same agent, account and project as `agent`, each in its own worktree, in
 * one group (the agent's own, else `groupId`). The prompt is optional: without it they start idle.
 */
export function buildAddRequests(
  agent: Pick<Agent, "provider" | "accountId" | "projectPath" | "customAgentId" | "groupId">,
  prompt: string,
  count: number,
  groupId: string,
): CreateAgentRequest[] {
  const text = prompt.trim();
  const one: CreateAgentRequest = {
    provider: agent.provider,
    accountId: agent.accountId ?? "",
    projectPath: agent.projectPath ?? "",
    worktree: true,
    groupId: agent.groupId ?? groupId,
    ...(agent.customAgentId ? { customAgentId: agent.customAgentId } : {}),
    ...(text ? { prompt: text } : {}),
  };
  return Array.from({ length: Math.max(1, count) }, () => ({ ...one }));
}

/** A request can be built only for an agent whose account and folder the server told us. */
export const canAddAgents = (a: Pick<Agent, "accountId" | "projectPath">) => !!a.accountId && !!a.projectPath;

export const newGroupId = newIdempotencyKey;

// ---------------------------------------------------------------------------
// Remembered groups (this device only)

const KEY = "armada.together";
const MAX_REMEMBERED = 20;

export function loadGroups(): string[][] {
  try {
    const raw: unknown = JSON.parse(storage.get(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((g): g is string[] => Array.isArray(g) && g.every((x) => typeof x === "string")) : [];
  } catch {
    return [];
  }
}

/** Adds a group, newest first; groups that overlap it are merged into it. */
export function withGroup(groups: readonly (readonly string[])[], ids: readonly string[]): string[][] {
  const merged = new Set(ids);
  const rest: string[][] = [];
  for (const g of groups) {
    if (g.some((x) => merged.has(x))) for (const x of g) merged.add(x);
    else rest.push([...g]);
  }
  return [[...merged], ...rest].slice(0, MAX_REMEMBERED);
}
