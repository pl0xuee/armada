import { ArrowDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Agent, TimelineItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Skeleton } from "../ui/skeleton";
import { AgentMessage, NoticeBanner, PermissionCard, PlanCard, ThoughtBlock, ToolCallCard, UserBubble } from "./items";

const STICK_THRESHOLD = 96;

export function Timeline({
  agent,
  items,
  loading,
  footer,
}: {
  agent: Agent;
  items: TimelineItem[] | undefined;
  loading: boolean;
  footer?: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  const stick = useRef(true);
  const lastCount = useRef(0);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // Reset when switching agents.
  useLayoutEffect(() => {
    stick.current = true;
    setAtBottom(true);
    setHasNew(false);
    lastCount.current = 0;
    scrollToBottom();
  }, [agent.id, scrollToBottom]);

  // Keep pinned to the bottom while content grows (streaming), unless the user scrolled up.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) scrollToBottom();
      else setHasNew(true);
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    const n = items?.length ?? 0;
    if (n !== lastCount.current) {
      if (stick.current) scrollToBottom();
      else if (n > lastCount.current) setHasNew(true);
      lastCount.current = n;
    }
  }, [items, scrollToBottom]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    stick.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
    if (bottom) setHasNew(false);
  };

  const live = agent.status === "working" || agent.status === "starting";
  const lastId = items?.[items.length - 1]?.id;

  return (
    <div className="@container relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto" aria-live="polite" aria-busy={live}>
        <div
          ref={contentRef}
          className="mx-auto flex w-full max-w-[860px] flex-col gap-3 px-3 pb-6 pt-4 @lg:px-6 @lg:pt-5 @[1280px]:max-w-[1000px]"
        >
          {loading && !items ? (
            <TimelineSkeleton />
          ) : (
            items?.map((it, i) => {
              const prev = items[i - 1];
              const isLast = it.id === lastId;
              return (
                <div
                  key={it.id}
                  // Off-screen items skip layout/paint, keeping long timelines fast.
                  className={cn(
                    spacingFor(it, prev),
                    !isLast && "[content-visibility:auto] [contain-intrinsic-size:auto_56px]",
                  )}
                >
                  {renderItem(it, agent, prev, live && isLast)}
                </div>
              );
            })
          )}
          {footer}
        </div>
      </div>
      <AnimatePresence>
        {!atBottom && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: 0.15 }}
            onClick={() => {
              stick.current = true;
              setHasNew(false);
              scrollToBottom(true);
            }}
            className="glass absolute bottom-3 left-1/2 z-10 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong px-3 text-[12px] font-medium text-fg shadow-lg shadow-black/40 edge transition-colors hover:border-accent/50"
          >
            {hasNew && <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_6px_var(--accent)]" />}
            {hasNew ? "New activity" : "Jump to latest"}
            <ArrowDown className="h-3.5 w-3.5" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

function spacingFor(it: TimelineItem, prev: TimelineItem | undefined): string {
  if (!prev) return "";
  if (it.kind === "user_message") return "mt-4";
  if (prev.kind === "user_message") return "mt-1";
  return "";
}

function renderItem(it: TimelineItem, agent: Agent, prev: TimelineItem | undefined, liveTail: boolean) {
  switch (it.kind) {
    case "user_message":
      return <UserBubble item={it} />;
    case "agent_message":
      return (
        <AgentMessage item={it} agent={agent} showHeader={!prev || prev.kind === "user_message"} streaming={liveTail} />
      );
    case "thought":
      return <ThoughtBlock item={it} live={liveTail} />;
    case "tool_call":
      return <ToolCallCard item={it} agentLive={agent.running && agent.status !== "interrupted"} />;
    case "permission":
      return <PermissionCard item={it} agent={agent} />;
    case "plan":
      return <PlanCard item={it} />;
    case "notice":
      return <NoticeBanner item={it} />;
    default:
      return null;
  }
}

function TimelineSkeleton() {
  return (
    <div className="space-y-6 pt-2" aria-label="Loading conversation">
      <div className="flex justify-end">
        <Skeleton className="h-14 w-[55%] rounded-2xl" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-[92%]" />
        <Skeleton className="h-3 w-[80%]" />
        <Skeleton className="h-3 w-[64%]" />
      </div>
      <Skeleton className="h-9 w-full rounded-xl" />
      <Skeleton className="h-9 w-full rounded-xl" />
      <div className="space-y-2">
        <Skeleton className="h-3 w-[88%]" />
        <Skeleton className="h-3 w-[70%]" />
      </div>
    </div>
  );
}
