import { Check, ChevronDown, Plus } from "lucide-react";
import { switchAccount } from "@/lib/actions";
import { PROVIDERS } from "@/lib/providers";
import type { Agent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { AccountAvatar } from "../AccountAvatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Tooltip } from "../ui/tooltip";

/**
 * The account this agent runs on, right in the agent header. Click it to run the agent on another
 * account of the same provider (its history comes along). Not possible mid-turn, so it says so.
 */
export function AccountSwitcher({ agent, showName }: { agent: Agent; showName: boolean }) {
  const accounts = useApp((s) => s.accounts);
  const current = accounts.find((a) => a.id === agent.accountId);
  if (!current) return null;
  const options = accounts.filter((a) => a.provider === agent.provider);
  const busy = agent.status === "working" || agent.status === "starting" || agent.status === "needs_permission";

  return (
    <DropdownMenu>
      <Tooltip content={`Account: ${current.name}. Click to use another.`}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Account: ${current.name}. Change account`}
            className={cn(
              "inline-flex h-6 min-w-0 max-w-[168px] items-center gap-1.5 rounded-full border border-line bg-card/60 text-[11.5px] text-muted transition-colors hover:border-line-strong hover:text-fg data-[state=open]:border-accent/50",
              showName ? "pl-1 pr-1.5" : "px-1",
            )}
          >
            <AccountAvatar account={current} size={16} showProvider={false} compact />
            {showName && <span className="max-w-[12ch] min-w-0 truncate">{current.name}</span>}
            <ChevronDown className="h-3 w-3 shrink-0 text-steel" />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-[236px]">
        <DropdownMenuLabel>Run this agent on</DropdownMenuLabel>
        {options.map((a) => {
          const isCurrent = a.id === agent.accountId;
          const signedIn = !!a.status?.loggedIn;
          return (
            <DropdownMenuItem
              key={a.id}
              disabled={!isCurrent && (!signedIn || busy)}
              onSelect={() => {
                if (!isCurrent) void switchAccount(agent, a, agent.rateLimited);
              }}
              className="h-auto min-h-9 py-1.5"
            >
              <AccountAvatar account={a} size={20} showProvider={false} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{a.name}</span>
                <span className={cn("truncate text-[11.5px]", signedIn ? "text-steel" : "text-warn")}>
                  {signedIn
                    ? [a.status?.label, a.status?.email].filter(Boolean).join(" · ") || "Signed in"
                    : "Not signed in"}
                </span>
              </span>
              {isCurrent && <Check className="!text-accent" />}
            </DropdownMenuItem>
          );
        })}
        {busy && options.length > 1 && (
          <p className="px-2 pb-1 pt-0.5 text-[11.5px] leading-snug text-steel">
            Wait for the current turn to finish, or stop it, before switching.
          </p>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => useUi.getState().setView("accounts")}>
          <Plus /> {options.length > 1 ? "Manage accounts…" : `Add another ${PROVIDERS[agent.provider].short} account…`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
