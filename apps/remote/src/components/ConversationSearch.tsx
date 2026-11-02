import { useEffect, useMemo, useState } from "react";
import { AccountDot, ProviderBadge } from "@/components/Identity";
import { Icon, Spinner } from "@/components/Icon";
import { Button } from "@/components/ui";
import { searchConversations } from "@/lib/phoneActions";
import { basename, relativeTime } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { safeColor } from "@/lib/meta";
import { navigate } from "@/lib/router";
import { setSearchFocus } from "@/lib/searchFocus";
import { accountOf } from "@/lib/selectors";
import { kindLabel, matchCount, resultGroups, searchText, splitSnippet } from "@/lib/search";
import { useStore } from "@/lib/store";
import type { Agent, SearchResults } from "@/lib/types";

/** Wait this long after the last keystroke before asking the computer. */
const DEBOUNCE_MS = 300;

type Status = "loading" | "ready" | "error";

/** Results for `query`, refreshed as it is typed. A slow answer to an older query never replaces a newer one. */
function useConversationSearch(query: string | null, retry: number) {
  const [results, setResults] = useState<SearchResults | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  useEffect(() => {
    if (!query) {
      setResults(null);
      return;
    }
    setStatus("loading");
    let stale = false;
    const timer = setTimeout(() => {
      searchConversations(query).then(
        (r) => {
          if (stale) return;
          setResults(r);
          setStatus("ready");
        },
        () => {
          if (!stale) setStatus("error");
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, retry]);
  return { results, status };
}

/** Marked words in a snippet. */
function Snippet({ text }: { text: string }) {
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

/**
 * "In conversations": what the fleet's search box finds inside the agents' conversations, grouped by agent with a
 * few snippets each. Tapping a result opens that agent.
 */
export function ConversationSearch({ query }: { query: string }) {
  const text = searchText(query);
  const [retry, setRetry] = useState(0);
  const { results, status } = useConversationSearch(text, retry);
  const agents = useStore((s) => s.agents);
  const groups = useMemo(() => resultGroups(results, agents), [results, agents]);
  const now = useNow();
  if (!text) return null;

  return (
    <section aria-labelledby="search-conversations" className="space-y-2">
      <h2 id="search-conversations" className="flex items-center gap-2 px-1 text-[12px] font-semibold tracking-[0.08em] text-steel uppercase">
        In conversations
        {status === "loading" && <Spinner size={12} />}
      </h2>
      {status === "error" ? (
        <div className="flex items-center gap-3 rounded-2xl border border-err/30 bg-err/[0.06] p-3" role="alert">
          <Icon name="alertCircle" size={18} className="shrink-0 text-err" />
          <p className="min-w-0 flex-1 text-[13.5px] text-fg">Couldn't search the conversations.</p>
          <Button size="sm" variant="secondary" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          {status === "ready" && !groups.length && <p className="px-1 text-[14px] text-muted">No conversation mentions "{text}".</p>}
          {groups.length > 0 && (
            <ul className="space-y-3" aria-busy={status === "loading"}>
              {groups.map(({ group, agent }) => (
                <li key={group.agentId} className="overflow-hidden rounded-2xl border border-line bg-panel edge">
                  <button
                    type="button"
                    onClick={() => navigate({ name: "agent", agentId: agent.id })}
                    className="press-row block w-full text-left"
                    aria-label={`${agent.title}, ${matchCount(group.total)}`}
                  >
                    <GroupHeader agent={agent} total={group.total} />
                  </button>
                  {group.hits.map((h) => (
                    <button
                      key={h.itemId}
                      type="button"
                      onClick={() => {
                        setSearchFocus({ agentId: agent.id, itemId: h.itemId, seq: h.seq });
                        navigate({ name: "agent", agentId: agent.id });
                      }}
                      aria-label={`Open in ${agent.title}: ${splitSnippet(h.snippet).map((p) => p.text).join("")}`}
                      className="press-row block min-h-11 w-full border-t border-line/60 px-3.5 py-2 text-left"
                    >
                      <span className="line-clamp-2 block text-[13.5px] leading-[1.4] break-words text-fg/90">
                        <Snippet text={h.snippet} />
                      </span>
                      <span className="mt-0.5 block text-[12px] text-steel">
                        {kindLabel(h.kind)} · {relativeTime(h.ts, now)}
                      </span>
                    </button>
                  ))}
                </li>
              ))}
            </ul>
          )}
          {status === "ready" && results?.indexing && <p className="px-1 text-[12.5px] text-steel">Older conversations are still being indexed, so this may be incomplete.</p>}
          {status === "ready" && results?.truncated && <p className="px-1 text-[12.5px] text-steel">Showing the best matches. Try a more specific search.</p>}
        </>
      )}
    </section>
  );
}

function GroupHeader({ agent, total }: { agent: Agent; total: number }) {
  const account = useStore((s) => accountOf(s.accounts, agent));
  return (
    <span className="flex items-center gap-3 px-3.5 py-2.5">
      <ProviderBadge agent={agent} size={32} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14.5px] font-semibold text-fg">{agent.title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted">
          {account && <AccountDot color={safeColor(account.color)} size={7} />}
          <span className="truncate">
            {agent.projectPath ? basename(agent.projectPath) : "Agent"}
            {agent.archived ? " · archived" : ""}
          </span>
        </span>
      </span>
      <span className="shrink-0 text-[12.5px] text-steel tabular">{matchCount(total)}</span>
    </span>
  );
}
