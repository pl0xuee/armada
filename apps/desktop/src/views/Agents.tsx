import { Columns3, Inbox, LayoutGrid, PanelLeftOpen, Play, Plus, RotateCcw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo } from "react";
import { AgentHeader } from "@/components/agent/AgentHeader";
import { AgentList } from "@/components/agent/AgentList";
import { Composer } from "@/components/agent/Composer";
import { Inspector } from "@/components/agent/Inspector";
import { AppMark } from "@/components/AppMark";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { Timeline } from "@/components/timeline/Timeline";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip } from "@/components/ui/tooltip";
import { resumeAgent } from "@/lib/actions";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { basename, modKey } from "@/lib/utils";
import { useAgentListLayout } from "@/hooks/useAgentListLayout";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { INSPECTOR_DOCK_QUERY } from "@/lib/layout";
import { useNow } from "@/hooks/useNow";
import { pendingCount, useApp } from "@/store/app";
import { useUi } from "@/store/ui";

export function AgentsView() {
  const selectedId = useUi((s) => s.selectedAgentId);
  const agent = useApp((s) => (selectedId ? s.agents[selectedId] : undefined));
  const list = useAgentListLayout();

  // Narrow window, nothing open: the list is the main area.
  if (!list.docked && !agent) {
    return (
      <div className="flex h-full">
        <AgentList variant="full" />
      </div>
    );
  }

  return (
    <div className="relative flex h-full">
      {list.docked && list.open && <AgentList variant="docked" />}
      {agent ? <AgentPane key={agent.id} agentId={agent.id} /> : <Welcome />}
      {!list.docked && (
        <AnimatePresence>
          {list.open && (
            <>
              <motion.div
                key="scrim"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="absolute inset-0 z-30 bg-[var(--scrim)]"
                onClick={list.close}
                aria-hidden
              />
              <motion.div
                key="drawer"
                initial={{ x: -24, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: -24, opacity: 0 }}
                transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
                className="absolute inset-y-0 left-0 z-40 flex shadow-[24px_0_60px_-20px_rgba(0,0,0,0.6)]"
                onKeyDown={(e) => e.key === "Escape" && list.close()}
              >
                <AgentList variant="drawer" onNavigate={list.close} />
              </motion.div>
            </>
          )}
        </AnimatePresence>
      )}
    </div>
  );
}

function AgentPane({ agentId }: { agentId: string }) {
  const agent = useApp((s) => s.agents[agentId]);
  const items = useApp((s) => s.items[agentId]);
  const loading = useApp((s) => s.itemsLoading[agentId] ?? false);
  const inspectorPref = useUi((s) => s.inspectorOpen);
  const overlay = useUi((s) => s.inspectorOverlay);
  const wide = useMediaQuery(INSPECTOR_DOCK_QUERY);
  const inspectorOpen = wide ? inspectorPref : overlay;
  const windowFocused = useUi((s) => s.windowFocused);

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
      <section aria-label={agent.title} className="flex min-w-0 flex-1 flex-col bg-base">
        <AgentHeader agent={agent} />
        <Timeline
          agent={agent}
          items={items}
          loading={loading}
          footer={
            items && items.length === 0 && !loading ? (
              <div className="py-16 text-center text-[12.5px] text-steel">
                {agent.status === "starting" ? "Starting session…" : "No messages yet. Say hello below."}
              </div>
            ) : null
          }
        />
        <Composer agent={agent} />
      </section>
      <AnimatePresence initial={false}>
        {inspectorOpen && (
          <Inspector
            key="inspector"
            agent={agent}
            items={items}
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
  const now = useNow();
  const list = useMemo(() => Object.values(agents), [agents]);
  const interrupted = list.filter((a) => a.status === "interrupted" && !a.archived);
  const pending = pendingCount(agents);
  const live = list.filter((a) => a.status === "working").length;

  const shortcuts: [string, string[]][] = [
    ["New agent", [modKey, "N"]],
    ["Command palette", [modKey, "K"]],
    ["Inbox", [modKey, "I"]],
    ["Mission Control", [modKey, "⇧", "M"]],
    ["Jump to agent", [modKey, "1–9"]],
    ["Settings", [modKey, ","]],
  ];

  return (
    <div className="relative flex min-w-0 flex-1 items-center justify-center overflow-y-auto bg-base">
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
            "radial-gradient(600px 300px at 50% 30%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 70%)",
        }}
      />
      <div className="relative w-full max-w-[560px] px-8 py-10">
        <div className="mb-8 flex items-center gap-4">
          <div className="relative">
            <div className="absolute inset-0 -m-3 rounded-full bg-accent/20 blur-2xl" aria-hidden />
            <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-line-strong bg-gradient-to-b from-raised to-card edge-strong">
              <AppMark size={30} />
            </div>
          </div>
          <div>
            <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Command your fleet</h1>
            <p className="text-[13px] text-muted">
              {live > 0 ? `${live} agent${live === 1 ? " is" : "s are"} working` : "All quiet"}
              {pending > 0 && <span className="text-warn"> · {pending} waiting on you</span>}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <QuickAction
            icon={<Plus />}
            title="New agent"
            hint="Launch Claude, Codex or Grok"
            onClick={() => openNewAgent()}
            primary
          />
          <QuickAction
            icon={<Columns3 />}
            title="Compare"
            hint="One prompt, several providers"
            onClick={() => openNewAgent({ compare: true })}
          />
          <QuickAction
            icon={<LayoutGrid />}
            title="Mission Control"
            hint="Every agent at a glance"
            onClick={() => setView("mission")}
          />
          <QuickAction
            icon={<Inbox />}
            title="Inbox"
            hint={pending ? `${pending} approval${pending === 1 ? "" : "s"} waiting` : "Nothing waiting"}
            onClick={() => setView("inbox")}
            badge={pending}
          />
        </div>

        {interrupted.length > 0 && (
          <div className="mt-6 overflow-hidden rounded-xl border border-violet/30 bg-violet/[0.05]">
            <div className="flex items-center gap-2 border-b border-violet/20 px-3.5 py-2.5">
              <RotateCcw className="h-3.5 w-3.5 text-violet" />
              <span className="text-[12.5px] font-semibold">Pick up where you left off</span>
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto text-violet hover:text-violet"
                onClick={() => interrupted.forEach((a) => void resumeAgent(a))}
              >
                Resume all
              </Button>
            </div>
            <ul>
              {interrupted.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center gap-2.5 px-3.5 py-2 transition-colors hover:bg-violet/[0.06]"
                >
                  <ProviderGlyph provider={a.provider} customAgentId={a.customAgentId} size="sm" />
                  <button type="button" onClick={() => openAgent(a.id)} className="min-w-0 flex-1 text-left">
                    <div className="truncate text-[13px] font-medium">{a.title}</div>
                    <div className="truncate text-[11.5px] text-steel">
                      {basename(a.projectPath)} · interrupted {relativeTime(a.lastActivityAt, now)} ago
                    </div>
                  </button>
                  <Button size="xs" variant="secondary" onClick={() => void resumeAgent(a)}>
                    <Play className="!h-3 !w-3" /> Resume
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-7 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-line pt-5">
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
    </div>
  );
}

function QuickAction({
  icon,
  title,
  hint,
  onClick,
  primary,
  badge,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  onClick: () => void;
  primary?: boolean;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex items-start gap-3 rounded-xl border border-line bg-card/80 p-3.5 text-left transition-[transform,border-color,background-color] duration-150 hover:-translate-y-px hover:border-line-strong hover:bg-raised/70 active:scale-[0.98] edge"
    >
      <span
        className={
          primary
            ? "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg shadow-[0_4px_14px_-4px_var(--accent)] [&_svg]:h-4 [&_svg]:w-4"
            : "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-raised text-muted transition-colors group-hover:text-fg [&_svg]:h-4 [&_svg]:w-4"
        }
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="block truncate text-[11.5px] text-steel">{hint}</span>
      </span>
      {badge ? (
        <span className="absolute right-3 top-3 flex h-4 min-w-4 items-center justify-center rounded-full bg-warn px-1 text-[10px] font-semibold text-warn-fg">
          {badge}
        </span>
      ) : null}
    </button>
  );
}
