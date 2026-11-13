import { useEffect, useMemo } from "react";
import { AccountDot, ProviderBadge } from "@/components/Identity";
import { Icon } from "@/components/Icon";
import { ConnectionPill, TopBar } from "@/components/TopBar";
import { IconButton } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatCost, formatTokens, plural, relativeTimeLong } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { safeColor } from "@/lib/meta";
import { loadUsage } from "@/lib/phoneActions";
import { goBack } from "@/lib/router";
import { useStore } from "@/lib/store";
import type { RemoteAccount } from "@/lib/types";
import {
  billingOf,
  budgetRows,
  hasDailyBudget,
  planLabel,
  providerName,
  resetsIn,
  sortAccounts,
  spendByAccount,
  usageMeters,
  usageState,
  type BudgetRow,
  type Meter,
  type Spend,
} from "@/lib/usage";

/** How often the open Usage screen reads again while the page is on screen. */
const REFRESH_MS = 30_000;

/**
 * Usage per account: the windows each provider last reported (5-hour, weekly, …) and what the account's
 * agents used, with today against the daily limits on top. Everything comes from what Kvistcode on the
 * computer already holds; reading it asks no provider anything.
 */
export function Usage() {
  const accounts = useStore((s) => s.accounts);
  const agents = useStore((s) => s.agents);
  const budget = useStore((s) => s.budget);
  const usageAt = useStore((s) => s.usageAt);
  const unsupported = useStore((s) => s.usageUnsupported);
  const now = useNow();
  // Only a paired phone may read usage; a reload opens here before the session is known.
  const owner = useStore((s) => s.session?.scope === "owner");

  // Read on open, then every half minute while the page is visible; a hidden page asks nothing.
  useEffect(() => {
    if (!owner) return;
    void loadUsage();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void loadUsage();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadUsage();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [owner]);

  const list = useMemo(() => sortAccounts(Object.values(accounts)), [accounts]);
  const spend = useMemo(() => spendByAccount(Object.values(agents)), [agents]);
  const rows = budgetRows(budget);

  let body;
  if (unsupported) {
    body = <Notice>Update Kvistcode on your computer to see usage here.</Notice>;
  } else if (!list.length) {
    body = <Notice>No accounts yet. Add one in Kvistcode on your computer.</Notice>;
  } else {
    body = (
      <div className="space-y-6">
        {rows.length > 0 && (
          <section aria-labelledby="usage-today">
            <SectionTitle id="usage-today">Today</SectionTitle>
            <div className="lifted rounded-[18px] border border-line px-4 py-3">
              <ul className="space-y-3">
                {rows.map((r) => (
                  <BudgetLine key={r.key} row={r} />
                ))}
              </ul>
              {!hasDailyBudget(budget) && <p className="mt-3 text-[12.5px] leading-[18px] text-steel">No daily limit is set. Set one in Kvistcode on your computer.</p>}
            </div>
          </section>
        )}
        <section aria-labelledby="usage-accounts">
          <SectionTitle id="usage-accounts">Accounts</SectionTitle>
          <ul className="space-y-3">
            {list.map((a) => (
              <li key={a.id}>
                <AccountCard account={a} spend={spend.get(a.id)} now={now} />
              </li>
            ))}
          </ul>
        </section>
        <p className="px-1 text-[12.5px] leading-[18px] text-steel">
          Limits are what each provider last reported while an agent ran. A sign-in plan's cost is what the same use would cost through the API, not a bill.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar left={<IconButton icon="chevronLeft" label="Back to agents" onClick={goBack} />} right={<ConnectionPill className="mr-2" />}>
        <div className="min-w-0">
          <h1 className="text-[17px] leading-[22px] font-semibold text-fg">Usage</h1>
          <p className="truncate text-[12px] leading-tight text-muted">
            {usageAt ? `Updated ${relativeTimeLong(usageAt, now)}` : list.length ? plural(list.length, "account") : "Accounts and limits"}
          </p>
        </div>
      </TopBar>
      <main className="mx-auto w-full max-w-[860px] flex-1 px-safe pt-4 pb-[calc(24px+var(--safe-bottom))]">{body}</main>
    </div>
  );
}

function SectionTitle({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="mb-2 px-1 text-[12px] leading-[16px] font-semibold tracking-[0.08em] text-steel uppercase">
      {children}
    </h2>
  );
}

function Notice({ children }: { children: string }) {
  return <p className="lifted rounded-[18px] border border-line px-4 py-4 text-[14px] leading-[20px] text-muted">{children}</p>;
}

const TONE: Record<string, string> = { ok: "var(--accent)", warn: "var(--warn)", err: "var(--err)", under: "var(--accent)", hit: "var(--err)" };

function Bar({ percent, color, label }: { percent: number; color: string; label: string }) {
  return (
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.min(100, percent)}
      className="meter-track block h-[6px] w-full overflow-hidden rounded-full"
    >
      {/* Scaled, not resized: a change only touches the compositor. */}
      <span className="block h-full w-full origin-left rounded-full" style={{ background: color, transform: `scaleX(${Math.min(100, Math.max(0, percent)) / 100})` }} />
    </span>
  );
}

function BudgetLine({ row }: { row: BudgetRow }) {
  const show = (n: number) => (row.key === "cost" ? formatCost(n) : row.key === "tokens" ? formatTokens(n) : String(Math.round(n)));
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3 text-[14px] leading-[20px]">
        <span className="text-muted">{row.label}</span>
        <span className="tabular text-fg">
          {show(row.spent)}
          {row.cap !== null && <span className="text-steel"> of {show(row.cap)}</span>}
          {row.level !== "under" && <span className={cn("ml-1.5 font-semibold", row.level === "hit" ? "text-err" : "text-warn")}>{row.level === "hit" ? "Limit reached" : `${row.percent}%`}</span>}
        </span>
      </div>
      {row.percent !== null && (
        <div className="mt-1.5">
          <Bar percent={row.percent} color={TONE[row.level]} label={`${row.label}: ${row.percent}% of today's limit`} />
        </div>
      )}
    </li>
  );
}

function MeterLine({ meter, now }: { meter: Meter; now: number }) {
  const reset = resetsIn(meter.resetsAt, now);
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3 text-[13.5px] leading-[18px]">
        <span className="text-fg/95">{meter.name}</span>
        <span className={cn("font-semibold tabular", meter.tone === "err" ? "text-err" : meter.tone === "warn" ? "text-warn" : "text-fg")}>{meter.usedPercent}%</span>
      </div>
      <div className="mt-1.5">
        <Bar percent={meter.usedPercent} color={TONE[meter.tone]} label={`${meter.name}: ${meter.usedPercent}% used`} />
      </div>
      {reset && <p className="mt-1 text-[12.5px] leading-[16px] text-steel">{reset}</p>}
    </li>
  );
}

function AccountCard({ account, spend, now }: { account: RemoteAccount; spend: Spend | undefined; now: number }) {
  const state = usageState(account);
  const plan = planLabel(account);
  const meters = state === "meters" ? usageMeters(account.usage) : [];
  const billing = billingOf(account);
  const updated = state === "meters" && account.usage?.updatedAt ? account.usage.updatedAt : null;
  return (
    <article className={cn("rounded-[18px] border border-line px-4 pt-3.5 pb-3.5", state === "signed_out" ? "bg-panel" : "lifted")}>
      <header className="flex items-center gap-3">
        <ProviderBadge agent={{ provider: account.provider, customAgentId: null }} size={36} />
        <div className="min-w-0 flex-1">
          <h3 className="flex min-w-0 items-center gap-1.5 text-[15.5px] leading-[20px] font-semibold text-fg">
            <AccountDot color={safeColor(account.color)} size={7} />
            <span className="truncate">{account.name}</span>
            <span className="shrink-0 font-normal text-steel">{providerName(account)}</span>
          </h3>
          <p className="truncate text-[12.5px] leading-[16px] text-steel">{[plan, updated ? `updated ${relativeTimeLong(updated, now)}` : null].filter(Boolean).join(" · ") || " "}</p>
        </div>
        {state === "signed_out" && (
          <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-warn/14 px-2.5 text-[12px] font-semibold text-warn">
            <Icon name="alert" size={12} strokeWidth={2.2} />
            Signed out
          </span>
        )}
      </header>

      {state === "meters" && (
        <ul className="mt-3.5 space-y-3">
          {meters.map((m) => (
            <MeterLine key={m.key} meter={m} now={now} />
          ))}
        </ul>
      )}
      {state === "none" && <p className="mt-3 text-[13.5px] leading-[18px] text-muted">No usage reported yet. It shows after an agent runs on this account.</p>}
      {state === "unmetered" && (
        <p className="mt-3 text-[13.5px] leading-[18px] text-muted">{billing === "api" ? "Billed per token: no usage limits." : "No usage limits."}</p>
      )}
      {state === "signed_out" && <p className="mt-3 text-[13.5px] leading-[18px] text-muted">Sign in again in Kvistcode on your computer to use this account.</p>}

      {spend && spend.agents > 0 && (
        <p className="mt-3 border-t border-line/70 pt-2.5 text-[13px] leading-[18px] text-muted tabular">
          {plural(spend.agents, "agent")} · {formatTokens(spend.tokens)} tokens
          {billing !== "local" && (
            <>
              {" · "}
              <span className="text-fg">{formatCost(spend.costUsd)}</span>
              {billing === "subscription" && <span className="text-steel"> API-equivalent</span>}
            </>
          )}
        </p>
      )}
    </article>
  );
}
