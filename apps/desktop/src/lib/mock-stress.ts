// Stress mode for the browser mock (?stress): 5 agents with 3,000-item timelines and
// fast streaming into all of them at once. Used to measure rendering performance.
import type { Agent, TimelineItem } from "./types";

export const STRESS_AGENTS = 5;
export const STRESS_ITEMS = 3000;
/** Delta interval per agent (ms); 5 agents × 1 delta / 8 ms ≈ 625 events/s. */
export const STRESS_TICK_MS = 8;

const WORDS =
  "the quick token refresh race fix single flight promise interceptor retries queued requests with the refreshed token and a regression test that asserts one network call for concurrent callers".split(
    " ",
  );

function para(n: number, seed: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[(seed * 7 + i * 13) % WORDS.length]);
  return out.join(" ");
}

export function stressAgents(base: Agent): Agent[] {
  return Array.from({ length: STRESS_AGENTS }, (_, i) => ({
    ...base,
    id: `stress-${i + 1}`,
    title: `Stress ${i + 1}: 3k-item timeline`,
    status: "working",
    running: true,
    unread: false,
    archived: false,
    pendingPermissions: 0,
    lastMessage: "Streaming…",
    groupId: null,
    scheduleId: null,
    rateLimited: false,
    queue: [],
    queuedPrompts: 0,
    queuePaused: false,
    configChoices: {},
    lastActivityAt: Date.now(),
  }));
}

export function stressItems(agentId: string): TimelineItem[] {
  const items: TimelineItem[] = [];
  const t0 = Date.now() - STRESS_ITEMS * 1000;
  for (let i = 0; i < STRESS_ITEMS; i++) {
    const base = { id: `${agentId}-s${i}`, agentId, seq: i + 1, ts: t0 + i * 1000 };
    const k = i % 6;
    if (k === 0) items.push({ ...base, kind: "user_message", text: `Step ${i / 6}: ${para(18, i)}` });
    else if (k === 1) items.push({ ...base, kind: "thought", text: para(30, i) });
    else if (k === 2 || k === 3)
      items.push({
        ...base,
        kind: "tool_call",
        toolCallId: `tc-${agentId}-${i}`,
        title: k === 2 ? `Read src/module${i % 40}.ts` : `Run npm test -- shard ${i % 8}`,
        toolKind: k === 2 ? "read" : "execute",
        status: "completed",
        locations: k === 2 ? [`src/module${i % 40}.ts`] : [],
        diffs: [],
        output: k === 3 ? `✓ ${i % 50} tests passed\n` : "",
        command: k === 3 ? `npm test -- shard ${i % 8}` : null,
      });
    else
      items.push({
        ...base,
        kind: "agent_message",
        text: `## Result ${i}\n\n${para(60, i)}\n\n- ${para(10, i + 1)}\n- ${para(12, i + 2)}\n\n\`\`\`ts\nexport const v${i} = ${i};\n\`\`\``,
      });
  }
  return items;
}

export function isStressMode(): boolean {
  try {
    return new URLSearchParams(location.search).has("stress");
  } catch {
    return false;
  }
}

/** Next chunk of streamed text. */
export function stressWords(n: number, seed: number): string {
  return `${para(n, seed)} `;
}
