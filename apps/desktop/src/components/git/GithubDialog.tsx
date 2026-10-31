import { Check, ExternalLink, Rocket, TriangleAlert, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { startGithubLogin } from "@/lib/actions";
import { api } from "@/lib/api";
import { openExternal } from "@/lib/external";
import type { Agent, GithubStatus, PublishResult, RepoInfo } from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { useUi } from "@/store/ui";
import { GithubGlyph } from "../settings/GithubGlyph";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "../ui/dialog";
import { Input, Label } from "../ui/input";
import { Spinner } from "../ui/misc";
import { Switch } from "../ui/switch";

/**
 * GitHub for one agent's work: sign in (and let git use the sign-in, which is what makes
 * pushing work from a GUI), push the current branch, or publish a folder as a new repository.
 */
export function GithubDialog({
  agent,
  open,
  onOpenChange,
  disabled,
  onPushed,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Why changing anything is unavailable right now (agent mid-turn). */
  disabled?: string | null;
  onPushed?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={
          <span className="flex items-center gap-2">
            <GithubGlyph className="h-4 w-4 text-steel" /> GitHub
          </span>
        }
        description="Sign in once, then push your work or put a new project on GitHub."
        className="w-[min(520px,calc(100vw-16px))]"
      >
        {open && (
          <GithubBody
            agent={agent}
            disabled={disabled ?? null}
            onPushed={onPushed}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function GithubBody({
  agent,
  disabled,
  onPushed,
  onClose,
}: {
  agent: Agent;
  disabled: string | null;
  onPushed?: () => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "git" | "push" | "publish">(null);
  const [error, setError] = useState<string | null>(null);

  // A worktree's folder is named after the agent; the remotes and the repository name belong to the project.
  const repoPath = agent.worktree ? agent.projectPath : agent.cwd;
  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api.githubStatus(), api.githubRepoInfo(repoPath)]);
      setStatus(s);
      setRepo(r);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [repoPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Signing in happens in the terminal window; look again when it closes or the app regains focus.
  const terminal = useUi((s) => s.terminal);
  const hadTerminal = useRef(false);
  useEffect(() => {
    if (terminal) hadTerminal.current = true;
    else if (hadTerminal.current) {
      hadTerminal.current = false;
      void refresh();
    }
  }, [terminal, refresh]);
  // Looking again when the window regains focus (you may have signed in in the browser) runs several
  // gh/git processes, so not while something is running and not more than every few seconds.
  const busyRef = useRef<typeof busy>(null);
  busyRef.current = busy;
  const lastFocusRefresh = useRef(0);
  useEffect(() => {
    const onFocus = () => {
      if (busyRef.current !== null || Date.now() - lastFocusRefresh.current < 5000) return;
      lastFocusRefresh.current = Date.now();
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const run = async <T,>(what: "git" | "push" | "publish", job: () => Promise<T>, done: (r: T) => void) => {
    setBusy(what);
    setError(null);
    try {
      done(await job());
    } catch (e) {
      setError(errorMessage(e));
      // A failed publish may already have created the repository and its remote.
      void refresh();
    } finally {
      setBusy(null);
    }
  };

  if (loadError)
    return (
      <>
        <DialogBody>
          <Problem>{loadError}</Problem>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="secondary" onClick={() => void refresh()}>
            Try again
          </Button>
        </DialogFooter>
      </>
    );
  if (!status || !repo)
    return (
      <DialogBody className="flex items-center gap-2 py-8 text-[13px] text-muted">
        <Spinner className="h-4 w-4" /> Checking GitHub…
      </DialogBody>
    );

  const origin = repo.remotes.find((r) => r.name === "origin") ?? repo.remotes[0];
  // What gets pushed is the agent's own branch (a worktree's), else whatever is checked out.
  const branch = (agent.worktree ? agent.branch : null) ?? repo.branch ?? "the current branch";

  return (
    <>
      <DialogBody className="space-y-4">
        {/* 1. Sign-in */}
        <Step n={1} done={status.loggedIn && status.gitReady} title="Sign in">
          {!status.ghInstalled ? (
            <>
              <p className="text-[12.5px] text-muted">
                Armada uses the GitHub CLI (<code className="font-mono">gh</code>) to talk to GitHub, and it isn't
                installed.
              </p>
              <Button size="sm" variant="secondary" onClick={() => void openExternal("https://cli.github.com")}>
                <ExternalLink /> Get the GitHub CLI
              </Button>
            </>
          ) : !status.loggedIn ? (
            <>
              <p className="text-[12.5px] text-muted">
                Opens your browser to sign in to GitHub. Armada never sees your password.
              </p>
              <Button size="sm" variant="primary" onClick={() => void startGithubLogin()}>
                <GithubGlyph className="h-3.5 w-3.5" /> Sign in to GitHub
              </Button>
            </>
          ) : !status.gitReady ? (
            <>
              <p className="text-[12.5px] text-muted">
                Signed in{status.user ? ` as ${status.user}` : ""}, but git doesn't use that sign-in yet, so pushes fail
                from here. This runs <code className="font-mono">gh auth setup-git</code>, which adds GitHub's
                credential helper to your git config.
              </p>
              <Button
                size="sm"
                variant="primary"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    "git",
                    () => api.githubSetupGit(),
                    (s) => {
                      setStatus(s);
                      toast.success("Git can now push to GitHub");
                    },
                  )
                }
              >
                {busy === "git" && <Spinner className="h-3.5 w-3.5 text-current" />} Let git use this sign-in
              </Button>
            </>
          ) : (
            <p className="text-[12.5px] text-muted">
              Signed in
              {status.user ? (
                <>
                  {" "}
                  as <span className="font-medium text-fg">{status.user}</span>
                </>
              ) : (
                ""
              )}
              . Git is connected.
            </p>
          )}
        </Step>

        {/* 2. Push or publish */}
        {origin ? (
          <Step n={2} done={false} title={`Push ${branch}`}>
            <p className="text-[12.5px] text-muted">
              To <span className="selectable break-all font-mono text-[11.5px] text-fg">{origin.url}</span>. Commit
              first: only commits are pushed, and Armada never force-pushes.
            </p>
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== null || !status.loggedIn || !!disabled}
              title={disabled ?? (!status.loggedIn ? "Sign in first" : undefined)}
              onClick={() =>
                void run(
                  "push",
                  () => api.pushAgentBranch(agent.id),
                  (msg) => {
                    toast.success(msg);
                    onPushed?.();
                  },
                )
              }
            >
              {busy === "push" ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Upload />} Push {branch}
            </Button>
          </Step>
        ) : (
          <Step n={2} done={false} title="Put this project on GitHub">
            <PublishForm
              key={repo.suggestedName}
              agent={agent}
              repo={repo}
              busy={busy === "publish"}
              disabled={busy !== null || !status.loggedIn || !status.gitReady || !!disabled}
              why={disabled ?? (!status.loggedIn || !status.gitReady ? "Finish step 1 first" : undefined)}
              onSubmit={(name, isPrivate, description) =>
                void run(
                  "publish",
                  () => api.githubPublish(agent.id, name, isPrivate, description),
                  (r) => {
                    announcePublished(r);
                    void refresh();
                    onPushed?.();
                  },
                )
              }
            />
          </Step>
        )}

        {error && <Problem>{error}</Problem>}
        {error && /credentials/i.test(error) && status.loggedIn && (
          // A helper that isn't GitHub's makes the status read "connected" while pushes still fail.
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() =>
              void run(
                "git",
                () => api.githubSetupGit(),
                (s) => {
                  setStatus(s);
                  setError(null);
                  toast.success("Git now uses your GitHub sign-in");
                },
              )
            }
          >
            {busy === "git" && <Spinner className="h-3.5 w-3.5 text-current" />} Let git use my GitHub sign-in
          </Button>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

function announcePublished(r: PublishResult) {
  toast.success("Published to GitHub", {
    description: (
      <span className="flex flex-col gap-0.5">
        <span className="break-all">{r.url}</span>
        {r.leftOut.length > 0 && <span>Left out (looked like secrets): {r.leftOut.join(", ")}</span>}
      </span>
    ),
    action: { label: "Open", onClick: () => void openExternal(r.url) },
    duration: r.leftOut.length ? 10000 : undefined,
  });
}

function PublishForm({
  agent,
  repo,
  busy,
  disabled,
  why,
  onSubmit,
}: {
  agent: Agent;
  repo: RepoInfo;
  busy: boolean;
  disabled: boolean;
  why?: string;
  onSubmit: (name: string, isPrivate: boolean, description: string) => void;
}) {
  const [name, setName] = useState(repo.suggestedName);
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const valid = /^([A-Za-z0-9._-]{1,100}\/)?[A-Za-z0-9._-]{1,100}$/.test(name.trim()) && !name.trim().startsWith("-");
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && valid) onSubmit(name.trim(), isPrivate, description);
      }}
    >
      <p className="text-[12.5px] text-muted">
        {repo.isRepo ? "This repository has no GitHub remote." : "This folder isn't a git repository yet."} Armada will
        {repo.isRepo ? "" : " set it up,"}
        {repo.hasCommits ? "" : " make a first commit (leaving out files that look like secrets),"} create the
        repository and push <span className="font-mono">{repo.branch ?? "main"}</span> from{" "}
        <span className="selectable break-all font-mono text-[11.5px] text-fg">{agent.projectPath}</span>.
      </p>
      <div>
        <Label htmlFor="gh-name">Repository name</Label>
        <Input
          id="gh-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          aria-invalid={!valid}
        />
        {!valid && (
          <p className="mt-1 text-[11.5px] text-err">
            Letters, numbers, “.”, “-” and “_” only (or owner/name to publish under an organisation).
          </p>
        )}
      </div>
      <div>
        <Label htmlFor="gh-desc">Description (optional)</Label>
        <Input id="gh-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <label className="flex items-center justify-between gap-3 text-[12.5px]">
        <span>
          <span className="font-medium text-fg">{isPrivate ? "Private" : "Public"}</span>
          <span className="block text-muted">
            {isPrivate ? "Only you (and people you add) can see it." : "Anyone on the internet can see it."}
          </span>
        </span>
        <Switch checked={isPrivate} onCheckedChange={setIsPrivate} aria-label="Private repository" />
      </label>
      <Button type="submit" size="sm" variant="primary" disabled={disabled || !valid} title={why}>
        {busy ? <Spinner className="h-3.5 w-3.5 text-current" /> : <Rocket />} Create repository &amp; push
      </Button>
    </form>
  );
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-base/40 p-3.5">
      <h3 className="mb-2 flex items-center gap-2 text-[13px] font-medium text-fg">
        <span
          className={
            done
              ? "flex h-5 w-5 items-center justify-center rounded-full bg-ok/15 text-ok"
              : "flex h-5 w-5 items-center justify-center rounded-full bg-raised text-[11px] text-muted"
          }
        >
          {done ? <Check className="h-3 w-3" /> : n}
        </span>
        {title}
      </h3>
      <div className="space-y-2.5 pl-7">{children}</div>
    </section>
  );
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="selectable flex items-start gap-1.5 whitespace-pre-wrap break-words rounded-lg border border-err/30 bg-err/[0.07] px-2.5 py-2 text-[12px] text-err"
    >
      <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" /> <span>{children}</span>
    </p>
  );
}
