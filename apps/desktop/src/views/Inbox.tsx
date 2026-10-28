import { Inbox } from "lucide-react";
import { m, AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InboxCard } from "@/components/inbox/InboxCard";
import { InboxZero } from "@/components/inbox/InboxZero";
import { PageHeader } from "@/components/PageHeader";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip } from "@/components/ui/tooltip";
import { useNow } from "@/hooks/useNow";
import { findOption, respondPermission } from "@/lib/actions";
import { relativeTimeLong } from "@/lib/format";
import type { Agent, PermissionOption } from "@/lib/types";
import { isEditableTarget } from "@/lib/utils";

import { useApp, usePendingPermissions, type PendingPermission } from "@/store/app";
import { useUi } from "@/store/ui";
import { approvalActionFor, createArm, shouldIgnoreApprovalKey } from "@/lib/approvalKeys";

export function InboxView() {
  const agents = useApp((s) => s.agents);
  const accounts = useApp((s) => s.accounts);
  const openAgent = useUi((s) => s.openAgent);
  const now = useNow();

  const queue = usePendingPermissions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  // Re-entry guard for keyboard answers: a held key or a fast second press must not
  // answer the next request while the current one is still in flight.
  const inFlight = useRef(false);
  const [handled, setHandled] = useState(0);
  const lastIndex = useRef(0);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  // Make sure every agent waiting on us has its timeline loaded.
  const waitingIds = Object.values(agents)
    .filter((a) => a.pendingPermissions > 0)
    .map((a) => a.id)
    .join(",");
  useEffect(() => {
    if (!waitingIds) return;
    for (const id of waitingIds.split(",")) void useApp.getState().ensureItems(id);
  }, [waitingIds]);

  // Keep a valid selection; when the selected item disappears, take its neighbor.
  const selectedIndex = queue.findIndex((p) => p.item.id === selectedId);
  useEffect(() => {
    if (queue.length === 0) return;
    if (selectedIndex < 0) {
      const idx = Math.min(lastIndex.current, queue.length - 1);
      setSelectedId(queue[idx].item.id);
    } else {
      lastIndex.current = selectedIndex;
    }
  }, [queue, selectedIndex]);

  const selected: PendingPermission | undefined = queue[selectedIndex];

  // Scroll only the list container (scrollIntoView would also scroll overflow-hidden ancestors).
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = selectedId ? cardRefs.current.get(selectedId) : null;
    const box = listRef.current;
    if (!el || !box) return;
    const raf = requestAnimationFrame(() => {
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      const bottom = top + el.offsetHeight;
      const pad = 16;
      if (top - pad < box.scrollTop) box.scrollTo({ top: top - pad, behavior: "smooth" });
      else if (bottom + pad > box.scrollTop + box.clientHeight)
        box.scrollTo({ top: bottom + pad - box.clientHeight, behavior: "smooth" });
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedId]);

  const respond = useCallback(async (p: PendingPermission, option: PermissionOption) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const key = p.item.id;
    setBusy((b) => new Set(b).add(key));
    try {
      await respondPermission(p.agent.id, p.item, option);
      setHandled((h) => h + 1);
    } finally {
      inFlight.current = false;
      setBusy((b) => {
        const n = new Set(b);
        n.delete(key);
        return n;
      });
    }
  }, []);

  const move = useCallback(
    (delta: number) => {
      if (queue.length === 0) return;
      const idx = selectedIndex < 0 ? 0 : (selectedIndex + delta + queue.length) % queue.length;
      setSelectedId(queue[idx].item.id);
    },
    [queue, selectedIndex],
  );

  // "Always allow" is irreversible: Shift+A arms, a second Shift+A within a moment confirms.
  const [alwaysArmed, setAlwaysArmed] = useState(false);
  const arm = useRef(createArm());
  useEffect(() => {
    arm.current.reset();
    setAlwaysArmed(false);
  }, [selected?.item.id]);

  // Keyboard (see lib/approvalKeys): J/K move · A allow once · ⇧A always (twice) · D deny · ⇧D / ⏎ open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      if (ui.paletteOpen || ui.newAgent.open || ui.terminal || ui.reviewAgentId) return;
      const action = approvalActionFor(e);
      if (action) {
        // Holding a key must never answer a chain of requests (shouldIgnore covers e.repeat).
        if (shouldIgnoreApprovalKey(e) || !selected || inFlight.current || busy.has(selected.item.id)) return;
        e.preventDefault();
        const it = selected.item;
        if (action === "deny_reason") {
          openAgent(selected.agent.id);
          return;
        }
        if (action === "allow_always") {
          const opt = findOption(it, ["allow_always"]);
          if (opt && arm.current.press("always", setAlwaysArmed)) void respond(selected, opt);
          return;
        }
        const opt =
          action === "allow_once" ? findOption(it, ["allow_once"]) : findOption(it, ["reject_once", "reject_always"]);
        if (opt) void respond(selected, opt);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || e.repeat) return;
      if (isEditableTarget(e.target)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      const key = e.key.toLowerCase();
      if (key === "j") {
        e.preventDefault();
        move(1);
      } else if (key === "k") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "Enter" && selected) {
        // Let focused buttons handle their own Enter.
        if (e.target instanceof HTMLElement && e.target.closest("button, a")) return;
        e.preventDefault();
        openAgent(selected.agent.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, selected, busy, respond, openAgent]);

  // Arrow keys move only while focus is in the list (roving focus between cards).
  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (e.target instanceof HTMLElement && e.target.closest("button, a, input, textarea")) return;
    e.preventDefault();
    if (queue.length === 0) return;
    const idx =
      selectedIndex < 0 ? 0 : (selectedIndex + (e.key === "ArrowDown" ? 1 : -1) + queue.length) % queue.length;
    const id = queue[idx].item.id;
    setSelectedId(id);
    requestAnimationFrame(() => cardRefs.current.get(id)?.focus());
  };

  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  // Stable callbacks/refs so memoized cards skip re-rendering when nothing about them changed.
  const onRespond = useCallback(
    (agent: Agent, item: PendingPermission["item"], o: PermissionOption) => void respond({ agent, item }, o),
    [respond],
  );
  const refSetters = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  const refFor = (id: string) => {
    let fn = refSetters.current.get(id);
    if (!fn) {
      fn = (el) => {
        if (el) cardRefs.current.set(id, el);
        else {
          cardRefs.current.delete(id);
          refSetters.current.delete(id);
        }
      };
      refSetters.current.set(id, fn);
    }
    return fn;
  };
  const oldest = queue[0]?.item.ts;

  return (
    <div className="@container flex h-full flex-col">
      <PageHeader
        icon={<Inbox />}
        title="Inbox"
        subtitle={
          queue.length === 0 ? (
            "Nothing waiting on you"
          ) : (
            <>
              <span className="tabular text-warn">{queue.length}</span> waiting for approval
              {oldest ? ` · oldest ${relativeTimeLong(oldest, now)}` : ""}
            </>
          )
        }
      />

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto" onKeyDown={onListKeyDown}>
        {queue.length === 0 ? (
          <InboxZero handled={handled} />
        ) : (
          <div
            role="list"
            aria-label="Pending approvals"
            className="mx-auto max-w-3xl space-y-2 px-3 py-4 @md:px-4 @2xl:px-6 @2xl:py-5"
          >
            <AnimatePresence initial={false} mode="popLayout">
              {queue.map((p) => (
                <m.div
                  key={p.item.id}
                  layout="position"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: 24, transition: { duration: 0.14 } }}
                  transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
                >
                  <InboxCard
                    ref={refFor(p.item.id)}
                    agent={p.agent}
                    item={p.item}
                    account={accountMap.get(p.agent.accountId)}
                    selected={p.item.id === selected?.item.id}
                    busy={busy.has(p.item.id)}
                    now={now}
                    onSelect={setSelectedId}
                    onOpen={openAgent}
                    onRespond={onRespond}
                  />
                </m.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {alwaysArmed && (
        <p
          role="status"
          className="shrink-0 border-t border-warn/30 bg-warn/10 px-4 py-2 text-center text-[12px] text-warn"
        >
          Press <Kbd>⇧</Kbd>
          <Kbd>A</Kbd> again to always allow this kind of request.
        </p>
      )}
      {queue.length > 0 && (
        <div className="texture flex h-10 shrink-0 items-center justify-center gap-4 border-t border-line bg-panel px-3 text-[11.5px] text-steel @3xl:gap-5">
          <Hint keys={["J", "K"]} label="Move" />
          <Hint keys={["A"]} label="Allow" />
          <span className="hidden @3xl:contents">
            <Hint keys={["⇧", "A"]} label="Always (twice)" />
          </span>
          <Hint keys={["D"]} label="Deny" />
          <span className="hidden @3xl:contents">
            <Hint keys={["↵"]} label="Open agent" />
          </span>
          <Tooltip
            content={
              <span className="flex flex-col gap-1 py-0.5">
                <Hint keys={["J", "K"]} label="Move between requests" />
                <Hint keys={["A"]} label="Allow once" />
                <Hint keys={["⇧", "A"]} label="Always allow (press twice)" />
                <Hint keys={["D"]} label="Deny" />
                <Hint keys={["⇧", "D"]} label="Deny with a reason (opens the agent)" />
                <Hint keys={["↵"]} label="Open the agent" />
              </span>
            }
          >
            <button
              type="button"
              aria-label="All keyboard shortcuts"
              className="flex h-6 w-6 items-center justify-center rounded-md border border-line-strong text-[11px] font-medium text-muted transition-colors hover:text-fg @3xl:hidden"
            >
              ?
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

function Hint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="flex gap-0.5">
        {keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
      {label}
    </span>
  );
}
