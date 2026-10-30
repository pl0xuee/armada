import * as D from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  GitCompare,
  Globe,
  Keyboard,
  Minimize2,
  Moon,
  Pencil,
  Play,
  Power,
  Square,
  SquareTerminal,
  Sun,
  CalendarClock,
  Download,
  Radio,
  Repeat,
  ChartColumn,
  Columns3,
  CornerDownLeft,
  History,
  Inbox,
  LayoutGrid,
  ListTodo,
  Rocket,
  MessagesSquare,
  Palette as PaletteIcon,
  PanelRight,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  MessageCircleQuestion,
  ShieldX,
  Users,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  archiveAgent,
  attempt,
  cancelTurn,
  checkForUpdates,
  copyDiagnostics,
  exportConversation,
  quickRespond,
  renameAgent,
  resumeAgent,
  stopAgent,
} from "@/lib/actions";
import { orderedAgents } from "@/lib/agents";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import type { Agent, SearchHit, Settings as SettingsT } from "@/lib/types";
import { basename, errorMessage, isMac, modKey } from "@/lib/utils";
import { launchAgent, resolveLaunch } from "@/lib/launchDefaults";
import { useIdentity } from "@/hooks/useIdentity";
import { toast } from "sonner";
import { useDebounced } from "@/hooks/useDebounced";
import { useApp, usePendingPermissions, usePendingQuestions } from "@/store/app";
import { useUi, type SettingsSection } from "@/store/ui";
import { previewOf, togglePreview, usePreview } from "@/store/preview";
import { openTerminal } from "@/store/workspace";
import { openShortcutHelp } from "./shell/ShortcutHelp";
import { ProviderGlyph } from "./ProviderGlyph";
import { StatusDot } from "./StatusDot";
import { Kbd } from "./ui/kbd";
import { Spinner } from "./ui/misc";
import { useReturnFocus } from "./ui/returnFocus";

const itemClass =
  "group flex h-10 cursor-default select-none items-center gap-3 rounded-lg px-2.5 text-[13px] text-fg outline-none data-[selected=true]:bg-gunmetal/80 data-[selected=true]:shadow-[inset_0_0_0_1px_var(--border-strong)] [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0";

const groupClass =
  "px-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-steel";

function IconBox({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line bg-raised text-steel group-data-[selected=true]:text-fg [&_svg]:!h-3.5 [&_svg]:!w-3.5">
      {children}
    </span>
  );
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const focus = useReturnFocus();
  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="anim-fade fixed inset-0 z-[70] bg-[var(--scrim)] backdrop-blur-[2px]" />
        <D.Content
          aria-describedby={undefined}
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
          className="anim-pop fixed left-1/2 top-[12vh] z-[70] w-[min(640px,calc(100vw-16px))] max-sm:top-2 -translate-x-1/2 overflow-hidden rounded-2xl border border-line-strong bg-card/95 shadow-[0_32px_100px_-12px_rgba(0,0,0,0.75)] backdrop-blur-xl edge-strong focus:outline-none"
        >
          <D.Title className="sr-only">Command palette</D.Title>
          {open && <Palette onClose={() => setOpen(false)} />}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

const SETTINGS_SECTIONS: { id: SettingsSection; label: string; keywords: string[] }[] = [
  { id: "appearance", label: "Appearance", keywords: ["theme", "dark", "light"] },
  { id: "sounds", label: "Sounds", keywords: ["audio", "volume"] },
  { id: "notifications", label: "Notifications", keywords: ["notify", "quiet hours", "dnd"] },
  { id: "behavior", label: "Behavior", keywords: ["tray", "hotkey", "failover", "permission mode"] },
  { id: "templates", label: "Templates", keywords: ["prompts", "snippets"] },
  { id: "mcp", label: "Tools (MCP)", keywords: ["mcp", "servers", "tools"] },
  { id: "providers", label: "Providers", keywords: ["install", "cli", "claude", "codex", "grok"] },
  { id: "agents", label: "Agents (ACP)", keywords: ["custom agents", "acp", "gemini", "goose"] },
  { id: "remote", label: "Remote & mobile", keywords: ["phone", "share", "pairing", "lan"] },
  { id: "about", label: "About", keywords: ["version", "updates"] },
];

/** Escape a string for use inside a RegExp. */
function escapeRe(t: string) {
  return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary matching: every search term must start a word in the item's keywords
 * ("mission" matches "Mission Control" but not "permission").
 */
function paletteFilter(value: string, search: string, keywords?: string[]): number {
  const q = search.trim();
  if (q.startsWith(">")) return value.startsWith("start:") ? 1 : 0;
  if (value.startsWith("start:")) return 0;
  const hay = (keywords && keywords.length ? keywords.join(" ") : value).toLowerCase();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((t) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}`, "u").test(hay)) ? 1 : 0;
}

function Palette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  // Inline rename of the current agent (palette "Rename…" switches into this mode).
  const [renaming, setRenaming] = useState<Agent | null>(null);
  const debounced = useDebounced(query, 220);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const agentsMap = useApp((s) => s.agents);
  const settings = useApp((s) => s.settings);
  const accounts = useApp((s) => s.accounts);
  const launch = useMemo(() => resolveLaunch(accounts, settings), [accounts, settings]);
  const launchIdentity = useIdentity(launch.provider, launch.customAgentId);
  const launchAccount = accounts.find((a) => a.id === launch.accountId);
  // The first "Start agent" item uses the default permission mode; the second offers the other one.
  const defaultMode: "auto" | "ask" = settings?.defaultPermissionMode ?? "ask";
  const startMode = query.trimStart().startsWith(">");
  const task = (startMode ? query.trimStart().slice(1) : query).trim();
  const ui = useUi.getState();

  const agents = useMemo(() => orderedAgents(Object.values(agentsMap)), [agentsMap]);
  const archived = useMemo(() => Object.values(agentsMap).filter((a) => a.archived), [agentsMap]);
  const pending = usePendingPermissions();
  const questions = usePendingQuestions();
  const current = ui.view === "agents" && ui.selectedAgentId ? agentsMap[ui.selectedAgentId] : undefined;
  const previewOpen = usePreview((s) => (current ? previewOf(s, current.id).open : false));

  useEffect(() => {
    const q = debounced.trim();
    if (q.length < 2 || q.startsWith(">") || renaming) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    api
      .search(q)
      .then((h) => !cancelled && setHits(h))
      .catch(() => !cancelled && setHits([]))
      .finally(() => !cancelled && setSearching(false));
    return () => {
      cancelled = true;
    };
  }, [debounced, renaming]);

  const run = (fn: () => void) => {
    onClose();
    // Let the dialog close before opening the next surface.
    setTimeout(fn, 10);
  };

  const patch = (p: Partial<SettingsT>) =>
    void useApp
      .getState()
      .patchSettings(p)
      .catch(() => {});

  const startAgent = (text: string, m: "auto" | "ask") =>
    run(() => {
      // Without a folder (or account), finish in the full dialog with the prompt filled in.
      if (!launch.folder || (launch.provider !== "custom" && !launchAccount)) {
        ui.openNewAgent({ prompt: text });
        return;
      }
      void launchAgent(launch, text, m)
        .then((a) => {
          useApp.getState().upsertAgent(a);
          useUi.getState().openAgent(a.id);
        })
        .catch((e: unknown) =>
          toast.error("Couldn't start the agent", {
            description: errorMessage(e),
            action: { label: "More options", onClick: () => useUi.getState().openNewAgent({ prompt: text }) },
          }),
        );
    });

  if (renaming) {
    return <RenameMode agent={renaming} onCancel={() => setRenaming(null)} onDone={onClose} />;
  }

  const busy =
    current && (current.status === "working" || current.status === "starting" || current.status === "needs_permission");
  const resumable = current && (current.status === "interrupted" || current.status === "stopped");
  const canCompact = current?.availableCommands.some((c) => c.name === "compact") ?? false;

  return (
    <Command
      label="Command palette"
      loop
      className="flex max-h-[min(560px,70vh)] flex-col max-sm:max-h-[min(640px,calc(100dvh-16px))]"
      filter={paletteFilter}
      onKeyDown={(e) => {
        // Ctrl/⌘+Enter starts an agent with the typed text (Start items never auto-select).
        const mod = isMac ? e.metaKey : e.ctrlKey;
        if (e.key === "Enter" && mod && !e.nativeEvent.isComposing && e.keyCode !== 229 && task.length >= 3) {
          e.preventDefault();
          startAgent(task, defaultMode);
        }
      }}
    >
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        {startMode ? (
          <Rocket className="h-4 w-4 shrink-0 text-accent" />
        ) : (
          <Search className="h-4 w-4 shrink-0 text-steel" />
        )}
        <Command.Input
          value={query}
          onValueChange={setQuery}
          autoFocus
          aria-label={startMode ? "Describe a task to start an agent" : "Search agents, actions and history"}
          placeholder="Search agents, actions and history…  (type > to start an agent)"
          className="h-12 flex-1 bg-transparent text-[14px] text-fg placeholder:text-steel focus:outline-none"
        />
        {searching && <Spinner className="h-3.5 w-3.5" />}
        <Kbd>Esc</Kbd>
      </div>
      <Command.List className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1.5 [&_[cmdk-list-sizer]]:space-y-0.5">
        {hits.length === 0 && !startMode && (
          <Command.Empty className="px-4 py-10 text-center text-[13px] text-steel">
            {searching ? "Searching history…" : "No results. Try a different phrase."}
          </Command.Empty>
        )}

        {startMode && (
          <Command.Group heading="Start an agent" className={groupClass}>
            {task.length < 3 ? (
              <div className="px-2.5 py-3 text-[12.5px] text-steel">
                Describe the task after “&gt;”, then press Enter.
              </div>
            ) : (
              [defaultMode, defaultMode === "auto" ? ("ask" as const) : ("auto" as const)].map((m) => (
                <Command.Item
                  key={m}
                  value={`start:${m}`}
                  onSelect={() => startAgent(task, m)}
                  className={`${itemClass} h-auto min-h-10 py-1.5`}
                >
                  <IconBox>
                    <Rocket className="!text-accent" />
                  </IconBox>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      Start agent{m === defaultMode ? "" : ` in ${m === "auto" ? "Auto" : "Ask"}`}:{" "}
                      <span className="text-fg">“{task}”</span>
                    </span>
                    <span className="flex min-w-0 items-center gap-1 text-[11px] text-steel">
                      <ProviderGlyph provider={launch.provider} customAgentId={launch.customAgentId} size="xs" />
                      <span className="truncate">
                        {launchIdentity.short}
                        {launchAccount ? ` · ${launchAccount.name}` : ""}
                        {launch.folder ? ` · ${basename(launch.folder)}` : " · choose a folder"}
                        {launch.worktree ? " · worktree" : ""}
                        {` · ${m === "auto" ? "Auto" : "Ask"}`}
                      </span>
                    </span>
                  </span>
                </Command.Item>
              ))
            )}
          </Command.Group>
        )}

        {!startMode && (
          <>
            <Command.Group heading="Agents" className={groupClass}>
              {[...agents, ...archived].map((a, i) => (
                <Command.Item
                  key={a.id}
                  value={`agent:${a.id}`}
                  keywords={[
                    a.title,
                    a.provider,
                    basename(a.projectPath),
                    a.branch ?? "",
                    a.archived ? "archived" : "",
                  ]}
                  onSelect={() => run(() => ui.openAgent(a.id))}
                  className={itemClass}
                >
                  <ProviderGlyph provider={a.provider} customAgentId={a.customAgentId} size="sm" />
                  <span className="min-w-0 flex-1 truncate">
                    {a.title}
                    {a.archived && <span className="ml-2 text-[11px] text-steel">archived</span>}
                  </span>
                  <StatusDot status={a.status} size={6} />
                  <span className="w-24 truncate text-right text-[11.5px] text-steel max-[480px]:hidden">
                    {basename(a.projectPath)}
                  </span>
                  {/* Always reserve the badge's width so rows don't shift when one is selected. */}
                  <span className="invisible flex w-[52px] shrink-0 justify-end gap-0.5 group-data-[selected=true]:visible max-[480px]:hidden">
                    {i < 9 && !a.archived && (
                      <>
                        <Kbd>{modKey}</Kbd>
                        <Kbd>{i + 1}</Kbd>
                      </>
                    )}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>

            {current && (
              <Command.Group heading={`This agent · ${current.title}`} className={groupClass}>
                {busy && (
                  <PaletteAction
                    icon={<Square />}
                    label="Stop this turn"
                    keywords={["stop", "cancel", "interrupt"]}
                    onSelect={() => run(() => void cancelTurn(current))}
                  />
                )}
                {resumable && (
                  <PaletteAction
                    icon={<Play />}
                    label="Resume agent"
                    keywords={["resume", "restart", "continue"]}
                    onSelect={() => run(() => void resumeAgent(current))}
                  />
                )}
                <PaletteAction
                  icon={<SquareTerminal />}
                  label="Toggle workspace panel"
                  shortcut={[modKey, "`"]}
                  keywords={["terminal", "scripts", "shell", "console"]}
                  onSelect={() => run(() => ui.setWorkspaceOpen(!useUi.getState().workspaceOpen))}
                />
                <PaletteAction
                  icon={<Globe />}
                  label={previewOpen ? "Close preview" : "Open preview"}
                  shortcut={[modKey, "⇧", "P"]}
                  keywords={["preview", "browser", "localhost", "web", "site", "dev server"]}
                  onSelect={() => run(() => togglePreview(current.id))}
                />
                <PaletteAction
                  icon={<SquareTerminal />}
                  label="New terminal"
                  keywords={["terminal", "shell", "console", "workspace"]}
                  onSelect={() =>
                    run(() => {
                      ui.setWorkspaceOpen(true);
                      void openTerminal(current.id).catch((e: unknown) =>
                        toast.error("Couldn't open a terminal", { description: errorMessage(e) }),
                      );
                    })
                  }
                />
                {current.worktree && (
                  <PaletteAction
                    icon={<GitCompare />}
                    label="Review diff"
                    keywords={["review", "diff", "changes", "commit", "merge"]}
                    onSelect={() => run(() => ui.setReviewAgent(current.id))}
                  />
                )}
                {canCompact && (
                  <PaletteAction
                    icon={<Minimize2 />}
                    label="Compact context"
                    keywords={["compact", "context", "summarize", "/compact"]}
                    onSelect={() =>
                      run(() => void attempt("Couldn't compact", () => api.sendPrompt(current.id, "/compact")))
                    }
                  />
                )}
                <PaletteAction
                  icon={<Pencil />}
                  label="Rename…"
                  keywords={["rename", "title"]}
                  onSelect={() => {
                    setRenaming(current);
                    setQuery("");
                  }}
                />
                <PaletteAction
                  icon={<Download />}
                  label="Export conversation…"
                  keywords={["export", "save", "markdown", "json", "transcript"]}
                  onSelect={() => run(() => void exportConversation(current))}
                />
                <PaletteAction
                  icon={<Radio />}
                  label="Share live view…"
                  keywords={["share", "remote", "link", "mobile"]}
                  onSelect={() => run(() => ui.setShareAgent(current))}
                />
                {current.provider !== "custom" && (
                  <PaletteAction
                    icon={<Repeat />}
                    label="Switch account…"
                    keywords={["switch account", "move", "failover", "limit"]}
                    onSelect={() => run(() => ui.setMoveAgent(current))}
                  />
                )}
                <PaletteAction
                  icon={current.archived ? <ArchiveRestore /> : <Archive />}
                  label={current.archived ? "Unarchive" : "Archive"}
                  keywords={["archive", "hide"]}
                  onSelect={() => run(() => void archiveAgent(current, !current.archived))}
                />
                {current.running && (
                  <PaletteAction
                    icon={<Power />}
                    label="Shut down agent"
                    keywords={["shut down", "kill", "process", "stop agent"]}
                    onSelect={() => run(() => void stopAgent(current))}
                  />
                )}
              </Command.Group>
            )}

            <Command.Group heading="Actions" className={groupClass}>
              <PaletteAction
                icon={<Plus />}
                label="New agent"
                shortcut={[modKey, "N"]}
                onSelect={() => run(() => ui.openNewAgent())}
              />
              <PaletteAction
                icon={<Columns3 />}
                label="Compare providers…"
                keywords={["compare", "side by side"]}
                onSelect={() => run(() => ui.openNewAgent({ compare: true }))}
              />
              <PaletteAction
                icon={<MessagesSquare />}
                label="Go to Agents"
                onSelect={() => run(() => ui.setView("agents"))}
              />
              <PaletteAction
                icon={<ListTodo />}
                label="Go to Needs you"
                shortcut={[modKey, "J"]}
                keywords={["triage", "attention", "unread", "queue"]}
                onSelect={() => run(() => ui.setView("triage"))}
              />
              <PaletteAction
                icon={<LayoutGrid />}
                label="Go to Mission Control"
                shortcut={[modKey, "⇧", "M"]}
                onSelect={() => run(() => ui.setView("mission"))}
              />
              <PaletteAction
                icon={<Inbox />}
                label="Go to Inbox"
                shortcut={[modKey, "I"]}
                keywords={["approvals"]}
                onSelect={() => run(() => ui.setView("inbox"))}
              />
              <PaletteAction
                icon={<Columns3 />}
                label="Go to Compare"
                onSelect={() => run(() => ui.openCompare(null))}
              />
              <PaletteAction
                icon={<ChartColumn />}
                label="Go to Usage"
                keywords={["cost", "tokens"]}
                onSelect={() => run(() => ui.setView("usage"))}
              />
              <PaletteAction
                icon={<Users />}
                label="Go to Accounts"
                keywords={["login", "sign in"]}
                onSelect={() => run(() => ui.setView("accounts"))}
              />
              <PaletteAction
                icon={<CalendarClock />}
                label="Go to Schedules"
                keywords={["cron", "recurring", "timer"]}
                onSelect={() => run(() => ui.setView("schedules"))}
              />
              <PaletteAction
                icon={<Settings />}
                label="Open Settings"
                shortcut={[modKey, ","]}
                onSelect={() => run(() => ui.openSettings())}
              />
              <PaletteAction
                icon={<Keyboard />}
                label="Keyboard shortcuts"
                shortcut={[modKey, "/"]}
                keywords={["help", "keys", "cheat sheet", "hotkeys"]}
                onSelect={() => run(() => openShortcutHelp())}
              />
              <PaletteAction
                icon={<Sparkles />}
                label="Check for updates"
                keywords={["update", "version", "upgrade"]}
                onSelect={() => run(() => void checkForUpdates())}
              />
              <PaletteAction
                icon={<PanelRight />}
                label="Toggle inspector"
                onSelect={() => run(() => ui.setInspectorOpen(!useUi.getState().inspectorOpen))}
              />
            </Command.Group>

            <Command.Group heading="Settings" className={groupClass}>
              <PaletteAction
                icon={<Download />}
                label="Copy diagnostics"
                keywords={["bug", "report", "debug", "logs", "support"]}
                onSelect={() => run(() => void copyDiagnostics())}
              />
              {SETTINGS_SECTIONS.map((sec) => (
                <PaletteAction
                  key={sec.id}
                  icon={<Settings />}
                  label={`Settings: ${sec.label}`}
                  keywords={["settings", "preferences", ...sec.keywords]}
                  onSelect={() => run(() => ui.openSettings(sec.id))}
                />
              ))}
            </Command.Group>

            {settings && (
              <Command.Group heading="Preferences" className={groupClass}>
                <PaletteAction
                  icon={settings.theme === "titanium" ? <Moon /> : <Sun />}
                  label={
                    settings.theme === "titanium" ? "Toggle theme: switch to dark" : "Toggle theme: switch to light"
                  }
                  keywords={["theme", "toggle", "dark", "light", "appearance"]}
                  onSelect={() => run(() => patch({ theme: settings.theme === "titanium" ? "gunmetal" : "titanium" }))}
                />
                <PaletteAction
                  icon={settings.sounds.enabled ? <VolumeX /> : <Volume2 />}
                  label={settings.sounds.enabled ? "Mute sounds" : "Unmute sounds"}
                  keywords={["sound", "audio"]}
                  onSelect={() =>
                    run(() => patch({ sounds: { ...settings.sounds, enabled: !settings.sounds.enabled } }))
                  }
                />
                <PaletteAction
                  icon={settings.notifications.enabled ? <BellOff /> : <Bell />}
                  label={settings.notifications.enabled ? "Turn off notifications" : "Turn on notifications"}
                  keywords={["notify", "dnd"]}
                  onSelect={() =>
                    run(() =>
                      patch({ notifications: { ...settings.notifications, enabled: !settings.notifications.enabled } }),
                    )
                  }
                />
                {(["gunmetal", "carbon", "titanium"] as const)
                  .filter((t) => t !== settings.theme)
                  .map((t) => (
                    <PaletteAction
                      key={t}
                      icon={<PaletteIcon />}
                      label={`Theme: ${t[0].toUpperCase()}${t.slice(1)}`}
                      keywords={["theme", "appearance", t === "titanium" ? "light" : "dark"]}
                      onSelect={() => run(() => patch({ theme: t }))}
                    />
                  ))}
              </Command.Group>
            )}

            {/* Approvals come last: cmdk auto-selects the first item, and Enter must never approve by accident. */}
            {pending.length > 0 && (
              <Command.Group heading="Waiting for approval" className={groupClass}>
                {pending.slice(0, 6).flatMap(({ agent, item }) => [
                  <Command.Item
                    key={`${item.id}-allow`}
                    value={`approve:${item.id}`}
                    keywords={["approve", "allow", "yes", "permission", item.title, agent.title]}
                    onSelect={() => run(() => void quickRespond(agent.id, item, "allow_once"))}
                    className={itemClass}
                  >
                    <IconBox>
                      <ShieldCheck className="!text-ok" />
                    </IconBox>
                    <span className="min-w-0 flex-1 truncate">
                      Allow once <span className="text-muted">· {item.title}</span>
                    </span>
                    <span className="truncate text-[11.5px] text-steel">{agent.title}</span>
                  </Command.Item>,
                  <Command.Item
                    key={`${item.id}-deny`}
                    value={`deny:${item.id}`}
                    keywords={["deny", "reject", "no", "permission", item.title, agent.title]}
                    onSelect={() => run(() => void quickRespond(agent.id, item, "reject"))}
                    className={itemClass}
                  >
                    <IconBox>
                      <ShieldX className="!text-err" />
                    </IconBox>
                    <span className="min-w-0 flex-1 truncate">
                      Deny <span className="text-muted">· {item.title}</span>
                    </span>
                    <span className="truncate text-[11.5px] text-steel">{agent.title}</span>
                  </Command.Item>,
                ])}
              </Command.Group>
            )}

            {questions.length > 0 && (
              <Command.Group heading="Waiting for an answer" className={groupClass}>
                {questions.slice(0, 6).map(({ agent, item }) => (
                  <Command.Item
                    key={item.id}
                    value={`answer:${item.id}`}
                    keywords={["answer", "question", "reply", item.message, agent.title]}
                    onSelect={() => run(() => ui.openAgent(agent.id))}
                    className={itemClass}
                  >
                    <IconBox>
                      <MessageCircleQuestion className="!text-warn" />
                    </IconBox>
                    <span className="min-w-0 flex-1 truncate">
                      Answer <span className="text-muted">· {item.message}</span>
                    </span>
                    <span className="truncate text-[11.5px] text-steel">{agent.title}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {hits.length > 0 && (
              <Command.Group heading="History" className={groupClass} forceMount>
                {hits.map((h) => {
                  const a = agentsMap[h.agentId];
                  return (
                    <Command.Item
                      key={`${h.agentId}-${h.itemId}`}
                      // Stable value + forceMount: rows don't remount or vanish while the query is retyped.
                      value={`history:${h.agentId}:${h.itemId}`}
                      forceMount
                      onSelect={() => run(() => ui.openAgent(h.agentId))}
                      className={`${itemClass} h-auto min-h-10 py-2`}
                    >
                      <IconBox>
                        <History />
                      </IconBox>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] text-fg/90">
                          {h.snippet.replace(/[`*#>_]+/g, "")}
                        </span>
                        <span className="block truncate text-[11px] text-steel">
                          {a?.title ?? "Deleted agent"} · {h.kind.replace("_", " ")} · {relativeTime(h.ts)}
                        </span>
                      </span>
                    </Command.Item>
                  );
                })}
              </Command.Group>
            )}
          </>
        )}
      </Command.List>
      <div className="flex items-center gap-3 border-t border-line bg-panel/60 px-4 py-2 text-[11px] text-steel">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> navigate
        </span>
        <span className="flex items-center gap-1">
          <Kbd>
            <CornerDownLeft className="h-2.5 w-2.5" />
          </Kbd>
          select
        </span>
        {!startMode && task.length >= 3 ? (
          <span className="ml-auto flex min-w-0 items-center gap-1 truncate">
            <Kbd>{modKey}</Kbd>
            <Kbd>
              <CornerDownLeft className="h-2.5 w-2.5" />
            </Kbd>
            <span className="truncate">start an agent with this text</span>
          </span>
        ) : (
          <span className="ml-auto max-[520px]:hidden">
            {startMode ? "Enter starts the agent" : "Type > to start an agent · 2+ characters search history"}
          </span>
        )}
      </div>
    </Command>
  );
}

/** Inline rename of an agent inside the palette. */
function RenameMode({ agent, onCancel, onDone }: { agent: Agent; onCancel: () => void; onDone: () => void }) {
  const [title, setTitle] = useState(agent.title);
  const commit = () => {
    const t = title.trim();
    onDone();
    if (t && t !== agent.title) void renameAgent(agent, t);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
      className="flex flex-col"
    >
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <Pencil className="h-4 w-4 shrink-0 text-steel" />
        <input
          autoFocus
          value={title}
          aria-label="New agent title"
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
            if (e.key === "Enter" && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault();
          }}
          className="h-12 flex-1 bg-transparent text-[14px] text-fg focus:outline-none"
        />
      </div>
      <div className="flex items-center gap-3 px-4 py-2 text-[11px] text-steel">
        <span className="flex items-center gap-1">
          <Kbd>
            <CornerDownLeft className="h-2.5 w-2.5" />
          </Kbd>
          rename
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd> back
        </span>
      </div>
    </form>
  );
}

function PaletteAction({
  icon,
  label,
  shortcut,
  keywords,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  shortcut?: string[];
  keywords?: string[];
  onSelect: () => void;
}) {
  return (
    <Command.Item
      value={`action:${label}`}
      keywords={[label, ...(keywords ?? [])]}
      onSelect={onSelect}
      className={itemClass}
    >
      <IconBox>{icon}</IconBox>
      <span className="flex-1 truncate">{label}</span>
      {shortcut && (
        <span className="flex gap-0.5">
          {shortcut.map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
        </span>
      )}
    </Command.Item>
  );
}
