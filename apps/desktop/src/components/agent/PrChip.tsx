import {
  Check,
  ExternalLink,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  GitMerge,
  MessageSquareText,
  RefreshCw,
  Wrench,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { attempt } from "@/lib/actions";
import { api } from "@/lib/api";
import { openExternal } from "@/lib/external";
import { agentHasBranch, ciSummary, failingChecks, formatDuration, PR_REVIEW_LABEL, PR_STATE_LABEL } from "@/lib/pr";
import type { Agent, PrCheck, PrInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { refreshPr, usePr } from "@/store/pr";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "../ui/dialog";
import { Textarea } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/misc";

/** CI result glyph: green check, red x, or amber spinner. */
export function CiIcon({ pr, className }: { pr: PrInfo; className?: string }) {
  const { overall } = pr.summary;
  if (overall === "passing") return <Check className={cn("h-3 w-3 text-ok", className)} aria-hidden />;
  if (overall === "failing") return <X className={cn("h-3 w-3 text-err", className)} aria-hidden />;
  if (overall === "pending") return <Spinner className={cn("h-3 w-3 text-warn", className)} />;
  return null;
}

function StateIcon({ state }: { state: PrInfo["state"] }) {
  const cls = "h-3 w-3 shrink-0";
  if (state === "merged") return <GitMerge className={cn(cls, "text-accent")} />;
  if (state === "closed") return <GitPullRequestClosed className={cn(cls, "text-err")} />;
  if (state === "draft") return <GitPullRequestDraft className={cn(cls, "text-steel")} />;
  return <GitPullRequest className={cn(cls, "text-ok")} />;
}

function CheckRow({ check }: { check: PrCheck }) {
  const dur = formatDuration(check.durationSecs);
  const icon =
    check.status === "passing" ? (
      <Check className="h-3.5 w-3.5 text-ok" />
    ) : check.status === "failing" ? (
      <X className="h-3.5 w-3.5 text-err" />
    ) : check.status === "pending" ? (
      <Spinner className="h-3.5 w-3.5 text-warn" />
    ) : (
      <span className="h-1.5 w-1.5 rounded-full bg-steel/60" />
    );
  const label = check.workflow ? `${check.workflow} / ${check.name}` : check.name;
  return (
    <li>
      <button
        type="button"
        disabled={!check.url}
        onClick={() => check.url && void openExternal(check.url)}
        title={check.url ? "Open check on GitHub" : undefined}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] transition-colors enabled:hover:bg-raised/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent/25"
      >
        <span className="flex w-4 shrink-0 justify-center" aria-label={check.status}>
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-fg/90">{label}</span>
        {dur && <span className="shrink-0 text-[11px] text-steel tabular">{dur}</span>}
      </button>
    </li>
  );
}

type Draft = { kind: "ci" | "review"; text: string; omitted: number } | null;

/** The pull request + CI chip in the agent header. Renders nothing without a PR. */
export function PrChip({ agent }: { agent: Agent }) {
  const status = usePr((s) => s.byAgent[agent.id]);
  const [draft, setDraft] = useState<Draft>(null);
  const [loading, setLoading] = useState<"ci" | "review" | "refresh" | null>(null);
  if (!agentHasBranch(agent) || status?.state !== "ok" || !status.pr) return null;
  const pr = status.pr;
  const failing = failingChecks(pr);
  const review = pr.review && pr.review !== "review_required" ? pr.review : null;
  const open = pr.state === "open" || pr.state === "draft";

  const prepare = async (kind: "ci" | "review") => {
    setLoading(kind);
    const prompt = await attempt(
      kind === "ci" ? "Couldn't prepare the CI prompt" : "Couldn't load review comments",
      () => (kind === "ci" ? api.prFixCiPrompt(agent.id) : api.prReviewPrompt(agent.id)),
    );
    setLoading(null);
    if (prompt) setDraft({ kind, text: prompt.text, omitted: prompt.omitted });
  };

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Pull request #${pr.number}, ${PR_STATE_LABEL[pr.state]}, ${ciSummary(pr)}${review ? `, ${PR_REVIEW_LABEL[review]}` : ""}`}
            className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border border-line bg-card/60 px-2 text-[11.5px] transition-colors hover:bg-raised/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent/25"
          >
            <StateIcon state={pr.state} />
            <span className="tabular text-fg/90">#{pr.number}</span>
            <span className="text-muted">{PR_STATE_LABEL[pr.state]}</span>
            {open && pr.summary.overall !== "none" && (
              <span className="inline-flex items-center gap-1">
                <CiIcon pr={pr} />
                {pr.summary.failing > 0 && (
                  <span className="tabular font-medium text-err">{pr.summary.failing} failing</span>
                )}
              </span>
            )}
            {open && review && (
              <span className={cn("hidden sm:inline", review === "approved" ? "text-ok" : "text-warn")}>
                {PR_REVIEW_LABEL[review]}
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-medium text-fg">
                {pr.title || `Pull request #${pr.number}`}
              </div>
              <div className="mt-0.5 text-[11.5px] text-steel">
                #{pr.number} · {PR_STATE_LABEL[pr.state]}
                {review ? ` · ${PR_REVIEW_LABEL[review]}` : ""}
                {pr.mergeable === "conflicting" ? " · Has conflicts" : ""}
              </div>
            </div>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Refresh status"
              disabled={loading === "refresh"}
              onClick={async () => {
                setLoading("refresh");
                await refreshPr(agent.id, true);
                setLoading(null);
              }}
            >
              <RefreshCw className={cn("!h-3 !w-3", loading === "refresh" && "animate-spin")} />
            </Button>
          </div>
          <div className="mt-2 text-[11px] font-medium uppercase tracking-wide text-steel">{ciSummary(pr)}</div>
          {pr.checks.length > 0 && (
            <ul className="-mx-1.5 mt-1 max-h-56 overflow-y-auto">
              {pr.checks.map((c, i) => (
                <CheckRow key={`${c.name}-${i}`} check={c} />
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {open && failing.length > 0 && (
              <Button size="sm" variant="primary" disabled={loading !== null} onClick={() => void prepare("ci")}>
                {loading === "ci" ? <Spinner className="h-3.5 w-3.5" /> : <Wrench className="!h-3.5 !w-3.5" />}
                Fix CI
              </Button>
            )}
            {open && (
              <Button size="sm" variant="secondary" disabled={loading !== null} onClick={() => void prepare("review")}>
                {loading === "review" ? (
                  <Spinner className="h-3.5 w-3.5" />
                ) : (
                  <MessageSquareText className="!h-3.5 !w-3.5" />
                )}
                Address comments
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void openExternal(pr.url)}>
              <ExternalLink className="!h-3.5 !w-3.5" />
              Open on GitHub
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <SendPromptDialog agent={agent} pr={pr} draft={draft} onClose={() => setDraft(null)} />
    </>
  );
}

function SendPromptDialog({
  agent,
  pr,
  draft,
  onClose,
}: {
  agent: Agent;
  pr: PrInfo;
  draft: Draft;
  onClose: () => void;
}) {
  return (
    <Dialog open={draft !== null} onOpenChange={(o) => !o && onClose()}>
      {draft && <SendPromptBody key={draft.kind + pr.number} agent={agent} pr={pr} draft={draft} onClose={onClose} />}
    </Dialog>
  );
}

function SendPromptBody({
  agent,
  pr,
  draft,
  onClose,
}: {
  agent: Agent;
  pr: PrInfo;
  draft: NonNullable<Draft>;
  onClose: () => void;
}): ReactNode {
  const [text, setText] = useState(draft.text);
  const [omitted, setOmitted] = useState(draft.omitted);
  const [sending, setSending] = useState(false);
  const [loadingOutside, setLoadingOutside] = useState(false);
  const includeOutside = async () => {
    setLoadingOutside(true);
    const prompt = await attempt("Couldn't load review comments", () => api.prReviewPrompt(agent.id, true));
    setLoadingOutside(false);
    if (!prompt) return;
    setText(prompt.text);
    setOmitted(0);
  };
  const busy = agent.status === "working" || agent.status === "starting" || agent.status === "needs_permission";
  const title = draft.kind === "ci" ? `Fix CI on #${pr.number}` : `Address review comments on #${pr.number}`;
  const send = async () => {
    setSending(true);
    // send_prompt queues behind a running turn, so busy agents just pick it up next.
    const ok = await attempt("Couldn't send the prompt", () => api.sendPrompt(agent.id, text.trim()));
    setSending(false);
    if (ok === null) return;
    toast.success(busy ? "Queued for the agent" : "Sent to the agent", { description: title });
    onClose();
  };
  return (
    <DialogContent
      title={title}
      description={
        busy
          ? "The agent is busy, so this will queue and run after its current turn. Edit it first if you like."
          : "This is what the agent will receive. Edit it first if you like."
      }
      sheet
      className="w-[min(720px,calc(100vw-32px))]"
    >
      <DialogBody>
        <p className="mb-2 text-[12px] text-muted">
          This message includes text written by other people. Review it before sending.
        </p>
        {omitted > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[12px]">
            <span>
              {omitted} {omitted === 1 ? "comment" : "comments"} from people outside the project{" "}
              {omitted === 1 ? "was" : "were"} left out.
            </span>
            <Button size="xs" variant="ghost" disabled={loadingOutside} onClick={() => void includeOutside()}>
              {loadingOutside && <Spinner className="h-3 w-3" />}
              Include {omitted === 1 ? "it" : "them"}
            </Button>
          </div>
        )}
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Prompt to send"
          spellCheck={false}
          className="h-[min(50vh,420px)] w-full resize-y font-mono text-[12px]"
        />
        <div className="mt-1.5 text-[11px] text-steel tabular">{text.length.toLocaleString()} characters</div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={sending || !text.trim()} onClick={() => void send()}>
          {sending && <Spinner className="h-3.5 w-3.5" />}
          {busy ? "Queue for agent" : "Send to agent"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
