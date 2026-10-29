import { CircleAlert, MessageSquarePlus, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import { counts, type ConsoleEntry } from "@/lib/previewBridge";
import { cn } from "@/lib/utils";
import type { PageTools } from "./usePreviewPage";

/** Toolbar badge + popover listing the page's console errors, warnings and uncaught exceptions. */
export function PreviewConsole({
  entries,
  tools,
  onSend,
  onClear,
  className,
}: {
  entries: ConsoleEntry[];
  tools: PageTools;
  onSend: () => void;
  onClear: () => void;
  className?: string;
}) {
  const { errors, warnings } = counts(entries);
  const total = errors + warnings;
  const unavailable = tools !== "ready" && total === 0;
  const label = unavailable
    ? tools === "off"
      ? "Console unavailable (page tools are off)"
      : tools === "unavailable"
        ? "Console unavailable for this page"
        : "Console"
    : total
      ? `Console: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`
      : "Console: no errors";
  return (
    <Popover>
      <Tooltip content={label}>
        <PopoverTrigger asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            disabled={unavailable}
            className={cn("relative", errors ? "text-err" : warnings ? "text-warn" : "", className)}
          >
            <CircleAlert />
            {total > 0 && (
              <span
                className={cn(
                  "absolute -right-0.5 -top-0.5 flex h-[14px] min-w-[14px] items-center justify-center rounded-full px-[3px] text-[9.5px] font-semibold leading-none text-white tabular",
                  errors ? "bg-err" : "bg-warn",
                )}
              >
                {total > 99 ? "99+" : total}
              </span>
            )}
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="w-[min(420px,calc(100vw-16px))] p-0">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <p className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg">
            {total ? `${errors} error${errors === 1 ? "" : "s"} · ${warnings} warning${warnings === 1 ? "" : "s"}` : "Console"}
          </p>
          <Tooltip content="Clear">
            <Button size="icon-sm" variant="ghost" aria-label="Clear console problems" disabled={!total} onClick={onClear}>
              <Trash2 />
            </Button>
          </Tooltip>
          <Button size="xs" variant="secondary" disabled={!total} onClick={onSend}>
            <MessageSquarePlus className="!h-3 !w-3" /> Send to agent
          </Button>
        </div>
        {total === 0 ? (
          <p className="px-3 py-6 text-center text-[12.5px] text-steel">
            No errors or warnings so far. Uncaught exceptions, unhandled rejections, failed resources and console.error / warn calls
            show up here.
          </p>
        ) : (
          <ul className="max-h-[320px] divide-y divide-line overflow-y-auto">
            {entries
              .slice()
              .reverse()
              .map((e) => (
                <li key={e.key} className="flex gap-2 px-3 py-2">
                  {e.level === "error" ? (
                    <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-err" />
                  ) : (
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-3 break-words font-mono text-[11.5px] leading-snug text-fg">{e.message}</p>
                    {e.stack && (
                      <p className="mt-0.5 truncate font-mono text-[10.5px] text-steel" title={e.stack}>
                        {e.stack.split("\n")[0]}
                      </p>
                    )}
                  </div>
                  {e.count > 1 && <span className="shrink-0 text-[11px] text-steel tabular">×{e.count}</span>}
                </li>
              ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
