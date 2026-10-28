import { Inbox } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InboxCard } from "@/components/inbox/InboxCard";
import { InboxZero } from "@/components/inbox/InboxZero";
import { PageHeader } from "@/components/PageHeader";
import { Kbd } from "@/components/ui/kbd";
import { useNow } from "@/hooks/useNow";
import { findOption, respondPermission } from "@/lib/actions";
import { relativeTimeLong } from "@/lib/format";
import type { PermissionOption } from "@/lib/types";
import { isEditableTarget } from "@/lib/utils";
import { collectPending, useApp, type PendingPermission } from "@/store/app";
import { useUi } from "@/store/ui";

export function InboxView() {
  const agents = useApp((s) => s.agents);
  const items = useApp((s) => s.items);
  const accounts = useApp((s) => s.accounts);
  const openAgent = useUi((s) => s.openAgent);
  const now = useNow();

  const queue = useMemo(() => collectPending({ agents, items }), [agents, items]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
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
    const key = p.item.id;
    setBusy((b) => new Set(b).add(key));
    await respondPermission(p.agent.id, p.item, option);
    setHandled((h) => h + 1);
    setBusy((b) => {
      const n = new Set(b);
      n.delete(key);
      return n;
    });
  }, []);

  const move = useCallback(
    (delta: number) => {
      if (queue.length === 0) return;
      const idx = selectedIndex < 0 ? 0 : (selectedIndex + delta + queue.length) % queue.length;
      setSelectedId(queue[idx].item.id);
    },
    [queue, selectedIndex],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (isEditableTarget(e.target)) return;
      const ui = useUi.getState();
      if (ui.paletteOpen || ui.newAgent.open || ui.terminal || ui.reviewAgentId) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      const key = e.key.toLowerCase();
      if (key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (selected && !busy.has(selected.item.id)) {
        const it = selected.item;
        let opt: PermissionOption | undefined;
        if (key === "a" && e.shiftKey) opt = findOption(it, ["allow_always"]);
        else if (key === "a") opt = findOption(it, ["allow_once", "allow_always"]);
        else if (key === "d") opt = findOption(it, ["reject_once", "reject_always"]);
        else if (e.key === "Enter") {
          // Let focused buttons handle their own Enter.
          if (e.target instanceof HTMLElement && e.target.closest("button, a")) return;
          e.preventDefault();
          openAgent(selected.agent.id);
          return;
        }
        if (opt) {
          e.preventDefault();
          void respond(selected, opt);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, selected, busy, respond, openAgent]);

  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const oldest = queue[0]?.item.ts;

  return (
    <div className="flex h-full flex-col">
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

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Pending approvals">
        {queue.length === 0 ? (
          <InboxZero handled={handled} />
        ) : (
          <div className="mx-auto max-w-3xl space-y-2 px-6 py-5">
            <AnimatePresence initial={false} mode="popLayout">
              {queue.map((p) => (
                <motion.div
                  key={p.item.id}
                  layout="position"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: 24, transition: { duration: 0.14 } }}
                  transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
                >
                  <InboxCard
                    ref={(el) => {
                      if (el) cardRefs.current.set(p.item.id, el);
                      else cardRefs.current.delete(p.item.id);
                    }}
                    agent={p.agent}
                    item={p.item}
                    account={accountMap.get(p.agent.accountId)}
                    selected={p.item.id === selected?.item.id}
                    busy={busy.has(p.item.id)}
                    now={now}
                    onSelect={() => setSelectedId(p.item.id)}
                    onOpen={() => openAgent(p.agent.id)}
                    onRespond={(o) => void respond(p, o)}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {queue.length > 0 && (
        <div className="texture flex h-10 shrink-0 items-center justify-center gap-5 border-t border-line bg-panel text-[11.5px] text-steel">
          <Hint keys={["J", "K"]} label="Move" />
          <Hint keys={["A"]} label="Allow" />
          <Hint keys={["⇧", "A"]} label="Always allow" />
          <Hint keys={["D"]} label="Deny" />
          <Hint keys={["↵"]} label="Open agent" />
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
