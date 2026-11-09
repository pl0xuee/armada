import { ChevronsDownUp, MessageSquareX, ShieldAlert, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useIdentity } from "@/hooks/useIdentity";
import { useSingleKeys } from "@/hooks/useSingleKeys";
import { cancelTurn, respondPermission } from "@/lib/actions";
import { api } from "@/lib/api";
import { planChoices, planTitle } from "@/lib/planApproval";
import type { Agent, PermissionOption } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { usePermissionUi } from "@/store/permissionUi";
import { useUi } from "@/store/ui";
import { Button } from "../ui/button";
import { Textarea } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Spinner } from "../ui/misc";
import { Tooltip } from "../ui/tooltip";
import { permissionKeyOptions, type PermissionItem } from "../timeline/usePermissionKeys";

/**
 * The approval the agent is waiting on, as the "needs you" row of the pinned dock above the composer, so
 * you never have to scroll the conversation to find the card. It answers with the same actions as the
 * card in the timeline (`respondPermission`, the same option choice by kind); "Details" jumps to the full
 * card (command, diff, plan). Questions have their own row (PinnedQuestion).
 */
export function ApprovalSection({
  agent,
  item,
  focused = true,
}: {
  agent: Agent;
  item: PermissionItem;
  focused?: boolean;
}) {
  const identity = useIdentity(agent.provider, agent.customAgentId);
  const singleKeys = useSingleKeys();
  const [busy, setBusy] = useState<string | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const requestId = item.requestId;
  const reason = usePermissionUi((s) => s.reasonDraft[requestId] ?? "");
  const armed = usePermissionUi((s) => Boolean(s.armed[requestId]));

  // While docked, the approval keys (A / Y / D / N) act even if the full card has been scrolled away, and
  // the card in the timeline leaves the buttons to the dock.
  useEffect(() => {
    usePermissionUi.getState().setDocked(requestId, true);
    return () => usePermissionUi.getState().setDocked(requestId, false);
  }, [requestId]);
  useEffect(() => setReasonOpen(false), [requestId]);

  const reveal = (itemId: string) => useUi.getState().revealItem(agent.id, itemId);

  const plan = typeof item.plan === "string" && item.plan.length > 0;
  const keyed = permissionKeyOptions(item);
  const { approve, keepPlanning } = planChoices(item);
  const answer = async (o: PermissionOption) => {
    if (busy) return;
    setBusy(o.id);
    await respondPermission(agent.id, item, o);
    setBusy(null);
  };
  const setReason = (text: string) => usePermissionUi.getState().setReasonDraft(item.requestId, text);
  const denyWithReason = async () => {
    const text = reason.trim();
    const deny = plan ? keepPlanning : keyed.deny;
    if (!deny || !text || busy) return;
    setBusy(deny.id);
    if (!(await respondPermission(agent.id, item, deny))) {
      setBusy(null);
      return;
    }
    try {
      await api.sendPrompt(agent.id, text);
      setReason("");
      setReasonOpen(false);
    } catch (e) {
      toast.error("Answered, but couldn't send your note", { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  // For a plan: the preferred way to approve, "keep planning", and the card for every other way.
  const options: PermissionOption[] = plan
    ? [...approve.slice(0, 1).map((c) => c.option), ...(keepPlanning ? [keepPlanning] : [])]
    : item.options;
  const labelOf = (o: PermissionOption) =>
    plan ? (approve.find((c) => c.option.id === o.id)?.label ?? o.name) : o.name;
  const hint = (o: PermissionOption): string | null => {
    if (!focused || plan || !singleKeys) return null;
    if (keyed.allow?.id === o.id) return "A";
    if (keyed.always?.id === o.id) return "⇧A";
    if (keyed.deny?.id === o.id) return "D";
    return null;
  };
  const denyOption = plan ? keepPlanning : keyed.deny;

  return (
    <div role="group" aria-label={plan ? "Plan waiting for your approval" : "Approval needed"} data-approval-dock>
      <div className="flex items-start gap-3 px-3.5 pb-2.5 pt-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-warn/40 bg-warn/15 text-warn">
          <ShieldAlert className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="eyebrow text-warn">
            {plan ? `${identity.short} has a plan for you` : `${identity.short} needs your approval`}
          </div>
          <div
            className={cn(
              "truncate text-[13.5px] font-medium text-fg",
              !plan && item.toolKind === "execute" && "font-mono text-small",
            )}
            title={plan ? planTitle(item.plan ?? "") : (item.command ?? item.title)}
          >
            {plan ? planTitle(item.plan ?? "") : item.title}
          </div>
          {!plan && item.command && item.command !== item.title && (
            <div className="mt-0.5 truncate font-mono text-meta text-steel" title={item.command}>
              ❯ {item.command}
            </div>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => reveal(item.id)}
          aria-label={plan ? "Show the full plan in the conversation" : "Show the full request in the conversation"}
        >
          <ChevronsDownUp />
          {plan ? "Review plan" : "Details"}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-warn/15 bg-base/30 px-3.5 py-2.5">
        {options.map((o, i) => {
          const allow = !(o.kind === "reject_once" || o.kind === "reject_always");
          const k = hint(o);
          return (
            <Button
              key={o.id}
              size="sm"
              disabled={busy !== null}
              variant={allow ? (i === 0 ? "warn" : "secondary") : "danger"}
              onClick={() => void answer(o)}
              className={cn(!allow && "sm:ml-auto")}
            >
              {busy === o.id ? <Spinner className="h-3.5 w-3.5 text-current" /> : null}
              {labelOf(o)}
              {k && <Kbd className="ml-0.5 border-current/25 bg-transparent text-current opacity-75">{k}</Kbd>}
            </Button>
          );
        })}
        {denyOption && !reasonOpen && (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setReasonOpen(true)}>
            <MessageSquareX />
            {plan ? "Keep planning with a note…" : "Deny with reason…"}
          </Button>
        )}
        <Tooltip content="Stop the whole turn instead of answering" shortcut={["Esc ×2"]}>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void cancelTurn(agent)}
            aria-label="Stop this turn"
          >
            <Square className="!h-3 !w-3 fill-current" />
            Stop turn
          </Button>
        </Tooltip>
      </div>
      {armed && keyed.always && (
        <div
          role="status"
          className="border-t border-warn/25 bg-warn/[0.12] px-3.5 py-2 text-caption font-medium text-warn"
        >
          Press <Kbd className="mx-0.5 border-warn/40 text-warn">⇧A</Kbd> again to always allow “{keyed.always.name}”.
        </div>
      )}
      {reasonOpen && denyOption && (
        <form
          className="border-t border-warn/15 bg-base/40 px-3.5 py-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void denyWithReason();
          }}
        >
          <Textarea
            autoFocus
            aria-label={`Tell ${identity.short} what to do instead`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                void denyWithReason();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setReasonOpen(false);
              }
            }}
            placeholder={`Tell ${identity.short} what to do instead…`}
            className="min-h-14"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <span className="mr-auto text-micro text-steel">
              Declines this request, then sends your note as the next message.
            </span>
            <Button type="button" size="sm" variant="ghost" onClick={() => setReasonOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="danger" disabled={!reason.trim() || busy !== null}>
              {busy ? <Spinner className="h-3.5 w-3.5 text-current" /> : null}
              {plan ? "Keep planning" : "Deny and send"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
