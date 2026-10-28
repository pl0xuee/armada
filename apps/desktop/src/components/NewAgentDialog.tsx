import { Check, ChevronDown, Columns3, FolderOpen, GitBranch, Rocket } from "lucide-react";
import { PermissionModeChip, usePermissionMode } from "./home/PermissionModeChip";
import { PreflightNotes, usePreflight } from "./home/PreflightNotes";
import { ProjectPicker } from "./home/ProjectPicker";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { recallLocalModel, rememberLocalModel } from "@/lib/local";
import { CUSTOM_ACCOUNT_ID, PROVIDER_ORDER, PROVIDERS } from "@/lib/providers";
import type { Account, Agent, Provider } from "@/lib/types";
import { cn, errorMessage, modKey, uuid, isMac } from "@/lib/utils";
import { pickFolder } from "@/lib/window";
import { customFromChoice, pickAccount, readLaunchDefaults, rememberLaunch, resolveLaunch } from "@/lib/launchDefaults";
import { useApp } from "@/store/app";
import { useUi, type NewAgentPreset } from "@/store/ui";
import { AccountAvatar } from "./AccountAvatar";
import { useAttachments } from "@/hooks/useAttachments";
import { AttachButton, DropOverlay } from "./AttachControls";
import { AttachmentStrip } from "./AttachmentStrip";
import { ProviderGlyph } from "./ProviderGlyph";
import { LocalModelPicker } from "./local/LocalModelPicker";
import { TemplatePicker } from "./TemplatePicker";
import { Button } from "./ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "./ui/dialog";
import { Input, Label, Textarea } from "./ui/input";
import { Kbd } from "./ui/kbd";
import { Spinner } from "./ui/misc";
import { Segmented } from "./ui/segmented";
import { Select } from "./ui/select";
import { Switch } from "./ui/switch";

export function NewAgentDialog() {
  const { open, preset } = useUi((s) => s.newAgent);
  const close = useUi((s) => s.closeNewAgent);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent
        title="New agent"
        description="Launch an agent into a project. It keeps running even if you close the window."
        className="w-[min(640px,calc(100vw-32px))]"
        sheet
      >
        {open && <NewAgentForm preset={preset} onDone={close} />}
      </DialogContent>
    </Dialog>
  );
}

/** One-line state of an account: its plan/label, or why it can't be used yet. */
function accountStateText(a: Account): string {
  if (a.status?.loggedIn) return a.status.label ?? "Signed in";
  return a.provider === "local" ? "Not running" : "Not signed in";
}

function defaultAccount(accounts: Account[], provider: Provider): Account | undefined {
  if (provider === "custom") return undefined;
  return pickAccount(accounts, provider, readLaunchDefaults().accounts[provider]);
}

interface LaunchTarget {
  /** Selection key: account id, or "custom:<id>" for custom agents. */
  key: string;
  provider: Provider;
  accountId: string;
  customAgentId: string | null;
}

function NewAgentForm({ preset, onDone }: { preset: NewAgentPreset | null; onDone: () => void }) {
  const [mode, setMode] = usePermissionMode();
  const accounts = useApp((s) => s.accounts);
  const settings = useApp((s) => s.settings);
  const openAgent = useUi((s) => s.openAgent);
  const openCompare = useUi((s) => s.openCompare);
  const setView = useUi((s) => s.setView);

  const recent = settings?.recentProjects ?? [];
  // Start from what was used last time (provider, account, folder, worktree), unless preset.
  const [initial] = useState(() => resolveLaunch(accounts, settings));
  const [project, setProject] = useState(preset?.projectPath ?? (initial.folder || recent[0] || ""));
  const [compare, setCompare] = useState(preset?.compare ?? false);
  const customAgents = useMemo(() => (settings?.customAgents ?? []).filter((c) => c.enabled), [settings?.customAgents]);
  /** "claude" | "codex" | "grok" | "custom:<id>" */
  const [choice, setChoice] = useState<string>(
    () =>
      preset?.provider ??
      (initial.provider === "custom" && !customFromChoice(initial.choice, customAgents) ? "claude" : initial.choice),
  );
  const custom = choice.startsWith("custom:") ? customAgents.find((c) => `custom:${c.id}` === choice) : undefined;
  const provider: Provider = custom ? "custom" : (choice as Provider);
  const attach = useAttachments();
  const [accountId, setAccountId] = useState<string>(
    () =>
      preset?.accountId ??
      (preset?.provider ? defaultAccount(accounts, preset.provider)?.id : initial.accountId || undefined) ??
      "",
  );
  const [targets, setTargets] = useState<string[]>(() =>
    PROVIDER_ORDER.map((p) => defaultAccount(accounts, p)?.id).filter((x): x is string => !!x),
  );
  const [worktree, setWorktree] = useState(initial.worktree);
  const [title, setTitle] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState(preset?.prompt ?? "");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const submittingRef = useRef(false);
  /** Compare group for this dialog session, reused when retrying failed targets. */
  const groupRef = useRef<string | null>(null);
  /** Agents already launched in this session (partial Compare launches). */
  const [launched, setLaunched] = useState<Agent[]>([]);

  const targetKeyOf = (a: Agent) => (a.provider === "custom" ? `custom:${a.customAgentId}` : a.accountId);
  const targetLabel = (t: LaunchTarget) => {
    if (t.provider === "custom") {
      return customAgents.find((c) => c.id === t.customAgentId)?.name ?? "Custom agent";
    }
    const acc = accounts.find((a) => a.id === t.accountId);
    return `${PROVIDERS[t.provider].short} · ${acc?.name ?? "account"}`;
  };

  useEffect(() => {
    const t = setTimeout(() => promptRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  // Alt+1..5 picks the agent: Claude, Codex, Grok, Local, then the first custom agent.
  const keyChoices = useMemo<string[]>(
    () => [...PROVIDER_ORDER, ...(customAgents[0] ? [`custom:${customAgents[0].id}`] : [])],
    [customAgents],
  );

  const providerAccounts = useMemo(() => accounts.filter((a) => a.provider === provider), [accounts, provider]);
  const account = accounts.find((a) => a.id === accountId);
  const issues = usePreflight({ provider, account: custom ? undefined : account, folder: project, worktree });

  const chooseProvider = (key: string) => {
    setChoice(key);
    setModel("");
    if (!key.startsWith("custom:")) setAccountId(defaultAccount(accounts, key as Provider)?.id ?? "");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘/Ctrl+Enter launches from any field (never mid-IME composition).
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (e.key === "Enter" && mod && !e.altKey) {
        if (e.isComposing || e.keyCode === 229 || e.repeat) return;
        e.preventDefault();
        void submit();
        return;
      }
      if (!e.altKey || e.ctrlKey || e.metaKey || e.repeat || compare) return;
      // e.code: Alt+digit types symbols on macOS.
      const m = /^Digit([1-5])$/.exec(e.code);
      const key = m ? keyChoices[Number(m[1]) - 1] : undefined;
      if (!key) return;
      e.preventDefault();
      chooseProvider(key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toggleTarget = (id: string) => setTargets((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));

  const browse = async () => {
    const p = await pickFolder(project || undefined);
    if (p) setProject(p);
  };

  /** Everything that will be launched: sign-in accounts and/or custom agents. */
  const chosen: LaunchTarget[] = compare
    ? [
        ...accounts
          .filter((a) => targets.includes(a.id))
          .map((a) => ({ key: a.id, provider: a.provider, accountId: a.id, customAgentId: null })),
        ...customAgents
          .filter((c) => targets.includes(`custom:${c.id}`))
          .map((c) => ({
            key: `custom:${c.id}`,
            provider: "custom" as const,
            accountId: CUSTOM_ACCOUNT_ID,
            customAgentId: c.id,
          })),
      ]
    : custom
      ? [{ key: `custom:${custom.id}`, provider: "custom", accountId: CUSTOM_ACCOUNT_ID, customAgentId: custom.id }]
      : account
        ? [{ key: account.id, provider: account.provider, accountId: account.id, customAgentId: null }]
        : [];
  const canSubmit =
    project.trim() !== "" &&
    chosen.length > 0 &&
    // The prompt is optional (the agent starts and waits), except in Compare mode,
    // which exists to send one prompt to several agents.
    // After a partial Compare launch, retrying the failed targets joins the same group.
    (!compare || ((chosen.length >= 2 || launched.length > 0) && prompt.trim() !== "")) &&
    // A local agent needs to know which of its server's models to run.
    (compare || provider !== "local" || model.trim() !== "");

  /** The model to start a target with: typed/picked (single launch), or a local account's last one. */
  const modelFor = (t: LaunchTarget): string | null => {
    if (t.provider === "custom") return null;
    if (compare) return t.provider === "local" ? recallLocalModel(t.accountId) : null;
    return model.trim() || null;
  };

  const submit = async () => {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    if (compare && !groupRef.current) groupRef.current = uuid();
    const groupId = compare ? groupRef.current : null;
    try {
      const results = await Promise.allSettled(
        chosen.map((t) =>
          api.createAgent({
            provider: t.provider,
            accountId: t.accountId,
            customAgentId: t.customAgentId,
            projectPath: project.trim(),
            prompt: prompt.trim(),
            title: title.trim() || null,
            worktree,
            model: modelFor(t),
            groupId,
            permissionMode: mode,
            attachments: attach.attachments,
          }),
        ),
      );
      const created: Agent[] = [];
      const failed: { target: LaunchTarget; error: string }[] = [];
      results.forEach((r, i) => {
        if (r.status === "fulfilled") created.push(r.value);
        else failed.push({ target: chosen[i], error: errorMessage(r.reason) });
      });
      for (const a of created) useApp.getState().upsertAgent(a);
      if (!compare && provider === "local" && model.trim()) rememberLocalModel(accountId, model.trim());
      const allLaunched = [...launched, ...created];

      if (failed.length === 0) {
        if (!compare && chosen[0]) {
          rememberLaunch({
            provider: chosen[0].provider,
            accountId: chosen[0].accountId,
            customAgentId: chosen[0].customAgentId,
            folder: project.trim(),
            worktree,
          });
        }
        onDone();
        if (groupId && allLaunched.length >= 2) {
          openCompare(groupId);
          toast.success(`Launched ${allLaunched.length} agents`, { description: "Comparing side by side." });
        } else if (allLaunched[0]) {
          openAgent(allLaunched[0].id);
        }
        return;
      }

      // Partial (or total) failure: keep what launched, leave only the failed targets selected
      // so a retry can't duplicate the successes.
      setLaunched(allLaunched);
      if (compare) {
        const ok = new Set(created.map((a) => targetKeyOf(a)));
        setTargets((t) => t.filter((k) => !ok.has(k)));
      }
      const lines = (
        <span className="mt-0.5 flex flex-col gap-0.5">
          {failed.map((f) => (
            <span key={f.target.key}>
              <span className="font-medium text-fg">{targetLabel(f.target)}</span>: {f.error}
            </span>
          ))}
        </span>
      );
      if (created.length === 0 && launched.length === 0) {
        toast.error(failed.length === 1 ? "Couldn't launch agent" : `Couldn't launch ${failed.length} agents`, {
          description: lines,
        });
      } else {
        toast.warning(`Launched ${allLaunched.length}, ${failed.length} failed`, {
          description: (
            <>
              {lines}
              <span className="mt-1 block">Launch again to retry only the failed ones.</span>
            </>
          ),
          action:
            groupId && allLaunched.length > 0
              ? {
                  label: "View comparison",
                  onClick: () => {
                    onDone();
                    openCompare(groupId);
                  },
                }
              : undefined,
        });
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <>
      <DialogBody className="space-y-4 pt-2 max-sm:flex max-sm:flex-col">
        {/* Project */}
        <div>
          <Label htmlFor="na-project">Project folder</Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <FolderOpen className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-steel" />
              <Input
                id="na-project"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                placeholder="/path/to/project"
                className="pl-9 font-mono text-[12.5px]"
              />
            </div>
            <Button variant="secondary" className="h-9" onClick={() => void browse()}>
              Browse…
            </Button>
          </div>
          <ProjectPicker value={project} onChange={setProject} recent={recent} defaultOpen={recent.length === 0} />
        </div>

        {/* Provider / account */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="flex items-center gap-2 text-xs font-medium text-muted">
              {compare ? "Run on" : "Provider"}
              {!compare && (
                <span className="hidden items-center gap-0.5 font-normal text-steel sm:flex">
                  <Kbd>Alt</Kbd>
                  <Kbd>1–{keyChoices.length}</Kbd>
                </span>
              )}
            </span>
            <label className="flex cursor-default items-center gap-2 text-[12px] text-muted">
              <Columns3 className="h-3.5 w-3.5 text-steel" />
              Compare mode
              <Switch checked={compare} onCheckedChange={setCompare} aria-label="Compare mode" />
            </label>
          </div>

          {!compare ? (
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                aria-label="Provider"
                value={choice}
                onChange={chooseProvider}
                className="max-w-full overflow-x-auto"
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
                  ...customAgents.map((c) => ({
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
              {custom ? (
                <div className="flex h-9 min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-line bg-base/40 px-3 text-[12.5px] text-muted">
                  <span className="truncate font-mono text-[11.5px] text-fg/80">
                    {[custom.command, ...custom.args].join(" ")}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-steel">No sign-in needed</span>
                </div>
              ) : providerAccounts.length > 0 ? (
                <div className="min-w-[200px] flex-1">
                  <Select
                    aria-label="Account"
                    value={accountId || undefined}
                    onValueChange={setAccountId}
                    placeholder="Choose account"
                    options={providerAccounts.map((a) => ({
                      value: a.id,
                      label: (
                        <span className="flex items-center gap-2">
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: a.color }} />
                          <span className="truncate">{a.name}</span>
                          <span className={cn("text-[11px]", a.status?.loggedIn ? "text-steel" : "text-warn")}>
                            {accountStateText(a)}
                          </span>
                        </span>
                      ),
                    }))}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    onDone();
                    setView("accounts");
                  }}
                  className="h-9 min-w-[200px] flex-1 rounded-lg border border-dashed border-line-strong px-3 text-left text-[12.5px] text-muted hover:text-fg"
                >
                  {provider === "local"
                    ? "No local model servers. Add one →"
                    : `No ${PROVIDERS[provider].short} accounts. Add one →`}
                </button>
              )}
            </div>
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {accounts.map((a) => {
                const on = targets.includes(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggleTarget(a.id)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-[border-color,background-color,transform] active:scale-[0.99]",
                      on ? "border-accent/50 bg-accent/[0.07]" : "border-line bg-card/60 hover:border-line-strong",
                    )}
                  >
                    <AccountAvatar account={a} size={24} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium">
                        {PROVIDERS[a.provider].short} · {a.name}
                      </span>
                      <span
                        className={cn("block truncate text-[11px]", a.status?.loggedIn ? "text-steel" : "text-warn")}
                      >
                        {accountStateText(a)}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors",
                        on ? "border-accent bg-accent text-accent-fg" : "border-line-strong",
                      )}
                    >
                      {on && <Check className="h-3 w-3" strokeWidth={3} />}
                    </span>
                  </button>
                );
              })}
              {customAgents.map((c) => {
                const key = `custom:${c.id}`;
                const on = targets.includes(key);
                return (
                  <button
                    key={key}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggleTarget(key)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-[border-color,background-color,transform] active:scale-[0.99]",
                      on ? "border-accent/50 bg-accent/[0.07]" : "border-line bg-card/60 hover:border-line-strong",
                    )}
                  >
                    <ProviderGlyph provider="custom" customAgentId={c.id} size="md" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium">{c.name}</span>
                      <span className="block truncate font-mono text-[10.5px] text-steel">
                        {[c.command, ...c.args].join(" ")}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors",
                        on ? "border-accent bg-accent text-accent-fg" : "border-line-strong",
                      )}
                    >
                      {on && <Check className="h-3 w-3" strokeWidth={3} />}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {!compare && provider === "local" && account && (
            <LocalModelPicker key={account.id} account={account} value={model} onChange={setModel} />
          )}
          {!compare && <PreflightNotes issues={issues} className="mt-2" />}
          {compare && chosen.length < 2 && launched.length === 0 && (
            <p className="mt-2 text-[12px] text-steel">Pick at least two agents to compare.</p>
          )}
        </div>

        {/* Prompt */}
        <div className="max-sm:flex max-sm:min-h-[180px] max-sm:flex-1 max-sm:flex-col">
          <div className="mb-1.5 flex items-center justify-between">
            <Label htmlFor="na-prompt" className="mb-0">
              Prompt
              {!compare && <span className="ml-1.5 font-normal text-steel">optional</span>}
            </Label>
            <div className="flex items-center gap-1">
              <AttachButton onClick={attach.openPicker} count={attach.attachments.length} />
              <TemplatePicker
                side="bottom"
                align="end"
                onInsert={(body) => {
                  setPrompt((p) => (p.trim() ? `${p.trimEnd()}\n\n${body}` : body));
                  requestAnimationFrame(() => promptRef.current?.focus());
                }}
              />
            </div>
          </div>
          <input {...attach.inputProps} />
          <div {...attach.dropHandlers} className="relative max-sm:flex max-sm:flex-1 max-sm:flex-col">
            <Textarea
              id="na-prompt"
              onPaste={attach.onPaste}
              ref={promptRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                compare
                  ? "What should each agent do? Be specific about goals and constraints."
                  : "Describe the task, or leave this empty to start the agent and type when you're ready."
              }
              className="min-h-[112px] max-sm:flex-1"
            />
            {attach.dragging && <DropOverlay />}
          </div>
          <AttachmentStrip attachments={attach.attachments} onRemove={attach.remove} className="mt-2" />
        </div>

        {/* Options */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <label className="flex items-center gap-2 text-[12.5px] text-fg">
            <Switch checked={worktree} onCheckedChange={setWorktree} aria-label="Isolated git worktree" />
            <GitBranch className="h-3.5 w-3.5 text-steel" />
            Isolated worktree
            <span className="text-[11.5px] text-steel">(own branch, no conflicts)</span>
          </label>
          <PermissionModeChip value={mode} onChange={setMode} />
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
            className="ml-auto flex items-center gap-1 text-[12px] text-muted hover:text-fg"
          >
            Title & model
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showAdvanced && "rotate-180")} />
          </button>
        </div>
        {showAdvanced && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="na-title">Title (optional)</Label>
              <Input
                id="na-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="From the prompt or your first message"
              />
            </div>
            <div>
              <Label htmlFor="na-model">Model (optional)</Label>
              <Input
                id="na-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={compare || !!custom || provider === "local"}
                placeholder={
                  provider === "local"
                    ? "Chosen above"
                    : compare || custom
                      ? "Agent default"
                      : "e.g. opus, gpt-5.1-codex"
                }
                className="font-mono text-[12.5px]"
              />
            </div>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <span className="mr-auto hidden items-center gap-1 text-[11.5px] text-steel sm:flex">
          <Kbd>{modKey}</Kbd>
          <Kbd>⏎</Kbd> to launch
        </span>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!canSubmit || submitting} onClick={() => void submit()}>
          {submitting ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Rocket />}
          {compare ? `Launch ${chosen.length} agents` : "Launch agent"}
        </Button>
      </DialogFooter>
    </>
  );
}
