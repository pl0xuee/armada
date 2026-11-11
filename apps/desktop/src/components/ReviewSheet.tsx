import * as D from "@radix-ui/react-dialog";
import {
  Archive,
  Ellipsis,
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
import { conflictPrompt, gitBusyReason, mergeToast, shipOutcome, toastCommit, toastPr } from "@/lib/gitResults";
import { GithubDialog } from "./git/GithubDialog";
import { PushBaseNotice } from "./git/PushBaseNotice";
import { pluralize } from "@/lib/format";
import { PatchIndex } from "@/lib/patchIndex";
import { findFileSlice, hunkPatch } from "@/lib/patchSlices";
import { createLatest, HIDE_COMPACT_DEFAULT_OVER, isCompactFile, orderReviewFiles } from "@/lib/reviewFiles";
import { prefillPr } from "@/lib/prFlow";
import type { Agent, AgentDiff, BaseBranchStatus, ChangedFile } from "@/lib/types";
import { basename, cn, errorMessage } from "@/lib/utils";
import { useApp } from "@/store/app";
import { refreshPrSoon } from "@/store/pr";
import { useUi } from "@/store/ui";
import { anchorKey, type FileReviewActions, type LineAnchor, type LineCommenting } from "./DiffView";
import { formatReviewPrompt, useAgentComments, useReviewComments } from "./review/commentStore";
import { LineCommentCard, LineCommentEditor } from "./review/LineComments";
import { LFS_BLOCK_REASON, LfsNotice } from "./review/LfsNotice";
import { ReviewDiffColumn, type DiffColumnHandle } from "./review/ReviewDiffColumn";
import { ReviewFileList } from "./review/ReviewFileList";
import { fileSignature, useAgentViewed, useViewedFiles } from "./review/viewedStore";
import { ProviderGlyph } from "./ProviderGlyph";
import { GithubGlyph } from "./settings/GithubGlyph";
import { ConfirmDialog } from "./ui/alert-dialog";
import { useReturnFocus } from "./ui/returnFocus";
import { Button } from "./ui/button";
import { Input, Label, Textarea } from "./ui/input";
import { Spinner } from "./ui/misc";
import { Select } from "./ui/select";
import { Switch } from "./ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/menu";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { FilePicker } from "./review/FilePicker";
import { Skeleton } from "./ui/skeleton";

export function ReviewSheet() {
  const reviewId = useUi((s) => s.reviewAgentId);
  const setReviewAgent = useUi((s) => s.setReviewAgent);
  const agent = useApp((s) => (reviewId ? s.agents[reviewId] : undefined));
  // Opened from a pill, a chip or a shortcut (no Radix trigger): focus goes back to where it was on close.
  const focus = useReturnFocus({
    // Start in the file list (or the first diff on narrow windows), not on the Refresh button.
    onOpenAutoFocus: (e) => {
      e.preventDefault();
      const root = e.currentTarget as HTMLElement | null;
      requestAnimationFrame(() => {
        const target =
          root?.querySelector<HTMLElement>("[data-file-row]:not([hidden])") ??
          root?.querySelector<HTMLElement>("[data-review-content]");
        (target ?? root)?.focus();
      });
    },
  });

  return (
    <D.Root open={!!agent} onOpenChange={(o) => !o && setReviewAgent(null)}>
      <D.Portal>
        <D.Overlay className="anim-fade fixed inset-0 z-50 bg-[var(--scrim)]" />
        <D.Content
          aria-describedby={undefined}
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
          // Esc inside a line-comment editor cancels that editor only (Radix listens in the capture phase).
          onEscapeKeyDown={(e) => {
            if (document.activeElement?.closest("[data-comment-editor]")) e.preventDefault();
          }}
          className="anim-sheet fixed inset-y-2 right-2 z-50 flex w-[min(1180px,calc(100vw-72px))] flex-col max-[900px]:left-2 max-[900px]:w-auto overflow-hidden rounded-2xl border border-line-strong bg-panel shadow-[0_24px_80px_-12px_rgba(0,0,0,0.7)] edge-strong focus:outline-none"
        >
          {agent && <ReviewBody key={agent.id} agent={agent} onClose={() => setReviewAgent(null)} />}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

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
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [confirmShip, setConfirmShip] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const prAfterMenu = useRef(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const [editing, setEditing] = useState<{ key: string; commentId: string | null } | null>(null);
  const [revertTarget, setRevertTarget] = useState<{ path: string; hunk: number | null } | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);
  /** After a merge: next steps, or conflict help. */
  const [afterMerge, setAfterMerge] = useState<
    | { kind: "merged"; message: string; baseStatus: BaseBranchStatus | null }
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

  // Only the newest request may write state: a slow older response (or one that lands after
  // the sheet closed) must not overwrite a newer diff or clear the loading state.
  const latest = useRef(createLatest());
  const load = useCallback(async () => {
    const token = latest.current.begin();
    setLoading(true);
    setError(null);
    try {
      const d = await api.getDiff(agent.id);
      if (!latest.current.isCurrent(token)) return;
      setDiff(d);
      setSelected((s) => (s && d.files.some((f) => f.path === s) ? s : (d.files[0]?.path ?? null)));
    } catch (e) {
      if (latest.current.isCurrent(token)) setError(errorMessage(e));
    } finally {
      if (latest.current.isCurrent(token)) setLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    const l = latest.current;
    void load();
    return () => l.cancel();
  }, [load]);

  // Say so when a big diff is slow to arrive.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading || diff) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(t);
  }, [loading, diff]);

  // One cheap scan finds each file's section; files are parsed only when first shown.
  const index = useMemo(() => (diff ? new PatchIndex(diff.patch) : null), [diff]);
  const [hideCompactChoice, setHideCompactChoice] = useState<boolean | null>(null);
  const ordered = useMemo(() => {
    if (!diff || !index) return { list: [], textCount: 0, compactCount: 0 };
    const all = orderReviewFiles(diff.files, index, false);
    const hide = hideCompactChoice ?? all.compactCount > HIDE_COMPACT_DEFAULT_OVER;
    return hide ? orderReviewFiles(diff.files, index, true) : all;
  }, [diff, index, hideCompactChoice]);
  const hideCompact = ordered.list.length === ordered.textCount && ordered.compactCount > 0;
  const shownFiles = ordered.list;
  const compactOf = useCallback(
    (f: { path: string; lfs: boolean }) => (index ? isCompactFile(f as never, index) : false),
    [index],
  );
  const columnRef = useRef<DiffColumnHandle>(null);
  const openState = useRef(new Map<string, boolean>());
  useEffect(() => {
    openState.current = new Map();
  }, [diff]);
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
    if (hit) {
      // A binary/LFS target may be filtered out: show them so it can be found.
      if (index && isCompactFile(hit, index)) setHideCompactChoice(false);
      requestAnimationFrame(() => requestAnimationFrame(() => jump(hit.path)));
    }
    // `jump` only reads refs and setters, so it's safe to omit from the deps.
  }, [diff]);

  const jump = (path: string) => {
    setSelected(path);
    columnRef.current?.scrollToPath(path);
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
    // The look at the repo can take a while: show the spinner now so a second click can't start a second commit.
    setBusy(then);
    let files: string[] = [];
    try {
      files = await api.secretLookingFiles(agent.id);
    } catch {
      // The commit itself reports git problems.
    }
    if (files.length > 0) {
      setBusy(null);
      setSecrets({ files, then });
    } else go([]);
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
  // Without git-lfs we can't tell what really changed; the backend refuses too.
  // Same rule as the backend's commit check: only when a changed file is an LFS file.
  const lfsAssetsChanged = !!diff?.lfs?.toolMissing && diff.files.some((f) => f.lfs);
  const lfsBlocked = lfsAssetsChanged ? LFS_BLOCK_REASON : null;
  const uncommitted = diff?.uncommitted ?? 0;
  // Until the first diff lands we can't know what Discard would throw away or what a merge carries.
  const diffPending = loading && !diff;
  const PENDING_REASON = "Waiting for the diff to load";
  const message = commitMsg.trim() || agent.title;
  // With no changes and no commits ahead there is nothing to ship, merge or open a pull request for.
  const nothingToShip = !hasChanges && (diff?.ahead ?? 0) === 0;
  const prReason = diffPending
    ? PENDING_REASON
    : !agent.branch
      ? "This agent has no branch to open a pull request from"
      : nothingToShip
        ? "Nothing to open a pull request for yet"
        : null;
  const mergeReason = diffPending
    ? PENDING_REASON
    : lfsBlocked
      ? lfsBlocked
      : gitBlocked
        ? gitBlocked
        : !agent.worktree
          ? "Only agents running in their own worktree can be merged"
          : uncommitted > 0
            ? "Commit first, or use Commit & merge"
            : (diff?.ahead ?? 0) === 0
              ? "No commits to merge yet"
              : null;
  const shipReason =
    (diffPending ? PENDING_REASON : null) ?? lfsBlocked ?? gitBlocked ?? (nothingToShip ? "Nothing to ship yet" : null);
  const discardReason = !agent.worktree
    ? "Only agents running in their own worktree have one to discard"
    : diffPending
      ? PENDING_REASON
      : gitBlocked;

  const doShip = (exclude: string[]) =>
    void run(
      "ship",
      () => api.shipAgent(agent.id, message, exclude),
      (result) => {
        setCommitMsg("");
        const o = shipOutcome(result);
        if (o.kind === "shipped") {
          toast.success("Committed & merged locally", {
            description: mergeToast(agent.branch ?? "Branch", agent.baseBranch ?? "the base branch", o.baseStatus),
          });
          setAfterMerge({ kind: "merged", message: "", baseStatus: o.baseStatus });
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
        toast.success("Merged locally", { description: `${msg} Not pushed to the remote.` });
        setAfterMerge({ kind: "merged", message: msg, baseStatus: null });
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
  const doRevert = async () => {
    if (!revertTarget || !index) return;
    const sliced = index.slice(revertTarget.path);
    const file = sliced ? findFileSlice([sliced], revertTarget.path) : undefined;
    const parsedFile = index.parsed(revertTarget.path);
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
      const undo = () => {
        api.applyPatch(agent.id, patch).then(
          () => {
            toast.success("Revert undone");
            void load();
          },
          (e) => toast.error("Couldn't undo the revert", { description: errorMessage(e) }),
        );
      };
      toast.success(revertTarget.hunk === null ? `Reverted ${basename(revertTarget.path)}` : "Reverted the hunk", {
        description: revertTarget.path,
        duration: 12000,
        action: { label: "Undo", onClick: undo },
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

  const indexRef = useRef(index);
  indexRef.current = index;
  // Revert is blocked while the agent works; read the latest reason without re-creating the actions.
  const gitBlockedRef = useRef(gitBlocked);
  gitBlockedRef.current = gitBlocked;
  const openStateRef = openState;
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
        const f = indexRef.current?.parsed(path);
        if (f) useViewedFiles.getState().toggle(agentId, path, fileSignature(f));
      },
      setOpen: (path, open) => void openStateRef.current.set(path, open),
    }),
    [agentId],
  );
  const isViewed = (path: string) => {
    if (viewed[path] === undefined) return false;
    const f = index?.parsed(path);
    return !!f && viewed[path] === fileSignature(f);
  };

  // Comments whose line changed (or vanished) since they were written, e.g. after Refresh.
  const outdatedIds = useMemo(() => {
    const out = new Set<string>();
    for (const c of comments) {
      const f = index?.parsed(c.path);
      const line = f?.hunks
        .flatMap((h) => h.lines)
        .find((l) => (c.side === "new" ? l.newNo === c.line : l.newNo === null && l.oldNo === c.line));
      if (!line || line.text !== c.code) out.add(c.id);
    }
    return out;
  }, [comments, index]);
  const orphaned = useMemo(
    () =>
      comments.filter(
        (c) =>
          !index
            ?.parsed(c.path)
            ?.hunks.some((h) =>
              h.lines.some((l) => (c.side === "new" ? l.newNo === c.line : l.newNo === null && l.oldNo === c.line)),
            ),
      ),
    [comments, index],
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
          <div className="mt-0.5 flex items-center gap-x-2 whitespace-nowrap text-caption text-muted [&>*:not([data-shrink])]:shrink-0">
            <GitBranch className="h-3.5 w-3.5 text-steel" />
            <span data-shrink className="min-w-0 truncate font-mono text-meta" title={agent.branch ?? undefined}>
              {agent.branch ?? "working tree"}
            </span>
            {agent.baseBranch && (
              <>
                <span className="text-steel">into</span>
                <span className="font-mono text-meta">{agent.baseBranch}</span>
              </>
            )}
            {diff && (
              <>
                <span className="text-line-strong">·</span>
                <span className="inline-flex items-center gap-2 whitespace-nowrap">
                  {pluralize(diff.files.length, "file")}
                  <span className="font-mono text-micro text-ok">+{totals.add}</span>
                  <span className="font-mono text-micro text-err">−{totals.del}</span>
                </span>
                {diff.ahead > 0 && (
                  <>
                    <span className="text-line-strong">·</span>
                    <span className="max-[900px]:hidden">{pluralize(diff.ahead, "commit")} ahead</span>
                    <span className="min-[901px]:hidden" title={`${pluralize(diff.ahead, "commit")} ahead`}>
                      {diff.ahead} ahead
                    </span>
                  </>
                )}
                {uncommitted > 0 && (
                  <span className="inline-flex h-5 items-center rounded-md border border-warn/35 bg-warn/10 px-1.5 text-micro font-medium text-warn">
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

      <LfsNotice lfs={diff?.lfs ?? null} blocking={lfsAssetsChanged} />
      {diff?.truncated && (
        <div
          role="note"
          className="flex shrink-0 items-start gap-2 border-b border-warn/30 bg-warn/[0.07] px-5 py-2 text-small"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
          <span className="text-muted">
            <span className="font-medium text-fg">This diff was cut at 8 MB.</span> The file list is complete, but some
            file contents aren't shown.
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1 max-[900px]:flex-col">
        {/* Narrow windows: a file picker bar instead of the sidebar. */}
        {diff && diff.files.length > 0 && (
          <div className="hidden shrink-0 items-center gap-2.5 border-b border-line bg-panel px-3 py-2 max-[900px]:flex">
            <span className="shrink-0 eyebrow text-steel">{pluralize(diff.files.length, "file")}</span>
            <FilePicker files={shownFiles} selected={selected} onSelect={jump} />
          </div>
        )}
        <nav
          aria-label="Changed files"
          className="flex w-[250px] shrink-0 flex-col border-r border-line bg-panel max-[900px]:hidden"
        >
          <div className="px-4 pb-1.5 pt-3 eyebrow text-steel">Changed files</div>
          {ordered.compactCount > 0 && (
            <button
              type="button"
              onClick={() => setHideCompactChoice(!hideCompact)}
              aria-pressed={hideCompact}
              className="mx-2 mb-1.5 rounded-md border border-line px-2 py-1 text-left text-meta text-muted transition-colors hover:bg-raised/60 hover:text-fg"
            >
              {hideCompact
                ? `Show ${ordered.compactCount.toLocaleString()} binary/LFS files`
                : `Hide ${ordered.compactCount.toLocaleString()} binary/LFS files`}
            </button>
          )}
          {loading && !diff ? (
            <div className="space-y-2.5 px-4 pt-1">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-7" />
              ))}
            </div>
          ) : (
            <ReviewFileList files={shownFiles} selected={selected} isViewed={isViewed} onSelect={jump} />
          )}
        </nav>

        <div
          ref={scrollRef}
          data-review-content
          tabIndex={-1}
          aria-label="Diff"
          className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-base px-4 outline-none max-sm:px-2.5"
        >
          {error ? (
            <div className="m-4 rounded-xl border border-err/30 bg-err/[0.06] p-4 text-body">
              <p className="font-medium text-err">Couldn't load the diff</p>
              <p className="selectable mt-1 break-words font-mono text-caption text-muted">{error}</p>
              <Button size="sm" variant="secondary" className="mt-3" onClick={() => void load()}>
                <RefreshCw /> Retry
              </Button>
            </div>
          ) : loading && !diff ? (
            <div className="space-y-3 py-4">
              <Skeleton className="h-9 rounded-xl" />
              <Skeleton className="h-48 rounded-xl" />
              <Skeleton className="h-9 rounded-xl" />
              <Skeleton className="h-9 rounded-xl" />
              {slow && (
                <p role="status" className="pt-2 text-center text-small text-muted">
                  Large diff, still loading…
                </p>
              )}
            </div>
          ) : !hasChanges ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <GitCommitHorizontal className="mb-3 h-8 w-8 text-steel" />
              <p className="text-[14px] font-medium">Nothing to review</p>
              <p className="mt-1 text-small text-muted">The working tree matches the base commit.</p>
            </div>
          ) : index ? (
            <>
              {ordered.compactCount > 0 && hideCompact && ordered.textCount === 0 && (
                <p className="pt-4 text-center text-small text-muted">
                  Only binary/LFS files changed. Use “Show {ordered.compactCount.toLocaleString()} binary/LFS files” to
                  list them.
                </p>
              )}
              <ReviewDiffColumn
                ref={columnRef}
                files={shownFiles}
                index={index}
                compact={compactOf}
                truncated={diff?.truncated}
                scrollEl={scrollRef}
                commenting={commenting}
                reviewActions={reviewActions}
                fileVersions={fileVersions}
                isViewed={isViewed}
                openState={openState}
              />
              <p className="px-1 pb-3 text-center text-meta text-steel">
                Click a line number (or focus a line and press Enter) to leave a comment for the agent.
              </p>
            </>
          ) : null}
          {orphaned.length > 0 && (
            <div className="mt-3 rounded-xl border border-line-strong bg-card/80 p-3">
              <p className="mb-2 text-caption font-medium text-muted">
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
              <span className="text-body font-medium">{pluralize(comments.length, "comment")}</span>
              <span className="hidden truncate text-caption text-steel sm:inline">
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
            "flex shrink-0 flex-wrap items-center gap-2 border-t px-4 py-2.5 text-small",
            afterMerge.kind === "merged" ? "border-ok/25 bg-ok/[0.07]" : "border-warn/30 bg-warn/[0.08]",
          )}
        >
          {afterMerge.kind === "merged" ? (
            <>
              <GitMerge className="h-4 w-4 shrink-0 text-ok" />
              <div className="min-w-0 flex-1 space-y-1">
                <PushBaseNotice agentId={agent.id} initial={afterMerge.baseStatus} />
                <span className="block text-muted">Clean up the worktree, or archive the agent if it's done.</span>
              </div>
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

      <footer className="flex shrink-0 items-center gap-2 border-t border-line bg-panel px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Input
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder={`Commit message (default: “${agent.title}”)`}
            aria-label="Commit message"
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && uncommitted > 0 && busy === null && !gitBlocked && !lfsBlocked) commit();
            }}
            className="h-8"
          />
          <Button
            variant={agent.worktree ? "secondary" : "primary"}
            disabled={uncommitted === 0 || busy !== null || !!gitBlocked || !!lfsBlocked}
            title={
              diffPending
                ? PENDING_REASON
                : (lfsBlocked ?? gitBlocked ?? (uncommitted === 0 ? "Nothing to commit" : undefined))
            }
            onClick={commit}
          >
            {busy === "commit" ? <Spinner className="h-3.5 w-3.5 text-current" /> : <GitCommitHorizontal />}
            Commit
          </Button>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2">
          {/* One main action that follows the state of the work; everything else lives in More. */}
          {agent.worktree && !nothingToShip && (
            <Button
              variant="primary"
              disabled={busy !== null || !!shipReason}
              title={shipReason ?? undefined}
              onClick={() => (uncommitted > 0 ? setConfirmShip(true) : setConfirmMerge(true))}
            >
              {busy === "ship" || busy === "merge" ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Rocket />}
              {uncommitted > 0 ? "Commit & merge" : "Merge"}
            </Button>
          )}
          <PrPopover
            agent={agent}
            open={prOpen}
            setOpen={setPrOpen}
            autoOpen={prIntent && !!diff}
            files={diff?.files ?? null}
            disabled={busy !== null || prReason !== null}
            onSubmit={async (t, b, base, draft) => {
              // Errors stay inline in the form (the popover keeps what you wrote).
              setBusy("pr");
              try {
                toastPr(await api.createPr(agent.id, t, b, base, draft));
                refreshPrSoon(agent.id);
                return null;
              } catch (e) {
                return errorMessage(e);
              } finally {
                setBusy(null);
              }
            }}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" aria-label="More actions">
                  {busy === "pr" ? <Spinner className="h-3.5 w-3.5" /> : <Ellipsis />}
                  <span className="max-[900px]:sr-only">More</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                side="top"
                className="w-[300px]"
                // The form opens once the menu has closed, and takes focus itself (not the More button).
                onCloseAutoFocus={(e) => {
                  if (!prAfterMenu.current) return;
                  prAfterMenu.current = false;
                  e.preventDefault();
                  setPrOpen(true);
                }}
              >
                <MoreItem
                  icon={<GitPullRequest />}
                  label="Open pull request…"
                  reason={busy !== null ? null : prReason}
                  disabled={busy !== null || prReason !== null}
                  onSelect={() => (prAfterMenu.current = true)}
                />
                <MoreItem
                  icon={<GithubGlyph className="h-3.5 w-3.5" />}
                  label="GitHub…"
                  reason={diffPending ? PENDING_REASON : null}
                  disabled={diffPending}
                  onSelect={() => setGithubOpen(true)}
                />
                {agent.worktree && uncommitted > 0 && (
                  <MoreItem
                    icon={<GitMerge />}
                    label="Merge only"
                    reason={mergeReason}
                    disabled={busy !== null || mergeReason !== null}
                    onSelect={() => setConfirmMerge(true)}
                  />
                )}
                <DropdownMenuSeparator />
                <MoreItem
                  icon={<Trash2 />}
                  label="Discard worktree…"
                  danger
                  reason={discardReason}
                  disabled={busy !== null || !!discardReason}
                  onSelect={() => setConfirmDiscard(true)}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </PrPopover>
        </div>
      </footer>

      <ConfirmDialog
        open={confirmShip}
        onOpenChange={setConfirmShip}
        title="Ship these changes?"
        description={
          <>
            Commit {pluralize(uncommitted, "uncommitted file")} as{" "}
            <span className="font-medium text-fg">“{message}”</span>, then merge{" "}
            <span className="font-mono text-caption text-fg">{agent.branch ?? "this branch"}</span> into{" "}
            <span className="font-mono text-caption text-fg">{agent.baseBranch ?? "the base branch"}</span>.
          </>
        }
        confirmLabel="Commit & merge"
        onConfirm={() => {
          setConfirmShip(false);
          ship();
        }}
      />
      <ConfirmDialog
        open={confirmMerge}
        onOpenChange={setConfirmMerge}
        title={`Merge into ${agent.baseBranch ?? "the base branch"}?`}
        description={
          <>
            Merges <span className="font-mono text-caption text-fg">{agent.branch ?? "this branch"}</span> into{" "}
            <span className="font-mono text-caption text-fg">{agent.baseBranch ?? "the base branch"}</span> in your
            project folder.
          </>
        }
        confirmLabel="Merge"
        onConfirm={() => {
          setConfirmMerge(false);
          merge();
        }}
      />
      <GithubDialog
        agent={agent}
        open={githubOpen}
        onOpenChange={setGithubOpen}
        disabled={gitBlocked}
        onPushed={() => refreshPrSoon(agent.id)}
      />
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
        <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-line bg-base/40 px-3 py-2 font-mono text-caption">
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
          // Stays open with a spinner while the worktree is deleted; an error shows as a toast.
          await run(
            "discard",
            () => api.discardWorktree(agent.id),
            () => {
              toast.success("Worktree discarded");
              onClose();
            },
          );
          setConfirmDiscard(false);
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
              {revertTarget.hunk !== null && " (this hunk only)"}. You can undo it right after.
            </>
          )
        }
        confirmLabel={revertTarget?.hunk === null ? "Revert file" : "Revert hunk"}
        onConfirm={doRevert}
      >
        {revertError && (
          <div role="alert" className="rounded-lg border border-err/30 bg-err/[0.07] px-3 py-2 text-small">
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

function MoreItem({
  icon,
  label,
  reason,
  danger,
  disabled,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  /** Why it can't be used right now, shown under the label. */
  reason?: string | null;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem danger={danger} disabled={disabled} onSelect={onSelect} className="h-auto min-h-8 py-1.5">
      {icon}
      <span className="flex min-w-0 flex-col">
        <span>{label}</span>
        {reason && <span className="whitespace-normal text-meta leading-snug text-steel">{reason}</span>}
      </span>
    </DropdownMenuItem>
  );
}

function PrPopover({
  agent,
  files,
  disabled,
  onSubmit,
  open,
  setOpen,
  children,
  autoOpen = false,
}: {
  autoOpen?: boolean;
  agent: Agent;
  /** The agent's changed files, for the size line in the description. */
  files: ChangedFile[] | null;
  disabled: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The button the form hangs from. */
  children: React.ReactNode;
  /** Resolves to an error message to show inline, or null on success. */
  onSubmit: (title: string, body: string, base: string | undefined, draft: boolean) => Promise<string | null>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [base, setBase] = useState(agent.baseBranch ?? "");
  const [branches, setBranches] = useState<string[] | null>(null);
  const onOpenChange = (next: boolean) => {
    if (!next && submitting) return;
    setOpen(next);
  };
  // Fresh defaults each time the form opens (the agent may have been renamed or said more since).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setFormError(null);
      const fill = prefillPr(agent, files);
      setTitle(fill.title);
      setBody(fill.body);
      setDraft(false);
      setBase(agent.baseBranch ?? "");
      // The picker fills in a moment later; until then it shows just the default base.
      setBranches(null);
      api
        .prBaseBranches(agent.id)
        .then(setBranches)
        .catch(() => setBranches(null));
    }
    wasOpen.current = open;
    // Seeds from the agent once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!autoOpen || autoOpened.current || disabled || !agent.branch) return;
    autoOpened.current = true;
    setOpen(true);
    // A one-shot open.
  }, [autoOpen, disabled, agent.branch]);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span className="inline-flex">{children}</span>
      </PopoverAnchor>
      <PopoverContent side="top" align="end" className="w-[380px]">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (submitting) return;
            setSubmitting(true);
            // Close only on success, so a failure (e.g. gh not signed in) keeps what you wrote.
            setFormError(null);
            const err = await onSubmit(
              title.trim() || agent.title,
              body,
              base && base !== agent.baseBranch ? base : undefined,
              draft,
            );
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
              className="min-h-28 font-mono text-caption"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Label htmlFor="pr-base" className="mb-0 shrink-0">
                Into
              </Label>
              <Select
                id="pr-base"
                aria-label="Base branch"
                className="h-8 max-w-[190px] font-mono text-caption"
                value={base || undefined}
                onValueChange={setBase}
                options={(branches?.length ? branches : base ? [base] : []).map((b) => ({ value: b, label: b }))}
              />
            </div>
            <label className="flex shrink-0 items-center gap-2 text-small text-muted">
              Draft
              <Switch checked={draft} onCheckedChange={setDraft} aria-label="Open as a draft" />
            </label>
          </div>
          {formError && (
            <p role="alert" className="rounded-lg border border-err/30 bg-err/[0.07] px-2.5 py-2 text-caption text-err">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" type="button" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={submitting}>
              {submitting ? <Spinner className="h-3.5 w-3.5 text-current" /> : <GitPullRequest />}{" "}
              {draft ? "Create draft" : "Create pull request"}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
