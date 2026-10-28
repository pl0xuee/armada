import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccountDot, ProviderBadge, StatusDot } from "@/components/Identity";
import { Composer, type ComposerHandle } from "@/components/Composer";
import { ImageSource } from "@/components/LocalImage";
import { Icon, Spinner } from "@/components/Icon";
import { Sheet } from "@/components/Sheet";
import { Timeline } from "@/components/timeline/Timeline";
import { TopBar } from "@/components/TopBar";
import { Button, IconButton } from "@/components/ui";
import { loadTimeline, markRead, resumeAgent, unpair } from "@/lib/controller";
import { devParam } from "@/lib/dev";
import { basename, formatCost, formatTokens, plainPreview, relativeTimeLong } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { agentIdentity, isBusy, isResumable, safeColor, statusMeta } from "@/lib/meta";
import { useDelayed } from "@/lib/hooks";
import { goBack, navigate } from "@/lib/router";
import { isUserLayoutChange } from "@/lib/scroll";
import { accountOf, useOtherPendingCount } from "@/lib/selectors";
import { useStore, type PendingPrompt, type Timeline as TimelineState } from "@/lib/store";
import type { Agent, TimelineItem } from "@/lib/types";
import { AccountSheet, AgentActions, OptionSheet, SettingsChips, switchableAccounts } from "./AgentControls";
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

const DetailHeader = memo(function DetailHeader({
  agent,
  readOnly,
  onDetails,
  below,
}: {
  agent: Agent | null;
  readOnly: boolean;
  onDetails?: () => void;
  below?: ReactNode;
}) {
  const accounts = useStore((s) => s.accounts);
  const customAgents = useStore((s) => s.customAgents);
  const otherPending = useOtherPendingCount(agent?.id ?? null);
  const account = agent ? accountOf(accounts, agent) : undefined;
  const id = agent ? agentIdentity(agent, customAgents) : null;
  const meta = agent ? statusMeta(agent.status) : null;

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
      below={readOnly ? <ViewerBar /> : below}
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
});

function ViewerBar() {
  const shared = useStore((s) => s.sharedView);
  return (
    <div className="flex min-h-9 items-center justify-center gap-1.5 border-t border-line/60 bg-accent/[0.06] px-safe text-[12.5px] font-medium text-accent">
      <Icon name="eye" size={15} />
      Live view · read-only
      {shared && (
        <button type="button" onClick={unpair} className="press hit relative ml-2 h-9 rounded-lg px-2 font-semibold text-fg underline-offset-2">
          Back to my agents
        </button>
      )}
    </div>
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
  const composer = useRef<ComposerHandle>(null);
  const [details, setDetails] = useState(devParam("sheet") === "details");
  const [jump, setJump] = useState<null | "idle" | "new">(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const initialScrollDone = useRef(false);
  const ready = timeline?.status === "ready";
  const items = timeline?.items;

  // Track whether the reader is following the bottom.
  useEffect(() => {
    // Pinned state must be current immediately (so auto-follow never fights the
    // reader's finger); the button state only changes when crossing the threshold.
    let away = false;
    const onScroll = () => {
      const d = distanceFromBottom();
      pinned.current = d < PIN_THRESHOLD;
      const nowAway = d > 320;
      if (nowAway !== away) {
        away = nowAway;
        setJump((j) => (nowAway ? (j ?? "idle") : null));
      }
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

  const editPrompt = useCallback((text: string) => composer.current?.setText(text), []);
  const [optionSheet, setOptionSheet] = useState<string | null>(null);
  const [accountSheet, setAccountSheet] = useState(devParam("sheet") === "account");

  // Opening an agent (or new activity while it's open) marks it read; if the
  // app was in the background then, retry when it comes back.
  useEffect(() => {
    if (readOnly || !agent.unread) return;
    const tryMark = () => {
      if (document.visibilityState === "visible") markRead(agent.id);
    };
    tryMark();
    document.addEventListener("visibilitychange", tryMark);
    return () => document.removeEventListener("visibilitychange", tryMark);
  }, [agent.id, agent.unread, readOnly]);

  const openDetails = useCallback(() => setDetails(true), []);
  const chips = useMemo(() => <SettingsChips agent={agent} onPick={setOptionSheet} />, [agent]);
  const banner = useMemo(
    () => (readOnly ? null : <StatusBanner agent={agent} readOnly={false} onSwitchAccount={() => setAccountSheet(true)} />),
    [agent, readOnly],
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <DetailHeader agent={agent} readOnly={readOnly} onDetails={openDetails} below={chips} />
      <main className="mx-auto w-full max-w-[860px] flex-1 px-safe pt-4 pb-6">
        {timeline && <StaleNotice agentId={agent.id} stale={timeline.stale} error={timeline.status === "ready" ? timeline.error : null} />}
        <LiveAnnouncer agent={agent} items={items} />
        {/* A log; announcements come from LiveAnnouncer (rows mount/unmount while scrolling). */}
        <div ref={listRef} role="log" aria-live="off" aria-label="Conversation">
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
            <ImageSource.Provider value={agent.id}>
              <Timeline agent={agent} items={items ?? []} pending={pending} readOnly={readOnly} onEditPrompt={editPrompt} />
            </ImageSource.Provider>
          )}
          {readOnly && <StatusBanner agent={agent} readOnly inline />}
        </div>
      </main>

      {jump && (
        <div
          className="pointer-events-none sticky z-20 flex justify-center"
          style={{ bottom: "calc(var(--composer-h, 0px) + var(--kb, 0px) + max(8px, var(--safe-bottom)))" }}
        >
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

      {!readOnly && <Composer agent={agent} banner={banner} handle={composer} />}
      {readOnly && <div className="h-[var(--safe-bottom)]" />}

      <AgentDetailsSheet
        agent={agent}
        open={details}
        onClose={() => setDetails(false)}
        readOnly={readOnly}
        onPickOption={(id) => {
          setDetails(false);
          setOptionSheet(id);
        }}
        onSwitchAccount={() => {
          setDetails(false);
          setAccountSheet(true);
        }}
      />
      {!readOnly && <OptionSheet agent={agent} optionId={optionSheet} onClose={() => setOptionSheet(null)} />}
      {!readOnly && <AccountSheet agent={agent} open={accountSheet} onClose={() => setAccountSheet(false)} />}
    </div>
  );
}

/** The conversation shown may be out of date (refresh pending or failed). */
function StaleNotice({ agentId, stale, error }: { agentId: string; stale: boolean; error: string | null }) {
  const show = useDelayed(stale, 1_500);
  if (!stale || !show) return null;
  return (
    <div className="animate-fade mb-3 flex min-h-10 items-center gap-2 rounded-xl border border-line bg-panel px-3 text-[12.5px] text-muted" role="status">
      {error ? <Icon name="alertCircle" size={15} className="shrink-0 text-warn" /> : <Spinner size={13} className="shrink-0" />}
      <span className="min-w-0 flex-1">{error ? "Couldn't refresh this conversation." : "Updating…"}</span>
      {error && (
        <button type="button" onClick={() => void loadTimeline(agentId)} className="press h-10 shrink-0 rounded-lg px-2 font-semibold text-accent">
          Retry
        </button>
      )}
    </div>
  );
}

/** Announces each finished agent message to screen readers (once, politely). */
function LiveAnnouncer({ agent, items }: { agent: Agent; items: TimelineItem[] | undefined }) {
  const [text, setText] = useState("");
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!items) return;
    let last: TimelineItem | undefined;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === "agent_message") {
        last = items[i];
        break;
      }
    }
    if (!last || last.kind !== "agent_message") return;
    const streaming = isBusy(agent.status) && items[items.length - 1] === last;
    if (announced.current === null) {
      announced.current = last.id; // don't read out history on open
      return;
    }
    if (streaming || announced.current === last.id || !last.text.trim()) return;
    announced.current = last.id;
    setText(`${agent.title}: ${plainPreview(last.text).slice(0, 280)}`);
  }, [items, agent.status, agent.title]);
  return (
    <div className="sr-only" role="status" aria-live="polite">
      {text}
    </div>
  );
}

/** Resume / error context shown just above the composer. */
function StatusBanner({
  agent,
  readOnly,
  inline = false,
  onSwitchAccount,
}: {
  agent: Agent;
  readOnly: boolean;
  inline?: boolean;
  onSwitchAccount?: () => void;
}) {
  const resuming = useStore((s) => !!s.busy[`resume:${agent.id}`]);
  const accounts = useStore((s) => s.accounts);
  const canSwitch = !readOnly && !!onSwitchAccount && switchableAccounts(agent, accounts).length > 1;
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
      ? canSwitch
        ? "Usage limit reached on this account. Switch accounts to keep going."
        : "Usage limit reached on this account. Try again later."
      : "The last turn failed. Send a message to try again.";
  } else if (agent.rateLimited && canSwitch) {
    tone = "err";
    text = "Usage limit reached on this account. Switch accounts to keep going.";
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
        {agent.rateLimited && canSwitch ? (
          <Button size="sm" variant="primary" icon="user" onClick={onSwitchAccount}>
            Switch
          </Button>
        ) : (
          resumable && (
            <Button size="sm" variant="primary" icon="play" loading={resuming} onClick={() => void resumeAgent(agent.id)}>
              Resume
            </Button>
          )
        )}
      </div>
    </div>
  );
}

/** Share-link viewers can leave the shared view or unpair this device. */
function ViewerAccess({ onDone }: { onDone: () => void }) {
  const shared = useStore((s) => s.sharedView);
  const [confirm, setConfirm] = useState(false);
  if (shared) {
    return (
      <div className="mt-4">
        <p className="mb-3 text-[13px] leading-relaxed text-muted">
          You're viewing a shared link. This device's own pairing is unchanged.
        </p>
        <Button
          variant="secondary"
          size="lg"
          icon="unlink"
          className="w-full"
          onClick={() => {
            onDone();
            unpair();
          }}
        >
          Leave shared view
        </Button>
      </div>
    );
  }
  return confirm ? (
    <div className="mt-4 rounded-2xl border border-err/30 bg-err/[0.06] p-3">
      <p className="text-[14px] text-fg">Unpair this device? You'll need the link again to watch this agent.</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="secondary" onClick={() => setConfirm(false)}>
          Cancel
        </Button>
        <Button variant="danger" icon="unlink" onClick={unpair}>
          Unpair
        </Button>
      </div>
    </div>
  ) : (
    <Button variant="danger" size="lg" icon="unlink" className="mt-4 w-full" onClick={() => setConfirm(true)}>
      Unpair this device
    </Button>
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

function AgentDetailsSheet({
  agent,
  open,
  onClose,
  readOnly,
  onPickOption,
  onSwitchAccount,
}: {
  agent: Agent;
  open: boolean;
  onClose: () => void;
  readOnly: boolean;
  onPickOption: (optionId: string) => void;
  onSwitchAccount: () => void;
}) {
  const accounts = useStore((s) => s.accounts);
  const customAgents = useStore((s) => s.customAgents);
  const now = useNow();
  const account = accountOf(accounts, agent);
  const id = agentIdentity(agent, customAgents);
  const modelOpt = agent.configOptions?.find((o) => o.category === "model");
  const model = modelOpt ? (modelOpt.options.find((o) => o.value === modelOpt.currentValue)?.name ?? modelOpt.currentValue) : null;
  const ctx = agent.contextUsed != null && agent.contextSize ? agent.contextUsed / agent.contextSize : null;

  return (
    <Sheet open={open} onClose={onClose} title={agent.title} description={`${id.name}${model ? ` · ${model}` : ""}`}>
      {!readOnly && <AgentActions agent={agent} onClose={onClose} onPickOption={onPickOption} onSwitchAccount={onSwitchAccount} />}
      {!readOnly && <h3 className="mt-5 mb-1 px-0.5 text-[12px] font-semibold tracking-[0.08em] text-steel uppercase">Details</h3>}
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
        {agent.projectPath && (
          <DetailRow label="Project">
            <span title={agent.projectPath}>{basename(agent.projectPath)}</span>
          </DetailRow>
        )}
        {agent.branch && (
          <DetailRow label={agent.worktree ? "Worktree branch" : "Branch"} mono>
            {agent.branch}
          </DetailRow>
        )}
        {agent.cwd && (
          <DetailRow label="Folder" mono>
            {agent.cwd}
          </DetailRow>
        )}
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
      {readOnly && <ViewerAccess onDone={onClose} />}
    </Sheet>
  );
}
