import * as D from "@radix-ui/react-dialog";
import {
  Archive,
  Check,
  FileCode2,
  FileMinus2,
  FilePlus2,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  RefreshCw,
  Rocket,
  Send,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { archiveAgent } from "@/lib/actions";
import { api } from "@/lib/api";
import { conflictPrompt, gitBusyReason, shipOutcome, toastCommit, toastPr } from "@/lib/gitResults";
import { parseUnified } from "@/lib/diff";
import { pluralize } from "@/lib/format";
import { findFileSlice, hunkPatch, slicePatch } from "@/lib/patchSlices";
import type { Agent, AgentDiff, ChangedFile } from "@/lib/types";
import { basename, cn, errorMessage } from "@/lib/utils";
import { useApp } from "@/store/app";
import { refreshPrSoon } from "@/store/pr";
import { useUi } from "@/store/ui";
import {
  anchorKey,
  DiffBar,
  FileDiffView,
  type FileReviewActions,
  type LineAnchor,
  type LineCommenting,
} from "./DiffView";
import { formatReviewPrompt, useAgentComments, useReviewComments } from "./review/commentStore";
import { LineCommentCard, LineCommentEditor } from "./review/LineComments";
import { fileSignature, useAgentViewed, useViewedFiles } from "./review/viewedStore";
import { ProviderGlyph } from "./ProviderGlyph";
import { ConfirmDialog } from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Input, Label, Textarea } from "./ui/input";
import { Spinner } from "./ui/misc";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Select } from "./ui/select";
import { Skeleton } from "./ui/skeleton";

export function ReviewSheet() {
  const reviewId = useUi((s) => s.reviewAgentId);
  const setReviewAgent = useUi((s) => s.setReviewAgent);
  const agent = useApp((s) => (reviewId ? s.agents[reviewId] : undefined));

  return (
    <D.Root open={!!agent} onOpenChange={(o) => !o && setReviewAgent(null)}>
      <D.Portal>
        <D.Overlay className="anim-fade fixed inset-0 z-50 bg-[var(--scrim)] backdrop-blur-[2px]" />
        <D.Content
          aria-describedby={undefined}
          // Start in the file list (or the first diff on narrow windows), not on the Refresh button.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const root = e.currentTarget as HTMLElement | null;
            requestAnimationFrame(() => {
              const target =
                root?.querySelector<HTMLElement>("[data-file-row]:not([hidden])") ??
                root?.querySelector<HTMLElement>("[data-review-content]");
              (target ?? root)?.focus();
            });
          }}
          // Esc inside a line-comment editor cancels that editor only (Radix listens in the capture phase).
          onEscapeKeyDown={(e) => {
            if (document.activeElement?.closest("[data-comment-editor]")) e.preventDefault();
          }}
          className="anim-sheet fixed inset-y-2 right-2 z-50 flex w-[min(1180px,calc(100vw-72px))] flex-col max-[900px]:left-2 max-[900px]:w-auto overflow-hidden rounded-2xl border border-line-strong bg-panel shadow-[0_24px_80px_-12px_rgba(0,0,0,0.7)] edge-strong focus:outline-none"
        >
          {agent && <ReviewBody agent={agent} onClose={() => setReviewAgent(null)} />}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

const FILE_ICON = { added: FilePlus2, deleted: FileMinus2, modified: FileCode2, renamed: FileCode2 } as const;
type BusyKind = "commit" | "ship" | "merge" | "pr" | "discard" | "send" | "revert";
const BUSY_LABEL: Record<BusyKind, string> = {
  revert: "Couldn't revert",
  commit: "Commit failed",
  ship: "Commit & merge failed",
  send: "Couldn't send the comments",
  merge: "Merge failed",
  pr: "Couldn't open pull request",
  discard: "Couldn't discard worktree",
};

function ReviewBody({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [diff, setDiff] = useState<AgentDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState<BusyKind | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [editing, setEditing] = useState<{ key: string; commentId: string | null } | null>(null);
  const [revertTarget, setRevertTarget] = useState<{ path: string; hunk: number | null } | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);
  /** After a merge: next steps, or conflict help. */
  const [afterMerge, setAfterMerge] = useState<
    | { kind: "merged"; message: string }
    | { kind: "conflict"; message: string }
    // Commit landed but the merge failed for another reason.
    | { kind: "not_merged"; message: string }
    | null
  >(null);
  const gitBlocked = gitBusyReason(agent);
  const viewed = useAgentViewed(agent.id);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reviewFile = useUi((s) => s.reviewFile);
  // "Open PR" from a Done card: open the PR form once the diff has loaded (read once, on open).
  const [prIntent] = useState(() => useUi.getState().reviewIntent === "pr");
  const comments = useAgentComments(agent.id);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.getDiff(agent.id);
      setDiff(d);
      setSelected((s) => s ?? d.files[0]?.path ?? null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const parsed = useMemo(() => (diff ? parseUnified(diff.patch) : []), [diff]);
  const byPath = useMemo(() => new Map(parsed.map((p) => [p.path, p])), [parsed]);
  const totals = useMemo(
    () =>
      (diff?.files ?? []).reduce((a, f) => ({ add: a.add + f.additions, del: a.del + f.deletions }), {
        add: 0,
        del: 0,
      }),
    [diff],
  );

  // Honour a file requested by the caller (e.g. a turn-summary chip), matching by path suffix.
  const pendingFile = useRef(reviewFile);
  useEffect(() => {
    const want = pendingFile.current;
    if (!want || !diff) return;
    const norm = want.replace(/^\.?\//, "");
    const hit =
      diff.files.find((f) => f.path === norm) ??
      diff.files.find((f) => f.path.endsWith(`/${norm}`) || norm.endsWith(`/${f.path}`));
    pendingFile.current = null;
    if (hit) requestAnimationFrame(() => jump(hit.path));
    // `jump` only reads refs and setters, so it's safe to omit from the deps.
  }, [diff]);

  const jump = (path: string) => {
    setSelected(path);
    // Scroll only our own container (scrollIntoView would also move overflow-hidden ancestors).
    const box = scrollRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
    if (box && el) {
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 8;
      box.scrollTo({ top, behavior: "smooth" });
    }
  };

  const run = async <T,>(kind: BusyKind, fn: () => Promise<T>, ok: (r: T) => void): Promise<boolean> => {
    setBusy(kind);
    try {
      ok(await fn());
      if (kind !== "discard") void load();
      return true;
    } catch (e) {
      const msg = errorMessage(e);
      if ((kind === "merge" || kind === "ship") && /conflict/i.test(msg)) {
        setAfterMerge({ kind: "conflict", message: msg });
      } else {
        toast.error(BUSY_LABEL[kind], { description: msg });
      }
      return false;
    } finally {
      setBusy(null);
    }
  };

  // New files whose names look like credentials: ask before a commit takes them.
  const [secrets, setSecrets] = useState<{ files: string[]; then: "commit" | "ship" } | null>(null);
  const checkSecrets = async (then: "commit" | "ship", go: (exclude: string[]) => void) => {
    let files: string[] = [];
    try {
      files = await api.secretLookingFiles(agent.id);
    } catch {
      // The commit itself reports git problems.
    }
    if (files.length > 0) setSecrets({ files, then });
    else go([]);
  };

  const doCommit = (exclude: string[]) =>
    void run(
      "commit",
      () => api.commitAgent(agent.id, commitMsg.trim() || agent.title, exclude),
      (summary) => {
        toastCommit(summary);
        setCommitMsg("");
        refreshPrSoon(agent.id);
      },
    );
  const commit = () => void checkSecrets("commit", doCommit);

  const hasChanges = (diff?.files.length ?? 0) > 0;
  const uncommitted = diff?.uncommitted ?? 0;
  const message = commitMsg.trim() || agent.title;

  const doShip = (exclude: string[]) =>
    void run(
      "ship",
      () => api.shipAgent(agent.id, message, exclude),
      (result) => {
        setCommitMsg("");
        const o = shipOutcome(result);
        if (o.kind === "shipped") {
          toast.success("Committed & merged", {
            description: `${agent.branch ?? "Branch"} is in ${agent.baseBranch ?? "the base branch"}${o.merged ? ` (${o.merged.slice(0, 7)})` : ""}.`,
          });
          setAfterMerge({ kind: "merged", message: "" });
        } else {
          // The commit landed; only the merge failed. A warning, not a success.
          toast.warning("Committed, but not merged", { description: o.error, duration: 10000 });
          setAfterMerge({ kind: o.conflict ? "conflict" : "not_merged", message: o.error });
        }
      },
    );

  const ship = () => void checkSecrets("ship", doShip);

  const merge = () =>
    void run(
      "merge",
      () => api.mergeAgent(agent.id),
      (msg) => {
        toast.success("Merged", { description: msg });
        setAfterMerge({ kind: "merged", message: msg });
      },
    );

  const askToResolve = () =>
    void run(
      "send",
      () => api.sendPrompt(agent.id, conflictPrompt(agent, afterMerge?.message ?? "")),
      () => {
        setAfterMerge(null);
        toast.success("Asked the agent to resolve the conflicts");
      },
    );

  // ---- revert (exact raw slices of the patch; see lib/patchSlices)
  const slices = useMemo(() => (diff ? slicePatch(diff.patch) : []), [diff]);
  const doRevert = async () => {
    if (!revertTarget) return;
    const file = findFileSlice(slices, revertTarget.path);
    const parsedFile = byPath.get(revertTarget.path);
    let patch: string | null = null;
    if (file) {
      if (revertTarget.hunk === null) patch = file.text;
      else {
        // Match the hunk by its @@ header (robust to parser differences), else by index.
        const header = parsedFile?.hunks[revertTarget.hunk]?.header;
        const idx = header ? file.hunks.findIndex((h) => h.header === header) : -1;
        patch = hunkPatch(file, idx >= 0 ? idx : revertTarget.hunk);
      }
    }
    if (!patch) {
      setRevertError("Couldn't find that change in the current diff. Refresh and try again.");
      return;
    }
    setBusy("revert");
    setRevertError(null);
    try {
      await api.revertPatch(agent.id, patch);
      toast.success(revertTarget.hunk === null ? `Reverted ${basename(revertTarget.path)}` : "Reverted the hunk", {
        description: revertTarget.path,
      });
      setRevertTarget(null);
      void load();
    } catch (e) {
      setRevertError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // ---- line comments
  // The `commenting` object is stable (it reads current state through a ref), so files only
  // re-render when their own `commentVersion` changes, and within a file only the touched chunk.
  const live = useRef({ comments, editing, outdatedIds: new Set<string>() });
  // Return focus to the diff line after the editor closes, so keyboard review can continue.
  const returnFocus = useRef<HTMLElement | null>(null);
  const agentId = agent.id;

  const commenting = useMemo<LineCommenting>(() => {
    // (live.current is refreshed below, after outdatedIds is computed)
    const closeEditor = () => {
      setEditing(null);
      const el = returnFocus.current;
      returnFocus.current = null;
      requestAnimationFrame(() => {
        const row = el?.closest("tr") ?? el;
        if (row?.isConnected) row.focus();
      });
    };
    const openEditor = (key: string, commentId: string | null) => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && !active.closest("[data-comment-editor]")) returnFocus.current = active;
      setEditing({ key, commentId });
    };
    const store = useReviewComments.getState;
    return {
      onLineComment: (anchor) => openEditor(anchorKey(anchor), null),
      hasComments: (key) => live.current.comments.some((c) => anchorKey(c) === key),
      noteSignature: (key) => {
        const { comments: cs, editing: ed } = live.current;
        let sig = ed?.key === key ? `e:${ed.commentId ?? "new"};` : "";
        for (const c of cs)
          if (anchorKey(c) === key) sig += `${c.id}:${c.text}:${live.current.outdatedIds.has(c.id) ? 1 : 0};`;
        return sig;
      },
      renderBelowLine: (anchor: LineAnchor) => {
        const key = anchorKey(anchor);
        const { comments: cs, editing: ed } = live.current;
        const here = cs.filter((c) => anchorKey(c) === key);
        const editingHere = ed?.key === key;
        if (here.length === 0 && !editingHere) return null;
        return (
          <div className="space-y-2">
            {here.map((c) =>
              editingHere && ed?.commentId === c.id ? (
                <LineCommentEditor
                  key={c.id}
                  anchor={c}
                  initial={c.text}
                  onCancel={closeEditor}
                  onSave={(text) => {
                    store().update(agentId, c.id, text);
                    closeEditor();
                  }}
                />
              ) : (
                <LineCommentCard
                  key={c.id}
                  comment={c}
                  outdated={live.current.outdatedIds.has(c.id)}
                  onEdit={() => openEditor(key, c.id)}
                  onDelete={() => store().remove(agentId, c.id)}
                />
              ),
            )}
            {editingHere && ed?.commentId === null && (
              <LineCommentEditor
                anchor={anchor}
                onCancel={closeEditor}
                onSave={(text) => {
                  store().add(agentId, anchor, text);
                  closeEditor();
                }}
              />
            )}
          </div>
        );
      },
    };
  }, [agentId]);

  const viewedRef = useRef<{ parsed: typeof parsed }>({ parsed });
  viewedRef.current = { parsed };
  // Revert is blocked while the agent works; read the latest reason without re-creating the actions.
  const gitBlockedRef = useRef(gitBlocked);
  gitBlockedRef.current = gitBlocked;
  const reviewActions = useMemo<FileReviewActions>(
    () => ({
      revertFile: (path) => {
        if (gitBlockedRef.current)
          return void toast.warning("Can't revert right now", { description: gitBlockedRef.current });
        setRevertError(null);
        setRevertTarget({ path, hunk: null });
      },
      revertHunk: (path, hunk) => {
        if (gitBlockedRef.current)
          return void toast.warning("Can't revert right now", { description: gitBlockedRef.current });
        setRevertError(null);
        setRevertTarget({ path, hunk });
      },
      toggleViewed: (path) => {
        const f = viewedRef.current.parsed.find((p) => p.path === path);
        if (f) useViewedFiles.getState().toggle(agentId, path, fileSignature(f));
      },
    }),
    [agentId],
  );
  const isViewed = (path: string) => {
    const f = byPath.get(path);
    return !!f && viewed[path] === fileSignature(f);
  };

  // Comments whose line changed (or vanished) since they were written, e.g. after Refresh.
  const outdatedIds = useMemo(() => {
    const out = new Set<string>();
    for (const c of comments) {
      const f = byPath.get(c.path);
      const line = f?.hunks
        .flatMap((h) => h.lines)
        .find((l) => (c.side === "new" ? l.newNo === c.line : l.newNo === null && l.oldNo === c.line));
      if (!line || line.text !== c.code) out.add(c.id);
    }
    return out;
  }, [comments, byPath]);
  const orphaned = useMemo(
    () =>
      comments.filter(
        (c) =>
          !byPath
            .get(c.path)
            ?.hunks.some((h) =>
              h.lines.some((l) => (c.side === "new" ? l.newNo === c.line : l.newNo === null && l.oldNo === c.line)),
            ),
      ),
    [comments, byPath],
  );

  /** Per-file signature of comments + editor state: the memo key that re-renders just that file. */
  const fileVersions = useMemo(() => {
    const m = new Map<string, string>();
    const add = (path: string, part: string) => m.set(path, (m.get(path) ?? "") + part);
    for (const c of comments) add(c.path, `${c.id}:${c.side}${c.line}:${c.text}:${outdatedIds.has(c.id) ? 1 : 0};`);
    if (editing) add(editing.key.split("\u0000")[0], `e:${editing.key}:${editing.commentId ?? "new"};`);
    return m;
  }, [comments, editing, outdatedIds]);
  live.current = { comments, editing, outdatedIds };

  const sendComments = () =>
    void run(
      "send",
      () => api.sendPrompt(agent.id, formatReviewPrompt(comments)),
      () => {
        const n = comments.length;
        useReviewComments.getState().clear(agent.id);
        setEditing(null);
        const busyNow =
          agent.status === "working" || agent.status === "starting" || agent.status === "needs_permission";
        toast.success(`Sent ${pluralize(n, "comment")} to the agent`, {
          description: busyNow ? "Queued: it runs right after the current turn." : undefined,
        });
      },
    );

  return (
    <>
      <header className="texture flex shrink-0 items-center gap-3 border-b border-line px-5 py-3.5">
        <ProviderGlyph provider={agent.provider} customAgentId={agent.customAgentId} size="md" />
        <div className="min-w-0 flex-1">
          <D.Title className="truncate text-[15px] font-semibold tracking-tight">Review · {agent.title}</D.Title>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
            <GitBranch className="h-3.5 w-3.5 text-steel" />
            <span className="font-mono text-[11.5px]">{agent.branch ?? "working tree"}</span>
            {agent.baseBranch && (
              <>
                <span className="text-steel">into</span>
                <span className="font-mono text-[11.5px]">{agent.baseBranch}</span>
              </>
            )}
            {diff && (
              <>
                <span className="text-line-strong">·</span>
                <span className="inline-flex items-center gap-2 whitespace-nowrap">
                  {pluralize(diff.files.length, "file")}
                  <span className="font-mono text-[11px] text-ok">+{totals.add}</span>
                  <span className="font-mono text-[11px] text-err">−{totals.del}</span>
                </span>
                {diff.ahead > 0 && (
                  <>
                    <span className="text-line-strong">·</span>
                    <span>{pluralize(diff.ahead, "commit")} ahead</span>
                  </>
                )}
                {uncommitted > 0 && (
                  <span className="inline-flex h-5 items-center rounded-md border border-warn/35 bg-warn/10 px-1.5 text-[11px] font-medium text-warn">
                    {uncommitted} uncommitted
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="Refresh diff" onClick={() => void load()}>
          <RefreshCw className={cn(loading && "animate-spin")} />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Close review" onClick={onClose}>
          <X />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 max-[900px]:flex-col">
        {/* Narrow windows: a file picker bar instead of the sidebar. */}
        {diff && diff.files.length > 0 && (
          <div className="hidden shrink-0 items-center gap-2.5 border-b border-line bg-panel px-3 py-2 max-[900px]:flex">
            <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-steel">
              {pluralize(diff.files.length, "file")}
            </span>
            <Select
              aria-label="Jump to file"
              value={selected ?? undefined}
              onValueChange={jump}
              className="h-8 min-w-0 flex-1 font-mono text-[12px]"
              options={diff.files.map((f) => ({
                value: f.path,
                label: (
                  <span className="flex min-w-0 items-center gap-2 font-mono text-[12px]">
                    <span className="truncate">{f.path}</span>
                    <span className="shrink-0 text-ok">+{f.additions}</span>
                    <span className="shrink-0 text-err">−{f.deletions}</span>
                  </span>
                ),
              }))}
            />
          </div>
        )}
        <nav
          aria-label="Changed files"
          className="flex w-[250px] shrink-0 flex-col border-r border-line bg-panel max-[900px]:hidden"
        >
          <div className="px-4 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-steel">
            Changed files
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {loading && !diff ? (
              <div className="space-y-2.5 px-2 pt-1">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-7" />
                ))}
              </div>
            ) : (
              diff?.files.map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  active={selected === f.path}
                  viewed={isViewed(f.path)}
                  onClick={() => jump(f.path)}
                />
              ))
            )}
          </div>
        </nav>

        <div
          ref={scrollRef}
          data-review-content
          tabIndex={-1}
          aria-label="Diff"
          className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-base p-4 outline-none max-sm:p-2.5"
        >
          {error ? (
            <div className="rounded-xl border border-err/30 bg-err/[0.06] p-4 text-[13px]">
              <p className="font-medium text-err">Couldn't load the diff</p>
              <p className="selectable mt-1 break-words font-mono text-[12px] text-muted">{error}</p>
              <Button size="sm" variant="secondary" className="mt-3" onClick={() => void load()}>
                <RefreshCw /> Try again
              </Button>
            </div>
          ) : loading && !diff ? (
            <div className="space-y-3">
              <Skeleton className="h-9 rounded-xl" />
              <Skeleton className="h-48 rounded-xl" />
              <Skeleton className="h-9 rounded-xl" />
            </div>
          ) : !hasChanges ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <GitCommitHorizontal className="mb-3 h-8 w-8 text-steel" />
              <p className="text-[14px] font-medium">Nothing to review</p>
              <p className="mt-1 text-[12.5px] text-muted">The working tree matches the base commit.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {diff?.truncated && (
                <div
                  role="note"
                  className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/[0.07] px-3.5 py-2.5 text-[12.5px]"
                >
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
                  <span className="text-muted">
                    <span className="font-medium text-fg">This diff was cut at 8 MB.</span> The file list is complete,
                    but some file contents aren't shown.
                  </span>
                </div>
              )}
              {(diff?.files ?? []).map((f) => {
                const p = byPath.get(f.path);
                return (
                  <div key={f.path} data-path={f.path} className="scroll-mt-2">
                    {p ? (
                      <FileDiffView
                        file={p}
                        commenting={commenting}
                        commentVersion={fileVersions.get(p.path) ?? ""}
                        review={reviewActions}
                        viewed={isViewed(p.path)}
                      />
                    ) : (
                      <div className="rounded-xl border border-line bg-card px-4 py-3 font-mono text-[12px] text-muted">
                        {f.path} · no textual diff
                      </div>
                    )}
                  </div>
                );
              })}
              <p className="px-1 pt-1 text-center text-[11.5px] text-steel">
                Click a line number (or focus a line and press Enter) to leave a comment for the agent.
              </p>
            </div>
          )}
          {orphaned.length > 0 && (
            <div className="mt-3 rounded-xl border border-line-strong bg-card/80 p-3">
              <p className="mb-2 text-[12px] font-medium text-muted">
                {pluralize(orphaned.length, "comment")} no longer {orphaned.length === 1 ? "matches" : "match"} a line
                in this diff (the code changed). {orphaned.length === 1 ? "It's" : "They're"} still sent with the line
                as you saw it.
              </p>
              <div className="space-y-2">
                {orphaned.map((c) => (
                  <LineCommentCard
                    key={c.id}
                    comment={c}
                    outdated
                    onDelete={() => useReviewComments.getState().remove(agent.id, c.id)}
                  />
                ))}
              </div>
            </div>
          )}
          {comments.length > 0 && (
            <div className="sticky bottom-0 z-[2] mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-warn/35 bg-raised/95 px-3 py-2 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.6)] backdrop-blur-xl edge">
              <MessageSquare className="h-4 w-4 shrink-0 text-warn" />
              <span className="text-[13px] font-medium">{pluralize(comments.length, "comment")}</span>
              <span className="hidden truncate text-[12px] text-steel sm:inline">
                in {pluralize(new Set(comments.map((c) => c.path)).size, "file")}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => {
                  useReviewComments.getState().clear(agent.id);
                  setEditing(null);
                }}
              >
                Clear
              </Button>
              <Button size="sm" variant="primary" disabled={busy !== null} onClick={sendComments}>
                {busy === "send" ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Send />}
                Send to agent
              </Button>
            </div>
          )}
        </div>
      </div>

      {afterMerge && (
        <div
          role="status"
          className={cn(
            "flex shrink-0 flex-wrap items-center gap-2 border-t px-4 py-2.5 text-[12.5px]",
            afterMerge.kind === "merged" ? "border-ok/25 bg-ok/[0.07]" : "border-warn/30 bg-warn/[0.08]",
          )}
        >
          {afterMerge.kind === "merged" ? (
            <>
              <GitMerge className="h-4 w-4 shrink-0 text-ok" />
              <span className="min-w-0 flex-1">
                <span className="font-medium text-fg">Merged.</span>{" "}
                <span className="text-muted">Clean up the worktree, or archive the agent if it's done.</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDiscard(true)} disabled={!agent.worktree}>
                <Trash2 /> Discard worktree
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void archiveAgent(agent, true);
                  onClose();
                }}
              >
                <Archive /> Archive agent
              </Button>
            </>
          ) : (
            <>
              <TriangleAlert className="h-4 w-4 shrink-0 text-warn" />
              <span className="min-w-0 flex-1">
                <span className="font-medium text-fg">
                  {afterMerge.kind === "conflict"
                    ? "Committed, but the merge hit a conflict."
                    : "Committed, but not merged."}
                </span>{" "}
                <span className="selectable break-words text-muted">{afterMerge.message}</span>
              </span>
              <Button size="sm" variant="primary" onClick={askToResolve} disabled={busy !== null}>
                {busy === "send" ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Send />}
                Ask the agent to resolve
              </Button>
            </>
          )}
          <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={() => setAfterMerge(null)}>
            <X className="!h-3.5 !w-3.5" />
          </Button>
        </div>
      )}

      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-panel px-4 py-3">
        <div className="flex min-w-[min(280px,100%)] flex-[1_1_320px] items-center gap-2">
          <Input
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder={`Commit message (default: “${agent.title}”)`}
            aria-label="Commit message"
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && uncommitted > 0 && busy === null && !gitBlocked) commit();
            }}
            className="h-8"
          />
          <Button
            variant={agent.worktree ? "secondary" : "primary"}
            disabled={uncommitted === 0 || busy !== null || !!gitBlocked}
            title={gitBlocked ?? (uncommitted === 0 ? "Nothing to commit" : undefined)}
            onClick={commit}
          >
            {busy === "commit" ? <Spinner className="h-3.5 w-3.5 text-current" /> : <GitCommitHorizontal />}
            Commit
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 max-[900px]:w-full">
          <Button
            variant="danger"
            disabled={busy !== null || !agent.worktree || !!gitBlocked}
            title={
              !agent.worktree
                ? "Only agents running in their own worktree have one to discard"
                : (gitBlocked ?? undefined)
            }
            onClick={() => setConfirmDiscard(true)}
          >
            <Trash2 />
            Discard
          </Button>
          <PrPopover
            agent={agent}
            autoOpen={prIntent && !!diff}
            busy={busy === "pr"}
            disabled={busy !== null}
            onSubmit={async (t, b) => {
              // Errors stay inline in the form (the popover keeps what you wrote).
              setBusy("pr");
              try {
                toastPr(await api.createPr(agent.id, t, b));
                refreshPrSoon(agent.id);
                return null;
              } catch (e) {
                return errorMessage(e);
              } finally {
                setBusy(null);
              }
            }}
          />
          <MergePopover
            agent={agent}
            busy={busy === "merge"}
            disabled={busy !== null || !agent.worktree || uncommitted > 0 || (diff?.ahead ?? 0) === 0 || !!gitBlocked}
            disabledReason={
              gitBlocked
                ? gitBlocked
                : !agent.worktree
                  ? "Only agents running in their own worktree can be merged"
                  : uncommitted > 0
                    ? "Commit first, or use Commit & merge"
                    : (diff?.ahead ?? 0) === 0
                      ? "No commits to merge yet"
                      : undefined
            }
            onConfirm={merge}
          />
          {agent.worktree && (
            <ShipPopover
              agent={agent}
              uncommitted={uncommitted}
              message={message}
              busy={busy === "ship"}
              disabled={busy !== null || (!hasChanges && (diff?.ahead ?? 0) === 0) || !!gitBlocked}
              disabledReason={
                gitBlocked ?? (!hasChanges && (diff?.ahead ?? 0) === 0 ? "Nothing to ship yet" : undefined)
              }
              onConfirm={ship}
            />
          )}
        </div>
      </footer>

      <ConfirmDialog
        open={secrets !== null}
        onOpenChange={(o) => {
          if (!o) setSecrets(null);
        }}
        title="These files look like secrets"
        description="These files look like secrets and will be committed:"
        confirmLabel="Exclude them"
        onConfirm={() => {
          const cur = secrets;
          setSecrets(null);
          if (cur) (cur.then === "commit" ? doCommit : doShip)(cur.files);
        }}
      >
        <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-line bg-base/40 px-3 py-2 font-mono text-[12px]">
          {secrets?.files.map((f) => (
            <li key={f} className="truncate" title={f}>
              {f}
            </li>
          ))}
        </ul>
        <Button
          size="sm"
          variant="ghost"
          className="mt-2"
          onClick={() => {
            const cur = secrets;
            setSecrets(null);
            if (cur) (cur.then === "commit" ? doCommit : doShip)([]);
          }}
        >
          Commit anyway
        </Button>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        danger
        title="Discard this worktree?"
        description={
          <>
            This deletes the worktree and the <span className="font-mono text-fg">{agent.branch}</span> branch.
            Uncommitted and unmerged changes will be lost. This can't be undone.
          </>
        }
        confirmLabel="Discard worktree"
        busy={busy === "discard"}
        onConfirm={async () => {
          setConfirmDiscard(false);
          await run(
            "discard",
            () => api.discardWorktree(agent.id),
            () => {
              toast.success("Worktree discarded");
              onClose();
            },
          );
        }}
      />
      <ConfirmDialog
        open={revertTarget !== null}
        onOpenChange={(o) => {
          if (!o && busy !== "revert") {
            setRevertTarget(null);
            setRevertError(null);
          }
        }}
        danger
        busy={busy === "revert"}
        title={revertTarget?.hunk === null ? "Revert this file?" : "Revert this hunk?"}
        description={
          revertTarget && (
            <>
              This discards the agent's change to <span className="font-mono text-fg">{revertTarget.path}</span>
              {revertTarget.hunk !== null && " (this hunk only)"}; it can't be undone.
            </>
          )
        }
        confirmLabel={revertTarget?.hunk === null ? "Revert file" : "Revert hunk"}
        onConfirm={doRevert}
      >
        {revertError && (
          <div role="alert" className="rounded-lg border border-err/30 bg-err/[0.07] px-3 py-2 text-[12.5px]">
            <p className="font-medium text-err">{revertError}</p>
            {/changed since|couldn't find/i.test(revertError) && (
              <Button
                size="xs"
                variant="ghost"
                className="-ml-1.5 mt-1"
                onClick={() => {
                  setRevertTarget(null);
                  setRevertError(null);
                  void load();
                }}
              >
                <RefreshCw className="!h-3 !w-3" /> Refresh the diff
              </Button>
            )}
          </div>
        )}
      </ConfirmDialog>
    </>
  );
}

function FileRow({
  file,
  active,
  viewed,
  onClick,
}: {
  file: ChangedFile;
  active: boolean;
  viewed: boolean;
  onClick: () => void;
}) {
  const Icon = FILE_ICON[file.status];
  const name = file.path.split("/").pop() ?? file.path;
  const dir = file.path.slice(0, file.path.length - name.length);
  return (
    <button
      type="button"
      data-file-row
      onClick={onClick}
      title={file.path}
      aria-current={active ? "true" : undefined}
      aria-label={`${file.path}, ${file.status}, ${file.additions} added, ${file.deletions} removed${viewed ? ", viewed" : ""}`}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
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

/** Primary path for worktree agents: commit what's left, then merge into the base branch. */
function ShipPopover({
  agent,
  uncommitted,
  message,
  busy,
  disabled,
  disabledReason,
  onConfirm,
}: {
  agent: Agent;
  uncommitted: number;
  message: string;
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
  onConfirm: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="primary" disabled={disabled} title={disabled ? disabledReason : undefined}>
          {busy ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Rocket />}
          Commit & merge
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[340px]">
        <p className="text-[13px] font-semibold">Ship these changes?</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
          {uncommitted > 0 ? (
            <>
              Commit {pluralize(uncommitted, "uncommitted file")} as{" "}
              <span className="font-medium text-fg">“{message}”</span>, then merge{" "}
            </>
          ) : (
            <>Merge </>
          )}
          <span className="font-mono text-[12px] text-fg">{agent.branch ?? "this branch"}</span> into{" "}
          <span className="font-mono text-[12px] text-fg">{agent.baseBranch ?? "the base branch"}</span>.
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <PopoverClose asChild>
            <Button size="sm" variant="ghost">
              Cancel
            </Button>
          </PopoverClose>
          <PopoverClose asChild>
            <Button size="sm" variant="primary" onClick={onConfirm} autoFocus>
              <Rocket /> {uncommitted > 0 ? "Commit & merge" : "Merge"}
            </Button>
          </PopoverClose>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Plain merge (everything already committed), with a confirm. */
function MergePopover({
  agent,
  busy,
  disabled,
  disabledReason,
  onConfirm,
}: {
  agent: Agent;
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
  onConfirm: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="secondary" disabled={disabled} title={disabled ? disabledReason : undefined}>
          {busy ? <Spinner className="h-3.5 w-3.5" /> : <GitMerge />}
          Merge
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[320px]">
        <p className="text-[13px] font-semibold">Merge into {agent.baseBranch ?? "the base branch"}?</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
          Merges <span className="font-mono text-[12px] text-fg">{agent.branch ?? "this branch"}</span> into{" "}
          <span className="font-mono text-[12px] text-fg">{agent.baseBranch ?? "the base branch"}</span> in your project
          folder.
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <PopoverClose asChild>
            <Button size="sm" variant="ghost">
              Cancel
            </Button>
          </PopoverClose>
          <PopoverClose asChild>
            <Button size="sm" variant="primary" onClick={onConfirm} autoFocus>
              <GitMerge /> Merge
            </Button>
          </PopoverClose>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PrPopover({
  agent,
  busy,
  disabled,
  onSubmit,
  autoOpen = false,
}: {
  autoOpen?: boolean;
  agent: Agent;
  busy: boolean;
  disabled: boolean;
  /** Resolves to an error message to show inline, or null on success. */
  onSubmit: (title: string, body: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  // Fresh defaults each time the form opens (the agent may have been renamed or said more since).
  const onOpenChange = (next: boolean) => {
    if (!next && submitting) return;
    if (next) {
      setFormError(null);
      setTitle(agent.title);
      setBody(agent.lastMessage ? `## Summary\n\n${agent.lastMessage}\n\n_Opened from Armada._` : "");
    }
    setOpen(next);
  };
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!autoOpen || autoOpened.current || disabled || !agent.branch) return;
    autoOpened.current = true;
    onOpenChange(true);
    // onOpenChange only seeds the form from the agent; it's stable enough for a one-shot open.
  }, [autoOpen, disabled, agent.branch]);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          disabled={disabled || !agent.branch}
          title={!agent.branch ? "This agent has no branch to open a pull request from" : undefined}
        >
          {busy ? <Spinner className="h-3.5 w-3.5" /> : <GitPullRequest />}
          Open PR
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[380px]">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (submitting) return;
            setSubmitting(true);
            // Close only on success, so a failure (e.g. gh not signed in) keeps what you wrote.
            setFormError(null);
            const err = await onSubmit(title.trim() || agent.title, body);
            setSubmitting(false);
            if (err === null) setOpen(false);
            else setFormError(err);
          }}
          className="space-y-3"
        >
          <div>
            <Label htmlFor="pr-title">Title</Label>
            <Input
              id="pr-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault();
              }}
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="pr-body">Description</Label>
            <Textarea
              id="pr-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="min-h-28 font-mono text-[12px]"
            />
          </div>
          {formError && (
            <p role="alert" className="rounded-lg border border-err/30 bg-err/[0.07] px-2.5 py-2 text-[12px] text-err">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" type="button" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={submitting}>
              {submitting ? <Spinner className="h-3.5 w-3.5 text-current" /> : <GitPullRequest />} Create pull request
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
