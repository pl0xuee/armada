import { ChevronDown, ChevronUp } from "lucide-react";
import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { collapseLimitPx, hiddenLines, shouldCollapse, type MessageRole } from "./collapse";

/** Bubbles up to the conversation: stop following the stream. */
export const UNFOLLOW_EVENT = "kvistcode:timeline-unfollow";

/** Messages the reader opened (survives the row being virtualized out and back in). */
const opened = new Set<string>();

/**
 * Folds a tall message behind a soft fade and a "Show more" control. The content is measured once it
 * stops streaming (and whenever its size changes after that); a message that streamed while mounted
 * is never folded under the reader, and neither is anything while it is still growing. How tall it may be
 * is fixed at that first measurement: a message's role changes as the turn goes on (the answer in the
 * making becomes a working note, and back when the turn ends), and that must never fold or unfold it by
 * itself. Only the reader's click does. The control is a real button (keyboard reachable); focus moving
 * into hidden content opens the message.
 */
export function MessageFold({
  id,
  role,
  streaming,
  children,
}: {
  id: string;
  role: MessageRole;
  streaming: boolean;
  children: ReactNode;
}) {
  const bodyId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(() => opened.has(id));
  const watched = useRef(false);
  if (streaming) watched.current = true;

  // Natural height of the content (independent of the clipping box around it).
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el || streaming || watched.current) return;
    const apply = (h: number) => setHeight((cur) => (cur !== null && Math.abs(cur - h) < 1 ? cur : h));
    apply(el.offsetHeight);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.borderBoxSize?.[0];
      apply(box ? box.blockSize : el.offsetHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [streaming]);

  // The role the fold limit follows: the one the message had when it was first measured.
  const limitRole = useRef<MessageRole | null>(null);
  if (height !== null && limitRole.current === null) limitRole.current = role;
  const foldRole = limitRole.current ?? role;

  const foldable = height !== null && shouldCollapse(height, foldRole, { streaming, watched: watched.current });
  const collapsed = foldable && !expanded;

  // After folding back up, keep the message's top in view instead of leaving the reader below it.
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (!refocus.current || collapsed === false) return;
    refocus.current = false;
    const root = rootRef.current;
    const scroller = root?.closest<HTMLElement>("[data-timeline-scroll]");
    if (!root || !scroller) return;
    const top = root.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    if (top < 8) scroller.scrollTop += top - 12;
  }, [collapsed]);

  const toggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (next) {
      opened.add(id);
      // Growing downward from the reader's position: don't let "follow the stream" yank it to the end.
      rootRef.current?.dispatchEvent(new CustomEvent(UNFOLLOW_EVENT, { bubbles: true }));
    } else {
      opened.delete(id);
      refocus.current = true;
    }
  }, [expanded, id]);

  return (
    <div ref={rootRef}>
      <div
        id={bodyId}
        className={cn("relative", collapsed && "overflow-hidden fold-fade")}
        style={collapsed ? { maxHeight: collapseLimitPx(foldRole) } : undefined}
        onFocusCapture={() => {
          if (collapsed) setExpanded(true);
        }}
      >
        <div ref={innerRef}>{children}</div>
      </div>
      {foldable && height !== null && (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          className="mt-1.5 inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-card/60 pl-2.5 pr-3 text-[12px] font-medium text-muted transition-colors hover:border-line-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          {collapsed ? "Show more" : "Show less"}
          {collapsed && (
            <span className="font-normal tabular-nums text-steel">· {hiddenLines(height, foldRole)} more lines</span>
          )}
        </button>
      )}
    </div>
  );
}
