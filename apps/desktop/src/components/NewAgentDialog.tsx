import { Check, ChevronDown, Columns3, FolderOpen, GitBranch, Rocket, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { CUSTOM_ACCOUNT_ID, PROVIDER_ORDER, PROVIDERS } from "@/lib/providers";
import type { Account, Provider } from "@/lib/types";
import { basename, cn, errorMessage, modKey, prettyPath, uuid } from "@/lib/utils";
import { pickFolder } from "@/lib/window";
import { useApp } from "@/store/app";
import { useUi, type NewAgentPreset } from "@/store/ui";
import { AccountAvatar } from "./AccountAvatar";
import { useAttachments } from "@/hooks/useAttachments";
import { AttachButton, DropOverlay } from "./AttachControls";
import { AttachmentStrip } from "./AttachmentStrip";
import { ProviderGlyph } from "./ProviderGlyph";
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

function defaultAccount(accounts: Account[], provider: Provider): Account | undefined {
  const mine = accounts.filter((a) => a.provider === provider);
  return mine.find((a) => a.status?.loggedIn) ?? mine[0];
}

interface LaunchTarget {
  provider: Provider;
  accountId: string;
  customAgentId: string | null;
}

function NewAgentForm({ preset, onDone }: { preset: NewAgentPreset | null; onDone: () => void }) {
  const accounts = useApp((s) => s.accounts);
  const settings = useApp((s) => s.settings);
  const providers = useApp((s) => s.providers);
  const openAgent = useUi((s) => s.openAgent);
  const openCompare = useUi((s) => s.openCompare);
  const setView = useUi((s) => s.setView);

  const recent = settings?.recentProjects ?? [];
  const [project, setProject] = useState(preset?.projectPath ?? recent[0] ?? "");
  const [compare, setCompare] = useState(preset?.compare ?? false);
  const customAgents = useMemo(() => (settings?.customAgents ?? []).filter((c) => c.enabled), [settings?.customAgents]);
  /** "claude" | "codex" | "grok" | "custom:<id>" */
  const [choice, setChoice] = useState<string>(preset?.provider ?? "claude");
  const custom = choice.startsWith("custom:") ? customAgents.find((c) => `custom:${c.id}` === choice) : undefined;
  const provider: Provider = custom ? "custom" : (choice as Provider);
  const attach = useAttachments();
  const [accountId, setAccountId] = useState<string>(
    preset?.accountId ?? defaultAccount(accounts, preset?.provider ?? "claude")?.id ?? "",
  );
  const [targets, setTargets] = useState<string[]>(() =>
    PROVIDER_ORDER.map((p) => defaultAccount(accounts, p)?.id).filter((x): x is string => !!x),
  );
  const [worktree, setWorktree] = useState(settings?.defaultWorktree ?? true);
  const [title, setTitle] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState(preset?.prompt ?? "");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const t = setTimeout(() => promptRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  const providerAccounts = useMemo(() => accounts.filter((a) => a.provider === provider), [accounts, provider]);
  const account = accounts.find((a) => a.id === accountId);
  const providerInfo = providers.find((p) => p.provider === provider);

  const chooseProvider = (key: string) => {
    setChoice(key);
    if (!key.startsWith("custom:")) setAccountId(defaultAccount(accounts, key as Provider)?.id ?? "");
  };

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
          .map((a) => ({ provider: a.provider, accountId: a.id, customAgentId: null })),
        ...customAgents
          .filter((c) => targets.includes(`custom:${c.id}`))
          .map((c) => ({ provider: "custom" as const, accountId: CUSTOM_ACCOUNT_ID, customAgentId: c.id })),
      ]
    : custom
      ? [{ provider: "custom", accountId: CUSTOM_ACCOUNT_ID, customAgentId: custom.id }]
      : account
        ? [{ provider: account.provider, accountId: account.id, customAgentId: null }]
        : [];
  const canSubmit =
    project.trim() !== "" && prompt.trim() !== "" && chosen.length > 0 && (!compare || chosen.length >= 2);

  const submit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    const groupId = compare ? uuid() : null;
    try {
      const created = await Promise.all(
        chosen.map((t) =>
          api.createAgent({
            provider: t.provider,
            accountId: t.accountId,
            customAgentId: t.customAgentId,
            projectPath: project.trim(),
            prompt: prompt.trim(),
            title: title.trim() || null,
            worktree,
            model: !compare && t.provider !== "custom" && model.trim() ? model.trim() : null,
            groupId,
            attachments: attach.attachments,
          }),
        ),
      );
      for (const a of created) useApp.getState().upsertAgent(a);
      onDone();
      if (groupId) {
        openCompare(groupId);
        toast.success(`Launched ${created.length} agents`, { description: "Comparing side by side." });
      } else if (created[0]) {
        openAgent(created[0].id);
      }
    } catch (e) {
      toast.error("Couldn't launch agent", { description: errorMessage(e) });
    } finally {
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
          {recent.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {recent.slice(0, 6).map((p) => (
                <button
                  key={p}
                  type="button"
                  title={prettyPath(p)}
                  onClick={() => setProject(p)}
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-[11.5px] transition-colors",
                    project === p
                      ? "border-accent/50 bg-accent/10 text-accent"
                      : "border-line bg-card text-muted hover:border-line-strong hover:text-fg",
                  )}
                >
                  {project === p && <Check className="h-3 w-3" />}
                  {basename(p)}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Provider / account */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-muted">{compare ? "Run on" : "Provider"}</span>
            <label className="flex cursor-default items-center gap-2 text-[12px] text-muted">
              <Columns3 className="h-3.5 w-3.5 text-steel" />
              Compare mode
              <Switch checked={compare} onCheckedChange={setCompare} aria-label="Compare mode" />
            </label>
          </div>

          {!compare ? (
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                aria-label="Agent"
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
                            {a.status?.loggedIn ? (a.status.label ?? "Signed in") : "Not signed in"}
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
                  No {PROVIDERS[provider].short} accounts. Add one →
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
                        {a.status?.loggedIn ? (a.status.label ?? "Signed in") : "Not signed in"}
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

          {!compare && !custom && account && account.status && !account.status.loggedIn && (
            <p className="mt-2 flex items-center gap-1.5 text-[12px] text-warn">
              <TriangleAlert className="h-3.5 w-3.5" /> {account.name} isn't signed in. The agent may fail to start.
            </p>
          )}
          {!compare && !custom && providerInfo && !providerInfo.installed && (
            <p className="mt-2 flex items-center gap-1.5 text-[12px] text-warn">
              <TriangleAlert className="h-3.5 w-3.5" /> {providerInfo.displayName} CLI isn't installed. Install it from
              Settings → Providers.
            </p>
          )}
          {compare && chosen.length < 2 && (
            <p className="mt-2 text-[12px] text-steel">Pick at least two agents to compare.</p>
          )}
        </div>

        {/* Prompt */}
        <div className="max-sm:flex max-sm:min-h-[180px] max-sm:flex-1 max-sm:flex-col">
          <div className="mb-1.5 flex items-center justify-between">
            <Label htmlFor="na-prompt" className="mb-0">
              Prompt
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
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="What should the agent do? Be specific about goals and constraints. Paste or drop images to attach them."
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
                placeholder="Generated from prompt"
              />
            </div>
            <div>
              <Label htmlFor="na-model">Model (optional)</Label>
              <Input
                id="na-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={compare || !!custom}
                placeholder={compare || custom ? "Agent default" : "e.g. opus, gpt-5.1-codex"}
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
