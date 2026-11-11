import { ArrowLeft, ArrowRight, Check, Search } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { cn, modKey } from "@/lib/utils";
import { closeTour, useTour } from "@/store/tour";

// Step transitions in CSS (transform/opacity only; reduced motion is handled globally in globals.css).
const TOUR_CSS = `
@keyframes tour-in { from { opacity: 0; transform: translateX(var(--tour-dx, 20px)); } }
@keyframes tour-rise { from { opacity: 0; transform: translateY(6px); } }
.tour-step { animation: tour-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.tour-rise { animation: tour-rise 200ms ease-out both; }
`;

interface TourStep {
  id: string;
  title: string;
  body: string;
  hint: { keys: string[]; label: string };
  art: () => ReactNode;
}

const STEPS: TourStep[] = [
  {
    id: "start",
    title: "Start an agent",
    body: "Describe the task, pick a folder and press Enter. Approvals and questions appear above the message box. When it's done, review the changes and merge them.",
    hint: { keys: [modKey, "N"], label: "Start a new agent" },
    art: StartArt,
  },
  {
    id: "grid",
    title: "Many agents, one place",
    body: "Start up to 8 agents on the same project and watch them side by side in a grid. Mission Control shows every agent from all your projects together.",
    hint: { keys: [modKey, "⇧", "M"], label: "Open Mission Control" },
    art: GridArt,
  },
  {
    id: "dock",
    title: "What needs you stays in view",
    body: "Approvals, questions and the live plan stay above the message box, wherever you've scrolled, so nothing waits unnoticed.",
    hint: { keys: [modKey, "J"], label: "Jump to what needs you" },
    art: DockArt,
  },
  {
    id: "find",
    title: "Find anything, spend on your terms",
    body: "Search every conversation, archived agents included. Set a spending limit per agent, project or day. An agent that reaches it finishes its turn and waits for you.",
    hint: { keys: [modKey, "⇧", "F"], label: "Search every conversation" },
    art: FindArt,
  },
  {
    id: "palette",
    title: "One key reaches everything",
    body: "The command palette starts agents, opens projects and runs any command. Type > to start an agent, or ? to search every conversation.",
    hint: { keys: [modKey, "K"], label: "Open the command palette" },
    art: FindArt,
  },
];

/** The short "what you can do" tour. Skippable at any point; Esc skips too. */
export function WelcomeTour() {
  const open = useTour((s) => s.open);
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const next = useRef<HTMLButtonElement>(null);
  const last = step === STEPS.length - 1;
  const s = STEPS[step];

  // Reopened from Settings or the palette: start from the first step.
  useEffect(() => {
    if (open) {
      setStep(0);
      setDir(1);
    }
  }, [open]);

  const go = (n: number) => {
    setDir(n > step ? 1 : -1);
    setStep(Math.max(0, Math.min(STEPS.length - 1, n)));
  };

  // Arrow keys move between steps (the dialog traps focus, so a window listener only sees the tour).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "ArrowRight") setStep((n) => Math.min(STEPS.length - 1, n + 1));
      else if (e.key === "ArrowLeft") setStep((n) => Math.max(0, n - 1));
      else return;
      setDir(e.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeTour()}>
      <DialogContent
        title="Quick tour"
        description={`Step ${step + 1} of ${STEPS.length}`}
        className="w-[min(520px,calc(100vw-32px))]"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          next.current?.focus();
        }}
      >
        <style>{TOUR_CSS}</style>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-2 max-sm:px-4">
          <div key={s.id} className="tour-step" style={{ "--tour-dx": `${dir * 20}px` } as CSSProperties}>
            <Stage>{s.art()}</Stage>
            {/* One height for every step, so the dialog doesn't jump as the copy changes. */}
            <div className="min-h-[148px]">
              <h2 className="mt-5 text-[20px] font-semibold leading-[26px] tracking-[-0.02em] text-fg">{s.title}</h2>
              <p className="mt-1.5 text-[13.5px] leading-[21px] text-muted">{s.body}</p>
              <p className="mt-3.5 flex items-center gap-2 text-small leading-[18px] text-steel">
                <span className="inline-flex gap-0.5">
                  {s.hint.keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
                {s.hint.label}
              </p>
            </div>
          </div>
        </div>
        <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-t border-line bg-panel/60 px-5 py-3 max-sm:px-4">
          <Button variant="ghost" size="sm" onClick={closeTour} className="-ml-1.5 justify-self-start">
            Skip tour
          </Button>
          <div className="flex items-center gap-1.5" role="group" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
            {STEPS.map((x, i) => (
              <button
                key={x.id}
                type="button"
                aria-label={`Step ${i + 1}: ${x.title}`}
                aria-current={i === step ? "step" : undefined}
                onClick={() => go(i)}
                className="flex h-4 w-4 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                <span
                  className={cn(
                    "h-1.5 rounded-full transition-[width,background-color] duration-150",
                    i === step ? "w-4 bg-accent" : "w-1.5 bg-line-strong",
                  )}
                />
              </button>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2">
            {step > 0 && (
              <Button variant="ghost" size="sm" onClick={() => go(step - 1)}>
                <ArrowLeft /> Back
              </Button>
            )}
            <Button ref={next} variant="primary" size="sm" onClick={() => (last ? closeTour() : go(step + 1))}>
              {last ? (
                <>
                  <Check /> Got it
                </>
              ) : (
                <>
                  Next <ArrowRight />
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- artwork
// Small drawn scenes in the app's own tokens (no screenshots, so they follow the theme).

function Stage({ children }: { children: ReactNode }) {
  return (
    <div aria-hidden className="relative h-[176px] overflow-hidden rounded-xl border border-line bg-base/70 edge">
      <div
        className="absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          maskImage: "radial-gradient(ellipse 70% 80% at 50% 50%, black, transparent)",
          WebkitMaskImage: "radial-gradient(ellipse 70% 80% at 50% 50%, black, transparent)",
        }}
      />
      <div className="absolute left-1/2 top-1/2 h-[140px] w-[300px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/[0.08] blur-[50px]" />
      <div className="relative flex h-full items-center justify-center px-5">{children}</div>
    </div>
  );
}

const line = "h-1.5 rounded-full bg-raised";

function MiniTile({ provider, name, delay }: { provider: "claude" | "codex" | "grok"; name: string; delay: number }) {
  return (
    <div
      style={{ animationDelay: `${delay}ms` }}
      className="tour-rise rounded-lg border border-line bg-card px-2 py-1.5 edge"
    >
      <div className="flex items-center gap-1.5">
        <ProviderGlyph provider={provider} size="xs" title="" />
        <span className="text-micro font-medium leading-[14px] text-fg">{name}</span>
        <span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent animate-breathe" />
      </div>
      <div className={cn(line, "mt-2 w-[85%]")} />
      <div className={cn(line, "mt-1.5 w-[55%]")} />
    </div>
  );
}

function StartArt() {
  return (
    <div className="flex w-full max-w-[340px] flex-col gap-1.5">
      <div className="tour-rise rounded-lg border border-line-strong bg-card px-2.5 py-2 edge-strong">
        <div className="text-micro leading-[16px] text-fg">Find and fix the failing tests</div>
        <div className="mt-2 flex items-center gap-1.5">
          <span className="rounded-md border border-line bg-raised px-1.5 text-micro leading-[16px] text-muted">
            atlas-api
          </span>
          <span className="rounded-md border border-line bg-raised px-1.5 text-micro leading-[16px] text-muted">
            Worktree
          </span>
          <span className="ml-auto flex gap-0.5">
            <Kbd className="!h-[16px] !min-w-[16px] !text-micro">⏎</Kbd>
          </span>
        </div>
      </div>
      <div
        className="tour-rise flex items-center gap-2 rounded-lg border border-warn/30 bg-card px-2.5 py-1.5 edge"
        style={{ animationDelay: "100ms" }}
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
        <span className="min-w-0 flex-1 truncate text-micro leading-[14px] text-fg">Run npm test?</span>
        <span className="rounded-md border border-line-strong bg-raised px-1.5 text-micro leading-[16px] text-muted">
          Allow
        </span>
      </div>
      <div
        className="tour-rise flex items-center gap-2 rounded-lg border border-line bg-card px-2.5 py-1.5 edge"
        style={{ animationDelay: "200ms" }}
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
        <span className="min-w-0 flex-1 truncate text-micro leading-[14px] text-muted">3 files changed</span>
        <span className="rounded-md border border-line-strong bg-raised px-1.5 text-micro leading-[16px] text-muted">
          Review
        </span>
      </div>
    </div>
  );
}

function GridArt() {
  return (
    <div className="flex w-full items-center gap-3">
      <div className="grid flex-[1.7] grid-cols-2 gap-2">
        <MiniTile provider="claude" name="Claude #1" delay={0} />
        <MiniTile provider="claude" name="Claude #2" delay={50} />
        <MiniTile provider="codex" name="Codex #3" delay={100} />
        <MiniTile provider="grok" name="Grok #4" delay={150} />
      </div>
      <div
        className="tour-rise flex-1 rounded-lg border border-line-strong bg-card/90 p-2 edge-strong"
        style={{ animationDelay: "200ms" }}
      >
        <div className="eyebrow text-steel">Mission Control</div>
        {[
          ["atlas-api", "bg-warn"],
          ["web-app", "bg-accent"],
          ["docs-site", "bg-ok"],
        ].map(([n, c]) => (
          <div key={n} className="mt-1.5 flex items-center gap-1.5">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", c)} />
            <span className="truncate text-micro leading-[14px] text-muted">{n}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DockArt() {
  return (
    <div className="flex w-full max-w-[340px] flex-col gap-1.5">
      <div className="px-1">
        <div className={cn(line, "w-[80%]")} />
        <div className={cn(line, "mt-1.5 w-[50%]")} />
      </div>
      <div
        className="tour-rise rounded-lg border border-accent/30 bg-card px-2.5 py-2 edge"
        style={{ animationDelay: "60ms" }}
      >
        <div className="flex items-center justify-between text-micro leading-[14px]">
          <span className="font-medium text-fg">Plan</span>
          <span className="text-steel tabular">3 of 5</span>
        </div>
        <div className="mt-1.5 flex gap-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={cn("h-1 flex-1 rounded-full", i < 3 ? "bg-accent" : "bg-raised")} />
          ))}
        </div>
      </div>
      <div
        className="tour-rise flex items-center gap-2 rounded-lg border border-warn/30 bg-card px-2.5 py-1.5 edge"
        style={{ animationDelay: "120ms" }}
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
        <span className="min-w-0 flex-1 truncate text-micro leading-[14px] text-fg">
          Keep validation in the handler?
        </span>
        <span className="rounded-md border border-line-strong bg-raised px-1.5 text-micro leading-[16px] text-muted">
          Yes
        </span>
        <span className="rounded-md border border-line-strong bg-raised px-1.5 text-micro leading-[16px] text-muted">
          No
        </span>
      </div>
      <div
        className="tour-rise flex h-7 items-center rounded-lg border border-line-strong bg-panel px-2.5 text-micro leading-[14px] text-steel"
        style={{ animationDelay: "180ms" }}
      >
        Message Claude…
      </div>
    </div>
  );
}

function FindArt() {
  return (
    <div className="flex w-full items-center gap-3">
      <div className="tour-rise flex-[1.5] rounded-lg border border-line-strong bg-card p-2 edge-strong">
        <div className="flex h-6 items-center gap-1.5 rounded-md border border-line bg-base/60 px-2">
          <Search className="h-3 w-3 text-steel" />
          <span className="text-micro leading-[14px] text-fg">migration</span>
          <span className="ml-auto flex gap-0.5">
            <Kbd className="!h-[16px] !min-w-[16px] !text-micro">{modKey}</Kbd>
            <Kbd className="!h-[16px] !min-w-[16px] !text-micro">⇧</Kbd>
            <Kbd className="!h-[16px] !min-w-[16px] !text-micro">F</Kbd>
          </span>
        </div>
        {[
          ["Claude #1", "Added the ", " for users"],
          ["Codex #3", "Rolled back the ", " and retried"],
        ].map(([who, a, b]) => (
          <div key={who} className="mt-2 px-0.5">
            <div className="text-micro leading-[14px] text-steel">{who}</div>
            <div className="truncate text-micro leading-[15px] text-muted">
              {a}
              <mark className="rounded-[3px] bg-accent/20 px-0.5 text-fg">migration</mark>
              {b}
            </div>
          </div>
        ))}
      </div>
      <div
        className="tour-rise flex-1 rounded-lg border border-line bg-card p-2.5 edge"
        style={{ animationDelay: "100ms" }}
      >
        <div className="eyebrow text-steel">Spending limit</div>
        <div className="mt-1.5 text-[15px] font-semibold leading-[20px] tracking-tight text-fg tabular">
          $3.20 <span className="text-micro font-normal text-steel">of $5.00</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
          <div className="h-full w-[64%] rounded-full bg-accent" />
        </div>
        <div className="mt-2 text-micro leading-[14px] text-steel">Pauses at the limit</div>
      </div>
    </div>
  );
}
