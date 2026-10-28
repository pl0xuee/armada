import { ArrowUpRight, Clock, FilePen, Globe, ShieldAlert, SquareTerminal, Trash2 } from "lucide-react";
import { forwardRef, memo, useMemo } from "react";
import { AccountAvatar } from "@/components/AccountAvatar";
import { DiffList } from "@/components/DiffView";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { parseFileDiff } from "@/lib/diff";
import { relativeTime } from "@/lib/format";
import { useIdentity } from "@/hooks/useIdentity";
import type { Account, Agent, PermissionOption, TimelineItem, ToolKind } from "@/lib/types";
import { basename, cn } from "@/lib/utils";

type PermissionItem = Extract<TimelineItem, { kind: "permission" }>;

const KIND_ICON: Partial<Record<ToolKind, typeof SquareTerminal>> = {
  execute: SquareTerminal,
  edit: FilePen,
  delete: Trash2,
  fetch: Globe,
};

const VARIANT: Record<PermissionOption["kind"], ButtonVariant> = {
  allow_once: "primary",
  allow_always: "ok",
  reject_once: "danger",
  reject_always: "outline",
};

/** Which option each keyboard shortcut maps to (first of its family). */
export function shortcutFor(item: PermissionItem, option: PermissionOption): string | null {
  // "A" is allow-once only; it never falls back to an "always" option.
  const firstAllow = item.options.find((o) => o.kind === "allow_once");
  const firstAlways = item.options.find((o) => o.kind === "allow_always");
  const firstReject = item.options.find((o) => o.kind === "reject_once" || o.kind === "reject_always");
  if (option === firstAllow) return "A";
  if (option === firstAlways) return "⇧A ×2";
  if (option === firstReject) return "D";
  return null;
}

export const InboxCard = memo(
  forwardRef<
    HTMLDivElement,
    {
      agent: Agent;
      item: PermissionItem;
      account: Account | undefined;
      selected: boolean;
      busy: boolean;
      now: number;
      onSelect: (itemId: string) => void;
      onOpen: (agentId: string) => void;
      onRespond: (agent: Agent, item: PermissionItem, option: PermissionOption) => void;
    }
  >(function InboxCard({ agent, item, account, selected, busy, now, onSelect, onOpen, onRespond }, ref) {
    const Icon = (item.toolKind && KIND_ICON[item.toolKind]) || ShieldAlert;
    const identity = useIdentity(agent.provider, agent.customAgentId);
    const files = useMemo(() => (selected ? item.diffs.flatMap(parseFileDiff) : []), [item.diffs, selected]);
    const waitingMins = (now - item.ts) / 60_000;

    return (
      <div
        ref={ref}
        role="listitem"
        aria-current={selected ? "true" : undefined}
        aria-label={`${item.title} · ${agent.title}`}
        // Roving focus: the selected card is the list's single tab stop; arrows move between cards.
        tabIndex={selected ? 0 : -1}
        onClick={() => onSelect(item.id)}
        className={cn(
          "@container/card relative overflow-hidden rounded-xl border bg-card transition-[border-color,background-color] duration-150",
          selected
            ? "border-warn/45 shadow-[0_0_0_1px_color-mix(in_srgb,var(--warn)_25%,transparent),0_14px_40px_-16px_color-mix(in_srgb,var(--warn)_45%,transparent)] edge-strong"
            : "border-line hover:border-line-strong edge",
        )}
      >
        {selected && (
          <span className="absolute inset-y-0 left-0 w-[3px] bg-warn shadow-[0_0_10px_var(--warn)]" aria-hidden />
        )}

        <div className="flex items-center gap-3 px-3.5 py-3 @md/card:px-4">
          <span
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border [&_svg]:h-4 [&_svg]:w-4",
              selected ? "border-warn/40 bg-warn/12 text-warn" : "border-line-strong bg-raised text-steel",
            )}
          >
            <Icon />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-medium text-fg">{item.title}</div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-steel">
              <ProviderGlyph provider={agent.provider} customAgentId={agent.customAgentId} size="xs" />
              <span className="truncate text-muted">{agent.title}</span>
              <span className="hidden text-line-strong @md/card:inline">·</span>
              <span className="hidden min-w-0 items-center gap-1.5 @md/card:flex">
                {account && <AccountAvatar account={account} size={12} showProvider={false} />}
                <span className="truncate">{account?.name ?? identity.short}</span>
              </span>
              <span className="hidden text-line-strong @lg/card:inline">·</span>
              <span className="hidden truncate @lg/card:inline">{basename(agent.projectPath)}</span>
            </div>
          </div>
          <span
            className={cn(
              "flex shrink-0 items-center gap-1 text-[11px] tabular",
              waitingMins >= 5 ? "text-warn" : "text-steel",
            )}
            title="Waiting for you"
          >
            <Clock className="h-3 w-3" />
            {relativeTime(item.ts, now)}
          </span>
        </div>

        {selected && (
          <div className="space-y-3 px-3.5 pb-3.5 @md/card:px-4 @md/card:pb-4" onClick={(e) => e.stopPropagation()}>
            {item.command && (
              <div className="overflow-hidden rounded-lg border border-line bg-code">
                <div className="flex h-7 items-center gap-1.5 border-b border-line bg-panel/60 px-3 text-[10.5px] uppercase tracking-wider text-steel">
                  <SquareTerminal className="h-3 w-3" /> Command
                  <span className="ml-auto hidden truncate font-mono normal-case tracking-normal @md/card:inline">
                    {agent.cwd.split(/[\\/]/).slice(-2).join("/")}
                  </span>
                </div>
                <pre className="selectable whitespace-pre-wrap px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-fg [overflow-wrap:anywhere]">
                  <span className="select-none text-ok">$ </span>
                  {item.command}
                </pre>
              </div>
            )}
            {files.length > 0 && <DiffList files={files} maxHeight={280} />}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              {item.options.map((o) => {
                const sc = shortcutFor(item, o);
                return (
                  <Button
                    key={o.id}
                    size="sm"
                    variant={VARIANT[o.kind]}
                    disabled={busy}
                    onClick={() => onRespond(agent, item, o)}
                  >
                    {o.name}
                    {sc && (
                      <Kbd
                        aria-hidden
                        className={cn(
                          "ml-0.5 hidden h-4 min-w-4 border-transparent bg-black/15 text-[10px] shadow-none @lg/card:inline-flex",
                          o.kind === "allow_once" ? "text-accent-fg" : "text-current",
                        )}
                      >
                        {sc}
                      </Kbd>
                    )}
                  </Button>
                );
              })}
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onOpen(agent.id)}>
                Open agent <ArrowUpRight />
                <Kbd className="ml-0.5 hidden h-4 min-w-4 text-[10px] @lg/card:inline-flex">↵</Kbd>
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }),
);
