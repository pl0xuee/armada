// Errors from the GitHub CLI arrive as one string: a readable sentence and, when there is more
// to say, gh's own words after a marker (see gh_errors.rs). The sentence is shown; the rest is
// kept for "Copy details".

/** Separates the sentence from the raw text. Must match `DETAILS_MARK` in gh_errors.rs. */
export const DETAILS_MARK = "\n\n--- details ---\n";

/** What a merge says when the pull request's head moved after it was reviewed. Must match `BRANCH_CHANGED` in gh_errors.rs. */
export const BRANCH_CHANGED_MESSAGE = "The branch changed since you looked. Review the new commits.";

export interface GhError {
  /** The readable sentence. */
  message: string;
  /** gh's own text, when it said more than the sentence. */
  details: string | null;
}

export function splitDetails(text: string): GhError {
  const i = text.indexOf(DETAILS_MARK);
  if (i < 0) return { message: text.trim(), details: null };
  return { message: text.slice(0, i).trim(), details: text.slice(i + DETAILS_MARK.length).trim() || null };
}

export function isBranchChanged(text: string): boolean {
  return splitDetails(text).message === BRANCH_CHANGED_MESSAGE;
}

/** What "Copy details" puts on the clipboard: what was being done, what Kvistcode said, what gh said. */
export function detailsText(text: string, context?: string): string {
  const { message, details } = splitDetails(text);
  return [context, message, details].filter(Boolean).join("\n\n");
}
