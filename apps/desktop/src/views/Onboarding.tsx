import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  FolderGit2,
  GitBranch,
  Play,
  RefreshCw,
  Rocket,
  UserPlus,
  Volume2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AccountRow } from "@/components/accounts/AccountRow";
import { AddAccountDialog } from "@/components/accounts/AddAccountDialog";
import { AppMark } from "@/components/AppMark";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { InstallAllBanner } from "@/components/settings/InstallAllBanner";
import { ProviderCard, providerReady } from "@/components/settings/ProviderCard";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { PROVIDER_ORDER, PROVIDERS } from "@/lib/providers";
import type { Settings } from "@/lib/types";
import { basename, cn, errorMessage, modKey, prettyPath } from "@/lib/utils";
import { discoverProjectsOnce } from "@/lib/launchDefaults";
import { useApp } from "@/store/app";

// Step transitions in CSS (transform/opacity only; reduced motion handled globally).
const ONBOARDING_CSS = `
@keyframes ob-in { from { opacity: 0; transform: translateX(var(--ob-dx, 24px)); } }
@keyframes ob-pop { from { opacity: 0; transform: scale(0.86); } }
@keyframes ob-rise { from { opacity: 0; transform: translateY(6px); } }
.ob-step { animation: ob-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.ob-pop { animation: ob-pop 200ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.ob-rise { animation: ob-rise 180ms ease-out both; }
`;

const STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "providers", label: "Providers" },
  { id: "accounts", label: "Accounts" },
  { id: "prefs", label: "Alerts" },
  { id: "done", label: "Ready" },
] as const;

async function save(patch: Partial<Settings>) {
  try {
    await useApp.getState().patchSettings(patch);
  } catch (e) {
    toast.error("Couldn't save settings", { description: errorMessage(e) });
  }
}

export function Onboarding() {
  // Dev/review convenience: ?onboarding&step=2
  const [step, setStep] = useState(() => {
    try {
      const n = Number(new URLSearchParams(location.search).get("step"));
      return Number.isInteger(n) && n >= 0 && n < STEPS.length ? n : 0;
    } catch {
      return 0;
    }
  });
  const [dir, setDir] = useState(1);
  const [finishing, setFinishing] = useState(false);

  const go = (n: number) => {
    setDir(n > step ? 1 : -1);
    setStep(Math.max(0, Math.min(STEPS.length - 1, n)));
  };

  const finish = async () => {
    setFinishing(true);
    await save({ onboarded: true });
    setFinishing(false);
  };

  const id = STEPS[step].id;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <style>{ONBOARDING_CSS}</style>
      <Backdrop />

      {/* Step indicator, with "Skip setup" in the same row (in flow, so it never overlaps). */}
      <div className="relative z-10 grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 pt-6 sm:px-5">
        <span aria-hidden />
        <nav aria-label="Setup steps" className="flex items-center justify-center gap-1">
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => i < step && go(i)}
              disabled={i > step}
              aria-current={i === step ? "step" : undefined}
              aria-label={`Step ${i + 1}: ${s.label}${i < step ? " (done)" : ""}`}
              className="group flex items-center gap-1 disabled:cursor-default"
            >
              <span
                className={cn(
                  "flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-medium transition-colors duration-150",
                  i === step
                    ? "bg-raised text-fg ring-1 ring-line-strong"
                    : i < step
                      ? "text-muted hover:text-fg"
                      : "text-steel",
                )}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 items-center justify-center rounded-full text-[9.5px] tabular",
                    i < step
                      ? "bg-accent/90 text-accent-fg"
                      : i === step
                        ? "bg-accent text-accent-fg"
                        : "bg-raised text-steel",
                  )}
                >
                  {i < step ? <Check className="h-2.5 w-2.5" strokeWidth={3.5} /> : i + 1}
                </span>
                <span className="hidden md:inline">{s.label}</span>
              </span>
              {i < STEPS.length - 1 && <span className={cn("h-px w-5", i < step ? "bg-accent/50" : "bg-line")} />}
            </button>
          ))}
        </nav>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={finish}
            className="h-6 shrink-0 whitespace-nowrap rounded-md px-2 text-[12px] text-steel transition-colors hover:text-fg"
          >
            Skip setup
          </button>
        </div>
      </div>

      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[680px] flex-col justify-center px-6 py-8">
          <div key={id} className="ob-step" style={{ "--ob-dx": `${dir * 28}px` } as React.CSSProperties}>
            {id === "welcome" && <Welcome onNext={() => go(1)} />}
            {id === "providers" && <ProvidersStep />}
            {id === "accounts" && <AccountsStep />}
            {id === "prefs" && <PrefsStep />}
            {id === "done" && <DoneStep onFinish={finish} finishing={finishing} />}
          </div>
        </div>
      </div>

      {id !== "welcome" && id !== "done" && (
        <footer className="relative z-10 border-t border-line bg-panel/70 backdrop-blur">
          <div className="mx-auto flex max-w-[680px] items-center justify-between px-6 py-3">
            <Button variant="ghost" onClick={() => go(step - 1)}>
              <ArrowLeft /> Back
            </Button>
            <Button variant="primary" onClick={() => go(step + 1)}>
              Continue <ArrowRight />
            </Button>
          </div>
        </footer>
      )}
    </div>
  );
}

function Backdrop() {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      <div
        className="absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse 60% 55% at 50% 40%, black, transparent)",
          WebkitMaskImage: "radial-gradient(ellipse 60% 55% at 50% 40%, black, transparent)",
        }}
      />
      <div className="absolute left-1/2 top-[18%] h-[420px] w-[620px] -translate-x-1/2 rounded-full bg-accent/[0.07] blur-[90px]" />
    </div>
  );
}

function StepHeader({ eyebrow, title, description }: { eyebrow: string; title: ReactNode; description: ReactNode }) {
  return (
    <div className="mb-6">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">{eyebrow}</p>
      <h1 className="mt-1.5 text-[24px] font-semibold tracking-[-0.025em]">{title}</h1>
      <p className="mt-1.5 max-w-[520px] text-[13.5px] leading-relaxed text-muted">{description}</p>
    </div>
  );
}

// ---------------------------------------------------------------- steps

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex flex-col items-center py-6 text-center">
      <div className="ob-pop relative mb-8">
        <div className="absolute inset-0 -m-14 rounded-full bg-accent/25 blur-[60px] animate-breathe" />
        <div className="relative flex h-[104px] w-[104px] items-center justify-center rounded-[28px] border border-line-strong bg-gradient-to-b from-raised to-panel shadow-[0_20px_60px_-10px_rgba(0,0,0,0.7)] edge-strong texture">
          <AppMark size={60} />
        </div>
      </div>
      <h1 className="text-[34px] font-semibold leading-tight tracking-[-0.035em]">
        Command your{" "}
        <span className="bg-gradient-to-r from-[color-mix(in_srgb,var(--accent)_45%,white)] via-accent to-[color-mix(in_srgb,var(--accent)_65%,black)] bg-clip-text text-transparent">
          fleet
        </span>
        .
      </h1>
      <p className="mt-3 max-w-[460px] text-[14px] leading-relaxed text-muted">
        Run Claude, Codex and Grok agents side by side, across every account you own. Approve, review and ship from one
        gunmetal command deck.
      </p>
      <div className="mt-7 flex items-center gap-2.5">
        {PROVIDER_ORDER.map((p, i) => (
          <span
            key={p}
            style={{ animationDelay: `${80 + i * 50}ms` }}
            className="ob-rise flex items-center gap-2 rounded-full border border-line bg-card/80 py-1 pl-1 pr-3 text-[12.5px] text-muted edge"
          >
            <ProviderGlyph provider={p} size="sm" />
            {PROVIDERS[p].short}
          </span>
        ))}
      </div>
      <Button variant="primary" size="lg" className="mt-9 min-w-[180px]" onClick={onNext} autoFocus>
        Get started <ArrowRight />
      </Button>
      <p className="mt-3 text-[12px] text-steel">Takes about a minute. You can change everything later.</p>
    </div>
  );
}

function ProvidersStep() {
  const providers = useApp((s) => s.providers);
  const [detecting, setDetecting] = useState(false);
  const ran = useRef(false);

  const detect = async () => {
    setDetecting(true);
    try {
      useApp.getState().setProviders(await api.detectProviders());
    } catch (e) {
      toast.error("Detection failed", { description: errorMessage(e) });
    } finally {
      setDetecting(false);
    }
  };

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    void detect();
  }, []);

  const ready = providers.filter(providerReady).length;

  return (
    <>
      <StepHeader
        eyebrow="Step 2 of 5 · Providers"
        title="Your agent runtimes"
        description="Armada drives each vendor's official CLI, so you get their newest features the day they ship. One click installs anything that's missing."
      />
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[12.5px] text-muted">
          {detecting ? (
            "Scanning your PATH…"
          ) : (
            <>
              <span className="text-fg tabular">{ready}</span> of {providers.length} ready
            </>
          )}
        </span>
        <Button size="sm" variant="ghost" onClick={detect} disabled={detecting}>
          <RefreshCw className={cn(detecting && "animate-spin")} /> Re-detect
        </Button>
      </div>
      {!detecting && <InstallAllBanner providers={providers} className="mb-3" />}
      <div className="space-y-2.5">
        {providers.length === 0
          ? [0, 1, 2].map((i) => <div key={i} className="skeleton h-[86px] rounded-xl" />)
          : providers.map((p) => <ProviderCard key={p.provider} info={p} compact />)}
      </div>
    </>
  );
}

function AccountsStep() {
  const accounts = useApp((s) => s.accounts);
  const [adding, setAdding] = useState(false);
  const signedIn = accounts.filter((a) => a.status?.loggedIn).length;

  return (
    <>
      <StepHeader
        eyebrow="Step 3 of 5 · Accounts"
        title="Sign in once, switch in one click"
        description="Armada found the logins your CLIs already use. Add more accounts (a second Claude Max, a work ChatGPT…) and run agents on all of them at once."
      />
      <div className="overflow-hidden rounded-xl border border-line bg-card edge">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="text-[12.5px] text-muted">
            <span className="text-fg tabular">{signedIn}</span> of {accounts.length} signed in
          </span>
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            <UserPlus /> Add account
          </Button>
        </div>
        <div className="max-h-[300px] divide-y divide-line overflow-y-auto">
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} compact />
          ))}
          {accounts.length === 0 && (
            <div className="px-4 py-8 text-center text-[13px] text-muted">No accounts yet. Add one to get started.</div>
          )}
        </div>
      </div>
      <AddAccountDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}

function PrefsStep() {
  const settings = useApp((s) => s.settings);
  const [volume, setVolume] = useState(settings?.sounds.volume ?? 0.6);
  if (!settings) return null;
  const s = settings.sounds;
  const n = settings.notifications;

  return (
    <>
      <StepHeader
        eyebrow="Step 4 of 5 · Alerts"
        title="Attention, not babysitting"
        description="Armada pings you when an agent needs approval, finishes, or hits an error, and stays quiet otherwise."
      />
      <div className="space-y-2.5">
        <PrefCard
          icon={<Volume2 />}
          title="Sounds"
          description="Short metallic cues, designed for Armada."
          control={
            <Switch
              aria-label="Sounds"
              checked={s.enabled}
              onCheckedChange={(v) => void save({ sounds: { ...s, enabled: v } })}
            />
          }
        >
          <div className={cn("mt-3 flex items-center gap-3", !s.enabled && "opacity-40")}>
            <Slider
              aria-label="Volume"
              value={volume}
              disabled={!s.enabled}
              onValueChange={setVolume}
              onValueCommit={(v) => void save({ sounds: { ...s, volume: v } })}
              className="max-w-[220px]"
            />
            <span className="w-9 text-[12px] text-muted tabular">{Math.round(volume * 100)}%</span>
            <div className="ml-auto flex gap-1">
              {(["permission", "done", "error"] as const).map((r) => (
                <Button
                  key={r}
                  size="xs"
                  variant="ghost"
                  disabled={!s.enabled}
                  onClick={() => void api.previewSound(r).catch(() => {})}
                  aria-label={`Preview ${r} sound`}
                >
                  <Play className="!h-3 !w-3" /> {r === "permission" ? "Approval" : r === "done" ? "Done" : "Error"}
                </Button>
              ))}
            </div>
          </div>
        </PrefCard>
        <PrefCard
          icon={<Bell />}
          title="Desktop notifications"
          description="With Approve / Deny / Open actions where your OS supports them."
          control={
            <Switch
              aria-label="Notifications"
              checked={n.enabled}
              onCheckedChange={(v) => void save({ notifications: { ...n, enabled: v } })}
            />
          }
        />
        <PrefCard
          icon={<Bell className="opacity-60" />}
          title="Smart mute"
          description="Stay silent about the agent you're already looking at."
          control={
            <Switch
              aria-label="Smart mute"
              checked={n.smartMute}
              onCheckedChange={(v) => void save({ notifications: { ...n, smartMute: v } })}
            />
          }
        />
        <PrefCard
          icon={<GitBranch />}
          title="Isolate agents in git worktrees"
          description="Each agent works on its own branch, so parallel agents never collide."
          control={
            <Switch
              aria-label="Default worktree"
              checked={settings.defaultWorktree}
              onCheckedChange={(v) => void save({ defaultWorktree: v })}
            />
          }
        />
      </div>
    </>
  );
}

function PrefCard({
  icon,
  title,
  description,
  control,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  control: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-card p-4 edge">
      <div className="flex items-center gap-3.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-raised text-steel edge [&_svg]:h-4 [&_svg]:w-4">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium">{title}</div>
          <div className="text-[12px] text-muted">{description}</div>
        </div>
        {control}
      </div>
      {children}
    </div>
  );
}

function DoneStep({ onFinish, finishing }: { onFinish: () => void; finishing: boolean }) {
  const providers = useApp((s) => s.providers);
  const accounts = useApp((s) => s.accounts);
  const ready = providers.filter(providerReady).length;
  const signedIn = accounts.filter((a) => a.status?.loggedIn).length;
  return (
    <div className="flex flex-col items-center py-6 text-center">
      <div className="ob-pop relative mb-7">
        <div className="absolute inset-0 -m-10 rounded-full bg-ok/20 blur-[50px]" />
        <div className="relative flex h-20 w-20 items-center justify-center rounded-full border border-ok/40 bg-ok/10 text-ok shadow-[0_0_40px_-6px_var(--ok)]">
          <Check className="h-9 w-9" strokeWidth={2.6} />
        </div>
      </div>
      <h1 className="text-[28px] font-semibold tracking-[-0.03em]">You're ready to launch</h1>
      <p className="mt-2.5 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-[13.5px] leading-relaxed text-muted">
        Press
        <span className="inline-flex gap-0.5">
          <Kbd>{modKey}</Kbd>
          <Kbd>N</Kbd>
        </span>
        to start your first agent, or
        <span className="inline-flex gap-0.5">
          <Kbd>{modKey}</Kbd>
          <Kbd>K</Kbd>
        </span>
        for everything else.
      </p>
      <div className="mt-6 grid w-full max-w-[420px] grid-cols-2 gap-2.5">
        <Stat value={`${ready}/${providers.length}`} label="providers ready" />
        <Stat value={`${signedIn}/${accounts.length}`} label="accounts signed in" />
      </div>
      <ProjectsGlimpse />
      <Button
        variant="primary"
        size="lg"
        className="mt-8 min-w-[200px]"
        onClick={onFinish}
        disabled={finishing}
        autoFocus
      >
        <Rocket /> Launch Armada
      </Button>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl border border-line bg-card px-4 py-3 edge">
      <div className="text-[20px] font-semibold tracking-tight tabular">{value}</div>
      <div className="text-[11.5px] text-muted">{label}</div>
    </div>
  );
}

/** "We found N repos": a non-blocking peek at discover_projects so the first agent has somewhere to go. */
function ProjectsGlimpse() {
  const [found, setFound] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    discoverProjectsOnce()
      .then((p) => !cancelled && setFound(p))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);
  if (failed || (found && found.length === 0)) return null;
  return (
    <div className="mt-4 w-full max-w-[420px] rounded-xl border border-line bg-card px-4 py-3 text-left edge">
      <div className="flex items-center gap-2 text-[12.5px]">
        <FolderGit2 className="h-4 w-4 text-accent" />
        {found ? (
          <span>
            <span className="font-semibold tabular">{found.length}</span> project{found.length === 1 ? "" : "s"} found
            on this computer
          </span>
        ) : (
          <span className="text-muted">Looking for your projects…</span>
        )}
      </div>
      <div className="mt-2 flex min-h-6 flex-wrap gap-1.5">
        {found
          ? found.slice(0, 6).map((p) => (
              <span
                key={p}
                title={prettyPath(p)}
                className="inline-flex h-6 max-w-[160px] items-center rounded-full border border-line bg-base/60 px-2.5 text-[11.5px] text-muted"
              >
                <span className="truncate">{basename(p)}</span>
              </span>
            ))
          : ["w-20", "w-24", "w-16"].map((w) => <span key={w} className={cn("skeleton h-6 rounded-full", w)} />)}
        {found && found.length > 6 && (
          <span className="inline-flex h-6 items-center px-1 text-[11.5px] text-steel">+{found.length - 6} more</span>
        )}
      </div>
      <p className="mt-2 text-[11.5px] text-steel">Pick any of them when you start an agent.</p>
    </div>
  );
}
