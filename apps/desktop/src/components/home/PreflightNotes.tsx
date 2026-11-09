import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { preflight, type PreflightIssue } from "@/lib/launchDefaults";
import type { Account, Provider } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { Button } from "../ui/button";

/**
 * Asks the core whether `folder` is a git repo with commits, debounced while typing.
 * Stale answers are dropped; null while checking, when the folder is empty, or on error.
 */
export function useIsGitRepo(folder: string, enabled: boolean): boolean | null {
  const [result, setResult] = useState<{ folder: string; ok: boolean } | null>(null);
  const path = folder.trim();
  useEffect(() => {
    if (!enabled || !path) return;
    let alive = true;
    const t = setTimeout(() => {
      api
        .isGitRepo(path)
        .then((ok) => alive && setResult({ folder: path, ok }))
        .catch(() => alive && setResult(null));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [path, enabled]);
  return enabled && result && result.folder === path ? result.ok : null;
}

/** Non-blocking launch warnings (signed-out account, missing CLI/adapter, non-git folder with worktree). */
export function usePreflight(p: {
  provider: Provider;
  account: Account | undefined;
  folder: string;
  worktree: boolean;
}): PreflightIssue[] {
  const providerInfo = useApp((s) =>
    // Local models run through the Codex CLI.
    s.providers.find((x) => x.provider === (p.provider === "local" ? "codex" : p.provider)),
  );
  const isGitRepo = useIsGitRepo(p.folder, p.worktree);
  return preflight({ ...p, providerInfo, isGitRepo });
}

/** Where each warning is fixed. The New agent dialog is closed first so the page shows. */
const FIXES: Partial<Record<PreflightIssue["id"], { label: string; go: () => void }>> = {
  signed_out: { label: "Accounts", go: () => useUi.getState().setView("accounts") },
  not_installed: { label: "Providers", go: () => useUi.getState().openSettings("providers") },
  no_adapter: { label: "Providers", go: () => useUi.getState().openSettings("providers") },
};

export function PreflightNotes({ issues, className }: { issues: PreflightIssue[]; className?: string }) {
  if (issues.length === 0) return null;
  return (
    <ul className={cn("space-y-1", className)} aria-label="Before you start">
      {issues.map((i) => {
        const fix = FIXES[i.id];
        return (
          <li key={i.id} className="flex items-start gap-1.5 text-caption leading-snug text-warn">
            <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">{i.text}</span>
            {fix && (
              <Button
                size="xs"
                variant="secondary"
                className="shrink-0"
                onClick={() => {
                  useUi.getState().closeNewAgent();
                  fix.go();
                }}
              >
                {fix.label}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
