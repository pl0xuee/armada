import { useEffect, useState } from "react";
import { useBudgetStatus } from "@/hooks/useBudgetStatus";
import { api } from "@/lib/api";
import { accountSpend, billingOf, budgetLeft, windowsLeft, type BillingMode } from "@/lib/billing";
import { formatCost } from "@/lib/format";
import type { Account, Provider, VoiceAssistantUsage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { resetLabel } from "../UsageMeter";

const PILL: Record<BillingMode, string> = {
  subscription: "border-accent/35 bg-accent/10 text-accent",
  api: "border-warn/40 bg-warn/10 text-warn",
  local: "border-line-strong bg-raised text-muted",
};

const tone = (usedPercent: number) => (usedPercent >= 90 ? "bg-err" : usedPercent >= 70 ? "bg-warn" : "bg-accent");

function LeftBar({ usedPercent, label }: { usedPercent: number; label: string }) {
  // The bar shows what is left, so it empties as it runs down.
  const left = 100 - usedPercent;
  return (
    <div
      className="mt-1 h-1 overflow-hidden rounded-full bg-raised"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={left}
    >
      <div
        className={cn("h-full origin-left rounded-full transition-transform duration-300", tone(usedPercent))}
        style={{ transform: `scaleX(${left / 100})` }}
      />
    </div>
  );
}

/** What the agents on this API key have used so far: the part that is really billed to it. */
function KeySpend({ accountId }: { accountId: string }) {
  const agents = useApp((s) => s.agents);
  const usd = accountSpend(Object.values(agents), accountId);
  return (
    <div className="mt-2 flex items-baseline justify-between gap-2 text-[11.5px]">
      <span className="text-steel">Used on this key</span>
      <span className="font-medium tabular text-fg">{formatCost(usd)}</span>
    </div>
  );
}

/**
 * The daily budget, which counts every agent's usage at API prices (subscription work too). It is the
 * limit Kvistcode enforces, not a bill, so it is labelled as that.
 */
function DailyBudget({ signal }: { signal: number }) {
  const status = useBudgetStatus(signal);
  const setView = useUi((s) => s.setView);
  const b = budgetLeft(status);
  if (!b) return null;
  return (
    <div className="mt-2 text-[11.5px]">
      {b.budgetUsd !== null && b.leftUsd !== null ? (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-steel">Daily budget left</span>
            <span className={cn("font-medium tabular", b.usedPercent >= 90 ? "text-err" : "text-fg")}>
              {formatCost(b.leftUsd)} <span className="font-normal text-steel">of {formatCost(b.budgetUsd)}</span>
            </span>
          </div>
          <LeftBar usedPercent={b.usedPercent} label="Daily budget left" />
        </>
      ) : (
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-steel">Counted toward today&rsquo;s budget</span>
          <span className="font-medium tabular text-fg">{formatCost(b.spentUsd)}</span>
        </div>
      )}
      <p className="mt-1.5 leading-snug text-steel">
        Counts every agent at API prices, subscription work included, so it can be far more than you are billed.
        {b.budgetUsd === null && (
          <>
            {" "}
            <button
              type="button"
              className="text-muted underline-offset-2 hover:text-fg hover:underline"
              onClick={() => setView("settings")}
            >
              Set a daily budget
            </button>
          </>
        )}
      </p>
    </div>
  );
}

/**
 * How this account is paid for and what is left: the plan's usage windows for a subscription, or the
 * day's budget for API billing. `signal` (the agent's cost) refreshes the API figure as it changes.
 */
export function BillingSummary({
  account,
  provider,
  signal,
  className,
}: {
  account: Account | null | undefined;
  provider: Provider;
  signal: number;
  className?: string;
}) {
  const billing = billingOf(account, provider);
  const windows = billing.mode === "subscription" ? windowsLeft(account?.usage) : [];
  return (
    <div className={className} data-billing={billing.mode}>
      <div className="flex items-center gap-2">
        <span className={cn("shrink-0 whitespace-nowrap rounded-full border px-2 py-px text-[10.5px] font-medium", PILL[billing.mode])}>
          {billing.label}
        </span>
        <span className="min-w-0 truncate text-[11.5px] text-steel" title={billing.detail}>
          {billing.detail}
        </span>
      </div>
      {windows.map((w) => (
        <div key={w.name} className="mt-2 text-[11.5px]">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-steel">
              {w.name} left{resetLabel(w.resetsAt) ? ` · ${resetLabel(w.resetsAt)}` : ""}
            </span>
            <span className={cn("font-medium tabular", w.leftPercent <= 10 ? "text-err" : "text-fg")}>
              {w.leftPercent}%
            </span>
          </div>
          <LeftBar usedPercent={w.usedPercent} label={`${w.name} usage left`} />
        </div>
      ))}
      {billing.mode === "api" && account && <KeySpend accountId={account.id} />}
      {billing.mode === "api" && <DailyBudget signal={signal} />}
    </div>
  );
}

/** The voice assistant runs on an OpenAI API key: what it has cost this month is the real charge (an estimate). */
export function AssistantBilling({ className }: { className?: string }) {
  const [month, setMonth] = useState<VoiceAssistantUsage | null>(null);
  useEffect(() => {
    let live = true;
    api
      .vaUsage()
      .then((u) => live && setMonth(u))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className={className} data-billing="api">
      <div className="flex items-center gap-2">
        <span className={cn("shrink-0 whitespace-nowrap rounded-full border px-2 py-px text-[10.5px] font-medium", PILL.api)}>
          API billing
        </span>
        <span className="min-w-0 truncate text-[11.5px] text-steel">Billed per token on your OpenAI key.</span>
      </div>
      {month && (
        <div className="mt-2 flex items-baseline justify-between gap-2 text-[11.5px]">
          <span className="text-steel">
            Assistant this month · {month.sessions} {month.sessions === 1 ? "session" : "sessions"}
          </span>
          <span className="font-medium tabular text-fg">~{formatCost(month.costUsd)} est.</span>
        </div>
      )}
      <p className="mt-1.5 text-[11.5px] leading-snug text-steel">
        Your OpenAI balance can&rsquo;t be read with an API key. Check it at platform.openai.com.
      </p>
    </div>
  );
}
