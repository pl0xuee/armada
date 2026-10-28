import { memo } from "react";
import { respondToPermission } from "@/lib/controller";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { confirmOption, isAllow, primaryAllow, primaryReject, RESOLVED_LABEL } from "@/lib/meta";
import { useStore } from "@/lib/store";
import type { PermissionItem, PermissionOption } from "@/lib/types";
import { Icon, Spinner } from "../Icon";
import { Button, type ButtonVariant } from "../ui";
import { DiffList } from "./DiffView";
import { CommandBlock, TOOL_ICON } from "./Items";

export const OPTION_VARIANT: Record<PermissionOption["kind"], ButtonVariant> = {
  allow_once: "primary",
  allow_always: "ok",
  reject_once: "danger",
  reject_always: "outline",
};

/** Primary pair first (deny left, allow right), then the remaining options. */
export function orderOptions(item: PermissionItem) {
  const allow = primaryAllow(item);
  const reject = primaryReject(item);
  const rest = item.options.filter((o) => o !== allow && o !== reject);
  return { allow, reject, rest };
}

export function resolutionLabel(item: PermissionItem, resolution: string): { label: string; allowed: boolean | null } {
  if (resolution === "cancelled") return { label: "Cancelled", allowed: null };
  const opt = item.options.find((o) => o.id === resolution);
  if (!opt) return { label: "Answered", allowed: null };
  return { label: opt.name || RESOLVED_LABEL[opt.kind], allowed: isAllow(opt) };
}

/** What's being asked: the command and/or the proposed file changes. */
export function PermissionSubject({ item, compact = false }: { item: PermissionItem; compact?: boolean }) {
  return (
    <>
      {item.command && <CommandBlock command={item.command} />}
      {item.diffs.length > 0 && <DiffList diffs={item.diffs} defaultOpen={!compact} />}
    </>
  );
}

export function ResolvedRow({ item, resolution, pending }: { item: PermissionItem; resolution: string; pending: boolean }) {
  const { label, allowed } = resolutionLabel(item, resolution);
  const color = pending ? "var(--steel)" : allowed === null ? "var(--steel)" : allowed ? "var(--ok)" : "var(--err)";
  return (
    <div className="flex min-h-12 items-center gap-3 rounded-2xl border border-line bg-panel px-3 py-2 edge">
      <span
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
        style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
      >
        {pending ? <Spinner size={14} /> : <Icon name={allowed === false ? "shieldX" : "shieldCheck"} size={16} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] text-fg/90">{item.title}</span>
        <span className="block text-[12.5px] font-medium" style={{ color }}>
          {pending ? `Sending “${label}”…` : label}
        </span>
      </span>
    </div>
  );
}

export function PermissionButtons({
  agentId,
  item,
  disabled,
  showRest = true,
}: {
  agentId: string;
  item: PermissionItem;
  disabled?: boolean;
  showRest?: boolean;
}) {
  const { allow, reject, rest } = orderOptions(item);
  const respond = async (o: PermissionOption) => {
    if (await confirmOption(o)) void respondToPermission(agentId, item.requestId, o.id);
  };
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        {reject && (
          <Button size="lg" variant="danger" disabled={disabled} onClick={() => respond(reject)} className={cn(!allow && "col-span-2")}>
            <span className="truncate">{reject.name}</span>
          </Button>
        )}
        {allow && (
          <Button size="lg" variant="primary" disabled={disabled} onClick={() => respond(allow)} className={cn(!reject && "col-span-2")}>
            <span className="truncate">{allow.name}</span>
          </Button>
        )}
      </div>
      {showRest &&
        rest.map((o) => (
          <Button key={o.id} size="md" variant={OPTION_VARIANT[o.kind]} disabled={disabled} onClick={() => respond(o)} className="w-full">
            <span className="truncate">{o.name}</span>
          </Button>
        ))}
    </div>
  );
}

export const PermissionCard = memo(function PermissionCard({
  item,
  readOnly,
}: {
  item: PermissionItem;
  readOnly: boolean;
}) {
  const sending = useStore((s) => s.resolving[item.requestId]);
  const now = useNow();
  if (item.resolution !== null) return <ResolvedRow item={item} resolution={item.resolution} pending={false} />;
  if (sending) return <ResolvedRow item={item} resolution={sending} pending />;

  return (
    <section
      aria-label={`Permission request: ${item.title}`}
      className="overflow-hidden rounded-2xl border border-warn/45 bg-card shadow-[0_0_0_1px_color-mix(in_srgb,var(--warn)_14%,transparent),0_16px_40px_-18px_color-mix(in_srgb,var(--warn)_50%,transparent)]"
    >
      <div className="flex items-center gap-2 border-b border-warn/15 bg-warn/[0.06] px-4 py-2.5">
        <Icon name="shield" size={16} className="text-warn" />
        <span className="text-[12px] font-semibold tracking-wider text-warn uppercase">Permission needed</span>
        <span className="ml-auto text-[12px] text-steel tabular">{relativeTime(item.ts, now)}</span>
      </div>
      <div className="space-y-3 p-4">
        <div className="flex items-start gap-2.5">
          {item.toolKind && <Icon name={TOOL_ICON[item.toolKind]} size={18} className="mt-0.5 shrink-0 text-steel" />}
          <h3 className="min-w-0 flex-1 text-[15.5px] leading-snug font-semibold break-words text-fg">{item.title}</h3>
        </div>
        <PermissionSubject item={item} />
        {readOnly ? (
          <p className="flex items-center gap-2 rounded-xl bg-raised px-3 py-2.5 text-[13px] text-muted">
            <Icon name="eye" size={16} className="shrink-0 text-steel" />
            Waiting for the owner to respond.
          </p>
        ) : (
          <PermissionButtons agentId={item.agentId} item={item} />
        )}
      </div>
    </section>
  );
});
