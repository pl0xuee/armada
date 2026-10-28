import {
  Bell,
  Bot,
  Smartphone,
  BookText,
  Plug,
  Info,
  Keyboard,
  Package,
  Palette,
  Play,
  RefreshCw,
  Send,
  SlidersHorizontal,
  Volume2,
  ExternalLink,
  Download,
  Sparkles,
} from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState, type ComponentType } from "react";
import { toast } from "sonner";
import { AppMark } from "@/components/AppMark";
import { GithubGlyph } from "@/components/settings/GithubGlyph";
import { InstallAllBanner } from "@/components/settings/InstallAllBanner";
import { AgentsSection } from "@/components/settings/AgentsSection";
import { CustomSoundLine } from "@/components/settings/CustomSound";
import { McpSection } from "@/components/settings/McpSection";
import { ProviderCard } from "@/components/settings/ProviderCard";
import { RemoteSection } from "@/components/settings/RemoteSection";
import { SectionHeader, SettingGroup, SettingRow } from "@/components/settings/SettingRow";
import { TemplatesSection } from "@/components/settings/TemplatesSection";
import { ThemeCard, THEMES } from "@/components/settings/ThemeCard";
import { Button } from "@/components/ui/button";
import { fieldClass, Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { checkForUpdates, installUpdate } from "@/lib/actions";
import { api } from "@/lib/api";
import { relativeTimeLong } from "@/lib/format";
import type { AttentionReason, Settings } from "@/lib/types";
import { cn, errorMessage, modKey } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi, type SettingsSection } from "@/store/ui";

const SECTIONS: { id: SettingsSection; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "sounds", label: "Sounds", icon: Volume2 },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "behavior", label: "Behavior", icon: SlidersHorizontal },
  { id: "templates", label: "Templates", icon: BookText },
  { id: "mcp", label: "Tools (MCP)", icon: Plug },
  { id: "providers", label: "Providers", icon: Package },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "remote", label: "Remote & mobile", icon: Smartphone },
  { id: "about", label: "About", icon: Info },
];

async function save(patch: Partial<Settings>) {
  try {
    await useApp.getState().patchSettings(patch);
  } catch (e) {
    toast.error("Couldn't save settings", { description: errorMessage(e) });
  }
}

export function SettingsView() {
  const section = useUi((s) => s.settingsSection);
  const openSettings = useUi((s) => s.openSettings);
  const settings = useApp((s) => s.settings);

  // Dev/review convenience: ?view=settings&section=sounds
  useEffect(() => {
    try {
      const want = new URLSearchParams(location.search).get("section");
      if (want && SECTIONS.some((s) => s.id === want)) openSettings(want as SettingsSection);
    } catch {
      /* ignore */
    }
  }, [openSettings]);
  if (!settings) return null;

  return (
    <div className="flex h-full">
      <nav
        aria-label="Settings sections"
        className="flex w-[208px] shrink-0 flex-col gap-0.5 border-r border-line bg-panel/50 px-2.5 pt-7"
      >
        <h1 className="mb-3 px-2.5 text-[20px] font-semibold tracking-[-0.02em]">Settings</h1>
        {SECTIONS.map((s) => {
          const active = s.id === section;
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => openSettings(s.id)}
              className={cn(
                "relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors",
                active ? "text-fg" : "text-muted hover:bg-raised/60 hover:text-fg",
              )}
            >
              {active && (
                <motion.span
                  layoutId="settings-nav"
                  transition={{ type: "spring", stiffness: 520, damping: 40 }}
                  className="absolute inset-0 rounded-lg border border-line-strong bg-raised edge"
                />
              )}
              <Icon className={cn("relative h-4 w-4", active ? "text-accent" : "text-steel")} />
              <span className="relative">{s.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div key={section} className="view-enter mx-auto max-w-[720px] px-8 pb-16 pt-8">
          {section === "appearance" && <Appearance settings={settings} />}
          {section === "sounds" && <Sounds settings={settings} />}
          {section === "notifications" && <Notifications settings={settings} />}
          {section === "behavior" && <Behavior settings={settings} />}
          {section === "templates" && <TemplatesSection templates={settings.templates} />}
          {section === "mcp" && <McpSection servers={settings.mcpServers} />}
          {section === "providers" && <Providers />}
          {section === "agents" && <AgentsSection agents={settings.customAgents} />}
          {section === "remote" && <RemoteSection settings={settings} />}
          {section === "about" && <About />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Appearance

function Appearance({ settings }: { settings: Settings }) {
  return (
    <>
      <SectionHeader title="Appearance" description="Pick the finish for your command deck." />
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {THEMES.map((t) => (
          <ThemeCard
            key={t.id}
            id={t.id}
            active={settings.theme === t.id}
            onSelect={() => void save({ theme: t.id })}
          />
        ))}
      </div>
      <p className="mt-4 text-[12px] text-steel">
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
    description: "Two-tone rising ping",
  },
  {
    key: "onDone",
    custom: "customDone",
    reason: "done",
    title: "Agent finished",
    description: "Soft completion chord",
  },
  {
    key: "onError",
    custom: "customError",
    reason: "error",
    title: "Error or rate limit",
    description: "Low metallic thud",
  },
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

  return (
    <>
      <SectionHeader title="Sounds" description="Audio cues play even when Armada is in the tray." />
      <div className="space-y-6">
        <SettingGroup>
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
              <span className="w-9 text-right text-[12px] text-muted tabular">{Math.round(volume * 100)}%</span>
            </div>
          </SettingRow>
        </SettingGroup>

        <SettingGroup
          title="Events"
          description="Use Armada's sounds or your own .wav, .ogg, .mp3 or .flac files. Preview plays whichever is saved."
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
                      return cur ? save({ sounds: { ...cur.sounds, [ev.custom]: path } }) : Promise.resolve();
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
  const [ntfy, setNtfy] = useState(settings.ntfyUrl ?? "");
  useEffect(() => setNtfy(settings.ntfyUrl ?? ""), [settings.ntfyUrl]);
  const ntfyValid = ntfy.trim() === "" || /^https?:\/\/\S+$/i.test(ntfy.trim());

  const commitNtfy = () => {
    const v = ntfy.trim();
    if (!ntfyValid) return;
    if ((settings.ntfyUrl ?? "") !== v) void save({ ntfyUrl: v || null });
  };

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
        </SettingGroup>

        <SettingGroup title="Quiet hours" description="Notifications and sounds are held during this window.">
          <SettingRow title="Enable quiet hours" htmlFor="qh-enabled">
            <Switch
              id="qh-enabled"
              checked={q.enabled}
              onCheckedChange={(v) => void save({ quietHours: { ...q, enabled: v } })}
            />
          </SettingRow>
          <SettingRow title="Schedule" description="Overnight windows (e.g. 22:00 to 08:00) are supported.">
            <input
              type="time"
              aria-label="Quiet hours start"
              value={q.start}
              disabled={!q.enabled}
              onChange={(e) => e.target.value && void save({ quietHours: { ...q, start: e.target.value } })}
              className={cn(fieldClass, "h-8 w-[128px] tabular [color-scheme:inherit]")}
            />
            <span className="text-[12px] text-steel">to</span>
            <input
              type="time"
              aria-label="Quiet hours end"
              value={q.end}
              disabled={!q.enabled}
              onChange={(e) => e.target.value && void save({ quietHours: { ...q, end: e.target.value } })}
              className={cn(fieldClass, "h-8 w-[128px] tabular [color-scheme:inherit]")}
            />
          </SettingRow>
        </SettingGroup>

        <SettingGroup title="Phone push" description="Optional. Forward attention events to your phone with ntfy.">
          <SettingRow
            stack
            title="ntfy topic URL"
            description={
              <>Install the ntfy app, subscribe to a hard-to-guess topic, and paste its URL. Leave empty to disable.</>
            }
            htmlFor="ntfy-url"
          >
            <div className="w-full">
              <Input
                id="ntfy-url"
                value={ntfy}
                placeholder="https://ntfy.sh/armada-7f3k2"
                onChange={(e) => setNtfy(e.target.value)}
                onBlur={commitNtfy}
                onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
                aria-invalid={!ntfyValid}
                className={cn(
                  "font-mono text-[12.5px]",
                  !ntfyValid && "border-err/60 focus:border-err/60 focus:ring-err/15",
                )}
              />
              {!ntfyValid && <p className="mt-1.5 text-[11.5px] text-err">Enter a full http(s) URL.</p>}
            </div>
          </SettingRow>
        </SettingGroup>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Behavior

const ESCALATE_OPTIONS = [0, 2, 5, 10, 15, 30];

const FAILOVER: { value: Settings["failover"]; label: string; description: string }[] = [
  { value: "off", label: "Off", description: "The agent stops with an error. You decide what to do next." },
  {
    value: "ask",
    label: "Ask me",
    description: "Armada shows a banner on the agent offering your other signed-in accounts of the same provider.",
  },
  {
    value: "auto",
    label: "Switch automatically",
    description: "Armada moves the agent to another signed-in account of the same provider and keeps going.",
  },
];

function Behavior({ settings }: { settings: Settings }) {
  const [hotkey, setHotkey] = useState(settings.globalHotkey);
  useEffect(() => setHotkey(settings.globalHotkey), [settings.globalHotkey]);

  const toggle = (key: "closeToTray" | "autoResume" | "defaultWorktree" | "launchAtLogin") => (v: boolean) =>
    void save({ [key]: v } as Partial<Settings>);

  return (
    <>
      <SectionHeader title="Behavior" description="How Armada runs in the background and launches agents." />
      <div className="space-y-6">
        <SettingGroup title="App">
          <SettingRow
            title="Close to tray"
            description="Closing the window keeps agents running and Armada in the tray."
            htmlFor="b-tray"
          >
            <Switch id="b-tray" checked={settings.closeToTray} onCheckedChange={toggle("closeToTray")} />
          </SettingRow>
          <SettingRow
            title="Launch at login"
            description="Start Armada quietly in the tray when you sign in."
            htmlFor="b-login"
          >
            <Switch id="b-login" checked={settings.launchAtLogin} onCheckedChange={toggle("launchAtLogin")} />
          </SettingRow>
          <SettingRow
            title="Global hotkey"
            description="Bring Armada forward from anywhere. Use Tauri accelerator syntax."
            htmlFor="b-hotkey"
          >
            <Input
              id="b-hotkey"
              value={hotkey}
              onChange={(e) => setHotkey(e.target.value)}
              onBlur={() => {
                const v = hotkey.trim();
                if (!v) setHotkey(settings.globalHotkey);
                else if (v !== settings.globalHotkey) void save({ globalHotkey: v });
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
              className="h-8 w-[220px] font-mono text-[12px]"
              spellCheck={false}
            />
          </SettingRow>
        </SettingGroup>

        <SettingGroup title="Agents">
          <SettingRow
            title="Auto-resume interrupted agents"
            description="When Armada starts, agents cut off by a crash or reboot pick up where they left off."
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
          <SettingRow title="Re-ping pending approvals" description="If an approval waits this long, ping once more.">
            <Select
              aria-label="Escalate after"
              className="h-8 w-[140px]"
              value={String(settings.escalateAfterMins)}
              onValueChange={(v) => void save({ escalateAfterMins: Number(v) })}
              options={ESCALATE_OPTIONS.map((m) => ({ value: String(m), label: m === 0 ? "Never" : `After ${m} min` }))}
            />
          </SettingRow>
        </SettingGroup>

        <SettingGroup title="Usage limits">
          <SettingRow
            stack
            title="When an account hits its usage limit"
            description={FAILOVER.find((f) => f.value === settings.failover)?.description}
          >
            <Segmented
              aria-label="When an account hits its usage limit"
              value={settings.failover}
              onChange={(v) => void save({ failover: v })}
              className="w-full"
              options={FAILOVER.map((f) => ({ value: f.value, label: f.label }))}
            />
          </SettingRow>
        </SettingGroup>
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
            : "Armada drives each vendor's official agent CLI."
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
    </>
  );
}

// ---------------------------------------------------------------- About

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: [modKey, "K"], label: "Command palette" },
  { keys: [modKey, "N"], label: "New agent" },
  { keys: [modKey, "1–9"], label: "Jump to agent" },
  { keys: [modKey, "I"], label: "Inbox" },
  { keys: [modKey, "⇧", "M"], label: "Mission Control" },
  { keys: [modKey, ","], label: "Settings" },
  { keys: ["Esc"], label: "Close / cancel turn" },
];

function About() {
  const version = useApp((s) => s.version);
  const platform = useApp((s) => s.platform);
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.update);
  const progress = useApp((s) => s.updateProgress);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    await checkForUpdates();
    setChecking(false);
  };

  const pct = progress?.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;

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
            <h2 className="text-[22px] font-semibold tracking-[-0.025em]">Armada</h2>
            <p className="text-[13px] text-muted">Command your fleet.</p>
            <p className="mt-1 text-[12px] text-steel tabular">
              Version {version || "dev"} ·{" "}
              {platform === "macos" ? "macOS" : platform === "windows" ? "Windows" : "Linux"} · MIT licensed
            </p>
          </div>
        </div>
        <div className="relative mt-5 flex flex-wrap gap-2">
          <Button asChild size="sm" variant="secondary">
            <a href="https://github.com/pl0xuee/armada" rel="noreferrer noopener">
              <GithubGlyph /> GitHub
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <a href="https://github.com/pl0xuee/armada/issues/new" rel="noreferrer noopener">
              Report an issue <ExternalLink />
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <a href="https://github.com/pl0xuee/armada/releases" rel="noreferrer noopener">
              Release notes <ExternalLink />
            </a>
          </Button>
        </div>
      </div>

      <SettingGroup title="Updates" className="mb-8">
        {update && (
          <div className="flex items-center gap-3 bg-accent/[0.06] px-4 py-3.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent">
              <Sparkles className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-fg">Armada {update.version} is available</p>
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
                  <span className="text-[11.5px] text-muted tabular">{pct === null ? "Downloading…" : `${pct}%`}</span>
                </div>
              ) : (
                <p className="text-[12px] text-muted">
                  You have {update.currentVersion}
                  {update.date ? ` · released ${new Date(update.date).toLocaleDateString()}` : ""}
                  {" · "}
                  <a href={update.url} rel="noreferrer noopener" className="text-accent hover:underline">
                    Release notes
                  </a>
                </p>
              )}
            </div>
            <Button size="sm" variant="primary" disabled={progress !== null} onClick={() => void installUpdate()}>
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
        {settings && (
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
        )}
      </SettingGroup>

      <SettingGroup
        title={
          <span className="flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-steel" />
            Keyboard shortcuts
          </span>
        }
      >
        {SHORTCUTS.map((s) => (
          <div key={s.label} className="flex items-center justify-between px-4 py-2.5">
            <span className="text-[13px] text-muted">{s.label}</span>
            <span className="flex gap-1">
              {s.keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          </div>
        ))}
      </SettingGroup>

      <p className="mt-6 text-[12px] leading-relaxed text-steel">
        No telemetry. Your keys stay in your OS keychain, and every agent runs through its vendor's official CLI.
      </p>
    </>
  );
}
