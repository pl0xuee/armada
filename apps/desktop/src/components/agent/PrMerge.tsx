import { GitMerge, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { MERGE_METHODS, mergeAdvice, readMergeMethod, rememberMergeMethod } from "@/lib/prFlow";
import type { Agent, MergeMethod, PrInfo } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { refreshPr } from "@/store/pr";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "../ui/dialog";
import { Spinner } from "../ui/misc";

/** Agents whose merge is in flight, so the dialog can't be dismissed half-way. */
const merging = new Set<string>();

/**
 * Confirms merging an agent's pull request on GitHub: pick how, see anything worth a second
 * look (failing checks, conflicts, open comments), then merge. GitHub has the last word.
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

function MergeBody({ agent, pr, onClose }: { agent: Agent; pr: PrInfo; onClose: () => void }) {
  const [method, setMethod] = useState<MergeMethod>(readMergeMethod);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { cautions } = mergeAdvice(pr);
  const base = pr.base ?? agent.baseBranch ?? "the base branch";

  const merge = async () => {
    setBusy(true);
    merging.add(agent.id);
    setError(null);
    try {
      const done = await api.prMerge(agent.id, method);
      rememberMergeMethod(method);
      toast.success(done);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      merging.delete(agent.id);
      setBusy(false);
      // Merged or refused, the panel should show what GitHub says now.
      void refreshPr(agent.id, true);
    }
  };

  return (
    <DialogContent
      title={`Merge #${pr.number} into ${base}`}
      description={pr.title || undefined}
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
                method === o.value ? "border-accent/50 bg-accent/[0.07]" : "border-line bg-card/60 hover:border-line-strong",
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
        {cautions.length > 0 && (
          <ul className="space-y-1 rounded-lg border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[12px] text-warn">
            {cautions.map((c) => (
              <li key={c} className="flex items-start gap-1.5">
                <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" /> <span>{c}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[12px] text-steel">
          This merges on GitHub. The agent's checkout and branch stay as they are.
        </p>
        {error && (
          <p
            role="alert"
            className="selectable rounded-lg border border-err/30 bg-err/[0.07] px-2.5 py-2 text-[12px] text-err"
          >
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void merge()} disabled={busy} autoFocus>
          {busy ? <Spinner className="h-3.5 w-3.5 text-current" /> : <GitMerge />}
          {cautions.length > 0 ? "Merge anyway" : "Merge"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
