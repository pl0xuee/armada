import { memo, useState } from "react";
import { cn } from "@/lib/cn";
import { devParam } from "@/lib/dev";
import { basename, formatCost, formatDuration, formatTokens, plural } from "@/lib/format";
import { isRunning, isSubagentNode, latestChild, type SubagentNode } from "@/lib/rows";
import { setReviewFocus } from "@/lib/reviewFocus";
import { subagentChips, type InheritedConfig } from "@/lib/subagents";
import { noteUserLayoutChange } from "@/lib/scroll";
import type { TurnSummaryItem } from "@/lib/types";
import { Icon, Spinner } from "../Icon";
import { CommitSheet, commitBlocked } from "../CommitSheet";
import { ImageStrip } from "../Images";
import { Button } from "../ui";
import { navigate } from "@/lib/router";
import { useStore } from "@/lib/store";
import { Markdown } from "../Markdown";
import { ToolRow } from "./Items";
import { SubagentChips } from "./SubagentChips";

const EXPAND_ALL = devParam("expand") === "1";

type Phase = "running" | "paused" | "failed" | "done";

/**
 * `running`: working now (an unfinished call of a live agent, or a background sub-agent whose
 * launch call already completed but which is still counted as running). `paused`: the call never
 * finished and the agent stopped.
 */
function phaseOf(call: SubagentNode["call"], agentLive: boolean, bgRunning: boolean): Phase {
  const unfinished = isRunning(call);
  if ((unfinished && agentLive) || bgRunning) return "running";
  if (unfinished) return "paused";
  return call.status === "failed" ? "failed" : "done";
}

const PHASE_COLOR: Record<Phase, string> = { running: "var(--accent)", paused: "var(--violet)", failed: "var(--err)", done: "var(--ok)" };

/** A long final report is clamped until asked for. */
const RESULT_CLAMP_CHARS = 360;

function Result({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const long = text.length > RESULT_CLAMP_CHARS || text.split("\n").length > 8;
  return (
    <div className="border-t border-line/70 px-3 pt-2.5 pb-1">
      <div className="mb-1 text-[11px] font-semibold tracking-wider text-steel uppercase">Result</div>
      <div className={cn("min-w-0", long && !full && "max-h-[9.5rem] overflow-hidden [mask-image:linear-gradient(180deg,#000_70%,transparent)]")}>
        <Markdown text={text} interim />
      </div>
      {long && (
        <button
          type="button"
          onClick={() => {
            noteUserLayoutChange();
            setFull((v) => !v);
          }}
          className="press hit relative -ml-1 flex h-9 items-center px-1 text-[13px] font-semibold text-accent"
          aria-expanded={full}
        >
          {full ? "Show less" : "Show full result"}
        </button>
      )}
    </div>
  );
}

/** A tool call that launched a sub-agent, with the sub-agent's own calls nested inside. */
export const SubagentCard = memo(function SubagentCard({
  node,
  agentLive = true,
  bgRunning,
  inherited,
  depth = 0,
}: {
  node: SubagentNode;
  /** False when the agent isn't running (stopped / interrupted): an unfinished call is paused, not spinning. */
  agentLive?: boolean;
  /** toolCallIds of background sub-agents that are still running after their launch call completed. */
  bgRunning?: ReadonlySet<string>;
  /** The main agent's model and effort, shown for the ones this sub-agent doesn't name. */
  inherited?: InheritedConfig;
  depth?: number;
}) {
  const { call } = node;
  const [open, setOpen] = useState(EXPAND_ALL);
  const [showPrompt, setShowPrompt] = useState(false);
  const background = !!call.subagent?.background;
  const phase = phaseOf(call, agentLive, background && call.status === "completed" && !!bgRunning?.has(call.toolCallId));
  const running = phase === "running";
  const color = PHASE_COLOR[phase];
  const result = phase === "running" || phase === "paused" ? "" : call.output.trim();
  const latest = latestChild(node);
  const kind = call.subagent?.kind?.trim();
  const description = call.subagent?.description?.trim() || call.title;
  const prompt = call.subagent?.prompt?.trim();
  // A nested sub-agent inherits from its parent sub-agent, whose values aren't known here: only named ones show.
  const chips = subagentChips(call.subagent, depth === 0 ? inherited : undefined);

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
          {running && <span className="animate-pulse-ring-soft absolute inset-0 rounded-[10px]" style={{ background: color }} aria-hidden />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] font-semibold tracking-wider text-steel uppercase">
            <span className="shrink-0 whitespace-nowrap">Sub-agent</span>
            {kind ? <span className="truncate normal-case tracking-normal text-muted">· {kind}</span> : null}
          </span>
          <span className="mt-0.5 line-clamp-2 block text-[14.5px] leading-snug font-medium text-fg">{description}</span>
          <SubagentChips chips={chips} className="mt-1" />
          {/* One line. The latest step is a wrapping flex item that needs ~6rem: when it can't fit beside the
              status it wraps onto a second line that is clipped, instead of showing as a stub ("· R…"). */}
          <span className="mt-1 flex h-[18px] min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 overflow-hidden text-[12.5px] leading-[18px] text-steel">
            <span className="shrink-0 whitespace-nowrap">
              {background && <span className={running ? "font-medium text-accent" : "text-steel"}>{running ? "Running in background" : "Background"} · </span>}
              <span className="tabular">{plural(node.total, "tool call")}</span>
            </span>
            {latest && (running || !open) && (
              <span className="min-w-0 flex-1 basis-24 truncate">
                <span aria-hidden>· </span>
                {latest.title}
              </span>
            )}
          </span>
        </span>
        <span className="mt-1 flex shrink-0 items-center gap-1.5">
          {running ? (
            <Spinner size={16} className="text-accent" />
          ) : phase === "paused" ? (
            <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="text-violet" role="img" aria-label="Paused">
              <circle cx="12" cy="12" r="9" />
              <path d="M10 9v6M14 9v6" />
            </svg>
          ) : phase === "failed" ? (
            <Icon name="x" size={17} strokeWidth={2.2} className="text-err" label="Failed" />
          ) : (
            <Icon name="check" size={17} strokeWidth={2.2} className="text-ok" label="Done" />
          )}
          <Icon name="chevronDown" size={16} className={cn("text-steel transition-transform duration-150", !open && "-rotate-90")} />
        </span>
      </button>
      {result && <Result text={result} />}
      {open && (
        <div className="animate-fade mt-1 border-t border-line/70">
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
            <p className="px-3 py-3 text-[13px] text-steel">{running ? "Getting started…" : phase === "paused" ? "Paused." : "No tool calls."}</p>
          ) : (
            <div className="divide-y divide-line/60">
              {node.children.map((c) =>
                isSubagentNode(c) ? (
                  <div key={c.call.id} className="p-2 pl-3">
                    <SubagentCard node={c} agentLive={agentLive} bgRunning={bgRunning} inherited={inherited} depth={depth + 1} />
                  </div>
                ) : (
                  <ToolRow key={c.id} item={c} agentLive={agentLive} />
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
  // Only the owner can open a review; a share link shows the names only.
  const owner = useStore((st) => st.session?.scope === "owner");
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
              <li key={f} className="max-w-full min-w-0">
                {owner ? (
                  <button
                    type="button"
                    title={f}
                    aria-label={`Review changes to ${basename(f) || f}`}
                    onClick={() => {
                      setReviewFocus(item.agentId, f);
                      navigate({ name: "review", agentId: item.agentId });
                    }}
                    className="press inline-flex h-11 max-w-full items-center gap-1.5 rounded-xl border border-line bg-card px-3 font-mono text-[12px] text-muted"
                  >
                    <Icon name="file" size={13} className="shrink-0 text-steel" />
                    <span className="truncate">{basename(f) || f}</span>
                  </button>
                ) : (
                  <span
                    title={f}
                    className="inline-flex max-w-full items-center gap-1 truncate rounded-lg border border-line bg-card px-2 py-1 font-mono text-[11.5px] text-muted"
                  >
                    <Icon name="file" size={12} className="shrink-0 text-steel" />
                    <span className="truncate">{basename(f) || f}</span>
                  </span>
                )}
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
                  className="press inline-flex h-11 items-center rounded-lg px-2 text-[13px] font-medium text-accent"
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
