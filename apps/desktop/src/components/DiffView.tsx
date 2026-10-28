import { ChevronDown, FileCode2, FileMinus2, FilePlus2 } from "lucide-react";
import { memo, useState } from "react";
import type { ParsedFileDiff } from "@/lib/diff";
import { cn } from "@/lib/utils";

export function DiffStat({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-mono text-[11px] tabular", className)}>
      <span className="text-ok">+{additions}</span>
      <span className="text-err">−{deletions}</span>
    </span>
  );
}

/** Five-block bar like GitHub's, proportional to additions/deletions. */
export function DiffBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  const adds = total ? Math.round((additions / total) * 5) : 0;
  return (
    <span className="inline-flex gap-px" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={cn("h-2 w-2 rounded-[2px]", i < adds ? "bg-ok" : i < (total ? 5 : 0) ? "bg-err" : "bg-raised")}
        />
      ))}
    </span>
  );
}

const STATUS_ICON = {
  added: FilePlus2,
  deleted: FileMinus2,
  modified: FileCode2,
  renamed: FileCode2,
} as const;

export const FileDiffView = memo(function FileDiffView({
  file,
  defaultOpen = true,
  maxHeight,
  className,
  flush,
}: {
  file: ParsedFileDiff;
  defaultOpen?: boolean;
  maxHeight?: number;
  className?: string;
  /** Render without outer border/radius (when nested in a card). */
  flush?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = STATUS_ICON[file.status];
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
  const name = file.path.slice(dir.length);
  return (
    <div className={cn("overflow-hidden bg-code", !flush && "rounded-xl border border-line", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="sticky top-0 z-[1] flex h-9 w-full items-center gap-2 border-b border-line bg-panel/90 px-3 text-left backdrop-blur transition-colors hover:bg-raised/70"
      >
        <ChevronDown
          className={cn("h-3.5 w-3.5 text-steel transition-transform duration-150", !open && "-rotate-90")}
        />
        <Icon
          className={cn(
            "h-3.5 w-3.5",
            file.status === "added" ? "text-ok" : file.status === "deleted" ? "text-err" : "text-steel",
          )}
        />
        <span className="min-w-0 truncate font-mono text-[12px]">
          <span className="text-steel">{dir}</span>
          <span className="text-fg">{name}</span>
        </span>
        {file.oldPath && <span className="truncate font-mono text-[11px] text-steel">← {file.oldPath}</span>}
        <span className="ml-auto flex items-center gap-2">
          <DiffStat additions={file.additions} deletions={file.deletions} />
          <DiffBar additions={file.additions} deletions={file.deletions} />
        </span>
      </button>
      {open && (
        <div className="selectable overflow-auto" style={maxHeight ? { maxHeight } : undefined}>
          {file.binary ? (
            <div className="px-4 py-3 text-xs text-steel">Binary file changed</div>
          ) : file.hunks.length === 0 ? (
            <div className="px-4 py-3 text-xs text-steel">No textual changes</div>
          ) : (
            <table className="w-full border-collapse font-mono text-[12px] leading-[1.55]">
              <tbody>
                {file.hunks.map((h, hi) => (
                  <HunkRows key={hi} header={h.header} lines={h.lines} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
});

function HunkRows({ header, lines }: { header: string; lines: ParsedFileDiff["hunks"][number]["lines"] }) {
  return (
    <>
      <tr>
        <td colSpan={4} className="border-y border-line/60 bg-accent/[0.05] px-3 py-1 text-[11px] text-accent/75">
          {header}
        </td>
      </tr>
      {lines.map((l, i) => (
        <tr
          key={i}
          className={cn(l.type === "add" && "bg-[var(--diff-add)]", l.type === "del" && "bg-[var(--diff-del)]")}
        >
          <td className="w-10 select-none border-r border-line/50 pr-2 text-right align-top text-[11px] text-steel/60 tabular">
            {l.oldNo ?? ""}
          </td>
          <td className="w-10 select-none border-r border-line/50 pr-2 text-right align-top text-[11px] text-steel/60 tabular">
            {l.newNo ?? ""}
          </td>
          <td
            className={cn(
              "w-5 select-none text-center align-top",
              l.type === "add" ? "text-ok" : l.type === "del" ? "text-err" : "text-transparent",
            )}
          >
            {l.type === "add" ? "+" : l.type === "del" ? "−" : " "}
          </td>
          <td className="whitespace-pre pr-4 text-fg/90">{l.text || " "}</td>
        </tr>
      ))}
    </>
  );
}

export function DiffList({
  files,
  maxHeight,
  className,
  defaultOpen = true,
}: {
  files: ParsedFileDiff[];
  maxHeight?: number;
  className?: string;
  defaultOpen?: boolean;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      {files.map((f, i) => (
        <FileDiffView key={`${f.path}-${i}`} file={f} maxHeight={maxHeight} defaultOpen={defaultOpen} />
      ))}
    </div>
  );
}
