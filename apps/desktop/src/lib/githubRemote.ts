// Whether a project's git remotes point at GitHub, so GitHub-only actions are offered only where they can work.
import type { GitRemote } from "./types";

/**
 * A remote URL on github.com: https://github.com/o/r(.git), git@github.com:o/r.git,
 * ssh://git@github.com/o/r, git://github.com/o/r. (GitHub Enterprise hosts are not guessed at.)
 */
export function isGithubUrl(url: string): boolean {
  const u = url.trim();
  return /^(?:(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?|[^@/\s]+@)(?:www\.)?github\.com(?::\d+)?[/:][^/\s]+\/[^/\s]+/i.test(u);
}

export function hasGithubRemote(remotes: Pick<GitRemote, "url">[]): boolean {
  return remotes.some((r) => isGithubUrl(r.url));
}
