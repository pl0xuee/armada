import { ChevronDown, Gauge, Play, Settings2, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { switchAccount } from "@/lib/actions";
import { PROVIDERS } from "@/lib/providers";
import type { Agent } from "@/lib/types";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { AccountAvatar } from "../AccountAvatar";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Spinner } from "../ui/misc";

const FAILOVER_LABEL = { off: "Off", ask: "Ask me", auto: "Switch automatically" } as const;

/** Shown above the composer when the agent's account hit its usage limit. */
export function RateLimitBanner({ agent }: { agent: Agent }) {
  const accounts = useApp((s) => s.accounts);
  const failover = useApp((s) => s.settings?.failover ?? "ask");
  const [busy, setBusy] = useState(false);
  const current = accounts.find((a) => a.id === agent.accountId);
  const candidates = useMemo(
    () => accounts.filter((a) => a.provider === agent.provider && a.id !== agent.accountId && a.status?.loggedIn),
    [accounts, agent.provider, agent.accountId],
  );
  const provider = PROVIDERS[agent.provider].short;
  const first = candidates[0];

  const go = async (accountId: string, cont: boolean) => {
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) return;
    setBusy(true);
    await switchAccount(agent, acc, cont);
    setBusy(false);
  };

  return (
    <div
      role="alert"
      className="relative mb-2.5 overflow-hidden rounded-xl border border-warn/35 bg-gradient-to-b from-warn/[0.09] to-card/80 edge"
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-warn/60 to-transparent" />
      <div className="flex flex-wrap items-center gap-3 px-3.5 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-warn/40 bg-warn/15 text-warn">
          <Gauge className="h-4 w-4" />
        </span>
        <div className="min-w-[200px] flex-1">
          <div className="text-[13px] font-semibold">This account hit its usage limit</div>
          <div className="text-[12px] leading-snug text-muted">
            {current ? `${provider} · ${current.name}` : provider}.{" "}
            {first
              ? "Move to another account to keep going. The session and its history come along."
              : `No other signed-in ${provider} accounts. Add one to keep going now.`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {first ? (
            <>
              <Button size="sm" variant="warn" disabled={busy} onClick={() => void go(first.id, true)}>
                {busy ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Play className="!h-3.5 !w-3.5" />}
                Switch to {first.name} & continue
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="secondary" disabled={busy} aria-label="More switch options">
                    Switch to…
                    <ChevronDown className="!h-3.5 !w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuLabel>Signed-in {provider} accounts</DropdownMenuLabel>
                  {candidates.map((a) => (
                    <DropdownMenuItem key={a.id} onSelect={() => void go(a.id, false)}>
                      <AccountAvatar account={a} size={18} showProvider={false} compact />
                      <span className="min-w-0 flex-1 truncate">{a.name}</span>
                      <span className="truncate text-[11px] text-steel">{a.status?.label ?? ""}</span>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => useUi.getState().setView("accounts")}>
                    <UserPlus /> Add another account
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => useUi.getState().setView("accounts")}>
              <UserPlus className="!h-3.5 !w-3.5" /> Add {provider} account
            </Button>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => useUi.getState().openSettings("behavior")}
        className="flex w-full items-center gap-1.5 border-t border-warn/15 bg-base/30 px-3.5 py-1.5 text-left text-[11.5px] text-steel transition-colors hover:text-muted"
      >
        <Settings2 className="h-3 w-3" />
        Automatic failover: <span className="text-muted">{FAILOVER_LABEL[failover]}</span>
        <span className="ml-auto">Change</span>
      </button>
    </div>
  );
}
