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
import { memo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { attempt } from "@/lib/actions";
import { conflictPrompt, gitBusyReason, mergeToast, shipOutcome, toastCommit } from "@/lib/gitResults";
import { findFileSlice, slicePatch } from "@/lib/patchSlices";
import { formatCost, formatTokens, pluralize } from "@/lib/format";
import type { Agent, BaseBranchStatus, TimelineItem } from "@/lib/types";
import { basename, cn, errorMessage } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { PushBaseNotice } from "../git/PushBaseNotice";
import { ConfirmDialog } from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input, Label } from "../ui/input";
import { Spinner } from "../ui/misc";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Tooltip } from "../ui/tooltip";

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
    <div className="flex items-center gap-2 px-1 text-[11.5px] text-steel">
      <CircleCheckBig className="h-3.5 w-3.5 text-ok/70" />
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

/** Ready-to-ship card after a turn that used tools: what changed, and what to do next. */
export const TurnSummaryCard = memo(function TurnSummaryCard({ item, agent }: { item: Summary; agent: Agent }) {
  const setReviewAgent = useUi((s) => s.setReviewAgent);
  const focusComposer = useUi((s) => s.focusComposer);
  const [busy, setBusy] = useState<null | "commit" | "ship">(null);
  const [shipState, setShipState] = useState<ShipState | null>(() => shipStates.get(item.id) ?? null);
  const shipped = shipState?.kind === "shipped";
  const [revertFile, setRevertFile] = useState<string | null>(null);
  const hasFiles = item.files.length > 0;
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
  return (
    <section aria-label="Turn finished" className="border-t border-line/60 pt-3">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Tooltip content={metrics}>
          <span
            tabIndex={0}
            aria-label={`Turn finished. ${metrics}`}
            className="flex items-center gap-2 rounded-md text-[13px] font-medium text-fg/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
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
          <span className="rounded-md border border-line-strong px-1.5 text-[10.5px] font-medium text-muted">
            Earlier turn
          </span>
        )}
      </header>

      {hasFiles && (
        <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Files changed">
          {item.files.map((f) => (
            <li key={f} className="inline-flex items-center overflow-hidden rounded-md border border-line bg-card/40">
              <Tooltip content={`Open diff · ${f}`}>
                <button
                  type="button"
                  onClick={() => setReviewAgent(agent.id, f)}
                  className="inline-flex h-6 max-w-[240px] items-center gap-1.5 px-2 font-mono text-[11.5px] text-fg/85 transition-colors hover:bg-raised hover:text-fg"
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
                    className="flex h-6 w-6 items-center justify-center border-l border-line text-steel transition-colors hover:bg-err/12 hover:text-err disabled:opacity-40"
                  >
                    <Undo2 className="h-3 w-3" />
                  </button>
                </Tooltip>
              )}
            </li>
          ))}
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
          className="mt-2.5 flex flex-wrap items-center gap-2 rounded-xl border border-warn/25 bg-warn/[0.07] px-3 py-2 text-[12px]"
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
            <span className="px-1.5 text-[11.5px] text-steel">Not in a worktree</span>
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
      await api.revertPatch(agent.id, file.text);
      toast.success(`Reverted ${basename(path)}`, { description: path });
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
            This discards the agent's change to <span className="font-mono text-fg">{path}</span>; it can't be undone.
          </>
        )
      }
      confirmLabel="Revert file"
      onConfirm={revert}
    >
      {error && (
        <p role="alert" className="rounded-lg border border-err/30 bg-err/[0.07] px-3 py-2 text-[12.5px] text-err">
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
            <div className="text-[13px] font-semibold">{title}</div>
            <p className="mt-0.5 text-[12px] text-muted">{hint}</p>
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
