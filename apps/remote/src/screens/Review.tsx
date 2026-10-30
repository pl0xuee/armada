import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommitSheet, commitBlocked } from "@/components/CommitSheet";
import { Icon } from "@/components/Icon";
import { FileBlock } from "@/components/timeline/DiffView";
import { TopBar } from "@/components/TopBar";
import { Button, IconButton } from "@/components/ui";
import { errorMessage, type AgentDiffSummary } from "@/lib/api";
import { cn } from "@/lib/cn";
import { loadDiff } from "@/lib/controller";
import { parseUnified } from "@/lib/diff";
import { plural, shortPath } from "@/lib/format";
import { findFileIndex, takeReviewFocus } from "@/lib/reviewFocus";
import { goBack } from "@/lib/router";
import { useStore } from "@/lib/store";
import { EmptyState, ErrorState } from "./States";

const STATUS_BADGE: Record<string, { letter: string; color: string }> = {
  added: { letter: "A", color: "var(--ok)" },
  modified: { letter: "M", color: "var(--accent)" },
  deleted: { letter: "D", color: "var(--err)" },
  renamed: { letter: "R", color: "var(--violet)" },
};

/** What the agent changed: file list, the patch (cheap unified renderer), and commit actions. */
export function Review({ agentId }: { agentId: string }) {
  const agent = useStore((s) => s.agents[agentId]);
  const [diff, setDiff] = useState<AgentDiffSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"commit" | "ship" | null>(null);

  const load = useCallback(() => {
    setError(null);
    loadDiff(agentId)
      .then((d) => setDiff(d))
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [agentId]);
  useEffect(load, [load]);

  const files = useMemo(() => (diff?.patch ? parseUnified(diff.patch, "patch") : []), [diff?.patch]);
  // A file tapped in a turn summary: open and scroll to it once the patch is there.
  const [focus] = useState(() => takeReviewFocus(agentId));
  const focusIdx = useMemo(() => (focus ? findFileIndex(files.map((f) => f.path), focus) : -1), [focus, files]);
  // The tapped file may have no change any more (committed or reverted since the summary).
  const [missingDismissed, setMissingDismissed] = useState(false);
  const missingFocus =
    focus && diff && diff.files.length > 0 && !missingDismissed && focusIdx < 0 && findFileIndex(diff.files.map((f) => f.path), focus) < 0
      ? focus
      : null;
  const scrolled = useRef(false);
  useEffect(() => {
    if (focusIdx < 0 || scrolled.current) return;
    scrolled.current = true;
    requestAnimationFrame(() => document.getElementById(`diff-${focusIdx}`)?.scrollIntoView({ block: "start" }));
  }, [focusIdx]);
  const blocked = agent ? commitBlocked(agent) : null;
  const totals = useMemo(
    () => (diff ? diff.files.reduce((t, f) => ({ add: t.add + (f.additions || 0), del: t.del + (f.deletions || 0) }), { add: 0, del: 0 }) : null),
    [diff],
  );

  let body;
  if (error && !diff) body = <ErrorState title="Couldn't load the changes" body={error} onRetry={load} />;
  else if (!diff) body = <div className="skeleton h-48 w-full rounded-2xl" aria-busy="true" aria-label="Loading changes" />;
  else if (!diff.files.length)
    body = <EmptyState icon="check" tone="ok" title="No changes" body={diff.ahead ? `${plural(diff.ahead, "commit")} not merged yet.` : "There's nothing to commit."} />;
  else
    body = (
      <div className="space-y-5">
        {missingFocus && (
          <div role="status" className="flex items-center gap-2.5 rounded-2xl border border-line-strong bg-card py-1 pr-1 pl-3.5 edge">
            <Icon name="info" size={17} className="shrink-0 text-steel" />
            <p className="min-w-0 flex-1 py-2 text-[13.5px] leading-snug text-muted">
              No current changes in <span className="font-mono text-fg" title={missingFocus}>{shortPath(missingFocus, 2)}</span>
            </p>
            <button
              type="button"
              onClick={() => setMissingDismissed(true)}
              aria-label="Dismiss"
              className="press inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-steel active:bg-raised"
            >
              <Icon name="x" size={17} />
            </button>
          </div>
        )}
        <section className="rounded-2xl border border-line bg-panel p-4 edge">
          <p className="text-[15px] font-semibold text-fg">
            {plural(diff.files.length, "file")} changed
            {totals && (
              <span className="ml-2 font-mono text-[13px] font-normal tabular">
                <span className="text-ok">+{totals.add}</span> <span className="text-err">−{totals.del}</span>
              </span>
            )}
          </p>
          <p className="mt-1 text-[13px] text-muted">
            {diff.worktree && diff.branch ? (
              <>
                <span className="font-mono">{diff.branch}</span> → <span className="font-mono">{diff.baseBranch ?? "base"}</span> ·{" "}
              </>
            ) : null}
            {diff.uncommitted ? `${plural(diff.uncommitted, "uncommitted file")}` : "Everything committed"}
            {diff.ahead ? ` · ${plural(diff.ahead, "commit")} ahead` : ""}
          </p>
        </section>

        <section aria-label="Changed files">
          <ul className="overflow-hidden rounded-2xl border border-line bg-panel">
            {diff.files.map((f, i) => {
              const badge = STATUS_BADGE[f.status] ?? { letter: "?", color: "var(--steel)" };
              const idx = files.findIndex((p) => p.path === f.path);
              return (
                <li key={f.path} className={cn(i > 0 && "border-t border-line/70")}>
                  <a href={idx >= 0 ? `#diff-${idx}` : undefined} onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(`diff-${idx}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
                  }} className="press-row flex min-h-11 items-center gap-3 px-3.5 py-2">
                    <span
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md font-mono text-[12px] font-bold"
                      style={{ color: badge.color, background: `color-mix(in srgb, ${badge.color} 14%, transparent)` }}
                      aria-label={f.status}
                    >
                      {badge.letter}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg" title={f.path}>
                      {shortPath(f.path, 3)}
                    </span>
                    <span className="shrink-0 font-mono text-[12px] tabular">
                      <span className="text-ok">+{f.additions}</span> <span className="text-err">−{f.deletions}</span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-label="Patch" className="space-y-2">
          {files.map((f, i) => (
            <FileBlock key={`${f.path}-${i}`} id={`diff-${i}`} file={f} defaultOpen={files.length <= 4 || i === focusIdx} />
          ))}
          {diff.truncated && (
            <p className="flex items-start gap-2 rounded-xl border border-line bg-panel px-3 py-2.5 text-[13px] text-muted">
              <Icon name="info" size={16} className="mt-px shrink-0" />
              The patch is too large to show in full here. Review the rest in Armada on your computer.
            </p>
          )}
        </section>
      </div>
    );

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar left={<IconButton icon="chevronLeft" label="Back" onClick={goBack} />} right={<IconButton icon="refresh" label="Reload changes" onClick={load} />}>
        <div className="min-w-0">
          <h1 className="truncate text-[17px] leading-tight font-semibold text-fg">Review changes</h1>
          {agent && <p className="truncate text-[12px] leading-tight text-muted">{agent.title}</p>}
        </div>
      </TopBar>
      <main className="mx-auto w-full max-w-[860px] flex-1 px-safe pt-4 pb-8">{body}</main>
      {agent && diff && (diff.files.length > 0 || diff.ahead > 0) && (
        <div className="chrome sticky bottom-0 z-20 border-t border-line/70 pb-[max(12px,var(--safe-bottom))]">
          <div className="mx-auto w-full max-w-[860px] px-safe pt-3">
            {blocked && <p className="mb-2 text-center text-[12.5px] text-warn">{blocked}</p>}
            <div className={cn("grid gap-2", diff.worktree ? "grid-cols-2" : "grid-cols-1")}>
              <Button variant={diff.worktree ? "secondary" : "primary"} size="lg" disabled={!!blocked || !diff.uncommitted} onClick={() => setSheet("commit")}>
                Commit
              </Button>
              {diff.worktree && (
                <Button variant="primary" size="lg" disabled={!!blocked} onClick={() => setSheet("ship")}>
                  Commit & merge
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
      {agent && <CommitSheet
          agent={agent}
          mode={sheet}
          onClose={() => setSheet(null)}
          onDone={load}
          changes={diff && totals ? { files: diff.files.length, additions: totals.add, deletions: totals.del } : null}
        />}
    </div>
  );
}
