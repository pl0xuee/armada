import { memo, useEffect, useMemo, useRef, useState } from "react";
import { planChoices, planTitle } from "@shared/planApproval";
import { DenyReasonSheet } from "@/components/DenyReasonSheet";
import { Icon } from "@/components/Icon";
import { OptionsSheet } from "@/components/OptionsSheet";
import { QuestionSheet, QuickAnswer } from "@/components/QuickAnswer";
import { Sheet } from "@/components/Sheet";
import { PlanApprovalCard } from "@/components/timeline/PlanApproval";
import { SubagentList } from "@/components/timeline/LiveStatus";
import { PlanCard } from "@/components/timeline/Items";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { respondToPermission, resumeAgent, retryAgent } from "@/lib/controller";
import {
  dockBlock,
  dockNeed,
  latestPlan,
  lingerStarts,
  planIsLive,
  planPhase,
  planProgress,
  PLAN_LINGER_MS,
  questionHeadline,
  resetClause,
  withoutReset,
  subagentHeadline,
  type DockBlock,
} from "@/lib/dock";
import { useNow } from "@/lib/hooks";
import { allowOnce, confirmOption, isBusy, isResumable, primaryAllow, primaryReject, rejectOnce } from "@/lib/meta";
import { permissionIndex } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import { inheritedConfig, useRunningSubagentList } from "@/lib/subagents";
import { formatElapsed } from "@/lib/thinking";
import type { Agent, PermissionItem, QuestionItem, TimelineItem } from "@/lib/types";
import { switchableAccounts } from "@/screens/AgentControls";

type Sheets = null | "options" | "reason" | "plan" | "question" | "chip-plan" | "chip-subagents";

/**
 * The pinned dock above the composer: what the agent waits on (approval, plan approval, question) or why it
 * is blocked (usage limit, error, interrupted), then one row of chips for the plan's progress and the
 * running sub-agents. Everything is a large tap target; details open in sheets so the dock never grows
 * past what a phone with the keyboard up can spare.
 */
export const Dock = memo(function Dock({ agent, onSwitchAccount }: { agent: Agent; onSwitchAccount: () => void }) {
  const pending = useStore((s) => permissionIndex(s.permissions).get(agent.id));
  const resolving = useStore((s) => s.resolving);
  const need = useMemo(() => dockNeed(pending?.filter((p) => !resolving[p.requestId])), [pending, resolving]);
  const block = need ? null : dockBlock(agent);
  const [sheet, setSheet] = useState<Sheets>(null);
  // The sheet for a request closes by itself once that request is gone.
  const needId = need?.item.requestId ?? null;
  useEffect(() => {
    setSheet((cur) => (cur === "options" || cur === "reason" || cur === "plan" || cur === "question" ? null : cur));
  }, [needId]);

  return (
    <div className="mx-auto w-full max-w-[860px] px-safe">
      {need && <NeedCard agent={agent} need={need} onSheet={setSheet} />}
      {block && <BlockedCard agent={agent} block={block} onSwitchAccount={onSwitchAccount} />}
      <Chips agent={agent} sheet={sheet} onSheet={setSheet} />
      {need && need.kind !== "question" && (
        <>
          <OptionsSheet
            entry={sheet === "options" ? { agent, item: need.item as PermissionItem } : null}
            onClose={() => setSheet(null)}
            onDenyWithReason={() => setSheet("reason")}
          />
          <DenyReasonSheet item={sheet === "reason" ? (need.item as PermissionItem) : null} onClose={() => setSheet(null)} />
        </>
      )}
      {need?.kind === "plan" && <PlanSheet item={sheet === "plan" ? (need.item as PermissionItem) : null} onClose={() => setSheet(null)} />}
      {need?.kind === "question" && (
        <QuestionSheet
          item={sheet === "question" ? (need.item as QuestionItem) : null}
          onClose={() => setSheet(null)}
          title={agent.title}
        />
      )}
    </div>
  );
});

function PlanSheet({ item, onClose }: { item: PermissionItem | null; onClose: () => void }) {
  const [shown, setShown] = useState(item);
  useEffect(() => {
    if (item) setShown(item);
  }, [item]);
  const it = item ?? shown;
  return (
    <Sheet open={!!item} onClose={onClose} title="Plan" description={it ? planTitle(it.plan ?? "") : undefined}>
      {it && <PlanApprovalCard item={it} readOnly={false} inSheet />}
    </Sheet>
  );
}

const CARD =
  "mt-2 overflow-hidden rounded-2xl border border-warn/45 bg-card shadow-[0_0_0_1px_color-mix(in_srgb,var(--warn)_12%,transparent),0_14px_36px_-18px_color-mix(in_srgb,var(--warn)_50%,transparent)] edge";

function CardHeader({
  icon,
  label,
  title,
  mono,
  sub,
  aside,
}: {
  icon: "shield" | "bookText" | "sparkle" | "gauge" | "alertCircle" | "play";
  label: string;
  title?: string;
  mono?: boolean;
  sub?: string | null;
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-3.5 pt-3 pb-2.5">
      <span className="mt-px inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-warn/40 bg-warn/15 text-warn">
        <Icon name={icon} size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11.5px] leading-tight font-semibold tracking-[0.08em] text-warn uppercase">{label}</p>
        {title && (
          <p
            className={cn(
              "mt-0.5 line-clamp-2 text-[14.5px] leading-snug font-medium break-words text-fg",
              mono && "font-mono text-[13px]",
            )}
          >
            {title}
          </p>
        )}
        {sub && <p className="mt-0.5 truncate font-mono text-[12px] text-steel">{sub}</p>}
      </div>
      {aside}
    </div>
  );
}

function NeedCard({
  agent,
  need,
  onSheet,
}: {
  agent: Agent;
  need: NonNullable<ReturnType<typeof dockNeed>>;
  onSheet: (s: Sheets) => void;
}) {
  const more = need.more > 0 ? ` · +${need.more}` : "";
  if (need.kind === "question") {
    const item = need.item as QuestionItem;
    return (
      <section aria-label="Question waiting for your answer" aria-live="polite" className={CARD}>
        <CardHeader icon="sparkle" label={`Question${more}`} title={questionHeadline(item)} />
        <div className="px-3.5 pb-3">
          <QuickAnswer item={item} onOpenForm={() => onSheet("question")} />
        </div>
      </section>
    );
  }
  const item = need.item as PermissionItem;
  if (need.kind === "plan") return <PlanNeed agent={agent} item={item} label={`Plan to approve${more}`} onSheet={onSheet} />;
  return <PermissionNeed agent={agent} item={item} label={`Needs approval${more}`} onSheet={onSheet} />;
}

function DetailsButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="press -mr-1.5 inline-flex h-11 shrink-0 items-center gap-0.5 rounded-xl pr-1 pl-2.5 text-[13.5px] font-medium text-muted active:text-fg"
    >
      Details
      <Icon name="chevronRight" size={16} />
    </button>
  );
}

function PermissionNeed({
  agent,
  item,
  label,
  onSheet,
}: {
  agent: Agent;
  item: PermissionItem;
  label: string;
  onSheet: (s: Sheets) => void;
}) {
  // The big pair reads Deny / Approve like everywhere else; the agent's own option names are under "Details".
  const allow = allowOnce(item) ?? primaryAllow(item);
  const reject = rejectOnce(item) ?? primaryReject(item);
  const respond = async (o: NonNullable<typeof allow>) => {
    if (await confirmOption(o)) void respondToPermission(agent.id, item.requestId, o.id);
  };
  return (
    <section aria-label="Approval needed" aria-live="polite" className={CARD}>
      <CardHeader
        icon="shield"
        label={label}
        title={item.title}
        mono={item.toolKind === "execute"}
        sub={item.command && item.command !== item.title ? `$ ${item.command.split("\n")[0]}` : null}
        aside={<DetailsButton label="Show the full request and every option" onClick={() => onSheet("options")} />}
      />
      <div className="grid grid-cols-2 gap-2 px-3.5 pb-3">
        <Button
          size="lg"
          variant="danger"
          icon="x"
          disabled={!reject}
          aria-label={reject ? `Deny: ${reject.name}` : "Deny"}
          onClick={() => reject && void respond(reject)}
        >
          Deny
        </Button>
        <Button
          size="lg"
          variant="primary"
          icon="check"
          disabled={!allow}
          aria-label={allow ? `Approve: ${allow.name}` : "Approve"}
          onClick={() => allow && void respond(allow)}
        >
          Approve
        </Button>
      </div>
    </section>
  );
}

function PlanNeed({ agent, item, label, onSheet }: { agent: Agent; item: PermissionItem; label: string; onSheet: (s: Sheets) => void }) {
  const { approve, keepPlanning } = planChoices(item);
  const first = approve[0];
  return (
    <section aria-label="Plan waiting for your approval" aria-live="polite" className={CARD}>
      <CardHeader
        icon="bookText"
        label={label}
        title={planTitle(item.plan ?? "")}
        aside={<DetailsButton label="Read the whole plan" onClick={() => onSheet("plan")} />}
      />
      <div className="space-y-2 px-3.5 pb-3">
        {first && (
          <Button
            size="lg"
            variant="primary"
            icon="check"
            className="w-full"
            aria-label={`${first.label}`}
            onClick={() => void respondToPermission(agent.id, item.requestId, first.option.id)}
          >
            <span className="truncate">{first.label}</span>
          </Button>
        )}
        <div className="grid grid-cols-2 gap-2">
          {keepPlanning && (
            <Button size="md" variant="danger" onClick={() => void respondToPermission(agent.id, item.requestId, keepPlanning.id)}>
              Keep planning
            </Button>
          )}
          <Button size="md" variant="outline" icon="pencil" className={cn(!keepPlanning && "col-span-2")} onClick={() => onSheet("plan")}>
            More choices
          </Button>
        </div>
      </div>
    </section>
  );
}

const lastErrorNotice = (items: readonly TimelineItem[] | undefined): string | null => {
  if (!items) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "notice" && it.level === "error") return it.text;
    if (it.kind === "user_message") return null;
  }
  return null;
};

function BlockedCard({ agent, block, onSwitchAccount }: { agent: Agent; block: DockBlock; onSwitchAccount: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const notice = useStore((s) => lastErrorNotice(s.timelines[agent.id]?.items));
  const resuming = useStore((s) => !!s.busy[`resume:${agent.id}`]);
  const canSwitch = switchableAccounts(agent, accounts).length > 1;
  const resumable = isResumable(agent.status);
  const kind = block.kind;
  const tone = kind === "error" ? "err" : kind === "usage_limit" ? "warn" : "steel";
  const color = tone === "err" ? "var(--err)" : tone === "warn" ? "var(--warn)" : kind === "interrupted" ? "var(--violet)" : "var(--steel)";
  const reset = kind === "usage_limit" ? resetClause(notice) : null;
  const detail =
    kind === "usage_limit"
      ? notice || (canSwitch ? "Switch accounts to keep going; the conversation comes along." : "Try again after the limit resets.")
      : kind === "error"
        ? notice || "Retry to carry on where it left off."
        : kind === "conflict"
          ? "Resolve it in Kvistcode on your computer."
          : "Resume to continue the session.";
  return (
    <section
      aria-label={block.title}
      role="status"
      className="mt-2 rounded-2xl border p-3 pl-3.5"
      style={{ borderColor: `color-mix(in srgb, ${color} 32%, var(--border))`, background: `color-mix(in srgb, ${color} 8%, var(--bg-1))` }}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0" style={{ color }}>
          <Icon name={kind === "usage_limit" ? "gauge" : kind === "error" ? "alertCircle" : "info"} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] leading-snug font-semibold text-fg">{block.title}</p>
          {reset && <p className="mt-0.5 text-[13.5px] leading-snug font-medium text-warn">{reset}</p>}
          <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug break-words text-muted">
            {reset && notice ? withoutReset(notice) || detail : detail}
          </p>
        </div>
      </div>
      {kind !== "conflict" && (
        <div className="mt-2.5 flex gap-2">
          {kind === "usage_limit" && canSwitch && (
            <Button size="md" variant="primary" icon="user" className="min-w-0 flex-1" onClick={onSwitchAccount}>
              Switch account
            </Button>
          )}
          {(kind === "usage_limit" || kind === "error") && (
            <Button
              size="md"
              variant={kind === "error" || !canSwitch ? "primary" : "secondary"}
              icon="refresh"
              className="min-w-0 flex-1"
              onClick={() => void (agent.running ? retryAgent(agent.id) : resumeAgent(agent.id))}
              loading={resuming}
            >
              {agent.running ? "Retry" : "Resume"}
            </Button>
          )}
          {kind === "error" && canSwitch && !agent.rateLimited && (
            <Button size="md" variant="secondary" icon="user" className="min-w-0 flex-1" onClick={onSwitchAccount}>
              Switch
            </Button>
          )}
          {(kind === "interrupted" || kind === "stopped") && resumable && (
            <Button
              size="md"
              variant="primary"
              icon="play"
              className="min-w-0 flex-1"
              loading={resuming}
              onClick={() => void resumeAgent(agent.id)}
            >
              Resume
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Chips: plan progress and running sub-agents

const CHIP =
  "press-row relative flex h-[56px] pb-1.5 min-w-0 flex-1 basis-0 items-center gap-2.5 rounded-2xl border border-line bg-card px-3 text-left edge";

function Chips({ agent, sheet, onSheet }: { agent: Agent; sheet: Sheets; onSheet: (s: Sheets) => void }) {
  const plan = useStore((s) => latestPlan(s.timelines[agent.id]?.items));
  const progress = useMemo(() => planProgress(plan), [plan]);
  const busy = isBusy(agent.status);
  const live = useStore((s) => planIsLive(s.timelines[agent.id]?.items));
  // A plan that just finished stays for a few seconds, so its last tick is seen before it folds away.
  const [lingering, setLingering] = useState(false);
  const phase = planPhase(progress, { live, busy, lingering });
  const wasActive = useRef(phase === "active");
  useEffect(() => {
    const starts = lingerStarts(wasActive.current, phase, progress);
    wasActive.current = phase === "active";
    if (starts) setLingering(true);
    else if (!progress?.complete) setLingering(false);
  }, [phase, progress]);
  useEffect(() => {
    if (!lingering) return;
    const t = setTimeout(() => setLingering(false), PLAN_LINGER_MS);
    return () => clearTimeout(t);
  }, [lingering]);
  const showPlan = phase !== null;

  const running = useRunningSubagentList(agent.id);
  const showSubs = running.length > 0 && busy;
  if (!showPlan && !showSubs) return null;

  return (
    <>
      <div className="dock-chips mt-2 flex gap-2">
        {showPlan && progress && (
          <button
            type="button"
            className={CHIP}
            onClick={() => onSheet("chip-plan")}
            aria-label={`Plan: ${progress.done} of ${progress.total} done${progress.current ? `, now ${progress.current}` : ""}. Open the checklist.`}
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5 text-[13px] leading-tight font-semibold text-fg">
                Plan
                <span className={cn("font-medium tabular", progress.complete ? "text-ok" : "text-muted")}>
                  {progress.complete ? "complete" : `${progress.done} of ${progress.total}`}
                </span>
              </span>
              <span className="mt-0.5 block truncate text-[12px] leading-tight text-steel">
                {progress.complete ? "All steps done" : (progress.current ?? "Working through the steps")}
              </span>
            </span>
            <span className="absolute inset-x-3.5 bottom-1.5 h-[3px] overflow-hidden rounded-full bg-raised" aria-hidden>
              <span
                className="block h-full w-full origin-left rounded-full bg-ok transition-transform duration-200"
                style={{ transform: `scaleX(${progress.done / progress.total})` }}
              />
            </span>
          </button>
        )}
        {showSubs && <SubagentChip running={running} onOpen={() => onSheet("chip-subagents")} />}
      </div>
      <PlanChipSheet agentId={agent.id} open={sheet === "chip-plan" && showPlan} onClose={() => onSheet(null)} />
      <SubagentsSheet agent={agent} running={running} open={sheet === "chip-subagents" && showSubs} onClose={() => onSheet(null)} />
    </>
  );
}

function SubagentChip({ running, onOpen }: { running: ReturnType<typeof useRunningSubagentList>; onOpen: () => void }) {
  // One tick a second while this is on screen (and the page is visible): the timer is the point of the chip.
  const now = useNow(1000);
  const since = Math.min(...running.map((r) => r.startedAt));
  const step = [...running].reverse().find((r) => r.step)?.step ?? null;
  return (
    <button
      type="button"
      className={CHIP}
      onClick={onOpen}
      aria-label={`${subagentHeadline(running)}, working for ${formatElapsed(now - since)}. Open the list.`}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5 text-[13px] leading-tight font-semibold text-fg">
          <span className="min-w-0 truncate">{subagentHeadline(running)}</span>
          <span className="shrink-0 font-medium text-accent tabular">{formatElapsed(Math.max(0, now - since))}</span>
        </span>
        <span className="mt-0.5 block truncate text-[12px] leading-tight text-steel">{step ?? "Working…"}</span>
      </span>
      <Icon name="chevronRight" size={16} className="shrink-0 text-steel" />
    </button>
  );
}

function PlanChipSheet({ agentId, open, onClose }: { agentId: string; open: boolean; onClose: () => void }) {
  const plan = useStore((s) => latestPlan(s.timelines[agentId]?.items));
  return (
    <Sheet open={open && !!plan} onClose={onClose} title="Plan" description="What the agent is working through">
      {plan && <PlanCard item={plan} />}
    </Sheet>
  );
}

function SubagentsSheet({
  agent,
  running,
  open,
  onClose,
}: {
  agent: Agent;
  running: ReturnType<typeof useRunningSubagentList>;
  open: boolean;
  onClose: () => void;
}) {
  const now = useNow(1000);
  return (
    <Sheet open={open && running.length > 0} onClose={onClose} title="Sub-agents" description={`${subagentHeadline(running)} working`}>
      <SubagentList running={running} now={now} inherited={inheritedConfig(agent)} />
    </Sheet>
  );
}
