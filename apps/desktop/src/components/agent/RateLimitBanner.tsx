import { ArrowRightLeft, ChevronDown, Gauge, Play, RotateCcw, Settings2, Timer, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { attempt, switchAccount } from "@/lib/actions";
import { api } from "@/lib/api";
import { limitCopy } from "@/lib/limitBanner";
import { useMinuteNow, waitingToResume } from "@/lib/limitResume";
import { withoutReset } from "@/lib/pinned";
import { PROVIDERS } from "@/lib/providers";
import type { Account, Agent } from "@/lib/types";
import { useApp } from "@/store/app";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";
import { AccountAvatar } from "../AccountAvatar";
import { ProviderGlyph } from "../ProviderGlyph";
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
import { Tooltip } from "../ui/tooltip";

/** Plan / status line for an account, flagging API-key accounts as billed per token. */
function accountDetail(a: Account): string {
  if (a.authKind === "api_key") return "API key · billed per token";
  return a.status?.label ?? a.status?.plan ?? "Signed in";
}

const FAILOVER_LABEL = { off: "Off", ask: "Ask me", auto: "Switch automatically" } as const;

/**
 * Shown above the composer when the agent's account hit its rate limit: a plain headline, one main
 * button, and everything else under "More". `embedded`: a row of the
 * pinned dock (no card of its own, compact).
 */
export function RateLimitBanner({ agent, embedded = false }: { agent: Agent; embedded?: boolean }) {
  const accounts = useApp((s) => s.accounts);
  const failover = useApp((s) => s.settings?.failover ?? "ask");
  const [busy, setBusy] = useState(false);
  // The provider's own wording ("resets at 5pm"), from the newest error notice and the last prompt to re-send.
  const notice = useApp((s) => {
    const list = s.items[agent.id];
    for (let i = (list?.length ?? 0) - 1; i >= 0; i--) {
      const it = list![i];
      if (it.kind === "notice" && it.level === "error") return it.text;
      if (it.kind === "user_message") return null;
    }
    return null;
  });
  // What to re-send: the user's own last message, not our automatic "continue".
  const lastPrompt = useApp((s) => s.items[agent.id]?.findLast((i) => i.kind === "user_message" && !i.automatic));
  const resumeOn = useApp((s) => s.settings?.resumeAfterLimit ?? true);
  const waiting = waitingToResume(agent, resumeOn);
  const retry = async () => {
    if (lastPrompt?.kind !== "user_message") return;
    setBusy(true);
    await attempt("Couldn't retry", async () => {
      if (!agent.running) await api.resumeAgent(agent.id, false);
      await api.sendPrompt(agent.id, lastPrompt.text, lastPrompt.attachments ?? []);
    });
    setBusy(false);
  };
  const current = accounts.find((a) => a.id === agent.accountId);
  // Plan-covered accounts first, so the one-click switch never lands on a pay-per-token key by default.
  const candidates = useMemo(
    () =>
      accounts
        .filter((a) => a.provider === agent.provider && a.id !== agent.accountId && a.status?.loggedIn)
        .sort((a, b) => Number(a.authKind === "api_key") - Number(b.authKind === "api_key")),
    [accounts, agent.provider, agent.accountId],
  );
  const provider = PROVIDERS[agent.provider].short;
  const first = candidates[0];
  const now = useMinuteNow(waiting);
  const copy = limitCopy(agent, resumeOn, notice, now);
  const detail = notice ? withoutReset(notice) : "";
  const canRetry = lastPrompt?.kind === "user_message";

  const go = async (accountId: string, cont: boolean) => {
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) return;
    setBusy(true);
    await switchAccount(agent, acc, cont);
    setBusy(false);
  };
  const retryLabel = waiting ? (agent.running ? "Retry now" : "Resume now") : agent.running ? "Retry" : "Resume";
  // What sits under the headline: the automatic-resume line, a note why it won't, or what switching does.
  const billed = first?.authKind === "api_key" ? `Switching uses ${first.name}, billed per token.` : null;
  const sub =
    [copy.sub, billed].filter(Boolean).join(" ") || (first ? "Switching keeps your session and history." : null);

  return (
    <div
      role="alert"
      className={cn(
        "relative",
        !embedded &&
          "mb-2.5 overflow-hidden rounded-xl border border-warn/35 bg-gradient-to-b from-warn/[0.09] to-card/80 edge",
      )}
    >
      {!embedded && (
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-warn/60 to-transparent" />
      )}
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 [@media(max-height:700px)]:py-2",
          embedded ? "py-2.5" : "py-3",
        )}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-warn/40 bg-warn/15 text-warn">
          <Gauge className="h-4 w-4" />
        </span>
        <div className="min-w-[200px] flex-1">
          <div className="text-body font-semibold leading-snug" data-testid="limit-headline">
            {copy.headline}
          </div>
          {sub && (
            <div className="line-clamp-2 text-caption leading-snug text-muted" data-testid="resume-line">
              {sub}
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {first ? (
            <Tooltip content={`${provider} · ${first.name} — ${accountDetail(first)}`}>
              <Button size="sm" variant="warn" disabled={busy} onClick={() => void go(first.id, true)}>
                {busy ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Play className="!h-3.5 !w-3.5" />}
                <span className="max-w-[180px] truncate">Switch to {first.name}</span>
              </Button>
            </Tooltip>
          ) : canRetry ? (
            <Tooltip content="Try again on this account (works once the limit resets)">
              <Button size="sm" variant="warn" disabled={busy} onClick={() => void retry()}>
                {busy ? <Spinner className="h-3.5 w-3.5 text-current" /> : <RotateCcw className="!h-3.5 !w-3.5" />}
                {retryLabel}
              </Button>
            </Tooltip>
          ) : (
            <Button size="sm" variant="warn" onClick={() => useUi.getState().setView("accounts")}>
              <UserPlus className="!h-3.5 !w-3.5" /> Add {provider} account
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" disabled={busy} aria-label="More options">
                More
                <ChevronDown className="!h-3.5 !w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <div className="px-2 py-1.5 text-caption leading-snug text-muted">
                <div className="text-fg">{current ? `${provider} · ${current.name}` : provider}</div>
                {detail && <div className="mt-0.5 line-clamp-3">{detail}</div>}
                {!first && <div className="mt-0.5">No other signed-in {provider} accounts.</div>}
              </div>
              {first && canRetry && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void retry()}>
                    <RotateCcw /> {agent.running ? "Try again on this account" : "Resume on this account"}
                  </DropdownMenuItem>
                </>
              )}
              {waiting && (
                <DropdownMenuItem
                  onSelect={() =>
                    void attempt("Couldn't cancel the automatic resume", () => api.cancelLimitResume(agent.id))
                  }
                >
                  <Timer /> Stop automatic resume
                </DropdownMenuItem>
              )}
              {first && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>
                    <span className="flex items-center gap-1.5">
                      <ProviderGlyph provider={agent.provider} size="xs" />
                      Switch without continuing
                    </span>
                  </DropdownMenuLabel>
                  {candidates.map((a) => (
                    <DropdownMenuItem
                      key={a.id}
                      onSelect={() => void go(a.id, false)}
                      className="h-auto min-h-9 py-1.5"
                    >
                      <AccountAvatar account={a} size={20} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{a.name}</span>
                        <span className="truncate text-micro text-steel">{accountDetail(a)}</span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => useUi.getState().setView("accounts")}>
                <UserPlus /> {first ? "Add another account" : `Add a ${provider} account`}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => useUi.getState().setHandoffAgent(agent)}>
                <ArrowRightLeft /> Continue with another provider
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => useUi.getState().openSettings("behavior")}>
                <Settings2 /> Automatic failover: {FAILOVER_LABEL[failover]}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
