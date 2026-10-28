import {
  Columns3,
  LayoutGrid,
  ListTodo,
  PanelLeftOpen,
  Play,
  RotateCcw,
  SlidersHorizontal,
  SquareTerminal,
  X,
} from "lucide-react";
import * as D from "@radix-ui/react-dialog";
import { AnimatePresence } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentHeader } from "@/components/agent/AgentHeader";
import { AgentList } from "@/components/agent/AgentList";
import { Composer } from "@/components/agent/Composer";
import { Inspector } from "@/components/agent/Inspector";
import { AppMark } from "@/components/AppMark";
import { HomeComposer } from "@/components/home/HomeComposer";
import { RelTime } from "@/components/RelTime";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { Timeline } from "@/components/timeline/Timeline";
import { CONVERSATION_MIN, WorkspacePanel, workspaceMaxHeight } from "@/components/workspace/WorkspacePanel";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useReturnFocus } from "@/components/ui/returnFocus";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip } from "@/components/ui/tooltip";
import { resumeAgent } from "@/lib/actions";
import { triageQueue } from "@/lib/agents";
import { api } from "@/lib/api";
import type { Agent } from "@/lib/types";
import { basename, modKey } from "@/lib/utils";
import { useAgentListLayout } from "@/hooks/useAgentListLayout";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { INSPECTOR_DOCK_QUERY } from "@/lib/layout";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";

export function AgentsView() {
  const selectedId = useUi((s) => s.selectedAgentId);
  const agent = useApp((s) => (selectedId ? s.agents[selectedId] : undefined));
  const list = useAgentListLayout();

  // Narrow window, nothing open: the list is the main area.
  if (!list.docked && !agent) {
    return (
      <div className="flex h-full flex-col">
        <div className="mx-auto w-full max-w-[760px] shrink-0 px-3 pt-3">
          <HomeComposer compact autoFocus={false} />
        </div>
        <div className="flex min-h-0 flex-1">
          <AgentList variant="full" />
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full">
      {list.docked && list.open && <AgentList variant="docked" />}
      {agent ? <AgentPane key={agent.id} agentId={agent.id} /> : <Welcome />}
      {!list.docked && <AgentDrawer open={list.open} onClose={list.close} />}
    </div>
  );
}

/**
 * Narrow windows: the agent list as a modal drawer (real dialog semantics: focus trap,
 * Esc / outside click close, focus returns to where it was).
 */
function AgentDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Land on the selected agent (or the filter), not the close button, whose tooltip would
  // otherwise swallow the first Esc.
  const focus = useReturnFocus({
    onOpenAutoFocus: (e) => {
      const root = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
      const target =
        root?.querySelector<HTMLElement>('[role="button"][aria-current="true"]') ??
        root?.querySelector<HTMLElement>('input[aria-label="Filter agents"]');
      if (target) {
        e.preventDefault();
        target.focus();
      }
    },
  });
  return (
    <D.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <D.Overlay className="anim-fade absolute inset-0 z-30 bg-[var(--scrim)]" />
      <D.Content
        aria-describedby={undefined}
        onOpenAutoFocus={focus.onOpenAutoFocus}
        onCloseAutoFocus={focus.onCloseAutoFocus}
        className="anim-drawer absolute inset-y-0 left-0 z-40 flex shadow-[24px_0_60px_-20px_rgba(0,0,0,0.6)] focus:outline-none"
      >
        <D.Title className="sr-only">Agents</D.Title>
        <AgentList variant="drawer" onNavigate={onClose} />
      </D.Content>
    </D.Root>
  );
}

/** Owns the items subscription so streamed frames re-render only the timeline, not the whole pane. */
function TimelinePane({ agent }: { agent: Agent }) {
  const items = useApp((s) => s.items[agent.id]);
  const loading = useApp((s) => s.itemsLoading[agent.id] ?? false);
  const loadError = useApp((s) => s.itemsError[agent.id]);
  return (
    <Timeline
      agent={agent}
      items={items}
      loading={loading}
      footer={
        loadError && !items ? (
          <div className="mx-auto mt-10 max-w-sm rounded-xl border border-err/30 bg-err/[0.06] p-4 text-center">
            <p className="text-[13px] font-medium text-err">Couldn't load this conversation</p>
            <p className="selectable mt-1 break-words font-mono text-[11.5px] text-muted">{loadError}</p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-3"
              onClick={() => void useApp.getState().ensureItems(agent.id, true)}
            >
              Try again
            </Button>
          </div>
        ) : items && items.length === 0 && !loading ? (
          <div className="py-16 text-center text-[12.5px] text-steel">
            {agent.status === "starting" ? "Starting session…" : "No messages yet. Say hello below."}
          </div>
        ) : null
      }
    />
  );
}

function InspectorPane({ agent, className }: { agent: Agent; className?: string }) {
  const items = useApp((s) => s.items[agent.id]);
  return <Inspector agent={agent} items={items} className={className} />;
}

function AgentPane({ agentId }: { agentId: string }) {
  const agent = useApp((s) => s.agents[agentId]);
  const inspectorPref = useUi((s) => s.inspectorOpen);
  const overlay = useUi((s) => s.inspectorOverlay);
  const wide = useMediaQuery(INSPECTOR_DOCK_QUERY);
  const inspectorOpen = wide ? inspectorPref : overlay;
  const windowFocused = useUi((s) => s.windowFocused);
  const workspaceOpen = useUi((s) => s.workspaceOpen);
  // The panel only takes what the conversation and composer can spare (tiling WMs go down to 600px tall).
  // Measures the header and composer (incl. queue) so the conversation always keeps its minimum.
  const sectionRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [workspaceMax, setWorkspaceMax] = useState(0);
  const setWorkspaceRoom = useUi((s) => s.setWorkspaceRoom);
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    // The conversation keeps at least 40% of the pane (and never less than CONVERSATION_MIN).
    const measure = () =>
      setWorkspaceMax(
        workspaceMaxHeight(
          section.clientHeight,
          (headerRef.current?.offsetHeight ?? 0) +
            (composerRef.current?.offsetHeight ?? 0) +
            Math.max(0, Math.round(section.clientHeight * 0.4) - CONVERSATION_MIN),
        ),
      );
    const ro = new ResizeObserver(measure);
    for (const el of [section, headerRef.current, composerRef.current]) if (el) ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    setWorkspaceRoom(workspaceMax);
  }, [workspaceMax, setWorkspaceRoom]);

  useEffect(() => {
    void useApp.getState().ensureItems(agentId);
  }, [agentId]);

  // Mark read when opened, and whenever new activity arrives while it's on screen.
  const unread = agent?.unread ?? false;
  useEffect(() => {
    if (unread && windowFocused) api.markRead(agentId).catch(() => {});
  }, [agentId, unread, windowFocused]);

  if (!agent) return null;

  return (
    <div className="relative flex min-w-0 flex-1">
      <section ref={sectionRef} aria-label={agent.title} className="flex min-w-0 flex-1 flex-col bg-base">
        <div ref={headerRef} className="shrink-0">
          <AgentHeader agent={agent} />
        </div>
        <TimelinePane agent={agent} />
        {workspaceOpen && workspaceMax > 0 && <WorkspacePanel agent={agent} maxHeight={workspaceMax} />}
        {workspaceOpen && workspaceMax === 0 && (
          <div
            role="status"
            className="flex h-8 shrink-0 items-center gap-2 border-t border-line bg-base px-3 text-[12px] text-muted"
          >
            <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-steel" />
            <span className="min-w-0 truncate">Workspace panel: not enough room. Enlarge the window.</span>
            <Button
              size="icon-sm"
              variant="ghost"
              className="ml-auto"
              aria-label="Hide workspace panel"
              onClick={() => useUi.getState().setWorkspaceOpen(false)}
            >
              <X />
            </Button>
          </div>
        )}
        <div ref={composerRef} className="shrink-0">
          <Composer agent={agent} />
        </div>
      </section>
      <AnimatePresence initial={false}>
        {inspectorOpen && (
          <InspectorPane
            key="inspector"
            agent={agent}
            className={
              wide ? undefined : "absolute inset-y-0 right-0 z-20 shadow-[-24px_0_60px_-20px_rgba(0,0,0,0.6)] glass"
            }
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function Welcome() {
  const agents = useApp((s) => s.agents);
  const listLayout = useAgentListLayout();
  const openNewAgent = useUi((s) => s.openNewAgent);
  const setView = useUi((s) => s.setView);
  const openAgent = useUi((s) => s.openAgent);
  const list = useMemo(() => Object.values(agents), [agents]);
  const interrupted = list.filter((a) => a.status === "interrupted" && !a.archived);
  const needs = useMemo(() => triageQueue(list).length, [list]);
  const live = list.filter((a) => a.status === "working").length;
  const [confirmResume, setConfirmResume] = useState(false);

  const shortcuts: [string, string[]][] = [
    ["Start from the palette", [modKey, "K"]],
    ["New agent (all options)", [modKey, "N"]],
    ["Needs you", [modKey, "J"]],
    ["Jump to agent", [modKey, "1–9"]],
    ["All shortcuts", [modKey, "/"]],
  ];

  return (
    <div className="@container relative flex min-w-0 flex-1 flex-col overflow-y-auto bg-base">
      {!listLayout.open && (
        <div className="absolute left-3 top-3 z-10">
          <Tooltip content="Show agents" shortcut={[modKey, "B"]}>
            <Button size="icon-sm" variant="ghost" aria-label="Show agent list" onClick={listLayout.toggle}>
              <PanelLeftOpen />
            </Button>
          </Tooltip>
        </div>
      )}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(700px 320px at 50% 22%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 70%)",
        }}
      />
      <div className="relative mx-auto my-auto w-full max-w-[720px] px-5 py-10 @2xl:px-8">
        <div className="mb-5 flex items-center gap-3.5">
          <div className="relative">
            <div className="absolute inset-0 -m-3 rounded-full bg-accent/20 blur-2xl" aria-hidden />
            <div className="relative flex h-11 w-11 items-center justify-center rounded-xl border border-line-strong bg-gradient-to-b from-raised to-card edge-strong">
              <AppMark size={24} />
            </div>
          </div>
          <div className="min-w-0">
            <h1 className="text-[20px] font-semibold tracking-[-0.02em]">Command your fleet</h1>
            <p className="text-[12.5px] text-muted">
              {live > 0 ? `${live} agent${live === 1 ? " is" : "s are"} working` : "All quiet"}
              {needs > 0 && (
                <>
                  {" · "}
                  <button type="button" onClick={() => setView("triage")} className="text-warn hover:underline">
                    {needs} need{needs === 1 ? "s" : ""} you
                  </button>
                </>
              )}
            </p>
          </div>
        </div>

        <HomeComposer />

        <div className="mt-3 flex flex-wrap gap-1.5">
          <QuickAction icon={<SlidersHorizontal />} label="All options" onClick={() => openNewAgent()} />
          <QuickAction icon={<Columns3 />} label="Compare providers" onClick={() => openNewAgent({ compare: true })} />
          <QuickAction icon={<ListTodo />} label="Needs you" badge={needs} onClick={() => setView("triage")} />
          <QuickAction icon={<LayoutGrid />} label="Mission Control" onClick={() => setView("mission")} />
        </div>

        {interrupted.length > 0 && (
          <div className="mt-6 overflow-hidden rounded-xl border border-violet/30 bg-violet/[0.05]">
            <div className="flex items-center gap-2 border-b border-violet/20 px-3.5 py-2">
              <RotateCcw className="h-3.5 w-3.5 text-violet" />
              <span className="text-[12.5px] font-semibold">Pick up where you left off</span>
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto text-violet hover:text-violet"
                onClick={() => setConfirmResume(true)}
              >
                Resume all ({interrupted.length})
              </Button>
            </div>
            <ul>
              {interrupted.slice(0, 4).map((a) => (
                <li
                  key={a.id}
                  className="flex items-center gap-2.5 px-3.5 py-1.5 transition-colors hover:bg-violet/[0.06]"
                >
                  <ProviderGlyph provider={a.provider} customAgentId={a.customAgentId} size="sm" />
                  <button type="button" onClick={() => openAgent(a.id)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[13px] font-medium">{a.title}</span>
                    <span className="block truncate text-[11.5px] text-steel">
                      {basename(a.projectPath)} · interrupted <RelTime ts={a.lastActivityAt} long />
                    </span>
                  </button>
                  <Button size="xs" variant="secondary" onClick={() => void resumeAgent(a)}>
                    <Play className="!h-3 !w-3" /> Resume
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-6 grid grid-cols-1 gap-x-6 gap-y-1.5 border-t border-line pt-4 @lg:grid-cols-2">
          {shortcuts.map(([label, keys]) => (
            <div key={label} className="flex items-center justify-between text-[12px] text-muted">
              <span>{label}</span>
              <span className="flex gap-0.5">
                {keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
      <ConfirmDialog
        open={confirmResume}
        onOpenChange={setConfirmResume}
        title={`Resume ${interrupted.length} interrupted agent${interrupted.length === 1 ? "" : "s"}?`}
        description={
          <>
            Each one picks up its turn where it stopped and keeps running (
            {interrupted
              .slice(0, 3)
              .map((a) => `“${a.title}”`)
              .join(", ")}
            {interrupted.length > 3 ? `, and ${interrupted.length - 3} more` : ""}). They may edit files and run
            commands per their permission mode.
          </>
        }
        confirmLabel={`Resume ${interrupted.length}`}
        onConfirm={() => {
          setConfirmResume(false);
          for (const a of interrupted) void resumeAgent(a);
        }}
      />
    </div>
  );
}

function QuickAction({
  icon,
  label,
  onClick,
  badge,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-card/70 px-2.5 text-[12.5px] text-muted transition-[border-color,background-color,color,transform] duration-150 hover:border-line-strong hover:bg-raised hover:text-fg active:scale-[0.98] [&_svg]:h-3.5 [&_svg]:w-3.5"
    >
      {icon}
      {label}
      {badge ? (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-warn px-1 text-[10px] font-semibold text-warn-fg tabular">
          {badge}
        </span>
      ) : null}
    </button>
  );
}
