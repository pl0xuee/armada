import { CircleDot, ExternalLink, RefreshCw, Rocket, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toastFailure } from "@/lib/actions";
import { api } from "@/lib/api";
import { openExternal } from "@/lib/external";
import { filterIssues, issueLabels, needsServerSearch } from "@/lib/prFlow";
import type { IssueLabel, IssueList, IssueSummary } from "@/lib/types";
import { basename, cn, errorMessage } from "@/lib/utils";
import { useUi } from "@/store/ui";
import { RelTime } from "../RelTime";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent } from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/misc";
import { GhError } from "./GhError";

/** Most label chips offered as filters; the rest are still searchable by name. */
const MAX_FILTER_CHIPS = 8;

/**
 * Open issues of a project's GitHub repository. "Start agent" opens the new-agent form with the
 * issue as the prompt, in its own worktree on a branch named after the issue, so the whole loop
 * (issue, agent, pull request, merge) starts from here.
 */
export function IssuesDialog() {
  const { open, projectPath } = useUi((s) => s.issues);
  const close = useUi((s) => s.closeIssues);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent
        title={
          <span className="flex items-center gap-2">
            <CircleDot className="h-4 w-4 text-steel" /> Issues
            {projectPath && <span className="font-normal text-muted">· {basename(projectPath)}</span>}
          </span>
        }
        description="Pick an issue to start an agent on it."
        className="w-[min(600px,calc(100vw-16px))]"
        sheet
      >
        {open && projectPath && <IssuesBody projectPath={projectPath} onClose={close} />}
      </DialogContent>
    </Dialog>
  );
}

function IssuesBody({ projectPath, onClose }: { projectPath: string; onClose: () => void }) {
  const openNewAgent = useUi((s) => s.openNewAgent);
  const [list, setList] = useState<IssueList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [label, setLabel] = useState<string | null>(null);
  const [searched, setSearched] = useState<{ query: string; list: IssueList } | null>(null);
  const [searching, setSearching] = useState(false);
  const [starting, setStarting] = useState<number | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const mine = ++request.current;
    setError(null);
    setList(null);
    setSearched(null);
    try {
      const l = await api.githubIssues(projectPath);
      if (request.current === mine) setList(l);
    } catch (e) {
      if (request.current === mine) setError(errorMessage(e));
    }
  }, [projectPath]);
  useEffect(() => {
    void load();
  }, [load]);

  // A list cut short can't be searched locally, so ask GitHub once typing settles.
  const q = query.trim();
  const askGithub = needsServerSearch(list, q);
  useEffect(() => {
    if (!askGithub) {
      setSearched(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const mine = ++request.current;
    const t = setTimeout(() => {
      api
        .githubIssues(projectPath, q)
        .then((l) => request.current === mine && setSearched({ query: q, list: l }))
        .catch(() => request.current === mine && setSearched(null))
        .finally(() => request.current === mine && setSearching(false));
    }, 350);
    return () => clearTimeout(t);
  }, [askGithub, q, projectPath]);

  const labels = useMemo(() => issueLabels(list?.issues ?? []).slice(0, MAX_FILTER_CHIPS), [list]);
  const shown = useMemo(() => {
    if (!list) return [];
    // GitHub already matched the text; the label chip still narrows what it sent.
    if (askGithub && searched?.query === q) return filterIssues(searched.list.issues, "", label);
    return filterIssues(list.issues, query, label);
  }, [list, searched, askGithub, q, query, label]);

  const start = async (issue: IssueSummary) => {
    setStarting(issue.number);
    try {
      const s = await api.githubIssueStart(projectPath, issue.number);
      onClose();
      openNewAgent({ projectPath, prompt: s.prompt, title: s.title, worktree: true });
    } catch (e) {
      toastFailure(`Couldn't read issue #${issue.number}`, errorMessage(e));
    } finally {
      setStarting(null);
    }
  };

  return (
    <DialogBody className="space-y-3 pt-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-steel" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title, number, author or label"
            aria-label="Search issues"
            className="pl-9"
            autoFocus
          />
          {searching && <Spinner className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-steel" />}
        </div>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Refresh issues"
          title="Refresh"
          disabled={!list && !error}
          onClick={() => void load()}
        >
          <RefreshCw className={cn("!h-3.5 !w-3.5", !list && !error && "animate-spin")} />
        </Button>
      </div>

      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by label">
          {labels.map((l) => (
            <LabelChip key={l.name} label={l} active={label === l.name} onClick={() => setLabel(label === l.name ? null : l.name)} />
          ))}
        </div>
      )}

      {error ? (
        <GhError text={error} context={`Reading the open issues of ${basename(projectPath)}`} />
      ) : !list ? (
        <div className="flex items-center gap-2 py-8 text-[13px] text-muted">
          <Spinner className="h-4 w-4" /> Loading issues…
        </div>
      ) : shown.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-muted">
          {list.issues.length === 0 ? "No open issues." : searching ? "Searching GitHub…" : "No issues match."}
        </p>
      ) : (
        <ul className="-mx-2 max-h-[min(46vh,380px)] overflow-y-auto">
          {shown.map((issue) => (
            <IssueRow
              key={issue.number}
              issue={issue}
              busy={starting === issue.number}
              disabled={starting !== null}
              onStart={() => void start(issue)}
            />
          ))}
        </ul>
      )}

      {list?.truncated && (
        <p className="text-[11.5px] text-steel">Showing the 100 most recently updated. Search asks GitHub for the rest.</p>
      )}
    </DialogBody>
  );
}

function LabelChip({ label, active, onClick }: { label: IssueLabel; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 max-w-[160px] items-center gap-1.5 rounded-full border px-2 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent/25",
        active ? "border-accent/50 bg-accent/[0.09] text-fg" : "border-line bg-card/60 text-muted hover:border-line-strong hover:text-fg",
      )}
    >
      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: `#${label.color || "8b949e"}` }} />
      <span className="truncate">{label.name}</span>
    </button>
  );
}

function IssueRow({
  issue,
  busy,
  disabled,
  onStart,
}: {
  issue: IssueSummary;
  busy: boolean;
  disabled: boolean;
  onStart: () => void;
}) {
  const ts = Date.parse(issue.updatedAt);
  return (
    <li className="group flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-raised/60">
      <span className="mt-[3px] w-10 shrink-0 text-right font-mono text-[11.5px] text-steel tabular">#{issue.number}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-fg" title={issue.title}>
          {issue.title}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11.5px] text-steel">
          {issue.labels.slice(0, 3).map((l) => (
            <span key={l.name} className="inline-flex min-w-0 items-center gap-1">
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: `#${l.color || "8b949e"}` }} />
              <span className="truncate">{l.name}</span>
            </span>
          ))}
          {issue.author && <span className="shrink-0">@{issue.author}</span>}
          {Number.isFinite(ts) && <RelTime ts={ts} className="shrink-0" />}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Open #${issue.number} on GitHub`}
          title="Open on GitHub"
          onClick={() => void openExternal(issue.url)}
        >
          <ExternalLink className="!h-3 !w-3" />
        </Button>
        <Button size="sm" variant="secondary" disabled={disabled} onClick={onStart} aria-label={`Start an agent on #${issue.number}`}>
          {busy ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Rocket />}
          Start
        </Button>
      </div>
    </li>
  );
}
