// Browser-mock stand-in for the `workflow_progress` command: a made-up Workflow run whose
// agents progress with the wall clock, so the dock row and timeline card can be developed and
// screenshotted without Claude Code. Never loaded inside Tauri (mock.ts is code-split).
import type { WorkflowAgent, WorkflowProgress } from "./types";

interface MockAgent {
  label: string;
  /** Seconds after launch it finishes (or fails). */
  endsAt: number;
  fails?: boolean;
  actions: string[];
}

const AGENTS: MockAgent[] = [
  {
    label: "build:phone",
    endsAt: 75,
    actions: [
      "Reading src/remote/view.rs",
      "Editing src/remote/view.rs",
      "Running cargo test -p kvistcode-core",
      "Editing apps/remote/src/Dock.tsx",
    ],
  },
  {
    label: "build:prsafety",
    endsAt: 52,
    actions: [
      "Reading src/pr_status.rs",
      "Searching for merge_state",
      "Editing src/pr_status.rs",
      "Running cargo clippy --workspace",
    ],
  },
  {
    label: "build:tools",
    endsAt: 95,
    actions: [
      "Reading src/toolkit.rs",
      "Editing src/toolkit.rs",
      "Running npx tsc --noEmit",
      "Editing src/components/Toolkit.tsx",
    ],
  },
  {
    label: "build:turns",
    endsAt: 64,
    fails: true,
    actions: [
      "Reading src/budget.rs",
      "Editing src/budget.rs",
      "Running cargo test turn_limit",
      "Writing src/turn_limit.rs",
    ],
  },
  {
    label: "build:previewtour",
    endsAt: 82,
    actions: [
      "Reading src/onboarding/Tour.tsx",
      "Editing src/onboarding/Tour.tsx",
      "Running npm run build",
      "Finding files **/preview*.ts",
    ],
  },
];

/** Wall-clock launch time per tool call; a call nobody registered starts when first asked. */
const starts = new Map<string, number>();

export function mockWorkflowStart(toolCallId: string, at = Date.now()) {
  starts.set(toolCallId, at);
}

export function mockWorkflowProgress(toolCallId: string, now = Date.now()): WorkflowProgress {
  if (!starts.has(toolCallId)) starts.set(toolCallId, now);
  const t = Math.max(0, (now - (starts.get(toolCallId) ?? now)) / 1000);
  const agents: WorkflowAgent[] = AGENTS.map((a, i) => {
    const done = t >= a.endsAt;
    const calls = Math.floor(Math.min(t, a.endsAt) * (0.35 + i * 0.04));
    return {
      id: `a${i}`,
      label: a.label,
      phase: "Build",
      status: done ? (a.fails ? "failed" : "finished") : "working",
      toolCalls: calls,
      latest: done ? null : a.actions[Math.floor(t / 6 + i) % a.actions.length],
      idleSecs: done ? Math.round(t - a.endsAt) : Math.round(t % 3),
    };
  });
  const allDone = agents.every((a) => a.status !== "working");
  const lastEnd = Math.max(...AGENTS.map((a) => a.endsAt));
  // Like the backend: finished only once everything has been quiet for a while.
  const state = allDone && t - lastEnd >= 10 ? "finished" : "running";
  return { runId: "wf_mock-1", state, agents };
}
