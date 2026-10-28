import { ArrowRightLeft, Repeat } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { CUSTOM_ACCOUNT_ID, PROVIDER_ORDER, PROVIDERS } from "@/lib/providers";
import type { Agent, CustomAgent, Provider } from "@/lib/types";

const EMPTY_CUSTOM: CustomAgent[] = [];
import { CONTINUE_PROMPT, switchAccount } from "@/lib/actions";
import { cn, errorMessage } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { AccountAvatar } from "./AccountAvatar";
import { ProviderGlyph } from "./ProviderGlyph";
import { ConfirmDialog } from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "./ui/dialog";
import { Label, Textarea } from "./ui/input";
import { Spinner } from "./ui/misc";
import { Segmented } from "./ui/segmented";
import { Select } from "./ui/select";

/** Hand-off and delete dialogs, driven by the UI store. */
export function AgentDialogs() {
  const handoff = useUi((s) => s.handoffAgent);
  const del = useUi((s) => s.deleteAgent);
  const move = useUi((s) => s.moveAgent);
  return (
    <>
      <MoveAccountDialog agent={move} onClose={() => useUi.getState().setMoveAgent(null)} />
      <HandoffDialog agent={handoff} onClose={() => useUi.getState().setHandoffAgent(null)} />
      <DeleteDialog agent={del} onClose={() => useUi.getState().setDeleteAgent(null)} />
    </>
  );
}

const PRESETS = [
  {
    label: "Second opinion",
    text: "Review the work so far and give a critical second opinion: bugs, risks, simpler alternatives.",
  },
  {
    label: "Review the diff",
    text: "Review the diff on this branch like a senior reviewer. Leave concrete, actionable feedback.",
  },
  {
    label: "Continue the task",
    text: "Continue this task from where the previous agent stopped. Verify its work first.",
  },
  { label: "Write tests", text: "Write thorough tests for the changes made on this branch and make sure they pass." },
];

function HandoffDialog({ agent, onClose }: { agent: Agent | null; onClose: () => void }) {
  const accounts = useApp((s) => s.accounts);
  const openAgent = useUi((s) => s.openAgent);
  const customAgents = useApp((s) => s.settings?.customAgents ?? EMPTY_CUSTOM);
  const enabledCustom = useMemo(() => customAgents.filter((c) => c.enabled), [customAgents]);
  /** "claude" | "codex" | "grok" | "custom:<id>" */
  const [choice, setChoice] = useState<string>("codex");
  const custom = choice.startsWith("custom:") ? enabledCustom.find((c) => `custom:${c.id}` === choice) : undefined;
  const provider: Provider = custom ? "custom" : (choice as Provider);
  const [accountId, setAccountId] = useState("");
  const [instruction, setInstruction] = useState(PRESETS[0].text);
  const [busy, setBusy] = useState(false);

  // Default to a different provider than the source agent.
  useEffect(() => {
    if (!agent) return;
    const p = PROVIDER_ORDER.find((x) => x !== agent.provider) ?? "claude";
    setChoice(p);
    setInstruction(PRESETS[0].text);
  }, [agent]);

  const providerAccounts = useMemo(() => accounts.filter((a) => a.provider === provider), [accounts, provider]);
  useEffect(() => {
    const preferred = providerAccounts.find((a) => a.status?.loggedIn) ?? providerAccounts[0];
    setAccountId(preferred?.id ?? "");
  }, [providerAccounts]);

  const submit = async () => {
    if (!agent || (!custom && !accountId) || !instruction.trim()) return;
    setBusy(true);
    try {
      const created = await api.handoffAgent(
        agent.id,
        provider,
        custom ? CUSTOM_ACCOUNT_ID : accountId,
        instruction.trim(),
        custom?.id ?? null,
      );
      useApp.getState().upsertAgent(created);
      toast.success(`Handed off to ${custom ? custom.name : PROVIDERS[provider].short}`, {
        description: created.title,
      });
      onClose();
      openAgent(created.id);
    } catch (e) {
      toast.error("Hand-off failed", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!agent} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Hand off"
        description={agent ? `Send “${agent.title}” to another agent with its context.` : undefined}
      >
        <DialogBody className="space-y-4">
          <div>
            <Label>Agent</Label>
            <Segmented
              aria-label="Agent"
              value={choice}
              onChange={setChoice}
              className="w-full max-w-full overflow-x-auto"
              options={[
                ...PROVIDER_ORDER.map((p) => ({
                  value: p as string,
                  label: (
                    <>
                      <ProviderGlyph provider={p} size="xs" />
                      {PROVIDERS[p].short}
                    </>
                  ),
                })),
                ...enabledCustom.map((c) => ({
                  value: `custom:${c.id}`,
                  label: (
                    <>
                      <ProviderGlyph provider="custom" customAgentId={c.id} size="xs" />
                      {c.name}
                    </>
                  ),
                })),
              ]}
            />
          </div>
          {!custom && (
            <div>
              <Label>Account</Label>
              <Select
                aria-label="Account"
                value={accountId || undefined}
                onValueChange={setAccountId}
                placeholder={providerAccounts.length ? "Choose account" : "No accounts for this provider"}
                disabled={providerAccounts.length === 0}
                options={providerAccounts.map((a) => ({
                  value: a.id,
                  label: `${a.name}${a.status?.loggedIn ? "" : " (not signed in)"}`,
                }))}
              />
            </div>
          )}
          <div>
            <Label htmlFor="handoff-instruction">Instruction</Label>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setInstruction(p.text)}
                  className="h-6 rounded-full border border-line bg-card px-2.5 text-[11.5px] text-muted transition-colors hover:border-line-strong hover:text-fg"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <Textarea
              id="handoff-instruction"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              className="min-h-24"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
              }}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || (!custom && !accountId) || !instruction.trim()}
            onClick={() => void submit()}
          >
            {busy ? <Spinner className="h-3.5 w-3.5 text-current" /> : <ArrowRightLeft />}
            Hand off
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ agent, onClose }: { agent: Agent | null; onClose: () => void }) {
  const [removeWorktree, setRemoveWorktree] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (agent) setRemoveWorktree(true);
  }, [agent]);

  return (
    <ConfirmDialog
      open={!!agent}
      onOpenChange={(o) => !o && onClose()}
      danger
      busy={busy}
      title="Delete agent?"
      description={
        agent ? (
          <>
            “{agent.title}” and its history will be removed from Armada. The provider's own session files are left
            untouched.
          </>
        ) : null
      }
      confirmLabel="Delete"
      onConfirm={async () => {
        if (!agent) return;
        setBusy(true);
        try {
          await api.deleteAgent(agent.id, agent.worktree && removeWorktree);
          toast(`Deleted “${agent.title}”`);
          onClose();
        } catch (e) {
          toast.error("Couldn't delete agent", { description: errorMessage(e) });
        } finally {
          setBusy(false);
        }
      }}
    >
      {agent?.worktree && (
        <label className="flex items-start gap-2.5 rounded-lg border border-line bg-base/40 p-3 text-[12.5px]">
          <Checkbox checked={removeWorktree} onCheckedChange={setRemoveWorktree} className="mt-0.5" />
          <span>
            Also remove the worktree
            <span className="mt-0.5 block font-mono text-[11px] text-steel">{agent.branch}</span>
          </span>
        </label>
      )}
    </ConfirmDialog>
  );
}

function MoveAccountDialog({ agent, onClose }: { agent: Agent | null; onClose: () => void }) {
  const accounts = useApp((s) => s.accounts);
  const [target, setTarget] = useState<string | null>(null);
  const [cont, setCont] = useState(true);
  const [busy, setBusy] = useState(false);
  const options = useMemo(
    () => (agent ? accounts.filter((a) => a.provider === agent.provider && a.id !== agent.accountId) : []),
    [accounts, agent],
  );

  useEffect(() => {
    if (!agent) return;
    setTarget(options.find((a) => a.status?.loggedIn)?.id ?? null);
    setCont(agent.rateLimited);
  }, [agent, options]);

  const current = agent ? accounts.find((a) => a.id === agent.accountId) : undefined;
  const chosen = options.find((a) => a.id === target);

  const submit = async () => {
    if (!agent || !chosen) return;
    setBusy(true);
    const ok = await switchAccount(agent, chosen, cont);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog open={!!agent} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Move to another account"
        description={
          agent && current
            ? `“${agent.title}” runs on ${PROVIDERS[agent.provider].short} · ${current.name}. Its session and history move with it.`
            : undefined
        }
      >
        <DialogBody className="space-y-3">
          {options.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center">
              <p className="text-[13px] font-medium">
                No other {agent ? PROVIDERS[agent.provider].short : ""} accounts
              </p>
              <p className="mt-1 text-[12px] text-muted">Add one in Accounts, then come back here.</p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-3"
                onClick={() => {
                  onClose();
                  useUi.getState().setView("accounts");
                }}
              >
                Open Accounts
              </Button>
            </div>
          ) : (
            <div role="radiogroup" aria-label="Account" className="space-y-1.5">
              {options.map((a) => {
                const signedIn = !!a.status?.loggedIn;
                const on = target === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={!signedIn}
                    onClick={() => setTarget(a.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-50",
                      on ? "border-accent/50 bg-accent/[0.07]" : "border-line bg-card/60 hover:border-line-strong",
                    )}
                  >
                    <AccountAvatar account={a} size={28} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{a.name}</span>
                      <span className={cn("block truncate text-[11.5px]", signedIn ? "text-steel" : "text-warn")}>
                        {signedIn ? [a.status?.label, a.status?.email].filter(Boolean).join(" · ") : "Not signed in"}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                        on ? "border-accent" : "border-line-strong",
                      )}
                    >
                      {on && <span className="h-2 w-2 rounded-full bg-accent" />}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {options.length > 0 && (
            <label className="flex items-center gap-2.5 text-[12.5px]">
              <Checkbox checked={cont} onCheckedChange={setCont} />
              Continue the task right away
              <span className="text-steel">(sends “{CONTINUE_PROMPT}”)</span>
            </label>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!chosen || busy} onClick={() => void submit()}>
            {busy ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Repeat />}
            {cont ? "Move & continue" : "Move agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
