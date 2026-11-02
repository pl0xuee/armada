import {
  CalendarClock,
  Cpu,
  FilePen,
  FileSearch,
  FolderOpen,
  GitBranch,
  Hash,
  ListChecks,
  Shrink,
  UserRound,
  Workflow,
} from "lucide-react";
import { m } from "motion/react";
import { memo, useRef, useState, type ReactNode } from "react";
import type { AgentDerived } from "./derived";
import { useRunningSubagentCount } from "./useSubagents";
import { canCompact, COMPACT_SUGGEST_RATIO, compactContext, contextRatio } from "./compact";
import { useScrollFade } from "@/hooks/useScrollFade";
import { attempt } from "@/lib/actions";
import { api } from "@/lib/api";
import { agentCostText, formatTokens } from "@/lib/format";
import { agentHasBranch } from "@/lib/pr";
import type { Account, Agent } from "@/lib/types";
import { cn, prettyPath } from "@/lib/utils";
import { useApp } from "@/store/app";
import { usePr } from "@/store/pr";
import { AccountAvatar } from "../AccountAvatar";
import { ContextRing } from "../ContextRing";
import { RelTime } from "../RelTime";
import { BillingSummary } from "../usage/BillingSummary";
import { CopyButton } from "../CopyButton";
import { PlanChecklist } from "../timeline/items";
import { PrChip } from "./PrChip";
import { Button } from "../ui/button";
import { Spinner } from "../ui/misc";
import { Tooltip } from "../ui/tooltip";

function Section({
  title,
  icon,
  children,
  right,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <section className="border-b border-line px-4 py-3.5 last:border-b-0">
      <div className="mb-2.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-steel [&_svg]:h-3.5 [&_svg]:w-3.5">
        {icon}
        {title}
        {right && <span className="ml-auto normal-case tracking-normal">{right}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * `derived` is cached on tool-call structure (agentDerived keeps its references across streamed text),
 * so with `memo` the panel only re-renders when the agent record or a tool call actually changes.
 */
export const Inspector = memo(function Inspector({
  agent,
  derived,
  className,
}: {
  agent: Agent;
  derived: AgentDerived;
  className?: string;
}) {
  const { files, plan } = derived;
  const subagents = useRunningSubagentCount(agent.id);
  const account = useApp((s) => s.accounts.find((a) => a.id === agent.accountId));
  const hasPr = usePr((s) => agentHasBranch(agent) && s.byAgent[agent.id]?.state === "ok" && !!s.byAgent[agent.id].pr);
  const scrollRef = useRef<HTMLElement>(null);
  useScrollFade(scrollRef);
  const done = plan?.entries.filter((e) => e.status === "completed").length ?? 0;

  return (
    <m.aside
      ref={scrollRef}
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 12 }}
      transition={{ duration: 0.16 }}
      aria-label="Inspector"
      className={cn(
        "scroll-fade flex h-full w-[272px] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel/70",
        className,
      )}
    >
      <Section title="Usage" icon={<Cpu />}>
        <div className="flex items-center gap-4">
          {agent.contextSize ? (
            <ContextRing used={agent.contextUsed ?? 0} size={agent.contextSize} diameter={68} label="context" />
          ) : (
            <div className="flex h-[68px] w-[68px] items-center justify-center rounded-full border border-dashed border-line-strong text-[11px] text-steel">
              n/a
            </div>
          )}
          <dl className="grid flex-1 grid-cols-1 gap-2 text-[12px]">
            <Stat label="Cost" value={agentCostText(agent)} />
            <Stat label="Tokens" value={formatTokens(agent.tokensUsed)} />
            {agent.contextSize ? (
              <Stat
                label="Context"
                value={`${formatTokens(agent.contextUsed ?? 0)} / ${formatTokens(agent.contextSize)}`}
              />
            ) : null}
          </dl>
        </div>
        {canCompact(agent) && agent.running && agent.contextSize ? <CompactRow agent={agent} /> : null}
      </Section>

      {account && agent.provider !== "custom" && <AccountSection account={account} agent={agent} />}

      {(subagents > 0 || agent.queue.length > 0) && (
        <Section title="Activity" icon={<Workflow />}>
          <dl className="space-y-2 text-[12px]">
            {subagents > 0 && (
              <Row label="Sub-agents">
                <span className="flex items-center gap-1.5 text-accent">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent animate-breathe" aria-hidden />
                  <span className="tabular">{subagents}</span> running
                </span>
              </Row>
            )}
            {agent.queue.length > 0 && (
              <Row label="Queue">
                <span className={cn("tabular", agent.queuePaused ? "text-warn" : "text-fg")}>
                  {agent.queue.length} message{agent.queue.length === 1 ? "" : "s"}
                  {agent.queuePaused ? " · paused" : ""}
                </span>
              </Row>
            )}
          </dl>
        </Section>
      )}

      {plan && (
        <Section
          title="Plan"
          icon={<ListChecks />}
          right={
            <span className="text-[11px] text-steel tabular">
              {done}/{plan.entries.length}
            </span>
          }
        >
          <PlanChecklist entries={plan.entries} dense />
        </Section>
      )}

      <Section
        title="Files touched"
        icon={<FilePen />}
        right={files.length > 0 ? <span className="text-[11px] text-steel tabular">{files.length}</span> : undefined}
      >
        {files.length === 0 ? (
          <p className="text-[12px] text-steel">No files yet.</p>
        ) : (
          <ul className="-mx-1.5 space-y-px">
            {files.slice(0, 40).map((f) => (
              <FileRow key={f.path} file={f} cwd={agent.cwd} />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Session" icon={<Hash />}>
        <dl className="space-y-2.5 text-[12px]">
          <Row label="Session">
            {agent.sessionId ? (
              <span className="flex min-w-0 items-center gap-1">
                <span className="selectable truncate font-mono text-[11px] text-fg/90">{agent.sessionId}</span>
                <CopyButton text={agent.sessionId} label="" ariaLabel="Copy session id" className="h-5 px-1" />
              </span>
            ) : (
              <span className="text-steel">Starting…</span>
            )}
          </Row>
          {agent.branch && (
            <Row label="Branch">
              <span className="flex min-w-0 items-center gap-1 font-mono text-[11px]">
                <GitBranch className="h-3 w-3 shrink-0 text-steel" />
                <span className="truncate">{agent.branch}</span>
              </span>
            </Row>
          )}
          {agent.baseCommit && (
            <Row label="Base">
              <span className="font-mono text-[11px] text-muted">
                {agent.baseBranch} @ {agent.baseCommit.slice(0, 7)}
              </span>
            </Row>
          )}
          <Row label="Started">
            <RelTime ts={agent.createdAt} long side="left" className="text-muted" />
          </Row>
          {agent.scheduleId && (
            <Row label="Schedule">
              <span className="flex items-center gap-1 text-muted">
                <CalendarClock className="h-3 w-3" /> Scheduled run
              </span>
            </Row>
          )}
          {hasPr && (
            <Row label="Pull request" stacked>
              <PrChip agent={agent} />
            </Row>
          )}
          <div>
            <dt className="mb-1 text-steel">Working directory</dt>
            <dd>
              <div className="selectable break-all rounded-lg border border-line bg-base/50 px-2 py-1.5 font-mono text-[11px] text-muted">
                {prettyPath(agent.cwd)}
              </div>
              <Button
                size="xs"
                variant="ghost"
                className="mt-1.5 -ml-1"
                onClick={() => void attempt("Couldn't open the folder", () => api.openPath(agent.cwd))}
              >
                <FolderOpen className="!h-3.5 !w-3.5" />
                Open folder
              </Button>
            </dd>
          </div>
        </dl>
      </Section>
    </m.aside>
  );
});

/** A touched file. The tooltip (a dozen components) is only mounted once the row has been hovered or focused. */
const FileRow = memo(function FileRow({ file: f, cwd }: { file: AgentDerived["files"][number]; cwd: string }) {
  const [armed, setArmed] = useState(false);
  const name = f.path.split("/").pop() ?? f.path;
  const dir = f.path.slice(0, f.path.length - name.length);
  const button = (
    <button
      type="button"
      aria-label={`Show ${f.path} in folder`}
      onClick={() => void attempt("Couldn't show the file", () => api.openPath(joinPath(cwd, f.path)))}
      onPointerEnter={armed ? undefined : () => setArmed(true)}
      onFocus={armed ? undefined : () => setArmed(true)}
      className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-raised"
    >
      {f.edited ? (
        <FilePen className="h-3.5 w-3.5 shrink-0 text-accent" />
      ) : (
        <FileSearch className="h-3.5 w-3.5 shrink-0 text-steel" />
      )}
      <span className="min-w-0 truncate font-mono text-[11.5px]">
        <span className={cn(f.edited ? "text-fg" : "text-muted")}>{name}</span>
        <span className="ml-1.5 text-steel">{dir}</span>
      </span>
    </button>
  );
  return (
    <li>
      {armed ? (
        <Tooltip
          side="left"
          content={
            <span className="flex flex-col">
              <span className="font-mono text-[11px]">{f.path}</span>
              <span className="text-steel">Click to show in folder</span>
            </span>
          }
        >
          {button}
        </Tooltip>
      ) : (
        button
      )}
    </li>
  );
});

/** Which account runs this agent, its plan and how much of each usage window is spent. */
function AccountSection({ account, agent }: { account: Account; agent: Agent }) {
  const usage = account.usage;
  const plan = account.status?.label ?? (usage?.plan ? usage.plan.charAt(0).toUpperCase() + usage.plan.slice(1) : null);
  return (
    <Section title="Account" icon={<UserRound />}>
      <div className="flex items-center gap-2 text-[12px]">
        <AccountAvatar account={account} size={18} showProvider={false} />
        <span className="min-w-0 truncate text-fg">{account.name}</span>
        {plan && <span className="ml-auto shrink-0 text-steel">{plan}</span>}
      </div>
      <BillingSummary account={account} provider={agent.provider} signal={agent.costUsd} className="mt-2.5" />
    </Section>
  );
}

function joinPath(base: string, p: string) {
  if (p.startsWith("/") || /^[A-Z]:\\/i.test(p)) return p;
  return `${base.replace(/[\\/]$/, "")}/${p}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-steel">{label}</dt>
      <dd className="font-medium tabular text-fg">{value}</dd>
    </div>
  );
}

/** `stacked` puts the value under its label, for values too wide to share the line (the pull request chip). */
function Row({ label, children, stacked }: { label: string; children: ReactNode; stacked?: boolean }) {
  return (
    <div className={stacked ? "space-y-1" : "flex items-center justify-between gap-3"}>
      <dt className="shrink-0 text-steel">{label}</dt>
      <dd className={cn("flex min-w-0", !stacked && "justify-end")}>{children}</dd>
    </div>
  );
}

function CompactRow({ agent }: { agent: Agent }) {
  const [busy, setBusy] = useState(false);
  const ratio = contextRatio(agent);
  const suggest = ratio >= COMPACT_SUGGEST_RATIO;
  return (
    <div
      className={cn(
        "mt-3 rounded-lg border px-2.5 py-2",
        suggest ? "border-warn/35 bg-warn/[0.07]" : "border-line bg-base/30",
      )}
    >
      {suggest && (
        <p className="mb-1.5 text-[11.5px] leading-snug text-muted">
          Context is {Math.round(ratio * 100)}% full. Compacting summarizes the conversation so the agent keeps room to
          work.
        </p>
      )}
      <Button
        size="xs"
        variant={suggest ? "warn" : "ghost"}
        className={cn(!suggest && "-ml-1")}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await compactContext(agent);
          setBusy(false);
        }}
      >
        {busy ? <Spinner className="h-3 w-3 text-current" /> : <Shrink className="!h-3.5 !w-3.5" />}
        Compact context
      </Button>
    </div>
  );
}
