import { Eye, EyeOff, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Account } from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { useApp } from "@/store/app";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "../ui/dialog";
import { Input, Label } from "../ui/input";
import { Spinner } from "../ui/misc";

/** Replace an API-key account's key (stored in the OS keychain by the backend). */
export function ReplaceKeyDialog({
  account,
  open,
  onOpenChange,
}: {
  account: Account;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runningAgents = useApp(
    (s) => Object.values(s.agents).filter((a) => a.accountId === account.id && a.running).length,
  );

  useEffect(() => {
    if (!open) return;
    setKey("");
    setShow(false);
    setError(null);
  }, [open]);

  const submit = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateAccountKey(account.id, key.trim());
      useApp.getState().upsertAccount(updated);
      // Verify the new key right away so a typo shows up now, not on the next agent launch.
      void api
        .checkAccount(account.id)
        .then((checked) => {
          useApp.getState().upsertAccount(checked);
          if (!checked.status?.loggedIn)
            toast.warning(`The new key for ${account.name} was rejected`, {
              description: checked.status?.error ?? "Check the key and replace it again.",
            });
        })
        .catch(() => {});
      toast.success(`Key replaced for ${account.name}`, {
        description: runningAgents
          ? `${runningAgents} running agent${runningAgents === 1 ? " keeps" : "s keep"} the old key until restarted.`
          : undefined,
      });
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        title={`Replace API key · ${account.name}`}
        description="The new key is stored in your OS keychain and used by agents started from now on."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogBody className="space-y-3">
            <div>
              <Label htmlFor="replace-key">New API key</Label>
              <div className="relative">
                <Input
                  id="replace-key"
                  type={show ? "text" : "password"}
                  autoComplete="off"
                  autoFocus
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  aria-invalid={!!error}
                  aria-describedby={error ? "replace-key-error" : undefined}
                  className="pr-9 font-mono text-[12.5px]"
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  aria-label={show ? "Hide key" : "Show key"}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-steel transition-colors hover:text-fg"
                >
                  {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
              {error && (
                <p id="replace-key-error" role="alert" className="mt-1.5 text-[12px] text-err">
                  {error}
                </p>
              )}
            </div>
            {runningAgents > 0 && (
              <p className="rounded-lg border border-line bg-base/40 px-3 py-2 text-[12px] text-muted">
                {runningAgents === 1
                  ? "1 running agent on this account keeps using the old key until it restarts."
                  : `${runningAgents} running agents on this account keep using the old key until they restart.`}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!key.trim() || busy}>
              {busy ? <Spinner className="h-3.5 w-3.5 text-current" /> : <KeyRound />}
              Replace key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
