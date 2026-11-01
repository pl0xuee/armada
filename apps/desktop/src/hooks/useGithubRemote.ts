import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { hasGithubRemote } from "@/lib/githubRemote";

/** Remotes rarely change, so a project is asked about at most this often. */
const TTL_MS = 60_000;
const known = new Map<string, { at: number; github: boolean }>();

/**
 * Whether the project folder has a GitHub remote. `null` until known (and for no project), so
 * GitHub-only actions stay hidden rather than appear and vanish.
 */
export function useGithubRemote(projectPath: string | null | undefined): boolean | null {
  const [answer, setAnswer] = useState<{ path: string; github: boolean } | null>(null);
  useEffect(() => {
    if (!projectPath) return;
    const hit = known.get(projectPath);
    if (hit && Date.now() - hit.at < TTL_MS) {
      setAnswer({ path: projectPath, github: hit.github });
      return;
    }
    let cancelled = false;
    api
      .githubRepoInfo(projectPath)
      .then((info) => {
        const github = info.isRepo && hasGithubRemote(info.remotes);
        known.set(projectPath, { at: Date.now(), github });
        if (!cancelled) setAnswer({ path: projectPath, github });
      })
      // Couldn't ask (folder gone, git missing): treat as no GitHub, quietly.
      .catch(() => !cancelled && setAnswer({ path: projectPath, github: false }));
    return () => {
      cancelled = true;
    };
  }, [projectPath]);
  return projectPath && answer?.path === projectPath ? answer.github : null;
}
