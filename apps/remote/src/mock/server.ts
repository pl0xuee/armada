/**
 * In-memory implementation of the remote API for development and screenshots.
 * Same request/stream contract as the Rust server, including errors and the
 * owner/viewer split, so the real code paths are exercised.
 */
import { ApiError, type Backend, type StreamHandlers } from "@/lib/api";
import type { Agent, AttentionReason, RemoteEvent, Session, TimelineItem } from "@/lib/types";
import { accounts, buildAgents, buildTimelines, customAgents, nextSeq, STREAM_SCRIPT } from "./data";

export interface Scenario {
  scope: "owner" | "viewer";
  latency: number;
  /** Hang every state/items request (to show loading skeletons). */
  hang: boolean;
  empty: boolean;
  fail: Set<string>;
  stream: boolean;
  toast: AttentionReason | null;
  pair: "plain" | "revoked" | null;
}

export function scenarioFromParams(p: URLSearchParams): Scenario {
  const toast = p.get("toast");
  const pair = p.get("pair");
  return {
    scope: p.get("scope") === "viewer" ? "viewer" : "owner",
    latency: Number(p.get("latency") ?? 160) || 0,
    hang: p.get("hang") === "1",
    empty: p.get("empty") === "1",
    fail: new Set((p.get("fail") ?? "").split(",").filter(Boolean)),
    stream: p.get("stream") !== "0",
    toast: toast === "permission" || toast === "done" || toast === "error" ? toast : null,
    pair: pair === "revoked" ? "revoked" : pair ? "plain" : null,
  };
}

type Listener = (e: RemoteEvent) => void;

const VIEWER_AGENT = "a3";

export class MockBackend implements Backend {
  readonly kind = "mock" as const;
  private readonly s: Scenario;
  private agents = new Map<string, Agent>();
  private items = new Map<string, TimelineItem[]>();
  private listeners = new Set<Listener>();
  private streamStep = 0;
  private streamItemId: string | null = null;

  constructor(scenario: Scenario) {
    this.s = scenario;
    const now = Date.now();
    if (!scenario.empty) {
      for (const a of buildAgents(now)) this.agents.set(a.id, a);
      for (const [id, list] of Object.entries(buildTimelines(now))) this.items.set(id, list);
    }
    const a3 = this.items.get("a3");
    this.streamItemId = a3?.[a3.length - 1]?.id ?? null;
    if (scenario.stream && !scenario.empty) setInterval(() => this.tick(), 140);
  }

  // -- transport ------------------------------------------------------------

  async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const hangs = this.s.hang && method === "GET" && path !== "/api/session";
    await delay(hangs ? 1e9 : this.s.latency * (0.6 + Math.random() * 0.8));
    return this.route(method, path, body);
  }

  async stream({ signal, onOpen, onMessage, onActivity }: StreamHandlers): Promise<void> {
    await delay(this.s.latency);
    if (this.s.fail.has("stream")) throw new ApiError(0, null);
    if (signal.aborted) return;
    onOpen();
    const listener: Listener = (e) => {
      onActivity();
      onMessage(JSON.stringify(e));
    };
    this.listeners.add(listener);
    const heartbeat = setInterval(onActivity, 20_000);
    if (this.s.toast) setTimeout(() => this.attention(this.s.toast === "permission" ? "a2" : "a5", this.s.toast!), 300);
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    clearInterval(heartbeat);
    this.listeners.delete(listener);
  }

  private emit(e: RemoteEvent) {
    if (this.s.scope === "viewer") {
      const id = e.type === "agent_updated" ? e.agent.id : e.type === "item_upserted" ? e.item.agentId : "agentId" in e ? e.agentId : null;
      if (id !== VIEWER_AGENT) return;
    }
    for (const l of this.listeners) l(e);
  }

  // -- routes ---------------------------------------------------------------

  private route(method: string, path: string, body: unknown): unknown {
    if (path === "/api/session") {
      if (this.s.fail.has("session-401")) throw new ApiError(401, "invalid token");
      if (this.s.fail.has("session-429")) throw new ApiError(429, "too many attempts");
      if (this.s.fail.has("session-down")) throw new ApiError(0, null);
      const session: Session = {
        scope: this.s.scope,
        agentId: this.s.scope === "viewer" ? VIEWER_AGENT : null,
        version: "0.1.0-dev",
      };
      return session;
    }
    if (path === "/api/state") {
      if (this.s.fail.has("state")) throw new ApiError(503, "core not ready");
      const agents = [...this.agents.values()].filter((a) => this.s.scope === "owner" || a.id === VIEWER_AGENT);
      return {
        agents: structuredClone(agents),
        accounts: this.s.scope === "owner" ? accounts : [],
        customAgents: this.s.scope === "owner" ? customAgents : [],
      };
    }
    const m = /^\/api\/agents\/([^/]+)\/(items|prompt|permission|cancel|resume)$/.exec(path);
    if (!m) throw new ApiError(404, "not found");
    const id = decodeURIComponent(m[1]);
    const action = m[2];
    const agent = this.agents.get(id);
    if (!agent || (this.s.scope === "viewer" && id !== VIEWER_AGENT)) throw new ApiError(404, "agent not found");

    if (action === "items" && method === "GET") {
      if (this.s.fail.has("items")) throw new ApiError(500, "database is locked");
      return structuredClone(this.items.get(id) ?? []);
    }
    if (method !== "POST") throw new ApiError(405, "method not allowed");
    if (this.s.scope !== "owner") throw new ApiError(403, "read-only link");
    if (this.s.fail.has(action)) throw new ApiError(500, `${action} failed (simulated)`);

    switch (action) {
      case "prompt":
        return this.prompt(agent, String((body as { text?: unknown })?.text ?? ""));
      case "permission":
        return this.permission(agent, body as { requestId: string; optionId: string });
      case "cancel":
        return this.cancel(agent);
      case "resume":
        return this.resume(agent);
    }
    throw new ApiError(404, "not found");
  }

  private update(id: string, patch: Partial<Agent>) {
    const a = this.agents.get(id);
    if (!a) return;
    const next = { ...a, ...patch, updatedAt: Date.now(), lastActivityAt: Date.now() };
    this.agents.set(id, next);
    this.emit({ type: "agent_updated", agent: structuredClone(next) });
  }

  private push(item: TimelineItem) {
    const list = this.items.get(item.agentId) ?? [];
    const idx = list.findIndex((i) => i.id === item.id);
    if (idx >= 0) list[idx] = item;
    else list.push(item);
    this.items.set(item.agentId, list);
    this.emit({ type: "item_upserted", item: structuredClone(item) });
  }

  private newItem<K extends TimelineItem["kind"]>(agentId: string, fields: Omit<Extract<TimelineItem, { kind: K }>, "id" | "agentId" | "seq" | "ts">) {
    const seq = nextSeq();
    return { id: `${agentId}-n${seq}`, agentId, seq, ts: Date.now(), ...fields } as unknown as TimelineItem;
  }

  private attention(agentId: string, reason: AttentionReason) {
    const a = this.agents.get(agentId);
    if (!a) return;
    const copy = {
      permission: { title: `${a.title} needs approval`, body: "Edit src/billing/CheckoutButton.tsx" },
      done: { title: `${a.title} finished`, body: a.lastMessage ?? "Ready for your next prompt." },
      error: { title: `${a.title} failed`, body: "Usage limit reached for this account." },
    }[reason];
    this.emit({ type: "attention", agentId, reason, ...copy, requestId: reason === "permission" ? "req-a2-edit" : null });
  }

  private prompt(agent: Agent, text: string) {
    if (!text.trim()) throw new ApiError(400, "empty prompt");
    this.push(this.newItem<"user_message">(agent.id, { kind: "user_message", text }));
    this.update(agent.id, { status: "working", running: true, rateLimited: false });
    const reply = this.newItem<"agent_message">(agent.id, { kind: "agent_message", text: "" });
    const words = "On it. I'll look at the relevant files first and report back with a plan before changing anything.".split(" ");
    setTimeout(() => {
      this.push(reply);
      words.forEach((w, i) =>
        setTimeout(() => {
          this.appendText(reply, `${i ? " " : ""}${w}`);
          if (i === words.length - 1) {
            this.update(agent.id, { status: "idle", lastMessage: (reply as { text: string }).text });
            this.attention(agent.id, "done");
          }
        }, 90 * (i + 1)),
      );
    }, 700);
  }

  private appendText(item: TimelineItem, delta: string) {
    if (item.kind !== "agent_message" && item.kind !== "thought") return;
    item.text += delta;
    this.emit({ type: "text_delta", agentId: item.agentId, itemId: item.id, field: "text", delta });
  }

  private permission(agent: Agent, { requestId, optionId }: { requestId: string; optionId: string }) {
    const list = this.items.get(agent.id) ?? [];
    const item = list.find((i) => i.kind === "permission" && i.requestId === requestId);
    if (!item || item.kind !== "permission" || item.resolution !== null) throw new ApiError(404, "no such pending request");
    const option = item.options.find((o) => o.id === optionId);
    if (!option) throw new ApiError(400, "unknown option");
    this.push({ ...item, resolution: optionId });
    const pending = Math.max(0, agent.pendingPermissions - 1);
    const allowed = option.kind.startsWith("allow");
    this.update(agent.id, { pendingPermissions: pending, status: pending ? "needs_permission" : "working" });
    if (pending) return;
    setTimeout(() => {
      if (allowed && item.toolKind === "execute") {
        const call = this.newItem<"tool_call">(agent.id, {
          kind: "tool_call",
          toolCallId: `tc-${requestId}`,
          title: item.title,
          toolKind: "execute",
          status: "in_progress",
          locations: [],
          diffs: [],
          output: "",
          command: item.command,
        });
        this.push(call);
        setTimeout(() => this.push({ ...(call as Extract<TimelineItem, { kind: "tool_call" }>), status: "completed", output: " PASS  tests/auth/refresh.test.ts\n  ✓ shares one refresh between concurrent callers (12 ms)\n\nTests: 1 passed, 1 total" }), 1200);
      }
      setTimeout(() => {
        const text = allowed ? "Done. The change is applied and the checks pass." : "Understood, I won't do that. Let me know how you'd like to proceed.";
        this.push(this.newItem<"agent_message">(agent.id, { kind: "agent_message", text }));
        this.update(agent.id, { status: "idle", lastMessage: text });
        this.attention(agent.id, "done");
      }, 2000);
    }, 400);
  }

  private cancel(agent: Agent) {
    for (const i of this.items.get(agent.id) ?? []) {
      if (i.kind === "permission" && i.resolution === null) this.push({ ...i, resolution: "cancelled" });
    }
    this.push(this.newItem<"notice">(agent.id, { kind: "notice", level: "info", text: "Turn cancelled" }));
    this.update(agent.id, { status: "idle", pendingPermissions: 0 });
  }

  private resume(agent: Agent) {
    if (agent.status !== "interrupted" && agent.status !== "stopped") throw new ApiError(409, "agent is not resumable");
    this.update(agent.id, { status: "starting", running: true });
    setTimeout(() => {
      this.push(this.newItem<"notice">(agent.id, { kind: "notice", level: "info", text: "Session resumed" }));
      this.update(agent.id, { status: "idle" });
    }, 900);
  }

  // -- simulation -----------------------------------------------------------

  /** Keeps agent a3 visibly streaming: words, then a tool call, then a new message. */
  private tick() {
    const a3 = this.agents.get("a3");
    if (!a3 || a3.status !== "working") return;
    const list = this.items.get("a3") ?? [];
    const msg = list.find((i) => i.id === this.streamItemId);
    const script = STREAM_SCRIPT.join("");
    if (msg && msg.kind === "agent_message" && msg.text.length < script.length && script.startsWith(msg.text)) {
      const rest = script.slice(msg.text.length);
      const chunk = /^\s*\S+\s?/.exec(rest)?.[0] ?? rest;
      this.appendText(msg, chunk);
      return;
    }
    this.streamStep++;
    if (this.streamStep % 30 === 1) {
      const call = this.newItem<"tool_call">("a3", {
        kind: "tool_call",
        toolCallId: `tc-sim-${this.streamStep}`,
        title: "Run npx tsc --noEmit",
        toolKind: "execute",
        status: "in_progress",
        locations: [],
        diffs: [],
        output: "",
        command: "npx tsc --noEmit",
      });
      this.push(call);
      setTimeout(() => this.push({ ...(call as Extract<TimelineItem, { kind: "tool_call" }>), status: "completed", output: "No errors." }), 1500);
    }
    if (this.streamStep % 30 === 15) {
      const next = this.newItem<"agent_message">("a3", { kind: "agent_message", text: "" });
      this.push(next);
      this.streamItemId = next.id;
      this.update("a3", { lastMessage: "Migrating the remaining pages to useApi." });
    }
  }
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
