import { ArrowUp, Check, ChevronDown, FolderOpen, GitBranch } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useIdentity } from "@/hooks/useIdentity";
import { launchAgent, resolveLaunch, type ResolvedLaunch } from "@/lib/launchDefaults";
import { CUSTOM_ACCOUNT_ID, PROVIDER_ORDER, PROVIDERS } from "@/lib/providers";
import { basename, cn, errorMessage, isMac, modKey, prettyPath } from "@/lib/utils";
import { pickFolder } from "@/lib/window";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { AccountAvatar } from "../AccountAvatar";
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
import { Spinner } from "../ui/misc";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { Tooltip } from "../ui/tooltip";
import { PermissionModeChip, usePermissionMode } from "./PermissionModeChip";
import { PreflightNotes, usePreflight } from "./PreflightNotes";
import { ProjectPicker } from "./ProjectPicker";

const chipClass =
  "inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-line bg-base/50 px-2 text-[12px] text-fg/90 transition-colors hover:border-line-strong hover:bg-raised data-[state=open]:border-line-strong data-[state=open]:bg-raised";

/**
 * Prompt-first home: type what an agent should do, pick where, press ⌘⏎.
 * Remembers the last provider / account / folder / worktree (lib/launchDefaults).
 */
export function HomeComposer({ compact = false, autoFocus = true }: { compact?: boolean; autoFocus?: boolean }) {
  const [mode, setMode] = usePermissionMode();
  const accounts = useApp((s) => s.accounts);
  const settings = useApp((s) => s.settings);
  const openAgent = useUi((s) => s.openAgent);
  const [target, setTarget] = useState<ResolvedLaunch>(() => resolveLaunch(accounts, settings));
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
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

  const account = accounts.find((a) => a.id === target.accountId);
  const missing = !target.folder.trim()
    ? "Pick a project folder"
    : target.provider !== "custom" && !account
      ? `Add a ${PROVIDERS[target.provider].short} account first`
      : null;
  const canStart = !missing && prompt.trim().length > 0 && !busy;
  const issues = usePreflight({
    provider: target.provider,
    account: target.provider === "custom" ? undefined : account,
    folder: target.folder,
    worktree: target.worktree,
  });

  const start = async () => {
    if (!canStart || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const agent = await launchAgent(target, prompt, mode);
      useApp.getState().upsertAgent(agent);
      setPrompt("");
      openAgent(agent.id);
    } catch (e) {
      toast.error("Couldn't start the agent", {
        description: errorMessage(e),
        action: { label: "More options", onClick: () => useUi.getState().openNewAgent({ prompt }) },
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        "rounded-2xl border border-line-strong bg-card shadow-[0_18px_60px_-24px_rgba(0,0,0,0.75)] transition-[border-color,box-shadow] duration-150 edge-strong",
        "focus-within:border-accent/50 focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_12%,transparent),0_18px_60px_-24px_rgba(0,0,0,0.75)]",
      )}
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
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            void start();
          }
        }}
        placeholder="What should an agent do?"
        className={cn(
          "block w-full resize-none bg-transparent px-4 pt-3.5 leading-relaxed text-fg placeholder:text-steel focus:outline-none",
          compact ? "min-h-[56px] text-[13.5px]" : "min-h-[84px] text-[15px]",
        )}
      />
      <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5 pt-1.5">
        <AgentPicker target={target} onChange={(t) => setTarget((cur) => ({ ...cur, ...t }))} />
        <FolderPicker folder={target.folder} onChange={(folder) => setTarget((cur) => ({ ...cur, folder }))} />
        <Tooltip content="Run in an isolated git worktree (its own branch)">
          <label className={cn(chipClass, "cursor-default gap-2 pr-1.5")}>
            <GitBranch className="h-3.5 w-3.5 text-steel" />
            <span className={cn(compact && "sr-only")}>Worktree</span>
            <Switch
              checked={target.worktree}
              onCheckedChange={(worktree) => setTarget((cur) => ({ ...cur, worktree }))}
              aria-label="Isolated git worktree"
              className="scale-[0.85]"
            />
          </label>
        </Tooltip>
        {!compact && <PermissionModeChip value={mode} onChange={setMode} className="h-7 rounded-lg" />}
        <div className="ml-auto flex items-center gap-2">
          {missing && prompt.trim() && <span className="text-[11.5px] text-warn">{missing}</span>}
          <Tooltip content="Start agent" shortcut={[modKey, "⏎"]}>
            <Button
              variant="primary"
              size={compact ? "icon-sm" : "sm"}
              disabled={!canStart}
              onClick={() => void start()}
              aria-label="Start agent"
              aria-keyshortcuts={isMac ? "Meta+Enter" : "Control+Enter"}
            >
              {busy ? (
                <Spinner className="h-3.5 w-3.5 text-current" />
              ) : (
                <ArrowUp className="!h-4 !w-4" strokeWidth={2.5} />
              )}
              {!compact && "Start"}
            </Button>
          </Tooltip>
        </div>
      </div>
      {issues.length > 0 && <PreflightNotes issues={issues} className="border-t border-line px-4 py-2" />}
    </div>
  );
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
                    <span className={cn("truncate text-[11px]", a.status?.loggedIn ? "text-steel" : "text-warn")}>
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
                <span className="truncate font-mono text-[10.5px] text-steel">{c.command}</span>
                {target.customAgentId === c.id && <Check className="!text-accent" />}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FolderPicker({ folder, onChange }: { folder: string; onChange: (f: string) => void }) {
  const recent = useApp((s) => s.settings?.recentProjects) ?? [];
  const [open, setOpen] = useState(false);
  const browse = async () => {
    const p = await pickFolder(folder || undefined);
    if (p) {
      onChange(p);
      setOpen(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
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
          <span className="text-[12px] font-medium text-muted">Project folder</span>
          <Button size="xs" variant="secondary" onClick={() => void browse()}>
            Browse…
          </Button>
        </div>
        {folder && (
          <p className="selectable mt-1.5 truncate font-mono text-[11px] text-steel" title={folder}>
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
