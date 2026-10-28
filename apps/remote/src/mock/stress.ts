/**
 * Dev-only stress scenario: a huge, varied timeline plus a fast stream of
 * deltas, for measuring scroll and typing smoothness (`?mock=1&stress=1`).
 */
import type { Agent, TimelineItem, ToolCallItem } from "@/lib/types";

/** Small deterministic PRNG so runs are comparable. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const WORDS =
  "the agent reads files refactors code runs tests updates types fixes bugs adds hooks caches requests streams output reviews diffs plans steps checks lint builds bundle migrates pages api client session token retry error state".split(
    " ",
  );

function sentence(r: () => number, n: number) {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(r() * WORDS.length)]);
  const s = out.join(" ");
  return s[0].toUpperCase() + s.slice(1) + ".";
}

function markdown(r: () => number) {
  const parts = [sentence(r, 14 + Math.floor(r() * 20)), sentence(r, 10)];
  if (r() < 0.5) parts.push(["- " + sentence(r, 6), "- " + sentence(r, 8), "- `" + WORDS[3] + "()` " + sentence(r, 5)].join("\n"));
  if (r() < 0.3) parts.push("```ts\nexport function useApi<T>(url: string) {\n  const [data, setData] = useState<T | null>(null);\n  return { data };\n}\n```");
  if (r() < 0.2) parts.push("**Note:** " + sentence(r, 12));
  return parts.join("\n\n");
}

export function stressAgent(base: Agent): Agent {
  return { ...base, id: "s1", title: "Stress test", status: "working", running: true, unread: false, archived: false, pendingPermissions: 0, queue: [], queuedPrompts: 0 };
}

export function stressTimeline(count: number): TimelineItem[] {
  const r = rng(42);
  const items: TimelineItem[] = [];
  let seq = 0;
  const now = Date.now() - count * 5_000;
  const push = (it: Omit<TimelineItem, "id" | "agentId" | "seq" | "ts">) => {
    seq++;
    items.push({ id: `s1-${seq}`, agentId: "s1", seq, ts: now + seq * 5_000, ...it } as TimelineItem);
  };
  const tool = (extra: Partial<ToolCallItem> = {}) => {
    const kinds = ["read", "edit", "search", "execute"] as const;
    const kind = kinds[Math.floor(r() * kinds.length)];
    push({
      kind: "tool_call",
      toolCallId: `tc-s1-${seq + 1}`,
      title: `${kind === "execute" ? "Run" : kind[0].toUpperCase() + kind.slice(1)} src/${WORDS[Math.floor(r() * WORDS.length)]}.ts`,
      toolKind: kind,
      status: r() < 0.06 ? "failed" : "completed",
      locations: [],
      diffs: [],
      output: kind === "execute" || kind === "search" ? Array.from({ length: 4 }, () => sentence(r, 6)).join("\n") : "",
      command: kind === "execute" ? "npm test -- --runInBand" : null,
      ...extra,
    } as Omit<ToolCallItem, "id" | "agentId" | "seq" | "ts">);
  };
  while (items.length < count) {
    push({ kind: "user_message", text: sentence(r, 8 + Math.floor(r() * 25)) } as never);
    if (r() < 0.6) push({ kind: "thought", text: sentence(r, 30) } as never);
    const tools = 2 + Math.floor(r() * 5);
    for (let i = 0; i < tools; i++) tool();
    if (r() < 0.15) {
      const parent = `tc-s1-sub-${seq}`;
      tool({ toolCallId: parent, subagent: { kind: "Explore", description: sentence(r, 6), prompt: sentence(r, 20) } });
      for (let i = 0; i < 3; i++) tool({ parentToolCallId: parent });
    }
    if (r() < 0.1) push({ kind: "plan", entries: Array.from({ length: 4 }, (_, i) => ({ content: sentence(r, 5), status: i < 2 ? "completed" : "pending", priority: null })) } as never);
    push({ kind: "agent_message", text: markdown(r) } as never);
    if (r() < 0.5)
      push({ kind: "turn_summary", durationMs: 60_000 + Math.floor(r() * 600_000), files: ["src/a.ts", "src/b.ts"], toolCalls: tools, commands: 2, costUsd: 0.12, tokens: 15_000 } as never);
  }
  // End on a message that is being streamed into.
  push({ kind: "agent_message", text: "" } as never);
  return items;
}

/** Next chunk of streamed text (a few words). */
export function streamChunk(i: number): string {
  const w = WORDS[i % WORDS.length];
  return i % 37 === 36 ? `${w}.\n\n` : `${w} `;
}
