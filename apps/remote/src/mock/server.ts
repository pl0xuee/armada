/**
 * In-memory implementation of the remote API for development and screenshots.
 * Same request/stream contract as the Rust server, including errors and the
 * owner/viewer split, so the real code paths are exercised.
 */
import { ApiError, type Backend, type HttpMethod, type RequestOptions, type StreamHandlers } from "@/lib/api";
import type { Agent, Attachment, AttentionReason, CreateAgentRequest, RemoteEvent, Session, TimelineItem } from "@/lib/types";
import { CHECKOUT_PNG, ORDERS_PNG } from "./images";
import { mockDiff } from "./diff";
import { streamChunk, stressAgent, stressTimeline } from "./stress";
import { accounts, buildAgents, buildTimelines, customAgents, nextSeq, projects, providerConfig, STREAM_SCRIPT, templates } from "./data";

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
  /** Stress test: items in agent s1's timeline (0 = off) and deltas per second. */
  stressItems: number;
  stressRate: number;
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
    stressItems: p.get("stress") === "1" ? Math.max(10, Number(p.get("items") ?? 3000) || 3000) : 0,
    stressRate: Math.max(1, Number(p.get("rate") ?? 60) || 60),
  };
}

type Listener = (e: RemoteEvent) => void;

const VIEWER_AGENT = "a3";

/** Exactly the agent fields the real server keeps behind a share link (remote.rs VIEWER_FIELDS). */
const VIEWER_FIELDS = new Set([
  "id", "title", "provider", "customAgentId", "status", "running", "worktree", "createdAt", "updatedAt",
  "lastActivityAt", "costUsd", "tokensUsed", "contextUsed", "contextSize", "archived", "lastMessage",
  "pendingPermissions", "rateLimited",
]);

function trimForViewer(agent: Agent): Agent {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(structuredClone(agent))) if (VIEWER_FIELDS.has(k)) copy[k] = v;
  return copy as unknown as Agent;
}

/** Viewer's version of an item (remote/view.rs project_item); null = hidden from viewers. */
function projectItem(item: TimelineItem): TimelineItem | null {
  const i = structuredClone(item);
  switch (i.kind) {
    case "user_message":
      return { ...i, attachments: [] };
    case "agent_message":
      return i;
    case "tool_call":
      return { ...i, locations: [], diffs: [], output: "", command: null, images: [], subagent: undefined };
    case "turn_summary":
      return { ...i, files: [] };
    default:
      return null; // thought, permission, plan, notice
  }
}

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
    if (scenario.stressItems) this.startStress(scenario.stressItems, scenario.stressRate);
  }

  /** Huge timeline + fast deltas on agent s1 (and status churn on others). */
  private startStress(count: number, rate: number) {
    const base = this.agents.get("a3") ?? [...this.agents.values()][0];
    if (!base) return;
    this.agents.set("s1", stressAgent(base));
    const list = stressTimeline(count);
    this.items.set("s1", list);
    let cur = list[list.length - 1];
    let n = 0;
    setInterval(() => {
      if (cur.kind !== "agent_message") return;
      this.appendText(cur, streamChunk(n++));
      if (cur.text.length > 1_200) {
        this.push(structuredClone(cur));
        // Stress items have their own seq range; continue it so new items append.
        const next: TimelineItem = { id: `s1-x${cur.seq + 1}`, agentId: "s1", seq: cur.seq + 1, ts: Date.now(), kind: "agent_message", text: "" };
        this.push(next);
        cur = next;
      }
      // Some unrelated churn: another agent's activity every ~second.
      if (n % rate === 0) this.update("a4", { lastActivityAt: Date.now(), tokensUsed: (this.agents.get("a4")?.tokensUsed ?? 0) + 100 });
    }, 1000 / rate);
  }

  // -- transport ------------------------------------------------------------

  /** Idempotency-Key → first result (like the server: retries get the same answer). */
  private idempotent = new Map<string, Promise<unknown>>();

  async request(method: HttpMethod, path: string, body?: unknown, opts: RequestOptions = {}): Promise<unknown> {
    const hangs = this.s.hang && method === "GET" && path !== "/api/session";
    const key = opts.idempotencyKey ? `${path}\u0000${opts.idempotencyKey}` : null;
    if (key && this.idempotent.has(key)) return this.idempotent.get(key);
    const run = (async () => {
      // Simulated upload progress for bodies with photos.
      if (opts.onProgress) for (let i = 1; i <= 5; i++) (await delay(this.s.latency / 2), opts.onProgress(i / 5));
      await delay(hangs ? 1e9 : this.s.latency * (0.6 + Math.random() * 0.8));
      return this.route(method, path, body);
    })();
    if (key) this.idempotent.set(key, run);
    return run;
  }

  async stream({ signal, onOpen, onMessage, onActivity }: StreamHandlers): Promise<void> {
    await delay(this.s.latency);
    if (this.s.fail.has("stream")) throw new ApiError(0, null);
    if (this.s.fail.has("stream-429")) throw new ApiError(429, "Too many open connections for this device or link.");
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
    if (this.s.scope === "viewer") {
      if (e.type === "text_delta") return; // never forwarded; the full item follows
      if (e.type === "item_upserted") {
        const item = projectItem(e.item);
        if (!item) return;
        e = { ...e, item };
      }
    }
    for (const l of this.listeners) l(e);
  }

  // -- routes ---------------------------------------------------------------

  private async route(method: string, path: string, body: unknown): Promise<unknown> {
    if (path === "/api/session") {
      if (this.s.fail.has("session-401")) throw new ApiError(401, "invalid token");
      if (this.s.fail.has("session-429")) throw new ApiError(429, "too many attempts");
      if (this.s.fail.has("session-down")) throw new ApiError(0, null);
      if (this.s.fail.has("session-503")) throw new ApiError(503, "Remote access was turned off.");
      if (this.s.fail.has("session-421")) throw new ApiError(421, "Unexpected host.");
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
        agents: this.s.scope === "viewer" ? agents.map(trimForViewer) : structuredClone(agents),
        accounts: this.s.scope === "owner" ? accounts : [],
        customAgents: this.s.scope === "owner" ? customAgents : customAgents.filter((c) => agents.some((a) => a.customAgentId === c.id)),
        projects: this.s.scope === "owner" ? projects : [],
        templates: this.s.scope === "owner" ? templates : [],
        defaultWorktree: this.s.scope === "owner",
        defaultPermissionMode: "ask",
      };
    }
    if (path === "/api/permissions") {
      if (this.s.scope !== "owner") throw new ApiError(403, "This is a read-only link.");
      const out: TimelineItem[] = [];
      for (const [id, list] of this.items) {
        if ((this.agents.get(id)?.pendingPermissions ?? 0) <= 0) continue;
        for (const i of list) if (i.kind === "permission" && i.resolution === null) out.push(structuredClone(i));
      }
      return out;
    }
    if (path === "/api/agents" && method === "POST") {
      if (this.s.scope !== "owner") throw new ApiError(403, "This is a read-only link.");
      if (this.s.fail.has("create")) throw new ApiError(400, `Folder not found: ${(body as CreateAgentRequest)?.projectPath ?? ""}`);
      return this.create(body as CreateAgentRequest);
    }
    const whole = /^\/api\/agents\/([^/]+)\/queue(\/resume)?$/.exec(path);
    if (whole) {
      if (this.s.scope !== "owner") throw new ApiError(403, "This is a read-only link.");
      const agent = this.agents.get(decodeURIComponent(whole[1]));
      if (!agent) throw new ApiError(404, "agent not found");
      if (whole[2] && method === "POST") {
        this.update(agent.id, { queuePaused: false });
        if (agent.status === "idle" || agent.status === "stopped") this.runNextQueued(agent.id);
        return;
      }
      if (method === "DELETE") {
        const removed = (agent.queue ?? []).length;
        this.update(agent.id, { queue: [], queuedPrompts: 0 });
        return { removed };
      }
      throw new ApiError(405, "method not allowed");
    }
    const q = /^\/api\/agents\/([^/]+)\/queue\/([^/]+)(\/send)?$/.exec(path);
    if (q) {
      if (this.s.scope !== "owner") throw new ApiError(403, "This is a read-only link.");
      const agent = this.agents.get(decodeURIComponent(q[1]));
      if (!agent) throw new ApiError(404, "agent not found");
      return this.queueAction(agent, decodeURIComponent(q[2]), method === "POST" && !!q[3]);
    }
    const [pathOnly, query = ""] = path.split("?");
    const m = /^\/api\/agents\/([^/]+)\/(items|prompt|permission|cancel|resume|stop|config|account|archive|read|diff|commit|ship|image)$/.exec(pathOnly);
    if (!m) throw new ApiError(404, "not found");
    const id = decodeURIComponent(m[1]);
    const action = m[2];
    const agent = this.agents.get(id);
    if (!agent || (this.s.scope === "viewer" && id !== VIEWER_AGENT)) throw new ApiError(404, "agent not found");

    if (action === "items" && method === "GET") {
      if (this.s.fail.has("items")) throw new ApiError(500, "database is locked");
      // Paging like the server: the last `limit` items with seq < beforeSeq.
      const q = new URLSearchParams(query);
      const limit = Math.min(1000, Number(q.get("limit")) || 0);
      const before = q.has("beforeSeq") ? Number(q.get("beforeSeq")) : Infinity;
      let list = (this.items.get(id) ?? []).filter((i) => i.seq < before);
      if (this.s.scope === "viewer") list = list.map(projectItem).filter((i): i is TimelineItem => i !== null);
      if (limit) list = list.slice(-limit);
      return structuredClone(list);
    }
    if (action === "diff" && method === "GET") {
      if (this.s.scope !== "owner") throw new ApiError(403, "This is a read-only link.");
      return mockDiff(agent);
    }
    if (action === "image" && method === "GET") {
      if (this.s.scope !== "owner") throw new ApiError(403, "This is a read-only link.");
      const p = new URLSearchParams(query).get("path") ?? "";
      if (!/\.(png|jpe?g)$/i.test(p)) throw new ApiError(400, "Not an image");
      await delay(300);
      return { name: p.split("/").pop(), mimeType: "image/png", data: /checkout/i.test(p) ? CHECKOUT_PNG : ORDERS_PNG };
    }
    if (method !== "POST") throw new ApiError(405, "method not allowed");
    if (this.s.scope !== "owner") throw new ApiError(403, "read-only link");
    if (this.s.fail.has(action)) throw new ApiError(500, `${action} failed (simulated)`);

    switch (action) {
      case "prompt": {
        const b = body as { text?: unknown; attachments?: Attachment[] };
        return this.prompt(agent, String(b?.text ?? ""), b?.attachments ?? []);
      }
      case "stop":
        this.update(agent.id, { status: "stopped", running: false, queuePaused: (agent.queue ?? []).length > 0 });
        return;
      case "config": {
        const { optionId, value } = body as { optionId: string; value: string };
        const opts = agent.configOptions ?? [];
        const opt = opts.find((o) => o.id === optionId);
        if (!opt || !opt.options.some((c) => c.value === value)) throw new ApiError(400, "Unknown option");
        this.update(agent.id, { configOptions: opts.map((o) => (o.id === optionId ? { ...o, currentValue: value } : o)) });
        return;
      }
      case "account": {
        const { accountId } = body as { accountId: string };
        const acc = accounts.find((a) => a.id === accountId);
        if (!acc || acc.provider !== agent.provider) throw new ApiError(400, "That account is for a different provider");
        this.update(agent.id, { accountId, rateLimited: false, status: agent.status === "error" ? "idle" : agent.status });
        this.push(this.newItem<"notice">(agent.id, { kind: "notice", level: "info", text: `Switched to ${acc.name}` }));
        return structuredClone(this.agents.get(agent.id));
      }
      case "commit":
      case "ship": {
        if (agent.status === "working" || agent.status === "needs_permission" || agent.status === "starting") {
          throw new ApiError(400, "The agent is still working; stop it or wait before committing.");
        }
        const message = String((body as { message?: unknown })?.message ?? "");
        if (action === "commit") {
          return { result: { hash: "a1b2c3d", files: ["e2e/checkout.spec.ts", "playwright.config.ts"], leftUncommitted: 0, skipped: [], message: `Committed 2 files (a1b2c3d): ${message}` } };
        }
        if (!agent.worktree) throw new ApiError(400, "Only agents running in their own worktree branch can be merged");
        if (this.s.fail.has("merge")) return { committed: "a1b2c3d", merged: null, error: `Committed a1b2c3d on ${agent.branch}, but the merge failed: conflicts in src/billing/plans.ts` };
        return { committed: "a1b2c3d", merged: `Merged ${agent.branch} into ${agent.baseBranch ?? "main"}: 2 files changed`, error: null };
      }
      case "archive":
        this.update(agent.id, { archived: !!(body as { archived?: boolean })?.archived });
        return;
      case "read":
        this.update(agent.id, { unread: false });
        return;
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
    this.emit({ type: "agent_updated", agent: this.s.scope === "viewer" ? trimForViewer(next) : structuredClone(next) });
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

  private prompt(agent: Agent, text: string, attachments: Attachment[] = []) {
    if (!text.trim() && !attachments.length) throw new ApiError(400, "empty prompt");
    if (attachments.length > 4) throw new ApiError(400, "Attach at most 4 images");
    if (agent.status === "working" || agent.status === "starting" || agent.status === "needs_permission") {
      // Mid-turn messages are queued and run after the current turn.
      const queue = [...(agent.queue ?? []), { id: `q${Date.now()}`, text, attachments: attachments.length }];
      this.update(agent.id, { queue, queuedPrompts: queue.length, queuePaused: false });
      return;
    }
    this.push(this.newItem<"user_message">(agent.id, attachments.length ? { kind: "user_message", text, attachments } : { kind: "user_message", text }));
    this.update(agent.id, { status: "working", running: true, rateLimited: false });
    const reply = this.newItem<"agent_message">(agent.id, { kind: "agent_message", text: "" });
    const words = "On it. I'll look at the relevant files first and report back with a plan before changing anything.".split(" ");
    setTimeout(() => {
      this.push(reply);
      words.forEach((w, i) =>
        setTimeout(() => {
          this.appendText(reply, `${i ? " " : ""}${w}`);
          if (i === words.length - 1) {
            this.push(structuredClone(reply)); // every stream ends with a full upsert
            this.update(agent.id, { status: "idle", lastMessage: (reply as { text: string }).text });
            this.attention(agent.id, "done");
            this.runNextQueued(agent.id);
          }
        }, 90 * (i + 1)),
      );
    }, 700);
  }

  private create(req: CreateAgentRequest): Agent {
    const acc = accounts.find((a) => a.id === req.accountId);
    if (!acc || acc.provider !== req.provider) throw new ApiError(400, "That account is for a different provider");
    if (req.provider === "custom" && !customAgents.some((c) => c.id === req.customAgentId && c.enabled !== false)) {
      throw new ApiError(400, "Choose an enabled custom agent");
    }
    const now = Date.now();
    const id = `n${now}`;
    const title = req.title?.trim() || (req.prompt ? req.prompt.split(/\s+/).slice(0, 6).join(" ") : "New agent");
    const created: Agent = {
      ...structuredClone(this.agents.get("a5") ?? [...this.agents.values()][0]),
      id,
      title,
      provider: req.provider,
      accountId: req.accountId,
      customAgentId: req.customAgentId ?? null,
      projectPath: req.projectPath,
      cwd: req.projectPath,
      worktree: !!req.worktree,
      branch: req.worktree ? `armada/${id}` : null,
      status: "starting",
      running: true,
      archived: false,
      unread: false,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      costUsd: 0,
      tokensUsed: 0,
      lastMessage: null,
      pendingPermissions: 0,
      queue: [],
      queuedPrompts: 0,
      queuePaused: false,
      rateLimited: false,
      configOptions: providerConfig(req.provider),
    };
    this.agents.set(id, created);
    this.items.set(id, []);
    this.emit({ type: "agent_updated", agent: structuredClone(created) });
    setTimeout(() => {
      this.update(id, { status: "idle" });
      if (req.prompt || req.attachments?.length) this.prompt(this.agents.get(id)!, req.prompt ?? "", req.attachments ?? []);
    }, 900);
    return structuredClone(created);
  }

  /** After a turn ends, the oldest queued message runs (unless the queue is paused). */
  private runNextQueued(agentId: string) {
    const a = this.agents.get(agentId);
    if (!a || a.queuePaused || !a.queue?.length) return;
    const [next, ...rest] = a.queue;
    this.update(agentId, { queue: rest, queuedPrompts: rest.length });
    setTimeout(() => this.prompt(this.agents.get(agentId)!, next.text), 400);
  }

  private queueAction(agent: Agent, qid: string, sendNow: boolean) {
    const queue = agent.queue ?? [];
    const entry = queue.find((x) => x.id === qid);
    if (!entry) throw new ApiError(404, "That message is no longer queued");
    const rest = queue.filter((x) => x.id !== qid);
    this.update(agent.id, { queue: rest, queuedPrompts: rest.length });
    if (!sendNow) {
      // The real server returns the photos too; the mock has a sample for entries that had some.
      const photos = entry.attachments ? [{ name: "sketch.png", mimeType: "image/png", data: CHECKOUT_PNG }] : [];
      return { text: entry.text, attachments: photos };
    }
    // Interrupt the current turn and run it now.
    this.push(this.newItem<"notice">(agent.id, { kind: "notice", level: "info", text: "Turn interrupted to run your message" }));
    this.update(agent.id, { status: "idle", queuePaused: false });
    this.prompt(this.agents.get(agent.id)!, entry.text);
    return undefined;
  }

  private appendText(item: TimelineItem, delta: string) {
    if (item.kind !== "agent_message" && item.kind !== "thought") return;
    const offset = item.text.length;
    item.text += delta;
    this.emit({ type: "text_delta", agentId: item.agentId, itemId: item.id, field: "text", delta, offset });
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
    this.update(agent.id, { status: "idle", pendingPermissions: 0, queuePaused: (agent.queue ?? []).length > 0 });
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
      const done = list.find((i) => i.id === this.streamItemId);
      if (done) this.push(structuredClone(done)); // finished streaming: full upsert
      this.push(next);
      this.streamItemId = next.id;
      this.update("a3", { lastMessage: "Migrating the remaining pages to useApi." });
    }
  }
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
