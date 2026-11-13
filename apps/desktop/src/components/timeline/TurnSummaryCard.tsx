import {
  Check,
  CircleCheckBig,
  FileCode2,
  GitCommitHorizontal,
  GitCompare,
  GitMerge,
  GitPullRequest,
  MessageSquarePlus,
  Undo2,
} from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { attempt } from "@/lib/actions";
import { conflictPrompt, gitBusyReason, mergeToast, shipOutcome, toastCommit } from "@/lib/gitResults";
import { findFileSlice, slicePatch } from "@/lib/patchSlices";
import { formatCost, formatTokens, pluralize } from "@/lib/format";
import type { Agent, BaseBranchStatus, TimelineItem } from "@/lib/types";
import { basename, cn, errorMessage } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useBackground } from "@/store/background";
import { backgroundActive, backgroundDetail } from "@/lib/background";
import { useUi } from "@/store/ui";
import { useMinimal } from "@/hooks/useLook";
import { PushBaseNotice } from "../git/PushBaseNotice";
import { ConfirmDialog } from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input, Label } from "../ui/input";
import { Spinner } from "../ui/misc";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Tooltip } from "../ui/tooltip";
import { formatElapsed } from "./thinking";
import { turnFileStats } from "./turnFiles";

type Summary = Extract<TimelineItem, { kind: "turn_summary" }>;

/** "6m 42s", "48s", "1h 3m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** One-line recap used for earlier turns (only the latest gets the full card). */
export const TurnSummaryLine = memo(function TurnSummaryLine({ item }: { item: Summary }) {
  return (
    <div className="flex items-center gap-2 px-1 text-meta text-steel minimal:px-0">
      <CircleCheckBig className="h-3.5 w-3.5 text-ok/70 minimal:text-steel" />
      <span>
        Done in {formatDuration(item.durationMs)} · {pluralize(item.files.length, "file")} ·{" "}
        {pluralize(item.toolCalls, "tool call")} · {formatCost(item.costUsd)}
      </span>
    </div>
  );
});

/** Ship state per summary this session (survives virtualized remounts). */
type ShipState =
  { kind: "shipped"; baseStatus: BaseBranchStatus | null } | { kind: "not_merged"; error: string; conflict: boolean };
const shipStates = new Map<string, ShipState>();

/** A long list of changed files would push the conversation away: this many show, the rest behind "+N more". */
export const FILES_SHOWN = 5;
/** Summaries whose full file list was opened this session (survives virtualized remounts, so heights stay put). */
const expandedFiles = new Set<string>();

/** The files to show as chips, and how many are folded away. */
export function visibleFiles(
  files: readonly string[],
  expanded: boolean,
): { shown: readonly string[]; hidden: number } {
  // Folding a single file behind "+1 more" saves nothing.
  if (expanded || files.length <= FILES_SHOWN) return { shown: files, hidden: 0 };
  const shown = files.slice(0, FILES_SHOWN - 1);
  return { shown, hidden: files.length - shown.length };
}

/** Ready-to-ship card after a turn that used tools: what changed, and what to do next. */
export const TurnSummaryCard = memo(function TurnSummaryCard({ item, agent }: { item: Summary; agent: Agent }) {
  const setReviewAgent = useUi((s) => s.setReviewAgent);
  const focusComposer = useUi((s) => s.focusComposer);
  const [busy, setBusy] = useState<null | "commit" | "ship">(null);
  const [shipState, setShipState] = useState<ShipState | null>(() => shipStates.get(item.id) ?? null);
  const shipped = shipState?.kind === "shipped";
  const [revertFile, setRevertFile] = useState<string | null>(null);
  const hasFiles = item.files.length > 0;
  const [allFiles, setAllFiles] = useState(() => expandedFiles.has(item.id));
  const { shown: files, hidden: hiddenFiles } = visibleFiles(item.files, allFiles);
  const showAllFiles = (on: boolean) => {
    if (on) expandedFiles.add(item.id);
    else expandedFiles.delete(item.id);
    setAllFiles(on);
  };
  // Animate only when the card appears live, not when an old conversation is opened.
  const [fresh] = useState(() => Date.now() - item.ts < 10_000);
  const busyReason = gitBusyReason(agent);
  const agentBusy = busyReason !== null;
  // A newer prompt means a new turn started: this summary no longer describes the latest state.
  const stale = useApp((s) => {
    const list = s.items[agent.id];
    if (!list) return false;
    for (let i = list.length - 1; i >= 0 && list[i].seq > item.seq; i--) {
      if (list[i].kind === "user_message") return true;
    }
    return false;
  });
  // Still true after the turn ended: say so next to "Done", which is only about the turn itself.
  const bg = useBackground(agent.id);
  const bgRunning = backgroundActive(bg) && !stale && agent.status === "idle";
  const gitDisabled = busy !== null || agentBusy || stale || shipped;
  const gitReason = shipped
    ? "Already shipped"
    : stale
      ? "A newer turn has started; review the current diff instead"
      : (busyReason ?? undefined);

  const run = async (kind: "commit" | "ship", message: string) => {
    setBusy(kind);
    try {
      const secrets = await api.secretLookingFiles(agent.id).catch(() => [] as string[]);
      if (secrets.length > 0) {
        toast.error("These files look like secrets", {
          description: `${secrets.slice(0, 4).join(", ")}${secrets.length > 4 ? ", ..." : ""}. Open the review to commit them or leave them out.`,
          duration: 10000,
        });
        return false;
      }
      if (kind === "commit") {
        toastCommit(await api.commitAgent(agent.id, message));
      } else {
        const o = shipOutcome(await api.shipAgent(agent.id, message));
        const next: ShipState =
          o.kind === "shipped"
            ? { kind: "shipped", baseStatus: o.baseStatus }
            : { kind: "not_merged", error: o.error, conflict: o.conflict };
        if (o.kind === "shipped")
          toast.success("Committed & merged locally", {
            description: mergeToast(agent.branch ?? "Branch", agent.baseBranch ?? "main", o.baseStatus),
          });
        else toast.warning("Committed, but not merged", { description: o.error, duration: 10000 });
        shipStates.set(item.id, next);
        setShipState(next);
      }
      return true;
    } catch (e) {
      toast.error(kind === "commit" ? "Commit failed" : "Commit & merge failed", { description: errorMessage(e) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const metrics = `${pluralize(item.toolCalls, "tool call")} · ${pluralize(item.commands, "command")} · ${formatCost(item.costUsd)} · ${formatTokens(item.tokens)} tokens`;
  const minimal = useMinimal();
  // Lines added and removed per file, from the turn's own edits. The turn is over, so they are read again
  // only when older history loads (the oldest loaded item changes), not on every streamed word.
  const oldestId = useApp((s) => (minimal ? s.items[agent.id]?.[0]?.id : undefined));
  const stats = useMemo(
    () => (minimal ? turnFileStats(useApp.getState().items[agent.id] ?? [], item.id, item.files) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- oldestId stands for the loaded history
    [minimal, agent.id, item.id, item.files, oldestId],
  );
  if (minimal && stats) {
    let additions = 0;
    let deletions = 0;
    for (const s of stats.values()) {
      additions += s.additions;
      deletions += s.deletions;
    }
    const state = shipped ? "Merged locally" : shipState?.kind === "not_merged" ? "Committed, not merged" : null;
    const chips = (
      <>
        {stale && !shipped && (
          <span className="shrink-0 rounded-md border border-line-strong px-1.5 text-micro font-medium text-muted">
            Earlier turn
          </span>
        )}
        {bgRunning && (
          <Tooltip content={backgroundDetail(bg)}>
            <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-1.5 text-micro font-medium text-accent">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
              {bg.workflows > 0 ? "Workflow still running" : "Background agents may still run"}
            </span>
          </Tooltip>
        )}
      </>
    );
    const title = (text: string) => (
      <Tooltip content={`Done in ${formatElapsed(item.durationMs)} · ${metrics}`}>
        <span
          tabIndex={0}
          aria-label={`Turn finished. ${metrics}`}
          className="min-w-0 truncate rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {text}
        </span>
      </Tooltip>
    );
    const quiet = "text-steel hover:text-fg";
    return (
      <section aria-label="Turn finished">
        {hasFiles ? (
          <div className="tl-well overflow-hidden rounded-[11px] border border-line">
            <header className="flex h-10 items-center gap-2 pl-3.5 pr-2 text-small font-medium text-fg/90">
              {title(state ?? pluralize(item.files.length, "changed file"))}
              {stats.size > 0 && (
                <span className="shrink-0 font-mono text-caption font-normal tabular-nums">
                  <span className="text-ok">+{additions}</span> <span className="text-err">−{deletions}</span>
                </span>
              )}
              {chips}
              <Button size="xs" variant="secondary" className="ml-auto" onClick={() => setReviewAgent(agent.id)}>
                <GitCompare /> Open diff
              </Button>
            </header>
            <ul aria-label="Files changed">
              {files.map((f) => {
                const s = stats.get(f);
                const cut = f.lastIndexOf("/") + 1;
                return (
                  <li key={f} className="group/file flex h-[30px] items-center border-t border-line">
                    <Tooltip content={`Open diff · ${f}`}>
                      <button
                        type="button"
                        onClick={() => setReviewAgent(agent.id, f)}
                        className="flex h-full min-w-0 flex-1 items-center gap-2 pl-3.5 pr-2 text-left font-mono text-caption text-steel transition-colors hover:bg-raised/40 focus-visible:outline-offset-[-2px]"
                      >
                        <span className="min-w-0 truncate">
                          {f.slice(0, cut)}
                          <span className="text-fg/85">{f.slice(cut)}</span>
                        </span>
                        {s && (
                          <span className="ml-auto shrink-0 tabular-nums">
                            <span className="text-ok">+{s.additions}</span>{" "}
                            <span className="text-err">−{s.deletions}</span>
                          </span>
                        )}
                      </button>
                    </Tooltip>
                    {!shipped && (
                      <Tooltip content={`Revert changes to ${basename(f)}…`}>
                        <button
                          type="button"
                          onClick={() => setRevertFile(f)}
                          disabled={agentBusy}
                          title={busyReason ?? undefined}
                          aria-label={`Revert changes to ${f}`}
                          className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-steel opacity-0 transition-[opacity,color,background-color] duration-150 hover:bg-err/12 hover:text-err focus-visible:opacity-100 focus-visible:outline-offset-[-2px] disabled:opacity-0 group-hover/file:opacity-100 group-hover/file:disabled:opacity-45"
                        >
                          <Undo2 className="h-3 w-3" />
                        </button>
                      </Tooltip>
                    )}
                  </li>
                );
              })}
              {(hiddenFiles > 0 || (allFiles && item.files.length > FILES_SHOWN)) && (
                <li className="flex h-[30px] items-center border-t border-line">
                  <button
                    type="button"
                    onClick={() => showAllFiles(!allFiles)}
                    aria-expanded={allFiles}
                    aria-label={allFiles ? "Show fewer files" : `Show ${pluralize(hiddenFiles, "more file")}`}
                    className="flex h-full w-full items-center pl-3.5 text-left text-caption text-steel transition-colors hover:bg-raised/40 hover:text-fg focus-visible:outline-offset-[-2px]"
                  >
                    {allFiles ? "Show fewer" : `+${hiddenFiles} more`}
                  </button>
                </li>
              )}
            </ul>
          </div>
        ) : (
          <div className="flex h-7 items-center gap-2 text-small text-steel">
            <Check className="h-3.5 w-3.5 shrink-0 text-ok/70" aria-hidden />
            {title(state ?? `Done in ${formatElapsed(item.durationMs)}`)}
            {chips}
            <Button size="xs" variant="ghost" className={cn("ml-auto", quiet)} onClick={focusComposer}>
              <MessageSquarePlus /> Continue
            </Button>
          </div>
        )}

        {shipState?.kind === "shipped" && (
          <div className="mt-2.5">
            <PushBaseNotice agentId={agent.id} initial={shipState.baseStatus} />
          </div>
        )}
        {shipState?.kind === "not_merged" && (
          <div
            role="status"
            className="mt-2.5 flex flex-wrap items-center gap-2 rounded-[11px] border border-warn/20 bg-warn/[0.07] px-3 py-2 text-caption"
          >
            <span className="min-w-0 flex-1 break-words text-muted">{shipState.error}</span>
            {shipState.conflict && (
              <Button
                size="xs"
                variant="secondary"
                onClick={() =>
                  void attempt("Couldn't send the request", () =>
                    api.sendPrompt(agent.id, conflictPrompt(agent, shipState.error)),
                  ).then((r) => r !== null && toast.success("Asked the agent to resolve the conflicts"))
                }
              >
                Ask the agent to resolve conflicts
              </Button>
            )}
          </div>
        )}
        {hasFiles && (
          <footer className="-ml-2 mt-1.5 flex flex-wrap items-center gap-0.5">
            <MessagePopover
              trigger={
                <Button size="xs" variant="ghost" className={quiet} disabled={gitDisabled} title={gitReason}>
                  {busy === "commit" ? <Spinner className="h-3.5 w-3.5" /> : <GitCommitHorizontal />}
                  Commit
                </Button>
              }
              title="Commit changes"
              hint={agent.branch ? `On ${agent.branch}` : "In the agent's working tree"}
              confirm="Commit"
              defaultMessage={agent.title}
              onConfirm={(m) => run("commit", m)}
            />
            {agent.worktree ? (
              <MessagePopover
                trigger={
                  <Button size="xs" variant="ghost" className={quiet} disabled={gitDisabled} title={gitReason}>
                    {busy === "ship" ? <Spinner className="h-3.5 w-3.5" /> : <GitMerge />}
                    Commit & merge
                  </Button>
                }
                title="Commit & merge"
                hint={`Commits anything uncommitted, then merges ${agent.branch ?? "this branch"} into ${agent.baseBranch ?? "main"}.`}
                confirm={`Merge into ${agent.baseBranch ?? "main"}`}
                defaultMessage={agent.title}
                onConfirm={(m) => run("ship", m)}
              />
            ) : (
              <span className="px-2 text-meta text-steel">Not in a worktree</span>
            )}
            {agent.branch && (
              <Button size="xs" variant="ghost" className={quiet} onClick={() => setReviewAgent(agent.id, null, "pr")}>
                <GitPullRequest /> Open PR
              </Button>
            )}
            <Button size="xs" variant="ghost" className={cn("-mr-2 ml-auto", quiet)} onClick={focusComposer}>
              <MessageSquarePlus /> Continue
            </Button>
          </footer>
        )}
        <RevertFileDialog agent={agent} path={revertFile} onClose={() => setRevertFile(null)} />
      </section>
    );
  }
  return (
    <section aria-label="Turn finished" className="border-t border-line/60 pt-3">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Tooltip content={metrics}>
          <span
            tabIndex={0}
            aria-label={`Turn finished. ${metrics}`}
            className="flex items-center gap-2 rounded-md text-body font-medium text-fg/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <span
              className="flex h-5 w-5 items-center justify-center rounded-full bg-ok/15 text-ok"
              style={fresh ? { animation: "var(--animate-done-pop), var(--animate-done-glow)" } : undefined}
            >
              <Check className="h-3 w-3" strokeWidth={3} />
            </span>
            {shipped
              ? "Merged locally"
              : shipState?.kind === "not_merged"
                ? "Committed, not merged"
                : !shipState
                  ? `Done in ${formatDuration(item.durationMs)}`
                  : "Done"}
            {hasFiles && !shipped && (
              <span className="font-normal text-steel">· {pluralize(item.files.length, "file")} changed</span>
            )}
          </span>
        </Tooltip>
        {stale && !shipped && (
          <span className="rounded-md border border-line-strong px-1.5 text-micro font-medium text-muted">
            Earlier turn
          </span>
        )}
        {bgRunning && (
          <Tooltip content={backgroundDetail(bg)}>
            <span className="inline-flex h-5 items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-1.5 text-micro font-medium text-accent">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent animate-breathe" />
              {bg.workflows > 0 ? "Workflow still running" : "Background agents may still run"}
            </span>
          </Tooltip>
        )}
      </header>

      {hasFiles && (
        <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Files changed">
          {files.map((f) => (
            <li key={f} className="inline-flex items-center overflow-hidden rounded-md border border-line bg-card/40">
              <Tooltip content={`Open diff · ${f}`}>
                <button
                  type="button"
                  onClick={() => setReviewAgent(agent.id, f)}
                  className="inline-flex h-6 max-w-[240px] items-center gap-1.5 px-2 font-mono text-meta text-fg transition-colors hover:bg-raised focus-visible:outline-offset-[-2px]"
                >
                  <FileCode2 className="h-3 w-3 shrink-0 text-steel" />
                  <span className="truncate">{basename(f)}</span>
                </button>
              </Tooltip>
              {!shipped && (
                <Tooltip content={`Revert changes to ${basename(f)}…`}>
                  <button
                    type="button"
                    onClick={() => setRevertFile(f)}
                    disabled={agentBusy}
                    title={busyReason ?? undefined}
                    aria-label={`Revert changes to ${f}`}
                    className="flex h-6 w-6 items-center justify-center border-l border-line text-steel transition-colors hover:bg-err/12 hover:text-err focus-visible:outline-offset-[-2px] disabled:opacity-45"
                  >
                    <Undo2 className="h-3 w-3" />
                  </button>
                </Tooltip>
              )}
            </li>
          ))}
          {(hiddenFiles > 0 || (allFiles && item.files.length > FILES_SHOWN)) && (
            <li className="inline-flex">
              <button
                type="button"
                onClick={() => showAllFiles(!allFiles)}
                aria-expanded={allFiles}
                aria-label={allFiles ? "Show fewer files" : `Show ${pluralize(hiddenFiles, "more file")}`}
                className="inline-flex h-6 items-center rounded-md px-2 text-meta font-medium text-muted transition-colors hover:bg-raised hover:text-fg"
              >
                {allFiles ? "Show fewer" : `+${hiddenFiles} more`}
              </button>
            </li>
          )}
        </ul>
      )}

      {shipState?.kind === "shipped" && (
        <div className="mt-2.5">
          <PushBaseNotice agentId={agent.id} initial={shipState.baseStatus} />
        </div>
      )}
      {shipState?.kind === "not_merged" && (
        <div
          role="status"
          className="mt-2.5 flex flex-wrap items-center gap-2 rounded-xl border border-warn/25 bg-warn/[0.07] px-3 py-2 text-caption"
        >
          <span className="min-w-0 flex-1 break-words text-muted">{shipState.error}</span>
          {shipState.conflict && (
            <Button
              size="xs"
              variant="secondary"
              onClick={() =>
                void attempt("Couldn't send the request", () =>
                  api.sendPrompt(agent.id, conflictPrompt(agent, shipState.error)),
                ).then((r) => r !== null && toast.success("Asked the agent to resolve the conflicts"))
              }
            >
              Ask the agent to resolve conflicts
            </Button>
          )}
        </div>
      )}
      <footer className="mt-3 flex flex-wrap items-center gap-1.5">
        {hasFiles && (
          <Button size="sm" variant="primary" onClick={() => setReviewAgent(agent.id)}>
            <GitCompare /> Review diff
          </Button>
        )}
        {hasFiles && (
          <MessagePopover
            trigger={
              <Button size="sm" variant="secondary" disabled={gitDisabled} title={gitReason}>
                {busy === "commit" ? <Spinner className="h-3.5 w-3.5" /> : <GitCommitHorizontal />}
                Commit
              </Button>
            }
            title="Commit changes"
            hint={agent.branch ? `On ${agent.branch}` : "In the agent's working tree"}
            confirm="Commit"
            defaultMessage={agent.title}
            onConfirm={(m) => run("commit", m)}
          />
        )}
        {hasFiles &&
          (agent.worktree ? (
            <MessagePopover
              trigger={
                <Button size="sm" variant="secondary" disabled={gitDisabled} title={gitReason}>
                  {busy === "ship" ? <Spinner className="h-3.5 w-3.5" /> : <GitMerge />}
                  Commit & merge
                </Button>
              }
              title="Commit & merge"
              hint={`Commits anything uncommitted, then merges ${agent.branch ?? "this branch"} into ${agent.baseBranch ?? "main"}.`}
              confirm={`Merge into ${agent.baseBranch ?? "main"}`}
              defaultMessage={agent.title}
              onConfirm={(m) => run("ship", m)}
            />
          ) : (
            <span className="px-1.5 text-meta text-steel">Not in a worktree</span>
          ))}
        {hasFiles && agent.branch && (
          <Button size="sm" variant="ghost" onClick={() => setReviewAgent(agent.id, null, "pr")}>
            <GitPullRequest /> Open PR
          </Button>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={focusComposer}>
          <MessageSquarePlus /> Continue
        </Button>
      </footer>
      <RevertFileDialog agent={agent} path={revertFile} onClose={() => setRevertFile(null)} />
    </section>
  );
});

/** Revert one file's changes from a summary chip: fetch the current diff, cut that file's exact section. */
function RevertFileDialog({ agent, path, onClose }: { agent: Agent; path: string | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revert = async () => {
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const diff = await api.getDiff(agent.id);
      const file = findFileSlice(slicePatch(diff.patch), path);
      if (!file) {
        setError("This file has no changes in the current diff (it may already be reverted or committed).");
        return;
      }
      const patch = file.text;
      await api.revertPatch(agent.id, patch);
      toast.success(`Reverted ${basename(path)}`, {
        description: path,
        duration: 12000,
        action: {
          label: "Undo",
          onClick: () => {
            api.applyPatch(agent.id, patch).then(
              () => toast.success("Revert undone"),
              (e) => toast.error("Couldn't undo the revert", { description: errorMessage(e) }),
            );
          },
        },
      });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      open={path !== null}
      onOpenChange={(o) => {
        if (!o && !busy) {
          setError(null);
          onClose();
        }
      }}
      danger
      busy={busy}
      title="Revert this file?"
      description={
        path && (
          <>
            This discards the agent's change to <span className="font-mono text-fg">{path}</span>; you can undo it right
            after.
          </>
        )
      }
      confirmLabel="Revert file"
      onConfirm={revert}
    >
      {error && (
        <p role="alert" className="rounded-lg border border-err/30 bg-err/[0.07] px-3 py-2 text-small text-err">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}

function MessagePopover({
  trigger,
  title,
  hint,
  confirm,
  defaultMessage,
  onConfirm,
}: {
  trigger: ReactNode;
  title: string;
  hint: string;
  confirm: string;
  defaultMessage: string;
  onConfirm: (message: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState(defaultMessage);
  const [busy, setBusy] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        setOpen(o);
        if (o) setMessage(defaultMessage);
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[340px]">
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            const ok = await onConfirm(message.trim() || defaultMessage);
            setBusy(false);
            if (ok) setOpen(false);
          }}
        >
          <div>
            <div className="text-body font-semibold">{title}</div>
            <p className="mt-0.5 text-caption text-muted">{hint}</p>
          </div>
          <div>
            <Label htmlFor={`msg-${title}`}>Commit message</Label>
            <Input
              id={`msg-${title}`}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              // Enter while an IME is composing must not submit the commit.
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault();
              }}
              autoFocus
              className="h-8"
            />
          </div>
          <div className="flex justify-end gap-2">
            <PopoverClose asChild>
              <Button size="sm" variant="ghost" type="button" disabled={busy}>
                Cancel
              </Button>
            </PopoverClose>
            <Button size="sm" variant="primary" type="submit" disabled={busy} className={cn(busy && "cursor-wait")}>
              {busy && <Spinner className="h-3.5 w-3.5 text-current" />}
              {confirm}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
