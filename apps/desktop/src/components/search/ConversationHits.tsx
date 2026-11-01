import { Command } from "cmdk";
import {
  FilePen,
  History,
  ListChecks,
  MessageCircleQuestion,
  MessagesSquare,
  ShieldQuestion,
  SquareTerminal,
  UserRound,
} from "lucide-react";
import type { ReactNode } from "react";
import { relativeTime } from "@/lib/format";
import { splitSnippet } from "@/lib/search";
import type { Agent, SearchGroup, SearchHit, SearchResults, TimelineKind } from "@/lib/types";
import { basename } from "@/lib/utils";

const KIND_LABEL: Partial<Record<TimelineKind, string>> = {
  user_message: "you",
  agent_message: "agent",
  tool_call: "tool",
  permission: "approval",
  question: "question",
  plan: "plan",
  notice: "notice",
  turn_summary: "summary",
};

const KIND_ICON: Partial<Record<TimelineKind, ReactNode>> = {
  user_message: <UserRound />,
  agent_message: <MessagesSquare />,
  tool_call: <SquareTerminal />,
  permission: <ShieldQuestion />,
  question: <MessageCircleQuestion />,
  plan: <ListChecks />,
  turn_summary: <FilePen />,
};

/** A snippet with the matched words marked. */
export function Snippet({ text }: { text: string }) {
  return (
    <>
      {splitSnippet(text).map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-[3px] bg-accent/25 px-px text-fg">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

const itemClass =
  "group flex h-auto min-h-10 cursor-default select-none items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] text-fg outline-none data-[selected=true]:bg-gunmetal/80 data-[selected=true]:shadow-[inset_0_0_0_1px_var(--border-strong)] [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0";

const groupClass =
  "px-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-steel";

function HitRow({
  hit,
  agent,
  showAgent,
  onOpen,
}: {
  hit: SearchHit;
  agent?: Agent;
  showAgent: boolean;
  onOpen: (hit: SearchHit) => void;
}) {
  return (
    <Command.Item
      // Stable value + forceMount: rows don't remount or vanish while the query is retyped.
      value={`history:${hit.agentId}:${hit.itemId}`}
      forceMount
      onSelect={() => onOpen(hit)}
      className={itemClass}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line bg-raised text-steel group-data-[selected=true]:text-fg [&_svg]:!h-3.5 [&_svg]:!w-3.5">
        {KIND_ICON[hit.kind] ?? <History />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-fg/90">
          <Snippet text={hit.snippet} />
        </span>
        <span className="block truncate text-[11px] text-steel">
          {showAgent && `${agent?.title ?? "Deleted agent"} · `}
          {KIND_LABEL[hit.kind] ?? hit.kind.replace("_", " ")} · {relativeTime(hit.ts)}
        </span>
      </span>
    </Command.Item>
  );
}

function GroupHeading({ group, agent }: { group: SearchGroup; agent?: Agent }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2 normal-case tracking-normal">
      <span className="truncate text-[12px] font-medium text-fg/90">{agent?.title ?? "Deleted agent"}</span>
      <span className="truncate text-[11px] font-normal text-steel">
        {agent ? basename(agent.projectPath) : ""}
        {agent?.archived ? " · archived" : ""}
      </span>
      <span className="ml-auto shrink-0 text-[11px] font-normal text-steel tabular">
        {group.total} {group.total === 1 ? "match" : "matches"}
      </span>
    </span>
  );
}

/** How many conversations the everyday palette shows before "See all". */
const COMPACT_GROUPS = 4;

/**
 * Conversation search results as palette rows. Compact (in the everyday palette): the best match of
 * a few conversations and a way into the full view. Full (the "?" mode): every conversation with
 * its best matches, grouped.
 */
export function ConversationHits({
  results,
  agents,
  searching,
  full,
  term,
  onOpen,
  onSeeAll,
}: {
  results: SearchResults | null;
  agents: Record<string, Agent>;
  searching: boolean;
  full: boolean;
  term: string;
  onOpen: (hit: SearchHit) => void;
  onSeeAll: () => void;
}) {
  const groups = results?.groups ?? [];

  if (full) {
    if (term.length < 2) {
      return (
        <div className="px-4 py-10 text-center text-[13px] text-steel">
          Search messages, tool calls, files and plans across every agent, archived ones included.
        </div>
      );
    }
    if (groups.length === 0) {
      return (
        <div className="px-4 py-10 text-center text-[13px] text-steel">
          {searching ? "Searching…" : `No conversation mentions “${term}”.`}
          {!searching && results?.indexing && <Indexing />}
        </div>
      );
    }
    return (
      <>
        {groups.map((g) => (
          <Command.Group
            key={g.agentId}
            heading={<GroupHeading group={g} agent={agents[g.agentId]} />}
            className={groupClass}
            forceMount
          >
            {g.hits.map((h) => (
              <HitRow key={h.itemId} hit={h} agent={agents[h.agentId]} showAgent={false} onOpen={onOpen} />
            ))}
          </Command.Group>
        ))}
        <div className="px-3.5 pb-2 pt-1 text-[11px] text-steel">
          {results?.truncated && "Showing the best matches. Add a word to narrow it down. "}
          {results?.indexing && <Indexing inline />}
        </div>
      </>
    );
  }

  if (groups.length === 0) return null;
  return (
    <Command.Group heading="Conversations" className={groupClass} forceMount>
      {groups.slice(0, COMPACT_GROUPS).map((g) => (
        <HitRow key={g.agentId} hit={g.hits[0]} agent={agents[g.agentId]} showAgent onOpen={onOpen} />
      ))}
      <Command.Item
        value="history:see-all"
        forceMount
        onSelect={onSeeAll}
        className="flex h-9 cursor-default select-none items-center gap-3 rounded-lg px-2.5 text-[12.5px] text-muted outline-none data-[selected=true]:bg-gunmetal/80 data-[selected=true]:text-fg"
      >
        <span className="w-6 shrink-0" />
        See all matches in {groups.length} {groups.length === 1 ? "conversation" : "conversations"}
      </Command.Item>
    </Command.Group>
  );
}

function Indexing({ inline }: { inline?: boolean }) {
  return (
    <span className={inline ? "" : "mt-1 block text-[11.5px]"}>
      Older conversations are still being indexed, so results may be incomplete.
    </span>
  );
}
