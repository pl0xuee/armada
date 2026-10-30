/**
 * What happened after "Commit" / "Commit & merge", in the desktop's terms
 * (apps/desktop/src/lib/gitResults.ts): committed (maybe with skipped or
 * left-over files), merged (and where the base branch stands), or committed
 * but not merged (a conflict gets its own "Ask the agent to resolve").
 */
import { ApiError, type BaseBranchStatus } from "./api";
import { plural } from "./format";
import type { Agent } from "./types";

export type GitResult =
  | {
      kind: "committed";
      /** "Committed 3 files (abc1234); 5 other changed files were left uncommitted" */
      message: string;
      /** Repository-relative paths that went into the commit. */
      files: string[];
      skipped: string[];
      leftUncommitted: number;
    }
  | {
      kind: "merged";
      committed: string | null;
      /** The merge's own summary ("Merged x into main: 2 files changed" / "Nothing to merge: …"). */
      summary: string | null;
      baseStatus: BaseBranchStatus | null;
    }
  | { kind: "conflict" | "not_merged"; committed: string | null; error: string };

/**
 * What `commitWork` hands the sheet: a result, or the server's refusal to commit
 * secret-looking files (with the files, so the sheet can ask what to do with them).
 */
export type CommitOutcome = GitResult | { kind: "secrets"; files: string[] };

/** The server refused the commit because it would add secret-looking files (422, names them). */
export function isSecretsRefusal(e: unknown): boolean {
  return e instanceof ApiError && e.status === 422 && /look like secrets/i.test(e.serverMessage ?? "");
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);

export function isConflict(message: string): boolean {
  return /conflict/i.test(message);
}

/** POST /commit's body (`{ result }`, or a bare string from older servers). */
export function commitResult(body: unknown): GitResult {
  const raw = body && typeof body === "object" && "result" in body ? (body as { result: unknown }).result : body;
  if (typeof raw === "string") return { kind: "committed", message: raw, files: [], skipped: [], leftUncommitted: 0 };
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const hash = str(r.hash);
  return {
    kind: "committed",
    message: str(r.message) ?? (hash ? `Committed ${hash}` : "Committed"),
    files: strings(r.files),
    skipped: strings(r.skipped),
    leftUncommitted: typeof r.leftUncommitted === "number" && r.leftUncommitted > 0 ? r.leftUncommitted : 0,
  };
}

function baseStatusOf(v: unknown): BaseBranchStatus | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  if (typeof b.branch !== "string") return null;
  return {
    branch: b.branch,
    upstream: str(b.upstream),
    ahead: typeof b.ahead === "number" ? b.ahead : 0,
    behind: typeof b.behind === "number" ? b.behind : 0,
  };
}

/** POST /ship's body. */
export function shipResult(body: unknown): GitResult {
  const r = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const committed = str(r.committed);
  const error = str(r.error);
  if (error) return { kind: isConflict(error) ? "conflict" : "not_merged", committed, error };
  return { kind: "merged", committed, summary: str(r.merged), baseStatus: baseStatusOf(r.baseStatus) };
}

/** A plain commit with nothing to flag is just a toast; everything else gets the result sheet. */
export function needsResultSheet(r: GitResult): boolean {
  if (r.kind === "committed") return r.skipped.length > 0 || r.leftUncommitted > 0;
  return true;
}

/** The result needs the owner's attention (not a clean success). */
export function isWarning(r: GitResult): boolean {
  return r.kind === "conflict" || r.kind === "not_merged" || (r.kind === "committed" && (r.skipped.length > 0 || r.leftUncommitted > 0));
}

/** Prompt asking the agent to resolve a failed merge (the desktop's wording). */
export function conflictPrompt(agent: Pick<Agent, "branch" | "baseBranch">, error: string): string {
  const base = agent.baseBranch ?? "the base branch";
  return `Merging ${agent.branch ?? "your branch"} into ${base} failed:\n\n${error}\n\nPlease merge ${base} into your branch, resolve the conflicts, make sure everything still builds and tests pass, and commit the result.`;
}

/** One-line state of the base branch after a merge. "Commit & merge" never pushes. */
export function baseSyncLine(s: BaseBranchStatus): string {
  if (!s.upstream) return `Merged into ${s.branch} locally · ${s.branch} has no upstream on GitHub`;
  if (s.ahead > 0) {
    const behind = s.behind > 0 ? ` (${s.upstream} also has ${plural(s.behind, "new commit")})` : "";
    return `Merged into ${s.branch} locally · ${plural(s.ahead, "commit")} not on ${s.upstream} yet${behind}`;
  }
  return `Merged into ${s.branch} · ${s.upstream} is up to date`;
}

/**
 * The command that publishes the base branch, to run on the computer (the phone can't push).
 * When the upstream has commits we don't, a plain push is rejected: rebase first.
 */
export function pushCommand(s: BaseBranchStatus): string {
  if (!s.upstream) return `git push -u origin ${s.branch}`;
  return s.behind > 0 ? "git pull --rebase && git push" : "git push";
}

/** "3 files · +12 −4" for the commit confirmation, from the diff summary the phone already has. */
export function changeSummaryLine(files: number, additions: number, deletions: number): string {
  return `${plural(files, "file")} · +${additions} −${deletions}`;
}
