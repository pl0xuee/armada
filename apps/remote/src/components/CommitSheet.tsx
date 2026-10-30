import { useEffect, useState, type ReactNode } from "react";
import { askToResolveConflict, commitWork, secretFilesFor } from "@/lib/controller";
import { baseSyncLine, changeSummaryLine, isWarning, pushCommand, type GitResult } from "@/lib/gitResult";
import { plural } from "@/lib/format";
import { isBusy } from "@/lib/meta";
import { navigate } from "@/lib/router";
import { useStore } from "@/lib/store";
import type { Agent } from "@/lib/types";
import { CopyButton } from "./CopyButton";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";
import { Button } from "./ui";

/** Can the agent's work be committed now? (Not while it's working or waiting for approval.) */
export function commitBlocked(agent: Agent): string | null {
  if (isBusy(agent.status)) return "Wait for the agent to finish (or stop it) before committing.";
  return null;
}

/**
 * "Commit" / "Commit & merge" with an editable message: the confirmation step.
 * Afterwards the sheet stays open with what happened (merged and where the
 * base branch stands, files skipped or left behind, or a merge conflict with
 * "Ask the agent to resolve"). A clean plain commit is just a toast.
 */
export function CommitSheet({
  agent,
  mode,
  onClose,
  onDone,
  changes,
}: {
  agent: Agent;
  mode: "commit" | "ship" | null;
  onClose: () => void;
  onDone?: () => void;
  /** What's about to be committed, when the screen already has the diff summary (no extra request). */
  changes?: { files: number; additions: number; deletions: number } | null;
}) {
  const [message, setMessage] = useState(agent.title);
  const [result, setResult] = useState<GitResult | null>(null);
  /** Files that look like secrets, found before committing: ask what to do with them. */
  const [secrets, setSecrets] = useState<string[] | null>(null);
  const [checking, setChecking] = useState(false);
  const busy = useStore((s) => !!s.busy[`commit:${agent.id}`]);
  // Prefilled with the title each time the sheet opens; a rename while it's open
  // (e.g. the agent's auto-title) mustn't overwrite what you typed.
  const title = agent.title;
  useEffect(() => {
    if (mode) {
      setMessage(title);
      setResult(null);
      setSecrets(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on open
  }, [mode]);
  const blocked = commitBlocked(agent);
  const ship = mode === "ship";

  const commit = async (options: { exclude?: string[]; allowSecrets?: boolean } = {}) => {
    const r = await commitWork(agent.id, message.trim(), ship, options);
    if (!r) return;
    // The server refused secret-looking files the look-ahead didn't catch: ask now.
    if (r.kind === "secrets") {
      setSecrets(r.files);
      return;
    }
    setSecrets(null);
    onDone?.();
    if (r.kind === "committed" && !isWarning(r)) onClose();
    else setResult(r);
  };

  // Look for secret-looking files first (the desktop asks too); the server refuses them otherwise.
  // If the look-ahead itself fails, go ahead: the server checks again and a refusal brings the list up.
  const start = async () => {
    setChecking(true);
    const found = await secretFilesFor(agent.id);
    setChecking(false);
    if (found && found.length > 0) setSecrets(found);
    else await commit();
  };

  return (
    <Sheet
      open={!!mode}
      onClose={onClose}
      title={result ? resultTitle(result) : ship ? "Commit & merge" : "Commit changes"}
      description={
        result
          ? resultSubtitle(result, agent)
          : ship
            ? `Commits the remaining changes on ${agent.branch ?? "its branch"}, then merges into ${agent.baseBranch ?? "the base branch"}.`
            : "Commits the agent's changes in its checkout."
      }
    >
      {result ? (
        <ResultBody agent={agent} result={result} onClose={onClose} />
      ) : secrets ? (
        <div className="space-y-3">
          <Note tone="warn" icon="alert">
            These files look like secrets (keys, passwords or tokens). Committing them can leak them to anyone who
            can read the repository.
          </Note>
          <FileList title="Looks like secrets" hint="Leaving them out keeps them on disk; they just aren't committed." files={secrets} />
          <div className="grid gap-2">
            <Button variant="primary" size="lg" loading={busy} onClick={() => void commit({ exclude: secrets })}>
              Leave them out
            </Button>
            <Button variant="secondary" size="lg" disabled={busy} onClick={() => void commit({ allowSecrets: true })}>
              Include them anyway
            </Button>
            <Button variant="ghost" size="lg" disabled={busy} onClick={() => setSecrets(null)}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <>
          <label htmlFor="commit-message" className="mb-1.5 block text-[13px] font-medium text-muted">
            Commit message
          </label>
          <textarea
            id="commit-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            className="block w-full resize-y rounded-xl border border-line-strong bg-card px-3.5 py-3 text-[16px] leading-[22px] text-fg outline-none focus:border-accent/60"
          />
          {changes && changes.files > 0 && (
            <p className="mt-2 px-1 font-mono text-[12.5px] text-muted tabular">
              {changeSummaryLine(changes.files, changes.additions, changes.deletions)}
            </p>
          )}
          {blocked && <p className="mt-2 text-[13px] text-warn">{blocked}</p>}
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button variant="secondary" size="lg" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="lg"
              loading={busy || checking}
              disabled={!!blocked || !message.trim()}
              onClick={() => void start()}
            >
              {ship ? "Commit & merge" : "Commit"}
            </Button>
          </div>
        </>
      )}
    </Sheet>
  );
}

function resultTitle(r: GitResult): string {
  switch (r.kind) {
    case "merged":
      return "Committed and merged";
    case "conflict":
      return "Committed, but the merge hit a conflict";
    case "not_merged":
      return "Committed, but not merged";
    default:
      return "Committed, with files left out";
  }
}

function resultSubtitle(r: GitResult, agent: Agent): string | undefined {
  if (r.kind === "merged") return `${agent.branch ?? "The branch"} into ${agent.baseBranch ?? "the base branch"}`;
  if (r.kind === "committed") return undefined;
  // The server's message already says which commit is on which branch: say it once.
  if (!r.committed || r.error.includes(r.committed)) return undefined;
  return `Commit ${r.committed} is on ${agent.branch ?? "the branch"}`;
}

function Note({ tone, icon, children }: { tone: "ok" | "warn"; icon: "check" | "alert"; children: ReactNode }) {
  return (
    <div
      className={
        tone === "ok"
          ? "flex items-start gap-2.5 rounded-xl border border-ok/25 bg-ok/[0.07] px-3.5 py-3"
          : "flex items-start gap-2.5 rounded-xl border border-warn/30 bg-warn/[0.08] px-3.5 py-3"
      }
    >
      <Icon name={icon} size={18} className={tone === "ok" ? "mt-px shrink-0 text-ok" : "mt-px shrink-0 text-warn"} />
      <div className="min-w-0 flex-1 text-[14px] leading-snug break-words text-fg">{children}</div>
    </div>
  );
}

function ResultBody({ agent, result, onClose }: { agent: Agent; result: GitResult; onClose: () => void }) {
  const [sending, setSending] = useState(false);

  if (result.kind === "committed") {
    return (
      <div className="space-y-3">
        <Note tone="warn" icon="alert">
          <span className="selectable">{result.message}</span>
        </Note>
        {result.files.length > 0 && <FileList title="Committed" files={result.files} />}
        {result.leftUncommitted > 0 && (
          <p className="px-1 text-[13px] leading-snug text-muted">
            The {plural(result.leftUncommitted, "other changed file")} stayed uncommitted: changes this agent didn't make, files you
            left out, or files in a nested repository. Review {result.leftUncommitted === 1 ? "it" : "them"} in Armada on your computer.
          </p>
        )}
        {result.skipped.length > 0 && (
          <FileList
            title="Skipped"
            hint="Inside a submodule or nested repository. Commit these in that repository."
            files={result.skipped}
          />
        )}
        <Button variant="primary" size="lg" className="w-full" onClick={onClose}>
          Done
        </Button>
      </div>
    );
  }

  if (result.kind === "merged") {
    const status = result.baseStatus;
    const line = status ? baseSyncLine(status) : "Merged locally. Nothing has been pushed to the remote.";
    return (
      <div className="space-y-3">
        <Note tone="ok" icon="check">
          {result.summary ?? "Merged."}
          {result.committed && <span className="mt-0.5 block text-[13px] text-muted">Committed {result.committed} first.</span>}
        </Note>
        <p className="px-1 text-[13.5px] text-muted">{line}</p>
        {status && (status.ahead > 0 || !status.upstream) && (
          <div className="rounded-xl border border-line bg-card px-3.5 py-2.5">
            <p className="text-[12.5px] text-steel">To publish it, run this on your computer:</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{pushCommand(status)}</code>
              <CopyButton text={pushCommand(status)} label="Copy command" />
            </div>
          </div>
        )}
        <Button variant="primary" size="lg" className="w-full" onClick={onClose}>
          Done
        </Button>
      </div>
    );
  }

  // Committed, but the merge didn't happen.
  const conflict = result.kind === "conflict";
  const openAgent = () => {
    onClose();
    navigate({ name: "agent", agentId: agent.id });
  };
  return (
    <div className="space-y-3">
      <Note tone="warn" icon="alert">
        <span className="selectable">{result.error}</span>
      </Note>
      {conflict && (
        <p className="px-1 text-[13.5px] text-muted">
          The agent can merge {agent.baseBranch ?? "the base branch"} into its branch, resolve the conflicts and commit. Then merge again.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" size="lg" onClick={onClose}>
          Not now
        </Button>
        {conflict ? (
          <Button
            variant="primary"
            size="lg"
            loading={sending}
            onClick={async () => {
              setSending(true);
              await askToResolveConflict(agent, result.error);
              setSending(false);
              openAgent();
            }}
          >
            Ask agent to resolve
          </Button>
        ) : (
          <Button variant="primary" size="lg" onClick={openAgent}>
            Open agent
          </Button>
        )}
      </div>
    </div>
  );
}

function FileList({ title, hint, files }: { title: string; hint?: string; files: string[] }) {
  return (
    <div>
      <p className="mb-1.5 px-1 text-[12px] font-semibold tracking-[0.08em] text-steel uppercase">
        {title} <span className="tabular">{files.length}</span>
      </p>
      <ul className="max-h-40 overflow-y-auto overscroll-contain rounded-xl border border-line bg-card py-1">
        {files.map((f) => (
          <li key={f} className="truncate px-3.5 py-1.5 font-mono text-[13px] text-fg" title={f}>
            {f}
          </li>
        ))}
      </ul>
      {hint && <p className="mt-1.5 px-1 text-[12.5px] text-steel">{hint}</p>}
    </div>
  );
}
