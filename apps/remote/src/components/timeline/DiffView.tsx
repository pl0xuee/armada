import { memo, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { parseFileDiff, type ParsedDiff } from "@/lib/diff";
import { shortPath } from "@/lib/format";
import type { FileDiff } from "@/lib/types";
import { Icon } from "../Icon";

const COLLAPSED_LINES = 14;

export function FileBlock({ file, defaultOpen, id }: { file: ParsedDiff; defaultOpen: boolean; id?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  const long = file.lines.length > COLLAPSED_LINES;
  const lines = expanded || !long ? file.lines : file.lines.slice(0, COLLAPSED_LINES);
  return (
    <div id={id} className="scroll-mt-28 overflow-hidden rounded-xl border border-line bg-code">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="press-row flex min-h-11 w-full items-center gap-2 px-3 text-left"
      >
        <Icon name="file" size={15} className="shrink-0 text-steel" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg" title={file.path}>
          {shortPath(file.path, 3)}
        </span>
        {file.status !== "modified" && (
          <span
            className={cn(
              "rounded-md px-1.5 py-px text-[10.5px] font-semibold tracking-wide uppercase",
              file.status === "added" ? "bg-ok/12 text-ok" : "bg-err/12 text-err",
            )}
          >
            {file.status === "added" ? "New" : "Deleted"}
          </span>
        )}
        <span className="shrink-0 font-mono text-[12px] tabular">
          <span className="text-ok">+{file.additions}</span> <span className="text-err">−{file.deletions}</span>
        </span>
        <Icon name="chevronDown" size={16} className={cn("shrink-0 text-steel transition-transform duration-150", !open && "-rotate-90")} />
      </button>
      {open && file.tooLarge && (
        <p className="border-t border-line/80 px-3 py-3 text-[12.5px] leading-snug text-muted">
          This change is too large to show on a phone. Review it in Armada on your computer.
        </p>
      )}
      {open && !file.tooLarge && (
        <>
          <div className="scroll-x border-t border-line/80 py-1">
            <div className="min-w-max font-mono text-[12px] leading-[1.6]">
              {lines.map((l, i) =>
                l.type === "gap" || l.type === "hunk" ? (
                  <div key={i} className="px-3 py-0.5 text-[11.5px] whitespace-pre text-steel">
                    {l.type === "gap" ? `⋯ ${l.text}` : `@@ ${l.text}`}
                  </div>
                ) : (
                  <div
                    key={i}
                    className={cn(
                      "flex pr-4 whitespace-pre",
                      l.type === "add" && "bg-[var(--diff-add)]",
                      l.type === "del" && "bg-[var(--diff-del)]",
                    )}
                  >
                    <span
                      className={cn(
                        "w-6 shrink-0 text-center select-none",
                        l.type === "add" ? "text-ok" : l.type === "del" ? "text-err" : "text-steel/50",
                      )}
                      aria-hidden
                    >
                      {l.type === "add" ? "+" : l.type === "del" ? "−" : " "}
                    </span>
                    <span className={cn(l.type === "ctx" ? "text-muted" : "text-fg")}>{l.text || " "}</span>
                  </div>
                ),
              )}
            </div>
          </div>
          {(long || file.truncated) && (
            <div className="border-t border-line/80">
              {long && (
                <button
                  type="button"
                  onClick={() => setExpanded((e) => !e)}
                  className="press-row h-10 w-full text-[12.5px] font-medium text-accent"
                >
                  {expanded ? "Show less" : `Show all ${file.lines.length} lines`}
                </button>
              )}
              {expanded && file.truncated && (
                <p className="px-3 pb-2 text-[12px] text-steel">Diff truncated. Open it on your computer to see everything.</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export const DiffList = memo(function DiffList({ diffs, defaultOpen = true }: { diffs: FileDiff[]; defaultOpen?: boolean }) {
  const files = useMemo(() => diffs.flatMap(parseFileDiff), [diffs]);
  if (!files.length) return null;
  return (
    <div className="space-y-2">
      {files.map((f, i) => (
        <FileBlock key={`${f.path}-${i}`} file={f} defaultOpen={defaultOpen && files.length <= 3} />
      ))}
    </div>
  );
});
