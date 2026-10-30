import { Timeline } from "@/components/timeline/Timeline";
import { Button } from "@/components/ui/button";
import type { Agent } from "@/lib/types";
import { useApp } from "@/store/app";

/** Owns the items subscription so streamed frames re-render only the timeline, not the whole pane. */
export function TimelinePane({ agent, focused = true }: { agent: Agent; focused?: boolean }) {
  const items = useApp((s) => s.items[agent.id]);
  const loading = useApp((s) => s.itemsLoading[agent.id] ?? false);
  const loadError = useApp((s) => s.itemsError[agent.id]);
  return (
    <Timeline
      agent={agent}
      items={items}
      loading={loading}
      focused={focused}
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
