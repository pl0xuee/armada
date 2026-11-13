import { ArrowUp, Check, ChevronDown, FolderOpen, FolderPlus, GitBranch } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useIdentity } from "@/hooks/useIdentity";
import { useMinimal } from "@/hooks/useLook";
import { launchAgents, needsWorktree, resolveLaunch, type ResolvedLaunch } from "@/lib/launchDefaults";
import { choicesFor } from "@/lib/modelGuide";
import { CUSTOM_ACCOUNT_ID, PROVIDER_ORDER, PROVIDERS } from "@/lib/providers";
import { basename, cn, errorMessage, prettyPath } from "@/lib/utils";
import { pickFolder } from "@/lib/window";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { AccountAvatar } from "../AccountAvatar";
import { NewProjectDialog } from "../NewProjectDialog";
import { ComposerVoiceButtons } from "../voice/ComposerVoiceButtons";
import { ProviderGlyph } from "../ProviderGlyph";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Kbd } from "../ui/kbd";
import { Spinner } from "../ui/misc";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { Tooltip } from "../ui/tooltip";
import { AgentCount } from "./AgentCount";
import { PermissionModeChip, usePermissionMode } from "./PermissionModeChip";
import { PreflightNotes, usePreflight } from "./PreflightNotes";
import { useWorkChoice, WorkTypeChip } from "./WorkTypeChip";
import { ProjectPicker } from "./ProjectPicker";

const chipClass =
  "inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-line bg-base/50 px-2 text-caption text-fg/90 transition-colors hover:border-line-strong hover:bg-raised data-[state=open]:border-line-strong data-[state=open]:bg-raised";

/**
 * Prompt-first home: type what an agent should do, pick where, press ⌘⏎.
 * Remembers the last provider / account / folder / worktree (lib/launchDefaults).
 */
export function HomeComposer({ compact = false, autoFocus = true }: { compact?: boolean; autoFocus?: boolean }) {
  const [mode, setMode] = usePermissionMode();
  const [work, setWork, workTypes] = useWorkChoice();
  const accounts = useApp((s) => s.accounts);
  const settings = useApp((s) => s.settings);
  const openAgent = useUi((s) => s.openAgent);
  const openAgents = useUi((s) => s.openAgents);
  const [target, setTarget] = useState<ResolvedLaunch>(() => resolveLaunch(accounts, settings));
  // In the store so a trip to Accounts (which remounts this view) keeps what was typed.
  const prompt = useUi((s) => s.homePrompt);
  const setPrompt = useUi((s) => s.setHomePrompt);
  // The agents already started for this prompt when some failed, so a retry joins them (kept like the prompt).
  const batch = useUi((s) => s.homeBatch);
  const minimal = useMinimal();
  const [count, setCount] = useState(() => useUi.getState().homeBatch?.count ?? 1);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const busyRef = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [prompt]);

  useLayoutEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  // Dictated text goes in at the caret. Never auto-starts an agent, whatever the setting.
  const insertDictation = (spoken: string) => {
    const el = ref.current;
    const cur = el?.value ?? "";
    const start = Math.min(el?.selectionStart ?? cur.length, cur.length);
    const end = Math.min(el?.selectionEnd ?? start, cur.length);
    const before = cur.slice(0, start);
    const inserted = `${before && !/\s$/.test(before) ? " " : ""}${spoken}`;
    setPrompt(`${before}${inserted}${cur.slice(end)}`);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(start + inserted.length, start + inserted.length);
    });
  };

  const account = accounts.find((a) => a.id === target.accountId);
  const needsFolder = !target.folder.trim();
  const needsAccount = target.provider !== "custom" && !account;
  const missing = needsFolder
    ? "Pick a project folder"
    : needsAccount
      ? `Add a ${PROVIDERS[target.provider].short} account first`
      : null;
  // Before the first agent: say what is still needed, with a button, instead of a dead Start button.
  const firstRun = useApp(hasNoAgents);
  const [folderOpen, setFolderOpen] = useState(false);
  // Several agents, or the failed ones of a batch being retried: each in its own worktree.
  const parallel = needsWorktree(count) || batch !== null;
  const issues = usePreflight({
    provider: target.provider,
    account: target.provider === "custom" ? undefined : account,
    folder: target.folder,
    worktree: target.worktree || parallel,
  });
  // Several agents in one non-git folder would share it, so they can't be started at all.
  const notGit = parallel && issues.some((i) => i.id === "not_git");
  const canStart = !missing && prompt.trim().length > 0 && !busy && !notGit;

  const start = async () => {
    if (!canStart || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const prior = useUi.getState().homeBatch;
      const { groupId, created, failed } = await launchAgents(
        target,
        prompt,
        mode,
        count,
        prior?.groupId,
        choicesFor(target.provider, work),
      );
      const ids = [...(prior?.ids ?? []), ...created.map((a) => a.id)];
      for (const a of created) useApp.getState().upsertAgent(a);
      if (failed.length === 0) {
        setPrompt("");
        setCount(1);
        useUi.getState().setHomeBatch(null);
      } else {
        // Keep the prompt, and only offer to start the ones that didn't, so a retry can't duplicate the rest.
        setCount(failed.length);
        useUi.getState().setHomeBatch(groupId && ids.length > 0 ? { groupId, ids, count: failed.length } : null);
      }
      if (created.length > 0) {
        // Several agents are shown together as a grid of conversations.
        if (ids.length > 1) openAgents(ids);
        else openAgent(created[0].id);
        if (failed.length === 0 && ids.length > 1)
          toast.success(`Started ${ids.length} agents`, { description: "Each has its own worktree." });
      }
      if (failed.length > 0) {
        toast.error(
          created.length > 0 ? `Started ${created.length}, ${failed.length} failed` : "Couldn't start the agent",
          {
            description: [...new Set(failed)].join("\n"),
            action: {
              label: "More options",
              onClick: () => {
                // The dialog takes the prompt over: don't leave it behind in the home composer.
                useUi.getState().setHomePrompt("");
                useUi.getState().setHomeBatch(null);
                useUi.getState().openNewAgent({ prompt });
              },
            },
          },
        );
      }
    } catch (e) {
      toast.error("Couldn't start the agent", { description: errorMessage(e) });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // Minimal: the round accent button; it keeps its label when it starts several agents.
  const round = minimal && count === 1;
  return (
    <div
      className={
        minimal
          ? "m-composer"
          : cn(
              "rounded-2xl border border-line-strong bg-card shadow-[0_18px_60px_-24px_rgba(0,0,0,0.75)] transition-[border-color,box-shadow] duration-150 edge-strong",
              "focus-within:border-accent/50 focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_12%,transparent),0_18px_60px_-24px_rgba(0,0,0,0.75)]",
            )
      }
    >
      <label htmlFor={compact ? "home-prompt-compact" : "home-prompt"} className="sr-only">
        What should an agent do?
      </label>
      <textarea
        id={compact ? "home-prompt-compact" : "home-prompt"}
        ref={ref}
        value={prompt}
        rows={compact ? 2 : 3}
        onChange={(e) => setPrompt(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          // Enter starts, as it sends in an agent's chat; Shift+Enter adds a new line.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            void start();
          }
        }}
        placeholder={
          firstRun && !compact
            ? "What should an agent do? For example: find and fix the failing tests"
            : "What should an agent do?"
        }
        className={cn(
          "block w-full resize-none bg-transparent px-4 pt-3.5 leading-relaxed text-fg placeholder:text-steel focus:outline-none minimal:px-[18px] minimal:pt-4",
          compact ? "min-h-[56px] text-[13.5px]" : "min-h-[84px] text-[15px]",
        )}
      />
      <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5 pt-1.5">
        <AgentPicker target={target} onChange={(t) => setTarget((cur) => ({ ...cur, ...t }))} />
        <FolderPicker
          folder={target.folder}
          onChange={(folder) => setTarget((cur) => ({ ...cur, folder }))}
          open={folderOpen}
          onOpenChange={setFolderOpen}
        />
        <Tooltip
          content={
            parallel
              ? "Several agents each run in their own worktree"
              : "Run in an isolated git worktree (its own branch)"
          }
        >
          <label className={cn(chipClass, "cursor-default gap-2 pr-1.5")}>
            <GitBranch className="h-3.5 w-3.5 text-steel" />
            <span className={cn(compact && "sr-only")}>Worktree</span>
            <Switch
              checked={target.worktree || parallel}
              disabled={parallel}
              onCheckedChange={(worktree) => setTarget((cur) => ({ ...cur, worktree }))}
              aria-label="Isolated git worktree"
              className="scale-[0.85]"
            />
          </label>
        </Tooltip>
        <AgentCount value={count} onChange={setCount} compact={compact} disabled={busy} />
        {target.provider === "claude" && (
          <WorkTypeChip value={work} onChange={setWork} available={workTypes} compact={compact} />
        )}
        <PermissionModeChip value={mode} onChange={setMode} compact={compact} className="h-7 rounded-lg" />
        <div className="ml-auto flex items-center gap-2">
          <ComposerVoiceButtons onText={insertDictation} />
          {missing && prompt.trim() && <span className="text-meta text-warn">{missing}</span>}
          {canStart && focused && (
            <span className="text-meta text-steel">
              <Kbd>⏎</Kbd> to start, <Kbd>⇧</Kbd> <Kbd>⏎</Kbd> for a new line
            </span>
          )}
          <Tooltip content="Start agent. Shift+Enter adds a new line." shortcut={["⏎"]}>
            <Button
              variant="primary"
              size={compact || round ? "icon-sm" : "sm"}
              disabled={!canStart}
              onClick={() => void start()}
              aria-label={count > 1 ? `Start ${count} agents` : "Start agent"}
              aria-keyshortcuts="Enter"
              className={cn(round ? "m-send" : "minimal:rounded-full")}
            >
              {busy ? (
                <Spinner className="h-3.5 w-3.5 text-current" />
              ) : (
                <ArrowUp className="!h-4 !w-4" strokeWidth={2.5} />
              )}
              {!compact && !round && (count > 1 ? `Start ${count}` : "Start")}
            </Button>
          </Tooltip>
        </div>
      </div>
      {issues.length > 0 && <PreflightNotes issues={issues} className="border-t border-line px-4 py-2" />}
      {firstRun && (needsAccount || needsFolder) && (
        <div className="flex items-center gap-3 border-t border-line px-4 py-2">
          <p className="min-w-0 flex-1 text-caption leading-snug text-muted">
            {needsAccount
              ? "Sign in to an account to start your first agent."
              : "Choose the folder your agent works in, or start a new project."}
          </p>
          {needsAccount ? (
            <Button size="xs" variant="secondary" onClick={() => useUi.getState().setView("accounts")}>
              Add account
            </Button>
          ) : (
            <Button size="xs" variant="secondary" onClick={() => setFolderOpen(true)}>
              Choose folder
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** True while no agent exists yet (the first run). Stops at the first key, so it stays cheap on a big list. */
function hasNoAgents(s: { agents: Record<string, unknown> }): boolean {
  for (const _id in s.agents) return false;
  return true;
}

function AgentPicker({
  target,
  onChange,
}: {
  target: ResolvedLaunch;
  onChange: (t: Pick<ResolvedLaunch, "choice" | "provider" | "accountId" | "customAgentId">) => void;
}) {
  const accounts = useApp((s) => s.accounts);
  const customAgents = useApp((s) => s.settings?.customAgents);
  const enabledCustom = useMemo(() => (customAgents ?? []).filter((c) => c.enabled), [customAgents]);
  const identity = useIdentity(target.provider, target.customAgentId);
  const account = accounts.find((a) => a.id === target.accountId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={chipClass}
          aria-label={`Agent: ${identity.name}${account ? `, ${account.name}` : ""}`}
        >
          <ProviderGlyph provider={target.provider} customAgentId={target.customAgentId} size="xs" />
          <span className="truncate">
            {identity.short}
            {account && <span className="text-muted"> · {account.name}</span>}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 text-steel" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {PROVIDER_ORDER.map((p, i) => {
          const mine = accounts.filter((a) => a.provider === p);
          return (
            <div key={p}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{PROVIDERS[p].name}</DropdownMenuLabel>
              {mine.length === 0 ? (
                <DropdownMenuItem onSelect={() => useUi.getState().setView("accounts")}>
                  <span className="text-muted">Add a {PROVIDERS[p].short} account…</span>
                </DropdownMenuItem>
              ) : (
                mine.map((a) => (
                  <DropdownMenuItem
                    key={a.id}
                    onSelect={() => onChange({ choice: p, provider: p, accountId: a.id, customAgentId: null })}
                  >
                    <AccountAvatar account={a} size={18} />
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    <span className={cn("truncate text-micro", a.status?.loggedIn ? "text-steel" : "text-warn")}>
                      {a.status?.loggedIn ? (a.status.label ?? "Signed in") : "Not signed in"}
                    </span>
                    {target.accountId === a.id && target.provider === p && <Check className="!text-accent" />}
                  </DropdownMenuItem>
                ))
              )}
            </div>
          );
        })}
        {enabledCustom.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Custom agents</DropdownMenuLabel>
            {enabledCustom.map((c) => (
              <DropdownMenuItem
                key={c.id}
                onSelect={() =>
                  onChange({
                    choice: `custom:${c.id}`,
                    provider: "custom",
                    accountId: CUSTOM_ACCOUNT_ID,
                    customAgentId: c.id,
                  })
                }
              >
                <ProviderGlyph provider="custom" customAgentId={c.id} size="xs" />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <span className="truncate font-mono text-micro text-steel">{c.command}</span>
                {target.customAgentId === c.id && <Check className="!text-accent" />}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FolderPicker({
  folder,
  onChange,
  open,
  onOpenChange: setOpen,
}: {
  folder: string;
  onChange: (f: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const recent = useApp((s) => s.settings?.recentProjects) ?? [];
  const [newOpen, setNewOpen] = useState(false);
  const browse = async () => {
    const p = await pickFolder(folder || undefined);
    if (p) {
      onChange(p);
      setOpen(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <NewProjectDialog open={newOpen} onOpenChange={setNewOpen} onCreated={onChange} />
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(chipClass, !folder && "border-warn/40 text-warn")}
          aria-label={folder ? `Project folder: ${prettyPath(folder)}` : "Choose a project folder"}
          title={folder ? prettyPath(folder) : undefined}
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-steel" />
          <span className="max-w-[180px] truncate">{folder ? basename(folder) : "Choose folder"}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-steel" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(380px,calc(100vw-16px))]">
        <div className="flex items-center justify-between gap-2">
          <span className="text-caption font-medium text-muted">Project folder</span>
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="secondary"
              onClick={() => {
                setOpen(false);
                setNewOpen(true);
              }}
            >
              <FolderPlus />
              New project…
            </Button>
            <Button size="xs" variant="secondary" onClick={() => void browse()}>
              Browse…
            </Button>
          </div>
        </div>
        {folder && (
          <p className="selectable mt-1.5 truncate font-mono text-micro text-steel" title={folder}>
            {prettyPath(folder)}
          </p>
        )}
        <ProjectPicker
          value={folder}
          recent={recent}
          defaultOpen={recent.length === 0}
          onChange={(p) => {
            onChange(p);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
