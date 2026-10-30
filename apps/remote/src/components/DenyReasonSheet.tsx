import { useEffect, useRef, useState } from "react";
import { denyWithReason } from "@/lib/controller";
import { planTitle } from "@shared/planApproval";
import { agentIdentity, confirmOption, primaryReject } from "@/lib/meta";
import { useStore } from "@/lib/store";
import type { PermissionItem } from "@/lib/types";
import { Sheet } from "./Sheet";
import { Button } from "./ui";

/** Reasons typed but not sent, per request (so closing the sheet doesn't lose them). */
const drafts = new Map<string, string>();

/**
 * "Deny with reason": denies the request, then sends what you typed as the
 * next message so the agent knows what to do instead (the desktop's flow).
 * `item` null = closed; the last item is kept while the sheet animates out.
 */
export function DenyReasonSheet({ item, onClose }: { item: PermissionItem | null; onClose: () => void }) {
  const [shown, setShown] = useState(item);
  useEffect(() => {
    if (item) setShown(item);
  }, [item]);
  const current = item ?? shown;
  const agent = useStore((s) => (current ? s.agents[current.agentId] : undefined));
  const customAgents = useStore((s) => s.customAgents);
  const name = agent ? agentIdentity(agent, customAgents).short : "the agent";
  return (
    <Sheet
      open={!!item}
      onClose={onClose}
      title={current?.plan ? "Keep planning" : "Deny with reason"}
      description={current ? <span className="line-clamp-2 break-words">{current.plan ? planTitle(current.plan) : current.title}</span> : undefined}
    >
      {current && <ReasonForm key={current.requestId} item={current} name={name} open={!!item} onClose={onClose} />}
    </Sheet>
  );
}

function ReasonForm({ item, name, open, onClose }: { item: PermissionItem; name: string; open: boolean; onClose: () => void }) {
  const [text, setText] = useState(() => drafts.get(item.requestId) ?? "");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const deny = primaryReject(item);
  const reason = text.trim();

  // Open straight into typing (after the sheet has settled, so iOS raises the keyboard).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => ref.current?.focus({ preventScroll: true }), 120);
    return () => clearTimeout(t);
  }, [open]);

  const update = (value: string) => {
    setText(value);
    if (value.trim()) drafts.set(item.requestId, value);
    else drafts.delete(item.requestId);
  };

  const submit = async () => {
    if (!deny || !reason || busy) return;
    if (!(await confirmOption(deny))) return;
    setBusy(true);
    const ok = await denyWithReason(item.agentId, item.requestId, deny.id, reason);
    setBusy(false);
    if (ok) {
      drafts.delete(item.requestId);
      onClose();
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="deny-reason" className="mb-1.5 block text-[13px] font-medium text-muted">
        {item.plan ? `What should ${name} change in the plan?` : `Tell ${name} what to do instead`}
      </label>
      <textarea
        id="deny-reason"
        ref={ref}
        value={text}
        onChange={(e) => update(e.currentTarget.value)}
        rows={4}
        placeholder="e.g. Don't run migrations against the dev DB; generate the SQL file only."
        className="block w-full resize-y rounded-xl border border-line-strong bg-card px-3.5 py-3 text-[16px] leading-[22px] text-fg outline-none placeholder:text-steel focus:border-accent/60"
      />
      <p className="mt-2 text-[12.5px] text-steel">
        {item.plan ? "Sends the plan back, then your note as the next message." : "Denies this request, then sends your note as the next message."}
      </p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="danger" size="lg" icon="x" loading={busy} disabled={!deny || !reason}>
          {item.plan ? "Keep planning & send" : "Deny & send"}
        </Button>
      </div>
    </form>
  );
}
