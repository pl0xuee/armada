import { ArrowUpRight, Clock, FilePen, Globe, ShieldAlert, SquareTerminal, Trash2 } from "lucide-react";
import { forwardRef, useMemo } from "react";
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
  const firstAllow =
    item.options.find((o) => o.kind === "allow_once") ?? item.options.find((o) => o.kind === "allow_always");
  const firstAlways = item.options.find((o) => o.kind === "allow_always");
  const firstReject = item.options.find((o) => o.kind === "reject_once" || o.kind === "reject_always");
  if (option === firstAllow) return "A";
  if (option === firstAlways && firstAlways !== firstAllow) return "⇧A";
  if (option === firstReject) return "D";
  return null;
}

export const InboxCard = forwardRef<
  HTMLDivElement,
  {
    agent: Agent;
    item: PermissionItem;
    account: Account | undefined;
    selected: boolean;
    busy: boolean;
    now: number;
    onSelect: () => void;
    onOpen: () => void;
    onRespond: (option: PermissionOption) => void;
  }
>(function InboxCard({ agent, item, account, selected, busy, now, onSelect, onOpen, onRespond }, ref) {
  const Icon = (item.toolKind && KIND_ICON[item.toolKind]) || ShieldAlert;
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const files = useMemo(() => (selected ? item.diffs.flatMap(parseFileDiff) : []), [item.diffs, selected]);
  const waitingMins = (now - item.ts) / 60_000;

  return (
    <div
      ref={ref}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onClick={onSelect}
      className={cn(
        "relative overflow-hidden rounded-xl border bg-card transition-[border-color,background-color] duration-150",
        selected
          ? "border-warn/45 shadow-[0_0_0_1px_color-mix(in_srgb,var(--warn)_25%,transparent),0_14px_40px_-16px_color-mix(in_srgb,var(--warn)_45%,transparent)] edge-strong"
          : "border-line hover:border-line-strong edge",
      )}
    >
      {selected && (
        <span className="absolute inset-y-0 left-0 w-[3px] bg-warn shadow-[0_0_10px_var(--warn)]" aria-hidden />
      )}

      <div className="flex items-center gap-3 px-4 py-3">
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
            <span className="text-line-strong">·</span>
            {account && <AccountAvatar account={account} size={12} showProvider={false} />}
            <span className="truncate">{account?.name ?? identity.short}</span>
            <span className="text-line-strong">·</span>
            <span className="truncate">{basename(agent.projectPath)}</span>
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
        <div className="space-y-3 px-4 pb-4" onClick={(e) => e.stopPropagation()}>
          {item.command && (
            <div className="overflow-hidden rounded-lg border border-line bg-code">
              <div className="flex h-7 items-center gap-1.5 border-b border-line bg-panel/60 px-3 text-[10.5px] uppercase tracking-wider text-steel">
                <SquareTerminal className="h-3 w-3" /> Command
                <span className="ml-auto font-mono normal-case tracking-normal">
                  {agent.cwd.split(/[\\/]/).slice(-2).join("/")}
                </span>
              </div>
              <pre className="selectable overflow-x-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-fg">
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
                <Button key={o.id} size="sm" variant={VARIANT[o.kind]} disabled={busy} onClick={() => onRespond(o)}>
                  {o.name}
                  {sc && (
                    <Kbd
                      className={cn(
                        "ml-0.5 h-4 min-w-4 border-transparent bg-black/15 text-[10px] shadow-none",
                        o.kind === "allow_once" ? "text-accent-fg" : "text-current",
                      )}
                    >
                      {sc}
                    </Kbd>
                  )}
                </Button>
              );
            })}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={onOpen}>
              Open agent <ArrowUpRight />
              <Kbd className="ml-0.5 h-4 min-w-4 text-[10px]">↵</Kbd>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
});
