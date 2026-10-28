// Workspace panel sessions: shells and script runs per agent. The PTYs live in the backend
// and keep running while the panel is closed or another agent is on screen; here we keep a
// capped transcript per terminal so a re-mounted view can replay what it missed.
import { create } from "zustand";
import { api } from "@/lib/api";
import { attachTerminal } from "@/lib/terminal-bus";
import { errorMessage } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";

export interface WsTerm {
  id: string;
  title: string;
  /** Undefined while running; the exit code (null if killed by a signal) afterwards. */
  exit?: number | null;
}

interface AgentWs {
  /** Registry tab shown (see components/workspace/tabs). */
  tab: string;
  terms: WsTerm[];
  /** Terminal shown in the Terminal tab. */
  active: string | null;
  /** A first shell has been started for this agent; closing them all doesn't start another. */
  autoStarted: boolean;
}

/** Live view of a terminal, set while its xterm is mounted. */
export interface WsView {
  write: (data: string) => void;
  /** Selected text, or the last `lines` lines of the scrollback. */
  snapshot: (lines: number) => { text: string; selection: boolean };
}

interface Runtime {
  agentId: string;
  data: string;
  view?: WsView;
  detach: () => void;
}

export const MAX_TERMINALS_PER_AGENT = 8;
const TRANSCRIPT_MAX = 1_000_000;
const TRANSCRIPT_KEEP = 700_000;

const runtime = new Map<string, Runtime>();

export function terminalTranscript(id: string): string {
  return runtime.get(id)?.data ?? "";
}

export function setTerminalView(id: string, view: WsView | undefined) {
  const r = runtime.get(id);
  if (r) r.view = view;
}

export function terminalView(id: string): WsView | undefined {
  return runtime.get(id)?.view;
}

const EMPTY: AgentWs = { tab: "terminal", terms: [], active: null, autoStarted: false };

interface WsStore {
  byAgent: Record<string, AgentWs>;
  setTab: (agentId: string, tab: string) => void;
  setActive: (agentId: string, id: string) => void;
}

export const useWorkspace = create<WsStore>(() => ({
  byAgent: {},
  setTab: (agentId, tab) => patchAgent(agentId, { tab }),
  setActive: (agentId, id) => patchAgent(agentId, { tab: "terminal", active: id }),
}));

function patchAgent(agentId: string, p: Partial<AgentWs>) {
  useWorkspace.setState((s) => ({
    byAgent: { ...s.byAgent, [agentId]: { ...(s.byAgent[agentId] ?? EMPTY), ...p } },
  }));
}

export function agentWs(s: WsStore, agentId: string): AgentWs {
  return s.byAgent[agentId] ?? EMPTY;
}

function setExit(agentId: string, id: string, code: number | null) {
  const cur = useWorkspace.getState().byAgent[agentId];
  if (!cur) return;
  patchAgent(agentId, { terms: cur.terms.map((t) => (t.id === id ? { ...t, exit: code } : t)) });
}

const opening = new Set<string>();

/** Starts a shell (or a detected script) in the agent's folder and shows it. */
export async function openTerminal(
  agentId: string,
  opts: { scriptId?: string; title?: string } = {},
): Promise<string | undefined> {
  const cur = useWorkspace.getState().byAgent[agentId] ?? EMPTY;
  if (cur.terms.length >= MAX_TERMINALS_PER_AGENT) {
    throw new Error(`At most ${MAX_TERMINALS_PER_AGENT} terminals per agent. Close one first.`);
  }
  if (opening.has(agentId)) return undefined;
  opening.add(agentId);
  try {
    patchAgent(agentId, { autoStarted: true });
    const id = await api.workspaceTerminalOpen(agentId, opts.scriptId);
    // The agent may have been deleted while the shell started.
    if (!useApp.getState().agents[agentId]) {
      void api.terminalKill(id).catch(() => {});
      return undefined;
    }
    const rt: Runtime = { agentId, data: "", detach: () => {} };
    runtime.set(id, rt);
    rt.detach = attachTerminal(id, {
      write: (d) => {
        rt.data += d;
        if (rt.data.length > TRANSCRIPT_MAX) {
          const cut = rt.data.length - TRANSCRIPT_KEEP;
          const nl = rt.data.indexOf("\n", cut);
          rt.data = rt.data.slice(nl >= 0 ? nl + 1 : cut);
        }
        rt.view?.write(d);
      },
      exit: (code) => {
        const line = `\r\n\x1b[2m[process exited${code !== null ? ` with code ${code}` : ""}]\x1b[0m\r\n`;
        rt.data += line;
        rt.view?.write(line);
        setExit(agentId, id, code);
      },
    });
    const now = useWorkspace.getState().byAgent[agentId] ?? EMPTY;
    const n = now.terms.length + 1;
    patchAgent(agentId, {
      tab: "terminal",
      terms: [...now.terms, { id, title: opts.title ?? `Terminal ${n}` }],
      active: id,
    });
    return id;
  } finally {
    opening.delete(agentId);
  }
}

export function closeTerminal(agentId: string, id: string) {
  const cur = useWorkspace.getState().byAgent[agentId];
  const t = cur?.terms.find((x) => x.id === id);
  if (!cur || !t) return;
  if (t.exit === undefined) void api.terminalKill(id).catch(() => {});
  const rt = runtime.get(id);
  rt?.detach();
  runtime.delete(id);
  const terms = cur.terms.filter((x) => x.id !== id);
  const idx = cur.terms.findIndex((x) => x.id === id);
  patchAgent(agentId, {
    terms,
    active: cur.active === id ? (terms[Math.min(idx, terms.length - 1)]?.id ?? null) : cur.active,
  });
}

/** Ends every terminal of an agent (agent deleted). */
export function disposeAgentTerminals(agentId: string) {
  const cur = useWorkspace.getState().byAgent[agentId];
  if (!cur) return;
  for (const t of cur.terms) {
    if (t.exit === undefined) void api.terminalKill(t.id).catch(() => {});
    runtime.get(t.id)?.detach();
    runtime.delete(t.id);
  }
  useWorkspace.setState((s) => {
    const { [agentId]: _gone, ...rest } = s.byAgent;
    return { byAgent: rest };
  });
}

// Deleting an agent ends its terminals. Agents only ever disappear from the store when deleted.
useApp.subscribe((state, prev) => {
  for (const id of Object.keys(useWorkspace.getState().byAgent)) {
    if (prev.agents[id] && !state.agents[id]) disposeAgentTerminals(id);
  }
});

/**
 * "Run" on a code block in an agent message: opens a NEW terminal (a login shell in the agent's
 * own folder, via the same workspace_terminal_open as the + button, no script) and types the text
 * into it through the existing terminal_write command. The webview thereby supplies arbitrary
 * text to the user's own shell, which is acceptable only because it follows the user's explicit
 * click on their own machine. No new Tauri command or capability; callers confirm destructive
 * commands first (lib/shellRun isDestructive).
 */
export async function runInNewTerminal(agentId: string, title: string, payload: string): Promise<void> {
  const id = await openTerminal(agentId, { title });
  if (!id) throw new Error("A terminal is already starting. Try again in a moment.");
  useUi.getState().setWorkspaceOpen(true);
  // Wait for the shell's first output (its prompt) so the text isn't swallowed by startup.
  for (let i = 0; i < 40 && !(runtime.get(id)?.data.length ?? 0); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 150));
  await api.terminalWrite(id, payload);
}

/** Opens a shell, reporting failures as a message (for UI handlers). */
export function openTerminalSafe(
  agentId: string,
  opts?: { scriptId?: string; title?: string },
  onError?: (m: string) => void,
) {
  return openTerminal(agentId, opts).catch((e: unknown) => onError?.(errorMessage(e)));
}
