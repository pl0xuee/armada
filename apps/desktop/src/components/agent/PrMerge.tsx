import { GitMerge, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { BRANCH_CHANGED_MESSAGE, isBranchChanged } from "@/lib/ghError";
import { MERGE_METHODS, mergeAdvice, mergeFacts, readMergeMethod, rememberMergeMethod, shortSha } from "@/lib/prFlow";
import type { Agent, MergeMethod, PrInfo } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { refreshPr, usePr } from "@/store/pr";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "../ui/dialog";
import { Spinner } from "../ui/misc";
import { GhError } from "../git/GhError";

/** A status read this much older than the dialog opening still counts as read for it (clock and promise slack). */
const FRESH_SLACK_MS = 1500;
const FACT_DOT = { ok: "bg-ok", warn: "bg-warn", err: "bg-err", muted: "bg-steel/60" } as const;

/** Agents whose merge is in flight, so the dialog can't be dismissed half-way. */
const merging = new Set<string>();

/**
 * Confirms merging an agent's pull request on GitHub: pick how, see anything worth a second
 * look (failing checks, conflicts, open comments), then merge. GitHub has the last word.
 *
 * What is shown is one fresh read of the pull request, taken when the dialog opens, and the
 * merge is pinned to that read's head commit: a push that lands afterwards is refused by GitHub
 * instead of being merged unreviewed, and the dialog then reads the new state and asks again.
 */
export function MergeDialog({
  agent,
  pr,
  open,
  onOpenChange,
}: {
  agent: Agent;
  pr: PrInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !merging.has(agent.id) && onOpenChange(o)}>
      {open && <MergeBody agent={agent} pr={pr} onClose={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function Note({ children }: { children: string }) {
  return (
    <p role="alert" className="rounded-lg border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[12px] text-warn">
      {children}
    </p>
  );
}

function MergeBody({ agent, pr: opened, onClose }: { agent: Agent; pr: PrInfo; onClose: () => void }) {
  const [method, setMethod] = useState<MergeMethod>(readMergeMethod);
  // The pull request as just read from GitHub; null while reading.
  const [pr, setPr] = useState<PrInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);

  // Only the newest read counts: a slower, older one must not overwrite it.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const mine = ++latest.current;
    const startedAt = Date.now();
    setPr(null);
    setLoadError(null);
    await refreshPr(agent.id, true);
    if (mine !== latest.current) return;
    const status = usePr.getState().byAgent[agent.id];
    if (status?.state === "ok" && status.pr && status.fetchedAt >= startedAt - FRESH_SLACK_MS) setPr(status.pr);
    else
      setLoadError(
        "Couldn't read the pull request from GitHub just now, so Kvistcode can't tell which commit you would merge. Try again.",
      );
  }, [agent.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const shown = pr ?? opened;
  const sha = pr?.headSha ?? null;
  const { cautions } = pr ? mergeAdvice(pr) : { cautions: [] as string[] };
  const base = shown.base ?? agent.baseBranch ?? "the base branch";
  const canMerge = !!pr && pr.state === "open" && !!sha && !busy;

  const merge = async () => {
    if (!pr || !sha) return;
    setBusy(true);
    merging.add(agent.id);
    setError(null);
    setMoved(false);
    try {
      const done = await api.prMerge(agent.id, method, sha);
      rememberMergeMethod(method);
      toast.success(done);
      onClose();
    } catch (e) {
      const text = errorMessage(e);
      if (isBranchChanged(text)) {
        // Nothing was merged. Read the new commits' state and let the user decide again.
        setMoved(true);
        void load();
      } else {
        setError(text);
      }
    } finally {
      merging.delete(agent.id);
      setBusy(false);
      // Merged or refused, the panel should show what GitHub says now.
      void refreshPr(agent.id, true);
    }
  };

  const finished =
    pr && pr.state !== "open"
      ? `This pull request is ${pr.state === "merged" ? "already merged" : pr.state === "closed" ? "closed" : "a draft again"}, so there is nothing to merge.`
      : null;

  return (
    <DialogContent
      title={`Merge #${shown.number} into ${base}`}
      description={shown.title || undefined}
      className="w-[min(460px,calc(100vw-16px))]"
    >
      <DialogBody className="space-y-3">
        <div role="radiogroup" aria-label="How to merge" className="space-y-1.5">
          {MERGE_METHODS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={method === o.value}
              disabled={busy}
              onClick={() => setMethod(o.value)}
              className={cn(
                "flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent/25",
                method === o.value
                  ? "border-accent/50 bg-accent/[0.07]"
                  : "border-line bg-card/60 hover:border-line-strong",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                  method === o.value ? "border-accent" : "border-line-strong",
                )}
              >
                {method === o.value && <span className="h-2 w-2 rounded-full bg-accent" />}
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-fg">{o.label}</span>
                <span className="block text-[11.5px] text-steel">{o.hint}</span>
              </span>
            </button>
          ))}
        </div>
        {moved && <Note>{BRANCH_CHANGED_MESSAGE}</Note>}
        {loadError ? (
          <div className="space-y-1.5">
            <GhError text={loadError} context={`Reading #${shown.number} before merging`} />
            <Button size="xs" variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : !pr ? (
          <div className="flex items-center gap-2 text-[12px] text-muted" role="status">
            <Spinner className="h-3.5 w-3.5" /> Checking GitHub for the latest commit…
          </div>
        ) : finished ? (
          <Note>{finished}</Note>
        ) : !sha ? (
          <Note>
            GitHub didn't say which commit this pull request is on, so it can't be merged from here. Merge it on GitHub.
          </Note>
        ) : (
          <>
            <div>
              <div className="text-[11.5px] text-steel">
                This is what you'd merge: commit <span className="font-mono text-fg/90 tabular">{shortSha(sha)}</span>
              </div>
              <ul className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]">
                {mergeFacts(pr).map((f) => (
                  <li key={f.key} className="flex min-w-0 items-center gap-1.5">
                    <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", FACT_DOT[f.tone])} />
                    <span className="truncate text-muted" title={f.text}>
                      {f.text}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {cautions.length > 0 && (
              <ul className="space-y-1 rounded-lg border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[12px] text-warn">
                {cautions.map((c) => (
                  <li key={c} className="flex items-start gap-1.5">
                    <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" /> <span>{c}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <p className="text-[12px] text-steel">
          This merges on GitHub. The agent's checkout and branch stay as they are.
        </p>
        {error && (
          <GhError
            text={error}
            context={`Merging #${shown.number} (${method}${sha ? `, commit ${shortSha(sha)}` : ""})`}
          />
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void merge()} disabled={!canMerge} autoFocus>
          {busy ? <Spinner className="h-3.5 w-3.5 text-current" /> : <GitMerge />}
          {cautions.length > 0 ? "Merge anyway" : "Merge"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
