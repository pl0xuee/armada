import * as D from "@radix-ui/react-dialog";
import {
  FileCode2,
  FileMinus2,
  FilePlus2,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { parseUnified } from "@/lib/diff";
import { openExternal } from "@/lib/external";
import { pluralize } from "@/lib/format";
import type { Agent, AgentDiff, ChangedFile } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { DiffBar, FileDiffView } from "./DiffView";
import { ProviderGlyph } from "./ProviderGlyph";
import { ConfirmDialog } from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Input, Label, Textarea } from "./ui/input";
import { Spinner } from "./ui/misc";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
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
          className="anim-sheet fixed inset-y-2 right-2 z-50 flex w-[min(1180px,calc(100vw-72px))] flex-col overflow-hidden rounded-2xl border border-line-strong bg-panel shadow-[0_24px_80px_-12px_rgba(0,0,0,0.7)] edge-strong focus:outline-none"
        >
          {agent && <ReviewBody agent={agent} onClose={() => setReviewAgent(null)} />}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

const FILE_ICON = { added: FilePlus2, deleted: FileMinus2, modified: FileCode2, renamed: FileCode2 } as const;
type BusyKind = "commit" | "merge" | "pr" | "discard";
const BUSY_LABEL: Record<BusyKind, string> = {
  commit: "Commit failed",
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
  const scrollRef = useRef<HTMLDivElement>(null);

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

  const run = async <T,>(kind: BusyKind, fn: () => Promise<T>, ok: (r: T) => void) => {
    setBusy(kind);
    try {
      ok(await fn());
      if (kind !== "discard") void load();
    } catch (e) {
      toast.error(BUSY_LABEL[kind], { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const commit = () =>
    void run(
      "commit",
      () => api.commitAgent(agent.id, commitMsg.trim() || agent.title),
      (sha) => {
        toast.success("Committed", { description: `${sha.slice(0, 7)} on ${agent.branch ?? "HEAD"}` });
        setCommitMsg("");
      },
    );

  const hasChanges = (diff?.files.length ?? 0) > 0;

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
                <span>{pluralize(diff.files.length, "file")}</span>
                <span className="font-mono text-[11px] text-ok">+{totals.add}</span>
                <span className="font-mono text-[11px] text-err">−{totals.del}</span>
                {diff.ahead > 0 && (
                  <>
                    <span className="text-line-strong">·</span>
                    <span>{pluralize(diff.ahead, "commit")} ahead</span>
                  </>
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

      <div className="flex min-h-0 flex-1">
        <nav aria-label="Changed files" className="flex w-[250px] shrink-0 flex-col border-r border-line bg-panel">
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
                <FileRow key={f.path} file={f} active={selected === f.path} onClick={() => jump(f.path)} />
              ))
            )}
          </div>
        </nav>

        <div ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto bg-base p-4">
          {error ? (
            <div className="rounded-xl border border-err/30 bg-err/[0.06] p-4 text-[13px] text-err">
              Couldn't load the diff: <span className="selectable font-mono text-[12px]">{error}</span>
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
              {(diff?.files ?? []).map((f) => {
                const p = byPath.get(f.path);
                return (
                  <div key={f.path} data-path={f.path} className="scroll-mt-2">
                    {p ? (
                      <FileDiffView file={p} />
                    ) : (
                      <div className="rounded-xl border border-line bg-card px-4 py-3 font-mono text-[12px] text-muted">
                        {f.path} · no textual diff
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-panel px-4 py-3">
        <div className="flex min-w-[260px] flex-1 items-center gap-2">
          <Input
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder={`Commit message (default: “${agent.title}”)`}
            aria-label="Commit message"
            onKeyDown={(e) => {
              if (e.key === "Enter" && hasChanges && busy === null) commit();
            }}
            className="h-8"
          />
          <Button variant="primary" disabled={!hasChanges || busy !== null} onClick={commit}>
            {busy === "commit" ? <Spinner className="h-3.5 w-3.5 text-current" /> : <GitCommitHorizontal />}
            Commit
          </Button>
        </div>
        <Button
          variant="secondary"
          disabled={busy !== null || !agent.worktree}
          onClick={() =>
            void run(
              "merge",
              () => api.mergeAgent(agent.id),
              (msg) => toast.success("Merged", { description: msg }),
            )
          }
        >
          {busy === "merge" ? <Spinner className="h-3.5 w-3.5" /> : <GitMerge />}
          Merge into {agent.baseBranch ?? "base"}
        </Button>
        <PrPopover
          agent={agent}
          busy={busy === "pr"}
          disabled={busy !== null}
          onSubmit={(t, b) =>
            run(
              "pr",
              () => api.createPr(agent.id, t, b),
              (url) =>
                toast.success("Pull request opened", {
                  description: url,
                  action: { label: "Open", onClick: () => void openExternal(url) },
                }),
            )
          }
        />
        <Button variant="danger" disabled={busy !== null || !agent.worktree} onClick={() => setConfirmDiscard(true)}>
          <Trash2 />
          Discard
        </Button>
      </footer>

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
    </>
  );
}

function FileRow({ file, active, onClick }: { file: ChangedFile; active: boolean; onClick: () => void }) {
  const Icon = FILE_ICON[file.status];
  const name = file.path.split("/").pop() ?? file.path;
  const dir = file.path.slice(0, file.path.length - name.length);
  return (
    <button
      type="button"
      onClick={onClick}
      title={file.path}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
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
        <span className="block truncate font-mono text-[12px] text-fg">{name}</span>
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

function PrPopover({
  agent,
  busy,
  disabled,
  onSubmit,
}: {
  agent: Agent;
  busy: boolean;
  disabled: boolean;
  onSubmit: (title: string, body: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(agent.title);
  const [body, setBody] = useState(
    agent.lastMessage ? `## Summary\n\n${agent.lastMessage}\n\n_Opened from Armada._` : "",
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" disabled={disabled || !agent.branch}>
          {busy ? <Spinner className="h-3.5 w-3.5" /> : <GitPullRequest />}
          Open PR
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[380px]">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setOpen(false);
            await onSubmit(title.trim() || agent.title, body);
          }}
          className="space-y-3"
        >
          <div>
            <Label htmlFor="pr-title">Title</Label>
            <Input id="pr-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
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
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit">
              <GitPullRequest /> Create pull request
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
