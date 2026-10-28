import { memo, useState } from "react";
import { cn } from "@/lib/cn";
import { devParam } from "@/lib/dev";
import { basename, formatCost, formatDuration, formatTokens, plural } from "@/lib/format";
import { isRunning, isSubagentNode, latestChild, type SubagentNode } from "@/lib/rows";
import { noteUserLayoutChange } from "@/lib/scroll";
import type { TurnSummaryItem } from "@/lib/types";
import { Icon, Spinner } from "../Icon";
import { CommitSheet, commitBlocked } from "../CommitSheet";
import { ImageStrip } from "../Images";
import { Button } from "../ui";
import { navigate } from "@/lib/router";
import { useStore } from "@/lib/store";
import { ToolRow } from "./Items";

const EXPAND_ALL = devParam("expand") === "1";

function statusColor(node: SubagentNode) {
  if (isRunning(node.call)) return "var(--accent)";
  return node.call.status === "failed" ? "var(--err)" : "var(--ok)";
}

/** A tool call that launched a sub-agent, with the sub-agent's own calls nested inside. */
export const SubagentCard = memo(function SubagentCard({ node, depth = 0 }: { node: SubagentNode; depth?: number }) {
  const { call } = node;
  const [open, setOpen] = useState(EXPAND_ALL);
  const [showPrompt, setShowPrompt] = useState(false);
  const running = isRunning(call);
  const color = statusColor(node);
  const latest = latestChild(node);
  const kind = call.subagent?.kind?.trim();
  const description = call.subagent?.description?.trim() || call.title;
  const prompt = call.subagent?.prompt?.trim();

  return (
    <section
      aria-label={`Sub-agent: ${description}`}
      className={cn("overflow-hidden rounded-2xl border bg-panel edge", depth > 0 && "rounded-xl")}
      style={{ borderColor: `color-mix(in srgb, ${color} ${running ? 38 : 18}%, var(--border))` }}
    >
      <button
        type="button"
        onClick={() => {
          noteUserLayoutChange();
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        className="press-row flex w-full items-start gap-3 px-3 py-3 text-left"
      >
        <span
          className="relative mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]"
          style={{ color, background: `color-mix(in srgb, ${color} 13%, transparent)` }}
        >
          <Icon name="bot" size={18} />
          {running && <span className="animate-pulse-ring absolute inset-0 rounded-[10px]" style={{ background: color, opacity: 0.25 }} aria-hidden />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[11.5px] font-semibold tracking-wider text-steel uppercase">
            Sub-agent{kind ? <span className="truncate normal-case tracking-normal text-muted">· {kind}</span> : null}
          </span>
          <span className="mt-0.5 line-clamp-2 block text-[14.5px] leading-snug font-medium text-fg">{description}</span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[12.5px] text-steel">
            <span className="shrink-0 tabular">{plural(node.total, "tool call")}</span>
            {latest && (running || !open) && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{latest.title}</span>
              </>
            )}
          </span>
        </span>
        <span className="mt-1 flex shrink-0 items-center gap-1.5">
          {running ? (
            <Spinner size={16} className="text-accent" />
          ) : call.status === "failed" ? (
            <Icon name="x" size={17} strokeWidth={2.2} className="text-err" label="Failed" />
          ) : (
            <Icon name="check" size={17} strokeWidth={2.2} className="text-ok" label="Done" />
          )}
          <Icon name="chevronDown" size={16} className={cn("text-steel transition-transform duration-150", !open && "-rotate-90")} />
        </span>
      </button>
      {open && (
        <div className="animate-fade border-t border-line/70">
          {prompt && (
            <div className="border-b border-line/70 px-3 py-2.5">
              <button
                type="button"
                onClick={() => {
                  noteUserLayoutChange();
                  setShowPrompt((v) => !v);
                }}
                className="press hit relative flex h-8 items-center gap-1 text-[12px] font-semibold tracking-wider text-steel uppercase"
                aria-expanded={showPrompt}
              >
                Task
                <Icon name="chevronDown" size={14} className={cn("transition-transform duration-150", !showPrompt && "-rotate-90")} />
              </button>
              <p className={cn("text-[13.5px] leading-relaxed whitespace-pre-wrap text-muted", !showPrompt && "line-clamp-2")}>{prompt}</p>
            </div>
          )}
          {call.images && call.images.length > 0 && <ImageStrip images={call.images} className="px-3 pt-3" />}
          {node.children.length === 0 ? (
            <p className="px-3 py-3 text-[13px] text-steel">{running ? "Getting started…" : "No tool calls."}</p>
          ) : (
            <div className="divide-y divide-line/60">
              {node.children.map((c) =>
                isSubagentNode(c) ? (
                  <div key={c.call.id} className="p-2 pl-3">
                    <SubagentCard node={c} depth={depth + 1} />
                  </div>
                ) : (
                  <ToolRow key={c.id} item={c} />
                ),
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
});

const FILES_SHOWN = 4;

/** The review card shown when a turn finishes. */
export const TurnSummaryCard = memo(function TurnSummaryCard({ item, latest = false }: { item: TurnSummaryItem; latest?: boolean }) {
  const [allFiles, setAllFiles] = useState(false);
  const files = item.files ?? [];
  const shownFiles = allFiles ? files : files.slice(0, FILES_SHOWN);
  const stats: { label: string; value: string }[] = [];
  if (item.commands > 0) stats.push({ label: item.commands === 1 ? "Command" : "Commands", value: String(item.commands) });
  if (item.toolCalls > 0) stats.push({ label: item.toolCalls === 1 ? "Tool call" : "Tool calls", value: String(item.toolCalls) });
  if (item.costUsd > 0) stats.push({ label: "Cost", value: formatCost(item.costUsd) });
  if (item.tokens > 0) stats.push({ label: "Tokens", value: formatTokens(item.tokens) });
  const duration = formatDuration(item.durationMs);

  return (
    <section aria-label="Turn summary" className="overflow-hidden rounded-2xl border border-ok/25 bg-panel edge">
      <div className="flex items-center gap-2.5 px-4 pt-3 pb-2">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-ok/90 text-base">
          <Icon name="check" size={14} strokeWidth={3} />
        </span>
        <span className="text-[14.5px] font-semibold text-fg">Done</span>
        {duration && <span className="text-[13px] text-steel tabular">in {duration}</span>}
      </div>
      {files.length > 0 && (
        <div className="px-4 pb-2">
          <p className="mb-1.5 text-[13px] text-muted">{plural(files.length, "file")} changed</p>
          <ul className="flex flex-wrap gap-1.5">
            {shownFiles.map((f) => (
              <li
                key={f}
                title={f}
                className="inline-flex max-w-full items-center gap-1 truncate rounded-lg border border-line bg-card px-2 py-1 font-mono text-[11.5px] text-muted"
              >
                <Icon name="file" size={12} className="shrink-0 text-steel" />
                <span className="truncate">{basename(f) || f}</span>
              </li>
            ))}
            {files.length > FILES_SHOWN && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    noteUserLayoutChange();
                    setAllFiles((v) => !v);
                  }}
                  className="press hit relative inline-flex h-[26px] items-center rounded-lg px-2 text-[12px] font-medium text-accent"
                >
                  {allFiles ? "Show less" : `+${files.length - FILES_SHOWN} more`}
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
      {latest && files.length > 0 && <SummaryActions agentId={item.agentId} />}
      {stats.length > 0 && (
        <dl className="mt-1 grid border-t border-line/70" style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }}>
          {stats.map((s, i) => (
            <div key={s.label} className={cn("px-3 py-2.5 text-center", i > 0 && "border-l border-line/70")}>
              <dt className="truncate text-[11px] text-steel">{s.label}</dt>
              <dd className="text-[14px] font-semibold text-fg tabular">{s.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
});

/** Review / Commit straight from the latest "Done" card (owner only). */
function SummaryActions({ agentId }: { agentId: string }) {
  const owner = useStore((st) => st.session?.scope === "owner");
  const agent = useStore((st) => st.agents[agentId]);
  const [sheet, setSheet] = useState<"commit" | "ship" | null>(null);
  if (!owner || !agent) return null;
  const blocked = commitBlocked(agent);
  return (
    <div className="flex flex-wrap gap-2 px-4 pt-1 pb-3">
      <Button size="sm" variant="secondary" icon="file" onClick={() => navigate({ name: "review", agentId })}>
        Review changes
      </Button>
      <Button size="sm" variant="secondary" disabled={!!blocked} onClick={() => setSheet("commit")}>
        Commit…
      </Button>
      {agent.worktree && (
        <Button size="sm" variant="secondary" disabled={!!blocked} onClick={() => setSheet("ship")}>
          Commit & merge…
        </Button>
      )}
      <CommitSheet agent={agent} mode={sheet} onClose={() => setSheet(null)} />
    </div>
  );
}
