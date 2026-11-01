import { memo, useEffect, useMemo } from "react";
import { Icon } from "@/components/Icon";
import { cn } from "@/lib/cn";
import { loadPr } from "@/lib/phoneActions";
import { hasBranch, PR_POLL_MS, prChip, type PrTone } from "@/lib/prChip";
import { useStore } from "@/lib/store";
import type { Agent } from "@/lib/types";

const TONE: Record<PrTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  err: "text-err",
  accent: "text-accent",
  muted: "text-muted",
};

/** Asks for the agent's PR status now, when the phone comes back to the screen, and every minute while it is open. */
function usePrStatus(agent: Agent) {
  const watch = hasBranch(agent);
  const id = agent.id;
  useEffect(() => {
    if (!watch) return;
    const visible = () => document.visibilityState === "visible";
    const ask = () => visible() && void loadPr(id);
    ask();
    const timer = setInterval(ask, PR_POLL_MS);
    document.addEventListener("visibilitychange", ask);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", ask);
    };
  }, [watch, id]);
}

/**
 * The agent's pull request in one line under the header: number, state, checks and review. Read-only; a tap opens
 * the PR on GitHub. Nothing is shown for a branch without a PR, or when GitHub can't be asked (the desktop says why).
 */
export const PrChip = memo(function PrChip({ agent }: { agent: Agent }) {
  usePrStatus(agent);
  const snap = useStore((s) => s.prs[agent.id]);
  const chip = useMemo(() => prChip(snap), [snap]);
  if (!chip) return null;
  const body = (
    <>
      <Icon name="branch" size={14} className="shrink-0 text-steel" />
      <span className="font-semibold text-fg tabular">{chip.number}</span>
      <span className="text-muted">{chip.state}</span>
      {chip.checks && <span className={cn("font-medium", TONE[chip.checksTone])}>{chip.checks}</span>}
      {chip.review && <span className={cn("font-medium", TONE[chip.reviewTone])}>{chip.review}</span>}
      {chip.url && <Icon name="arrowUpRight" size={14} className="shrink-0 text-steel" />}
    </>
  );
  const cls = "inline-flex h-8 shrink-0 items-center gap-2 rounded-full border border-line-strong bg-card px-3 text-[12.5px] whitespace-nowrap";
  return (
    <div className="scroll-x border-t border-line/60 [@media(orientation:landscape)_and_(max-height:500px)]:hidden">
      <div className="mx-auto flex w-max min-w-full items-center px-safe py-1.5 md:w-full md:max-w-[860px]">
        {chip.url ? (
          <a href={chip.url} target="_blank" rel="noopener noreferrer" aria-label={`${chip.label}. Open on GitHub`} className={cn("press hit relative", cls)}>
            {body}
          </a>
        ) : (
          <span role="status" aria-label={chip.label} className={cls}>
            {body}
          </span>
        )}
      </div>
    </div>
  );
});
