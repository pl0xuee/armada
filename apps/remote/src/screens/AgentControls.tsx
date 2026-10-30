/**
 * Owner controls for one agent: session settings (mode / model / effort, as
 * advertised by each provider), switching accounts, and lifecycle actions.
 */
import { memo, useEffect, useRef, useState } from "react";
import { AccountDot } from "@/components/Identity";
import { Icon, Spinner } from "@/components/Icon";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { confirmAction } from "@/lib/confirm";
import { navigate } from "@/lib/router";
import { choiceName, visibleOptions } from "@/lib/config";
import { cancelTurn, resumeAgent, setArchived, setConfigOption, stopAgent, switchAccount } from "@/lib/controller";
import { isBusy, isResumable, safeColor } from "@/lib/meta";
import { accountProblem } from "@/lib/newAgent";
import { useStore } from "@/lib/store";
import { useRunningSubagentCount } from "@/lib/subagents";
import type { Agent, ConfigOption, RemoteAccount } from "@/lib/types";

/** Same-provider accounts the agent could switch to. */
export function switchableAccounts(agent: Agent, accounts: Record<string, RemoteAccount>): RemoteAccount[] {
  return Object.values(accounts).filter((a) => a.provider === agent.provider);
}

/** Which sides of a horizontal scroller have more to scroll to (for an edge fade). */
function useScrollEdges(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const update = () => {
      const left = el.scrollLeft > 4;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
      setEdges((cur) => (cur.left === left && cur.right === right ? cur : { left, right }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [active]);
  return { ref, edges };
}

/** Header strip: one chip per session option, plus a running sub-agents badge. */
export const SettingsChips = memo(function SettingsChips({ agent, onPick }: { agent: Agent; onPick: (optionId: string) => void }) {
  const options = visibleOptions(agent.configOptions);
  const busy = useStore((s) => s.busy);
  // A number, so streamed text (which changes the items every frame) doesn't re-render the chips.
  const subagents = useRunningSubagentCount(agent.id);
  const shown = options.length > 0 || subagents > 0;
  const { ref, edges } = useScrollEdges(shown);
  if (!shown) return null;
  return (
    // Landscape phones: vertical space is precious; the settings stay in the details sheet.
    // The edge fades say there are more chips to scroll to.
    <div
      ref={ref}
      className={cn(
        "scroll-x border-t border-line/60 [@media(orientation:landscape)_and_(max-height:500px)]:hidden",
        edges.left && edges.right ? "fade-x" : edges.right ? "fade-x-end" : edges.left ? "fade-x-start" : "",
      )}
    >
      <div className="mx-auto flex w-max min-w-full max-w-none items-center gap-1.5 px-safe py-1.5 md:w-full md:max-w-[860px]">
        {subagents > 0 && (
          <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-accent/35 bg-accent/10 px-2.5 text-[12.5px] font-medium text-accent">
            <Spinner size={12} />
            {subagents === 1 ? "1 sub-agent running" : `${subagents} sub-agents running`}
          </span>
        )}
        {options.map((o) => {
          const saving = !!busy[`config:${agent.id}:${o.id}`];
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => onPick(o.id)}
              aria-label={`${o.name}: ${choiceName(o)}. Change`}
              className="press hit relative inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-line-strong bg-card pr-2 pl-3 text-[12.5px]"
            >
              <span className="text-steel">{o.name}</span>
              <span className="max-w-[9rem] truncate font-medium text-fg">{choiceName(o)}</span>
              {saving ? <Spinner size={12} className="ml-0.5 text-steel" /> : <Icon name="chevronDown" size={14} className="text-steel" />}
            </button>
          );
        })}
      </div>
    </div>
  );
});

/** Pick a value for one session option. */
export function OptionSheet({ agent, optionId, onClose }: { agent: Agent; optionId: string | null; onClose: () => void }) {
  const option = (agent.configOptions ?? []).find((o) => o.id === optionId) ?? null;
  const [shown, setShown] = useState<ConfigOption | null>(option);
  if (option && option !== shown) setShown(option);
  const o = option ?? shown;
  return (
    <Sheet open={!!option} onClose={onClose} title={o?.name ?? "Setting"} description="Applies to this agent's session">
      {o && (
        <div className="space-y-1.5" role="radiogroup" aria-label={o.name}>
          {o.options.map((c) => {
            const selected = c.value === o.currentValue;
            return (
                <button
                  key={c.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    onClose();
                    if (!selected) void setConfigOption(agent.id, o.id, c.value);
                  }}
                  className={cn(
                    "press flex min-h-14 w-full items-center gap-3 rounded-2xl border px-4 py-2.5 text-left",
                    selected ? "border-accent/50 bg-accent/10" : "border-line bg-card",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-medium text-fg">{c.name}</span>
                    {c.description && <span className="mt-0.5 block text-[13px] leading-snug text-muted">{c.description}</span>}
                  </span>
                  {selected && <Icon name="check" size={18} strokeWidth={2.4} className="shrink-0 text-accent" />}
                </button>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}

/** Move the agent to another account of the same provider (e.g. after a usage limit). */
export function AccountSheet({ agent, open, onClose }: { agent: Agent; open: boolean; onClose: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const switching = useStore((s) => !!s.busy[`account:${agent.id}`]);
  const list = switchableAccounts(agent, accounts);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Switch account"
      description={agent.rateLimited ? "This account hit its usage limit. The session continues on the account you pick." : "The session continues on the account you pick."}
    >
      {list.length <= 1 ? (
        <p className="py-2 text-[14px] text-muted">There's no other account for this provider. Add one in Armada on your computer.</p>
      ) : (
        <div className="space-y-1.5" role="radiogroup" aria-label="Accounts">
          {list.map((a) => {
            const current = a.id === agent.accountId;
            return (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  aria-checked={current}
                  disabled={current || switching}
                  onClick={async () => {
                    if (await switchAccount(agent.id, a.id)) onClose();
                  }}
                  className={cn(
                    "press flex min-h-14 w-full items-center gap-3 rounded-2xl border px-4 py-2.5 text-left disabled:opacity-100",
                    current ? "border-accent/50 bg-accent/10" : "border-line bg-card",
                  )}
                >
                  <AccountDot color={safeColor(a.color)} size={10} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium text-fg">{a.name}</span>
                    {accountProblem(a) ? (
                      <span className="block text-[12.5px] leading-snug text-warn">{accountProblem(a)}</span>
                    ) : (
                      a.label && <span className="block truncate text-[13px] text-muted">{a.label}</span>
                    )}
                  </span>
                  {current ? (
                    <span className="shrink-0 text-[12.5px] font-medium text-accent">Current</span>
                  ) : switching ? (
                    <Spinner size={16} className="shrink-0 text-steel" />
                  ) : (
                    <Icon name="chevronRight" size={18} className="shrink-0 text-steel" />
                  )}
                </button>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}

/** Settings rows and lifecycle buttons at the top of the agent's details sheet. */
export function AgentActions({
  agent,
  onClose,
  onPickOption,
  onSwitchAccount,
}: {
  agent: Agent;
  onClose: () => void;
  onPickOption: (optionId: string) => void;
  onSwitchAccount: () => void;
}) {
  const accounts = useStore((s) => s.accounts);
  const busy = useStore((s) => s.busy);
  const options = visibleOptions(agent.configOptions);
  const canSwitch = switchableAccounts(agent, accounts).length > 1;
  const running = agent.running && agent.status !== "stopped";
  const working = isBusy(agent.status);
  const resumable = isResumable(agent.status);
  const run = (fn: () => unknown) => () => {
    onClose();
    void fn();
  };

  return (
    <div className="space-y-3">
      {(options.length > 0 || canSwitch) && (
        <div className="overflow-hidden rounded-2xl border border-line bg-card">
          {options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              onClick={() => onPickOption(o.id)}
              className={cn("press-row flex min-h-12 w-full items-center gap-3 px-4 text-left", i > 0 && "border-t border-line/70")}
            >
              <span className="flex-1 text-[14.5px] text-fg">{o.name}</span>
              <span className="max-w-[50%] truncate text-[14px] text-muted">{choiceName(o)}</span>
              <Icon name="chevronRight" size={16} className="shrink-0 text-steel" />
            </button>
          ))}
          {canSwitch && (
            <button
              type="button"
              onClick={onSwitchAccount}
              className={cn("press-row flex min-h-12 w-full items-center gap-3 px-4 text-left", options.length > 0 && "border-t border-line/70")}
            >
              <span className="flex-1 text-[14.5px] text-fg">Account</span>
              <span className="max-w-[50%] truncate text-[14px] text-muted">{accounts[agent.accountId ?? ""]?.name ?? "Switch"}</span>
              <Icon name="chevronRight" size={16} className="shrink-0 text-steel" />
            </button>
          )}
        </div>
      )}
      <Button
        variant="secondary"
        icon="file"
        className="w-full"
        onClick={() => {
          onClose();
          navigate({ name: "review", agentId: agent.id });
        }}
      >
        Review changes
      </Button>
      <div className="grid grid-cols-2 gap-2">
        {resumable && (
          <Button variant="primary" icon="play" loading={!!busy[`resume:${agent.id}`]} onClick={run(() => resumeAgent(agent.id))}>
            Resume
          </Button>
        )}
        {working && (
          <Button variant="secondary" icon="stop" loading={!!busy[`cancel:${agent.id}`]} onClick={run(() => cancelTurn(agent.id))}>
            Cancel turn
          </Button>
        )}
        {running && (
          <Button
            variant="danger"
            icon="power"
            loading={!!busy[`stop:${agent.id}`]}
            onClick={run(async () => {
              const ok = await confirmAction({
                title: "Stop this agent?",
                body: "This ends the agent's process. The conversation is kept and you can resume it later.",
                confirmLabel: "Stop agent",
                destructive: true,
              });
              if (ok) await stopAgent(agent.id);
            })}
          >
            Stop agent
          </Button>
        )}
        <Button variant="secondary" icon="archive" onClick={run(() => setArchived(agent.id, !agent.archived))}>
          {agent.archived ? "Unarchive" : "Archive"}
        </Button>
      </div>
      {running && (
        <p className="px-1 text-[12.5px] leading-snug text-steel">
          {working ? "Cancel ends this turn. " : ""}Stop ends the agent's process; you can resume the session later.
        </p>
      )}
    </div>
  );
}
