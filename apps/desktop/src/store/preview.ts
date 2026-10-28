// Preview pane state per agent: dev servers detected from the agent's terminals, tool output and
// messages (verified to be listening), the last URL used, and whether a new server is unseen.
import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@/lib/api";
import { rankDevUrls, urlPort, type DetectedUrl } from "@/lib/ports";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { terminalTranscript, useWorkspace } from "@/store/workspace";

export interface PreviewState {
  /** Live servers, least recently mentioned first (the most recently mentioned is last). */
  live: string[];
  /** Ports already shown to the user in the Preview pane (for the "new" dot). */
  seen: number[];
  /** Last URL the user viewed or typed. */
  url: string;
  width: number | null;
  /** `url` was picked by detection (not typed / chosen / opened from a link), so detection may update it. */
  auto: boolean;
  /** The side pane is showing for this agent. Memory only. */
  open: boolean;
  /** The pane fills the whole agent view. Memory only. */
  maximized: boolean;
}

const EMPTY: PreviewState = { live: [], seen: [], url: "", width: null, auto: true, open: false, maximized: false };
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

/**
 * Shows `agentId`'s Preview pane (right of the conversation) and loads `url` (already a loopback URL;
 * see parseLoopbackUrl) when given. A URL given here counts as the user's choice: detection won't replace it.
 */
export function openPreview(agentId: string, url?: string) {
  const ui = useUi.getState();
  if (ui.view !== "agents" || ui.selectedAgentId !== agentId) ui.openAgent(agentId);
  patchPreview(agentId, url ? { open: true, url, auto: false } : { open: true });
  markPreviewSeen(agentId);
}

export function closePreview(agentId: string) {
  patchPreview(agentId, { open: false, maximized: false });
}

export function togglePreview(agentId: string) {
  if (previewOf(usePreview.getState(), agentId).open) closePreview(agentId);
  else openPreview(agentId);
}

/** Marks every currently live server as seen (clears the dot). */
export function markPreviewSeen(agentId: string) {
  const cur = previewOf(usePreview.getState(), agentId);
  patchPreview(agentId, { seen: cur.live.map(urlPort) });
}

export function hasNewServer(s: PreviewState): boolean {
  return s.live.some((u) => !s.seen.includes(urlPort(u)));
}

/**
 * Next `live` list: servers from `ranked` (ascending recency) that are up, preceded by previously live
 * servers that are still up but no longer mentioned in the scanned text.
 */
export function rankLive(ranked: DetectedUrl[], up: ReadonlySet<number>, prev: string[]): string[] {
  const mentioned = new Set(ranked.map((r) => r.port));
  const kept = prev.filter((u) => up.has(urlPort(u)) && !mentioned.has(urlPort(u)));
  return [...kept, ...ranked.filter((r) => up.has(r.port)).map((r) => r.url)];
}

/** URL detection should select: the most recently mentioned live server, unless the user chose one. */
export function autoSelect(cur: Pick<PreviewState, "url" | "auto">, live: string[]): string | null {
  const newest = live[live.length - 1];
  if (!newest || cur.url === newest) return null;
  return cur.auto || !cur.url ? newest : null;
}

const SCAN_TAIL = 200_000;

function candidates(agentId: string): DetectedUrl[] {
  // Terminals first (no timestamps), then the conversation, which is chronological: whatever the
  // agent said last ranks highest.
  const texts: string[] = [];
  for (const t of useWorkspace.getState().byAgent[agentId]?.terms ?? []) {
    texts.push(terminalTranscript(t.id).slice(-SCAN_TAIL));
  }
  const items = useApp.getState().items[agentId] ?? [];
  for (const it of items.slice(-60)) {
    if (it.kind === "tool_call") {
      if (it.command) texts.push(it.command);
      if (it.output) texts.push(it.output.slice(-20_000));
    } else if (it.kind === "agent_message" && it.text) {
      texts.push(it.text.slice(-20_000));
    }
  }
  return rankDevUrls(texts.join("\n"));
}

const scanning = new Set<string>();
const lastProbe = new Map<string, { sig: string; at: number }>();

/** Probes the agent's candidate ports. Skips when nothing changed and the last probe is recent (`minGap`). */
async function scan(agentId: string, minGap: number) {
  if (scanning.has(agentId)) return;
  scanning.add(agentId);
  try {
    const ranked = candidates(agentId);
    const sig = ranked.map((r) => r.url).join(" ");
    const prev = lastProbe.get(agentId);
    if (prev && prev.sig === sig && Date.now() - prev.at < minGap) return;
    lastProbe.set(agentId, { sig, at: Date.now() });
    const recent = ranked.slice(-16);
    const up = new Set(recent.length ? await api.probePorts(recent.map((r) => r.port)) : []);
    const cur = previewOf(usePreview.getState(), agentId);
    const live = rankLive(recent, up, cur.live);
    if (live.length !== cur.live.length || live.some((u, i) => u !== cur.live[i])) patchPreview(agentId, { live });
    const pick = autoSelect(previewOf(usePreview.getState(), agentId), live);
    if (pick) patchPreview(agentId, { url: pick, auto: true });
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
/** Conversation changes trigger a (cheap, signature-gated) rescan at most this often. */
const ITEMS_THROTTLE_MS = 2000;

const active = () => document.visibilityState === "visible" && document.hasFocus();

/**
 * Detects dev servers of `agentId` while it is on screen and the window is visible and focused.
 * With the pane open (`fast`) it polls every few seconds; otherwise only every 10s, plus when the
 * conversation changes. Backs off when no server has been seen for a while; scans at once on focus.
 */
export function usePreviewDetection(agentId: string, fast: boolean) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let itemsTimer: ReturnType<typeof setTimeout> | undefined;
    let lastSeen = Date.now();
    let stopped = false;
    let running = false;
    const minGap = fast ? FAST_MS : SLOW_MS;
    const tick = async () => {
      timer = undefined;
      if (stopped || running || !active()) return; // resumes on focus / visibility
      running = true;
      await scan(agentId, minGap);
      running = false;
      if (stopped) return;
      if (previewOf(usePreview.getState(), agentId).live.length) lastSeen = Date.now();
      const idle = Date.now() - lastSeen > IDLE_AFTER_MS;
      timer = setTimeout(() => void tick(), fast && !idle ? FAST_MS : SLOW_MS);
    };
    const wake = () => {
      if (!active()) return;
      if (timer) clearTimeout(timer);
      timer = undefined;
      void tick();
    };
    wake();
    const unsub = useApp.subscribe((s, prev) => {
      if (s.items[agentId] === prev.items[agentId] || itemsTimer) return;
      itemsTimer = setTimeout(() => {
        itemsTimer = undefined;
        if (!stopped && active()) void scan(agentId, minGap);
      }, ITEMS_THROTTLE_MS);
    });
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (itemsTimer) clearTimeout(itemsTimer);
      unsub();
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [agentId, fast]);
}
