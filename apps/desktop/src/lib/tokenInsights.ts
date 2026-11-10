import { formatTokens } from "./format";
import type { Account, Agent, McpServer, Settings } from "./types";

/**
 * Where the tokens go, and what to do about it. Pure: computed from what the app already knows
 * about the agents (context size, cost per token, effort, who is working) and the accounts'
 * usage windows. Why these rules: every step an agent takes re-reads its whole context, so
 * tokens per turn are roughly context size x steps (docs/TOKEN-SAVING.md).
 */

/** Context at which an agent is worth replacing with a fresh one that carries a short summary. */
export const LONG_CONTEXT = 200_000;
/** Context at which it's urgent. */
export const VERY_LONG_CONTEXT = 350_000;
/** Compact size the "Save tokens" preset sets (mirrors the Rust `PRESET_COMPACT_WINDOW`). */
export const PRESET_COMPACT_WINDOW = 250_000;
/** Agents working at once on one account before it is worth a warning. */
export const PARALLEL_WARN = 4;
/** Context above which an expired prompt cache is worth a warning. */
export const CACHE_COLD_CONTEXT = 150_000;
/** Idle time after which Claude's one-hour prompt cache has expired. */
export const CACHE_TTL_MS = 60 * 60_000;
/** Dollars per million tokens above which an agent is on a much pricier model than usual. */
const PRICEY_PER_MTOK = 2.5;

export type InsightAction =
  | { kind: "preset"; label: string }
  | { kind: "open-agent"; agentId: string; label: string }
  | { kind: "lower-effort"; agentIds: string[]; label: string }
  | { kind: "open-settings"; label: string }
  /** Only the helper-agent model, not the whole preset. */
  | { kind: "helper-model"; model: "sonnet"; label: string };

export interface Insight {
  id: string;
  severity: "high" | "medium" | "info";
  title: string;
  detail: string;
  action?: InsightAction;
}

const live = (a: Agent) => !a.archived;
const BUSY = new Set<Agent["status"]>(["working", "needs_permission", "starting"]);

function effortOf(a: Agent): string | null {
  return a.configOptions?.find((o) => o.id === "effort")?.currentValue ?? null;
}

function claudeEffortHigh(a: Agent): boolean {
  const e = effortOf(a);
  return a.provider === "claude" && (e === "high" || e === "xhigh" || e === "max");
}

function windowText(percent: number, mins: number | null | undefined): string {
  const span =
    mins && mins >= 1440 ? `${Math.round(mins / 1440)}-day` : mins ? `${Math.round(mins / 60)}-hour` : "usage";
  return `${span} window is ${Math.round(percent)}% used`;
}

export function tokenInsights(input: {
  agents: Agent[];
  accounts: Account[];
  settings: Settings | null | undefined;
  now?: number;
}): Insight[] {
  const { accounts, settings } = input;
  const now = input.now ?? Date.now();
  const agents = input.agents.filter(live);
  const out: Insight[] = [];

  // 1. Many agents working at once on one account, against that account's remaining window.
  const working = new Map<string, Agent[]>();
  for (const a of agents) {
    if (!BUSY.has(a.status)) continue;
    working.set(a.accountId, [...(working.get(a.accountId) ?? []), a]);
  }
  for (const [accountId, list] of working) {
    const acc = accounts.find((x) => x.id === accountId);
    const win = acc?.usage?.primary;
    const used = win && (win.resetsAt == null || win.resetsAt > now) ? win.usedPercent : null;
    const crowded = list.length >= PARALLEL_WARN;
    const tight = used != null && used >= 60 && list.length >= 2;
    if (!crowded && !tight) continue;
    const name = acc?.name ?? "this account";
    const reset =
      win?.resetsAt && win.resetsAt > now
        ? ` Resets in ${Math.max(1, Math.round((win.resetsAt - now) / 60000))} min.`
        : "";
    out.push({
      id: `parallel:${accountId}`,
      severity: (used != null && used >= 80) || list.length >= 6 ? "high" : "medium",
      title: `${list.length} agents are working at once on ${name}${used != null ? `; its ${windowText(used, win?.windowMins)}` : ""}`,
      detail: `Agents on one account share one usage window, and each re-reads its own context on every step, so parallel agents drain it several times faster.${reset} Pause the ones that can wait, or move some to another account.`,
    });
  }

  // 2. Long contexts: every step re-reads all of it.
  const long = agents
    .filter((a) => (a.contextUsed ?? 0) >= LONG_CONTEXT)
    .sort((a, b) => (b.contextUsed ?? 0) - (a.contextUsed ?? 0));
  if (long.length) {
    const worst = long[0];
    const perStep = long.reduce((s, a) => s + (a.contextUsed ?? 0), 0);
    out.push({
      id: "long-context",
      severity: (worst.contextUsed ?? 0) >= VERY_LONG_CONTEXT ? "high" : "medium",
      title: `${long.length} ${long.length === 1 ? "agent carries" : "agents carry"} ${formatTokens(LONG_CONTEXT)}+ tokens of context`,
      detail: `Every step re-reads the whole context: about ${formatTokens(perStep)} tokens per step across ${long.length === 1 ? "it" : "them"}. The biggest is "${worst.title}" at ${formatTokens(worst.contextUsed ?? 0)}. Starting a fresh agent from a short handoff summary costs a fraction of that per step. (A cache that sat idle for over an hour is rebuilt from scratch too.)`,
      action: { kind: "open-agent", agentId: worst.id, label: "Open the biggest" },
    });
  }

  // 3. Claude Code only summarizes very late on 1M-context models.
  const bigWindow = agents.some((a) => a.provider === "claude" && (a.contextSize ?? 0) >= 500_000);
  if (settings && settings.autoCompactWindow == null && bigWindow) {
    out.push({
      id: "compact-window",
      severity: long.length ? "high" : "medium",
      title: "Claude agents have a 1M-token context and summarize very late",
      detail: `Keeping the context near ${formatTokens(PRESET_COMPACT_WINDOW)} instead of letting it grow toward 1M roughly halves what each step re-reads. The "Save tokens" preset sets that, plus concise replies and medium effort for new agents. Running agents pick it up when they next restart.`,
      action: { kind: "preset", label: "Save tokens" },
    });
  }

  // 4. High effort.
  const high = agents.filter(claudeEffortHigh);
  if (high.length) {
    out.push({
      id: "effort",
      severity: "medium",
      title: `${high.length} Claude ${high.length === 1 ? "agent runs" : "agents run"} at high effort or above`,
      detail:
        "Higher effort means more thinking tokens on every step. Medium is Claude's own default for the 5.5 models and is enough for most routine work; raise it one step at a time for hard problems, and past High a bigger model is often the better buy. On the 5.5 models, changing effort keeps the cache.",
      action: { kind: "lower-effort", agentIds: high.map((a) => a.id), label: "Set to medium" },
    });
  }

  // 5. An agent that costs far more per token than the rest (a pricier model).
  const rated = agents
    .filter((a) => a.provider === "claude" && a.tokensUsed >= 1_000_000 && a.costUsd > 0)
    .map((a) => ({ a, perM: (a.costUsd / a.tokensUsed) * 1e6 }));
  const pricey = rated.filter((r) => r.perM >= PRICEY_PER_MTOK).sort((x, y) => y.a.costUsd - x.a.costUsd);
  if (pricey.length) {
    const cheap = rated.filter((r) => r.perM < PRICEY_PER_MTOK).map((r) => r.perM);
    const base = cheap.length ? cheap.reduce((s, v) => s + v, 0) / cheap.length : 0;
    const top = pricey[0];
    out.push({
      id: "pricey",
      severity: "medium",
      title: `${pricey.length} ${pricey.length === 1 ? "agent costs" : "agents cost"} $${top.perM.toFixed(2)} or more per million tokens`,
      detail: `"${top.a.title}" averages $${top.perM.toFixed(2)} per million tokens${base ? `, about ${Math.max(1, Math.round(top.perM / base))}x your cheaper agents` : ""}, which usually means a pricier model (Opus or Fable class). Opus at medium effort covers most everyday work; keep the biggest model for big refactors and research, and use Sonnet for routine, well-scoped tasks. Switching a long conversation re-reads all of it uncached once, so switch at a break or when starting a new agent.`,
      action: { kind: "open-agent", agentId: top.a.id, label: "Open it" },
    });
  }

  // 6. Many MCP servers on for every project.
  const servers: McpServer[] = (settings?.mcpServers ?? []).filter((s) => s.enabled);
  if (servers.length >= 3) {
    out.push({
      id: "mcp",
      severity: "info",
      title: `${servers.length} MCP servers are on`,
      detail:
        "Claude Code defers MCP tool definitions by default, so the cost is usually small, but where that isn't available every tool of every server is re-sent on each step. Turn off the servers you are not using.",
      action: { kind: "open-settings", label: "Open MCP settings" },
    });
  }

  // 7. A big conversation whose prompt cache has expired: the next message re-reads all of it
  // at full price (Claude Code's cache lasts an hour on a subscription, five minutes otherwise).
  const cold = agents
    .filter(
      (a) =>
        a.provider === "claude" &&
        !BUSY.has(a.status) &&
        (a.contextUsed ?? 0) >= CACHE_COLD_CONTEXT &&
        a.lastActivityAt > 0 &&
        now - a.lastActivityAt >= CACHE_TTL_MS,
    )
    .sort((a, b) => (b.contextUsed ?? 0) - (a.contextUsed ?? 0));
  if (cold.length) {
    const worst = cold[0];
    out.push({
      id: "cold-cache",
      severity: (worst.contextUsed ?? 0) >= VERY_LONG_CONTEXT ? "high" : "medium",
      title:
        cold.length === 1
          ? `"${worst.title}" has been idle over an hour with ${formatTokens(worst.contextUsed ?? 0)} tokens of context`
          : `${cold.length} agents have been idle over an hour with ${formatTokens(CACHE_COLD_CONTEXT)}+ tokens of context`,
      detail:
        "Claude's prompt cache has expired, so the next message re-reads the whole conversation at full price, once. If you only need a result, start a fresh agent from a short handoff summary instead of continuing this one.",
      action: { kind: "open-agent", agentId: worst.id, label: "Open it" },
    });
  }

  // 8. Claude's helper agents run on the same (often pricier) model as the agent itself.
  const heavyClaude = agents.some((a) => a.provider === "claude" && a.tokensUsed >= 2_000_000);
  if (settings?.tokenSaver && !settings.tokenSaver.subagentModel && heavyClaude) {
    out.push({
      id: "helper-model",
      severity: "info",
      title: "Claude's helper agents run on the same model as the agent",
      detail:
        "Helpers (exploration, searches, test runs) each carry their own conversation and use your plan separately. Running them on Sonnet keeps the agent's own model for the hard part. This changes only that; the Save tokens preset sets it too, and Settings also offers Haiku.",
      action: { kind: "helper-model", model: "sonnet", label: "Use Sonnet for helpers" },
    });
  }

  const rank = { high: 0, medium: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
