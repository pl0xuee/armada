import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { attempt } from "@/lib/actions";
import type { RestorePreview, TimelineItem } from "@/lib/types";
import { basename, cn, errorMessage } from "@/lib/utils";
import { ensureCheckpoints, refreshCheckpoints, useCheckpoints } from "@/store/checkpoints";
import { useApp } from "@/store/app";
import { insertIntoDraft } from "../agent/drafts";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "../ui/dialog";
import { Spinner } from "../ui/misc";

type UserItem = Extract<TimelineItem, { kind: "user_message" }>;

const STATUS_LABEL = { added: "restored", deleted: "removed", modified: "changed" } as const;

/** "Restore to here" on a user message: puts the agent's files back to how they were before it. */
export function RestoreAction({ item }: { item: UserItem }) {
  const agentId = item.agentId;
  useEffect(() => ensureCheckpoints(agentId), [agentId]);
  const checkpoint = useCheckpoints((s) => s.byAgent[agentId]?.byItem[item.id]);
  const available = useCheckpoints((s) => s.byAgent[agentId]?.available ?? false);
  const agent = useApp((s) => s.agents[agentId]);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const checkpointId = checkpoint?.id;
  useEffect(() => {
    if (!open || !checkpointId) return;
    let live = true;
    setPreview(null);
    setError(null);
    api
      .previewCheckpoint(agentId, checkpointId)
      .then((p) => live && setPreview(p))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [open, agentId, checkpointId]);

  if (!available || !checkpoint || !agent) return null;
  const working = agent.status === "working" || agent.status === "needs_permission" || agent.status === "starting";
  const folder = basename(agent.cwd);

  async function run(editPrompt: boolean) {
    if (!checkpointId) return;
    setBusy(true);
    const res = await attempt("Couldn't restore the files", () => api.restoreCheckpoint(agentId, checkpointId));
    setBusy(false);
    refreshCheckpoints(agentId);
    if (!res) return;
    setOpen(false);
    if (editPrompt && item.text) insertIntoDraft(agentId, item.text);
    toast.success(
      res.filesChanged === 0
        ? "Files already matched"
        : `Restored ${res.filesChanged} file${res.filesChanged === 1 ? "" : "s"}`,
      {
        description: "Your previous state was saved first.",
        duration: 12000,
        action: {
          label: "Undo",
          onClick: () => {
            void attempt("Couldn't undo the restore", () => api.restoreCheckpoint(agentId, res.safetyId)).then((r) => {
              refreshCheckpoints(agentId);
              if (r) toast.success("Restore undone");
            });
          },
        },
      },
    );
  }

  return (
    <>
      <button
        type="button"
        aria-label="Restore files to before this message"
        title={working ? "Stop the agent to restore files" : "Restore files to before this message"}
        disabled={working}
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-steel transition-colors hover:bg-raised hover:text-fg disabled:pointer-events-none disabled:opacity-40",
        )}
      >
        <RotateCcw className="h-3.5 w-3.5" />
        <span>Restore to here</span>
      </button>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent
          title="Restore files to here?"
          description={`Files in ${folder} go back to how they were before this message. Your current state is saved first so you can undo.`}
        >
          <DialogBody className="space-y-3">
            {error ? (
              <p className="text-[12.5px] text-err">{error}</p>
            ) : !preview ? (
              <div className="flex items-center gap-2 text-[12.5px] text-steel">
                <Spinner className="h-3.5 w-3.5" /> Comparing with the current files…
              </div>
            ) : preview.totalFiles === 0 ? (
              <p className="text-[12.5px] text-muted">The files already match this point. Nothing would change.</p>
            ) : (
              <div className="rounded-lg border border-line bg-base/40">
                <div className="flex items-center justify-between border-b border-line px-3 py-2 text-[12px] text-muted">
                  <span>
                    {preview.totalFiles} file{preview.totalFiles === 1 ? "" : "s"} will change
                  </span>
                  <span className="font-mono text-[11.5px]">
                    <span className="text-ok">+{preview.additions}</span>{" "}
                    <span className="text-err">−{preview.deletions}</span>
                  </span>
                </div>
                <ul className="max-h-56 overflow-y-auto py-1">
                  {preview.files.map((f) => (
                    <li key={f.path} className="flex items-center gap-2 px-3 py-1 text-[12px]">
                      <span className="min-w-0 flex-1 truncate font-mono" title={f.path}>
                        {f.path}
                      </span>
                      <span className="shrink-0 text-[11px] text-steel">{STATUS_LABEL[f.status]}</span>
                      <span className="shrink-0 font-mono text-[11px]">
                        <span className="text-ok">+{f.additions}</span> <span className="text-err">−{f.deletions}</span>
                      </span>
                    </li>
                  ))}
                  {preview.totalFiles > preview.files.length && (
                    <li className="px-3 py-1 text-[11.5px] text-steel">
                      and {preview.totalFiles - preview.files.length} more
                    </li>
                  )}
                </ul>
              </div>
            )}
            <p className="text-[11.5px] text-steel">
              Git history, branches and ignored files (like node_modules) are not touched.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            {item.text && (
              <Button variant="secondary" onClick={() => void run(true)} disabled={busy || !!error || !preview}>
                Restore and edit prompt
              </Button>
            )}
            <Button variant="primary" onClick={() => void run(false)} disabled={busy || !!error || !preview}>
              {busy ? <Spinner className="h-3.5 w-3.5 text-current" /> : <RotateCcw />}
              Restore files
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
