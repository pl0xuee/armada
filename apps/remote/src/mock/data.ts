/** Realistic sample fleet for the dev mock. Dev-only; never bundled in production. */
import type { Agent, AgentStatus, FileDiff, RemoteAccount, RemoteCustomAgent, TimelineItem } from "@/lib/types";
import { CHECKOUT_PNG, ORDERS_PNG } from "./images";

const MIN = 60_000;

export const accounts: RemoteAccount[] = [
  { id: "acc-work", name: "Work", provider: "claude", color: "#4FC3F7", label: "Claude Max" },
  { id: "acc-personal", name: "Personal", provider: "claude", color: "#F472B6", label: "Claude Pro" },
  { id: "acc-openai", name: "ChatGPT", provider: "codex", color: "#3DDC97", label: "ChatGPT Pro" },
  { id: "acc-grok", name: "xAI", provider: "grok", color: "#E5E7EB", label: "SuperGrok", loggedIn: false, error: null },
  { id: "custom-gemini", name: "Local agents", provider: "custom", color: "#B39DDB", label: null },
];

export const customAgents: RemoteCustomAgent[] = [
  { id: "gemini", name: "Gemini CLI", color: "#8AB4F8", enabled: true },
  { id: "goose", name: "Goose", color: "#F5B544", enabled: true },
  { id: "opencode", name: "OpenCode", color: "#3DDC97", enabled: false },
];

export const projects = [
  "/home/dev/code/acme-web",
  "/home/dev/code/acme-api",
  "/home/dev/code/docs",
  "/home/dev/code/research",
  "/home/dev/code/infra",
  "/home/dev/code/mobile-app",
  "/home/dev/code/design-system",
];

export const templates = [
  { id: "t-review", name: "Review PR", text: "Review the open changes on this branch. Flag bugs, risky changes and missing tests." },
  { id: "t-tests", name: "Write tests", text: "Add tests for the code you just changed and make sure the suite passes." },
  { id: "t-fix-ci", name: "Fix CI", text: "CI is failing on main. Find the cause and fix it with the smallest change." },
  // Parity: templates with {{placeholders}} open the fill-in form in the composer.
  { id: "t-explain", name: "Explain a file", text: "Explain what {{target_file}} does and how it fits into {{area}}. Keep it short and point at the key functions." },
  { id: "t-refactor", name: "Refactor", text: "Refactor {{target}} without changing behaviour. Keep the public API and make sure the tests still pass." },
];

type Choice = [value: string, name: string, description?: string];
function option(id: string, name: string, category: string, current: string, choices: Choice[]) {
  return {
    id,
    name,
    category,
    currentValue: current,
    options: choices.map(([value, n, description]) => ({ value, name: n, description: description ?? null })),
  };
}

/** What each provider typically advertises (ids differ per provider, as in reality). */
export function providerConfig(provider: Agent["provider"], modelValue?: string) {
  switch (provider) {
    case "claude":
      return [
        option("mode", "Mode", "mode", "default", [
          ["default", "Default", "Ask before edits and commands"],
          ["acceptEdits", "Accept edits", "Edit files without asking"],
          ["plan", "Plan", "Read and plan only, no changes"],
          ["bypassPermissions", "Bypass permissions", "Never ask (use with care)"],
        ]),
        option("model", "Model", "model", modelValue ?? "claude-opus", [
          ["claude-opus", "Opus", "Most capable"],
          ["claude-sonnet", "Sonnet", "Fast and capable"],
          ["claude-haiku", "Haiku", "Fastest"],
        ]),
      ];
    case "codex":
      return [
        option("approval_preset", "Approvals", "mode", "auto", [
          ["read-only", "Read only", "Ask before any change"],
          ["auto", "Auto", "Edit in the workspace, ask for network and outside access"],
          ["full-access", "Full access", "No prompts"],
        ]),
        option("model", "Model", "model", modelValue ?? "gpt-5-codex", [
          ["gpt-5-codex", "GPT-5 Codex"],
          ["gpt-5", "GPT-5"],
        ]),
        option("reasoning_effort", "Effort", "thought_level", "medium", [
          ["low", "Low"],
          ["medium", "Medium"],
          ["high", "High"],
        ]),
      ];
    case "grok":
      return [option("model", "Model", "model", "grok-code-fast", [["grok-code-fast", "Grok Code Fast"], ["grok-4", "Grok 4"]])];
    default:
      return [option("mode", "Mode", "mode", "default", [["default", "Default"], ["yolo", "Auto-approve"]])];
  }
}

export const slashCommands = [
  { name: "compact", description: "Summarize the conversation to free up context", hint: null },
  { name: "review", description: "Review the current changes", hint: "[focus]" },
  { name: "init", description: "Create an AGENTS.md / CLAUDE.md for this project", hint: null },
  { name: "clear", description: "Start a fresh conversation", hint: null },
  { name: "cost", description: "Show usage for this session", hint: null },
  { name: "remote-control", description: "Continue this session from claude.ai/code or the Claude mobile app", hint: null },
];

function agent(
  now: number,
  id: string,
  title: string,
  provider: Agent["provider"],
  accountId: string,
  status: AgentStatus,
  extra: Partial<Agent> & { agoMin: number },
): Agent {
  const { agoMin, ...rest } = extra;
  const t = now - agoMin * MIN;
  const project = rest.projectPath ?? "/home/dev/code/acme-web";
  return {
    id,
    title,
    provider,
    accountId,
    projectPath: project,
    cwd: rest.worktree ? `${project}/.armada/worktrees/${id}` : project,
    worktree: false,
    branch: null,
    baseBranch: "main",
    baseCommit: "9f2c1ab",
    sessionId: `sess-${id}`,
    queuedPrompts: 0,
    status,
    running: status !== "stopped" && status !== "interrupted",
    groupId: null,
    createdAt: t - 40 * MIN,
    updatedAt: t,
    lastActivityAt: t,
    costUsd: 0,
    tokensUsed: 0,
    contextUsed: null,
    contextSize: null,
    unread: false,
    archived: false,
    lastMessage: null,
    pendingPermissions: 0,
    configOptions: [],
    // Claude and Codex take messages into a running turn.
    steerable: provider === "claude" || provider === "codex",
    availableCommands: [],
    rateLimited: false,
    scheduleId: null,
    customAgentId: null,
    ...rest,
  };
}

export function buildAgents(now: number): Agent[] {
  return [
    agent(now, "a1", "Fix token refresh race", "claude", "acc-work", "needs_permission", {
      agoMin: 1,
      projectPath: "/home/dev/code/acme-api",
      worktree: true,
      branch: "armada/fix-token-refresh",
      pendingPermissions: 1,
      costUsd: 0.42,
      tokensUsed: 48_200,
      contextUsed: 61_000,
      contextSize: 200_000,
      lastMessage: "Found it. refreshToken() isn't single-flight: when two requests get a 401 at the same moment, both start a refresh.",
      configOptions: providerConfig("claude", "claude-opus"),
      availableCommands: slashCommands,
    }),
    agent(now, "a2", "Migrate billing to Stripe Payment Element", "codex", "acc-openai", "needs_permission", {
      agoMin: 4,
      branch: "armada/stripe-v2",
      worktree: true,
      pendingPermissions: 1,
      costUsd: 1.18,
      tokensUsed: 131_000,
      contextUsed: 88_000,
      contextSize: 272_000,
      lastMessage: "Swapping redirectToCheckout for the Payment Element; the plan IDs stay the same.",
      configOptions: providerConfig("codex"),
      availableCommands: slashCommands.slice(1, 3),
    }),
    agent(now, "a3", "Refactor API client into hooks", "claude", "acc-personal", "working", {
      agoMin: 0,
      branch: "armada/api-hooks",
      worktree: true,
      costUsd: 0.87,
      tokensUsed: 92_400,
      contextUsed: 74_000,
      contextSize: 200_000,
      lastMessage: "Moving request deduplication into a shared cache so every hook reuses in-flight requests.",
      configOptions: providerConfig("claude", "claude-sonnet"),
      availableCommands: slashCommands,
      queuedPrompts: 2,
      queue: [
        { id: "q1", text: "After the refactor, migrate Settings.tsx to useApi as well.", attachments: 0 },
        { id: "q2", text: "Then compare the bundle size before and after.", attachments: 1 },
      ],
    }),
    agent(now, "a12", "Audit checkout accessibility", "claude", "acc-work", "idle", {
      agoMin: 6,
      branch: "armada/a11y-audit",
      worktree: true,
      costUsd: 1.36,
      tokensUsed: 118_000,
      contextUsed: 70_000,
      contextSize: 200_000,
      lastMessage: "Fixed 5 accessibility issues in the checkout flow; the e2e suite and axe checks pass.",
      configOptions: providerConfig("claude", "claude-sonnet"),
      availableCommands: slashCommands,
    }),
    agent(now, "a4", "Compare vector DBs for search", "grok", "acc-grok", "working", {
      agoMin: 2,
      projectPath: "/home/dev/code/research",
      costUsd: 0.31,
      tokensUsed: 40_900,
      lastMessage: "pgvector is the simplest fit up to ~5M rows; past that Qdrant's filtering wins.",
      configOptions: providerConfig("grok"),
    }),
    agent(now, "a11", "Pick a database for the new service", "claude", "acc-work", "needs_permission", {
      agoMin: 3,
      projectPath: "/home/dev/code/acme-api",
      pendingPermissions: 1,
      costUsd: 0.09,
      tokensUsed: 11_400,
      lastMessage: "I need a couple of decisions before scaffolding the service.",
      configOptions: providerConfig("claude", "claude-opus"),
      availableCommands: slashCommands,
    }),
    agent(now, "a9", "Summarize open PRs", "custom", "custom-gemini", "starting", {
      agoMin: 0,
      projectPath: "/home/dev/code/acme-web",
      customAgentId: "gemini",
      lastMessage: null,
      configOptions: providerConfig("custom"),
    }),
    agent(now, "a5", "Add e2e tests for checkout", "codex", "acc-openai", "idle", {
      agoMin: 18,
      branch: "armada/checkout-e2e",
      worktree: true,
      costUsd: 2.04,
      tokensUsed: 210_500,
      unread: true,
      lastMessage: "All 14 checkout tests pass locally and in CI mode. Two flaky waits were replaced with explicit assertions.",
      configOptions: providerConfig("codex"),
    }),
    agent(now, "a6", "Upgrade to React 19", "claude", "acc-work", "error", {
      agoMin: 34,
      rateLimited: true,
      costUsd: 3.6,
      tokensUsed: 402_000,
      lastMessage: "Usage limit reached for this account.",
      configOptions: providerConfig("claude", "claude-opus"),
    }),
    agent(now, "a7", "Dark mode for the docs site", "claude", "acc-personal", "interrupted", {
      agoMin: 95,
      projectPath: "/home/dev/code/docs",
      costUsd: 0.58,
      tokensUsed: 61_000,
      lastMessage: "Theme tokens are in place; next I'll update the code block styles.",
    }),
    agent(now, "a8", "Nightly dependency audit", "codex", "acc-openai", "stopped", {
      agoMin: 60 * 9,
      projectPath: "/home/dev/code/acme-api",
      scheduleId: "sch-nightly",
      costUsd: 0.12,
      tokensUsed: 15_300,
      lastMessage: "3 advisories found; 2 are dev-only. Stopped before opening the PR.",
    }),
    agent(now, "a10", "Spike: WebGPU charts", "grok", "acc-grok", "idle", {
      agoMin: 60 * 24 * 3,
      archived: true,
      lastMessage: "WebGPU is ~4x faster for 1M points but Safari support is still partial.",
    }),
  ];
}

const sessionOld = `import { api } from "../api/client";
import type { Session } from "./types";

let current: Session | null = null;

export async function refreshToken(): Promise<Session> {
  const res = await api.post("/auth/refresh", {
    token: current?.refreshToken,
  });
  current = res.data;
  return current;
}

export function getSession() {
  return current;
}
`;

const sessionNew = `import { api } from "../api/client";
import type { Session } from "./types";

let current: Session | null = null;
let inflight: Promise<Session> | null = null;

/** Single-flight: concurrent 401s share one refresh. */
export function refreshToken(): Promise<Session> {
  inflight ??= doRefresh().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doRefresh(): Promise<Session> {
  const res = await api.post("/auth/refresh", {
    token: current?.refreshToken,
  });
  current = res.data;
  return current;
}

export function getSession() {
  return current;
}
`;

const testNew = `import { describe, expect, it, vi } from "vitest";
import { refreshToken } from "../../src/auth/session";
import { api } from "../../src/api/client";

describe("refreshToken", () => {
  it("shares one refresh between concurrent callers", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ data: { refreshToken: "r2" } });
    await Promise.all(Array.from({ length: 5 }, () => refreshToken()));
    expect(post).toHaveBeenCalledTimes(1);
  });
});
`;

const stripeUnified = `--- a/src/billing/CheckoutButton.tsx
+++ b/src/billing/CheckoutButton.tsx
@@ -1,22 +1,27 @@
-import { loadStripe } from "@stripe/stripe-js";
+import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
+import { loadStripe } from "@stripe/stripe-js";
 import { useState } from "react";
 import type { Plan } from "./plans";

 const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_KEY);

-export function CheckoutButton({ plan }: { plan: Plan }) {
+function CheckoutForm({ plan }: { plan: Plan }) {
+  const stripe = useStripe();
+  const elements = useElements();
   const [busy, setBusy] = useState(false);

   async function onClick() {
+    if (!stripe || !elements) return;
     setBusy(true);
-    const stripe = await stripePromise;
-    await stripe?.redirectToCheckout({
-      lineItems: [{ price: plan.priceId, quantity: 1 }],
-      mode: "subscription",
-      successUrl: \`\${location.origin}/billing/success\`,
-      cancelUrl: location.href,
+    const { error } = await stripe.confirmPayment({
+      elements,
+      confirmParams: { return_url: \`\${location.origin}/billing/success\` },
     });
+    if (error) setBusy(false);
   }

   return (
-    <button onClick={onClick} disabled={busy}>Subscribe to {plan.name}</button>
+    <>
+      <PaymentElement />
+      <button onClick={onClick} disabled={busy || !stripe}>Subscribe to {plan.name}</button>
+    </>
   );
 }
`;

let seq = 0;
function base(agentId: string, ts: number) {
  seq += 1;
  return { id: `${agentId}-i${seq}`, agentId, seq, ts };
}

function tool(
  agentId: string,
  ts: number,
  toolKind: Extract<TimelineItem, { kind: "tool_call" }>["toolKind"],
  title: string,
  rest: Partial<Extract<TimelineItem, { kind: "tool_call" }>> = {},
): TimelineItem {
  const b = base(agentId, ts);
  return {
    ...b,
    kind: "tool_call",
    toolCallId: `tc-${b.id}`,
    title,
    toolKind,
    status: "completed",
    locations: [],
    diffs: [],
    output: "",
    command: null,
    ...rest,
  };
}

const diff = (path: string, oldText: string | null, newText: string | null): FileDiff => ({
  path,
  oldText,
  newText,
  unified: null,
});

export function buildTimelines(now: number): Record<string, TimelineItem[]> {
  seq = 0;
  const at = (minAgo: number) => now - minAgo * MIN;
  const tl: Record<string, TimelineItem[]> = {};

  tl.a1 = [
    {
      ...base("a1", at(14)),
      kind: "user_message",
      text: "The token refresh sometimes fires twice when two requests 401 at the same time, and the second refresh invalidates the first session. Can you fix it and add a regression test?",
    },
    {
      ...base("a1", at(13.8)),
      kind: "thought",
      text: "Two requests failing at once each call refreshToken(). Each POST rotates the refresh token, so the slower response carries a token the server already revoked. The fix is a single-flight promise shared by concurrent callers. I should check every call site first.",
    },
    tool("a1", at(13.6), "read", "Read src/auth/session.ts", { locations: ["src/auth/session.ts"] }),
    tool("a1", at(13.5), "search", "Search for refreshToken(", {
      output: "src/auth/session.ts:7:export async function refreshToken(): Promise<Session> {\nsrc/api/client.ts:88:      await refreshToken();\nsrc/api/client.ts:131:    const session = await refreshToken();",
    }),
    tool("a1", at(13.3), "read", "Read src/api/client.ts", { locations: ["src/api/client.ts"] }),
    {
      ...base("a1", at(12)),
      kind: "plan",
      entries: [
        { content: "Reproduce the race in a test", status: "completed", priority: "high" },
        { content: "Make refreshToken() single-flight", status: "completed", priority: "high" },
        { content: "Add a regression test", status: "in_progress", priority: "medium" },
        { content: "Run the auth test suite", status: "pending", priority: "medium" },
      ],
    },
    {
      ...base("a1", at(6)),
      kind: "agent_message",
      text: "Found it. `refreshToken()` isn't single-flight: when two requests get a **401** at the same moment, both start a refresh, and the second one revokes the token the first just obtained.\n\nThe fix keeps one in-flight promise and shares it:\n\n```ts\nlet inflight: Promise<Session> | null = null;\n\nexport function refreshToken() {\n  inflight ??= doRefresh().finally(() => {\n    inflight = null;\n  });\n  return inflight;\n}\n```\n\nI also added a regression test that fires **5 concurrent requests** against an expired session. See the [MDN notes on promises](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) for the `finally` semantics.",
    },
    {
      ...base("a1", at(5.5)),
      kind: "agent_message",
      text: "",
      images: [{ name: "refresh-race.png", mimeType: "image/png", data: ORDERS_PNG }],
    },
    {
      ...base("a1", at(5.2)),
      kind: "agent_message",
      text: "Before and after, rendered from the test harness:",
      images: [
        { name: "before.png", mimeType: "image/png", data: ORDERS_PNG },
        { name: "after.png", mimeType: "image/png", data: CHECKOUT_PNG },
      ],
    },
    tool("a1", at(5), "edit", "Edit src/auth/session.ts", {
      locations: ["src/auth/session.ts"],
      diffs: [diff("src/auth/session.ts", sessionOld, sessionNew)],
    }),
    tool("a1", at(4.5), "edit", "Create tests/auth/refresh.test.ts", {
      locations: ["tests/auth/refresh.test.ts"],
      diffs: [diff("tests/auth/refresh.test.ts", null, testNew)],
    }),
    {
      ...base("a1", at(1)),
      kind: "permission",
      requestId: "req-a1-test",
      title: "Run npm test -- auth",
      toolKind: "execute",
      command: "npm test -- auth --runInBand",
      diffs: [],
      options: [
        { id: "allow", name: "Allow", kind: "allow_once" },
        { id: "always", name: "Always allow npm test", kind: "allow_always" },
        { id: "reject", name: "Reject", kind: "reject_once" },
      ],
      resolution: null,
    },
  ];

  tl.a2 = [
    {
      ...base("a2", at(22)),
      kind: "user_message",
      text: "Move the billing page from Stripe Checkout redirects to the Payment Element. Keep the existing plans and the success URL.",
    },
    tool("a2", at(21), "execute", "Run rg -n \"stripe\" src/billing", {
      command: 'rg -n "stripe" src/billing',
      output:
        'src/billing/CheckoutButton.tsx:1:import { loadStripe } from "@stripe/stripe-js";\nsrc/billing/CheckoutButton.tsx:6:const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_KEY);\nsrc/billing/CheckoutButton.tsx:14:    await stripe?.redirectToCheckout({\nsrc/billing/plans.ts:3:// Price IDs from the Stripe dashboard',
    }),
    {
      ...base("a2", at(19)),
      kind: "permission",
      requestId: "req-a2-install",
      title: "Run npm install @stripe/react-stripe-js",
      toolKind: "execute",
      command: "npm install @stripe/react-stripe-js@3",
      diffs: [],
      options: [
        { id: "approved", name: "Approve", kind: "allow_once" },
        { id: "approved_for_session", name: "Approve for session", kind: "allow_always" },
        { id: "denied", name: "Deny", kind: "reject_once" },
      ],
      resolution: "approved",
    },
    tool("a2", at(18), "execute", "Run npm install @stripe/react-stripe-js@3", {
      command: "npm install @stripe/react-stripe-js@3",
      output: "\nadded 2 packages, and audited 412 packages in 3s\n\n98 packages are looking for funding\n  run `npm fund` for details\n\nfound 0 vulnerabilities",
    }),
    {
      ...base("a2", at(6)),
      kind: "agent_message",
      text: "Plan for `CheckoutButton.tsx`:\n\n1. Wrap the button in `<Elements>` with the existing `stripePromise`.\n2. Replace `redirectToCheckout` with `confirmPayment`, keeping the same success URL.\n3. Leave `plans.ts` untouched so the price IDs don't change.",
    },
    {
      ...base("a2", at(4)),
      kind: "permission",
      requestId: "req-a2-edit",
      title: "Edit src/billing/CheckoutButton.tsx",
      toolKind: "edit",
      command: null,
      diffs: [{ path: "src/billing/CheckoutButton.tsx", oldText: null, newText: null, unified: stripeUnified }],
      options: [
        { id: "approved", name: "Approve", kind: "allow_once" },
        { id: "approved_for_session", name: "Approve for session", kind: "allow_always" },
        { id: "denied", name: "Deny", kind: "reject_once" },
        { id: "cancel", name: "Deny and stop", kind: "reject_always" },
      ],
      resolution: null,
    },
  ];

  tl.a3 = [
    {
      ...base("a3", at(9)),
      kind: "user_message",
      text: "Refactor the API client into React hooks. useQuery-style, no new dependencies, and keep request dedup.",
    },
    {
      ...base("a3", at(8.8)),
      kind: "thought",
      text: "I'll keep `client.ts` as the transport and build `useApi` on top with a tiny cache keyed by URL.",
    },
    tool("a3", at(8.5), "read", "Read src/api/client.ts", { locations: ["src/api/client.ts"] }),
    tool("a3", at(8.4), "other", "Task: Audit API call sites", {
      toolCallId: "sa-audit",
      subagent: {
        kind: "Explore",
        description: "Find every component that calls the API client directly",
        prompt: "Search src/ for direct uses of api.get / api.post. For each, note the component, the endpoint and whether it handles loading and errors. Report a table; don't change any files.",
      },
      // The sub-agent's final report (shown on its card once it finishes).
      output:
        "## Direct API calls\n\n| Component | Endpoint | Loading | Errors |\n|---|---|---|---|\n| `Orders.tsx` | `/orders?page=` | yes | no |\n| `Customers.tsx` | `/customers` | yes | yes |\n| `Dashboard.tsx` | `/stats`, `/orders/recent` | no | no |\n| `Settings.tsx` | `/settings` | no | no |\n\n**4 components** call `api.get` directly. Only `Customers.tsx` handles errors, so the hook should surface `error` by default.",
    }),
    tool("a3", at(8.35), "search", "Search for api.get(", { parentToolCallId: "sa-audit", output: "12 matches in 6 files" }),
    tool("a3", at(8.3), "read", "Read src/pages/Orders.tsx", { parentToolCallId: "sa-audit", locations: ["src/pages/Orders.tsx"] }),
    tool("a3", at(8.28), "read", "Read src/pages/Customers.tsx", { parentToolCallId: "sa-audit", locations: ["src/pages/Customers.tsx"] }),
    tool("a3", at(8.25), "read", "Read src/pages/Dashboard.tsx", { parentToolCallId: "sa-audit", locations: ["src/pages/Dashboard.tsx"] }),
    tool("a3", at(8.2), "search", "Find usages of api.get", {
      output: "src/pages/Orders.tsx:22\nsrc/pages/Customers.tsx:17\nsrc/pages/Dashboard.tsx:41\nsrc/pages/Settings.tsx:12",
    }),
    tool("a3", at(6), "execute", "Run npx tsc --noEmit", {
      command: "npx tsc --noEmit",
      output: "src/pages/Orders.tsx(31,18): error TS2339: Property 'items' does not exist on type 'unknown'.\nFound 1 error in src/pages/Orders.tsx:31",
      status: "failed",
    }),
    tool("a3", at(5), "other", "Screenshot localhost:5173/orders", {
      locations: ["http://localhost:5173/orders"],
      images: [
        { name: "orders.png", mimeType: "image/png", data: ORDERS_PNG },
        { name: "checkout-mobile.png", mimeType: "image/png", data: CHECKOUT_PNG },
      ],
    }),
    tool("a3", at(4), "edit", "Edit src/pages/Orders.tsx", {
      locations: ["src/pages/Orders.tsx"],
      diffs: [
        diff(
          "src/pages/Orders.tsx",
          "  const data = await api.get(`/orders?page=${page}`);\n  setOrders(data.items);\n",
          "  const { data } = useApi<OrderPage>(`/orders?page=${page}`);\n  const orders = data?.items ?? [];\n",
        ),
      ],
    }),
    tool("a3", at(2), "other", "Task: Migrate Customers.tsx", {
      toolCallId: "sa-customers",
      status: "in_progress",
      subagent: { kind: "general-purpose", description: "Migrate Customers.tsx to useApi", prompt: "Replace the manual fetch in Customers.tsx with useApi. Keep pagination behaviour identical." },
    }),
    tool("a3", at(1.8), "read", "Read src/pages/Customers.tsx", { parentToolCallId: "sa-customers", locations: ["src/pages/Customers.tsx"] }),
    tool("a3", at(1.2), "edit", "Edit src/pages/Customers.tsx", { parentToolCallId: "sa-customers", status: "in_progress" }),
    // Codex-style management call: shown like a tool call, never counted as a running sub-agent.
    tool("a3", at(1.1), "other", "Wait for Migrate Customers.tsx", { toolCallId: "sa-wait", subagent: { kind: "wait", control: true } }),
    // A background sub-agent: its launch call completed, but it keeps running.
    tool("a3", at(1), "other", "Task: Compare bundle size", {
      toolCallId: "sa-bundle",
      output: "Async agent launched successfully. It keeps running in the background.",
      subagent: {
        kind: "general-purpose",
        description: "Build before and after and compare the bundle size",
        prompt: "Build the app on main and on this branch, then report the size difference per chunk.",
        background: true,
      },
    }),
    tool("a3", at(0.9), "execute", "Run npx vite build --report", {
      parentToolCallId: "sa-bundle",
      command: "npx vite build --report",
      status: "in_progress",
      output: "vite v6.3.5 building for production...\n",
    }),
    // A running command: ANSI colors and a progress bar redrawn with \r.
    tool("a3", at(0.7), "execute", "Run npm install", {
      command: "npm install",
      status: "in_progress",
      output:
        "\x1b[1m\x1b[36mnpm\x1b[0m \x1b[33mwarn\x1b[0m deprecated inflight@1.0.6: This module is not supported\n" +
        "\x1b[2K\x1b[1G(\x1b[32m#\x1b[0m#########) \x1b[1m12%\x1b[0m idealTree:react\r" +
        "\x1b[2K\x1b[1G(\x1b[32m####\x1b[0m######) \x1b[1m47%\x1b[0m reify:vite\r" +
        "\x1b[2K\x1b[1G(\x1b[32m#########\x1b[0m#) \x1b[1m91%\x1b[0m reify:esbuild",
    }),
    {
      ...base("a3", at(0.5)),
      kind: "agent_message",
      text: "Moving request deduplication into a shared cache so every hook reuses in-flight requests.",
    },
  ];

  tl.a4 = [
    {
      ...base("a4", at(12)),
      kind: "user_message",
      text: "Compare pgvector, Qdrant and LanceDB for our 20M-document semantic search. Latency, filtering, ops cost.",
    },
    tool("a4", at(11), "fetch", "Fetch qdrant.tech/benchmarks", { locations: ["https://qdrant.tech/benchmarks/"] }),
    tool("a4", at(10), "fetch", "Fetch github.com/pgvector/pgvector", { locations: ["https://github.com/pgvector/pgvector"] }),
    {
      ...base("a4", at(3)),
      kind: "agent_message",
      text: "## Short version\n\n| | p95 @ 20M | Filtering | Ops |\n|---|---|---|---|\n| pgvector | ~45 ms | SQL | Existing Postgres |\n| Qdrant | ~12 ms | Payload index | New service |\n| LanceDB | ~30 ms | Basic | Embedded |\n\npgvector is the simplest fit up to ~5M rows; past that Qdrant's filtering wins.",
    },
    {
      ...base("a4", at(2)),
      kind: "agent_message",
      text: "## Formatting check\n\nSetext heading\n==============\n\nHard break after this line  \nsecond line, and one with a backslash\\\nthird line. Escapes: \\*not italic\\*, 5 \\< 6, AT&amp;T, ~~old~~ ~new~, ***both***, `a || b`.\n\n1. **Install** the tools:\n\n   ```bash\n   npm i -g pnpm\n   ```\n\n2. Configure:\n   - [x] write `.env`\n   - [ ] rotate keys\n     - nested _deeper_ item\n3. Verify\n\n> **Note**\n> - quoted bullet\n> - another one\n\n| Option | Default | Notes |\n|:--|:-:|--:|\n| `--ef` | 64 | higher is slower, see [docs](https://qdrant.tech/documentation/) |\n| `m` | 16 | graph degree |\n\n```diff\n- ef = 32\n+ ef = 128\n@@ -3,2 +3,2 @@\n```\n\n```python\ndef search(q, k=10):\n    # nearest neighbours\n    return index.query(q, top_k=k)  # 12 ms\n```\n\n![diagram](/home/dev/code/acme-api/docs/diagram.png) and a web one: ![logo](https://qdrant.tech/logo.png)\n\n---\n\nSee https://lancedb.github.io/lancedb/ or mail me@example.com.",
    },
    // Still working: the trailing run of calls is the live group (open, showing the current step).
    tool("a4", at(1.5), "search", "Search for LanceDB filtering", { output: "docs/concepts/filtering.md\ndocs/guides/prefilter.md" }),
    tool("a4", at(1), "fetch", "Fetch lancedb.github.io/lancedb/concepts", { status: "in_progress" }),
  ];

  tl.a11 = [
    { ...base("a11", at(5)), kind: "user_message", text: "Scaffold the new notifications service. Ask me whatever you need to know first." },
    {
      ...base("a11", at(3)),
      kind: "question",
      requestId: "req-a11-ask",
      message: "A couple of decisions before I scaffold the notifications service.",
      source: null,
      fields: [
        {
          id: "question_0",
          title: "Database",
          description: "Which database should the service use for queued notifications?",
          kind: "single",
          required: true,
          options: [
            { value: "postgres", label: "PostgreSQL", description: "Reuse the existing cluster; transactional outbox, no new infrastructure." },
            { value: "redis", label: "Redis", description: "Fast and simple, but notifications are lost if it restarts without persistence." },
            { value: "sqlite", label: "SQLite", description: "A single file per instance; easiest locally, awkward to scale out." },
          ],
        },
        { id: "question_0_custom", title: "Database", description: null, kind: "text", otherFor: "question_0" },
        {
          id: "question_1",
          title: "Channels",
          description: "Which delivery channels should it support at launch?",
          kind: "multi",
          options: [
            { value: "email", label: "Email", description: "Transactional email through the existing provider." },
            { value: "push", label: "Push", description: "APNs and FCM." },
            { value: "sms", label: "SMS" },
            { value: "webhook", label: "Webhooks", description: "Signed HTTP callbacks for customers." },
          ],
        },
        { id: "question_1_custom", title: "Channels", description: null, kind: "text", otherFor: "question_1" },
      ],
      resolution: null,
    },
  ];

  tl.a9 = [
    {
      ...base("a9", at(0.3)),
      kind: "user_message",
      text: "Summarize every open PR in acme-web: what it changes, risk, and whether it's ready to merge.",
    },
  ];

  tl.a5 = [
    { ...base("a5", at(40)), kind: "user_message", text: "Write Playwright e2e tests for the checkout flow, including failed payments." },
    tool("a5", at(38), "edit", "Create e2e/checkout.spec.ts", { locations: ["e2e/checkout.spec.ts"] }),
    tool("a5", at(30), "execute", "Run npx playwright test e2e/checkout.spec.ts", {
      command: "npx playwright test e2e/checkout.spec.ts",
      output: "Running 14 tests using 4 workers\n\n  14 passed (38.2s)",
    }),
    {
      ...base("a5", at(36)),
      kind: "question",
      requestId: "req-a5-ask",
      message: "Which browsers should the checkout tests run in?",
      source: null,
      fields: [
        {
          id: "question_0",
          title: null,
          description: null,
          kind: "single",
          options: [
            { value: "chromium", label: "Chromium only", description: "Fastest; covers most traffic." },
            { value: "all", label: "Chromium, Firefox and WebKit", description: "Triple the CI time." },
          ],
        },
        { id: "question_0_custom", title: null, description: null, kind: "text", otherFor: "question_0" },
      ],
      resolution: "answered",
      answers: { question_0: "chromium" },
    },
    { ...base("a5", at(25)), kind: "notice", level: "info", text: "Context compacted to free up space" },
    {
      ...base("a5", at(18)),
      kind: "agent_message",
      text: "All **14** checkout tests pass locally and in CI mode.\n\n- Card success, 3-D Secure, declined card and expired card paths\n- Coupon codes, including an expired one\n- Two flaky `waitForTimeout` calls were replaced with explicit assertions\n\nRun them with `npx playwright test e2e/checkout.spec.ts`.\n\nThe success page after a test payment:\n\n![checkout success](/home/dev/code/acme-web/test-results/checkout.png)",
    },
    {
      ...base("a5", at(17.9)),
      kind: "turn_summary",
      durationMs: 22 * MIN + 14_000,
      files: ["e2e/checkout.spec.ts", "e2e/fixtures/cards.ts", "e2e/helpers/payment.ts", "playwright.config.ts", "package.json", "README.md"],
      toolCalls: 23,
      commands: 7,
      costUsd: 2.04,
      tokens: 210_500,
    },
  ];

  tl.a6 = [
    { ...base("a6", at(60)), kind: "user_message", text: "Upgrade the app to React 19 and fix whatever breaks." },
    tool("a6", at(55), "execute", "Run npm install react@19 react-dom@19", {
      command: "npm install react@19 react-dom@19",
      output: "added 2 packages, changed 2 packages in 4s",
    }),
    { ...base("a6", at(34)), kind: "notice", level: "error", text: "Usage limit reached for Claude Max (Work). It resets at 3:00 PM." },
  ];

  tl.a7 = [
    { ...base("a7", at(120)), kind: "user_message", text: "Add a dark mode to the docs site that follows the system setting." },
    {
      ...base("a7", at(96)),
      kind: "agent_message",
      text: "Theme tokens are in place; next I'll update the code block styles.",
    },
    tool("a7", at(95.5), "edit", "Edit docs/styles/code.css", { locations: ["docs/styles/code.css"], status: "in_progress" }),
    tool("a7", at(95.4), "other", "Task: Check contrast ratios", {
      toolCallId: "sa-contrast",
      status: "in_progress",
      subagent: { kind: "Explore", description: "Check text contrast in both themes", prompt: "Compute WCAG contrast for every theme token pair." },
    }),
    {
      ...base("a7", at(95)),
      kind: "notice",
      level: "warn",
      text: "Armada closed while this agent was working. Resume to pick up where it left off.",
    },
  ];

  tl.a8 = [
    { ...base("a8", at(60 * 9 + 20)), kind: "user_message", text: "Run npm audit, summarize the advisories and open a PR with safe upgrades." },
    tool("a8", at(60 * 9 + 10), "execute", "Run npm audit --json", { command: "npm audit --json", output: '{\n  "vulnerabilities": 3\n}' }),
    { ...base("a8", at(60 * 9 + 2)), kind: "agent_message", text: "3 advisories found; 2 are dev-only. Stopped before opening the PR." },
    { ...base("a8", at(60 * 9)), kind: "notice", level: "info", text: "Stopped by you" },
  ];

  tl.a10 = [
    { ...base("a10", at(60 * 24 * 3 + 30)), kind: "user_message", text: "Spike: can we render 1M points with WebGPU?" },
    { ...base("a10", at(60 * 24 * 3)), kind: "agent_message", text: "WebGPU is ~4x faster for 1M points but Safari support is still partial." },
  ];

  // A long finished turn: lots of work folded into one line, then the answer and a "Done" card.
  tl.a12 = [
    { ...base("a12", at(38)), kind: "user_message", text: "Audit the checkout flow for accessibility problems and fix what you find. Run the e2e suite when you're done." },
    { ...base("a12", at(37.8)), kind: "thought", text: "Start with the form components: labels, focus order and error announcements are the usual culprits. Then check colour contrast and the modal." },
    tool("a12", at(37.5), "read", "Read src/billing/CheckoutForm.tsx", { locations: ["src/billing/CheckoutForm.tsx"] }),
    tool("a12", at(37.4), "read", "Read src/billing/CardField.tsx", { locations: ["src/billing/CardField.tsx"] }),
    tool("a12", at(37.3), "read", "Read src/billing/ErrorSummary.tsx", { locations: ["src/billing/ErrorSummary.tsx"] }),
    tool("a12", at(37.2), "search", "Search for aria-", { output: "src/billing/CardField.tsx:14: aria-label\nsrc/billing/Modal.tsx:9: aria-modal" }),
    tool("a12", at(37), "read", "Read src/billing/Modal.tsx", { locations: ["src/billing/Modal.tsx"] }),
    { ...base("a12", at(36.5)), kind: "agent_message", text: "Four things stand out: the card field has no visible label, errors aren't announced, the modal doesn't trap focus, and the muted text fails contrast." },
    tool("a12", at(35), "execute", "Run npx axe-cli http://localhost:5173/checkout", {
      command: "npx axe-cli http://localhost:5173/checkout",
      status: "failed",
      output:
        "\x1b[1mRunning axe-core 4.10.0\x1b[0m\n\x1b[31m✖ 5 violations found\x1b[0m\n  \x1b[33mlabel\x1b[0m: Form elements must have labels (1 node)\n  \x1b[33mcolor-contrast\x1b[0m: Elements must meet minimum color contrast (3 nodes)\n  \x1b[33maria-dialog-name\x1b[0m: Dialogs must have an accessible name (1 node)\n\nexit code 1",
    }),
    tool("a12", at(34), "edit", "Edit src/billing/CardField.tsx", {
      locations: ["src/billing/CardField.tsx"],
      diffs: [
        diff(
          "src/billing/CardField.tsx",
          '<input className="card" placeholder="Card number" />\n<p className="hint">We never store your card.</p>\n',
          '<label htmlFor="card">Card number</label>\n<input id="card" className="card" autoComplete="cc-number" inputMode="numeric" />\n<p id="card-hint" className="hint">We never store your card.</p>\n',
        ),
      ],
    }),
    tool("a12", at(33), "edit", "Edit src/billing/ErrorSummary.tsx", {
      locations: ["src/billing/ErrorSummary.tsx"],
      diffs: [diff("src/billing/ErrorSummary.tsx", '<div className="errors">\n', '<div className="errors" role="alert" aria-live="assertive">\n')],
    }),
    { ...base("a12", at(32.5)), kind: "thought", text: "The modal needs a focus trap and an accessible name. I'll use the dialog element's label and restore focus to the trigger on close." },
    tool("a12", at(32), "edit", "Edit src/billing/Modal.tsx", {
      locations: ["src/billing/Modal.tsx"],
      diffs: [
        diff(
          "src/billing/Modal.tsx",
          '<div className="modal" aria-modal="true">\n',
          '<div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">\n  <FocusTrap onEscape={onClose}>\n',
        ),
      ],
    }),
    tool("a12", at(31), "edit", "Edit src/styles/tokens.css", {
      locations: ["src/styles/tokens.css"],
      diffs: [diff("src/styles/tokens.css", "--muted: #8b95a1;\n", "--muted: #6b7684;\n")],
    }),
    tool("a12", at(30), "execute", "Run npm install --save-dev focus-trap-react", {
      command: "npm install --save-dev focus-trap-react",
      output:
        "\x1b[2K\x1b[1G(#####     ) reify:focus-trap-react: \x1b[32mhttp fetch\x1b[0m GET 200\r\x1b[2K\x1b[1G(##########) reify:focus-trap-react: \x1b[32msill\x1b[0m audit\n\nadded 2 packages in 3s",
    }),
    tool("a12", at(29), "read", "Read e2e/checkout.spec.ts", { locations: ["e2e/checkout.spec.ts"] }),
    tool("a12", at(28), "edit", "Edit e2e/checkout.spec.ts", {
      locations: ["e2e/checkout.spec.ts"],
      diffs: [diff("e2e/checkout.spec.ts", 'await page.getByPlaceholder("Card number").fill(card);\n', 'await page.getByLabel("Card number").fill(card);\n')],
    }),
    tool("a12", at(27), "execute", "Run npx playwright test e2e/checkout.spec.ts", {
      command: "npx playwright test e2e/checkout.spec.ts",
      output: "\x1b[32m✓\x1b[0m 14 passed (38.2s)",
    }),
    tool("a12", at(26), "execute", "Run npx axe-cli http://localhost:5173/checkout", {
      command: "npx axe-cli http://localhost:5173/checkout",
      output: "\x1b[1mRunning axe-core 4.10.0\x1b[0m\n\x1b[32m✓ 0 violations found\x1b[0m",
    }),
    { ...base("a12", at(25)), kind: "agent_message", text: "All five violations are fixed. Here is what changed:" },
    {
      ...base("a12", at(24.8)),
      kind: "agent_message",
      text: "Fixed **5 accessibility issues** in the checkout flow:\n\n- The card number field now has a real `<label>` and `autocomplete`\n- Validation errors are announced (`role=\"alert\"`)\n- The modal has an accessible name and traps focus (new dependency: `focus-trap-react`)\n- Muted text now meets the 4.5:1 contrast ratio\n\nThe e2e suite passes (14 tests) and axe reports **0 violations**.",
    },
    {
      ...base("a12", at(24.5)),
      kind: "turn_summary",
      durationMs: 13 * MIN + 41_000,
      files: ["e2e/checkout.spec.ts", "playwright.config.ts", "src/billing/legacy.ts", "src/billing/CardField.tsx", "src/billing/Modal.tsx"],
      toolCalls: 17,
      commands: 5,
      costUsd: 1.36,
      tokens: 118_000,
    },
  ];

  return tl;
}

export function nextSeq() {
  seq += 1;
  return seq;
}

/** Text the "working" agent streams in the simulation. */
export const STREAM_SCRIPT = [
  "Moving request deduplication into a shared cache so every hook reuses in-flight requests. ",
  "`useApi(url)` now returns `{ data, error, loading, refetch }` and subscribes to the cache entry, ",
  "so two components asking for `/orders?page=1` trigger **one** request.\n\n",
  "Next I'll migrate the remaining pages:\n\n- `Customers.tsx`\n- `Dashboard.tsx`\n- `Settings.tsx`\n",
];
