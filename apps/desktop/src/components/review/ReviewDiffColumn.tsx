import { useVirtualizer } from "@tanstack/react-virtual";
import { forwardRef, useCallback, useImperativeHandle, useState } from "react";
import type { ParsedFileDiff } from "@/lib/diff";
import type { PatchIndex } from "@/lib/patchIndex";
import { compactLabel, isBigFile } from "@/lib/reviewFiles";
import type { ChangedFile } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FileDiffView, type FileReviewActions, type LineCommenting } from "../DiffView";
import { LfsTag } from "./ReviewFileList";
import { FileMinus2, FilePlus2, FileQuestion } from "lucide-react";

const GAP = 12;
const PAD = 16;
const HEADER_PX = 36;
const ROW_PX = 18.6;
const COMPACT_PX = 36;

export interface DiffColumnHandle {
  scrollToPath: (path: string) => void;
}

/** A parsed-file stand-in for a huge file whose diff hasn't been loaded yet. */
function stubFor(f: ChangedFile): ParsedFileDiff {
  return {
    path: f.path,
    oldPath: null,
    status: f.status,
    hunks: [],
    additions: f.additions,
    deletions: f.deletions,
    binary: false,
  };
}

function estimate(f: ChangedFile, compact: boolean, open: boolean): number {
  if (compact) return COMPACT_PX;
  if (!open) return HEADER_PX + 2;
  return HEADER_PX + 2 + (f.additions + f.deletions + 10) * ROW_PX;
}

/**
 * The diff column: a virtualised list of files. Only files near the viewport are mounted, each
 * parsed from the patch on first use. Open/collapsed state lives in `openState` so a file keeps
 * it when it scrolls out and back in.
 */
export const ReviewDiffColumn = forwardRef<
  DiffColumnHandle,
  {
    files: ChangedFile[];
    index: PatchIndex;
    compact: (f: ChangedFile) => boolean;
    /** The patch was cut at the size cap: files missing from it just aren't loaded. */
    truncated?: boolean;
    scrollEl: React.RefObject<HTMLDivElement | null>;
    commenting: LineCommenting;
    reviewActions: FileReviewActions;
    fileVersions: Map<string, string>;
    isViewed: (path: string) => boolean;
    openState: React.MutableRefObject<Map<string, boolean>>;
  }
>(function ReviewDiffColumn(
  { files, index, compact, truncated, scrollEl, commenting, reviewActions, fileVersions, isViewed, openState },
  ref,
) {
  const v = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollEl.current,
    estimateSize: (i) => {
      const f = files[i];
      return estimate(f, compact(f), openState.current.get(f.path) ?? !isBigFile(f));
    },
    overscan: 2,
    gap: GAP,
    paddingStart: PAD,
    paddingEnd: PAD,
    getItemKey: (i) => files[i]?.path ?? i,
  });
  useImperativeHandle(
    ref,
    () => ({
      scrollToPath: (path) => {
        const i = files.findIndex((f) => f.path === path);
        if (i >= 0) v.scrollToIndex(i, { align: "start" });
      },
    }),
    [files, v],
  );

  return (
    <div style={{ height: v.getTotalSize(), position: "relative", width: "100%" }}>
      {v.getVirtualItems().map((row) => {
        const f = files[row.index];
        return (
          <div
            key={row.key}
            ref={v.measureElement}
            data-index={row.index}
            data-path={f.path}
            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start}px)` }}
          >
            {compact(f) ? (
              <CompactRow file={f} label={compactLabel(f, index, truncated)} />
            ) : (
              <FileItem
                file={f}
                index={index}
                commenting={commenting}
                reviewActions={reviewActions}
                commentVersion={fileVersions.get(f.path) ?? ""}
                viewed={isViewed(f.path)}
                openState={openState}
              />
            )}
          </div>
        );
      })}
    </div>
  );
});

function CompactRow({ file, label }: { file: ChangedFile; label: string }) {
  const Icon = file.status === "added" ? FilePlus2 : file.status === "deleted" ? FileMinus2 : FileQuestion;
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
  return (
    <div className="flex h-9 items-center gap-2 rounded-xl border border-line bg-card px-3 font-mono text-[12px]">
      <Icon
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          file.status === "added" ? "text-ok" : file.status === "deleted" ? "text-err" : "text-steel",
        )}
      />
      <span className="min-w-0 truncate">
        <span className="text-steel">{dir}</span>
        <span className="text-fg">{file.path.slice(dir.length)}</span>
      </span>
      {file.lfs && <LfsTag />}
      <span className="ml-auto shrink-0 font-sans text-[11.5px] text-steel">{label}</span>
    </div>
  );
}

function FileItem({
  file,
  index,
  commenting,
  reviewActions,
  commentVersion,
  viewed,
  openState,
}: {
  file: ChangedFile;
  index: PatchIndex;
  commenting: LineCommenting;
  reviewActions: FileReviewActions;
  commentVersion: string;
  viewed: boolean;
  openState: React.MutableRefObject<Map<string, boolean>>;
}) {
  const big = isBigFile(file);
  // Huge files stay unparsed and collapsed until asked for.
  const [expanded, setExpanded] = useState(() => !big || openState.current.get(file.path) === true);
  const expand = useCallback(() => {
    openState.current.set(file.path, true);
    setExpanded(true);
  }, [openState, file.path]);
  const remembered = openState.current.get(file.path);

  if (!expanded) {
    return (
      <FileDiffView
        key="stub"
        file={stubFor(file)}
        initialOpen={false}
        onExpandRequest={expand}
        collapsedHint={
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-[12px] text-steel">
            <span>Large diff, collapsed to keep the review fast.</span>
            <button
              type="button"
              onClick={expand}
              className="rounded-md border border-line-strong px-2.5 py-1 text-[12px] font-medium text-fg transition-colors hover:bg-raised"
            >
              Show diff ({(file.additions + file.deletions).toLocaleString()} lines)
            </button>
          </div>
        }
      />
    );
  }
  const parsed = index.parsed(file.path);
  if (!parsed) {
    return (
      <div className="rounded-xl border border-line bg-card px-4 py-3 font-mono text-[12px] text-muted">
        {file.path} · no textual diff
      </div>
    );
  }
  return (
    <FileDiffView
      key="full"
      file={parsed}
      commenting={commenting}
      commentVersion={commentVersion}
      review={reviewActions}
      viewed={viewed}
      initialOpen={remembered ?? !viewed}
    />
  );
}
