import { MotionConfig } from "motion/react";
import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import { Toaster } from "sonner";
import { AgentDialogs } from "@/components/AgentDialogs";
import { AppMark } from "@/components/AppMark";
import { CommandPalette } from "@/components/CommandPalette";
import { NewAgentDialog } from "@/components/NewAgentDialog";
import { Rail } from "@/components/Rail";
import { ReviewSheet } from "@/components/ReviewSheet";
import { ShareDialog } from "@/components/ShareDialog";
import { TitleBar } from "@/components/TitleBar";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { api } from "@/lib/api";
import { applyDevLinks } from "@/lib/devlinks";
import { installNavigationGuard } from "@/lib/external";
import { useApp } from "@/store/app";
import { connectEvents } from "@/store/events";
import { useUi, type View } from "@/store/ui";
import { AccountsView } from "@/views/Accounts";
import { AgentsView } from "@/views/Agents";
import { CompareView } from "@/views/Compare";
import { InboxView } from "@/views/Inbox";
import { MissionControlView } from "@/views/MissionControl";
import { Onboarding } from "@/views/Onboarding";
import { SchedulesView } from "@/views/Schedules";
import { SettingsView } from "@/views/Settings";
import { UsageView } from "@/views/Usage";

// xterm is only needed for login/install terminals; keep it out of the startup bundle.
const TerminalModal = lazy(() => import("@/components/TerminalModal").then((m) => ({ default: m.TerminalModal })));

const VIEWS: Record<View, ComponentType> = {
  agents: AgentsView,
  mission: MissionControlView,
  inbox: InboxView,
  compare: CompareView,
  schedules: SchedulesView,
  usage: UsageView,
  accounts: AccountsView,
  settings: SettingsView,
};

export function App() {
  const booted = useApp((s) => s.booted);
  const bootError = useApp((s) => s.bootError);
  const settings = useApp((s) => s.settings);
  const theme = settings?.theme ?? "gunmetal";

  // Boot + events
  useEffect(() => {
    const off = connectEvents();
    void useApp.getState().boot().then(applyDevLinks);
    return off;
  }, []);

  // Links open externally; nothing navigates the webview.
  useEffect(() => installNavigationGuard(), []);

  // Theme on <html data-theme>
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

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

  return (
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
              <Onboarding />
            </>
          ) : (
            <>
              <TitleBar />
              <div className="flex min-h-0 flex-1">
                <Rail />
                <Main />
              </div>
              <CommandPalette />
              <NewAgentDialog />
              <AgentDialogs />
              <ReviewSheet />
              <ShareDialog />
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
  );
}

function LazyTerminal() {
  const open = useUi((s) => s.terminal !== null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  if (!mounted) return null;
  return (
    <Suspense fallback={null}>
      <TerminalModal />
    </Suspense>
  );
}

function Main() {
  const view = useUi((s) => s.view);
  const Comp = VIEWS[view];
  return (
    <main className="relative min-w-0 flex-1 overflow-hidden">
      <div key={view} className="view-enter h-full">
        <Comp />
      </div>
    </main>
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
