import { useEffect, useState } from "react";
import { commitWork } from "@/lib/controller";
import { isBusy } from "@/lib/meta";
import { useStore } from "@/lib/store";
import type { Agent } from "@/lib/types";
import { Sheet } from "./Sheet";
import { Button } from "./ui";

/** Can the agent's work be committed now? (Not while it's working or waiting for approval.) */
export function commitBlocked(agent: Agent): string | null {
  if (isBusy(agent.status)) return "Wait for the agent to finish (or stop it) before committing.";
  return null;
}

/** "Commit" / "Commit & merge" with an editable message: the confirmation step. */
export function CommitSheet({ agent, mode, onClose, onDone }: { agent: Agent; mode: "commit" | "ship" | null; onClose: () => void; onDone?: () => void }) {
  const [message, setMessage] = useState(agent.title);
  const busy = useStore((s) => !!s.busy[`commit:${agent.id}`]);
  useEffect(() => {
    if (mode) setMessage(agent.title);
  }, [mode, agent.title]);
  const blocked = commitBlocked(agent);
  const ship = mode === "ship";
  return (
    <Sheet
      open={!!mode}
      onClose={onClose}
      title={ship ? "Commit & merge" : "Commit changes"}
      description={ship ? `Commits the remaining changes on ${agent.branch ?? "its branch"}, then merges into ${agent.baseBranch ?? "the base branch"}.` : "Commits the agent's changes in its checkout."}
    >
      <label htmlFor="commit-message" className="mb-1.5 block text-[13px] font-medium text-muted">
        Commit message
      </label>
      <textarea
        id="commit-message"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={3}
        className="block w-full resize-y rounded-xl border border-line-strong bg-card px-3.5 py-3 text-[16px] leading-[22px] text-fg outline-none focus:border-accent/60"
      />
      {blocked && <p className="mt-2 text-[13px] text-warn">{blocked}</p>}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button variant="secondary" size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="lg"
          loading={busy}
          disabled={!!blocked || !message.trim()}
          onClick={async () => {
            if (await commitWork(agent.id, message.trim(), ship)) {
              onClose();
              onDone?.();
            }
          }}
        >
          {ship ? "Commit & merge" : "Commit"}
        </Button>
      </div>
    </Sheet>
  );
}
