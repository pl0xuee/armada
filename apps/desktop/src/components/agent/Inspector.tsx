import { Cpu, FilePen, FileSearch, FolderOpen, GitBranch, Hash, ListChecks, Shrink, Workflow } from "lucide-react";
import { m } from "motion/react";
import { useState, type ReactNode } from "react";
import { agentDerived } from "./derived";
import { isBusy } from "@/lib/agents";
import { canCompact, COMPACT_SUGGEST_RATIO, compactContext, contextRatio } from "./compact";
import { attempt } from "@/lib/actions";
import { api } from "@/lib/api";
import { agentCostText, formatTokens } from "@/lib/format";
import type { Agent, TimelineItem } from "@/lib/types";
import { cn, prettyPath } from "@/lib/utils";
import { ContextRing } from "../ContextRing";
import { RelTime } from "../RelTime";
import { CopyButton } from "../CopyButton";
import { PlanChecklist } from "../timeline/items";
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

export function Inspector({
  agent,
  items,
  className,
}: {
  agent: Agent;
  items: TimelineItem[] | undefined;
  className?: string;
}) {
  // Cached on tool-call structure: streaming text doesn't recompute (or re-sort) these.
  const { files, runningSubagents: subagents, plan } = agentDerived(agent.id, items, isBusy(agent));
  const done = plan?.entries.filter((e) => e.status === "completed").length ?? 0;

  return (
    <m.aside
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 12 }}
      transition={{ duration: 0.16 }}
      aria-label="Inspector"
      className={cn(
        "flex h-full w-[272px] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel/70",
        className,
      )}
    >
      <Section title="Usage" icon={<Cpu />}>
        <div className="flex items-center gap-4">
          {agent.contextSize ? (
            <ContextRing used={agent.contextUsed ?? 0} size={agent.contextSize} diameter={68} label="context" />
          ) : (
            <div className="flex h-[68px] w-[68px] items-center justify-center rounded-full border border-dashed border-line-strong text-[10px] text-steel">
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
            {files.slice(0, 40).map((f) => {
              const name = f.path.split("/").pop() ?? f.path;
              const dir = f.path.slice(0, f.path.length - name.length);
              return (
                <li key={f.path}>
                  <Tooltip
                    side="left"
                    content={
                      <span className="flex flex-col">
                        <span className="font-mono text-[11px]">{f.path}</span>
                        <span className="text-steel">Click to show in folder</span>
                      </span>
                    }
                  >
                    <button
                      type="button"
                      aria-label={`Show ${f.path} in folder`}
                      onClick={() =>
                        void attempt("Couldn't show the file", () => api.openPath(joinPath(agent.cwd, f.path)))
                      }
                      className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-raised"
                    >
                      {f.edited ? (
                        <FilePen className="h-3.5 w-3.5 shrink-0 text-accent" />
                      ) : (
                        <FileSearch className="h-3.5 w-3.5 shrink-0 text-steel" />
                      )}
                      <span className="min-w-0 truncate font-mono text-[11.5px]">
                        <span className={cn(f.edited ? "text-fg" : "text-muted")}>{name}</span>
                        <span className="ml-1.5 text-steel/80">{dir}</span>
                      </span>
                    </button>
                  </Tooltip>
                </li>
              );
            })}
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
          <div>
            <dt className="mb-1 text-steel">Working directory</dt>
            <dd className="selectable break-all rounded-lg border border-line bg-base/50 px-2 py-1.5 font-mono text-[11px] text-muted">
              {prettyPath(agent.cwd)}
            </dd>
            <Button
              size="xs"
              variant="ghost"
              className="mt-1.5 -ml-1"
              onClick={() => void attempt("Couldn't open the folder", () => api.openPath(agent.cwd))}
            >
              <FolderOpen className="!h-3.5 !w-3.5" />
              Open folder
            </Button>
          </div>
        </dl>
      </Section>
    </m.aside>
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

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-steel">{label}</dt>
      <dd className="flex min-w-0 justify-end">{children}</dd>
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
