import { Cpu, FilePen, FileSearch, FolderOpen, GitBranch, Hash, ListChecks } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, type ReactNode } from "react";
import { filesTouched, latestPlan } from "@/lib/agents";
import { api } from "@/lib/api";
import { formatCost, formatTokens, fullDate } from "@/lib/format";
import type { Agent, TimelineItem } from "@/lib/types";
import { cn, prettyPath } from "@/lib/utils";
import { ContextRing } from "../ContextRing";
import { CopyButton } from "../CopyButton";
import { PlanChecklist } from "../timeline/items";
import { Button } from "../ui/button";
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
  const files = useMemo(() => filesTouched(items ?? []), [items]);
  const plan = useMemo(() => latestPlan(items ?? []), [items]);
  const done = plan?.entries.filter((e) => e.status === "completed").length ?? 0;

  return (
    <motion.aside
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
            <Stat label="Cost" value={formatCost(agent.costUsd)} />
            <Stat label="Tokens" value={formatTokens(agent.tokensUsed)} />
            {agent.contextSize ? (
              <Stat
                label="Context"
                value={`${formatTokens(agent.contextUsed ?? 0)} / ${formatTokens(agent.contextSize)}`}
              />
            ) : null}
          </dl>
        </div>
      </Section>

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
                      onClick={() => void api.openPath(joinPath(agent.cwd, f.path))}
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
                <CopyButton text={agent.sessionId} label="" className="h-5 px-1" />
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
            <span className="text-muted">{fullDate(agent.createdAt)}</span>
          </Row>
          <div>
            <dt className="mb-1 text-steel">Working directory</dt>
            <dd className="selectable break-all rounded-lg border border-line bg-base/50 px-2 py-1.5 font-mono text-[11px] text-muted">
              {prettyPath(agent.cwd)}
            </dd>
            <Button size="xs" variant="ghost" className="mt-1.5 -ml-1" onClick={() => void api.openPath(agent.cwd)}>
              <FolderOpen className="!h-3.5 !w-3.5" />
              Open folder
            </Button>
          </div>
        </dl>
      </Section>
    </motion.aside>
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
