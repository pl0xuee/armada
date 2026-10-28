import { Check, ChevronDown, FileCode2, FileMinus2, FilePlus2, Plus, Undo2 } from "lucide-react";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { DiffLine, ParsedFileDiff } from "@/lib/diff";
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

/** A commentable line: new-side number for added/context lines, old-side for deletions. */
export interface LineAnchor {
  path: string;
  side: "new" | "old";
  line: number;
  code: string;
  type: DiffLine["type"];
}

export function anchorKey(a: Pick<LineAnchor, "path" | "side" | "line">): string {
  return `${a.path}\u0000${a.side}:${a.line}`;
}

function anchorFor(path: string, l: DiffLine): LineAnchor | null {
  if (l.newNo !== null) return { path, side: "new", line: l.newNo, code: l.text, type: l.type };
  if (l.oldNo !== null) return { path, side: "old", line: l.oldNo, code: l.text, type: l.type };
  return null;
}

/**
 * Opt-in line commenting (used by the Review sheet; the timeline renders plain diffs).
 * Keep this object referentially stable; signal changes through `noteSignature` + the
 * `commentVersion` prop so only the affected file/chunk re-renders.
 */
export interface LineCommenting {
  /** Open an editor for this line. */
  onLineComment: (anchor: LineAnchor) => void;
  /** Content rendered under a line (existing comments and/or the open editor), or null. */
  renderBelowLine: (anchor: LineAnchor) => ReactNode;
  /** Changes whenever what renders under this line changes; "" when nothing does. */
  noteSignature: (key: string) => string;
  /** Line has saved comments (marks the gutter). */
  hasComments: (key: string) => boolean;
}

/**
 * Opt-in review actions (Review sheet only). Keep the object referentially stable;
 * per-file state (viewed) comes in as plain props so memoised files only re-render when it changes.
 */
export interface FileReviewActions {
  revertFile: (path: string) => void;
  revertHunk: (path: string, hunkIndex: number) => void;
  toggleViewed: (path: string) => void;
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
  commenting,
  review,
  viewed = false,
}: {
  file: ParsedFileDiff;
  defaultOpen?: boolean;
  maxHeight?: number;
  className?: string;
  /** Render without outer border/radius (when nested in a card). */
  flush?: boolean;
  commenting?: LineCommenting;
  /** Bump to re-render this file's comments (memo key; the commenting object itself stays stable). */
  commentVersion?: string;
  review?: FileReviewActions;
  /** Marked as viewed in review: collapsed, with a check. */
  viewed?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen && !viewed);
  // Marking a file viewed collapses it (unmarking re-opens it), like a code-review tool.
  const prevViewed = useRef(viewed);
  useEffect(() => {
    if (prevViewed.current !== viewed) setOpen(!viewed);
    prevViewed.current = viewed;
  }, [viewed]);
  const Icon = STATUS_ICON[file.status];
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
  const name = file.path.slice(dir.length);
  return (
    <div className={cn("overflow-hidden bg-code", !flush && "rounded-xl border border-line", className)}>
      <div className="sticky top-0 z-[1] flex h-9 w-full items-center border-b border-line bg-panel/90 backdrop-blur">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left transition-colors hover:bg-raised/70"
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
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <DiffStat additions={file.additions} deletions={file.deletions} />
            <span className="max-sm:hidden">
              <DiffBar additions={file.additions} deletions={file.deletions} />
            </span>
          </span>
        </button>
        {review && (
          <div className="flex h-full shrink-0 items-center gap-1 border-l border-line/70 px-1.5">
            <button
              type="button"
              onClick={() => review.revertFile(file.path)}
              title="Revert this file's changes"
              aria-label={`Revert all changes to ${file.path}`}
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-muted transition-colors hover:bg-err/12 hover:text-err"
            >
              <Undo2 className="h-3.5 w-3.5" />
              <span className="max-md:hidden">Revert file</span>
            </button>
            <label
              className={cn(
                "inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[11.5px] transition-colors hover:bg-raised",
                viewed ? "text-ok" : "text-muted",
              )}
            >
              <input
                type="checkbox"
                checked={viewed}
                onChange={() => review.toggleViewed(file.path)}
                className="peer sr-only"
                aria-label={`Viewed ${file.path}`}
              />
              <span
                aria-hidden
                className={cn(
                  "flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border peer-focus-visible:ring-2 peer-focus-visible:ring-accent/60",
                  viewed ? "border-ok bg-ok text-base" : "border-line-strong",
                )}
              >
                {viewed && <Check className="h-2.5 w-2.5" strokeWidth={3.5} />}
              </span>
              <span className="max-sm:hidden">Viewed</span>
            </label>
          </div>
        )}
      </div>
      {open && (
        <div className="selectable overflow-auto" style={maxHeight ? { maxHeight } : undefined}>
          {file.binary ? (
            <div className="px-4 py-3 text-xs text-steel">Binary file changed</div>
          ) : file.hunks.length === 0 ? (
            <div className="px-4 py-3 text-xs text-steel">No textual changes</div>
          ) : (
            <table className="w-full border-collapse font-mono text-[12px] leading-[1.55]">
              {commenting ? (
                <CommentableBody file={file} commenting={commenting} review={review} />
              ) : (
                <tbody>
                  {file.hunks.map((h, hi) => (
                    <HunkRows
                      key={hi}
                      header={h.header}
                      lines={h.lines}
                      onRevert={review ? () => review.revertHunk(file.path, hi) : undefined}
                    />
                  ))}
                </tbody>
              )}
            </table>
          )}
        </div>
      )}
    </div>
  );
});

function HunkHeaderRow({ header, onRevert }: { header: string; onRevert?: () => void }) {
  return (
    <tr>
      <td colSpan={4} className="border-y border-line/60 bg-accent/[0.05] px-3 py-1 text-[11px] text-accent/75">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{header}</span>
          {onRevert && (
            <button
              type="button"
              onClick={onRevert}
              title="Revert this hunk"
              aria-label={`Revert hunk ${header}`}
              className="inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 font-sans text-[11px] text-muted transition-colors hover:bg-err/12 hover:text-err"
            >
              <Undo2 className="h-3 w-3" />
              Revert hunk
            </button>
          )}
        </span>
      </td>
    </tr>
  );
}

function HunkRows({
  header,
  lines,
  onRevert,
}: {
  header: string;
  lines: ParsedFileDiff["hunks"][number]["lines"];
  onRevert?: () => void;
}) {
  return (
    <>
      <HunkHeaderRow header={header} onRevert={onRevert} />
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

/** Lines per lazily rendered chunk; big hunks are split so a 5,000-line diff mounts only what's near the viewport. */
const CHUNK = 200;
const ROW_PX = 18.6;

interface Chunk {
  key: string;
  /** Index of the hunk this chunk belongs to. */
  hunk: number;
  header: string | null;
  lines: DiffLine[];
  /** Global row index of the chunk's first line (for roving focus). */
  start: number;
}

function chunksOf(file: ParsedFileDiff): Chunk[] {
  const out: Chunk[] = [];
  let start = 0;
  file.hunks.forEach((h, hi) => {
    for (let i = 0; i < Math.max(1, h.lines.length); i += CHUNK) {
      const lines = h.lines.slice(i, i + CHUNK);
      out.push({ key: `${hi}-${i}`, hunk: hi, header: i === 0 ? h.header : null, lines, start });
      start += lines.length;
    }
  });
  return out;
}

/**
 * Diff rows with a comment gutter. Rows use a roving tabindex: one Tab stop per file,
 * ↑/↓ (or j/k) move between lines, Enter (or c) opens the comment editor.
 * Chunks are memoised and mount lazily, so typing a comment re-renders one chunk.
 */
function CommentableBody({
  file,
  commenting,
  review,
}: {
  file: ParsedFileDiff;
  commenting: LineCommenting;
  review?: FileReviewActions;
}) {
  const [focusIdx, setFocusIdx] = useState(0);
  const rows = useRef<(HTMLTableRowElement | null)[]>([]);
  const chunks = useMemo(() => chunksOf(file), [file]);
  const total = chunks.reduce((n, c) => n + c.lines.length, 0);

  const onKey = useCallback(
    (e: KeyboardEvent<HTMLTableRowElement>, i: number, anchor: LineAnchor | null) => {
      let next = -1;
      if (e.key === "ArrowDown" || e.key === "j") next = Math.min(total - 1, i + 1);
      else if (e.key === "ArrowUp" || e.key === "k") next = Math.max(0, i - 1);
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = total - 1;
      else if ((e.key === "Enter" || e.key === "c") && anchor && e.target === e.currentTarget) {
        e.preventDefault();
        commenting.onLineComment(anchor);
        return;
      }
      if (next < 0) return;
      e.preventDefault();
      // Unmounted (far-away) rows can't take focus yet: stop at the nearest mounted one.
      const step = next > i ? -1 : 1;
      while (next !== i && !rows.current[next]) next += step;
      setFocusIdx(next);
      rows.current[next]?.focus();
    },
    [commenting, total],
  );
  const setRow = useCallback((i: number, el: HTMLTableRowElement | null) => {
    rows.current[i] = el;
  }, []);

  return (
    <>
      {chunks.map((c) => {
        const local = focusIdx >= c.start && focusIdx < c.start + c.lines.length ? focusIdx - c.start : -1;
        let sig = "";
        for (const l of c.lines) {
          const a = anchorFor(file.path, l);
          if (!a) continue;
          const n = commenting.noteSignature(anchorKey(a));
          if (n) sig += `${a.side}${a.line}:${n};`;
        }
        return (
          <LazyChunk
            key={c.key}
            chunk={c}
            path={file.path}
            focusLocal={local}
            noteSig={sig}
            commenting={commenting}
            review={review}
            onKey={onKey}
            onFocusRow={setFocusIdx}
            setRow={setRow}
          />
        );
      })}
    </>
  );
}

const LazyChunk = memo(function LazyChunk({
  chunk,
  path,
  focusLocal,
  commenting,
  review,
  onKey,
  onFocusRow,
  setRow,
}: {
  chunk: Chunk;
  review?: FileReviewActions;
  path: string;
  focusLocal: number;
  /** Comment/editor state for lines in this chunk; changing it re-renders only this chunk. */
  noteSig: string;
  commenting: LineCommenting;
  onKey: (e: KeyboardEvent<HTMLTableRowElement>, i: number, anchor: LineAnchor | null) => void;
  onFocusRow: (i: number) => void;
  setRow: (i: number, el: HTMLTableRowElement | null) => void;
}) {
  // First chunks render immediately; later ones once they come near the viewport (and then stay).
  const [visible, setVisible] = useState(chunk.start < CHUNK * 2);
  const ref = useRef<HTMLTableSectionElement>(null);
  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((x) => x.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "1200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  const header = chunk.header && (
    <HunkHeaderRow header={chunk.header} onRevert={review ? () => review.revertHunk(path, chunk.hunk) : undefined} />
  );

  if (!visible) {
    return (
      <tbody ref={ref} aria-hidden>
        {header}
        <tr>
          <td colSpan={4} style={{ height: chunk.lines.length * ROW_PX }} />
        </tr>
      </tbody>
    );
  }

  return (
    <tbody ref={ref}>
      {header}
      {chunk.lines.map((l, li) => {
        const i = chunk.start + li;
        const anchor = anchorFor(path, l);
        const key = anchor ? anchorKey(anchor) : null;
        const has = key ? commenting.hasComments(key) : false;
        const below = anchor && key && commenting.noteSignature(key) ? commenting.renderBelowLine(anchor) : null;
        const lineLabel = anchor ? `${anchor.side === "old" ? "old " : ""}line ${anchor.line}` : "line";
        return (
          <Fragment key={li}>
            <tr
              ref={(el) => setRow(i, el)}
              tabIndex={li === focusLocal || (focusLocal === -1 && i === 0) ? 0 : -1}
              aria-label={`${path} ${lineLabel}: ${l.text || "blank"}${has ? " (has comments)" : ""}`}
              onFocus={() => onFocusRow(i)}
              onKeyDown={(e) => onKey(e, i, anchor)}
              className={cn(
                "group/line outline-none focus-visible:shadow-[inset_2px_0_0_var(--accent)]",
                l.type === "add" && "bg-[var(--diff-add)]",
                l.type === "del" && "bg-[var(--diff-del)]",
              )}
            >
              <td className="relative w-12 select-none border-r border-line/50 pl-5 pr-2 text-right align-top text-[11px] text-steel/60 tabular">
                {anchor && (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`Comment on ${lineLabel}`}
                    onClick={() => commenting.onLineComment(anchor)}
                    className={cn(
                      "absolute left-0.5 top-[3px] flex h-[15px] w-[15px] items-center justify-center rounded-[4px] bg-accent text-accent-fg opacity-0 shadow-sm transition-opacity",
                      "group-hover/line:opacity-100 group-focus-visible/line:opacity-100",
                      has && "bg-warn text-warn-fg opacity-100",
                    )}
                  >
                    <Plus className="h-2.5 w-2.5" strokeWidth={3} />
                  </button>
                )}
                {l.oldNo ?? ""}
              </td>
              <td
                className="w-10 cursor-pointer select-none border-r border-line/50 pr-2 text-right align-top text-[11px] text-steel/60 tabular hover:text-accent"
                onClick={() => anchor && commenting.onLineComment(anchor)}
              >
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
            {below && (
              <tr>
                <td colSpan={4} className="border-y border-line bg-panel/80 px-3 py-2 font-sans">
                  {below}
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </tbody>
  );
});

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
