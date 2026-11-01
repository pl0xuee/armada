import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui";
import { addAgents, pushToast } from "@/lib/controller";
import { basename } from "@/lib/format";
import { agentIdentity } from "@/lib/meta";
import { navigate } from "@/lib/router";
import { useStore } from "@/lib/store";
import { addRoom, clampCount, MAX_TOGETHER, newGroupId } from "@/lib/together";
import type { Agent } from "@/lib/types";

/**
 * Start 1 to 8 more of this agent in the same project (same account, each in its own worktree so they
 * can't overwrite each other), with an optional prompt. They join the agents started together: the
 * chip row under the header hops between them.
 */
export function AddAgentsSheet({
  agent,
  together,
  open,
  onClose,
}: {
  agent: Agent;
  /** Agents already together, this one included. */ together: number;
  open: boolean;
  onClose: () => void;
}) {
  const room = addRoom(together);
  const [wanted, setWanted] = useState(1);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  // The same group for a retry of the ones that failed, so they join their siblings.
  const group = useRef(newGroupId());
  const customAgents = useStore((s) => s.customAgents);
  const identity = agentIdentity(agent, customAgents);
  const account = useStore((s) => (agent.accountId ? s.accounts[agent.accountId] : undefined));
  const count = clampCount(wanted, room);
  useEffect(() => {
    if (open) {
      setFailures([]);
      group.current = newGroupId();
    }
  }, [open]);

  const start = async () => {
    if (busy || room === 0) return;
    setBusy(true);
    setFailures([]);
    const { created, failed } = await addAgents(agent, prompt, count, group.current);
    setBusy(false);
    if (!failed.length) {
      setPrompt("");
      setWanted(1);
      onClose();
      pushToast({
        tone: "ok",
        title: created.length === 1 ? "Agent added" : `Added ${created.length} agents`,
        body: "Each has its own worktree.",
        agentId: null,
        reason: null,
        duration: 5_000,
        action: { label: "Open", run: () => navigate({ name: "agent", agentId: created[0] }) },
      });
    } else {
      // Offer only the ones that didn't start, so a retry can't duplicate the rest.
      setFailures([...new Set(failed)]);
      setWanted(failed.length);
      if (created.length) {
        pushToast({
          tone: "warn",
          title: `Added ${created.length}, ${failed.length} failed`,
          body: null,
          agentId: null,
          reason: null,
          duration: 6_000,
        });
      }
    }
  };

  const via = agent.provider === "custom" ? identity.name : `${identity.name}${account ? ` · ${account.name}` : ""}`;
  const project = basename(agent.projectPath);
  return (
    <Sheet open={open} onClose={onClose} title="Add agents" description={project ? `to ${project}` : undefined}>
      <div className="space-y-4">
        {room === 0 ? (
          <p className="rounded-xl bg-raised px-3 py-3 text-[14px] text-muted">
            {MAX_TOGETHER} is the most agents together. Archive one to add another.
          </p>
        ) : (
          <>
            <div>
              <label htmlFor="add-agents-prompt" className="mb-1.5 block text-[13px] font-medium text-muted">
                What should they do? <span className="text-steel">(optional: without it they start idle)</span>
              </label>
              <textarea
                id="add-agents-prompt"
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={busy}
                placeholder="e.g. Also write tests for the new endpoint"
                className="block w-full resize-none rounded-xl border border-line-strong bg-code px-3.5 py-3 text-[16px] leading-[22px] text-fg outline-none placeholder:text-steel focus:border-accent/60"
              />
            </div>
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[14.5px] font-medium text-fg" id="add-agents-count">
                  How many
                </p>
                <p className="text-[12.5px] text-steel">Up to {room} more</p>
              </div>
              <div
                className="flex items-center gap-1 rounded-2xl border border-line-strong bg-raised p-1"
                role="group"
                aria-labelledby="add-agents-count"
              >
                <button
                  type="button"
                  aria-label="Fewer agents"
                  disabled={busy || count <= 1}
                  onClick={() => setWanted(count - 1)}
                  className="press inline-flex h-11 w-11 items-center justify-center rounded-xl text-fg disabled:opacity-35"
                >
                  <span className="text-[22px] leading-none" aria-hidden>
                    −
                  </span>
                </button>
                <span className="w-8 text-center text-[17px] font-semibold tabular text-fg" aria-live="polite">
                  {count}
                </span>
                <button
                  type="button"
                  aria-label="More agents"
                  disabled={busy || count >= room}
                  onClick={() => setWanted(count + 1)}
                  className="press inline-flex h-11 w-11 items-center justify-center rounded-xl text-fg disabled:opacity-35"
                >
                  <Icon name="plus" size={20} />
                </button>
              </div>
            </div>
            <p className="text-[12.5px] leading-snug text-steel">
              Same agent as this one ({via}). Each starts in {project || "this project"} in its own worktree.
            </p>
            {failures.length > 0 && (
              <ul
                role="alert"
                className="space-y-1 rounded-xl border border-err/30 bg-err/[0.06] px-3 py-2.5 text-[13px] leading-snug text-err"
              >
                {failures.map((f) => (
                  <li key={f} className="break-words">
                    {f}
                  </li>
                ))}
              </ul>
            )}
            <Button size="lg" variant="primary" className="w-full" loading={busy} onClick={() => void start()}>
              Start {count} {count === 1 ? "agent" : "agents"}
            </Button>
          </>
        )}
      </div>
    </Sheet>
  );
}
