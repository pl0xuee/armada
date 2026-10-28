// In-memory mock of the Rust backend, used when the UI runs in a plain browser.
// It mirrors the command surface of ./api.ts and emits the same ArmadaEvents,
// including simulated streaming, permissions, login terminals and installs.

import type { ArmadaApi } from "./api";
import { emitVoiceBus } from "./voiceBus";
import { isStressMode, STRESS_AGENTS, STRESS_TICK_MS, stressAgents, stressItems, stressWords } from "./mock-stress";
import {
  commandsFor,
  mockScreenshot,
  configFor,
  seedAccounts,
  seedAgents,
  seedDiff,
  seedItems,
  seedProviders,
  seedSchedules,
  MOCK_PROJECTS,
  seedSettings,
} from "./mock-data";
import type {
  Account,
  Checkpoint,
  RestorePreview,
  ShipResult,
  PrStatus,
  PrInfo,
  PrCheck,
  CommitSummary,
  Agent,
  AgentDiff,
  AppState,
  ArmadaEvent,
  Attachment,
  AttentionReason,
  FileDiff,
  PermissionOption,
  PlanEntry,
  ProjectScript,
  Provider,
  ProviderInfo,
  QueuedPrompt,
  Schedule,
  SearchHit,
  Settings,
  TimelineItem,
  ToolKind,
  UpdateInfo,
} from "./types";

type Listener = (e: ArmadaEvent | ArmadaEvent[]) => void;

const listeners = new Set<Listener>();

export function subscribeMock(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Like the real core: events emitted in one tick are delivered as one array.
let outbox: ArmadaEvent[] = [];
function emit(e: ArmadaEvent) {
  if (outbox.length === 0) queueMicrotask(flushOutbox);
  outbox.push(e);
}
function flushOutbox() {
  const batch = outbox;
  outbox = [];
  for (const l of listeners) {
    try {
      l(batch);
    } catch (err) {
      console.error("[mock] listener failed", err);
    }
  }
}

// ---------------------------------------------------------------- state

const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : null;
const platformParam = params?.get("platform");

const db = {
  accounts: seedAccounts(),
  providers: seedProviders(),
  settings: seedSettings(!(params?.has("onboarding") ?? false)),
  agents: seedAgents(),
  schedules: seedSchedules(),
  items: seedItems(),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clone = <T>(v: T): T => structuredClone(v);

function getAgent(id: string): Agent {
  const a = db.agents.find((x) => x.id === id);
  if (!a) throw new Error(`Unknown agent ${id}`);
  return a;
}

function patchAgent(id: string, patch: Partial<Agent>) {
  const a = getAgent(id);
  Object.assign(a, patch, { updatedAt: Date.now() });
  emit({ type: "agent_updated", agent: clone(a) });
}

function itemsOf(agentId: string): TimelineItem[] {
  return (db.items[agentId] ??= []);
}

let idCounter = 1000;
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

type NewItem = TimelineItem extends infer T
  ? T extends TimelineItem
    ? Omit<T, "id" | "agentId" | "seq" | "ts">
    : never
  : never;

function addItem(agentId: string, init: NewItem): TimelineItem {
  const list = itemsOf(agentId);
  const seq = (list[list.length - 1]?.seq ?? 0) + 1;
  const item = { ...init, id: newId(agentId), agentId, seq, ts: Date.now() } as TimelineItem;
  list.push(item);
  emit({ type: "item_upserted", item: clone(item) });
  return item;
}

function updateItem(agentId: string, itemId: string, patch: Record<string, unknown>) {
  const item = itemsOf(agentId).find((i) => i.id === itemId);
  if (!item) return;
  Object.assign(item, patch);
  emit({ type: "item_upserted", item: clone(item) });
}

function appendDelta(agentId: string, itemId: string, field: "text" | "output", delta: string) {
  const item = itemsOf(agentId).find((i) => i.id === itemId) as Record<string, unknown> | undefined;
  if (!item) return;
  const before = String(item[field] ?? "");
  item[field] = before + delta;
  emit({ type: "text_delta", agentId, itemId, field, delta, offset: before.length });
}

function bumpUsage(agentId: string, tokens: number) {
  const a = getAgent(agentId);
  const price = a.provider === "claude" ? 9e-6 : a.provider === "codex" ? 5e-6 : 3e-6;
  a.tokensUsed += tokens;
  a.costUsd = Math.round((a.costUsd + tokens * price) * 1000) / 1000;
  if (a.contextUsed !== null && a.contextSize !== null) {
    a.contextUsed = Math.min(a.contextSize, a.contextUsed + Math.round(tokens * 0.35));
  }
}

function attention(agentId: string, reason: AttentionReason, body: string) {
  const a = getAgent(agentId);
  const title =
    reason === "permission"
      ? `${a.title} needs approval`
      : reason === "done"
        ? `${a.title} is done`
        : `${a.title} hit an error`;
  emit({ type: "attention", agentId, reason, title, body, requestId: null });
}

// ---------------------------------------------------------------- streaming helpers

/** Cooperative cancellation for simulated turns. */
const turns = new Map<string, { cancelled: boolean }>();
class Cancelled extends Error {}

function tokenize(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

async function streamField(
  agentId: string,
  itemId: string,
  field: "text" | "output",
  text: string,
  turn: { cancelled: boolean },
  speed = 1,
) {
  const words = tokenize(text);
  let i = 0;
  while (i < words.length) {
    if (turn.cancelled) throw new Cancelled();
    const n = Math.max(1, Math.round(rand(1, 4)));
    appendDelta(agentId, itemId, field, words.slice(i, i + n).join(""));
    i += n;
    await sleep(rand(28, 70) / speed);
  }
  // Like the backend: every stream ends with the full item, so dropped deltas self-heal.
  updateItem(agentId, itemId, {});
}

async function streamLines(
  agentId: string,
  itemId: string,
  lines: string[],
  turn: { cancelled: boolean },
  delay: [number, number] = [120, 380],
) {
  for (const l of lines) {
    if (turn.cancelled) throw new Cancelled();
    appendDelta(agentId, itemId, "output", `${l}\n`);
    await sleep(rand(delay[0], delay[1]));
  }
  updateItem(agentId, itemId, {});
}

async function pause(ms: number, turn: { cancelled: boolean }) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (turn.cancelled) throw new Cancelled();
    await sleep(Math.min(100, end - Date.now()));
  }
}

const permissionWaiters = new Map<string, (optionId: string) => void>();

function waitForPermission(requestId: string, turn: { cancelled: boolean }): Promise<string> {
  return new Promise((resolve, reject) => {
    permissionWaiters.set(requestId, resolve);
    const poll = setInterval(() => {
      if (turn.cancelled) {
        clearInterval(poll);
        permissionWaiters.delete(requestId);
        reject(new Cancelled());
      }
    }, 150);
    const orig = resolve;
    permissionWaiters.set(requestId, (v) => {
      clearInterval(poll);
      orig(v);
    });
  });
}

async function runTurn(agentId: string, body: (turn: { cancelled: boolean }) => Promise<void>) {
  const prev = turns.get(agentId);
  if (prev) prev.cancelled = true;
  const turn = { cancelled: false };
  turns.set(agentId, turn);
  turnStarts.set(agentId, { at: Date.now(), from: itemsOf(agentId).length });
  try {
    await body(turn);
  } catch (e) {
    if (!(e instanceof Cancelled)) {
      console.error("[mock] turn failed", e);
      addItem(agentId, { kind: "notice", level: "error", text: String(e) });
      patchAgent(agentId, { status: "error" });
    }
  } finally {
    if (turns.get(agentId) === turn) turns.delete(agentId);
    setTimeout(() => drainQueue(agentId), 400);
  }
}

const turnStarts = new Map<string, { at: number; from: number }>();

// ---------------------------------------------------------------- prompt queue

const BUSY = new Set(["working", "needs_permission", "starting"]);
const queueImages = new Map<string, Attachment[]>();

function setQueue(agentId: string, queue: QueuedPrompt[], extra: Partial<Agent> = {}) {
  patchAgent(agentId, { queue, queuedPrompts: queue.length, ...extra });
}

/** Run the next queued prompt once the agent is idle (unless the queue is paused). */
function drainQueue(agentId: string) {
  const a = db.agents.find((x) => x.id === agentId);
  if (!a || !a.running || BUSY.has(a.status) || a.status === "stopped" || a.status === "interrupted") return;
  if (a.queuePaused || a.queue.length === 0) return;
  const [next, ...rest] = a.queue;
  const images = queueImages.get(next.id) ?? [];
  queueImages.delete(next.id);
  setQueue(agentId, rest);
  startPrompt(agentId, next.text, images);
}

function startPrompt(agentId: string, text: string, attachments: Attachment[]) {
  addItem(agentId, { kind: "user_message", text, ...(attachments.length ? { attachments } : {}) });
  patchAgent(agentId, { status: "working", lastActivityAt: Date.now() });
  const n = attachments.length;
  const described = n ? `${text || "Take a look at this"} (with ${n} image${n === 1 ? "" : "s"} attached)` : text;
  void runTurn(agentId, (turn) => scriptedTurn(agentId, described, turn));
}

// ---------------------------------------------------------------- scripted responses

const REPLIES = [
  "Done. Here's what changed:\n\n- Extracted the shared logic into `src/lib/retry.ts`\n- Added exponential backoff with **jitter** (base 200 ms, cap 5 s)\n- Covered the edge cases with three new unit tests\n\n```ts\nexport async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {\n  for (let i = 0; ; i++) {\n    try {\n      return await fn();\n    } catch (e) {\n      if (i >= attempts - 1 || !isRetryable(e)) throw e;\n      await sleep(Math.min(5000, 200 * 2 ** i) * (0.5 + Math.random()));\n    }\n  }\n}\n```\n\nEverything passes. Want me to open a PR?",
  "Good question. There are two reasonable options:\n\n1. **Keep it in the request handler**: simplest, but couples validation to transport.\n2. **Move it to a domain service**: a little more code, much easier to test.\n\nI'd go with option 2. I've sketched it in `src/services/orders.ts` and left the handler as a thin adapter. The diff is small and nothing else changes.",
  "I looked through the call sites and the issue is a stale closure: `onSave` captures `draft` from the first render. Switching to a functional update fixes it:\n\n```tsx\nsetDraft((d) => ({ ...d, title }));\n```\n\nI also added a test that types quickly into the field and asserts the final value.",
];

const READ_TARGETS = ["src/index.ts", "src/lib/retry.ts", "package.json", "src/services/orders.ts", "README.md"];

async function scriptedTurn(agentId: string, prompt: string, turn: { cancelled: boolean }) {
  patchAgent(agentId, { status: "working", running: true, lastActivityAt: Date.now() });
  await pause(500, turn);

  // Thinking
  const thought = addItem(agentId, { kind: "thought", text: "" });
  await streamField(
    agentId,
    thought.id,
    "text",
    `The user wants: "${prompt.slice(0, 80)}${prompt.length > 80 ? "…" : ""}". Let me look at the relevant files first, then make the smallest change that solves it and verify with tests.`,
    turn,
    1.6,
  );

  // Read
  const target = READ_TARGETS[Math.floor(Math.random() * READ_TARGETS.length)];
  const read = addItem(agentId, {
    kind: "tool_call",
    toolCallId: newId("tc"),
    title: `Read ${target}`,
    toolKind: "read",
    status: "in_progress",
    locations: [target],
    diffs: [],
    output: "",
    command: null,
  });
  await pause(700, turn);
  updateItem(agentId, read.id, { status: "completed" });

  // Permission-gated command when the prompt sounds like it wants to run something.
  if (/\b(test|run|install|build|deploy|migrat|lint)\w*/i.test(prompt)) {
    const command = /lint/i.test(prompt) ? "npm run lint" : /build/i.test(prompt) ? "npm run build" : "npm test";
    const requestId = newId("perm");
    const options: PermissionOption[] = [
      { id: "allow", name: "Allow once", kind: "allow_once" },
      { id: "always", name: `Always allow \`${command.split(" ")[0]}\``, kind: "allow_always" },
      { id: "deny", name: "Deny", kind: "reject_once" },
    ];
    addItem(agentId, {
      kind: "permission",
      requestId,
      title: `Run ${command}`,
      toolKind: "execute",
      command,
      diffs: [],
      options,
      resolution: null,
    });
    const a = getAgent(agentId);
    patchAgent(agentId, { status: "needs_permission", pendingPermissions: a.pendingPermissions + 1 });
    emit({
      type: "attention",
      agentId,
      reason: "permission",
      title: `${getAgent(agentId).title} needs approval`,
      body: `Wants to run: ${command}`,
      requestId,
    });
    const choice = await waitForPermission(requestId, turn);
    const chosen = options.find((o) => o.id === choice);
    patchAgent(agentId, { status: "working" });
    if (chosen && chosen.kind.startsWith("reject")) {
      const msg = addItem(agentId, { kind: "agent_message", text: "" });
      await streamField(
        agentId,
        msg.id,
        "text",
        "Understood, I won't run that. What would you like me to do instead?",
        turn,
      );
      finishTurn(agentId, "Waiting for your direction.");
      return;
    }
    const exec = addItem(agentId, {
      kind: "tool_call",
      toolCallId: newId("tc"),
      title: `Run ${command}`,
      toolKind: "execute",
      status: "in_progress",
      locations: [],
      diffs: [],
      output: "",
      command,
    });
    await streamLines(
      agentId,
      exec.id,
      [
        "",
        `> app@1.0.0 ${command.replace("npm run ", "").replace("npm ", "")}`,
        "",
        " ✓ src/lib/retry.test.ts (6 tests) 41ms",
        " ✓ src/services/orders.test.ts (11 tests) 87ms",
        " ✓ src/http/client.test.ts (9 tests) 64ms",
        "",
        " Test Files  3 passed (3)",
        "      Tests  26 passed (26)",
        "   Duration  1.42s",
      ],
      turn,
    );
    updateItem(agentId, exec.id, { status: "completed" });
  } else {
    // An edit with a diff
    const path = "src/lib/retry.ts";
    const oldText = "export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {\n  return fn();\n}\n";
    const newText =
      "export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {\n  for (let i = 0; ; i++) {\n    try {\n      return await fn();\n    } catch (e) {\n      if (i >= attempts - 1 || !isRetryable(e)) throw e;\n      await sleep(Math.min(5000, 200 * 2 ** i) * (0.5 + Math.random()));\n    }\n  }\n}\n";
    const edit = addItem(agentId, {
      kind: "tool_call",
      toolCallId: newId("tc"),
      title: `Edit ${path}`,
      toolKind: "edit",
      status: "in_progress",
      locations: [path],
      diffs: [],
      output: "",
      command: null,
    });
    await pause(900, turn);
    const diffs: FileDiff[] = [{ path, oldText, newText, unified: null }];
    updateItem(agentId, edit.id, { status: "completed", diffs });
  }

  bumpUsage(agentId, Math.round(rand(6000, 22000)));
  const reply = REPLIES[Math.floor(Math.random() * REPLIES.length)];
  const msg = addItem(agentId, { kind: "agent_message", text: "" });
  await streamField(agentId, msg.id, "text", reply, turn);
  finishTurn(agentId, reply);
}

function finishTurn(agentId: string, text: string) {
  const preview = text
    .replace(/[#*`>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  bumpUsage(agentId, Math.round(rand(800, 3000)));
  const start = turnStarts.get(agentId);
  if (start) {
    const turnItems = itemsOf(agentId).slice(start.from);
    const tools = turnItems.filter((i) => i.kind === "tool_call");
    if (tools.length > 0) {
      const files = new Set<string>();
      for (const t of tools) {
        if (t.kind !== "tool_call") continue;
        if (t.toolKind === "edit" || t.toolKind === "delete" || t.toolKind === "move" || t.diffs.length) {
          for (const p of [...t.locations, ...t.diffs.map((d) => d.path)]) files.add(p);
        }
      }
      addItem(agentId, {
        kind: "turn_summary",
        durationMs: Date.now() - start.at,
        files: [...files],
        toolCalls: tools.length,
        commands: tools.filter((t) => t.kind === "tool_call" && t.toolKind === "execute").length,
        costUsd: Math.round(rand(0.05, 0.6) * 100) / 100,
        tokens: Math.round(rand(8000, 60000)),
      });
    }
  }
  patchAgent(agentId, {
    status: "idle",
    lastMessage: preview,
    lastActivityAt: Date.now(),
    unread: true,
  });
  attention(agentId, "done", preview);
}

// ---------------------------------------------------------------- boot-time live activity

let liveStarted = false;

function startLiveActivity() {
  if (liveStarted) return;
  liveStarted = true;

  // 1) Claude agent finishing its test run, then summarizing.
  void runTurn("a-token", async (turn) => {
    await pause(1800, turn);
    const exec = itemsOf("a-token").find((i) => i.kind === "tool_call" && i.status === "in_progress");
    if (exec) {
      await streamLines(
        "a-token",
        exec.id,
        [
          " ✓ test/auth.test.ts > refreshToken > stores the new token pair 3ms",
          " ✓ test/auth.test.ts > refreshToken > clears tokens on invalid_grant 2ms",
          " ✓ test/auth.test.ts > refreshToken > shares one request between concurrent callers 4ms",
          " ✓ test/http/client.test.ts > interceptor > retries once after refresh 6ms",
          " ✓ test/http/client.test.ts > interceptor > queues requests during refresh 9ms",
          " ✓ test/http/client.test.ts > interceptor > logs out after a failed refresh 3ms",
          "",
          " Test Files  2 passed (2)",
          "      Tests  6 passed (6)",
          "   Start at  14:02:11",
          "   Duration  612ms (transform 88ms, setup 0ms, collect 141ms, tests 27ms)",
        ],
        turn,
        [500, 1400],
      );
      updateItem("a-token", exec.id, { status: "completed" });
    }
    const plan = itemsOf("a-token").find((i) => i.kind === "plan");
    if (plan && plan.kind === "plan") {
      const entries: PlanEntry[] = plan.entries.map((e, i) =>
        i < 4 ? { ...e, status: "completed" } : { ...e, status: "in_progress" },
      );
      updateItem("a-token", plan.id, { entries });
    }
    bumpUsage("a-token", 14000);
    const msg = addItem("a-token", { kind: "agent_message", text: "" });
    const summary =
      "All **6 auth tests pass**, including the new concurrency regression test.\n\n### What changed\n\n- `refreshToken()` is now **single-flight**: one in-flight promise shared by concurrent callers, cleared in `finally` so a failed refresh can be retried.\n- The interceptor queues requests that 401 while a refresh is running and replays them with the new token.\n- New test: two parallel `refreshToken()` calls hit `/oauth/token` exactly **once**.\n\n```diff\n- export async function refreshToken(): Promise<string> {\n+ export function refreshToken(): Promise<string> {\n+   inflight ??= doRefresh().finally(() => { inflight = null; });\n+   return inflight;\n```\n\nThe branch `armada/fix-token-refresh` is ready for review.";
    await streamField("a-token", msg.id, "text", summary, turn, 0.45);
    if (plan && plan.kind === "plan") {
      updateItem("a-token", plan.id, { entries: plan.entries.map((e) => ({ ...e, status: "completed" })) });
    }
    finishTurn("a-token", "All 6 auth tests pass, including the new concurrency regression test.");
  });

  // 2) Grok research agent keeps fetching sources for a while.
  void runTurn("a-research", async (turn) => {
    const sources = [
      ["Fetch turbopuffer.com/docs/performance", "200 OK · 36 KB · object-storage backed, ~10ms p50 warm namespaces"],
      ["Fetch aws.amazon.com/rds/postgresql/pricing", "200 OK · 210 KB · r6g.2xlarge on-demand + storage"],
      ['Search "pgvector 4M vectors p95 latency"', "8 results · 3 relevant benchmarks (2025)"],
      ["Fetch qdrant.tech/pricing", "200 OK · 61 KB · managed cloud tiers"],
    ];
    // A sub-agent that explores in parallel, with child calls nested under it.
    await pause(1200, turn);
    const sa = addItem("a-research", {
      kind: "tool_call",
      toolCallId: "gk-sub",
      title: "Benchmark notes for Qdrant",
      toolKind: "other",
      status: "in_progress",
      locations: [],
      diffs: [],
      output: "",
      command: null,
      subagent: {
        kind: "general-purpose",
        description: "Collect Qdrant filtered-search benchmarks at 1–10M vectors",
        prompt:
          "Find recent (2025+) public benchmarks for Qdrant filtered vector search between 1M and 10M vectors. Summarize p50/p95 latency, hardware, and recall settings. Cite sources.",
      },
    });
    // Two background sub-agents (Claude's run_in_background): their calls complete at launch, yet
    // they keep working until the turn ends.
    const bgRuns = [
      ["gk-bg1", "Explore", "Survey Turbopuffer namespace limits and pricing", 'Search "turbopuffer namespace limits"'],
      [
        "gk-bg2",
        "general-purpose",
        "Price out pgvector on RDS for 4M vectors",
        "Fetch aws.amazon.com/rds/instance-types",
      ],
    ] as const;
    const bgChildren: string[] = [];
    for (const [tcId, kind, description, step] of bgRuns) {
      addItem("a-research", {
        kind: "tool_call",
        toolCallId: tcId,
        title: description,
        toolKind: "other",
        status: "completed",
        locations: [],
        diffs: [],
        output: "Async agent launched successfully.",
        command: null,
        subagent: { kind, description, prompt: description, background: true },
      });
      const c = addItem("a-research", {
        kind: "tool_call",
        toolCallId: newId("gk-bc"),
        title: step,
        toolKind: "fetch",
        status: "in_progress",
        locations: [],
        diffs: [],
        output: "",
        command: null,
        parentToolCallId: tcId,
      });
      bgChildren.push(c.id);
    }
    const childTitles = [
      ['Search "qdrant filtered search benchmark 2025"', "search"],
      ["Fetch qdrant.tech/benchmarks/filtered", "fetch"],
      ["Fetch github.com/erikbern/ann-benchmarks", "fetch"],
    ] as const;
    for (const [ct, kind] of childTitles) {
      const c = addItem("a-research", {
        kind: "tool_call",
        toolCallId: newId("gk-c"),
        title: ct,
        toolKind: kind,
        status: "in_progress",
        locations: [],
        diffs: [],
        output: "",
        command: null,
        parentToolCallId: "gk-sub",
      });
      patchAgent("a-research", { lastMessage: ct });
      await pause(rand(1600, 2600), turn);
      updateItem("a-research", c.id, { status: "completed" });
    }
    appendDelta("a-research", sa.id, "output", "Qdrant p95 ≈ 9 ms at 4M × 1536 with payload filters (HNSW m=16).");
    updateItem("a-research", sa.id, { status: "completed" });

    for (const [title, out] of sources) {
      await pause(rand(2500, 4500), turn);
      const kind: ToolKind = title.startsWith("Search") ? "search" : "fetch";
      const tc = addItem("a-research", {
        kind: "tool_call",
        toolCallId: newId("gk"),
        title,
        toolKind: kind,
        status: "in_progress",
        locations: [],
        diffs: [],
        output: "",
        command: null,
      });
      await pause(rand(1200, 2400), turn);
      appendDelta("a-research", tc.id, "output", out);
      updateItem("a-research", tc.id, { status: "completed" });
      bumpUsage("a-research", 9000);
      patchAgent("a-research", { lastMessage: title.replace(/^Fetch /, "Reading ") });
    }
    for (const id of bgChildren) updateItem("a-research", id, { status: "completed" });
    await pause(1500, turn);
    const msg = addItem("a-research", { kind: "agent_message", text: "" });
    const text =
      "## Recommendation: start with pgvector\n\n| | pgvector (HNSW) | Qdrant Cloud | Turbopuffer |\n|---|---|---|---|\n| p95 @ 4M × 1536 | ~18 ms | ~9 ms | ~25 ms (warm) |\n| Filtered search | good (0.8 iterative scans) | excellent | good |\n| Est. monthly cost | **~$410** | ~$690 | ~$140 + egress |\n| Ops burden | none new | new service | new vendor |\n\n**Why:** you already run Postgres, latency is well inside the 100 ms budget, and it keeps tickets and embeddings transactionally consistent. Revisit Qdrant if filtered queries exceed ~30% of traffic or the corpus passes 20M.";
    await streamField("a-research", msg.id, "text", text, turn, 0.6);
    finishTurn(
      "a-research",
      "Recommendation: start with pgvector. ~18 ms p95 at 4M vectors and no new infrastructure.",
    );
  });
}

// ---------------------------------------------------------------- terminals

interface MockTerminal {
  id: string;
  kind: "login" | "install";
  accountId?: string;
  provider?: Provider;
  buffer: string;
  stage: number;
  done: boolean;
  /** A workspace-panel shell (echoes typed input). */
  shell?: boolean;
}

const MOCK_SCRIPTS: ProjectScript[] = [
  { id: "npm:dev", source: "npm", name: "dev", command: "npm run dev" },
  { id: "npm:build", source: "npm", name: "build", command: "npm run build" },
  { id: "npm:test", source: "npm", name: "test", command: "npm run test" },
  { id: "cargo:test", source: "cargo", name: "test", command: "cargo test" },
];

const terminals = new Map<string, MockTerminal>();

function termOut(id: string, data: string) {
  emit({ type: "terminal_output", terminalId: id, data });
}

async function termExit(t: MockTerminal, code: number) {
  t.done = true;
  await sleep(400);
  emit({ type: "terminal_exit", terminalId: t.id, code });
  terminals.delete(t.id);
}

const C = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  reset: "\x1b[0m",
};

async function runLogin(t: MockTerminal) {
  const acc = db.accounts.find((a) => a.id === t.accountId);
  const cli = acc?.provider === "codex" ? "codex" : acc?.provider === "grok" ? "grok" : "claude";
  await sleep(350);
  termOut(t.id, `${C.dim}$ ${cli} ${cli === "claude" ? "/login" : "login"}${C.reset}\r\n\r\n`);
  await sleep(500);
  termOut(
    t.id,
    `${C.bold}Sign in to ${acc ? (cli === "codex" ? "ChatGPT" : cli === "grok" ? "Grok" : "Claude") : "provider"}${C.reset}\r\n\r\n`,
  );
  await sleep(300);
  termOut(t.id, `Opening your browser to complete sign-in…\r\n`);
  await sleep(500);
  termOut(
    t.id,
    `If the browser didn't open, visit:\r\n${C.cyan}https://auth.example.com/oauth/authorize?client_id=armada-demo&code_challenge=Xq9…${C.reset}\r\n\r\n`,
  );
  await sleep(400);
  termOut(
    t.id,
    `${C.yellow}Paste the code from the browser here (or press Enter to simulate success):${C.reset}\r\n> `,
  );
  t.stage = 1;
}

async function finishLogin(t: MockTerminal) {
  t.stage = 2;
  termOut(t.id, `\r\n\r\n${C.dim}Exchanging code…${C.reset}\r\n`);
  await sleep(900);
  const acc = db.accounts.find((a) => a.id === t.accountId);
  if (acc) {
    acc.status = {
      loggedIn: true,
      label: acc.provider === "claude" ? "Claude Max" : acc.provider === "codex" ? "ChatGPT Plus" : "SuperGrok",
      email: `sam+${acc.name.toLowerCase().replace(/\W+/g, "")}@fleet.dev`,
      plan: acc.provider === "claude" ? "Max 5x" : acc.provider === "codex" ? "Plus" : "SuperGrok",
      checkedAt: Date.now(),
      error: null,
    };
    emit({ type: "account_updated", account: clone(acc) });
  }
  termOut(t.id, `${C.green}✔ Login successful.${C.reset} Credentials saved to this profile.\r\n`);
  await termExit(t, 0);
}

async function runInstallMissing(t: MockTerminal) {
  const missing = db.providers.filter((p) => !p.installed || (p.adapterRequired && !p.adapterInstalled));
  await sleep(300);
  const out = (s: string, ms = 250) => {
    termOut(t.id, `${s}\r\n`);
    return sleep(rand(ms * 0.6, ms * 1.4));
  };
  await out(`${C.cyan}▸${C.reset} Checking for Node.js…`);
  await out(`${C.green}✓${C.reset} Node.js 22.11.0 found`);
  if (missing.length === 0) {
    await out(`${C.green}✓${C.reset} Everything is already installed.`);
    return termExit(t, 0);
  }
  for (const p of missing) {
    if (t.done) return;
    await out(`${C.cyan}▸${C.reset} Installing ${p.displayName} (${p.cliName})…`, 400);
    await out(
      `${C.dim}  npm install --prefix ~/.local/share/armada/tools ${p.installCommand.split(" ").slice(3).join(" ")}${C.reset}`,
    );
    await out(`${C.dim}  added 18 packages in 3s${C.reset}`, 700);
    p.installed = true;
    p.version = p.version ?? "1.0.3";
    p.path = `~/.local/share/armada/tools/bin/${p.cliName}`;
    if (p.adapterRequired) p.adapterInstalled = true;
    await out(`${C.green}✓${C.reset} ${p.displayName} ${p.version} ready`);
  }
  await out("");
  await out(`${C.green}✓ All agents installed.${C.reset}`);
  emit({ type: "providers_changed", providers: clone(db.providers) });
  await termExit(t, 0);
}

async function runInstall(t: MockTerminal) {
  const p = db.providers.find((x) => x.provider === t.provider);
  if (!p) return termExit(t, 1);
  await sleep(300);
  termOut(t.id, `${C.dim}$ ${p.installCommand}${C.reset}\r\n\r\n`);
  const steps = [
    "npm http fetch GET 200 https://registry.npmjs.org/ 142ms",
    "npm http fetch GET 200 https://registry.npmjs.org/@types%2fnode 88ms",
    "npm info run postinstall",
    "",
    `added 12 packages in 4s`,
    "",
  ];
  for (const s of steps) {
    termOut(t.id, `${s}\r\n`);
    await sleep(rand(200, 600));
  }
  p.installed = true;
  p.version = p.version ?? "1.0.3";
  p.path = `/usr/local/bin/${p.cliName}`;
  if (p.adapterRequired) p.adapterInstalled = true;
  termOut(t.id, `${C.green}✔ ${p.displayName} installed (${p.version}).${C.reset}\r\n`);
  emit({ type: "providers_changed", providers: clone(db.providers) });
  await termExit(t, 0);
}

// ---------------------------------------------------------------- sound (WebAudio preview)

let audioCtx: AudioContext | null = null;
function playTone(reason: AttentionReason) {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    const vol = db.settings.sounds.volume * 0.18;
    const notes = reason === "permission" ? [660, 990] : reason === "done" ? [523.25, 659.25, 783.99] : [196, 147];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = reason === "error" ? "triangle" : "sine";
      o.frequency.value = f;
      const t0 = ctx.currentTime + i * 0.11;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
      o.connect(g).connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + 0.5);
    });
  } catch {
    /* audio not available */
  }
}

// ---------------------------------------------------------------- API

function delay<T>(v: T, ms = 120): Promise<T> {
  return new Promise((r) => setTimeout(() => r(v), ms + Math.random() * 80));
}

export const mockApi: ArmadaApi = {
  async getState(): Promise<AppState> {
    setTimeout(startLiveActivity, 600);
    if (isStressMode()) setupStress();
    const platform =
      platformParam === "macos" || platformParam === "windows" || platformParam === "linux"
        ? platformParam
        : /Mac/i.test(navigator.platform)
          ? "macos"
          : /Win/i.test(navigator.platform)
            ? "windows"
            : "linux";
    return delay(
      clone({
        agents: db.agents,
        accounts: db.accounts,
        providers: db.providers,
        settings: db.settings,
        version: "0.1.0-mock",
        platform,
      }),
      350,
    );
  },

  async listItems(agentId, opts) {
    let list = itemsOf(agentId);
    if (opts?.beforeSeq !== undefined) list = list.filter((i) => i.seq < (opts.beforeSeq ?? Infinity));
    if (opts?.limit !== undefined) list = list.slice(Math.max(0, list.length - opts.limit));
    return delay(clone(list), 220);
  },

  async search(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: SearchHit[] = [];
    for (const [agentId, list] of Object.entries(db.items)) {
      for (const it of list) {
        const text =
          it.kind === "user_message" || it.kind === "agent_message" || it.kind === "thought" || it.kind === "notice"
            ? it.text
            : it.kind === "tool_call" || it.kind === "permission"
              ? `${it.title} ${it.kind === "tool_call" ? it.output : (it.command ?? "")}`
              : it.kind === "plan"
                ? it.entries.map((e) => e.content).join(" ")
                : "";
        const idx = text.toLowerCase().indexOf(q);
        if (idx >= 0) {
          const start = Math.max(0, idx - 40);
          hits.push({
            agentId,
            itemId: it.id,
            kind: it.kind,
            snippet: `${start > 0 ? "…" : ""}${text.slice(start, idx + q.length + 60).replace(/\s+/g, " ")}`,
            ts: it.ts,
          });
        }
      }
    }
    return delay(hits.sort((a, b) => b.ts - a.ts).slice(0, 30), 160);
  },

  async createAgent(req) {
    const now = Date.now();
    const id = newId("a");
    const folder = req.projectPath.split("/").filter(Boolean).pop() ?? "";
    const hasPrompt = req.prompt.trim() !== "" || req.attachments.length > 0;
    const slug = (req.title || req.prompt || folder)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 28)
      .replace(/-+$/, "");
    const agent: Agent = {
      id,
      title:
        req.title?.trim() ||
        req.prompt.trim().split(/[.\n]/)[0].slice(0, 60) ||
        (folder ? `New agent · ${folder}` : "New agent"),
      provider: req.provider,
      accountId: req.accountId,
      projectPath: req.projectPath,
      cwd: req.worktree ? `/home/sam/.armada/worktrees/${req.projectPath.split("/").pop()}/${id}` : req.projectPath,
      worktree: req.worktree,
      branch: req.worktree ? `armada/${slug}` : null,
      baseBranch: req.worktree ? "main" : null,
      baseCommit: req.worktree ? "4f1c2e9a7b" : null,
      sessionId: null,
      status: "starting",
      running: true,
      groupId: req.groupId,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      costUsd: 0,
      tokensUsed: 0,
      contextUsed: 0,
      contextSize: req.provider === "claude" ? 200_000 : req.provider === "codex" ? 272_000 : 256_000,
      unread: false,
      archived: false,
      lastMessage: null,
      pendingPermissions: 0,
      configOptions: configFor(req.provider, req.model),
      availableCommands: commandsFor(req.provider),
      rateLimited: false,
      scheduleId: null,
      customAgentId: req.provider === "custom" ? req.customAgentId : null,
      queuedPrompts: 0,
      queue: [],
      queuePaused: false,
      acknowledgedAt: null,
      needsBriefing: false,
      permissionMode: req.permissionMode ?? db.settings.defaultPermissionMode,
    };
    db.agents.unshift(agent);
    db.items[id] = [];
    if (!db.settings.recentProjects.includes(req.projectPath)) {
      db.settings.recentProjects = [req.projectPath, ...db.settings.recentProjects].slice(0, 8);
    }
    emit({ type: "agent_updated", agent: clone(agent) });
    setTimeout(() => {
      if (!hasPrompt) {
        // Started without a prompt: warm up and wait for the first message.
        patchAgent(id, { sessionId: `ses_${id.slice(-8)}`, status: "idle" });
        return;
      }
      patchAgent(id, { sessionId: `ses_${id.slice(-8)}`, status: "working" });
      addItem(id, {
        kind: "user_message",
        text: req.prompt,
        ...(req.attachments.length ? { attachments: req.attachments } : {}),
      });
      void runTurn(id, (turn) => scriptedTurn(id, req.prompt, turn));
    }, 700);
    return delay(clone(agent), 250);
  },

  async sendPrompt(agentId, text, attachments) {
    const a = getAgent(agentId);
    if (!a.running) throw new Error("Agent is not running. Resume it first.");
    // Like the real backend: messages sent mid-turn queue (outside the timeline) and run after it.
    if (BUSY.has(a.status)) {
      const q: QueuedPrompt = { id: newId("q"), text, attachments: attachments?.length ?? 0 };
      if (attachments?.length) queueImages.set(q.id, attachments);
      setQueue(agentId, [...a.queue, q]);
      return delay(undefined, 40);
    }
    // Agents started without a prompt are named after their first message.
    if (!itemsOf(agentId).some((i) => i.kind === "user_message") && text.trim() && a.title.startsWith("New agent")) {
      patchAgent(agentId, { title: text.trim().split(/[.\n]/)[0].slice(0, 60) });
    }
    // Sending resumes a paused queue (this message first, then the queue).
    if (a.queuePaused) patchAgent(agentId, { queuePaused: false });
    startPrompt(agentId, text, attachments ?? []);
    return delay(undefined, 40);
  },

  async removeQueued(agentId, queuedId) {
    const a = getAgent(agentId);
    const q = a.queue.find((x) => x.id === queuedId);
    if (!q) return delay(null, 40);
    const images = queueImages.get(queuedId) ?? [];
    queueImages.delete(queuedId);
    setQueue(
      agentId,
      a.queue.filter((x) => x.id !== queuedId),
    );
    return delay({ text: q.text, attachments: images }, 60);
  },

  async resumeQueue(agentId) {
    const a = getAgent(agentId);
    patchAgent(agentId, { queuePaused: false });
    // Like the core: a shut-down agent restarts to run its queue.
    if (!a.running) patchAgent(agentId, { running: true, status: "idle" });
    setTimeout(() => drainQueue(agentId), 200);
    return delay(undefined, 60);
  },

  async clearQueue(agentId) {
    const a = getAgent(agentId);
    const n = a.queue.length;
    for (const q of a.queue) queueImages.delete(q.id);
    setQueue(agentId, [], { queuePaused: false });
    return delay(n, 60);
  },

  async sendQueuedNow(agentId, queuedId) {
    const a = getAgent(agentId);
    const q = a.queue.find((x) => x.id === queuedId);
    if (!q) throw new Error("That message already ran.");
    // Move it to the front, stop the current turn, and let the queue run it.
    setQueue(agentId, [q, ...a.queue.filter((x) => x.id !== queuedId)], { queuePaused: false });
    const t = turns.get(agentId);
    if (t) t.cancelled = true;
    for (const it of itemsOf(agentId)) {
      if (it.kind === "permission" && it.resolution === null) updateItem(agentId, it.id, { resolution: "cancelled" });
      if (it.kind === "tool_call" && (it.status === "in_progress" || it.status === "pending")) {
        updateItem(agentId, it.id, { status: "failed" });
      }
    }
    addItem(agentId, { kind: "notice", level: "info", text: "Interrupted to run your queued message now." });
    patchAgent(agentId, { status: "idle", pendingPermissions: 0 });
    setTimeout(() => drainQueue(agentId), 300);
    return delay(undefined, 60);
  },

  async cancelTurn(agentId) {
    const t = turns.get(agentId);
    if (t) t.cancelled = true;
    // Resolve any pending permission as cancelled.
    for (const it of itemsOf(agentId)) {
      if (it.kind === "permission" && it.resolution === null) updateItem(agentId, it.id, { resolution: "cancelled" });
    }
    for (const it of itemsOf(agentId)) {
      if (it.kind === "tool_call" && (it.status === "in_progress" || it.status === "pending")) {
        updateItem(agentId, it.id, { status: "failed" });
      }
    }
    addItem(agentId, { kind: "notice", level: "info", text: "Turn cancelled." });
    const cur = getAgent(agentId);
    // Stopping holds the queue; the next message you send resumes it.
    patchAgent(agentId, { status: "idle", pendingPermissions: 0, queuePaused: cur.queue.length > 0 });
    return delay(undefined, 60);
  },

  async respondPermission(agentId, requestId, optionId) {
    const item = itemsOf(agentId).find((i) => i.kind === "permission" && i.requestId === requestId);
    if (!item || item.kind !== "permission") throw new Error("Unknown permission request");
    updateItem(agentId, item.id, { resolution: optionId });
    const a = getAgent(agentId);
    const pending = Math.max(0, a.pendingPermissions - 1);
    patchAgent(agentId, { pendingPermissions: pending, status: pending ? "needs_permission" : "working" });

    const waiter = permissionWaiters.get(requestId);
    if (waiter) {
      permissionWaiters.delete(requestId);
      waiter(optionId);
    } else {
      // Seeded permissions: simulate the rest of the turn.
      const opt = item.options.find((o) => o.id === optionId);
      void runTurn(agentId, async (turn) => {
        if (opt?.kind.startsWith("reject")) {
          const msg = addItem(agentId, { kind: "agent_message", text: "" });
          await streamField(agentId, msg.id, "text", "Okay, I won't do that. How would you like me to proceed?", turn);
          finishTurn(agentId, "Waiting for your direction.");
          return;
        }
        if (item.toolKind === "execute" && item.command) {
          const exec = addItem(agentId, {
            kind: "tool_call",
            toolCallId: newId("tc"),
            title: `Run ${item.command}`,
            toolKind: "execute",
            status: "in_progress",
            locations: [],
            diffs: [],
            output: "",
            command: item.command,
          });
          await streamLines(
            agentId,
            exec.id,
            [
              "Environment variables loaded from .env",
              "Prisma schema loaded from prisma/schema.prisma",
              'Datasource "db": PostgreSQL database "atlas_dev" at "localhost:5432"',
              "",
              "Applying migration `20261027140211_billing_payment_intents`",
              "",
              "The following migration(s) have been created and applied from new schema changes:",
              "",
              "migrations/",
              "  └─ 20261027140211_billing_payment_intents/",
              "    └─ migration.sql",
              "",
              "Your database is now in sync with your schema.",
              "",
              "✔ Generated Prisma Client (v6.17.1) to ./node_modules/@prisma/client in 212ms",
            ],
            turn,
          );
          updateItem(agentId, exec.id, { status: "completed" });
        } else {
          const tc = addItem(agentId, {
            kind: "tool_call",
            toolCallId: newId("tc"),
            title: item.title,
            toolKind: item.toolKind ?? "edit",
            status: "in_progress",
            locations: item.diffs.map((d) => d.path),
            diffs: item.diffs,
            output: "",
            command: null,
          });
          await pause(800, turn);
          updateItem(agentId, tc.id, { status: "completed" });
        }
        bumpUsage(agentId, 12000);
        const msg = addItem(agentId, { kind: "agent_message", text: "" });
        const reply =
          item.toolKind === "execute"
            ? "Migration applied cleanly. I also regenerated the Prisma client and ran the billing tests: **all 31 pass**.\n\nNext I'd backfill `paymentIntentId` for recent charges with a one-off script. Want me to write it?"
            : "Created the middleware and mounted it on `/api/v1/*` before the auth layer, so unauthenticated floods are limited too. I added tests for the header values and the `429` path.";
        await streamField(agentId, msg.id, "text", reply, turn);
        finishTurn(agentId, reply);
      });
    }
    return delay(undefined, 60);
  },

  async resumeAgent(agentId, autoContinue) {
    patchAgent(agentId, { status: "starting", running: true });
    await sleep(700);
    addItem(agentId, {
      kind: "notice",
      level: "info",
      text: `Session resumed${autoContinue ? " and continuing" : ""}.`,
    });
    if (autoContinue) {
      patchAgent(agentId, { status: "working" });
      void runTurn(agentId, async (turn) => {
        for (const it of itemsOf(agentId)) {
          if (it.kind === "tool_call" && it.status === "in_progress")
            updateItem(agentId, it.id, { status: "completed" });
        }
        await pause(900, turn);
        const msg = addItem(agentId, { kind: "agent_message", text: "" });
        const reply =
          "Picking up where I left off. The chart palette now reads from the theme tokens, and the header toggle persists to `localStorage` while still respecting `prefers-color-scheme` by default.";
        await streamField(agentId, msg.id, "text", reply, turn);
        finishTurn(agentId, reply);
      });
    } else {
      patchAgent(agentId, { status: "idle" });
    }
  },

  async stopAgent(agentId) {
    const t = turns.get(agentId);
    if (t) t.cancelled = true;
    addItem(agentId, { kind: "notice", level: "info", text: "Shut down by you." });
    patchAgent(agentId, { status: "stopped", running: false, pendingPermissions: 0 });
    return delay(undefined);
  },

  async deleteAgent(agentId, removeWorktree, force) {
    const a = getAgent(agentId);
    if (removeWorktree && a.worktree && !force && UNSAVED_WORK[agentId]) {
      await sleep(300);
      throw new Error(`Unsaved work: ${UNSAVED_WORK[agentId]} Delete anyway to discard them.`);
    }
    const t = turns.get(agentId);
    if (t) t.cancelled = true;
    db.agents = db.agents.filter((a) => a.id !== agentId);
    delete db.items[agentId];
    emit({ type: "agent_removed", agentId });
    return delay(undefined);
  },

  async renameAgent(agentId, title) {
    patchAgent(agentId, { title });
    return delay(undefined, 40);
  },

  async archiveAgent(agentId, archived) {
    patchAgent(agentId, { archived });
    return delay(undefined, 40);
  },

  async acknowledgeAgent(agentId) {
    getAgent(agentId);
    patchAgent(agentId, { unread: false, acknowledgedAt: Date.now() });
    return delay(undefined, 40);
  },

  async markRead(agentId) {
    const a = db.agents.find((x) => x.id === agentId);
    if (a?.unread) patchAgent(agentId, { unread: false });
    return delay(undefined, 20);
  },

  async setAgentConfig(agentId, optionId, value) {
    const a = getAgent(agentId);
    const configOptions = a.configOptions.map((o) => (o.id === optionId ? { ...o, currentValue: value } : o));
    patchAgent(agentId, { configOptions });
    return delay(undefined, 80);
  },

  async handoffAgent(agentId, provider, accountId, instruction, customAgentId) {
    const src = getAgent(agentId);
    const agent = await mockApi.createAgent({
      provider,
      accountId,
      projectPath: src.projectPath,
      prompt: `${instruction}\n\n(Handed off from "${src.title}"; context summary attached.)`,
      title: `${src.title} · handoff`,
      worktree: src.worktree,
      model: null,
      groupId: null,
      customAgentId: provider === "custom" ? (customAgentId ?? null) : null,
      attachments: [],
    });
    return agent;
  },

  async switchAccount(agentId, accountId) {
    const a = getAgent(agentId);
    const acc = db.accounts.find((x) => x.id === accountId);
    if (!acc) throw new Error("Unknown account");
    if (acc.provider !== a.provider) throw new Error(`${acc.name} is not a ${a.provider} account`);
    if (!acc.status?.loggedIn) throw new Error(`${acc.name} is not signed in`);
    await sleep(700);
    const from = db.accounts.find((x) => x.id === a.accountId)?.name ?? "previous account";
    addItem(agentId, {
      kind: "notice",
      level: "info",
      text: `Moved from ${from} to ${acc.name}. The session continues with full history.`,
    });
    patchAgent(agentId, { accountId, rateLimited: false, status: "idle", running: true });
    return clone(getAgent(agentId));
  },

  async exportAgent(agentId) {
    const a = getAgent(agentId);
    // The real backend shows a native save dialog; the mock prompts instead.
    const name = `${a.title.replace(/[\\/:*?"<>|]+/g, "-").trim() || "conversation"}.md`;
    const path = window.prompt("Save conversation as (browser mock)", `/home/sam/Documents/${name}`)?.trim();
    if (!path) return null;
    await sleep(400);
    return path;
  },

  async listSchedules() {
    return delay(clone(db.schedules), 200);
  },

  async saveSchedule(schedule: Schedule) {
    await sleep(250);
    if (!schedule.name.trim()) throw new Error("Give the schedule a name.");
    if (!schedule.prompt.trim()) throw new Error("The prompt can't be empty.");
    if (!schedule.projectPath.trim()) throw new Error("Pick a project folder.");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time))
      throw new Error(`"${schedule.time}" isn't a valid time (HH:MM).`);
    if (schedule.days.some((d) => d < 0 || d > 6)) throw new Error("Days must be 0 (Sun) to 6 (Sat).");
    if (schedule.permissionMode !== null && !["auto", "ask"].includes(schedule.permissionMode)) {
      throw new Error(`Unknown permission mode “${schedule.permissionMode}”`);
    }
    const acc = db.accounts.find((x) => x.id === schedule.accountId);
    if (!acc || acc.provider !== schedule.provider) throw new Error("Choose an account for the selected provider.");
    const saved: Schedule = {
      ...schedule,
      id: schedule.id || newId("sch"),
      days: [...new Set(schedule.days)].sort(),
      updatedAt: Date.now(),
    };
    const i = db.schedules.findIndex((x) => x.id === saved.id);
    if (i >= 0) db.schedules[i] = saved;
    else db.schedules.push(saved);
    emit({ type: "schedule_updated", schedule: clone(saved) });
    return clone(saved);
  },

  async deleteSchedule(scheduleId) {
    db.schedules = db.schedules.filter((x) => x.id !== scheduleId);
    emit({ type: "schedule_removed", scheduleId });
    return delay(undefined, 150);
  },

  async runSchedule(scheduleId) {
    const sch = db.schedules.find((x) => x.id === scheduleId);
    if (!sch) throw new Error("Schedule not found");
    sch.lastRunAt = Date.now();
    emit({ type: "schedule_updated", schedule: clone(sch) });
    const agent = await mockApi.createAgent({
      provider: sch.provider,
      accountId: sch.accountId,
      projectPath: sch.projectPath,
      prompt: sch.prompt,
      title: sch.name,
      worktree: sch.worktree,
      model: null,
      groupId: null,
      customAgentId: sch.customAgentId,
      attachments: [],
      permissionMode: sch.permissionMode,
    });
    const a = getAgent(agent.id);
    a.scheduleId = sch.id;
    emit({ type: "agent_updated", agent: clone(a) });
    sch.lastAgentId = agent.id;
    emit({ type: "schedule_updated", schedule: clone(sch) });
    return clone(a);
  },

  async setFocus() {
    return undefined;
  },

  async chimeWatched() {
    return undefined;
  },

  async setWindowTitle(title) {
    if (typeof document !== "undefined") document.title = title;
  },

  async getDiff(agentId) {
    return delay(withoutReverted(seedDiff(itemsOf(agentId)), revertedPatches.get(agentId) ?? []), 400);
  },

  async listCheckpoints(agentId) {
    const agent = getAgent(agentId);
    const extra = mockSafety.get(agentId) ?? [];
    const turns: Checkpoint[] = itemsOf(agentId)
      .filter((it) => it.kind === "user_message")
      .map((it, i) => ({ id: `ck-${it.id}`, agentId, seq: i + 1, itemId: it.id, createdAt: it.ts, kind: "turn" }));
    return delay({ available: agent.worktree, checkpoints: [...turns, ...extra] }, 150);
  },

  async previewCheckpoint(agentId, checkpointId) {
    getAgent(agentId);
    if (!checkpointId) throw new Error("That checkpoint no longer exists");
    const files: RestorePreview["files"] = [
      { path: "src/lib/session.ts", status: "modified", additions: 4, deletions: 31 },
      { path: "src/lib/session.test.ts", status: "deleted", additions: 0, deletions: 58 },
      { path: "README.md", status: "added", additions: 12, deletions: 0 },
    ];
    return delay(
      {
        files,
        totalFiles: files.length,
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
      },
      250,
    );
  },

  async restoreCheckpoint(agentId, checkpointId) {
    const a = getAgent(agentId);
    assertIdle(a, "restoring its files");
    await gitLock(agentId, 500);
    const list = mockSafety.get(agentId) ?? [];
    const safety: Checkpoint = {
      id: `ck-safety-${list.length + 1}-${checkpointId}`,
      agentId,
      seq: 1000 + list.length,
      itemId: null,
      createdAt: Date.now(),
      kind: "safety",
    };
    mockSafety.set(agentId, [...list, safety]);
    return { safetyId: safety.id, filesChanged: 3 };
  },

  async commitAgent(agentId, message) {
    const a = getAgent(agentId);
    assertIdle(a, "committing");
    await gitLock(agentId, 600);
    const files = seedDiff(itemsOf(agentId)).files.map((f) => f.path);
    if (files.length === 0) throw new Error("Nothing to commit: the worktree is clean.");
    const committed = files.slice(0, Math.max(1, files.length - 1));
    const left = files.length - committed.length;
    const summary: CommitSummary = {
      hash: "3f9a1c2",
      files: committed,
      leftUncommitted: left,
      skipped: [],
      message:
        `Committed ${committed.length} file${committed.length === 1 ? "" : "s"} (3f9a1c2)` +
        (left ? `; ${left} other changed file${left === 1 ? " was" : "s were"} left uncommitted` : "") +
        ".",
    };
    addItem(agentId, { kind: "notice", level: "info", text: `${summary.message} “${message.trim() || a.title}”` });
    return summary;
  },

  async revertPatch(agentId, patch) {
    assertIdle(getAgent(agentId), "reverting");
    await gitLock(agentId, 500);
    if (!/^diff --git |^--- /m.test(patch) || !/^@@ /m.test(patch))
      throw new Error("Invalid patch: missing file header or hunk.");
    if (/STALE/.test(patch)) throw new Error("The change couldn't be reverted (the file has changed since).");
    const file = /^\+\+\+ b\/(.+)$/m.exec(patch)?.[1] ?? "file";
    const hunks = (patch.match(/^@@ /gm) ?? []).length;
    revertedPatches.set(agentId, [...(revertedPatches.get(agentId) ?? []), patch]);
    addItem(agentId, {
      kind: "notice",
      level: "info",
      text: `Reverted ${hunks === 1 ? "a change" : `${hunks} changes`} in ${file}.`,
    });
  },

  async shipAgent(agentId, message): Promise<ShipResult> {
    const a = getAgent(agentId);
    if (!a.worktree) throw new Error("Only worktree agents can be merged. Commit from your own branch instead.");
    assertIdle(a, "merging");
    await gitLock(agentId, 900);
    const msg = message.trim() || a.title;
    // The billing agent's branch conflicts with main: the commit lands, the merge fails.
    if (agentId === "a-billing") {
      addItem(agentId, { kind: "notice", level: "warn", text: `Committed “${msg}” (3f9a1c2); the merge failed.` });
      return {
        committed: "3f9a1c2",
        merged: null,
        error: `Committed 3f9a1c2 on ${a.branch}, but the merge failed: CONFLICT (content): Merge conflict in prisma/schema.prisma`,
      };
    }
    addItem(agentId, {
      kind: "notice",
      level: "info",
      text: `Committed “${msg}” and merged ${a.branch ?? "branch"} into ${a.baseBranch ?? "main"}.`,
    });
    return { committed: "3f9a1c2", merged: "8b04de1", error: null };
  },

  async mergeAgent(agentId) {
    const a = getAgent(agentId);
    assertIdle(a, "merging");
    await gitLock(agentId, 700);
    return `Merged ${a.branch ?? "branch"} into ${a.baseBranch ?? "main"} (fast-forward).`;
  },

  async createPr(agentId) {
    const a = getAgent(agentId);
    if (!a.worktree) throw new Error("Pull requests need a worktree agent with its own branch.");
    await sleep(900);
    if (agentId === "a-e2e") return "A pull request already exists: https://github.com/acme/storefront/pull/77";
    return "https://github.com/acme/atlas-api/pull/128";
  },

  async prStatus(agentId) {
    const a = getAgent(agentId);
    const base = { reason: null, fetchedAt: Date.now() } as const;
    if (!a.branch) return delay<PrStatus>({ ...base, state: "none", pr: null });
    const mk = (n: number, state: PrInfo["state"], checks: PrCheck[], review: PrInfo["review"]): PrStatus => {
      const count = (s: string) => checks.filter((c) => c.status === s).length;
      const failing = count("failing");
      const pending = count("pending");
      return {
        ...base,
        state: "ok",
        pr: {
          number: n,
          url: `https://github.com/acme/${a.projectPath.split("/").pop()}/pull/${n}`,
          title: a.title,
          state,
          review,
          mergeable: "mergeable",
          checks,
          summary: {
            passing: count("passing"),
            failing,
            pending,
            overall: failing ? "failing" : pending ? "pending" : checks.length ? "passing" : "none",
          },
        },
      };
    };
    const c = (name: string, status: PrCheck["status"], d: number | null): PrCheck => ({
      name,
      workflow: "CI",
      status,
      url: "https://github.com/acme/atlas-api/actions/runs/1/job/2",
      runId: "1",
      durationSecs: d,
    });
    if (agentId === "a-token")
      return delay(
        mk(
          128,
          "open",
          [
            c("lint", "passing", 41),
            c("test (ubuntu)", "failing", 212),
            c("test (macos)", "failing", 305),
            c("build", "passing", 97),
          ],
          "changes_requested",
        ),
      );
    if (agentId === "a-e2e") return delay(mk(77, "open", [c("e2e", "pending", null), c("lint", "passing", 38)], null));
    if (agentId === "a-ratelimit") return delay(mk(64, "draft", [c("test", "passing", 120)], null));
    return delay<PrStatus>({ ...base, state: "none", pr: null });
  },

  async prFixCiPrompt(agentId) {
    const s = await mockApi.prStatus(agentId);
    const failing = s.pr?.checks.filter((x) => x.status === "failing") ?? [];
    if (!s.pr || failing.length === 0) throw new Error("No checks are failing.");
    return `CI is failing on PR #${s.pr.number}. Fix it.\n\nFailing checks:\n${failing.map((x) => `- CI / ${x.name} (${x.url})`).join("\n")}\n\nLogs:\n\`\`\`\n--- ${failing[0].name} ---\nerror[E0432]: unresolved import \`crate::auth::refresh\`\n --> src/session.rs:12:5\n##[error]Process completed with exit code 101.\n\`\`\`\n`;
  },

  async prReviewPrompt(agentId) {
    const s = await mockApi.prStatus(agentId);
    if (!s.pr) throw new Error("This branch has no pull request.");
    return `Reviewers left feedback on PR #${s.pr.number}. Address it: make the requested changes (or explain briefly why not).\n\nReviews requesting changes:\n- maria requested changes: Please add a regression test for the refresh race.\n\nInline comments:\n- src/session.rs:42 (maria): This lock is held across the await; use a scoped guard.\n`;
  },

  async discardWorktree(agentId) {
    patchAgent(agentId, { worktree: false, branch: null, cwd: getAgent(agentId).projectPath });
    return delay(undefined, 500);
  },

  async createAccount(req) {
    const acc: Account = {
      id: newId("acc"),
      provider: req.provider,
      name: req.name,
      color: req.color,
      authKind: req.authKind,
      isSystem: false,
      configDir: `~/.local/share/armada/profiles/${req.name.toLowerCase().replace(/\W+/g, "-")}`,
      createdAt: Date.now(),
      status:
        req.authKind === "api_key"
          ? { loggedIn: true, label: "API key", email: null, plan: "Pay as you go", checkedAt: Date.now(), error: null }
          : { loggedIn: false, label: null, email: null, plan: null, checkedAt: Date.now(), error: null },
      usage: null,
    };
    db.accounts.push(acc);
    emit({ type: "account_updated", account: clone(acc) });
    return delay(clone(acc), 200);
  },

  async updateAccountKey(accountId, apiKey) {
    const acc = db.accounts.find((a) => a.id === accountId);
    if (!acc) throw new Error("Unknown account");
    if (acc.authKind !== "api_key") throw new Error("Only API-key accounts have a key to replace.");
    const key = apiKey.trim();
    if (key.length < 20) throw new Error("That doesn't look like a valid API key (too short).");
    await sleep(600);
    acc.status = {
      loggedIn: true,
      label: acc.status?.label ?? "API key",
      email: null,
      plan: acc.status?.plan ?? "Pay as you go",
      checkedAt: Date.now(),
      error: null,
    };
    emit({ type: "account_updated", account: clone(acc) });
    return clone(acc);
  },

  async updateAccount(accountId, name, color) {
    const acc = db.accounts.find((a) => a.id === accountId);
    if (!acc) throw new Error("Unknown account");
    Object.assign(acc, { name, color });
    emit({ type: "account_updated", account: clone(acc) });
    return delay(clone(acc), 80);
  },

  async deleteAccount(accountId) {
    const archived = db.agents.filter((a) => a.accountId === accountId && a.archived).length;
    if (archived > 0) {
      throw new Error(
        `${archived} archived agent${archived === 1 ? " still uses" : "s still use"} this account; delete ${archived === 1 ? "it" : "them"} first.`,
      );
    }
    const scheds = db.schedules.filter((s) => s.accountId === accountId).map((s) => `“${s.name}”`);
    if (scheds.length)
      throw new Error(
        `Used by schedule${scheds.length === 1 ? "" : "s"} ${scheds.join(", ")}; change or delete ${scheds.length === 1 ? "it" : "them"} first.`,
      );
    db.accounts = db.accounts.filter((a) => a.id !== accountId);
    emit({ type: "account_removed", accountId });
    return delay(undefined);
  },

  async checkAccount(accountId) {
    const acc = db.accounts.find((a) => a.id === accountId);
    if (!acc) throw new Error("Unknown account");
    await sleep(900);
    acc.status = acc.status ? { ...acc.status, checkedAt: Date.now() } : null;
    emit({ type: "account_updated", account: clone(acc) });
    return clone(acc);
  },

  async loginAccount(accountId) {
    if (db.accounts.find((a) => a.id === accountId)?.provider === "custom") {
      throw new Error("Custom agents don't need a sign-in.");
    }
    // Like the core: a login already running for this account is reused (its output isn't replayed).
    for (const existing of terminals.values()) {
      if (existing.kind === "login" && existing.accountId === accountId && !existing.done) {
        return delay({ terminalId: existing.id, reused: true }, 40);
      }
    }
    const t: MockTerminal = { id: newId("term"), kind: "login", accountId, buffer: "", stage: 0, done: false };
    terminals.set(t.id, t);
    void runLogin(t);
    return delay({ terminalId: t.id, reused: false }, 80);
  },

  async detectProviders(): Promise<ProviderInfo[]> {
    await sleep(800);
    emit({ type: "providers_changed", providers: clone(db.providers) });
    return clone(db.providers);
  },

  async installProvider(provider) {
    const t: MockTerminal = { id: newId("term"), kind: "install", provider, buffer: "", stage: 0, done: false };
    terminals.set(t.id, t);
    void runInstall(t);
    return delay(t.id, 80);
  },

  async installMissing() {
    const t: MockTerminal = { id: newId("term"), kind: "install", buffer: "", stage: 0, done: false };
    terminals.set(t.id, t);
    void runInstallMissing(t);
    return delay(t.id, 80);
  },

  async terminalWrite(terminalId, data) {
    if (data.length > 65_536) throw new Error("That's too much input at once (over 64 KB).");
    const t = terminals.get(terminalId);
    if (!t || t.done) return;
    if (t.shell) {
      t.buffer = (t.buffer + data).replace(/\r/g, "\r\n");
      termOut(t.id, data.replace(/\r/g, "\r\n"));
      return;
    }
    if (t.kind === "login" && t.stage === 1) {
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          void finishLogin(t);
          return;
        }
        if (ch === "\x7f") {
          if (t.buffer.length) {
            t.buffer = t.buffer.slice(0, -1);
            termOut(t.id, "\b \b");
          }
        } else if (ch === "\x03") {
          termOut(t.id, "^C\r\n");
          void termExit(t, 130);
          return;
        } else if (ch >= " ") {
          t.buffer += ch;
          termOut(t.id, "*");
        }
      }
    }
  },

  async workspaceTerminalOpen(agentId, scriptId) {
    const agent = db.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error("Agent not found");
    const t: MockTerminal = { id: newId("term"), kind: "install", buffer: "", stage: 0, done: false, shell: true };
    terminals.set(t.id, t);
    const prompt = `${C.green}${agent.cwd.split("/").filter(Boolean).pop() ?? "~"}${C.reset} $ `;
    const script = scriptId ? MOCK_SCRIPTS.find((x) => x.id === scriptId) : undefined;
    setTimeout(() => {
      if (script) {
        termOut(t.id, `${prompt}${script.command}\r\n${C.dim}(mock) running…${C.reset}\r\nDone.\r\n`);
        void termExit(t, 0);
      } else {
        termOut(t.id, `${C.dim}Mock shell (browser preview)${C.reset}\r\n${prompt}`);
      }
    }, 200);
    return delay(t.id, 60);
  },

  async probePorts(ports) {
    return delay(ports, 40);
  },

  async workspaceScripts() {
    return delay(clone(MOCK_SCRIPTS), 80);
  },

  async terminalResize() {
    return undefined;
  },

  async terminalKill(terminalId) {
    const t = terminals.get(terminalId);
    if (t && !t.done) void termExit(t, 143);
  },

  async updateSettings(settings: Settings) {
    const invalid = validateSettings(settings);
    if (invalid) {
      await sleep(150);
      throw new Error(invalid);
    }
    const prevRemote = db.settings.remote;
    db.settings = clone(settings);
    const r = settings.remote;
    if (r.enabled !== prevRemote.enabled || r.lan !== prevRemote.lan || r.port !== prevRemote.port) {
      await sleep(500);
      if (r.port < 1024 || r.port > 65535) {
        remote.error = `Port ${r.port} is out of range (1024–65535).`;
      } else if (r.port === 3000) {
        remote.error = "Port 3000 is already in use. Pick another port.";
      } else {
        remote.error = null;
      }
    }
    return delay(clone(db.settings), 60);
  },

  async setInterfaceZoom(percent) {
    (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = String(percent / 100);
  },

  async previewSound(reason) {
    playTone(reason);
  },

  async testNotification(ntfyUrl) {
    const url = ntfyUrl ?? db.settings.ntfyUrl;
    emit({
      type: "attention",
      agentId: db.agents[0]?.id ?? "",
      reason: "done",
      title: "Armada test notification",
      body: "Notifications are working. You'll hear from us when an agent needs you.",
      requestId: null,
    });
    if (url) {
      await sleep(700);
      const problem = ntfyProblem(url);
      if (problem) throw new Error(`The notification was shown, but the phone push failed: ${problem}`);
    }
  },

  async openPath(path) {
    if (/^https?:\/\//.test(path)) window.open(path, "_blank", "noopener");
    else console.info("[mock] open path", path);
  },

  async readClipboardImages() {
    return { attachments: [], problems: [] };
  },

  async readImage(agentId, path) {
    getAgent(agentId);
    await sleep(rand(250, 600));
    if (!/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(path)) throw new Error(`${path} is not an image file`);
    if (/missing|deleted/i.test(path)) throw new Error(`No such file: ${path}`);
    if (/^\/tmp\//.test(path) && !JSON.stringify(itemsOf(agentId)).includes(path)) {
      throw new Error(`${path} is in a temporary folder and this agent's conversation doesn't mention it.`);
    }
    const name = path.split(/[\\/]/).pop() ?? path;
    return mockScreenshot(name, path);
  },

  async testMcpServer(server) {
    await sleep(rand(700, 1300));
    if (server.transport === "http") {
      if (!/^https?:\/\//.test(server.url)) throw new Error("URL must start with http:// or https://");
      if (/localhost:9/.test(server.url)) throw new Error(`connect ECONNREFUSED ${server.url}`);
      return `${server.name || "server"} · 18 tools (HTTP, MCP 2025-06-18)`;
    }
    const cmd = server.command.trim();
    if (!cmd) throw new Error("Command is empty.");
    if (!["npx", "uvx", "node", "python", "docker", "bunx"].includes(cmd)) {
      throw new Error(`spawn ${cmd}: No such file or directory (os error 2)`);
    }
    const pkg = server.args.find((a) => !a.startsWith("-")) ?? server.name;
    return `${pkg.split("/").pop()} 1.2.0 · ${8 + (pkg.length % 9)} tools`;
  },

  async isGitRepo(path) {
    await sleep(120);
    const p = path
      .trim()
      .replace(/^~(?=\/|$)/, "/home/sam")
      .replace(/\/+$/, "");
    return MOCK_PROJECTS.some((r) => p === r || p.startsWith(`${r}/`));
  },

  async discoverProjects() {
    await sleep(500);
    return [...MOCK_PROJECTS];
  },

  async listFiles(agentId, query) {
    getAgent(agentId);
    const q = query.toLowerCase().replace(/^@/, "");
    const score = (p: string) => {
      const l = p.toLowerCase();
      if (!q) return 1;
      const base = l.slice(l.lastIndexOf("/") + 1);
      if (base.startsWith(q)) return 3;
      if (l.includes(q)) return 2;
      // subsequence match
      let i = 0;
      for (const ch of l) if (ch === q[i]) i++;
      return i === q.length ? 1 : 0;
    };
    const hits = MOCK_FILES.map((p) => [p, score(p)] as const)
      .filter(([, sc]) => sc > 0)
      .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
      .slice(0, 50)
      .map(([p]) => p);
    return delay(hits, 90);
  },

  async testCustomAgent(agent) {
    await sleep(1100);
    const known: Record<string, string> = {
      gemini: "Gemini CLI 0.52.0 (ACP v1)",
      goose: "Goose 1.14.2 (ACP v1)",
      opencode: "OpenCode 0.15.8 (ACP v1)",
    };
    const v = known[agent.command.trim()];
    if (!agent.command.trim()) throw new Error("Command is empty.");
    if (!v) throw new Error(`spawn ${agent.command.trim()}: No such file or directory (os error 2)`);
    if (agent.command.trim() === "gemini" && !agent.args.includes("--acp")) {
      throw new Error("gemini exited before the ACP handshake (code 1):\nUnknown mode. Did you mean --acp?");
    }
    return v;
  },

  async remoteStatus() {
    return delay(remoteStatus(), 150);
  },

  async remoteRotateToken() {
    remote.token = randomToken();
    return delay(remoteStatus(), 300);
  },

  async createShareLink(agentId) {
    const a = getAgent(agentId);
    if (!db.settings.remote.enabled) throw new Error("Turn on remote access to create share links.");
    const token = randomToken().slice(0, 16);
    const link = {
      token,
      agentId,
      agentTitle: a.title,
      url: `${baseUrl()}/share/${token}`,
      createdAt: Date.now(),
    };
    remote.shares.push(link);
    return delay(clone(link), 250);
  },

  async revokeShareLink(token) {
    remote.shares = remote.shares.filter((x) => x.token !== token);
    return delay(undefined, 150);
  },

  async checkForUpdate() {
    await sleep(900);
    return MOCK_UPDATE;
  },

  // ---- voice dictation (simulated: no microphone, canned transcript)
  async voiceStatus() {
    const v = db.settings.voice;
    return {
      models: MOCK_VOICE_MODELS.map((m) => ({ ...m, installed: mockVoice.installed.has(m.id) })),
      languages: MOCK_VOICE_LANGUAGES,
      maxRecordingSecs: 300,
      model: v.model,
      ready: mockVoice.installed.has(v.model),
      downloading: mockVoice.downloading,
    };
  },

  async voiceListDevices() {
    await sleep(80);
    return [
      { name: "Built-in Microphone", isDefault: true },
      { name: "USB Headset", isDefault: false },
    ];
  },

  async voiceDownloadModel(id) {
    const m = MOCK_VOICE_MODELS.find((x) => x.id === id);
    if (!m) throw new Error(`Unknown dictation model “${id}”`);
    if (mockVoice.downloading) throw new Error("A model is already downloading");
    mockVoice.downloading = id;
    mockVoice.cancel = false;
    let done = 0;
    try {
      while (done < m.sizeBytes) {
        await sleep(120);
        if (mockVoice.cancel) {
          emitVoiceBus("voice-download", { id, done: 0, total: m.sizeBytes, state: "cancelled", error: null });
          throw new Error("Download cancelled");
        }
        done = Math.min(m.sizeBytes, done + Math.round(m.sizeBytes / 30));
        emitVoiceBus("voice-download", { id, done, total: m.sizeBytes, state: "progress", error: null });
      }
      mockVoice.installed.add(id);
      emitVoiceBus("voice-download", { id, done, total: m.sizeBytes, state: "done", error: null });
    } finally {
      mockVoice.downloading = null;
    }
  },

  async voiceCancelDownload() {
    mockVoice.cancel = true;
  },

  async voiceDeleteModel(id) {
    mockVoice.installed.delete(id);
  },

  async voiceStart() {
    await sleep(120);
    if (mockVoice.timer) clearInterval(mockVoice.timer);
    const t0 = Date.now();
    mockVoice.timer = setInterval(() => {
      emitVoiceBus("voice-level", { level: Math.random() * 0.8, elapsedMs: Date.now() - t0 });
    }, 80);
  },

  async voiceStop() {
    if (mockVoice.timer) clearInterval(mockVoice.timer);
    mockVoice.timer = null;
    await sleep(900);
    return { text: "Please add tests for the retry logic and run them.", autoSend: db.settings.voice.autoSend };
  },

  async voiceCancel() {
    if (mockVoice.timer) clearInterval(mockVoice.timer);
    mockVoice.timer = null;
  },

  async installUpdate() {
    const total = 14_200_000;
    let downloaded = 0;
    while (downloaded < total) {
      await sleep(rand(120, 260));
      downloaded = Math.min(total, downloaded + Math.round(rand(500_000, 1_400_000)));
      emit({ type: "update_progress", downloaded, total });
    }
    await sleep(600);
    // A real install restarts the app; the mock just reloads.
    location.reload();
  },
};

const MOCK_UPDATE: UpdateInfo = {
  currentVersion: "0.1.0-mock",
  version: "0.2.0",
  date: new Date(Date.now() - 86_400_000).toISOString(),
  url: "https://github.com/pl0xuee/armada/releases/tag/v0.2.0",
  canInstall: true,
  notes:
    "## Highlights\n\n- **One-click installer**: Armada installs missing agents for you, no admin rights needed.\n- **Inbox** keyboard flow is faster: `A` / `D` now advance automatically.\n- Mission Control tiles stream the latest action live.\n\n## Fixes\n\n- Resuming an interrupted Codex agent no longer replays the last tool call.\n- The context meter is accurate for 1M-token sessions.",
};

// Announce the update shortly after boot, like the backend's auto-check.
setTimeout(() => {
  if (db.settings.autoCheckUpdates) emit({ type: "update_available", update: MOCK_UPDATE });
}, 9000);

// ---------------------------------------------------------------- remote control

const MOCK_FILES = [
  "src/auth/session.ts",
  "src/auth/store.ts",
  "src/auth/errors.ts",
  "src/http/client.ts",
  "src/http/retry.ts",
  "src/billing/stripe.ts",
  "src/billing/refunds.ts",
  "src/webhooks/stripe.ts",
  "src/middleware/rateLimit.ts",
  "src/lib/redis.ts",
  "src/lib/retry.ts",
  "src/server.ts",
  "src/index.ts",
  "test/auth.test.ts",
  "test/http/client.test.ts",
  "prisma/schema.prisma",
  "package.json",
  "tsconfig.json",
  "README.md",
  "docs/architecture.md",
];

function randomToken(): string {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

const remote = {
  token: randomToken(),
  error: null as string | null,
  shares: [] as { token: string; agentId: string; agentTitle: string | null; url: string | null; createdAt: number }[],
};

function baseUrl(): string {
  const r = db.settings.remote;
  return `http://${r.lan ? "192.168.1.42" : "127.0.0.1"}:${r.port}`;
}

/** Deterministic QR-looking SVG (placeholder; the backend returns a real QR code). */
function fakeQrSvg(seed: string): string {
  const n = 29;
  let h = 2166136261;
  const rnd = () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return (h >>> 0) / 4294967296;
  };
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const cells: string[] = [];
  const finder = (x: number, y: number) =>
    `<rect x="${x}" y="${y}" width="7" height="7" fill="#000"/><rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="#fff"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3" fill="#000"/>`;
  const inFinder = (x: number, y: number) => (x < 8 && y < 8) || (x >= n - 8 && y < 8) || (x < 8 && y >= n - 8);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (!inFinder(x, y) && rnd() > 0.52) cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><g fill="#000">${cells.join("")}</g>${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}</svg>`;
}

function remoteStatus() {
  const r = db.settings.remote;
  const running = r.enabled && remote.error === null;
  const url = running ? baseUrl() : null;
  const pairingUrl = running ? `${url}/pair#${remote.token}` : null;
  return clone({
    enabled: r.enabled,
    running,
    lan: r.lan,
    port: r.port,
    url,
    pairingUrl,
    qrSvg: pairingUrl ? fakeQrSvg(pairingUrl) : null,
    error: r.enabled ? remote.error : null,
    shares: remote.shares,
  });
}

// ---------------------------------------------------------------- stress mode (?stress)

let stressStarted = false;

function setupStress() {
  if (stressStarted) return;
  stressStarted = true;
  const base = db.agents[0];
  for (const a of stressAgents(base)) {
    db.agents.unshift(a);
    db.items[a.id] = stressItems(a.id);
  }
  setTimeout(() => {
    let tick = 0;
    const current = new Map<string, string>();
    setInterval(() => {
      tick++;
      for (let i = 1; i <= STRESS_AGENTS; i++) {
        const id = `stress-${i}`;
        let itemId = current.get(id);
        const list = itemsOf(id);
        const cur = itemId ? list.find((x) => x.id === itemId) : undefined;
        // Start a new streaming message every ~400 deltas (keeps the timeline growing too).
        if (!cur || (cur.kind === "agent_message" && cur.text.length > 2400)) {
          if (cur) updateItem(id, cur.id, {});
          addItem(id, {
            kind: "tool_call",
            toolCallId: newId("stc"),
            title: `Edit src/stress/file${tick % 50}.ts`,
            toolKind: "edit",
            status: "completed",
            locations: [`src/stress/file${tick % 50}.ts`],
            diffs: [],
            output: "",
            command: null,
          });
          itemId = addItem(id, { kind: "agent_message", text: "" }).id;
          current.set(id, itemId);
        }
        if (itemId) appendDelta(id, itemId, "text", stressWords(1 + (tick % 3), tick + i));
      }
    }, STRESS_TICK_MS);
  }, 1500);
}

// ---------------------------------------------------------------- revert_patch (mock)

const revertedPatches = new Map<string, string[]>();

/** Drop reverted hunks/files from the mock diff so the UI sees the change disappear. */
function withoutReverted(diff: AgentDiff, reverted: string[]): AgentDiff {
  if (reverted.length === 0) return diff;
  let patch = diff.patch;
  for (const r of reverted) {
    const header = r.slice(0, r.indexOf("\n@@") + 1);
    const hunks = r
      .slice(header.length)
      .split(/(?=^@@ )/m)
      .filter(Boolean);
    for (const h of hunks) patch = patch.replace(h, "");
    // A file with no hunks left disappears entirely.
    if (!patch.slice(patch.indexOf(header) + header.length).startsWith("@@")) patch = patch.replace(header, "");
  }
  const files = diff.files.filter((f) => patch.includes(`b/${f.path}`));
  return { ...diff, patch, files, uncommitted: Math.min(diff.uncommitted, files.length) };
}

// ---------------------------------------------------------------- git busy/lock & validation (mock)

const gitBusy = new Set<string>();

const mockSafety = new Map<string, Checkpoint[]>();

function assertIdle(a: Agent, what: string) {
  if (a.status === "working" || a.status === "needs_permission" || a.status === "starting") {
    throw new Error(`The agent is still working; stop it or wait before ${what} changes.`);
  }
}

async function gitLock(agentId: string, ms: number) {
  if (gitBusy.has(agentId)) {
    throw new Error("Armada is already committing, merging or reverting this agent's work; wait for it to finish.");
  }
  gitBusy.add(agentId);
  try {
    await sleep(ms);
  } finally {
    gitBusy.delete(agentId);
  }
}

const UNSAVED_WORK: Record<string, string> = {
  "a-e2e": "1 uncommitted change in the worktree and 2 commits on armada/e2e-checkout that no other branch contains.",
  "a-billing": "3 uncommitted changes in the worktree.",
};

function ntfyProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "that isn't a valid URL";
  }
  if (u.username || u.password) return "remove the user:password part (use an access token instead)";
  const lan = /^(localhost|127\.|10\.|192\.168\.|100\.|[^.]+\.ts\.net$|[^.]+$)/.test(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && lan))
    return "use https:// (http is only allowed for LAN or Tailscale hosts)";
  if (u.pathname.replace(/\//g, "") === "") return "include a topic, like https://ntfy.sh/my-topic";
  if (/fail/.test(u.pathname)) return "ntfy.sh answered 403 Forbidden";
  return null;
}

const MOCK_VOICE_MODELS = [
  {
    id: "tiny.en",
    label: "Tiny (English)",
    description: "Fastest, least accurate",
    sizeBytes: 77_704_715,
    multilingual: false,
    isDefault: false,
  },
  {
    id: "base.en",
    label: "Base (English)",
    description: "Good balance of speed and accuracy",
    sizeBytes: 147_964_211,
    multilingual: false,
    isDefault: true,
  },
  {
    id: "small.en",
    label: "Small (English)",
    description: "More accurate, slower",
    sizeBytes: 487_614_201,
    multilingual: false,
    isDefault: false,
  },
  {
    id: "small",
    label: "Small (multilingual)",
    description: "Understands about 99 languages",
    sizeBytes: 487_601_967,
    multilingual: true,
    isDefault: false,
  },
];
const MOCK_VOICE_LANGUAGES: [string, string][] = [
  ["en", "English"],
  ["fr", "French"],
  ["de", "German"],
  ["es", "Spanish"],
  ["ja", "Japanese"],
];
const mockVoice = {
  installed: new Set<string>(),
  downloading: null as string | null,
  cancel: false,
  timer: null as ReturnType<typeof setInterval> | null,
};

function validateSettings(s: Settings): string | null {
  if (!["off", "ask", "auto"].includes(s.failover)) return `Unknown failover setting “${s.failover}”`;
  if (!["auto", "ask"].includes(s.defaultPermissionMode)) return `Unknown permission mode “${s.defaultPermissionMode}”`;
  if (!Number.isInteger(s.remote.port) || s.remote.port < 1 || s.remote.port > 65535) {
    return "The remote control port must be between 1 and 65535";
  }
  const vm = MOCK_VOICE_MODELS.find((m) => m.id === s.voice.model);
  if (!vm) return `Unknown dictation model “${s.voice.model}”`;
  if (!vm.multilingual && s.voice.language !== "auto" && s.voice.language !== "en") {
    return `The ${vm.label} model only understands English; pick a multilingual model for other languages`;
  }
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const t of [s.quietHours.start, s.quietHours.end]) {
    if (!hhmm.test(t)) return `Quiet hours must be times like 22:00 (00:00 to 23:59), not “${t}”`;
  }
  if (s.ntfyUrl) {
    const p = ntfyProblem(s.ntfyUrl);
    if (p && !/403/.test(p)) return `Phone push URL: ${p}`;
  }
  return null;
}
