import { LazyMotion, MotionConfig } from "motion/react";
import { lazy, Profiler, Suspense, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Toaster } from "sonner";
import { AgentDialogs } from "@/components/AgentDialogs";
import { Announcer } from "@/components/shell/Announcer";
import { VoiceSetupDialog } from "@/components/DictateButton";
import { ShortcutHelp } from "@/components/shell/ShortcutHelp";
import { AppMark } from "@/components/AppMark";
import { Rail } from "@/components/Rail";
import { TitleBar } from "@/components/TitleBar";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { usePrPolling } from "@/hooks/usePrPolling";
import { api } from "@/lib/api";
import { applyDevLinks } from "@/lib/devlinks";
import { installNavigationGuard } from "@/lib/external";
import { useApp } from "@/store/app";
import { connectEvents } from "@/store/events";
import { applyInterfaceScale } from "@/lib/zoom";
import { useUi, type View } from "@/store/ui";
import { AgentsView } from "@/views/Agents";

// Code splitting: only the agents view ships in the startup bundle. Everything else
// (views, overlays, xterm) loads on first use and is prefetched when the app is idle.
const load = {
  mission: () => import("@/views/MissionControl").then((m) => ({ default: m.MissionControlView })),
  inbox: () => import("@/views/Inbox").then((m) => ({ default: m.InboxView })),
  compare: () => import("@/views/Compare").then((m) => ({ default: m.CompareView })),
  triage: () => import("@/views/Triage").then((m) => ({ default: m.TriageView })),
  schedules: () => import("@/views/Schedules").then((m) => ({ default: m.SchedulesView })),
  usage: () => import("@/views/Usage").then((m) => ({ default: m.UsageView })),
  accounts: () => import("@/views/Accounts").then((m) => ({ default: m.AccountsView })),
  settings: () => import("@/views/Settings").then((m) => ({ default: m.SettingsView })),
  onboarding: () => import("@/views/Onboarding").then((m) => ({ default: m.Onboarding })),
  palette: () => import("@/components/CommandPalette").then((m) => ({ default: m.CommandPalette })),
  newAgent: () => import("@/components/NewAgentDialog").then((m) => ({ default: m.NewAgentDialog })),
  review: () => import("@/components/ReviewSheet").then((m) => ({ default: m.ReviewSheet })),
  share: () => import("@/components/ShareDialog").then((m) => ({ default: m.ShareDialog })),
  terminal: () => import("@/components/TerminalModal").then((m) => ({ default: m.TerminalModal })),
};

const loadMotionFeatures = () => import("@/lib/motionFeatures").then((mod) => mod.default);

const TerminalModal = lazy(load.terminal);
const Onboarding = lazy(load.onboarding);
const CommandPalette = lazy(load.palette);
const NewAgentDialog = lazy(load.newAgent);
const ReviewSheet = lazy(load.review);
const ShareDialog = lazy(load.share);

const VIEWS: Record<View, ComponentType> = {
  agents: AgentsView,
  mission: lazy(load.mission),
  inbox: lazy(load.inbox),
  compare: lazy(load.compare),
  triage: lazy(load.triage),
  schedules: lazy(load.schedules),
  usage: lazy(load.usage),
  accounts: lazy(load.accounts),
  settings: lazy(load.settings),
};

/** Warm the chunks once the UI is idle so the first switch to a view is instant. */
function prefetchChunks() {
  const idle =
    (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback ??
    ((cb: () => void) => window.setTimeout(cb, 1200));
  idle(() => {
    for (const fn of Object.values(load)) void fn().catch(() => {});
  });
}

export function App() {
  const booted = useApp((s) => s.booted);
  const bootError = useApp((s) => s.bootError);
  const settings = useApp((s) => s.settings);
  const theme = settings?.theme ?? "gunmetal";

  // Boot + events
  useEffect(() => {
    const off = connectEvents();
    void useApp.getState().boot().then(applyDevLinks).then(prefetchChunks);
    return off;
  }, []);

  // Links open externally; nothing navigates the webview.
  useEffect(() => installNavigationGuard(), []);

  // Theme on <html data-theme>
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Interface zoom (webview zoom, so layout and measurements stay consistent)
  const scale = settings?.interfaceScale;
  useEffect(() => {
    if (scale !== undefined) applyInterfaceScale(scale);
  }, [scale]);

  // Window focus tracking (smart mute)
  useEffect(() => {
    const onFocus = () => useUi.getState().setWindowFocused(true);
    const onBlur = () => useUi.getState().setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const focusTarget = useUi((s) => (s.view === "agents" && s.windowFocused ? s.selectedAgentId : null));
  useEffect(() => {
    if (!booted) return;
    api.setFocus(focusTarget).catch(() => {});
  }, [focusTarget, booted]);

  useGlobalShortcuts(booted && settings?.onboarded === true);
  usePrPolling();

  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <MotionConfig reducedMotion="user">
        <TooltipProvider delayDuration={350} skipDelayDuration={200}>
          <div className="flex h-full flex-col bg-base text-fg">
            {!booted ? (
              <>
                <TitleBar minimal />
                <BootScreen error={bootError} />
              </>
            ) : settings && !settings.onboarded ? (
              <>
                <TitleBar minimal />
                <Suspense fallback={<div className="flex-1" />}>
                  <Onboarding />
                </Suspense>
              </>
            ) : (
              <>
                <TitleBar />
                <div className="flex min-h-0 flex-1">
                  <Rail />
                  <Main />
                </div>
                <WhenOpened open={(s) => s.paletteOpen}>
                  <CommandPalette />
                </WhenOpened>
                <WhenOpened open={(s) => s.newAgent.open}>
                  <NewAgentDialog />
                </WhenOpened>
                <AgentDialogs />
                <ShortcutHelp />
                <VoiceSetupDialog />
                <Announcer />
                <WhenOpened open={(s) => s.reviewAgentId !== null}>
                  <ReviewSheet />
                </WhenOpened>
                <WhenOpened open={(s) => s.shareAgent !== null}>
                  <ShareDialog />
                </WhenOpened>
              </>
            )}
            <LazyTerminal />
          </div>
          <Toaster
            theme={theme === "titanium" ? "light" : "dark"}
            position="bottom-right"
            offset={16}
            gap={8}
            visibleToasts={4}
            toastOptions={{
              classNames: {
                toast:
                  "!rounded-xl !border !border-line-strong !bg-raised/95 !text-fg !shadow-[0_16px_48px_-8px_rgba(0,0,0,0.55)] backdrop-blur-xl !font-sans",
                description: "!text-muted",
                actionButton: "!bg-accent !text-accent-fg !rounded-md !font-medium",
                cancelButton: "!bg-card !text-muted",
              },
            }}
          />
        </TooltipProvider>
      </MotionConfig>
    </LazyMotion>
  );
}

/** Mounts a lazily loaded overlay the first time it opens, then keeps it (for exit animations). */
function WhenOpened({
  open,
  children,
}: {
  open: (s: ReturnType<typeof useUi.getState>) => boolean;
  children: ReactNode;
}) {
  const isOpen = useUi(open);
  const [mounted, setMounted] = useState(isOpen);
  useEffect(() => {
    if (isOpen) setMounted(true);
  }, [isOpen]);
  if (!mounted) return null;
  return <Suspense fallback={null}>{children}</Suspense>;
}

function LazyTerminal() {
  return (
    <WhenOpened open={(s) => s.terminal !== null}>
      <TerminalModal />
    </WhenOpened>
  );
}

/** Dev perf instrumentation (?stress): React commit durations → window.__armadaPerf. */
const PERF =
  import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).has("stress");
type PerfWindow = Window & { __armadaPerf?: { commits: number[] } };
function onRender(_id: string, _phase: string, actualDuration: number) {
  const w = window as PerfWindow;
  (w.__armadaPerf ??= { commits: [] }).commits.push(actualDuration);
}

function Main() {
  const view = useUi((s) => s.view);
  const Comp = VIEWS[view];
  const content = (
    <div key={view} className="view-enter h-full">
      <Suspense fallback={<ViewFallback />}>
        <Comp />
      </Suspense>
    </div>
  );
  return (
    <main className="relative min-w-0 flex-1 overflow-hidden">
      {PERF ? (
        <Profiler id="main" onRender={onRender}>
          {content}
        </Profiler>
      ) : (
        content
      )}
    </main>
  );
}

function ViewFallback() {
  return (
    <div className="flex h-full items-center justify-center" aria-busy="true" aria-label="Loading">
      <div className="h-1 w-32 overflow-hidden rounded-full bg-raised shimmer-bar" />
    </div>
  );
}

function BootScreen({ error }: { error: string | null }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5">
      <div className="relative">
        <div className="absolute inset-0 -m-10 rounded-full bg-accent/15 blur-3xl animate-breathe" aria-hidden />
        <AppMark size={56} className="relative" />
      </div>
      {error ? (
        <div className="max-w-md text-center">
          <p className="text-[15px] font-semibold">Couldn't reach the Armada core</p>
          <p className="selectable mt-1.5 font-mono text-xs text-muted">{error}</p>
          <Button className="mt-4" variant="primary" onClick={() => void useApp.getState().boot()}>
            Try again
          </Button>
        </div>
      ) : (
        <div
          className="h-1 w-40 overflow-hidden rounded-full bg-raised shimmer-bar"
          role="progressbar"
          aria-label="Loading"
        />
      )}
    </div>
  );
}
