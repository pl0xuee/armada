import { Bot, ChartColumn, Coins, Cpu, FolderOpen, Gauge, Layers, Timer, Trophy, Users } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { AccountAvatar } from "@/components/AccountAvatar";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { StatusDot } from "@/components/StatusDot";
import { Segmented } from "@/components/ui/segmented";
import { BarList, ShareBar, type BarDatum } from "@/components/usage/BarList";
import { BudgetBar } from "@/components/usage/BudgetBar";
import { KpiTile } from "@/components/usage/KpiTile";
import { UsageMeters } from "@/components/UsageMeter";
import { useBudgetStatus } from "@/hooks/useBudgetStatus";
import { splitCost } from "@/lib/costSplit";
import { formatCost, formatTokens, relativeTimeLong } from "@/lib/format";
import { identityFor } from "@/lib/identity";
import { providerRank, PROVIDERS } from "@/lib/providers";
import type { Agent, Provider } from "@/lib/types";
import { basename, prettyPath } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";

type Metric = "cost" | "tokens";

interface Bucket {
  key: string;
  cost: number;
  tokens: number;
  agents: number;
}

function aggregate(agents: Agent[], keyOf: (a: Agent) => string): Map<string, Bucket> {
  const map = new Map<string, Bucket>();
  for (const a of agents) {
    const k = keyOf(a);
    const b = map.get(k) ?? { key: k, cost: 0, tokens: 0, agents: 0 };
    b.cost += a.costUsd;
    b.tokens += a.tokensUsed;
    b.agents += 1;
    map.set(k, b);
  }
  return map;
}

function tip(title: ReactNode, b: Bucket, total: { cost: number; tokens: number }, metric: Metric) {
  const share = metric === "cost" ? (total.cost ? b.cost / total.cost : 0) : total.tokens ? b.tokens / total.tokens : 0;
  return (
    <div className="space-y-0.5 py-0.5 tabular">
      <div className="font-medium">{title}</div>
      <div className="text-muted">
        {formatCost(b.cost)} · {formatTokens(b.tokens)} tokens
      </div>
      <div className="text-muted">
        {b.agents} {b.agents === 1 ? "agent" : "agents"} · {Math.round(share * 100)}% of{" "}
        {metric === "cost" ? "spend" : "tokens"}
      </div>
    </div>
  );
}

/** Bucket key for an agent's runtime: the provider, or one bucket per custom ACP agent. */
function runtimeKey(a: Agent): string {
  return a.provider === "custom" ? `custom:${a.customAgentId ?? ""}` : a.provider;
}

function runtimeOf(key: string): { provider: Provider; customAgentId: string | null } {
  return key.startsWith("custom:")
    ? { provider: "custom", customAgentId: key.slice("custom:".length) || null }
    : { provider: key as Provider, customAgentId: null };
}

export function UsageView() {
  const agentsMap = useApp((s) => s.agents);
  const accounts = useApp((s) => s.accounts);
  const customAgents = useApp((s) => s.settings?.customAgents);
  const openAgent = useUi((s) => s.openAgent);
  const openSettings = useUi((s) => s.openSettings);
  const dailyCap = useApp((s) => s.settings?.dailyBudgetUsd);
  const [metric, setMetric] = useState<Metric>("cost");

  const agents = useMemo(() => Object.values(agentsMap), [agentsMap]);
  const total = useMemo(
    () => ({
      cost: agents.reduce((s, a) => s + a.costUsd, 0),
      tokens: agents.reduce((s, a) => s + a.tokensUsed, 0),
    }),
    [agents],
  );
  const budget = useBudgetStatus(total.cost);
  const val = (b: Bucket) => (metric === "cost" ? b.cost : b.tokens);
  const fmt = (b: Bucket) => (metric === "cost" ? formatCost(b.cost) : formatTokens(b.tokens));

  const byProvider = useMemo(() => aggregate(agents, runtimeKey), [agents]);
  // Custom agents have no sign-in account; bucket them by agent instead.
  const byAccount = useMemo(
    () => aggregate(agents, (a) => (a.provider === "custom" ? runtimeKey(a) : a.accountId)),
    [agents],
  );
  const identity = (key: string) => {
    const r = runtimeOf(key);
    return identityFor(r.provider, r.customAgentId, customAgents);
  };
  const runtimeKeys = [...byProvider.keys()].sort((a, b) => {
    const ra = runtimeOf(a);
    const rb = runtimeOf(b);
    return providerRank(ra.provider) - providerRank(rb.provider) || identity(a).name.localeCompare(identity(b).name);
  });
  const byProject = useMemo(() => aggregate(agents, (a) => a.projectPath), [agents]);

  const providerData: BarDatum[] = runtimeKeys.map((k) => {
    const b = byProvider.get(k)!;
    const id = identity(k);
    const r = runtimeOf(k);
    return {
      key: k,
      label: id.name,
      sub: `${b.agents} ${b.agents === 1 ? "agent" : "agents"}`,
      icon: <ProviderGlyph provider={r.provider} customAgentId={r.customAgentId} size="xs" />,
      value: val(b),
      display: fmt(b),
      color: id.color,
      tooltip: tip(id.name, b, total, metric),
    };
  });

  const accountData: BarDatum[] = [...byAccount.values()]
    .sort((a, b) => val(b) - val(a))
    .map((b) => {
      if (b.key.startsWith("custom:")) {
        const id = identity(b.key);
        const r = runtimeOf(b.key);
        return {
          key: b.key,
          label: id.name,
          sub: "No sign-in",
          icon: <ProviderGlyph provider="custom" customAgentId={r.customAgentId} size="xs" />,
          value: val(b),
          display: fmt(b),
          color: id.color,
          tooltip: tip(`${id.name} · custom agent`, b, total, metric),
        };
      }
      const acc = accounts.find((a) => a.id === b.key);
      const name = acc?.name ?? "Removed account";
      return {
        key: b.key,
        label: name,
        sub: acc ? PROVIDERS[acc.provider].short : undefined,
        icon: acc ? <AccountAvatar account={acc} size={16} showProvider={false} /> : undefined,
        value: val(b),
        display: fmt(b),
        color: acc?.color ?? "var(--steel)",
        tooltip: tip(`${name}${acc ? ` · ${PROVIDERS[acc.provider].short}` : ""}`, b, total, metric),
      };
    });

  const projectData: BarDatum[] = [...byProject.values()]
    .sort((a, b) => val(b) - val(a))
    .slice(0, 8)
    .map((b) => ({
      key: b.key,
      label: basename(b.key),
      sub: `${b.agents} ${b.agents === 1 ? "agent" : "agents"}`,
      icon: <FolderOpen className="h-3.5 w-3.5 shrink-0 text-steel" />,
      value: val(b),
      display: fmt(b),
      color: "var(--accent)",
      tooltip: tip(prettyPath(b.key), b, total, metric),
    }));

  const top = [...agents].sort((a, b) => b.costUsd - a.costUsd).slice(0, 8);
  const topMax = Math.max(0.0001, ...top.map((a) => a.costUsd));
  const live = agents.filter(
    (a) => a.status === "working" || a.status === "needs_permission" || a.status === "starting",
  ).length;
  const priciest = providerData.length ? [...byProvider.values()].sort((a, b) => b.cost - a.cost)[0] : null;
  const accountsInUse = new Set(agents.filter((a) => a.provider !== "custom").map((a) => a.accountId)).size;
  const split = splitCost(agents, accounts);
  const metered = accounts.filter((a) => a.usage && (a.usage.primary || a.usage.secondary));

  if (agents.length === 0) {
    return (
      <div className="@container flex h-full flex-col">
        <PageHeader
          icon={<ChartColumn />}
          title="Usage"
          subtitle="Spend and tokens across providers, accounts and projects"
        />
        <div className="flex flex-1 items-center justify-center overflow-y-auto">
          <EmptyState
            icon={<Coins />}
            title="No usage yet"
            description="Once your agents start working, their cost and token usage roll up here per provider, account and project."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="@container flex h-full flex-col">
      <PageHeader
        icon={<ChartColumn />}
        title="Usage"
        subtitle="Cost and tokens as reported by each agent runtime, since your agents were created"
        right={
          <Segmented<Metric>
            size="sm"
            aria-label="Metric"
            value={metric}
            onChange={setMetric}
            options={[
              { value: "cost", label: "Cost (USD)" },
              { value: "tokens", label: "Tokens" },
            ]}
          />
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-3 px-4 py-4 @2xl:space-y-4 @2xl:px-6 @2xl:py-5">
          {budget && dailyCap != null && (
            <BudgetBar status={budget} onConfigure={() => openSettings("budgets")} />
          )}

          <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
            <KpiTile
              icon={<Coins />}
              label="Billed (API keys)"
              value={formatCost(split.billed)}
              sub={split.billed > 0 ? "Charged per token" : "No API-key usage"}
            />
            <KpiTile
              icon={<Gauge />}
              label="API-equivalent cost"
              value={formatCost(split.equivalent)}
              sub={
                split.equivalent > 0
                  ? "Subscription usage, not billed per token"
                  : priciest
                    ? `Most on ${identity(priciest.key).short}`
                    : undefined
              }
            />
            <KpiTile
              icon={<Cpu />}
              label="Tokens"
              value={formatTokens(total.tokens)}
              sub={`${formatTokens(Math.round(total.tokens / agents.length))} per agent`}
            />
            <KpiTile
              icon={<Bot />}
              label="Agents"
              value={agents.length}
              sub={`incl. archived · ${live} live · ${accountsInUse} ${accountsInUse === 1 ? "account" : "accounts"}`}
            />
          </div>

          <Panel title="Provider share" icon={<Layers />}>
            <ShareBar
              segments={runtimeKeys.map((k) => {
                const b = byProvider.get(k)!;
                const id = identity(k);
                return { key: k, label: id.name, value: val(b), display: fmt(b), color: id.color };
              })}
            />
          </Panel>

          {metered.length > 0 && (
            <Panel title="Rate limits" icon={<Timer />} flush>
              <ul className="divide-y divide-line/70">
                {metered.map((acc) => (
                  <li key={acc.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
                    <div className="flex min-w-[180px] flex-1 items-center gap-2.5">
                      <AccountAvatar account={acc} size={24} />
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-fg">
                          {acc.name}
                          <span className="ml-1.5 font-normal text-steel">{PROVIDERS[acc.provider].short}</span>
                        </div>
                        <div className="truncate text-[11.5px] text-steel">
                          {[
                            acc.usage?.plan ? capitalize(acc.usage.plan) : acc.status?.plan,
                            `updated ${relativeTimeLong(acc.usage?.updatedAt ?? Date.now())}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </div>
                    </div>
                    <UsageMeters usage={acc.usage} className="w-full max-w-[520px] @2xl:w-auto @2xl:flex-1" />
                  </li>
                ))}
              </ul>
              <p className="border-t border-line/70 px-4 py-2 text-[11.5px] text-steel">
                Reported by the provider runtime for accounts that expose rate-limit windows (Codex and Claude).
              </p>
            </Panel>
          )}

          <div className="grid gap-3 @2xl:gap-4 @4xl:grid-cols-3">
            <Panel title="By provider" icon={<Layers />}>
              <BarList data={providerData} />
            </Panel>
            <Panel title="By account" icon={<Users />}>
              <BarList data={accountData} />
            </Panel>
            <Panel title="By project" icon={<FolderOpen />}>
              <BarList data={projectData} />
            </Panel>
          </div>

          <Panel title="Top agents by cost" icon={<Trophy />} flush>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.06em] text-steel">
                  <th className="w-10 py-2 pl-4 font-medium">#</th>
                  <th className="py-2 font-medium">Agent</th>
                  <th className="hidden w-[150px] py-2 font-medium @2xl:table-cell">Account</th>
                  <th className="hidden w-[90px] py-2 pr-4 text-right font-medium @md:table-cell">Tokens</th>
                  <th className="w-[84px] py-2 pr-4 text-right font-medium @lg:w-[180px]">Cost</th>
                </tr>
              </thead>
              <tbody>
                {top.map((a, i) => {
                  const acc = accounts.find((x) => x.id === a.accountId);
                  return (
                    <tr
                      key={a.id}
                      tabIndex={0}
                      onClick={() => openAgent(a.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") openAgent(a.id);
                      }}
                      className="cursor-default border-b border-line/60 transition-colors last:border-0 hover:bg-raised/50 focus-visible:bg-raised/60 focus-visible:outline-none"
                    >
                      <td className="py-2.5 pl-4 text-steel tabular">{i + 1}</td>
                      <td className="max-w-0 py-2.5 pr-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <ProviderGlyph provider={a.provider} customAgentId={a.customAgentId} size="xs" />
                          <span className="truncate text-fg">{a.title}</span>
                          <StatusDot status={a.status} size={6} />
                          <span className="hidden truncate text-[11.5px] text-steel @4xl:inline">
                            {basename(a.projectPath)}
                          </span>
                        </div>
                      </td>
                      <td className="hidden py-2.5 pr-3 @2xl:table-cell">
                        {acc ? (
                          <span className="flex items-center gap-1.5 text-muted">
                            <AccountAvatar account={acc} size={14} showProvider={false} />
                            <span className="truncate">{acc.name}</span>
                          </span>
                        ) : a.provider === "custom" ? (
                          <span className="truncate text-steel">{identity(runtimeKey(a)).name}</span>
                        ) : (
                          <span className="text-steel">—</span>
                        )}
                      </td>
                      <td className="hidden py-2.5 pr-4 text-right text-muted tabular @md:table-cell">
                        {formatTokens(a.tokensUsed)}
                      </td>
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center justify-end gap-2.5">
                          <span className="hidden h-1.5 w-20 overflow-hidden rounded-[4px] bg-raised/70 @lg:block">
                            <span
                              className="block h-full rounded-[4px]"
                              style={{
                                width: `${(a.costUsd / topMax) * 100}%`,
                                background: identity(runtimeKey(a)).color,
                              }}
                            />
                          </span>
                          <span className="w-14 text-right font-medium text-fg tabular">{formatCost(a.costUsd)}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Panel({
  title,
  icon,
  children,
  flush,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="rounded-xl border border-line bg-card edge">
      <h2 className="flex items-center gap-2 px-4 pb-2 pt-3.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-steel [&_svg]:h-3.5 [&_svg]:w-3.5">
        {icon}
        {title}
      </h2>
      <div className={flush ? "" : "px-4 pb-4 pt-1"}>{children}</div>
    </section>
  );
}
