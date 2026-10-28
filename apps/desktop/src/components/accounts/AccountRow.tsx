import { CircleAlert, LogIn, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AccountAvatar } from "@/components/AccountAvatar";
import { UsageMeters } from "@/components/UsageMeter";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/tooltip";
import { useNow } from "@/hooks/useNow";
import { checkAccount, startLogin } from "@/lib/actions";
import { api } from "@/lib/api";
import { relativeTimeLong } from "@/lib/format";
import type { Account } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { useApp } from "@/store/app";
import { EditAccountPopover } from "./EditAccountPopover";

const AUTH_LABEL: Record<Account["authKind"], string> = {
  default: "Default login",
  oauth: "Subscription",
  api_key: "API key",
};

export function AccountRow({ account, compact }: { account: Account; compact?: boolean }) {
  const now = useNow();
  const [checking, setChecking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const agentCount = useApp(
    (s) => Object.values(s.agents).filter((a) => a.accountId === account.id && !a.archived).length,
  );
  const st = account.status;
  const usage = account.usage;
  const loggedIn = st?.loggedIn ?? false;

  const onCheck = async () => {
    setChecking(true);
    await checkAccount(account);
    setChecking(false);
  };

  const onDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteAccount(account.id);
      useApp.getState().removeAccount(account.id);
      toast(`Removed “${account.name}”`);
      setConfirmDelete(false);
    } catch (e) {
      toast.error("Couldn't remove account", { description: errorMessage(e) });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="@container/acct">
      <div className={cn("group flex items-center gap-3 px-4 @lg/acct:gap-3.5", compact ? "py-2.5" : "py-3.5")}>
        <AccountAvatar account={account} size={compact ? 30 : 36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[13.5px] font-medium text-fg">{account.name}</span>
            {account.isSystem ? <Badge>System (default login)</Badge> : <Badge>{AUTH_LABEL[account.authKind]}</Badge>}
            {!compact && agentCount > 0 && (
              <span className="text-[11.5px] text-steel tabular">
                · {agentCount} agent{agentCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <div
            className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px]"
            title={st ? `Checked ${relativeTimeLong(st.checkedAt, now)}` : undefined}
          >
            {st === null ? (
              <span className="text-steel">Status unknown. Run a check.</span>
            ) : loggedIn ? (
              <>
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok shadow-[0_0_6px_var(--ok)]" />
                <span className="truncate text-muted">
                  {[st.label, st.plan && st.plan !== st.label ? st.plan : null, st.email].filter(Boolean).join(" · ") ||
                    "Signed in"}
                </span>
              </>
            ) : (
              <>
                <CircleAlert className="h-3.5 w-3.5 shrink-0 text-warn" />
                <span className="truncate text-warn/90">{st.error ?? "Not signed in"}</span>
              </>
            )}
            {!compact && st && (
              <span className="hidden shrink-0 text-steel/80 @2xl/acct:inline">
                · checked {relativeTimeLong(st.checkedAt, now)}
              </span>
            )}
          </div>
          {usage && (usage.primary || usage.secondary) && (
            <div className={cn("flex flex-wrap items-end gap-x-4 gap-y-1.5", compact ? "mt-1.5" : "mt-2.5")}>
              <UsageMeters usage={usage} className="w-full max-w-[460px]" />
              {!compact && (
                <span className="hidden pb-px text-[11px] text-steel/80 @xl/acct:inline">
                  updated {relativeTimeLong(usage.updatedAt, now)}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5 @lg/acct:gap-1">
          {(!loggedIn || !compact) && account.authKind !== "api_key" && (
            <Tooltip content={loggedIn ? "Sign in again" : "Sign in"}>
              <Button
                size="sm"
                variant={loggedIn ? "ghost" : "primary"}
                onClick={() => void startLogin(account)}
                aria-label={`${loggedIn ? "Sign in again to" : "Sign in to"} ${account.name}`}
                className={cn(loggedIn && "w-8 px-0 @2xl/acct:w-auto @2xl/acct:px-2.5")}
              >
                <LogIn />
                <span className={cn(loggedIn && "hidden @2xl/acct:inline")}>{loggedIn ? "Re-sign in" : "Sign in"}</span>
              </Button>
            </Tooltip>
          )}
          <Tooltip content="Check sign-in status">
            <Button size="icon-sm" variant="ghost" onClick={onCheck} disabled={checking} aria-label="Check account">
              <RefreshCw className={cn(checking && "animate-spin")} />
            </Button>
          </Tooltip>
          {!compact && (
            <>
              <EditAccountPopover account={account}>
                <Button size="icon-sm" variant="ghost" aria-label="Rename or recolor">
                  <Pencil />
                </Button>
              </EditAccountPopover>
              {!account.isSystem && (
                <Tooltip content="Remove account">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="hover:!bg-err/12 hover:!text-err"
                    onClick={() => setConfirmDelete(true)}
                    aria-label="Remove account"
                  >
                    <Trash2 />
                  </Button>
                </Tooltip>
              )}
            </>
          )}
        </div>

        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          danger
          busy={deleting}
          title={`Remove “${account.name}”?`}
          description={
            <>
              Armada will delete this profile's isolated config directory
              {account.authKind === "api_key"
                ? " and remove its API key from your OS keychain"
                : " and its saved login"}
              .
              {agentCount > 0 &&
                ` ${agentCount} agent${agentCount === 1 ? " uses" : "s use"} this account and won't be able to resume.`}
            </>
          }
          confirmLabel="Remove account"
          onConfirm={onDelete}
        />
      </div>
    </div>
  );
}
