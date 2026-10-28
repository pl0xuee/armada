import { Check, Copy, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { baseSyncLine, pushCommand } from "@/lib/gitResults";
import type { BaseBranchStatus } from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/misc";

/**
 * After "Commit & merge": the merge only touched the local base branch. Shows how far it is
 * from its upstream and lets the user push it (never automatically).
 */
export function PushBaseNotice({
  agentId,
  initial,
  disabled,
  onChange,
}: {
  agentId: string;
  initial: BaseBranchStatus | null;
  disabled?: boolean;
  onChange?: (s: BaseBranchStatus) => void;
}) {
  const [status, setStatus] = useState<BaseBranchStatus | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushed, setPushed] = useState(false);

  useEffect(() => {
    if (initial) return;
    let live = true;
    api
      .baseBranchStatus(agentId)
      .then((s) => live && setStatus(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [agentId, initial]);

  if (!status) return null;
  const command = pushCommand(status);
  const canPush = !!status.upstream && status.ahead > 0;

  const push = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.pushBaseBranch(agentId);
      setStatus(next);
      setPushed(true);
      onChange?.(next);
      toast.success(`Pushed to ${next.upstream ?? "origin"}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = () =>
    void navigator.clipboard
      .writeText(command)
      .then(() => toast.success("Copied", { description: command }))
      .catch(() => toast.error("Couldn't copy to the clipboard"));

  if (pushed && status.upstream && status.ahead === 0) {
    return (
      <p role="status" className="flex items-center gap-1.5 text-[12px] font-medium text-ok">
        <Check className="h-3.5 w-3.5" /> Pushed to {status.upstream} ✓
      </p>
    );
  }
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px]">
      <span className="min-w-0 flex-1 break-words text-muted">{baseSyncLine(status)}</span>
      {canPush && (
        <Button size="xs" variant="primary" onClick={push} disabled={busy || disabled}>
          {busy ? <Spinner className="h-3 w-3 text-current" /> : <Upload />}
          Push to {status.upstream?.split("/")[0] ?? "origin"}
        </Button>
      )}
      {(canPush || !status.upstream) && (
        <Button size="xs" variant="ghost" onClick={copy} title={`Copy: ${command}`}>
          <Copy /> Copy command
          <code className="ml-1 font-mono text-[10.5px] text-steel">{command}</code>
        </Button>
      )}
      {error && (
        <span role="alert" className="basis-full break-words text-err">
          {error}
        </span>
      )}
    </div>
  );
}
