import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { collapseLimitPx, hiddenLines, shouldCollapse, type MessageRole } from "@/lib/collapse";
import { noteUserLayoutChange } from "@/lib/scroll";
import { Icon } from "./Icon";

/** Messages the reader opened or watched stream in (kept across the row being virtualized out and back in). */
const opened = new Set<string>();
const watchedIds = new Set<string>();

/**
 * Folds a tall message behind a soft fade and a "Show more · N more lines" control (the desktop's
 * `MessageFold`, with a 44px tap target). The content is measured once it stops streaming; a message that
 * streamed while it was on screen is never folded under the reader, and nothing folds while it grows.
 */
export function MessageFold({ id, role, streaming, children }: { id: string; role: MessageRole; streaming: boolean; children: ReactNode }) {
  const bodyId = useId();
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(() => opened.has(id));
  if (streaming) watchedIds.add(id);
  const watched = watchedIds.has(id);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el || streaming || watched) return;
    const apply = (h: number) => setHeight((cur) => (cur !== null && Math.abs(cur - h) < 1 ? cur : h));
    apply(el.offsetHeight);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.borderBoxSize?.[0];
      apply(box ? box.blockSize : el.offsetHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [streaming, watched]);

  const foldable = height !== null && shouldCollapse(height, role, { streaming, watched });
  const collapsed = foldable && !expanded;

  const toggle = useCallback(() => {
    // Growing downward from where the reader is: don't let "follow the newest" yank the page.
    noteUserLayoutChange();
    setExpanded((v) => {
      if (v) opened.delete(id);
      else opened.add(id);
      return !v;
    });
  }, [id]);

  return (
    <div>
      <div
        id={bodyId}
        className={cn("relative", collapsed && "fold-fade overflow-hidden")}
        style={collapsed ? { maxHeight: collapseLimitPx(role) } : undefined}
      >
        <div ref={innerRef}>{children}</div>
      </div>
      {foldable && height !== null && (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          className="press hit relative mt-1.5 inline-flex h-8 items-center gap-1.5 rounded-full border border-line-strong bg-card/70 pr-3 pl-2.5 text-[12.5px] font-medium text-muted active:text-fg"
        >
          <Icon name="chevronDown" size={15} className={cn("transition-transform duration-150", !collapsed && "rotate-180")} />
          {collapsed ? "Show more" : "Show less"}
          {collapsed && <span className="font-normal text-steel tabular">· {hiddenLines(height, role)} more lines</span>}
        </button>
      )}
    </div>
  );
}
