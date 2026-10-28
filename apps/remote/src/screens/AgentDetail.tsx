import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AccountDot, ProviderBadge, StatusDot } from "@/components/Identity";
import { Composer, loadDraft } from "@/components/Composer";
import { Icon } from "@/components/Icon";
import { Sheet } from "@/components/Sheet";
import { Timeline } from "@/components/timeline/Timeline";
import { TopBar } from "@/components/TopBar";
import { Button, IconButton } from "@/components/ui";
import { cancelTurn, loadTimeline, resumeAgent } from "@/lib/controller";
import { devParam } from "@/lib/dev";
import { basename, formatCost, formatTokens, relativeTimeLong } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { agentIdentity, isBusy, isResumable, safeColor, statusMeta } from "@/lib/meta";
import { goBack, navigate } from "@/lib/router";
import { isUserLayoutChange } from "@/lib/scroll";
import { useInbox } from "@/lib/selectors";
import { useStore, type PendingPrompt, type Timeline as TimelineState } from "@/lib/store";
import type { Agent } from "@/lib/types";
import { EmptyState, ErrorState } from "./States";

const NO_PENDING: PendingPrompt[] = [];

export function AgentDetail({ agentId }: { agentId: string }) {
  const agent = useStore((s) => s.agents[agentId]);
  const timeline = useStore((s) => s.timelines[agentId]);
  const stateStatus = useStore((s) => s.stateStatus);
  const scope = useStore((s) => s.session?.scope ?? "viewer");
  const pending = useStore((s) => s.pendingPrompts[agentId] ?? NO_PENDING);
  const readOnly = scope !== "owner";

  if (!agent) {
    if (stateStatus === "ready") {
      return (
        <Screen agent={null} readOnly={readOnly}>
          <EmptyState
            icon="archive"
            title="Agent not found"
            body="It may have been deleted on your computer."
            action={readOnly ? undefined : { label: "Back to agents", onClick: () => navigate({ name: "fleet" }, { replace: true }) }}
          />
        </Screen>
      );
    }
    return (
      <Screen agent={null} readOnly={readOnly}>
        <TimelineSkeleton />
      </Screen>
    );
  }
  return <AgentView agent={agent} timeline={timeline} pending={pending} readOnly={readOnly} />;
}

function Screen({ agent, readOnly, children }: { agent: Agent | null; readOnly: boolean; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <DetailHeader agent={agent} readOnly={readOnly} />
      <main className="mx-auto w-full max-w-[860px] flex-1 px-safe py-4">{children}</main>
    </div>
  );
}

function DetailHeader({ agent, readOnly, onDetails }: { agent: Agent | null; readOnly: boolean; onDetails?: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const customAgents = useStore((s) => s.customAgents);
  const inbox = useInbox();
  const account = agent ? accounts[agent.accountId] : undefined;
  const id = agent ? agentIdentity(agent, customAgents) : null;
  const meta = agent ? statusMeta(agent.status) : null;
  const otherPending = agent ? inbox.count - inbox.entries.filter((e) => e.agent.id === agent.id).length : 0;

  return (
    <TopBar
      left={readOnly ? <span className="w-2.5" /> : <IconButton icon="chevronLeft" label="Back to agents" onClick={goBack} />}
      right={
        <>
          {!readOnly && otherPending > 0 && (
            <IconButton icon="inbox" label="Inbox" badge={otherPending} tone="warn" onClick={() => navigate({ name: "inbox" })} />
          )}
          {agent && onDetails && <IconButton icon="more" label="Agent details" onClick={onDetails} />}
        </>
      }
      below={
        readOnly ? (
          <div className="flex items-center justify-center gap-1.5 border-t border-line/60 bg-accent/[0.06] py-1.5 text-[12.5px] font-medium text-accent">
            <Icon name="eye" size={15} />
            Live view · read-only
          </div>
        ) : null
      }
    >
      {agent && id && meta ? (
        <div className="flex min-w-0 items-center gap-2.5">
          <ProviderBadge agent={agent} size={32} />
          <div className="min-w-0">
            <h1 className="truncate text-[15.5px] leading-tight font-semibold text-fg">{agent.title}</h1>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] leading-tight text-muted">
              <StatusDot status={agent.status} size={7} />
              <span className="shrink-0" style={{ color: agent.status === "idle" || agent.status === "stopped" ? undefined : meta.color }}>
                {meta.label}
              </span>
              <span className="text-line-strong">·</span>
              <span className="truncate">{account ? account.name : id.short}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="skeleton h-5 w-40" />
      )}
    </TopBar>
  );
}

function TimelineSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading conversation">
      <div className="ml-auto h-16 w-[70%] skeleton rounded-[20px]" />
      <div className="space-y-2">
        <div className="skeleton h-3.5 w-[92%]" />
        <div className="skeleton h-3.5 w-[84%]" />
        <div className="skeleton h-3.5 w-[60%]" />
      </div>
      <div className="skeleton h-[148px] w-full rounded-2xl" />
      <div className="space-y-2">
        <div className="skeleton h-3.5 w-[88%]" />
        <div className="skeleton h-3.5 w-[40%]" />
      </div>
    </div>
  );
}

const PIN_THRESHOLD = 96;

function distanceFromBottom() {
  const el = document.scrollingElement ?? document.documentElement;
  return el.scrollHeight - (window.scrollY + window.innerHeight);
}

function scrollToBottom(smooth = false) {
  const el = document.scrollingElement ?? document.documentElement;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduce ? "smooth" : "instant" });
}

function AgentView({
  agent,
  timeline,
  pending,
  readOnly,
}: {
  agent: Agent;
  timeline: TimelineState | undefined;
  pending: PendingPrompt[];
  readOnly: boolean;
}) {
  const [draft, setDraft] = useState(() => loadDraft(agent.id));
  const [details, setDetails] = useState(devParam("sheet") === "details");
  const [jump, setJump] = useState<null | "idle" | "new">(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const initialScrollDone = useRef(false);
  const ready = timeline?.status === "ready";
  const items = timeline?.items;

  // Track whether the reader is following the bottom.
  useEffect(() => {
    const onScroll = () => {
      const d = distanceFromBottom();
      pinned.current = d < PIN_THRESHOLD;
      setJump((j) => (d > 320 ? (j ?? "idle") : null));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // First paint of a loaded timeline starts at the newest message.
  useLayoutEffect(() => {
    if (ready && !initialScrollDone.current) {
      initialScrollDone.current = true;
      scrollToBottom();
      pinned.current = true;
    }
  }, [ready]);

  // Follow growth (new items, streaming text) while pinned.
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastHeight = el.offsetHeight;
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      const grew = h > lastHeight;
      lastHeight = h;
      if (!grew || !initialScrollDone.current) return;
      if (isUserLayoutChange()) return;
      if (pinned.current) scrollToBottom();
      else setJump("new");
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const editPrompt = useCallback((text: string) => setDraft(text), []);

  const banner = !readOnly ? <StatusBanner agent={agent} readOnly={false} /> : null;

  return (
    <div className="flex min-h-dvh flex-col">
      <DetailHeader agent={agent} readOnly={readOnly} onDetails={() => setDetails(true)} />
      <main className="mx-auto w-full max-w-[860px] flex-1 px-safe pt-4 pb-6">
        <div ref={listRef}>
          {!timeline || (timeline.status === "loading" && !timeline.items.length) ? (
            <TimelineSkeleton />
          ) : timeline.status === "error" ? (
            <ErrorState title="Couldn't load this conversation" body={timeline.error} onRetry={() => void loadTimeline(agent.id)} />
          ) : items && items.length === 0 && pending.length === 0 ? (
            <EmptyState
              icon="sparkle"
              title="No messages yet"
              body={readOnly ? "Messages will appear here as the agent works." : "Send a prompt to get this agent started."}
            />
          ) : (
            <Timeline agent={agent} items={items ?? []} pending={pending} readOnly={readOnly} onEditPrompt={editPrompt} />
          )}
          {readOnly && <StatusBanner agent={agent} readOnly inline />}
        </div>
      </main>

      {jump && (
        <div className="pointer-events-none sticky bottom-[calc(76px+var(--safe-bottom))] z-20 flex justify-center">
          <button
            type="button"
            onClick={() => {
              pinned.current = true;
              setJump(null);
              scrollToBottom(true);
            }}
            className={`press animate-enter pointer-events-auto mb-2 inline-flex h-10 items-center gap-1.5 rounded-full border px-4 text-[13px] font-semibold shadow-[0_10px_30px_-10px_rgba(0,0,0,0.8)] ${
              jump === "new" ? "border-accent/50 bg-accent text-accent-fg" : "border-line-strong bg-raised text-fg"
            }`}
          >
            <Icon name="arrowDown" size={16} strokeWidth={2.2} />
            {jump === "new" ? "New activity" : "Latest"}
          </button>
        </div>
      )}

      {!readOnly && <Composer agent={agent} value={draft} onChange={setDraft} banner={banner} />}
      {readOnly && <div className="h-[var(--safe-bottom)]" />}

      <AgentDetailsSheet agent={agent} open={details} onClose={() => setDetails(false)} readOnly={readOnly} />
    </div>
  );
}

/** Resume / error context shown just above the composer. */
function StatusBanner({ agent, readOnly, inline = false }: { agent: Agent; readOnly: boolean; inline?: boolean }) {
  const resuming = useStore((s) => !!s.busy[`resume:${agent.id}`]);
  let tone: "violet" | "err" | "steel" | null = null;
  let text = "";
  if (agent.status === "interrupted") {
    tone = "violet";
    text = "Interrupted when Armada closed. Resume to continue the session.";
  } else if (agent.status === "stopped") {
    tone = "steel";
    text = "This agent was stopped. Resume to continue the session.";
  } else if (agent.status === "error") {
    tone = "err";
    text = agent.rateLimited
      ? "Usage limit reached on this account. Try again later or switch accounts on your computer."
      : "The last turn failed. Send a message to try again.";
  }
  if (!tone) return null;
  const color = tone === "violet" ? "var(--violet)" : tone === "err" ? "var(--err)" : "var(--steel)";
  const resumable = !readOnly && isResumable(agent.status);
  return (
    <div className={inline ? "mt-5" : "mx-auto w-full max-w-[860px] px-safe pt-2.5"}>
      <div
        role="status"
        className="flex items-center gap-3 rounded-2xl border py-2 pr-2 pl-3.5"
        style={{
          color,
          borderColor: `color-mix(in srgb, ${color} 30%, var(--border))`,
          background: `color-mix(in srgb, ${color} 8%, var(--bg-1))`,
        }}
      >
        <Icon name={tone === "err" ? "alertCircle" : "info"} size={18} className="shrink-0" />
        <p className="min-w-0 flex-1 py-1 text-[13px] leading-snug text-fg/90">{text}</p>
        {resumable && (
          <Button size="sm" variant="primary" icon="play" loading={resuming} onClick={() => void resumeAgent(agent.id)}>
            Resume
          </Button>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-h-11 items-start gap-4 py-2.5">
      <dt className="w-[34%] shrink-0 text-[13.5px] text-muted">{label}</dt>
      <dd className={`min-w-0 flex-1 text-right text-[14px] break-words text-fg ${mono ? "font-mono text-[12.5px] leading-5" : ""}`}>{children}</dd>
    </div>
  );
}

function AgentDetailsSheet({ agent, open, onClose, readOnly }: { agent: Agent; open: boolean; onClose: () => void; readOnly: boolean }) {
  const accounts = useStore((s) => s.accounts);
  const customAgents = useStore((s) => s.customAgents);
  const now = useNow();
  const resuming = useStore((s) => !!s.busy[`resume:${agent.id}`]);
  const cancelling = useStore((s) => !!s.busy[`cancel:${agent.id}`]);
  const account = accounts[agent.accountId];
  const id = agentIdentity(agent, customAgents);
  const modelOpt = agent.configOptions?.find((o) => o.category === "model");
  const model = modelOpt ? (modelOpt.options.find((o) => o.value === modelOpt.currentValue)?.name ?? modelOpt.currentValue) : null;
  const ctx = agent.contextUsed != null && agent.contextSize ? agent.contextUsed / agent.contextSize : null;

  return (
    <Sheet open={open} onClose={onClose} title={agent.title} description={`${id.name}${model ? ` · ${model}` : ""}`}>
      <dl className="divide-y divide-line/70">
        <DetailRow label="Status">
          <span className="inline-flex items-center gap-1.5">
            <StatusDot status={agent.status} size={7} />
            {statusMeta(agent.status).label}
          </span>
        </DetailRow>
        {account && (
          <DetailRow label="Account">
            <span className="inline-flex items-center gap-1.5">
              <AccountDot color={safeColor(account.color)} />
              {account.name}
              {account.label && <span className="text-muted">· {account.label}</span>}
            </span>
          </DetailRow>
        )}
        <DetailRow label="Project">
          <span title={agent.projectPath}>{basename(agent.projectPath)}</span>
        </DetailRow>
        {agent.branch && (
          <DetailRow label={agent.worktree ? "Worktree branch" : "Branch"} mono>
            {agent.branch}
          </DetailRow>
        )}
        <DetailRow label="Folder" mono>
          {agent.cwd}
        </DetailRow>
        <DetailRow label="Cost">
          <span className="tabular">{formatCost(agent.costUsd)}</span>
        </DetailRow>
        <DetailRow label="Tokens">
          <span className="tabular">{formatTokens(agent.tokensUsed)}</span>
        </DetailRow>
        {ctx !== null && (
          <DetailRow label="Context">
            <span className="inline-flex items-center gap-2">
              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-raised" aria-hidden>
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${Math.min(100, ctx * 100)}%`, background: ctx > 0.85 ? "var(--warn)" : "var(--accent)" }}
                />
              </span>
              <span className="tabular">{Math.round(ctx * 100)}%</span>
            </span>
          </DetailRow>
        )}
        <DetailRow label="Last activity">{relativeTimeLong(agent.lastActivityAt, now)}</DetailRow>
        {agent.scheduleId && <DetailRow label="Started by">A schedule</DetailRow>}
      </dl>
      {!readOnly && isResumable(agent.status) && (
        <Button
          variant="primary"
          size="lg"
          icon="play"
          className="mt-4 w-full"
          loading={resuming}
          onClick={() => {
            void resumeAgent(agent.id);
            onClose();
          }}
        >
          Resume session
        </Button>
      )}
      {!readOnly && isBusy(agent.status) && (
        <Button
          variant="danger"
          size="lg"
          icon="stop"
          className="mt-4 w-full"
          loading={cancelling}
          onClick={() => {
            void cancelTurn(agent.id);
            onClose();
          }}
        >
          Stop this turn
        </Button>
      )}
    </Sheet>
  );
}
