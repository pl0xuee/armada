import {
  Bell,
  Bot,
  Boxes,
  FileText,
  Smartphone,
  FolderCog,
  Info,
  Search,
  Keyboard,
  Play,
  RefreshCw,
  Send,
  SlidersHorizontal,
  Volume2,
  Wallet,
  Mic,
  ExternalLink,
  Heart,
  Download,
  Sparkles,
  X,
} from "lucide-react";
import { m } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { toast } from "sonner";
import { AppMark } from "@/components/AppMark";
import { GithubGlyph } from "@/components/settings/GithubGlyph";
import { CompanionSection } from "@/components/settings/CompanionSection";
import { InstallAllBanner } from "@/components/settings/InstallAllBanner";
import { HelperSettings } from "@/components/settings/HelperSettings";
import { ResponseStyleSettings } from "@/components/settings/ResponseStyleSettings";
import { ModelGuideSettings } from "@/components/settings/ModelGuideSettings";
import { TokenSavingSettings } from "@/components/settings/TokenSavingSettings";
import { RememberedChoicesRow } from "@/components/settings/RememberedChoicesRow";
import { FAILOVER } from "@/components/accounts/FailoverRow";
import { AgentsSection } from "@/components/settings/AgentsSection";
import { AlertTargets } from "@/components/settings/AlertTargets";
import { BudgetsSection } from "@/components/settings/BudgetsSection";
import { CustomSoundLine } from "@/components/settings/CustomSound";
import { ToolsHub } from "@/components/toolkit/ToolsHub";
import { ProviderCard } from "@/components/settings/ProviderCard";
import { RemoteSection } from "@/components/settings/RemoteSection";
import { VoiceSection } from "@/components/settings/VoiceSection";
import { VoiceAssistantSection } from "@/components/settings/VoiceAssistantSection";
import { SectionHeader, SettingGroup, SettingRow } from "@/components/settings/SettingRow";
import { ToolsSection } from "@/components/settings/ToolsSection";
import { TemplatesSection } from "@/components/settings/TemplatesSection";
import { ThemeCard } from "@/components/settings/ThemeCard";
import {
  ANCHOR_OF,
  NAV_GROUPS,
  PAGE_LABEL,
  PAGE_OF,
  parseSection,
  searchSettings,
  type SettingsEntry,
  type SettingsPage,
} from "@/lib/settingsPages";
import { SYSTEM_THEME, THEMES } from "@/lib/themes";
import { useResolvedTheme } from "@/lib/useResolvedTheme";
import { Button } from "@/components/ui/button";
import { fieldClass, Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { CountBadge, Spinner } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { checkForUpdates, copyDiagnostics, saveDiagnosticsFile } from "@/lib/actions";
import { useGuardedInstall } from "@/components/settings/useGuardedInstall";
import { HotkeyRecorder } from "@/components/settings/HotkeyRecorder";
import { acceleratorCaps } from "@/components/settings/acceleratorLabels";
import { useCommitOnUnmount } from "@/components/settings/useCommitOnUnmount";
import { FieldError } from "@/components/settings/FieldError";
import { fieldErrorId, saveSettingsPatch, useFieldError } from "@/components/settings/settingsErrors";
import { api } from "@/lib/api";
import { relativeTimeLong } from "@/lib/format";
import { updateCount } from "@/lib/toolVersions";
import type { AttentionReason, Settings, SoundPack } from "@/lib/types";
import { cn, errorMessage, isMac, modKey, scrollBehavior } from "@/lib/utils";
import { MAX_SCALE, MIN_SCALE, DEFAULT_SCALE, SCALE_PRESETS, SCALE_STEP } from "@/lib/zoom";
import { useApp } from "@/store/app";
import { openTour } from "@/store/tour";
import { useToolkit } from "@/store/toolkit";
import { useUi } from "@/store/ui";

const ICON_OF: Record<SettingsPage, ComponentType<{ className?: string }>> = {
  appearance: SlidersHorizontal,
  keyboard: Keyboard,
  notifications: Bell,
  behavior: Bot,
  models: Wallet,
  providers: Boxes,
  projects: FolderCog,
  templates: FileText,
  remote: Smartphone,
  voice: Mic,
  about: Info,
};

/** Save a patch; validation errors land inline on their field, others as a toast. */
function save(patch: Partial<Settings>): Promise<boolean> {
  return saveSettingsPatch(patch, (message) => toast.error("Couldn't save settings", { description: message }));
}

export function SettingsView() {
  const section = useUi((s) => s.settingsSection);
  const openSettings = useUi((s) => s.openSettings);
  const settings = useApp((s) => s.settings);
  const page = PAGE_OF[section] ?? "appearance";
  // A spot a search result points to, further down its page (a fresh object each pick).
  const [jump, setJump] = useState<{ anchor?: string } | null>(null);

  // Dev/review convenience: ?view=settings&section=sounds
  useEffect(() => {
    try {
      const want = parseSection(new URLSearchParams(location.search).get("section"));
      if (want) openSettings(want);
    } catch {
      /* ignore */
    }
  }, [openSettings]);
  // Each page starts at the top, or at the heading an older section id or a search result points to.
  const scrollRef = useRef<HTMLDivElement>(null);
  const ready = !!settings;
  useEffect(() => {
    const anchor = jump ? jump.anchor : ANCHOR_OF[section];
    const el = anchor ? scrollRef.current?.querySelector<HTMLElement>(`[data-settings-anchor="${anchor}"]`) : null;
    if (el) el.scrollIntoView({ block: "start" });
    else scrollRef.current?.scrollTo({ top: 0 });
  }, [section, ready, jump]);
  if (!settings) return null;

  const select = (p: SettingsPage) => {
    setJump(null);
    openSettings(p);
  };
  const pick = (e: SettingsEntry) => {
    if (e.tab) useToolkit.getState().setTab(e.tab);
    openSettings(e.page);
    setJump({ anchor: e.anchor });
  };

  return (
    <div className="flex h-full max-[860px]:flex-col">
      <SettingsNav page={page} onSelect={select} onPick={pick} />

      <div ref={scrollRef} className="@container min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div key={page} className="view-enter mx-auto max-w-[720px] px-4 pb-16 pt-6 @md:px-6 @2xl:px-8 @2xl:pt-8">
          {page === "appearance" && <General settings={settings} />}
          {page === "keyboard" && <KeyboardPage settings={settings} />}
          {page === "notifications" && (
            <>
              <Notifications settings={settings} />
              <Part id="sounds">
                <Sounds settings={settings} />
              </Part>
            </>
          )}
          {page === "behavior" && <NewAgents settings={settings} />}
          {page === "models" && (
            <>
              <ModelsPage settings={settings} />
              <Part id="budgets">
                <BudgetsSection settings={settings} />
              </Part>
            </>
          )}
          {page === "providers" && (
            <>
              <Providers />
              <Part id="tools">
                <ToolsSection settings={settings} />
              </Part>
              <Part id="agents">
                <AgentsSection agents={settings.customAgents} />
              </Part>
            </>
          )}
          {page === "projects" && <ToolsHub servers={settings.mcpServers} />}
          {page === "templates" && <TemplatesSection templates={settings.templates} />}
          {page === "remote" && (
            <>
              <RemoteSection settings={settings} />
              <Part id="push">
                <PhonePush settings={settings} />
              </Part>
            </>
          )}
          {page === "voice" && (
            <>
              <VoiceSection settings={settings} />
              <Part id="assistant">
                <VoiceAssistantSection settings={settings} />
              </Part>
            </>
          )}
          {page === "about" && <About />}
        </div>
      </div>
    </div>
  );
}

/** A later part of a page that holds several: a divider, then its own heading. */
function Part({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div data-settings-anchor={id} className="mt-12 scroll-mt-6 border-t border-line pt-10">
      {children}
    </div>
  );
}

/** A spot partway down a page that the search can scroll to. */
function Spot({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div data-settings-anchor={id} className="scroll-mt-6">
      {children}
    </div>
  );
}

/**
 * Section navigation: a grouped sidebar on wide windows, a horizontally scrolling pill strip
 * below 860px (tiling window managers routinely give us narrow tiles). A search box on top finds
 * any setting by name and jumps to it.
 */
function SettingsNav({
  page,
  onSelect,
  onPick,
}: {
  page: SettingsPage;
  onSelect: (p: SettingsPage) => void;
  onPick: (e: SettingsEntry) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const updates = useApp((s) => updateCount(s.providers));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchSettings(query), [query]);
  const searching = query.trim() !== "";
  useEffect(() => setActive(0), [query]);

  // Keep the active pill in view on the narrow strip (scroll only the strip itself).
  useEffect(() => {
    const strip = stripRef.current;
    const el = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !el || strip.scrollWidth <= strip.clientWidth) return;
    const target = el.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2;
    strip.scrollTo({ left: Math.max(0, target), behavior: scrollBehavior() });
  }, [page, searching]);

  const choose = (e: SettingsEntry | undefined) => {
    if (!e) return;
    setQuery("");
    onPick(e);
  };

  return (
    <nav
      aria-label="Settings sections"
      className={cn(
        "flex w-[208px] shrink-0 flex-col border-r border-line bg-panel/50 px-2.5 pb-3 pt-7 min-[861px]:min-h-0 min-[861px]:overflow-y-auto",
        "max-[860px]:w-full max-[860px]:border-b max-[860px]:border-r-0 max-[860px]:px-0 max-[860px]:pt-4",
      )}
    >
      <h1 className="mb-3 px-2.5 text-[20px] font-semibold tracking-[-0.02em] max-[860px]:mb-2.5 max-[860px]:px-4 max-[860px]:text-[18px]">
        Settings
      </h1>
      <div className="relative mb-3 max-[860px]:mx-3 max-[860px]:mb-2.5">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-steel" />
        <Input
          type="search"
          aria-label="Search settings"
          placeholder="Search settings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const n = results.length;
              if (n) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(results[active]);
            } else if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
          aria-controls={searching ? "settings-search-results" : undefined}
          aria-activedescendant={searching && results[active] ? `settings-result-${active}` : undefined}
          className="h-8 pl-8 text-caption"
        />
      </div>
      {searching ? (
        <div
          id="settings-search-results"
          role="listbox"
          aria-label="Matching settings"
          className="flex flex-col gap-0.5 max-[860px]:px-3 max-[860px]:pb-2.5"
        >
          {results.length === 0 && <p className="px-2.5 py-1.5 text-caption text-steel">No setting matches.</p>}
          {results.map((r, i) => (
            <button
              key={`${r.page}:${r.label}`}
              id={`settings-result-${i}`}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(r)}
              className={cn(
                "flex flex-col items-start rounded-lg px-2.5 py-1.5 text-left transition-colors",
                i === active ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg",
              )}
            >
              <span className="text-body leading-[20px]">{r.label}</span>
              <span className="text-meta leading-[16px] text-steel">{PAGE_LABEL[r.page]}</span>
            </button>
          ))}
        </div>
      ) : (
        <div
          ref={stripRef}
          className={cn(
            "flex flex-col",
            "max-[860px]:flex-row max-[860px]:gap-1 max-[860px]:overflow-x-auto max-[860px]:px-3 max-[860px]:pb-2.5",
            "max-[860px]:[scrollbar-width:none] max-[860px]:[&::-webkit-scrollbar]:hidden",
            "max-[860px]:[mask-image:linear-gradient(to_right,transparent,black_14px,black_calc(100%-14px),transparent)]",
          )}
        >
          {NAV_GROUPS.map((g, gi) => (
            <div
              key={g.title ?? "more"}
              role="group"
              aria-label={g.title ?? undefined}
              className={cn(
                "flex flex-col gap-0.5 max-[860px]:contents",
                gi > 0 && (g.title ? "mt-4" : "mt-4 border-t border-line pt-3"),
              )}
            >
              {g.title && (
                <h2 className="px-2.5 pb-1 text-micro font-medium uppercase tracking-[0.06em] text-steel max-[860px]:hidden">
                  {g.title}
                </h2>
              )}
              {g.pages.map((id) => {
                const isActive = id === page;
                const Icon = ICON_OF[id];
                return (
                  <button
                    key={id}
                    type="button"
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => onSelect(id)}
                    className={cn(
                      "relative flex h-8 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 text-body transition-colors",
                      "max-[860px]:h-8 max-[860px]:gap-2 max-[860px]:rounded-full max-[860px]:px-3",
                      isActive ? "text-fg" : "text-muted hover:bg-raised/60 hover:text-fg",
                    )}
                  >
                    {isActive && (
                      <m.span
                        layoutId="settings-nav"
                        transition={{ type: "spring", stiffness: 520, damping: 40 }}
                        className="absolute inset-0 rounded-[inherit] border border-line-strong bg-raised edge"
                      />
                    )}
                    <Icon className={cn("relative h-4 w-4", isActive ? "text-accent" : "text-steel")} />
                    <span className="relative">{PAGE_LABEL[id]}</span>
                    {id === "providers" && updates > 0 && (
                      <CountBadge count={updates} className="relative ml-auto shadow-none max-[860px]:ml-0" />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </nav>
  );
}

// ---------------------------------------------------------------- Appearance

/** Settings → General: the look, the window and updates. */
function General({ settings }: { settings: Settings }) {
  return (
    <>
      <Appearance settings={settings} />
      <div className="mt-8 space-y-6">
        <Spot id="window">
          <SettingGroup title="Window and startup">
            <SettingRow
              title="Close to tray"
              description="Closing the window keeps agents running and Kvistcode in the tray."
              htmlFor="b-tray"
            >
              <Switch id="b-tray" checked={settings.closeToTray} onCheckedChange={toggle("closeToTray")} />
            </SettingRow>
            <SettingRow
              title="Launch at login"
              description="Start Kvistcode quietly in the tray when you sign in."
              htmlFor="b-login"
            >
              <Switch id="b-login" checked={settings.launchAtLogin} onCheckedChange={toggle("launchAtLogin")} />
            </SettingRow>
          </SettingGroup>
        </Spot>
        <Spot id="updates">
          <UpdatesGroup settings={settings} />
        </Spot>
      </div>
    </>
  );
}

function Appearance({ settings }: { settings: Settings }) {
  // Zoom applies on release: resizing the UI under the dragged thumb would make it jump.
  const [dragScale, setDragScale] = useState<number | null>(null);
  const shownScale = dragScale ?? settings.interfaceScale;
  const followSystem = settings.theme === SYSTEM_THEME;
  const shown = useResolvedTheme(settings.theme);
  return (
    <>
      <SectionHeader title="General" description="How Kvistcode looks, starts and updates." />
      <SettingGroup className="mb-3">
        <SettingRow
          title="Match system"
          description={
            followSystem
              ? `Following your computer's light or dark setting. Now showing ${THEMES.find((t) => t.id === shown)?.name}.`
              : "Switch between a dark and a light theme with your computer's setting."
          }
          htmlFor="theme-system"
        >
          <Switch
            id="theme-system"
            checked={followSystem}
            onCheckedChange={(v) => void save({ theme: v ? SYSTEM_THEME : shown })}
          />
        </SettingRow>
      </SettingGroup>
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-1 gap-3 @md:grid-cols-3">
        {THEMES.map((t) => (
          <ThemeCard
            key={t.id}
            id={t.id}
            active={!followSystem && settings.theme === t.id}
            onSelect={() => void save({ theme: t.id })}
          />
        ))}
      </div>
      <SettingGroup className="mt-5">
        <SettingRow
          title="Interface scale"
          description={`Make the whole interface bigger or smaller. Shortcuts: ${modKey} + and ${modKey} - to change it, ${modKey} 0 to reset.`}
          stack
        >
          <div className="flex w-full flex-wrap items-center gap-3">
            <Slider
              aria-label="Interface scale"
              className="min-w-[140px] flex-1"
              value={shownScale}
              min={MIN_SCALE}
              max={MAX_SCALE}
              step={SCALE_STEP}
              onValueChange={setDragScale}
              onValueCommit={(v) => {
                setDragScale(null);
                void save({ interfaceScale: v });
              }}
            />
            <span className="w-12 text-right font-mono text-caption tabular-nums text-fg">{shownScale}%</span>
            <Segmented
              size="sm"
              aria-label="Scale presets"
              value={String(settings.interfaceScale)}
              onChange={(v) => void save({ interfaceScale: Number(v) })}
              options={SCALE_PRESETS.map((p) => ({ value: String(p), label: `${p}%` }))}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={settings.interfaceScale === DEFAULT_SCALE}
              onClick={() => void save({ interfaceScale: DEFAULT_SCALE })}
            >
              Reset
            </Button>
          </div>
        </SettingRow>
      </SettingGroup>
      <p className="mt-4 text-caption text-steel">
        Animations follow your system's reduce-motion setting automatically.
      </p>
    </>
  );
}

// ---------------------------------------------------------------- Sounds

const SOUND_EVENTS: {
  key: "onPermission" | "onDone" | "onError";
  custom: "customPermission" | "customDone" | "customError";
  reason: AttentionReason;
  title: string;
  description: string;
}[] = [
  {
    key: "onPermission",
    custom: "customPermission",
    reason: "permission",
    title: "Needs approval",
    description: "When an agent is waiting for your decision",
  },
  {
    key: "onDone",
    custom: "customDone",
    reason: "done",
    title: "Agent finished",
    description: "When an agent has finished its work",
  },
  {
    key: "onError",
    custom: "customError",
    reason: "error",
    title: "Error or rate limit",
    description: "When something fails or a rate limit is hit",
  },
];

const SOUND_PACKS: { value: SoundPack; label: string; description: string }[] = [
  { value: "soft", label: "Soft", description: "Warm mallet tones, calm and short." },
  { value: "glass", label: "Glass", description: "Brighter bell and crystal tones with a longer shimmer." },
  { value: "classic", label: "Classic", description: "The original plain tones." },
];

function PreviewButton({ reason, disabled }: { reason: AttentionReason; disabled?: boolean }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={disabled}
      aria-label={`Preview ${reason} sound`}
      onClick={() =>
        api.previewSound(reason).catch((e) => toast.error("Couldn't play sound", { description: errorMessage(e) }))
      }
    >
      <Play /> Preview
    </Button>
  );
}

function Sounds({ settings }: { settings: Settings }) {
  const s = settings.sounds;
  const [volume, setVolume] = useState(s.volume);
  useEffect(() => setVolume(s.volume), [s.volume]);

  const choosePack = async (pack: SoundPack) => {
    if (pack === s.pack) return;
    const saved = await save({ sounds: { ...s, pack } });
    // Play "finished" in the new pack so the difference is audible right away (unless the
    // user has their own file for it, which would play instead).
    if (saved && s.enabled && !s.customDone?.trim()) {
      api.previewSound("done").catch((e) => toast.error("Couldn't play sound", { description: errorMessage(e) }));
    }
  };

  return (
    <>
      <SectionHeader title="Sounds" description="Audio cues play even when Kvistcode is in the tray." />
      <div className="space-y-6">
        <SettingGroup>
          <SettingRow
            title="Sound pack"
            description={SOUND_PACKS.find((p) => p.value === s.pack)?.description}
            htmlFor="snd-pack"
          >
            <Select
              id="snd-pack"
              aria-label="Sound pack"
              className="h-8 w-[160px]"
              value={s.pack}
              disabled={!s.enabled}
              onValueChange={(v) => void choosePack(v as SoundPack)}
              options={SOUND_PACKS}
            />
          </SettingRow>
          <SettingRow title="Play sounds" description="Master switch for all audio cues." htmlFor="snd-enabled">
            <Switch
              id="snd-enabled"
              checked={s.enabled}
              onCheckedChange={(v) => void save({ sounds: { ...s, enabled: v } })}
            />
          </SettingRow>
          <SettingRow title="Volume" description="Relative to your system volume.">
            <div className="flex w-[220px] items-center gap-3">
              <Volume2 className="h-4 w-4 shrink-0 text-steel" />
              <Slider
                aria-label="Volume"
                value={volume}
                disabled={!s.enabled}
                onValueChange={setVolume}
                onValueCommit={(v) => void save({ sounds: { ...s, volume: v } })}
              />
              <span className="w-9 text-right text-caption text-muted tabular">{Math.round(volume * 100)}%</span>
            </div>
          </SettingRow>
        </SettingGroup>

        <SettingGroup
          title="Events"
          description="Use the pack's sounds or your own .wav, .ogg, .mp3 or .flac files. Preview plays whichever is saved."
        >
          {SOUND_EVENTS.map((ev) => (
            <SettingRow
              key={ev.key}
              title={ev.title}
              description={
                <>
                  {ev.description}
                  <CustomSoundLine
                    path={s[ev.custom]}
                    disabled={!s.enabled}
                    eventLabel={ev.title}
                    onChange={(path) => {
                      const cur = useApp.getState().settings;
                      return cur
                        ? save({ sounds: { ...cur.sounds, [ev.custom]: path } }).then(() => {})
                        : Promise.resolve();
                    }}
                  />
                </>
              }
              htmlFor={`snd-${ev.key}`}
            >
              <PreviewButton reason={ev.reason} disabled={!s.enabled} />
              <Switch
                id={`snd-${ev.key}`}
                checked={s[ev.key]}
                disabled={!s.enabled}
                onCheckedChange={(v) => void save({ sounds: { ...s, [ev.key]: v } })}
              />
            </SettingRow>
          ))}
        </SettingGroup>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Notifications

function Notifications({ settings }: { settings: Settings }) {
  const n = settings.notifications;
  const q = settings.quietHours;
  // Time inputs commit on blur, and only complete HH:MM values (no half-typed saves).
  const [qStart, setQStart] = useState(q.start);
  const [qEnd, setQEnd] = useState(q.end);
  // While a rejected value is shown with its backend error, don't overwrite it on rollback.
  const keepQuiet = useRef(false);
  useEffect(() => {
    if (!keepQuiet.current) setQStart(q.start);
  }, [q.start]);
  useEffect(() => {
    if (!keepQuiet.current) setQEnd(q.end);
  }, [q.end]);
  const [quietError, setQuietError] = useState<string | null>(null);
  const commitQuiet = (key: "start" | "end", value: string) => {
    const cur = useApp.getState().settings?.quietHours;
    if (!cur) return;
    const snapBack = () => (key === "start" ? setQStart(cur.start) : setQEnd(cur.end));
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      // Invalid or cleared: snap back to the saved value.
      snapBack();
      return;
    }
    const other = key === "start" ? cur.end : cur.start;
    if (value === other) {
      setQuietError("Start and end can't be the same time.");
      snapBack();
      return;
    }
    setQuietError(null);
    if (cur[key] === value) return;
    keepQuiet.current = true;
    void save({ quietHours: { ...cur, [key]: value } }).then((ok) => {
      setTimeout(() => (keepQuiet.current = !ok), 0);
    });
  };
  // Switching sections/views by shortcut skips the blur: commit pending edits on unmount.
  useCommitOnUnmount(() => {
    if (qStart !== q.start) commitQuiet("start", qStart);
    if (qEnd !== q.end) commitQuiet("end", qEnd);
  });

  return (
    <>
      <SectionHeader
        title="Notifications"
        description="Get pinged when an agent needs you, and stay quiet otherwise."
        right={
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              api
                .testNotification()
                .then(() => toast("Test notification sent"))
                .catch((e) => toast.error("Couldn't send test", { description: errorMessage(e) }))
            }
          >
            <Send /> Send test
          </Button>
        }
      />
      <div className="space-y-6">
        <SettingGroup>
          <SettingRow
            title="Desktop notifications"
            description="Uses your OS notification center."
            htmlFor="ntf-enabled"
          >
            <Switch
              id="ntf-enabled"
              checked={n.enabled}
              onCheckedChange={(v) => void save({ notifications: { ...n, enabled: v } })}
            />
          </SettingRow>
          {SOUND_EVENTS.map((ev) => (
            <SettingRow key={ev.key} title={ev.title} htmlFor={`ntf-${ev.key}`} className="py-3 pl-8">
              <Switch
                id={`ntf-${ev.key}`}
                checked={n[ev.key]}
                disabled={!n.enabled}
                onCheckedChange={(v) => void save({ notifications: { ...n, [ev.key]: v } })}
              />
            </SettingRow>
          ))}
          <SettingRow
            title="Smart mute"
            description="Skip the sound and notification when you're already looking at that agent."
            htmlFor="ntf-smart"
          >
            <Switch
              id="ntf-smart"
              checked={n.smartMute}
              onCheckedChange={(v) => void save({ notifications: { ...n, smartMute: v } })}
            />
          </SettingRow>
          <SettingRow
            title="Chime when the agent I'm watching finishes a long task"
            description="A soft sound for turns longer than 30 seconds, even with smart mute on. Needs sounds enabled."
            htmlFor="ntf-chime"
          >
            <Switch
              id="ntf-chime"
              checked={settings.sounds.chimeWhenWatching}
              disabled={!settings.sounds.enabled}
              onCheckedChange={(v) => void save({ sounds: { ...settings.sounds, chimeWhenWatching: v } })}
            />
          </SettingRow>
        </SettingGroup>

        <Spot id="reminders">
          <SettingGroup title="Reminders">
            <SettingRow title="Re-ping pending approvals" description="If an approval waits this long, ping once more.">
              <Select
                aria-label="Re-ping pending approvals"
                className="h-8 w-[140px]"
                value={String(settings.escalateAfterMins)}
                onValueChange={(v) => void save({ escalateAfterMins: Number(v) })}
                options={ESCALATE_OPTIONS.map((m) => ({
                  value: String(m),
                  label: m === 0 ? "Never" : `After ${m} min`,
                }))}
              />
            </SettingRow>
          </SettingGroup>
        </Spot>

        <Spot id="quiet-hours">
          <SettingGroup title="Quiet hours" description="Notifications and sounds are held during this window.">
            <SettingRow title="Enable quiet hours" htmlFor="qh-enabled">
              <Switch
                id="qh-enabled"
                checked={q.enabled}
                onCheckedChange={(v) => void save({ quietHours: { ...q, enabled: v } })}
              />
            </SettingRow>
            <SettingRow
              title="Schedule"
              description={
                quietError ? (
                  <span role="alert" className="text-err">
                    {quietError}
                  </span>
                ) : (
                  "Overnight windows (e.g. 22:00 to 08:00) are supported."
                )
              }
            >
              <input
                type="time"
                aria-label="Quiet hours start"
                value={qStart}
                disabled={!q.enabled}
                onChange={(e) => setQStart(e.target.value)}
                onBlur={(e) => commitQuiet("start", e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
                className={cn(fieldClass, "h-8 w-[128px] tabular [color-scheme:inherit]")}
              />
              <span className="text-caption text-steel">to</span>
              <input
                type="time"
                aria-label="Quiet hours end"
                value={qEnd}
                disabled={!q.enabled}
                onChange={(e) => setQEnd(e.target.value)}
                onBlur={(e) => commitQuiet("end", e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
                className={cn(fieldClass, "h-8 w-[128px] tabular [color-scheme:inherit]")}
              />
              <div className="basis-full">
                <FieldError field="quietHours" />
              </div>
            </SettingRow>
          </SettingGroup>
        </Spot>

        <Spot id="webhooks">
          <AlertTargets targets={settings.alertTargets} />
        </Spot>
      </div>
    </>
  );
}

/** Settings → Phone & remote: forwards attention events to a phone with ntfy. */
function PhonePush({ settings }: { settings: Settings }) {
  const keepNtfy = useRef(false);
  // The field keeps what the user typed even when the backend rejects it (so they can fix it).
  const [ntfy, setNtfy] = useState(settings.ntfyUrl ?? "");
  useEffect(() => {
    if (!keepNtfy.current) setNtfy(settings.ntfyUrl ?? "");
  }, [settings.ntfyUrl]);
  const ntfyValid = ntfy.trim() === "" || /^https?:\/\/\S+$/i.test(ntfy.trim());
  const ntfyError = useFieldError("ntfy");
  const [push, setPush] = useState<{ state: "idle" | "sending" | "sent" } | { state: "error"; message: string }>({
    state: "idle",
  });
  const sendTestPush = async () => {
    const url = ntfy.trim();
    if (!url || !ntfyValid) return;
    setPush({ state: "sending" });
    try {
      await api.testNotification(url);
      setPush({ state: "sent" });
    } catch (e) {
      setPush({ state: "error", message: errorMessage(e) });
    }
  };
  useEffect(() => setPush({ state: "idle" }), [ntfy]);

  const commitNtfy = () => {
    const v = ntfy.trim();
    if (!ntfyValid) return;
    if ((settings.ntfyUrl ?? "") === v) return;
    keepNtfy.current = true;
    void save({ ntfyUrl: v || null }).then((ok) => {
      setTimeout(() => (keepNtfy.current = !ok), 0);
    });
  };
  // Switching sections/views by shortcut skips the blur: commit a pending edit on unmount.
  useCommitOnUnmount(commitNtfy);

  return (
    <SettingGroup
      title="Phone push"
      description="Optional. Get a push on your phone when an agent needs you, with the free ntfy app. Works without pairing."
    >
      <SettingRow
        stack
        title="ntfy topic URL"
        description={
          <>Install the ntfy app, subscribe to a hard-to-guess topic, and paste its URL. Leave empty to disable.</>
        }
        htmlFor="ntfy-url"
      >
        <div className="w-full">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="ntfy-url"
              value={ntfy}
              placeholder="https://ntfy.sh/kvistcode-7f3k2"
              onChange={(e) => setNtfy(e.target.value)}
              onBlur={commitNtfy}
              onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
              aria-invalid={!ntfyValid || !!ntfyError}
              aria-describedby={ntfyError ? fieldErrorId("ntfy") : undefined}
              className={cn(
                "min-w-0 flex-1 basis-[260px] font-mono text-small",
                (!ntfyValid || ntfyError) && "border-err/60 focus:border-err/60 focus:ring-err/15",
              )}
            />
            <Button
              size="sm"
              variant="secondary"
              className="h-9"
              disabled={!ntfy.trim() || !ntfyValid || push.state === "sending"}
              title={!ntfy.trim() ? "Enter a topic URL first" : "Show a test notification and push it to this URL"}
              onClick={() => void sendTestPush()}
            >
              {push.state === "sending" ? <Spinner className="h-3.5 w-3.5" /> : <Send />}
              Send test push
            </Button>
          </div>
          {!ntfyValid && <p className="mt-1.5 text-meta text-err">Enter a full http(s) URL.</p>}
          <FieldError field="ntfy" />
          {push.state === "sent" && (
            <p role="status" className="mt-1.5 text-meta text-ok">
              Sent. Check your phone.
            </p>
          )}
          {push.state === "error" && (
            <p role="alert" className="mt-1.5 break-words text-meta text-err">
              {push.message}
            </p>
          )}
        </div>
      </SettingRow>
      <SettingRow
        stack
        title="Push detail"
        description={
          <>
            {settings.ntfyDetail === "full"
              ? "Pushes include the agent's last message or the command awaiting approval, with secrets scrubbed. "
              : "Pushes only say which agent needs you and why. "}
            The topic name is a shared secret: anyone who knows it can read your pushes, and the ntfy server sees them.
          </>
        }
      >
        <Segmented
          aria-label="Push detail"
          value={settings.ntfyDetail}
          onChange={(v) => void save({ ntfyDetail: v })}
          className="w-full"
          options={[
            { value: "minimal", label: "Minimal" },
            { value: "full", label: "Full text" },
          ]}
        />
      </SettingRow>
    </SettingGroup>
  );
}

// ---------------------------------------------------------------- Behavior

const ESCALATE_OPTIONS = [0, 2, 5, 10, 15, 30];

const PERMISSION_MODES: {
  value: Settings["defaultPermissionMode"];
  label: string;
  description: string;
}[] = [
  {
    value: "auto",
    label: "Auto",
    description:
      "New agents start in their Auto mode: Claude decides when to ask you, Codex works freely inside its sandbox. Change it per agent from the composer.",
  },
  {
    value: "ask",
    label: "Ask before acting",
    description: "New agents start in their default mode and ask before edits and commands.",
  },
];

/** The global hotkey: record a shortcut, or type one. The backend refuses ones it can't register. */
function HotkeyRow({ settings }: { settings: Settings }) {
  const [hotkey, setHotkey] = useState(settings.globalHotkey);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const [hotkeySaving, setHotkeySaving] = useState(false);
  const hotkeyCaps = acceleratorCaps(hotkey, isMac);
  // After a failed save the store rolls back; keep the user's text (and the error) instead.
  const holdHotkey = useRef(false);
  useEffect(() => {
    if (!holdHotkey.current) setHotkey(settings.globalHotkey);
  }, [settings.globalHotkey]);

  const commitHotkey = async (raw: string) => {
    const v = raw.trim();
    if (v === (useApp.getState().settings?.globalHotkey ?? "")) {
      holdHotkey.current = false;
      setHotkeyError(null);
      setHotkey(v);
      return;
    }
    holdHotkey.current = true;
    setHotkeySaving(true);
    try {
      await useApp.getState().patchSettings({ globalHotkey: v });
      holdHotkey.current = false;
      setHotkeyError(null);
    } catch (e) {
      // The backend refuses accelerators it can't register (taken, or malformed).
      setHotkeyError(errorMessage(e));
      setHotkey(v);
    } finally {
      setHotkeySaving(false);
    }
  };

  useCommitOnUnmount(() => {
    if (hotkey.trim() !== (useApp.getState().settings?.globalHotkey ?? "") && !hotkeySaving) void commitHotkey(hotkey);
  });

  return (
    <SettingRow
      title="Global hotkey"
      description="Bring Kvistcode forward from anywhere. Record a shortcut, or leave it empty to turn it off."
      htmlFor="b-hotkey"
    >
      <div className="w-[240px] max-w-full">
        <div className="relative">
          <Input
            id="b-hotkey"
            value={hotkey}
            placeholder="Disabled"
            onChange={(e) => setHotkey(e.target.value)}
            onBlur={() => void commitHotkey(hotkey)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
              if (e.key === "Escape" && hotkeyError === null) setHotkey(settings.globalHotkey);
            }}
            aria-invalid={hotkeyError !== null}
            aria-describedby={hotkeyError ? "b-hotkey-error" : undefined}
            className={cn(
              "peer h-8 pr-8 font-mono text-caption",
              // The caps below stand in for the raw text until you edit it.
              hotkeyCaps.length > 0 && !hotkeyError && "text-transparent focus:text-fg",
              hotkeyError && "border-err/60 focus:border-err/60 focus:ring-err/15",
            )}
            spellCheck={false}
          />
          {hotkeyCaps.length > 0 && !hotkeyError && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-2.5 right-8 flex items-center gap-1 overflow-hidden peer-focus:hidden"
            >
              {hotkeyCaps.map((c, i) => (
                <Kbd key={`${c}${i}`}>{c}</Kbd>
              ))}
            </span>
          )}
          {hotkeySaving ? (
            <Spinner className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
          ) : (
            hotkey && (
              <button
                type="button"
                aria-label="Clear hotkey (disable)"
                title="Clear (disable)"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setHotkey("");
                  void commitHotkey("");
                }}
                className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-steel transition-colors hover:bg-raised hover:text-fg"
              >
                <X className="h-3 w-3" />
              </button>
            )
          )}
        </div>
        <div className="mt-1.5">
          <HotkeyRecorder
            disabled={hotkeySaving}
            onRecord={(acc) => {
              setHotkey(acc);
              void commitHotkey(acc);
            }}
          />
        </div>
        {hotkeyError && (
          <p id="b-hotkey-error" role="alert" className="mt-1.5 text-meta leading-snug text-err">
            {hotkeyError}
          </p>
        )}
      </div>
    </SettingRow>
  );
}

const toggle =
  (key: "closeToTray" | "autoResume" | "resumeAfterLimit" | "defaultWorktree" | "launchAtLogin") => (v: boolean) =>
    void save({ [key]: v } as Partial<Settings>);

/** Settings → Keyboard: the global hotkey, one-letter keys and the shortcut list. */
function KeyboardPage({ settings }: { settings: Settings }) {
  return (
    <>
      <SectionHeader title="Keyboard" description="Get around Kvistcode without the mouse." />
      <div className="space-y-6">
        <SettingGroup>
          <HotkeyRow settings={settings} />
          <SettingRow
            title="One-letter shortcuts"
            description="A, Y, D and N answer an approval, number keys pick an answer to a pinned question, and J, K and E step through Needs you. Turn off if a stray key press could answer by mistake."
            htmlFor="single-keys"
          >
            <Switch
              id="single-keys"
              checked={settings.singleKeyShortcuts}
              onCheckedChange={(v) => void save({ singleKeyShortcuts: v })}
            />
          </SettingRow>
          <SettingRow
            title="Talk to the voice assistant"
            description="Its hotkey is set with the rest of the voice assistant."
          >
            <Button size="sm" variant="ghost" onClick={() => useUi.getState().openSettings("assistant")}>
              Open Voice
            </Button>
          </SettingRow>
        </SettingGroup>
        <Spot id="shortcuts">
          <SettingGroup title="Shortcuts">
            {SHORTCUTS.map((s) => (
              <div key={s.label} className="flex items-center justify-between px-4 py-2.5">
                <span className="text-body text-muted">{s.label}</span>
                <span className="flex gap-1">
                  {s.keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </div>
            ))}
          </SettingGroup>
        </Spot>
      </div>
    </>
  );
}

/** Settings → New agents: how agents start, reply and get help. */
function NewAgents({ settings }: { settings: Settings }) {
  return (
    <>
      <SectionHeader
        title="New agents"
        description="How new agents start, how they reply, and who helps when they are busy."
      />
      <div className="space-y-6">
        <SettingGroup title="Starting">
          <SettingRow
            stack
            title="Permission mode for new agents"
            description={PERMISSION_MODES.find((m) => m.value === settings.defaultPermissionMode)?.description}
          >
            <Segmented
              aria-label="Permission mode for new agents"
              value={settings.defaultPermissionMode}
              onChange={(v) => void save({ defaultPermissionMode: v })}
              className="w-full"
              options={PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label }))}
            />
            <FieldError field="permissionMode" />
          </SettingRow>
          <RememberedChoicesRow />
          <SettingRow
            title="Auto-resume interrupted agents"
            description="When Kvistcode starts, agents cut off by a crash or reboot pick up where they left off."
            htmlFor="b-resume"
          >
            <Switch id="b-resume" checked={settings.autoResume} onCheckedChange={toggle("autoResume")} />
          </SettingRow>
          <SettingRow
            title="Use a git worktree by default"
            description="Each new agent gets its own branch and folder, so agents never trample each other."
            htmlFor="b-worktree"
          >
            <Switch id="b-worktree" checked={settings.defaultWorktree} onCheckedChange={toggle("defaultWorktree")} />
          </SettingRow>
        </SettingGroup>
        <Spot id="replies">
          <ResponseStyleSettings settings={settings} />
        </Spot>
        <Spot id="helpers">
          <HelperSettings settings={settings} />
        </Spot>
      </div>
    </>
  );
}

/** Settings → Models & spending: models, token saving, rate limits (budgets follow on the page). */
function ModelsPage({ settings }: { settings: Settings }) {
  return (
    <>
      <SectionHeader
        title="Models & spending"
        description="Which models your agents use, how to spend fewer tokens, and what happens at a limit."
      />
      <div className="space-y-6">
        <ModelGuideSettings settings={settings} />
        <Spot id="save-tokens">
          <TokenSavingSettings settings={settings} />
        </Spot>
        <Spot id="rate-limits">
          <SettingGroup title="Rate limits">
            <SettingRow
              stack
              title="When an account hits its rate limit"
              description={FAILOVER.find((f) => f.value === settings.failover)?.description}
            >
              <Segmented
                aria-label="When an account hits its rate limit"
                value={settings.failover}
                onChange={(v) => void save({ failover: v })}
                className="w-full"
                options={FAILOVER.map((f) => ({ value: f.value, label: f.label }))}
              />
              <FieldError field="failover" />
            </SettingRow>
            <SettingRow
              title="Resume agents automatically when a rate limit resets"
              description="Agents a limit stopped continue by themselves shortly after it resets, a few at a time. Never one you stopped or touched."
              htmlFor="b-limit-resume"
            >
              <Switch
                id="b-limit-resume"
                checked={settings.resumeAfterLimit ?? true}
                onCheckedChange={toggle("resumeAfterLimit")}
              />
            </SettingRow>
          </SettingGroup>
        </Spot>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Providers

function Providers() {
  const providers = useApp((s) => s.providers);
  const [detecting, setDetecting] = useState(false);
  const [detectedAt, setDetectedAt] = useState<number | null>(null);

  const detect = async () => {
    setDetecting(true);
    try {
      const list = await api.detectProviders();
      useApp.getState().setProviders(list);
      setDetectedAt(Date.now());
    } catch (e) {
      toast.error("Detection failed", { description: errorMessage(e) });
    } finally {
      setDetecting(false);
    }
  };

  return (
    <>
      <SectionHeader
        title="Providers"
        description={
          detectedAt
            ? `Agent CLIs found on this machine · detected ${relativeTimeLong(detectedAt)}`
            : "Kvistcode drives each vendor's official agent CLI."
        }
        right={
          <Button size="sm" variant="secondary" onClick={detect} disabled={detecting}>
            <RefreshCw className={cn(detecting && "animate-spin")} /> Re-detect
          </Button>
        }
      />
      <InstallAllBanner providers={providers} className="mb-4" />
      <div className="space-y-3">
        {providers.map((p) => (
          <ProviderCard key={p.provider} info={p} />
        ))}
      </div>
      <CompanionSection className="mt-10" />
    </>
  );
}

// ---------------------------------------------------------------- About

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: [modKey, "K"], label: "Command palette" },
  { keys: [modKey, "N"], label: "New agent" },
  { keys: [modKey, "1–9"], label: "Jump to agent" },
  { keys: [modKey, "J"], label: "Needs you" },
  { keys: [modKey, "⇧", "M"], label: "Mission Control: All agents" },
  { keys: [modKey, ","], label: "Settings" },
  { keys: [modKey, "/"], label: "All shortcuts" },
  { keys: ["Esc"], label: "Close / cancel turn" },
];

/** Kvistcode's own updates: what's available, a manual check, and the automatic one. */
function UpdatesGroup({ settings }: { settings: Settings }) {
  const version = useApp((s) => s.version);
  const update = useApp((s) => s.update);
  const progress = useApp((s) => s.updateProgress);
  const [checking, setChecking] = useState(false);
  const guardedInstall = useGuardedInstall();

  const check = async () => {
    setChecking(true);
    await checkForUpdates();
    setChecking(false);
  };

  const pct = progress?.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;

  return (
    <>
      {guardedInstall.dialog}
      <SettingGroup title="Updates">
        {update && (
          <div className="flex items-center gap-3 bg-accent/[0.06] px-4 py-3.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent">
              <Sparkles className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-body font-medium text-fg">Kvistcode {update.version} is available</p>
              {progress ? (
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="h-1 w-40 overflow-hidden rounded-full bg-raised">
                    {pct === null ? (
                      <div className="shimmer-bar h-full w-full" />
                    ) : (
                      <div
                        className="h-full rounded-full bg-accent transition-[width] duration-200"
                        style={{ width: `${pct}%` }}
                      />
                    )}
                  </div>
                  <span className="text-meta text-muted tabular">{pct === null ? "Downloading…" : `${pct}%`}</span>
                </div>
              ) : (
                <p className="text-caption text-muted">
                  You have {update.currentVersion}
                  {update.date ? ` · released ${new Date(update.date).toLocaleDateString()}` : ""}
                  {" · "}
                  <a href={update.url} rel="noreferrer noopener" className="text-accent hover:underline">
                    Release notes
                  </a>
                </p>
              )}
            </div>
            <Button size="sm" variant="primary" disabled={progress !== null} onClick={guardedInstall.request}>
              {update.canInstall ? (
                <>
                  <Download /> Install & restart
                </>
              ) : (
                <>
                  <ExternalLink /> Download
                </>
              )}
            </Button>
          </div>
        )}
        <SettingRow
          title={`Version ${version || "dev"}`}
          description={update ? "A newer version is ready." : "Updates are signed and installed in place."}
        >
          <Button size="sm" variant="secondary" onClick={check} disabled={checking}>
            <RefreshCw className={cn(checking && "animate-spin")} /> Check for updates
          </Button>
        </SettingRow>
        <SettingRow
          title="Automatically check for updates"
          description="Checks on launch and every few hours."
          htmlFor="auto-upd"
        >
          <Switch
            id="auto-upd"
            checked={settings.autoCheckUpdates}
            onCheckedChange={(v) => void save({ autoCheckUpdates: v })}
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}

function About() {
  const version = useApp((s) => s.version);
  const platform = useApp((s) => s.platform);

  return (
    <>
      <div className="relative mb-8 overflow-hidden rounded-2xl border border-line bg-card p-6 edge texture">
        <div
          className="pointer-events-none absolute -right-10 -top-16 h-56 w-56 rounded-full bg-accent/10 blur-3xl"
          aria-hidden
        />
        <div className="relative flex items-center gap-4">
          <div className="relative">
            <div className="absolute inset-0 -m-3 rounded-full bg-accent/20 blur-xl" aria-hidden />
            <AppMark size={52} className="relative" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[22px] font-semibold tracking-[-0.025em]">Kvistcode</h2>
            <p className="text-body text-muted">Every coding agent, one calm place.</p>
            <p className="mt-1 text-caption text-steel tabular">
              Version {version || "dev"} ·{" "}
              {platform === "macos" ? "macOS" : platform === "windows" ? "Windows" : "Linux"} · MIT licensed
            </p>
          </div>
        </div>
        <div className="relative mt-5 flex flex-wrap gap-2">
          <Button asChild size="sm" variant="secondary">
            <a href="https://github.com/pl0xuee/kvistcode" rel="noreferrer noopener">
              <GithubGlyph /> GitHub
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <a href="https://github.com/pl0xuee/kvistcode/issues/new" rel="noreferrer noopener">
              Report an issue <ExternalLink />
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <a href="https://github.com/pl0xuee/kvistcode/releases" rel="noreferrer noopener">
              Release notes <ExternalLink />
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <a href="https://github.com/sponsors/pl0xuee" rel="noreferrer noopener">
              <Heart /> Sponsor
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <a href="https://kvistcode.com/support/" rel="noreferrer noopener">
              Other ways to support <ExternalLink />
            </a>
          </Button>
        </div>
      </div>

      <Spot id="diagnostics">
        <SettingGroup title="Diagnostics" className="mb-8">
          <SettingRow
            title="Copy diagnostics"
            description="Versions, system info, settings and recent logs for a bug report. Keys, tokens, emails and prompts are left out."
          >
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => void copyDiagnostics()}>
                Copy diagnostics
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void saveDiagnosticsFile()}>
                Save to file…
              </Button>
            </div>
          </SettingRow>
        </SettingGroup>
      </Spot>
      <Spot id="tour">
        <SettingGroup title="Welcome" className="mb-8">
          <SettingRow
            title="Show the tour again"
            description="A short look at agent grids, the pinned dock, search and spending limits."
          >
            <Button size="sm" variant="secondary" onClick={openTour}>
              <Sparkles /> Show the tour
            </Button>
          </SettingRow>
        </SettingGroup>
      </Spot>

      <p className="mt-6 text-caption leading-relaxed text-steel">
        No telemetry. Your keys stay in your OS keychain, and every agent runs through its vendor's official CLI.
      </p>
    </>
  );
}
