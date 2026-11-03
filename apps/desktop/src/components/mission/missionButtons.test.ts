// A card or row that opens an agent holds buttons of its own (Allow, Deny, Answer, Resume). A button can't sit
// inside another button for the keyboard and screen readers, so the opener is one element and those buttons
// are its siblings.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { QuestionItem } from "@/lib/question";
import { seedAgents } from "@/lib/mock-data";
import type { Agent, TimelineItem } from "@/lib/types";

vi.mock("@/lib/api", () => ({ api: {} }));
// The shared clock needs a client to subscribe to; a fixed time is all a markup test wants.
vi.mock("@/hooks/useNow", () => ({ useNow: () => 1_700_000_000_000 }));

const { TooltipProvider } = await import("@/components/ui/tooltip");
const { AgentTile } = await import("./AgentTile");
const { AgentRowCompact } = await import("./AgentRowCompact");

type PermissionItem = Extract<TimelineItem, { kind: "permission" }>;

const summary = { action: "Run npm test", message: "Working on it", messageIsTail: true, tail: null, subagents: 1 };
const permission = {
  id: "p1",
  agentId: "a",
  seq: 1,
  ts: 1,
  kind: "permission",
  requestId: "r1",
  title: "Create a file",
  toolKind: null,
  command: null,
  diffs: [],
  options: [
    { id: "y", name: "Yes", kind: "allow_once" },
    { id: "n", name: "No", kind: "reject_once" },
  ],
  resolution: null,
} as PermissionItem;
const question = { message: "Which database?" } as QuestionItem;
const agent = (over: Partial<Agent>): Agent => ({ ...seedAgents()[0], id: "a", title: "Fix the build", ...over });

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
const INTERACTIVE = /^(button|a|input|select|textarea)$/;

interface Found {
  tag: string;
  attrs: string;
  /** Interactive elements found inside this one. */
  inside: string[];
}

/** Every role="button" element in the markup, with the interactive elements it contains. */
function openers(html: string): Found[] {
  const out: Found[] = [];
  const stack: { tag: string; found: Found | null }[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const [, close, tag, attrs] = m;
    if (close) {
      while (stack.length && stack.pop()!.tag !== tag);
      continue;
    }
    const interactive = INTERACTIVE.test(tag) || /\stabindex=/.test(attrs) || /\srole="button"/.test(attrs);
    if (interactive)
      for (const s of stack) s.found?.inside.push(tag + (attrs.match(/\saria-label="[^"]*"/)?.[0] ?? ""));
    if (VOID.has(tag) || attrs.endsWith("/")) continue;
    const found = /\srole="button"/.test(attrs) ? { tag, attrs, inside: [] } : null;
    if (found) out.push(found);
    stack.push({ tag, found });
  }
  return out;
}

const rendered = {
  tile: (a: Agent, over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(AgentTile, { agent: a, account: undefined, summary, pending: null, onOpen: () => {}, ...over }),
      ),
    ),
  row: (a: Agent, over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(AgentRowCompact, {
          agent: a,
          account: undefined,
          summary,
          pending: null,
          onOpen: () => {},
          ...over,
        }),
      ),
    ),
};

const cases: [string, (a: Agent, o?: Record<string, unknown>) => string][] = [
  ["Mission Control tile", rendered.tile],
  ["compact row", rendered.row],
];

describe.each(cases)("%s", (_name, render) => {
  const variants: [string, Agent, Record<string, unknown>, string[]][] = [
    ["waiting for an approval", agent({ status: "needs_permission" }), { pending: permission }, ["Allow", "Deny"]],
    ["waiting for an answer", agent({ status: "needs_permission" }), { question }, ["Answer"]],
    ["after an error", agent({ status: "error", rateLimited: true, running: false }), {}, ["Switch account", "Resume"]],
    ["working", agent({ status: "working" }), {}, []],
  ];

  it.each(variants)("has one opener with no button inside it: %s", (_v, a, props, labels) => {
    const html = render(a, props);
    const found = openers(html);
    expect(found).toHaveLength(1);
    expect(found[0].inside).toEqual([]);
    expect(found[0].attrs).toContain('tabindex="0"');
    expect(found[0].attrs).toContain(`aria-label="Fix the build, `);
    // The buttons are still there, beside the opener.
    for (const label of labels) expect(html).toContain(label);
    expect((html.match(/<button/g) ?? []).length).toBeGreaterThanOrEqual(labels.length);
  });

  it("keeps data-agent-id on the outer element so clicks resolve to the agent", () => {
    expect(render(agent({}))).toMatch(/^<div data-agent-id="a"/);
  });

  it("does not make the outer element a second tab stop", () => {
    const html = render(agent({ status: "needs_permission" }), { pending: permission });
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(1);
  });
});

describe("the helper", () => {
  it("finds a button inside a button", () => {
    expect(openers('<div role="button" tabindex="0"><span>x</span><button>y</button></div>')).toEqual([
      expect.objectContaining({ inside: ["button"] }),
    ]);
    expect(openers('<div role="button" tabindex="0"><svg><path d="M0"></path></svg></div><button>y</button>')).toEqual([
      expect.objectContaining({ inside: [] }),
    ]);
  });
});
