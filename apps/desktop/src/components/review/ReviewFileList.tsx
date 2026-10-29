import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, FileCode2, FileMinus2, FilePlus2 } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ChangedFile } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DiffBar } from "../DiffView";

const FILE_ICON = { added: FilePlus2, deleted: FileMinus2, modified: FileCode2, renamed: FileCode2 } as const;
export const FILE_ROW_PX = 46;

export function LfsTag({ className }: { className?: string }) {
  return (
    <span
      title="Stored with Git LFS"
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded border border-line-strong px-1 font-sans text-[9.5px] font-semibold uppercase tracking-wide text-steel",
        className,
      )}
    >
      LFS
    </span>
  );
}

/** The sidebar: fixed-height rows, only the ones in (or near) view are mounted. */
export function ReviewFileList({
  files,
  selected,
  isViewed,
  onSelect,
}: {
  files: ChangedFile[];
  selected: string | null;
  isViewed: (path: string) => boolean;
  onSelect: (path: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FILE_ROW_PX,
    overscan: 8,
    getItemKey: (i) => files[i]?.path ?? i,
  });
  const selectedIndex = selected === null ? -1 : files.findIndex((f) => f.path === selected);
  // Keep the active row in view (jumps, keyboard moves, deep links).
  useEffect(() => {
    if (selectedIndex >= 0) v.scrollToIndex(selectedIndex, { align: "auto" });
    // `v` is stable per render of the list; only the selection should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex]);

  const focusAfter = useRef<string | null>(null);
  useEffect(() => {
    if (!focusAfter.current) return;
    const el = [...(scrollRef.current?.querySelectorAll<HTMLElement>("[data-file-row]") ?? [])].find(
      (b) => b.dataset.fileRow === focusAfter.current,
    );
    if (el) {
      el.focus();
      focusAfter.current = null;
    }
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
    const edge = e.key === "Home" ? 0 : e.key === "End" ? files.length - 1 : -1;
    if (!step && edge < 0) return;
    if (files.length === 0) return;
    e.preventDefault();
    const from = selectedIndex < 0 ? 0 : selectedIndex;
    const next = edge >= 0 ? edge : Math.min(files.length - 1, Math.max(0, from + step));
    focusAfter.current = files[next].path;
    onSelect(files[next].path);
  };

  return (
    <div ref={scrollRef} onKeyDown={onKeyDown} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      <div style={{ height: v.getTotalSize(), position: "relative", width: "100%" }}>
        {v.getVirtualItems().map((row) => {
          const f = files[row.index];
          return (
            <div
              key={row.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: row.size,
                transform: `translateY(${row.start}px)`,
              }}
            >
              <FileRow
                file={f}
                active={selected === f.path}
                tabbable={selected === f.path || (selectedIndex < 0 && row.index === 0)}
                viewed={isViewed(f.path)}
                onClick={() => onSelect(f.path)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FileRow({
  file,
  active,
  tabbable,
  viewed,
  onClick,
}: {
  file: ChangedFile;
  active: boolean;
  tabbable: boolean;
  viewed: boolean;
  onClick: () => void;
}) {
  const Icon = FILE_ICON[file.status];
  const name = file.path.split("/").pop() ?? file.path;
  const dir = file.path.slice(0, file.path.length - name.length);
  return (
    <button
      type="button"
      data-file-row={file.path}
      tabIndex={tabbable ? 0 : -1}
      onClick={onClick}
      title={file.path}
      aria-current={active ? "true" : undefined}
      aria-label={`${file.path}, ${file.status}${file.lfs ? ", Git LFS" : ""}, ${file.additions} added, ${file.deletions} removed${viewed ? ", viewed" : ""}`}
      className={cn(
        "flex h-[42px] w-full items-center gap-2 rounded-lg px-2 text-left transition-colors",
        viewed && "opacity-60",
        active ? "bg-gunmetal/70 shadow-[inset_0_0_0_1px_var(--border-strong)]" : "hover:bg-raised/60",
      )}
    >
      <Icon
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          file.status === "added" ? "text-ok" : file.status === "deleted" ? "text-err" : "text-steel",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 truncate font-mono text-[12px] text-fg">
          {viewed && <Check className="h-3 w-3 shrink-0 text-ok" aria-hidden />}
          <span className="truncate">{name}</span>
          {file.lfs && <LfsTag />}
        </span>
        {dir && <span className="block truncate font-mono text-[10.5px] text-steel">{dir}</span>}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className="font-mono text-[10.5px] tabular">
          <span className="text-ok">+{file.additions}</span> <span className="text-err">−{file.deletions}</span>
        </span>
        <DiffBar additions={file.additions} deletions={file.deletions} />
      </span>
    </button>
  );
}
