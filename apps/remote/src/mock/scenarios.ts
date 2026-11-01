/**
 * Optional dev-mock scenarios for the newer features (`?quick=1&plan=1&group=1&md=1&dock=1`), kept out of the
 * default fleet so the other screenshots and tests stay stable. Dev-only; never bundled in production.
 */
import type { Agent, TimelineItem } from "@/lib/types";
import { agent, base, MIN, tool } from "./data";

export interface Extras {
  agents: Agent[];
  timelines: Record<string, TimelineItem[]>;
}

export function buildExtras(now: number, flags: ReadonlySet<string>): Extras {
  const agents: Agent[] = [];
  const timelines: Record<string, TimelineItem[]> = {};
  const at = (m: number) => now - m * MIN;
  const WEB = "/home/dev/code/acme-web";

  if (flags.has("quick")) {
    // A one-field, single-choice question: answered with one tap from the dock.
    agents.push(
      agent(now, "q1", "Choose a test runner", "claude", "acc-work", "needs_permission", {
        agoMin: 2,
        projectPath: WEB,
        pendingPermissions: 1,
        steerable: true,
      }),
    );
    timelines.q1 = [
      { ...base("q1", at(4)), kind: "user_message", text: "Set up unit tests for the billing module." },
      { ...base("q1", at(3)), kind: "agent_message", text: "I can set this up with either runner. Which one fits your CI?" },
      {
        ...base("q1", at(2)),
        kind: "question",
        requestId: "req-q1",
        message: "Which test runner should I use?",
        source: null,
        fields: [
          {
            id: "q",
            title: null,
            description: null,
            kind: "single",
            required: true,
            options: [
              { value: "vitest", label: "Vitest", description: "Already a dev dependency; fastest." },
              { value: "jest", label: "Jest", description: "Matches the other packages." },
              { value: "node", label: "node:test", description: "No dependencies." },
            ],
          },
          { id: "q_custom", title: null, description: null, kind: "text", otherFor: "q" },
        ],
        resolution: null,
      },
    ];
  }

  if (flags.has("plan")) {
    agents.push(
      agent(now, "p1", "Plan the auth rewrite", "claude", "acc-work", "needs_permission", {
        agoMin: 1,
        projectPath: WEB,
        pendingPermissions: 1,
        steerable: true,
      }),
    );
    timelines.p1 = [
      { ...base("p1", at(6)), kind: "user_message", text: "Plan how we move sessions from cookies to short-lived tokens." },
      {
        ...base("p1", at(1)),
        kind: "permission",
        requestId: "req-p1",
        title: "Ready to code?",
        toolKind: "other",
        command: null,
        diffs: [],
        plan: "# Move sessions to short-lived tokens\n\n1. Add a token service with 15 minute access tokens and rotating refresh tokens.\n2. Replace the cookie middleware.\n3. Migrate existing sessions on next request.\n4. Remove the old store and update the docs.\n\nRisk: logged-in users are signed out once if the migration fails.",
        options: [
          { id: "exit-plan-accept-edits", name: "Yes, and auto-accept edits", kind: "allow_always" },
          { id: "exit-plan-default", name: "Yes, and review each edit", kind: "allow_once" },
          { id: "exit-plan-keep", name: "No, keep planning", kind: "reject_once" },
        ],
        resolution: null,
      } as TimelineItem,
    ];
  }

  if (flags.has("group")) {
    const mk = (id: string, title: string, status: Agent["status"], extra: Partial<Agent> & { agoMin: number }) =>
      agent(now, id, title, "claude", "acc-work", status, {
        projectPath: WEB,
        worktree: true,
        branch: `kvistcode/${id}`,
        groupId: "grp-login",
        steerable: true,
        ...extra,
      });
    agents.push(
      mk("g1", "Fix login redirect", "working", { agoMin: 0.5, createdAt: at(30) }),
      mk("g2", "Fix login redirect", "idle", {
        agoMin: 6,
        unread: true,
        lastMessage: "Done: the redirect now keeps the `next` parameter.",
        createdAt: at(29),
      }),
      mk("g3", "Fix login redirect", "needs_permission", { agoMin: 2, pendingPermissions: 1, createdAt: at(28) }),
    );
    timelines.g1 = [
      { ...base("g1", at(5)), kind: "user_message", text: "Fix the login redirect losing the next parameter." },
      tool("g1", at(1), "edit", "Edit src/auth/redirect.ts", { status: "in_progress" }),
    ];
    timelines.g2 = [
      { ...base("g2", at(8)), kind: "user_message", text: "Fix the login redirect losing the next parameter." },
      { ...base("g2", at(6)), kind: "agent_message", text: "Done: the redirect now keeps the `next` parameter." },
    ];
    timelines.g3 = [
      { ...base("g3", at(8)), kind: "user_message", text: "Fix the login redirect losing the next parameter." },
      {
        ...base("g3", at(2)),
        kind: "permission",
        requestId: "req-g3",
        title: "Run npm test -- redirect",
        toolKind: "execute",
        command: "npm test -- redirect",
        diffs: [],
        options: [
          { id: "allow", name: "Allow", kind: "allow_once" },
          { id: "deny", name: "Deny", kind: "reject_once" },
        ],
        resolution: null,
      } as TimelineItem,
    ];
  }

  if (flags.has("md")) {
    agents.push(
      agent(now, "m1", "Benchmark the search index", "claude", "acc-work", "idle", {
        agoMin: 3,
        projectPath: "/home/dev/code/research",
        steerable: true,
      }),
    );
    const code = Array.from(
      { length: 42 },
      (_, i) => `  const step${i} = measure("case ${i}", () => index.query(vectors[${i}], { k: 10 }));`,
    ).join("\n");
    timelines.m1 = [
      { ...base("m1", at(30)), kind: "user_message", text: "Benchmark the index and tell me what to change." },
      {
        ...base("m1", at(29)),
        kind: "agent_message",
        text: "Let me start by looking at how the index is built and what the harness measures, so the numbers mean something.",
      },
      tool("m1", at(28), "read", "Read bench/harness.ts", { locations: ["bench/harness.ts"] }),
      {
        ...base("m1", at(27)),
        kind: "agent_message",
        text: "The harness warms the cache once and then runs every query cold, which hides the real tail. I'll run it again with the cache disabled",
      },
      {
        ...base("m1", at(26.9)),
        kind: "agent_message",
        text: "and compare the two. This is a longer working note that goes on for a while to show how narration folds: it explains the plan for the comparison, what each run measures, the order they run in, and why the machine has to stay idle while they do, otherwise the numbers are not comparable at all. The second run repeats the first with a different seed so the two can be told apart from noise, and each one is repeated five times.",
      },
      tool("m1", at(25), "execute", "Run npm run bench", { command: "npm run bench", output: "ok" }),
      {
        ...base("m1", at(20)),
        kind: "agent_message",
        text: `## Result\n\nThe index is **fast but its tail is long**. Median latency is fine; p99 is 6x worse than the median.\n\n| Case | p50 | p99 | Recall | Note |\n| --- | --- | --- | --- | --- |\n| baseline | 12 ms | 74 ms | 0.97 | cold cache |\n| warm | 9 ms | 31 ms | 0.97 | cache on |\n| ef=128 | 21 ms | 90 ms | 0.995 | slower, better recall |\n\n### What to change\n\n1. Raise \`ef\` only for the queries that need recall.\n2. Cache the entry points.\n3. Batch queries from the API layer.\n\nThe benchmark loop I used:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nFour more paragraphs follow so that this answer is long enough to fold. ${"The index rebuild takes about nine minutes on this machine and blocks writes while it runs, so schedule it. ".repeat(3)}\n\nAnother paragraph about the cache: ${"entry points are stable across rebuilds, so caching them is safe. ".repeat(4)}\n\nAnd a last one on batching: ${"the API layer issues one query per request today, which wastes the index's batch path. ".repeat(4)}\n\nThen the order I would do it in, with the reasoning for each step and what to watch for afterwards, so nothing regresses quietly. ${"Measure again after every change, one at a time. ".repeat(4)}\n\nFinally a short summary of risks, costs and the rollback plan. ${"Nothing here is irreversible. ".repeat(6)}`,
      },
    ];
  }

  if (flags.has("dock")) {
    // A busy agent with a plan in progress and a rate-limit-free, steerable turn.
    const a = agent(now, "k1", "Ship the settings page", "claude", "acc-work", "working", {
      agoMin: 0.2,
      projectPath: WEB,
      steerable: true,
    });
    agents.push(a);
    timelines.k1 = [
      { ...base("k1", at(9)), kind: "user_message", text: "Build the settings page." },
      {
        ...base("k1", at(8)),
        kind: "plan",
        entries: [
          { content: "Sketch the form", status: "completed", priority: "high" },
          { content: "Wire up the settings API", status: "completed", priority: "high" },
          { content: "Add validation and error states", status: "in_progress", priority: "medium" },
          { content: "Write tests", status: "pending", priority: "medium" },
          { content: "Update the docs", status: "pending", priority: "low" },
        ],
      },
      tool("k1", at(1), "edit", "Edit src/settings/Form.tsx", { status: "in_progress" }),
    ];
  }

  if (flags.has("hold")) {
    // Held at a limit: a dollar limit with queued messages, and a limit kind this app has no wording for.
    agents.push(
      agent(now, "h1", "Refactor the invoice exporter", "claude", "acc-work", "idle", {
        agoMin: 3,
        projectPath: WEB,
        costUsd: 3.08,
        unread: true,
        queuedPrompts: 2,
        queue: [
          { id: "hq1", text: "Now add CSV export.", attachments: 0 },
          { id: "hq2", text: "And update the docs.", attachments: 0 },
        ],
        queuePaused: true,
        lastMessage: "The exporter now streams rows instead of building the whole file in memory.",
        budgetHold: { scope: "agent", metric: "cost", spent: 3.08, cap: 3, since: now - 3 * MIN },
      }),
      agent(now, "h2", "Triage the flaky e2e suite", "codex", "acc-openai", "idle", {
        agoMin: 8,
        projectPath: WEB,
        lastMessage: "Three of the five flaky specs share a race in the cart fixture.",
        // A kind the core may add later: it must still read sensibly.
        budgetHold: { scope: "project", metric: "turns", spent: 41, cap: 40, since: now - 8 * MIN } as unknown as Agent["budgetHold"],
      }),
    );
    timelines.h1 = [
      { ...base("h1", at(20)), kind: "user_message", text: "Refactor the invoice exporter to stream rows." },
      { ...base("h1", at(4)), kind: "agent_message", text: "The exporter now streams rows instead of building the whole file in memory." },
    ];
    timelines.h2 = [
      { ...base("h2", at(30)), kind: "user_message", text: "Find out why the e2e suite is flaky." },
      { ...base("h2", at(9)), kind: "agent_message", text: "Three of the five flaky specs share a race in the cart fixture." },
    ];
  }

  return { agents, timelines };
}
