// Preview tab state per agent: dev servers detected from the agent's terminals and tool output
// (verified to be listening), the last URL used, and whether a new server is unseen.
import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@/lib/api";
import { detectDevUrls, urlPort } from "@/lib/ports";
import { useApp } from "@/store/app";
import { terminalTranscript, useWorkspace } from "@/store/workspace";

export interface PreviewState {
  /** Live servers, oldest first (the newest is last). */
  live: string[];
  /** Ports already shown to the user in the Preview tab (for the "new" dot). */
  seen: number[];
  /** Last URL the user viewed or typed. */
  url: string;
  width: number | null;
}

const EMPTY: PreviewState = { live: [], seen: [], url: "", width: null };
const KEY = "armada.preview.v1";

function load(): Record<string, PreviewState> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Partial<PreviewState>>;
    return Object.fromEntries(
      Object.entries(raw).map(([id, p]) => [
        id,
        { ...EMPTY, url: typeof p.url === "string" ? p.url : "", width: typeof p.width === "number" ? p.width : null },
      ]),
    );
  } catch {
    return {};
  }
}

interface Store {
  byAgent: Record<string, PreviewState>;
}
export const usePreview = create<Store>(() => ({ byAgent: load() }));

export function previewOf(s: Store, agentId: string): PreviewState {
  return s.byAgent[agentId] ?? EMPTY;
}

export function patchPreview(agentId: string, p: Partial<PreviewState>) {
  usePreview.setState((s) => ({ byAgent: { ...s.byAgent, [agentId]: { ...(s.byAgent[agentId] ?? EMPTY), ...p } } }));
  if ("url" in p || "width" in p) {
    try {
      const out = Object.fromEntries(
        Object.entries(usePreview.getState().byAgent).map(([id, v]) => [id, { url: v.url, width: v.width }]),
      );
      localStorage.setItem(KEY, JSON.stringify(out));
    } catch {
      /* storage unavailable: state still works in memory */
    }
  }
}

/** Marks every currently live server as seen (clears the dot). */
export function markPreviewSeen(agentId: string) {
  const cur = previewOf(usePreview.getState(), agentId);
  patchPreview(agentId, { seen: cur.live.map(urlPort) });
}

export function hasNewServer(s: PreviewState): boolean {
  return s.live.some((u) => !s.seen.includes(urlPort(u)));
}

const SCAN_TAIL = 200_000;

function candidates(agentId: string): string[] {
  const texts: string[] = [];
  for (const t of useWorkspace.getState().byAgent[agentId]?.terms ?? []) {
    texts.push(terminalTranscript(t.id).slice(-SCAN_TAIL));
  }
  const items = useApp.getState().items[agentId] ?? [];
  for (const it of items.slice(-60)) {
    if (it.kind === "tool_call" && it.output) texts.push(it.output.slice(-20_000));
    if (it.kind === "tool_call" && it.command) texts.push(it.command);
  }
  const urls: string[] = [];
  for (const d of detectDevUrls(texts.join("\n"))) urls.push(d.url);
  return urls;
}

const scanning = new Set<string>();

async function scan(agentId: string) {
  if (scanning.has(agentId)) return;
  scanning.add(agentId);
  try {
    const cand = candidates(agentId);
    const ports = [...new Set(cand.map(urlPort))].slice(-16);
    const up = new Set(ports.length ? await api.probePorts(ports) : []);
    const cur = previewOf(usePreview.getState(), agentId);
    // Keep known live servers that are still up, then append newly seen ones.
    const live = cur.live.filter((u) => up.has(urlPort(u)));
    for (const u of cand) if (up.has(urlPort(u)) && !live.some((l) => urlPort(l) === urlPort(u))) live.push(u);
    if (live.length !== cur.live.length || live.some((u, i) => u !== cur.live[i])) patchPreview(agentId, { live });
  } catch {
    /* probing is best effort */
  } finally {
    scanning.delete(agentId);
  }
}

const FAST_MS = 2500;
const SLOW_MS = 10_000;
/** After this long without a server, poll at SLOW_MS. */
const IDLE_AFTER_MS = 30_000;

const active = () => document.visibilityState === "visible" && document.hasFocus();

/**
 * Polls for dev servers of `agentId` while the workspace panel is open, the window is visible and
 * focused. Backs off when no server has been seen for a while; scans at once on focus.
 */
export function usePreviewDetection(agentId: string) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastSeen = Date.now();
    let stopped = false;
    let running = false;
    const tick = async () => {
      timer = undefined;
      if (stopped || running || !active()) return; // resumes on focus / visibility
      running = true;
      await scan(agentId);
      running = false;
      if (stopped) return;
      if (previewOf(usePreview.getState(), agentId).live.length) lastSeen = Date.now();
      const idle = Date.now() - lastSeen > IDLE_AFTER_MS;
      timer = setTimeout(() => void tick(), idle ? SLOW_MS : FAST_MS);
    };
    const wake = () => {
      if (!active()) return;
      if (timer) clearTimeout(timer);
      timer = undefined;
      void tick();
    };
    wake();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [agentId]);
}
