import * as D from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import {
  Bell,
  BellOff,
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
  MessagesSquare,
  Palette as PaletteIcon,
  PanelRight,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  ShieldX,
  Users,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { checkForUpdates, exportConversation, quickRespond } from "@/lib/actions";
import { orderedAgents } from "@/lib/agents";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import type { SearchHit, Settings as SettingsT } from "@/lib/types";
import { basename, modKey } from "@/lib/utils";
import { useDebounced } from "@/hooks/useDebounced";
import { collectPending, useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { ProviderGlyph } from "./ProviderGlyph";
import { StatusDot } from "./StatusDot";
import { Kbd } from "./ui/kbd";
import { Spinner } from "./ui/misc";

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
  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="anim-fade fixed inset-0 z-[70] bg-[var(--scrim)] backdrop-blur-[2px]" />
        <D.Content
          aria-describedby={undefined}
          className="anim-pop fixed left-1/2 top-[12vh] z-[70] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-2xl border border-line-strong bg-card/95 shadow-[0_32px_100px_-12px_rgba(0,0,0,0.75)] backdrop-blur-xl edge-strong focus:outline-none"
        >
          <D.Title className="sr-only">Command palette</D.Title>
          {open && <Palette onClose={() => setOpen(false)} />}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function Palette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 220);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const agentsMap = useApp((s) => s.agents);
  const items = useApp((s) => s.items);
  const settings = useApp((s) => s.settings);
  const ui = useUi.getState();

  const agents = useMemo(() => orderedAgents(Object.values(agentsMap)), [agentsMap]);
  const archived = useMemo(() => Object.values(agentsMap).filter((a) => a.archived), [agentsMap]);
  const pending = useMemo(() => collectPending({ agents: agentsMap, items }), [agentsMap, items]);
  const current = ui.view === "agents" && ui.selectedAgentId ? agentsMap[ui.selectedAgentId] : undefined;

  useEffect(() => {
    const q = debounced.trim();
    if (q.length < 2) {
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
  }, [debounced]);

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

  return (
    <Command
      label="Command palette"
      loop
      className="flex max-h-[min(560px,70vh)] flex-col"
      filter={(value, search, keywords) => {
        const hay = `${value} ${(keywords ?? []).join(" ")}`.toLowerCase();
        const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
        return terms.every((t) => hay.includes(t)) ? 1 : 0;
      }}
    >
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <Search className="h-4 w-4 shrink-0 text-steel" />
        <Command.Input
          value={query}
          onValueChange={setQuery}
          autoFocus
          placeholder="Search agents, actions and history…"
          className="h-12 flex-1 bg-transparent text-[14px] text-fg placeholder:text-steel focus:outline-none"
        />
        {searching && <Spinner className="h-3.5 w-3.5" />}
        <Kbd>Esc</Kbd>
      </div>
      <Command.List className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1.5 [&_[cmdk-list-sizer]]:space-y-0.5">
        {hits.length === 0 && (
          <Command.Empty className="px-4 py-10 text-center text-[13px] text-steel">
            {searching ? "Searching history…" : "No results. Try a different phrase."}
          </Command.Empty>
        )}

        {pending.length > 0 && (
          <Command.Group heading="Waiting for approval" className={groupClass}>
            {pending.slice(0, 6).flatMap(({ agent, item }) => [
              <Command.Item
                key={`${item.id}-allow`}
                value={`approve ${item.title} ${agent.title}`}
                keywords={["allow", "yes", "permission"]}
                onSelect={() => run(() => void quickRespond(agent.id, item, "allow_once"))}
                className={itemClass}
              >
                <IconBox>
                  <ShieldCheck className="!text-ok" />
                </IconBox>
                <span className="min-w-0 flex-1 truncate">
                  Approve <span className="text-muted">· {item.title}</span>
                </span>
                <span className="truncate text-[11.5px] text-steel">{agent.title}</span>
              </Command.Item>,
              <Command.Item
                key={`${item.id}-deny`}
                value={`deny ${item.title} ${agent.title}`}
                keywords={["reject", "no", "permission"]}
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

        <Command.Group heading="Agents" className={groupClass}>
          {[...agents, ...archived].map((a, i) => (
            <Command.Item
              key={a.id}
              value={`agent ${a.title} ${a.id}`}
              keywords={[a.provider, basename(a.projectPath), a.branch ?? "", a.archived ? "archived" : ""]}
              onSelect={() => run(() => ui.openAgent(a.id))}
              className={itemClass}
            >
              <ProviderGlyph provider={a.provider} customAgentId={a.customAgentId} size="sm" />
              <span className="min-w-0 flex-1 truncate">
                {a.title}
                {a.archived && <span className="ml-2 text-[11px] text-steel">archived</span>}
              </span>
              <StatusDot status={a.status} size={6} />
              <span className="w-24 truncate text-right text-[11.5px] text-steel">{basename(a.projectPath)}</span>
              {i < 9 && !a.archived && (
                <span className="hidden gap-0.5 group-data-[selected=true]:flex">
                  <Kbd>{modKey}</Kbd>
                  <Kbd>{i + 1}</Kbd>
                </span>
              )}
            </Command.Item>
          ))}
        </Command.Group>

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
            icon={<LayoutGrid />}
            label="Go to Mission Control"
            shortcut={[modKey, "⇧", "M"]}
            onSelect={() => run(() => ui.setView("mission"))}
          />
          <PaletteAction
            icon={<Inbox />}
            label="Go to Inbox"
            shortcut={[modKey, "I"]}
            onSelect={() => run(() => ui.setView("inbox"))}
          />
          <PaletteAction icon={<Columns3 />} label="Go to Compare" onSelect={() => run(() => ui.openCompare(null))} />
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
            icon={<Settings />}
            label="Open Settings"
            shortcut={[modKey, ","]}
            onSelect={() => run(() => ui.openSettings())}
          />
          {current && (
            <>
              <PaletteAction
                icon={<Download />}
                label={`Export “${current.title}”…`}
                keywords={["export", "save", "markdown", "json", "transcript"]}
                onSelect={() => run(() => void exportConversation(current))}
              />
              <PaletteAction
                icon={<Radio />}
                label={`Share live view of “${current.title}”…`}
                keywords={["share", "remote", "link", "mobile"]}
                onSelect={() => run(() => ui.setShareAgent(current))}
              />
              {current.provider !== "custom" && (
                <PaletteAction
                  icon={<Repeat />}
                  label={`Move “${current.title}” to another account…`}
                  keywords={["switch", "account", "failover", "limit"]}
                  onSelect={() => run(() => ui.setMoveAgent(current))}
                />
              )}
            </>
          )}
          <PaletteAction
            icon={<CalendarClock />}
            label="Go to Schedules"
            keywords={["cron", "recurring", "timer"]}
            onSelect={() => run(() => ui.setView("schedules"))}
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

        {settings && (
          <Command.Group heading="Preferences" className={groupClass}>
            <PaletteAction
              icon={settings.sounds.enabled ? <VolumeX /> : <Volume2 />}
              label={settings.sounds.enabled ? "Mute sounds" : "Unmute sounds"}
              keywords={["sound", "audio"]}
              onSelect={() => run(() => patch({ sounds: { ...settings.sounds, enabled: !settings.sounds.enabled } }))}
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

        {hits.length > 0 && (
          <Command.Group heading="History" className={groupClass} forceMount>
            {hits.map((h) => {
              const a = agentsMap[h.agentId];
              return (
                <Command.Item
                  key={`${h.agentId}-${h.itemId}`}
                  value={`history ${h.itemId} ${debounced}`}
                  keywords={[debounced]}
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
        <span className="ml-auto">Type 2+ characters to search history</span>
      </div>
    </Command>
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
    <Command.Item value={label} keywords={keywords} onSelect={onSelect} className={itemClass}>
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
