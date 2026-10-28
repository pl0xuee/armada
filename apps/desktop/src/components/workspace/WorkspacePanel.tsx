import { X } from "lucide-react";
import { Suspense, useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/tooltip";
import type { Agent } from "@/lib/types";
import { cn, modKey } from "@/lib/utils";
import { agentWs, useWorkspace } from "@/store/workspace";
import { useUi, WORKSPACE_DEFAULT_HEIGHT, WORKSPACE_MIN_HEIGHT } from "@/store/ui";
import { hasNewServer, previewOf, usePreview, usePreviewDetection } from "@/store/preview";
import { WORKSPACE_TABS } from "./tabs";

/** Vertical space the conversation and composer keep; the panel never takes it. */
export const WORKSPACE_RESERVED = 300;

/** Tallest the panel can be inside a column of `available` px, or 0 when it doesn't fit at all. */
export function workspaceMaxHeight(available: number): number {
  const max = available - WORKSPACE_RESERVED;
  return max >= WORKSPACE_MIN_HEIGHT ? max : 0;
}

/**
 * Bottom panel of the agent view: registry tabs (Terminal, Scripts, ...), resizable by its top edge.
 * `maxHeight` is how tall it may be right now.
 */
export function WorkspacePanel({ agent, maxHeight }: { agent: Agent; maxHeight: number }) {
  const height = useUi((s) => s.workspaceHeight);
  const setHeight = useUi((s) => s.setWorkspaceHeight);
  const setOpen = useUi((s) => s.setWorkspaceOpen);
  const tabId = useWorkspace((s) => agentWs(s, agent.id).tab);
  const setTab = useWorkspace((s) => s.setTab);
  usePreviewDetection(agent.id);
  const newServer = usePreview((s) => hasNewServer(previewOf(s, agent.id)));
  const tab = WORKSPACE_TABS.find((t) => t.id === tabId) ?? WORKSPACE_TABS[0];

  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef({ y: 0, h: 0 });
  const clamp = useCallback(
    (h: number) => Math.max(WORKSPACE_MIN_HEIGHT, Math.min(maxHeight, Math.round(h))),
    [maxHeight],
  );
  const shown = drag ?? clamp(height);

  return (
    <div
      className="relative flex shrink-0 flex-col border-t border-line bg-base"
      style={{ height: shown }}
      role="region"
      aria-label="Workspace"
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize workspace panel"
        aria-valuemin={WORKSPACE_MIN_HEIGHT}
        aria-valuemax={maxHeight}
        aria-valuenow={shown}
        tabIndex={0}
        className={cn(
          "absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none outline-none transition-colors hover:bg-accent/30 focus-visible:bg-accent/40",
          drag !== null && "bg-accent/40",
        )}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          start.current = { y: e.clientY, h: shown };
          setDrag(shown);
        }}
        onPointerMove={(e) => {
          if (drag !== null) setDrag(clamp(start.current.h + start.current.y - e.clientY));
        }}
        onPointerUp={() => {
          if (drag !== null) setHeight(drag);
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
        onDoubleClick={() => setHeight(WORKSPACE_DEFAULT_HEIGHT)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            setHeight(clamp(shown + (e.key === "ArrowUp" ? 24 : -24)));
          }
        }}
      />
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-1.5">
        <div role="tablist" aria-label="Workspace tabs" className="flex items-center gap-0.5">
          {WORKSPACE_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === tab.id}
              onClick={() => setTab(agent.id, t.id)}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5",
                t.id === tab.id ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg",
              )}
            >
              <t.icon />
              {t.label}
              {t.id === "preview" && newServer && t.id !== tab.id && (
                <span className="h-1.5 w-1.5 rounded-full bg-accent" role="img" aria-label="New server detected" />
              )}
            </button>
          ))}
        </div>
        <Tooltip content="Hide panel" shortcut={[modKey, "`"]}>
          <Button
            size="icon-sm"
            variant="ghost"
            className="ml-auto"
            aria-label="Hide workspace panel"
            onClick={() => setOpen(false)}
          >
            <X />
          </Button>
        </Tooltip>
      </div>
      <div className="@container flex min-h-0 flex-1 flex-col" role="tabpanel">
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center">
              <Spinner className="h-4 w-4" />
            </div>
          }
        >
          <tab.Component key={tab.id} agent={agent} />
        </Suspense>
      </div>
    </div>
  );
}
