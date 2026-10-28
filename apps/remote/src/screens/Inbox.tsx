import { memo, useEffect, useMemo, useState } from "react";
import { AccountDot, ProviderBadge } from "@/components/Identity";
import { Icon } from "@/components/Icon";
import { Sheet } from "@/components/Sheet";
import { Swipeable } from "@/components/Swipeable";
import { OPTION_VARIANT, PermissionSubject } from "@/components/timeline/Permission";
import { TOOL_ICON } from "@/components/timeline/Items";
import { ConnectionPill, TopBar } from "@/components/TopBar";
import { Button, IconButton } from "@/components/ui";
import { cn } from "@/lib/cn";
import { loadInboxTimelines, loadTimeline, respondToPermission, retryState } from "@/lib/controller";
import { devParam } from "@/lib/dev";
import { diffStats } from "@/lib/diff";
import { basename, plural, relativeTime } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { agentIdentity, OPTION_HINT, primaryAllow, primaryReject, safeColor } from "@/lib/meta";
import { goBack, navigate } from "@/lib/router";
import { useInbox, type InboxEntry } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import type { PermissionOption } from "@/lib/types";
import { EmptyState, ErrorState } from "./States";

const EXIT_MS = 170;

export function Inbox() {
  const inbox = useInbox();
  const resolving = useStore((s) => s.resolving);
  const stateStatus = useStore((s) => s.stateStatus);
  const stateError = useStore((s) => s.stateError);
  const now = useNow();
  const [optionsFor, setOptionsFor] = useState<string | null>(null);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    loadInboxTimelines();
  }, []);

  // Answered requests leave the list immediately (and come back if sending fails).
  const entries = useMemo(() => inbox.entries.filter((e) => !resolving[e.item.requestId]), [inbox.entries, resolving]);

  const devSheet = devParam("sheet") === "options";
  useEffect(() => {
    if (devSheet && entries[0] && optionsFor === null) setOptionsFor(entries[0].item.requestId);
  }, [devSheet, entries, optionsFor]);

  const sheetEntry = entries.find((e) => e.item.requestId === optionsFor) ?? null;

  let body;
  if (stateStatus !== "ready" && !entries.length) {
    body = stateStatus === "error" ? <ErrorState title="Couldn't load approvals" body={stateError} onRetry={retryState} /> : <InboxSkeleton count={2} />;
  } else if (!entries.length && !inbox.loading && !inbox.failed.length) {
    body = (
      <EmptyState
        icon="shieldCheck"
        tone="ok"
        title="You're all caught up"
        body="When an agent needs permission to run a command or edit a file, it shows up here."
        action={{ label: "Back to agents", onClick: () => navigate({ name: "fleet" }, { replace: true }) }}
      />
    );
  } else {
    body = (
      <div className="space-y-3">
        {entries.length > 0 && (
          <p className="flex items-center justify-center gap-1.5 pb-1 text-center text-[12.5px] text-steel [@media(pointer:fine)]:hidden">
            Swipe right to approve, left to deny
          </p>
        )}
        {entries.map((e) => (
          <InboxCard key={e.item.requestId} entry={e} now={now} onMore={() => setOptionsFor(e.item.requestId)} />
        ))}
        {inbox.loading > 0 && <InboxSkeleton count={Math.min(inbox.loading, 2)} />}
        {inbox.failed.map((a) => (
          <div key={a.id} className="flex items-center gap-3 rounded-2xl border border-err/30 bg-err/[0.06] p-3">
            <Icon name="alertCircle" size={18} className="shrink-0 text-err" />
            <p className="min-w-0 flex-1 text-[13.5px] text-fg">
              Couldn't load requests from <span className="font-semibold">{a.title}</span>
            </p>
            <Button size="sm" variant="secondary" onClick={() => void loadTimeline(a.id)}>
              Retry
            </Button>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar left={<IconButton icon="chevronLeft" label="Back to agents" onClick={goBack} />} right={<ConnectionPill className="mr-2" />}>
        <div className="min-w-0">
          <h1 className="text-[17px] leading-tight font-semibold text-fg">Inbox</h1>
          <p className="text-[12px] leading-tight text-muted">
            {inbox.count ? `${plural(inbox.count, "request")} waiting` : "Nothing waiting"}
          </p>
        </div>
      </TopBar>
      <main className="mx-auto w-full max-w-[860px] flex-1 px-safe pt-4 pb-[calc(24px+var(--safe-bottom))]">{body}</main>
      <OptionsSheet entry={sheetEntry} onClose={() => setOptionsFor(null)} />
    </div>
  );
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

const InboxCard = memo(function InboxCard({ entry, now, onMore }: { entry: InboxEntry; now: number; onMore: () => void }) {
  const { agent, item } = entry;
  const account = useStore((s) => s.accounts[agent.accountId]);
  const customAgents = useStore((s) => s.customAgents);
  const [leaving, exit] = useExit();
  const [showDiff, setShowDiff] = useState(false);
  const allow = primaryAllow(item);
  const reject = primaryReject(item);
  const extra = item.options.length - (allow ? 1 : 0) - (reject ? 1 : 0);
  const waitingMin = (now - item.ts) / 60_000;
  const stats = useMemo(() => (item.diffs.length ? diffStats(item.diffs) : null), [item.diffs]);
  const respond = (o: PermissionOption) => void respondToPermission(agent.id, item.requestId, o.id);

  return (
    <div className={cn("transition-[opacity,transform] duration-150", leaving ? "scale-[0.98] opacity-0" : "animate-enter")}>
      <Swipeable
        rightLabel="Approve"
        leftLabel="Deny"
        onSwipeRight={allow ? () => respond(allow) : undefined}
        onSwipeLeft={reject ? () => respond(reject) : undefined}
      >
        <article
          aria-label={`${agent.title}: ${item.title}`}
          className="overflow-hidden rounded-2xl border border-line-strong bg-card shadow-[0_12px_32px_-20px_rgba(0,0,0,0.9)] edge-strong"
        >
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
                <span className="text-line-strong">·</span>
                <span className="truncate text-steel">{basename(agent.projectPath)}</span>
              </span>
            </span>
            <span
              className={cn("inline-flex shrink-0 items-center gap-1 text-[12.5px] tabular", waitingMin >= 5 ? "text-warn" : "text-steel")}
              aria-label={`Waiting ${relativeTime(item.ts, now)}`}
            >
              <Icon name="clock" size={14} />
              {relativeTime(item.ts, now)}
            </span>
          </button>

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
                onClick={() => reject && exit(() => respond(reject))}
              >
                Deny
              </Button>
              <Button
                size="lg"
                variant="primary"
                icon="check"
                disabled={!allow}
                aria-label={allow ? `Approve: ${allow.name}` : "Approve"}
                onClick={() => allow && exit(() => respond(allow))}
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
                {extra > 0 ? `More options (${extra})` : "All options"}
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

function OptionsSheet({ entry, onClose }: { entry: InboxEntry | null; onClose: () => void }) {
  // Keep showing the last entry while the sheet animates closed.
  const [shown, setShown] = useState(entry);
  useEffect(() => {
    if (entry) setShown(entry);
  }, [entry]);
  const e = entry ?? shown;
  return (
    <Sheet open={!!entry} onClose={onClose} title={e?.item.title ?? "Options"} description={e ? `${e.agent.title}` : undefined}>
      {e && (
        <div className="space-y-4">
          <div data-noswipe className="space-y-2">
            <PermissionSubject item={e.item} compact />
          </div>
          <div className="space-y-2" role="group" aria-label="Choose a response">
            {e.item.options.map((o) => (
              <Button
                key={o.id}
                size="lg"
                variant={OPTION_VARIANT[o.kind]}
                className="h-auto min-h-[56px] w-full flex-col !items-start gap-0 py-2.5 text-left"
                onClick={() => {
                  onClose();
                  void respondToPermission(e.agent.id, e.item.requestId, o.id);
                }}
              >
                <span className="block w-full truncate">{o.name}</span>
                <span className="block w-full truncate text-[12.5px] font-normal opacity-75">{OPTION_HINT[o.kind]}</span>
              </Button>
            ))}
          </div>
        </div>
      )}
    </Sheet>
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
