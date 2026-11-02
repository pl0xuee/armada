import { memo, useEffect, useMemo, useState } from "react";
import { isPlanApproval, planTitle } from "@shared/planApproval";
import { HoldBody } from "@/components/BudgetHold";
import { DenyReasonSheet } from "@/components/DenyReasonSheet";
import { AccountDot, ProviderBadge } from "@/components/Identity";
import { Icon } from "@/components/Icon";
import { OptionsSheet } from "@/components/OptionsSheet";
import { QuestionSheet, QuickAnswer } from "@/components/QuickAnswer";
import { Swipeable } from "@/components/Swipeable";
import { PermissionSubject } from "@/components/timeline/Permission";
import { TOOL_ICON } from "@/components/timeline/Items";
import { ConnectionPill, TopBar } from "@/components/TopBar";
import { Button, IconButton } from "@/components/ui";
import { cn } from "@/lib/cn";
import { acknowledgeAgent, loadPermissions, resumeAgent, respondToPermission, respondWithUndo, retryAgent, retryState } from "@/lib/controller";
import { devParam } from "@/lib/dev";
import { diffStats } from "@/lib/diff";
import { basename, plainPreview, plural, relativeTime } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import {
  agentIdentity,
  allowOnce,
  confirmOption,
  isAlways,
  primaryAllow,
  primaryReject,
  rejectOnce,
  safeColor,
  swipeable,
} from "@/lib/meta";
import { primaryFields } from "@/lib/question";
import { switchableAccounts, AccountSheet } from "./AgentControls";
import { goBack, navigate } from "@/lib/router";
import { accountOf, useInbox, useTriage, type InboxEntry } from "@/lib/selectors";
import { holdLabel, type HoldLike } from "@/lib/budgetHold";
import { reasonLabel, triageSections, needsYouLabel, type TriageEntry, type NeedsReason } from "@/lib/triage";
import { questionHeadline } from "@/lib/dock";
import { planChoices } from "@shared/planApproval";
import { useStore } from "@/lib/store";
import type { Agent, PermissionItem, PermissionOption, QuestionItem } from "@/lib/types";
import { EmptyState, ErrorState } from "./States";

const EXIT_MS = 170;

export function Inbox() {
  const inbox = useInbox();
  const triage = useTriage();
  const resolving = useStore((s) => s.resolving);
  const stateStatus = useStore((s) => s.stateStatus);
  const stateError = useStore((s) => s.stateError);
  const now = useNow();
  const [optionsFor, setOptionsFor] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [questionFor, setQuestionFor] = useState<string | null>(null);
  const [switchFor, setSwitchFor] = useState<string | null>(null);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    void loadPermissions();
  }, []);

  // Answered requests leave the list immediately (and come back if sending fails).
  const entries = useMemo(() => inbox.entries.filter((e) => !resolving[e.item.requestId]), [inbox.entries, resolving]);
  const itemsByAgent = useMemo(() => {
    const m = new Map<string, InboxEntry[]>();
    for (const e of entries) m.set(e.agent.id, [...(m.get(e.agent.id) ?? []), e]);
    return m;
  }, [entries]);
  const sections = useMemo(() => triageSections(triage.queue), [triage.queue]);

  const devSheet = devParam("sheet") === "options";
  useEffect(() => {
    const first = entries.find((e) => e.item.kind === "permission");
    if (devSheet && first && optionsFor === null) setOptionsFor(first.item.requestId);
  }, [devSheet, entries, optionsFor]);

  const sheetEntry = useMemo(() => {
    for (const e of entries) if (e.item.kind === "permission" && e.item.requestId === optionsFor) return { agent: e.agent, item: e.item };
    return null;
  }, [entries, optionsFor]);

  // Gone from the list once the deny is sent: the sheet then closes itself.
  const reasonItem = useMemo(() => {
    for (const e of entries) if (e.item.kind === "permission" && e.item.requestId === reasonFor) return e.item;
    return null;
  }, [entries, reasonFor]);
  const questionEntry = useMemo(() => {
    for (const e of entries) if (e.item.kind === "question" && e.item.requestId === questionFor) return e;
    return null;
  }, [entries, questionFor]);
  const switchAgent = switchFor ? (triage.queue.find((e) => e.agent.id === switchFor)?.agent ?? null) : null;

  const swipeHint = entries.some((e) => e.item.kind === "permission" && swipeable(e.item) && (allowOnce(e.item) || rejectOnce(e.item)));
  let body;
  if (stateStatus !== "ready" && !triage.queue.length) {
    body = stateStatus === "error" ? <ErrorState title="Couldn't load requests" body={stateError} onRetry={retryState} /> : <InboxSkeleton count={2} />;
  } else if (!triage.queue.length && !inbox.loading && !inbox.failed) {
    body = (
      <EmptyState
        icon="shieldCheck"
        tone="ok"
        title="You're all caught up"
        body="When an agent needs approval, has a question, hits a limit or finishes, it shows up here."
        action={{ label: "Back to agents", onClick: () => navigate({ name: "fleet" }, { replace: true }) }}
      />
    );
  } else {
    body = (
      <div className="space-y-6">
        {swipeHint && (
          <p className="mb-3 flex items-center justify-center gap-1.5 text-center text-[12.5px] text-steel [@media(pointer:fine)]:hidden">
            Swipe right to approve, left to deny
          </p>
        )}
        {sections.map((sec) => (
          <section key={sec.id} aria-labelledby={`needs-${sec.id}`} className="space-y-3">
            <h2 id={`needs-${sec.id}`} className={cn("flex items-center gap-1.5 px-1 text-[12px] font-semibold tracking-[0.08em] uppercase", sec.id === "blocked" ? "text-warn" : "text-steel")}>
              {sec.label}
              <span className="tabular opacity-80">{sec.entries.length}</span>
            </h2>
            {sec.entries.map((e) => (
              <QueueEntry
                key={e.agent.id}
                entry={e}
                items={itemsByAgent.get(e.agent.id)}
                loading={inbox.loading}
                now={now}
                onMore={setOptionsFor}
                onForm={setQuestionFor}
                onSwitch={setSwitchFor}
              />
            ))}
          </section>
        ))}
        {inbox.failed && (
          <div className="flex items-center gap-3 rounded-2xl border border-err/30 bg-err/[0.06] p-3" role="alert">
            <Icon name="alertCircle" size={18} className="shrink-0 text-err" />
            <p className="min-w-0 flex-1 text-[13.5px] text-fg">Couldn't load the requests.</p>
            <Button size="sm" variant="secondary" onClick={() => void loadPermissions()}>
              Retry
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar left={<IconButton icon="chevronLeft" label="Back to agents" onClick={goBack} />} right={<ConnectionPill className="mr-2" />}>
        <div className="min-w-0">
          <h1 className="text-[17px] leading-tight font-semibold text-fg">Needs you</h1>
          <p className="text-[12px] leading-tight text-muted">{triage.count ? needsYouLabel(triage.count) : "Nothing waiting"}</p>
        </div>
      </TopBar>
      <main className="mx-auto w-full max-w-[860px] flex-1 px-safe pt-4 pb-[calc(24px+var(--safe-bottom))]">{body}</main>
      <OptionsSheet
        entry={sheetEntry}
        onClose={() => setOptionsFor(null)}
        onDenyWithReason={(id) => {
          setOptionsFor(null);
          setReasonFor(id);
        }}
      />
      <DenyReasonSheet item={reasonItem} onClose={() => setReasonFor(null)} />
      <QuestionSheet item={questionEntry?.item.kind === "question" ? questionEntry.item : null} title={questionEntry?.agent.title ?? ""} onClose={() => setQuestionFor(null)} />
      {switchAgent && <AccountSheet agent={switchAgent} open onClose={() => setSwitchFor(null)} />}
    </div>
  );
}

/** One agent in the queue: its open requests (approvals, questions, a plan), or what blocks or finished it. */
function QueueEntry({
  entry,
  items,
  loading,
  now,
  onMore,
  onForm,
  onSwitch,
}: {
  entry: TriageEntry;
  items: InboxEntry[] | undefined;
  loading: boolean;
  now: number;
  onMore: (requestId: string) => void;
  onForm: (requestId: string) => void;
  onSwitch: (agentId: string) => void;
}) {
  const { agent, reason } = entry;
  if (reason === "permission") {
    if (items?.length) return <>{items.map((e) => <InboxCard key={e.item.requestId} entry={e} now={now} onMore={() => onMore(e.item.requestId)} onForm={() => onForm(e.item.requestId)} />)}</>;
    return loading ? <InboxSkeleton count={1} /> : <WaitingCard agent={agent} now={now} />;
  }
  if (reason === "done") return <DoneCard agent={agent} now={now} />;
  if (reason === "budget" && agent.budgetHold) return <BudgetCard agent={agent} hold={agent.budgetHold} now={now} />;
  return <RecoveryCard agent={agent} reason={reason} now={now} onSwitch={() => onSwitch(agent.id)} />;
}

function useExit(): [boolean, (fn: () => void) => void] {
  const [leaving, setLeaving] = useState(false);
  const run = (fn: () => void) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return fn();
    setLeaving(true);
    setTimeout(() => {
      fn();
      setLeaving(false);
    }, EXIT_MS);
  };
  return [leaving, run];
}

const InboxCard = memo(function InboxCard({ entry, now, onMore, onForm }: { entry: InboxEntry; now: number; onMore: () => void; onForm: () => void }) {
  const { agent, item } = entry;
  return item.kind === "question" ? (
    <QuestionInboxCard agent={agent} item={item} now={now} onForm={onForm} />
  ) : isPlanApproval(item) ? (
    <PlanInboxCard agent={agent} item={item} now={now} />
  ) : (
    <PermissionInboxCard agent={agent} item={item} now={now} onMore={onMore} />
  );
});

/** Who is waiting and for how long: the tappable top row shared by both card kinds. */
function CardHeader({ agent, ts, now }: { agent: Agent; ts: number; now: number }) {
  const account = useStore((s) => accountOf(s.accounts, agent));
  const customAgents = useStore((s) => s.customAgents);
  const waitingMin = (now - ts) / 60_000;
  return (
    <button
      type="button"
      onClick={() => navigate({ name: "agent", agentId: agent.id })}
      className="press-row flex w-full items-center gap-3 border-b border-line/70 px-4 py-3 text-left"
    >
      <ProviderBadge agent={agent} size={34} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14.5px] font-semibold text-fg">{agent.title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted">
          {account ? (
            <>
              <AccountDot color={safeColor(account.color)} size={7} />
              <span className="truncate">{account.name}</span>
            </>
          ) : (
            <span className="truncate">{agentIdentity(agent, customAgents).short}</span>
          )}
          {agent.projectPath && (
            <>
              <span className="text-line-strong">·</span>
              <span className="truncate text-steel">{basename(agent.projectPath)}</span>
            </>
          )}
        </span>
      </span>
      <span
        className={cn("inline-flex shrink-0 items-center gap-1 text-[12.5px] tabular", waitingMin >= 5 ? "text-warn" : "text-steel")}
        aria-label={`Waiting ${relativeTime(ts, now)}`}
      >
        <Icon name="clock" size={14} />
        {relativeTime(ts, now)}
      </span>
    </button>
  );
}

/** A question isn't swipe-approvable: it shows what's asked and opens the agent to answer. */
function QuestionInboxCard({ agent, item, now, onForm }: { agent: Agent; item: QuestionItem; now: number; onForm: () => void }) {
  const fields = primaryFields(item.fields);
  const titles = fields.map((f) => f.title || f.description).filter(Boolean);
  const message = questionHeadline(item);
  return (
    <div className="animate-enter">
      <article
        aria-label={`${agent.title}: ${message}`}
        className="overflow-hidden rounded-2xl border border-line-strong bg-card shadow-[0_12px_32px_-20px_rgba(0,0,0,0.9)] edge-strong"
      >
        <CardHeader agent={agent} ts={item.ts} now={now} />
        <div className="space-y-3 p-4">
          <div className="flex items-start gap-2.5">
            <span className="mt-px inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-warn/12 text-warn">
              <Icon name="sparkle" size={16} />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <h2 className="text-[15.5px] leading-snug font-semibold break-words text-fg">{message}</h2>
              {(item.source || fields.length > 1) && (
                <p className="mt-0.5 truncate text-[12.5px] text-muted">
                  {[item.source, fields.length > 1 ? (titles.length === fields.length ? titles.join(" · ") : plural(fields.length, "question")) : null]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
            </div>
          </div>
          <QuickAnswer item={item} onOpenForm={onForm} />
        </div>
      </article>
    </div>
  );
}

/** A plan: approve it here with the adapter's preferred choice, or open the agent to read it first. */
function PlanInboxCard({ agent, item, now }: { agent: Agent; item: PermissionItem; now: number }) {
  const first = planChoices(item).approve[0];
  return (
    <div className="animate-enter">
      <article
        aria-label={`${agent.title}: plan ready for approval`}
        className="overflow-hidden rounded-2xl border border-line-strong bg-card shadow-[0_12px_32px_-20px_rgba(0,0,0,0.9)] edge-strong"
      >
        <CardHeader agent={agent} ts={item.ts} now={now} />
        <div className="space-y-3 p-4">
          <div className="flex items-start gap-2.5">
            <span className="mt-px inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-warn/12 text-warn">
              <Icon name="bookText" size={16} />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <h2 className="text-[15.5px] leading-snug font-semibold break-words text-fg">Plan ready for approval</h2>
              <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted">{planTitle(item.plan ?? "")}</p>
            </div>
          </div>
          {first && (
            <Button size="lg" variant="primary" icon="check" className="w-full" onClick={() => void respondToPermission(agent.id, item.requestId, first.option.id)}>
              <span className="truncate">{first.label}</span>
            </Button>
          )}
          <Button size="md" variant="secondary" icon="bookText" className="w-full" onClick={() => navigate({ name: "agent", agentId: agent.id })}>
            Read the plan
          </Button>
        </div>
      </article>
    </div>
  );
}

const PermissionInboxCard = memo(function PermissionInboxCard({
  agent,
  item,
  now,
  onMore,
}: {
  agent: Agent;
  item: PermissionItem;
  now: number;
  onMore: () => void;
}) {
  const [leaving, exit] = useExit();
  const [showDiff, setShowDiff] = useState(false);
  // The big buttons always read "Deny" / "Approve" (the desktop's wording). Swipes only ever
  // mean the one-shot options; without one the button falls back to the closest option (an
  // "always" one asks to confirm) and the agent's own option names stay under "More options".
  const allowSafe = allowOnce(item);
  const rejectSafe = rejectOnce(item);
  const allow = allowSafe ?? primaryAllow(item);
  const reject = rejectSafe ?? primaryReject(item);
  const extra = item.options.length - (allow ? 1 : 0) - (reject ? 1 : 0);
  const stats = useMemo(() => (item.diffs.length ? diffStats(item.diffs) : null), [item.diffs]);
  const respond = async (o: PermissionOption) => {
    if (await confirmOption(o)) void respondToPermission(agent.id, item.requestId, o.id);
  };
  const canSwipe = swipeable(item);
  const swipe = (o: PermissionOption, verb: string) => () => respondWithUndo(agent.id, item.requestId, o.id, verb, item.title);

  return (
    <div className={cn("transition-[opacity,transform] duration-150", leaving ? "scale-[0.98] opacity-0" : "animate-enter")}>
      <Swipeable
        rightLabel="Approve"
        leftLabel="Deny"
        onSwipeRight={canSwipe && allowSafe ? swipe(allowSafe, "Approved") : undefined}
        onSwipeLeft={canSwipe && rejectSafe ? swipe(rejectSafe, "Denied") : undefined}
      >
        <article
          aria-label={`${agent.title}: ${item.title}`}
          className="overflow-hidden rounded-2xl border border-line-strong bg-card shadow-[0_12px_32px_-20px_rgba(0,0,0,0.9)] edge-strong"
        >
          <CardHeader agent={agent} ts={item.ts} now={now} />

          <div className="space-y-3 p-4">
            <div className="flex items-start gap-2.5">
              <span className="mt-px inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-warn/12 text-warn">
                <Icon name={item.toolKind ? TOOL_ICON[item.toolKind] : "shield"} size={16} />
              </span>
              <h2 className="min-w-0 flex-1 pt-0.5 text-[15.5px] leading-snug font-semibold break-words text-fg">{item.title}</h2>
            </div>

            <div data-noswipe className="space-y-2">
              {item.command && <PermissionSubject item={{ ...item, diffs: [] }} />}
              {stats && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowDiff((v) => !v)}
                    aria-expanded={showDiff}
                    className="press-row flex min-h-11 w-full items-center gap-2 rounded-xl border border-line bg-code px-3 text-left text-[13px]"
                  >
                    <Icon name="pencil" size={15} className="shrink-0 text-steel" />
                    <span className="min-w-0 flex-1 truncate text-fg">
                      {stats.files === 1 ? basename(item.diffs[0]?.path ?? "1 file") : `${stats.files} files`}
                    </span>
                    <span className="shrink-0 font-mono text-[12px] tabular">
                      <span className="text-ok">+{stats.additions}</span> <span className="text-err">−{stats.deletions}</span>
                    </span>
                    <span className="shrink-0 text-[12.5px] font-medium text-accent">{showDiff ? "Hide" : "Review"}</span>
                  </button>
                  {showDiff && <PermissionSubject item={{ ...item, command: null }} />}
                </>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <Button
                size="lg"
                variant="danger"
                icon="x"
                disabled={!reject}
                aria-label={reject ? `Deny: ${reject.name}` : "Deny"}
                onClick={() => reject && (isAlways(reject) ? void respond(reject) : exit(() => void respond(reject)))}
              >
                Deny
              </Button>
              <Button
                size="lg"
                variant="primary"
                icon="check"
                disabled={!allow}
                aria-label={allow ? `Approve: ${allow.name}` : "Approve"}
                onClick={() => allow && (isAlways(allow) ? void respond(allow) : exit(() => void respond(allow)))}
              >
                Approve
              </Button>
            </div>
            <div className="-mx-2 -mb-2 flex items-center justify-between">
              <button
                type="button"
                onClick={onMore}
                className="press inline-flex h-11 items-center gap-1 rounded-xl px-2 text-[13.5px] font-medium text-muted active:text-fg"
              >
                <Icon name="more" size={18} />
                {extra > 0 ? `More options (${extra})` : "More options"}
              </button>
              <button
                type="button"
                onClick={() => navigate({ name: "agent", agentId: agent.id })}
                className="press inline-flex h-11 items-center gap-1 rounded-xl px-2 text-[13.5px] font-medium text-muted active:text-fg"
              >
                Open agent
                <Icon name="chevronRight" size={16} />
              </button>
            </div>
          </div>
        </article>
      </Swipeable>
    </div>
  );
});

/** The agent says it waits on you but its request isn't known here (yet): open it to see. */
function WaitingCard({ agent, now }: { agent: Agent; now: number }) {
  return (
    <article aria-label={`${agent.title}: waiting for you`} className="animate-enter overflow-hidden rounded-2xl border border-line-strong bg-card edge-strong">
      <CardHeader agent={agent} ts={agent.lastActivityAt} now={now} />
      <div className="p-4">
        <Button size="lg" variant="primary" icon="chevronRight" className="w-full" onClick={() => navigate({ name: "agent", agentId: agent.id })}>
          Open agent
        </Button>
      </div>
    </article>
  );
}

const lastNotice = (items: readonly { kind: string; level?: string; text?: string }[] | undefined): string | null => {
  for (let i = (items?.length ?? 0) - 1; i >= 0; i--) {
    const it = items![i];
    if (it.kind === "notice" && it.level === "error" && it.text) return it.text;
    if (it.kind === "user_message") return null;
  }
  return null;
};

/** A rate limit or an error: what happened, and the way out (switch account, retry or resume). */
function RecoveryCard({ agent, reason, now, onSwitch }: { agent: Agent; reason: NeedsReason; now: number; onSwitch: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const notice = useStore((s) => lastNotice(s.timelines[agent.id]?.items));
  const resuming = useStore((s) => !!s.busy[`resume:${agent.id}`]);
  const limited = reason === "rate_limited";
  const canSwitch = switchableAccounts(agent, accounts).length > 1;
  const text = notice ?? (agent.lastMessage ? plainPreview(agent.lastMessage) : limited ? "Paused until the limit resets, or switch to another account." : "Something went wrong.");
  const color = limited ? "var(--warn)" : "var(--err)";
  return (
    <div className="animate-enter">
      <article aria-label={`${agent.title}: ${reasonLabel(reason)}`} className="overflow-hidden rounded-2xl border border-line-strong bg-card shadow-[0_12px_32px_-20px_rgba(0,0,0,0.9)] edge-strong">
        <CardHeader agent={agent} ts={agent.lastActivityAt} now={now} />
        <div className="space-y-3 p-4">
          <div className="flex items-start gap-2.5">
            <span className="mt-px inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}>
              <Icon name={limited ? "gauge" : "alertCircle"} size={16} />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <h2 className="text-[15.5px] leading-snug font-semibold text-fg">{limited ? "This account hit its rate limit" : "The last turn failed"}</h2>
              <p className="mt-0.5 line-clamp-3 text-[13px] leading-snug break-words text-muted">{text}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {limited && canSwitch ? (
              <Button size="lg" variant="primary" icon="user" onClick={onSwitch}>
                Switch account
              </Button>
            ) : (
              <Button size="lg" variant="primary" icon={agent.running ? "refresh" : "play"} loading={resuming} onClick={() => void (agent.running ? retryAgent(agent.id) : resumeAgent(agent.id))}>
                {agent.running ? "Retry" : "Resume"}
              </Button>
            )}
            <Button size="lg" variant="secondary" onClick={() => void acknowledgeAgent(agent.id)}>
              Mark done
            </Button>
          </div>
          <CardFooter agent={agent} showSwitch={!limited && canSwitch} onSwitch={onSwitch} />
        </div>
      </article>
    </div>
  );
}

/** An agent held at a limit: what it reached, and how to go on. */
function BudgetCard({ agent, hold, now }: { agent: Agent; hold: HoldLike; now: number }) {
  return (
    <div className="animate-enter">
      <article aria-label={`${agent.title}: ${holdLabel(hold)}`} className="overflow-hidden rounded-2xl border border-line-strong bg-card shadow-[0_12px_32px_-20px_rgba(0,0,0,0.9)] edge-strong">
        <CardHeader agent={agent} ts={agent.budgetHold?.since ?? agent.lastActivityAt} now={now} />
        <div className="p-4">
          <HoldBody agent={agent} hold={hold} onContinued={() => navigate({ name: "agent", agentId: agent.id })} />
        </div>
      </article>
    </div>
  );
}

function CardFooter({ agent, showSwitch, onSwitch }: { agent: Agent; showSwitch?: boolean; onSwitch?: () => void }) {
  return (
    <div className="-mx-2 -mb-2 flex items-center justify-between">
      {showSwitch ? (
        <button type="button" onClick={onSwitch} className="press inline-flex h-11 items-center gap-1 rounded-xl px-2 text-[13.5px] font-medium text-muted active:text-fg">
          <Icon name="user" size={16} />
          Switch account
        </button>
      ) : (
        <span />
      )}
      <button type="button" onClick={() => navigate({ name: "agent", agentId: agent.id })} className="press inline-flex h-11 items-center gap-1 rounded-xl px-2 text-[13.5px] font-medium text-muted active:text-fg">
        Open agent
        <Icon name="chevronRight" size={16} />
      </button>
    </div>
  );
}

/** Finished work waiting to be looked at: the last words, open it or mark it done. */
function DoneCard({ agent, now }: { agent: Agent; now: number }) {
  const preview = agent.lastMessage ? plainPreview(agent.lastMessage) : "The agent finished.";
  return (
    <div className="animate-enter">
      <article aria-label={`${agent.title}: finished`} className="overflow-hidden rounded-2xl border border-line bg-card edge">
        <CardHeader agent={agent} ts={agent.lastActivityAt} now={now} />
        <div className="space-y-3 p-4">
          <div className="flex items-start gap-2.5">
            <span className="mt-px inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ok/12 text-ok">
              <Icon name="check" size={16} strokeWidth={2.2} />
            </span>
            <p className="line-clamp-4 min-w-0 flex-1 pt-0.5 text-[14px] leading-[1.5] break-words text-fg/90">{preview}</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button size="lg" variant="secondary" icon="chevronRight" onClick={() => navigate({ name: "agent", agentId: agent.id })}>
              Open
            </Button>
            <Button size="lg" variant="primary" icon="check" onClick={() => void acknowledgeAgent(agent.id)}>
              Mark done
            </Button>
          </div>
        </div>
      </article>
    </div>
  );
}

function InboxSkeleton({ count }: { count: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading requests">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-2xl border border-line bg-card">
          <div className="flex items-center gap-3 border-b border-line/70 px-4 py-3">
            <div className="skeleton h-[34px] w-[34px] rounded-[10px]" />
            <div className="flex-1 space-y-1.5">
              <div className="skeleton h-3.5 w-[50%]" />
              <div className="skeleton h-3 w-[30%]" />
            </div>
          </div>
          <div className="space-y-3 p-4">
            <div className="skeleton h-4 w-[70%]" />
            <div className="skeleton h-11 w-full rounded-xl" />
            <div className="grid grid-cols-2 gap-2">
              <div className="skeleton h-[52px] rounded-[14px]" />
              <div className="skeleton h-[52px] rounded-[14px]" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
