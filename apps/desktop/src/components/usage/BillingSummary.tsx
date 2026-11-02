import { useBudgetStatus } from "@/hooks/useBudgetStatus";
import { billingOf, budgetLeft, windowsLeft, type BillingMode } from "@/lib/billing";
import { formatCost } from "@/lib/format";
import type { Account, Provider } from "@/lib/types";
import { cn } from "@/lib/utils";
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

/** What is left of today's daily budget, for an account billed per token. */
function ApiLeft({ signal }: { signal: number }) {
  const status = useBudgetStatus(signal);
  const setView = useUi((s) => s.setView);
  const b = budgetLeft(status);
  if (!b) return null;
  return (
    <div className="mt-2 text-[11.5px]">
      {b.budgetUsd !== null && b.leftUsd !== null ? (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-steel">Left today</span>
            <span className={cn("font-medium tabular", b.usedPercent >= 90 ? "text-err" : "text-fg")}>
              {formatCost(b.leftUsd)} <span className="font-normal text-steel">of {formatCost(b.budgetUsd)}</span>
            </span>
          </div>
          <LeftBar usedPercent={b.usedPercent} label="Daily budget left" />
        </>
      ) : (
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-steel">Spent today</span>
          <span className="font-medium tabular text-fg">{formatCost(b.spentUsd)}</span>
        </div>
      )}
      <p className="mt-1.5 leading-snug text-steel">
        A prepaid balance can&rsquo;t be read with an API key, so this counts down your daily budget.
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
      {billing.mode === "api" && <ApiLeft signal={signal} />}
    </div>
  );
}

/** The voice assistant always runs on an OpenAI API key, so it is API billing; shows the day's budget left. */
export function AssistantBilling({ signal, className }: { signal: number; className?: string }) {
  return (
    <div className={className} data-billing="api">
      <div className="flex items-center gap-2">
        <span className={cn("shrink-0 whitespace-nowrap rounded-full border px-2 py-px text-[10.5px] font-medium", PILL.api)}>API billing</span>
        <span className="min-w-0 truncate text-[11.5px] text-steel">Billed per token on your OpenAI key.</span>
      </div>
      <ApiLeft signal={signal} />
    </div>
  );
}
