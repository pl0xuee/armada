import {
  ArrowLeft,
  ArrowRight,
  Bell,
  BellOff,
  Check,
  ChevronRight,
  Download,
  FolderGit2,
  GitBranch,
  Play,
  LogIn,
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
import { AccentText, HeroBackdrop } from "@/components/HeroBackdrop";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { ToolPickRow } from "@/components/onboarding/ToolPickRow";
import { providerReady } from "@/components/settings/ProviderCard";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { startLogin } from "@/lib/actions";
import { api } from "@/lib/api";
import {
  moveOnAction,
  offeredFirst,
  primaryAction,
  progressNote,
  rowState,
  selectedTools,
  signInOffers,
} from "@/lib/firstRun";
import { PROVIDER_ORDER, PROVIDERS } from "@/lib/providers";
import type { Settings } from "@/lib/types";
import { basename, cn, errorMessage, modKey, prettyPath } from "@/lib/utils";
import { discoverProjectsOnce } from "@/lib/launchDefaults";
import { useApp } from "@/store/app";
import { useInstalls } from "@/store/installs";

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
    // Anthropic's advice for new setups: helper agents on Sonnet, so the agent's own model does the hard part.
    const saver = useApp.getState().settings?.tokenSaver;
    await save({
      onboarded: true,
      ...(saver && !saver.subagentModel ? { tokenSaver: { ...saver, subagentModel: "sonnet" } } : {}),
    });
    setFinishing(false);
  };

  const id = STEPS[step].id;
  const hero = id === "welcome" || id === "done";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <style>{ONBOARDING_CSS}</style>
      <HeroBackdrop />

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
                  "flex h-6 items-center gap-1.5 rounded-full px-2.5 text-meta font-medium transition-colors duration-150",
                  i === step
                    ? "bg-raised text-fg ring-1 ring-line-strong"
                    : i < step
                      ? "text-muted hover:text-fg"
                      : "text-steel",
                )}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 items-center justify-center rounded-full text-micro tabular",
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
            className="h-6 shrink-0 whitespace-nowrap rounded-md px-2 text-caption text-muted transition-colors hover:text-fg"
          >
            Skip setup
          </button>
        </div>
      </div>

      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            "mx-auto flex min-h-full w-full max-w-[680px] flex-col px-6 py-8",
            // Welcome and Ready are centred; the steps with a form share one top offset so headings stay put.
            hero ? "justify-center" : "pt-[clamp(24px,9vh,88px)]",
          )}
        >
          <div key={id} className="ob-step" style={{ "--ob-dx": `${dir * 28}px` } as React.CSSProperties}>
            {id === "welcome" && <Welcome onNext={() => go(1)} />}
            {id === "providers" && <ProvidersStep />}
            {id === "accounts" && <AccountsStep />}
            {id === "prefs" && <PrefsStep />}
            {id === "done" && <DoneStep onFinish={finish} finishing={finishing} onAddAccount={() => go(2)} />}
          </div>
        </div>
      </div>

      {id !== "welcome" && id !== "done" && (
        <footer className="relative z-10 border-t border-line bg-panel/70 backdrop-blur">
          <div className="mx-auto flex max-w-[680px] items-center justify-between px-6 py-3">
            <Button variant="ghost" onClick={() => go(step - 1)}>
              <ArrowLeft /> Back
            </Button>
            {id === "providers" ? (
              <ProvidersNext onNext={() => go(step + 1)} />
            ) : (
              <Button variant="primary" onClick={() => go(step + 1)}>
                Continue <ArrowRight />
              </Button>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}

function StepHeader({ title, description }: { title: ReactNode; description: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-[24px] font-semibold tracking-[-0.025em]">{title}</h1>
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
        Many agents, <AccentText>you in control</AccentText>.
      </h1>
      <p className="mt-3 max-w-[460px] text-[14px] leading-relaxed text-muted">
        Run several AI coding agents at once, and stay in control. Use Claude, Codex and Grok side by side, on all your
        accounts. Approve, review and ship from one place.
      </p>
      <div className="mt-7 flex items-center gap-2.5">
        {PROVIDER_ORDER.map((p, i) => (
          <span
            key={p}
            style={{ animationDelay: `${80 + i * 50}ms` }}
            className="ob-rise flex items-center gap-2 rounded-full border border-line bg-card/80 py-1 pl-1 pr-3 text-small text-muted edge"
          >
            <ProviderGlyph provider={p} size="sm" />
            {PROVIDERS[p].short}
          </span>
        ))}
      </div>
      <Button variant="primary" size="lg" className="mt-9 min-w-[180px]" onClick={onNext} autoFocus>
        Get started <ArrowRight />
      </Button>
      <p className="mt-3 text-caption text-steel">Takes about a minute. You can change everything later.</p>
    </div>
  );
}

function ProvidersStep() {
  const providers = useApp((s) => s.providers);
  const runs = useInstalls((s) => s.runs);
  const unticked = useInstalls((s) => s.unticked);
  const log = useInstalls((s) => s.log);
  // Scanning starts as soon as the step opens, so there is no "nothing found" flash before it begins.
  const [detecting, setDetecting] = useState(true);
  const [details, setDetails] = useState(false);
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

  const states = providers.map((p) => rowState(p, runs[p.provider]));
  const ready = states.filter((s) => s === "ready").length;
  const note = progressNote(states);

  return (
    <>
      <StepHeader
        title="Your AI tools"
        description="Pick the tools you want. Kvistcode runs the official tool from each provider, so you get new features as soon as they ship. Nothing is installed until you press the button."
      />
      <div className="mb-3 flex items-center justify-between">
        <span className="text-small text-muted">
          {detecting ? (
            "Looking for your tools…"
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
      <div className="space-y-2.5">
        {providers.length > 0 ? (
          providers.map((p, i) => (
            <ToolPickRow
              key={p.provider}
              info={p}
              state={states[i]}
              run={runs[p.provider]}
              ticked={!unticked.includes(p.provider)}
              onToggle={() => useInstalls.getState().toggle(p.provider)}
              onRetry={() => void useInstalls.getState().start([p.provider])}
            />
          ))
        ) : detecting ? (
          [0, 1, 2].map((i) => <div key={i} className="skeleton h-[70px] rounded-xl" />)
        ) : (
          <div className="flex flex-col items-center rounded-xl border border-line bg-card px-4 py-8 text-center edge">
            <p className="text-[13.5px] font-medium">No tools found yet</p>
            <p className="mt-1 text-small text-muted">Kvistcode couldn't look for Claude, Codex or Grok.</p>
            <Button className="mt-4" variant="primary" onClick={detect}>
              <RefreshCw /> Try again
            </Button>
          </div>
        )}
      </div>
      {note && <p className="mt-3 text-caption text-muted">{note}</p>}
      {log && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setDetails((v) => !v)}
            aria-expanded={details}
            className="flex items-center gap-1 rounded-md py-1 text-caption text-muted transition-colors hover:text-fg"
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform duration-150", details && "rotate-90")} />
            {details ? "Hide details" : "Show details"}
          </button>
          {details && <InstallLog text={log} />}
        </div>
      )}
    </>
  );
}

/** What the installer printed, as plain text that follows the newest line. */
function InstallLog({ text }: { text: string }) {
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={box}
      className="selectable mt-1 max-h-[200px] overflow-auto rounded-lg border border-line bg-code p-3 font-mono text-meta leading-relaxed text-muted"
    >
      {text}
    </pre>
  );
}

/** The footer button of the tools step: install what's ticked, then carry on once one tool is ready. */
function ProvidersNext({ onNext }: { onNext: () => void }) {
  const providers = useApp((s) => s.providers);
  const runs = useInstalls((s) => s.runs);
  const unticked = useInstalls((s) => s.unticked);
  const selected = selectedTools(providers, runs, unticked);
  const states = providers.map((p) => rowState(p, runs[p.provider]));
  const action = primaryAction(states, selected.length);
  const moveOn = moveOnAction(states, action);
  return (
    <div className="flex min-w-0 items-center gap-3">
      {action.reason && <p className="min-w-0 text-right text-caption leading-snug text-muted">{action.reason}</p>}
      {moveOn && (
        <Button variant="ghost" onClick={onNext}>
          {moveOn.label}
        </Button>
      )}
      <Button
        variant="primary"
        disabled={action.disabled}
        onClick={() => (action.kind === "install" ? void useInstalls.getState().start(selected) : onNext())}
      >
        {action.kind === "install" ? (
          <>
            <Download /> {action.label}
          </>
        ) : (
          <>
            {action.label} <ArrowRight />
          </>
        )}
      </Button>
    </div>
  );
}

function AccountsStep() {
  const accounts = useApp((s) => s.accounts);
  const providers = useApp((s) => s.providers);
  const installed = useInstalls((s) => s.installed);
  const runs = useInstalls((s) => s.runs);
  const [adding, setAdding] = useState(false);
  // Tools that finished installing a moment ago get one quiet sign-in check: a status from
  // before the install (tool missing) says nothing about existing sign-ins.
  const [checked, setChecked] = useState<string[]>([]);
  const asked = useRef(new Set<string>());
  const candidates = signInOffers(installed, providers, accounts, runs);
  useEffect(() => {
    for (const a of candidates) {
      if (asked.current.has(a.id)) continue;
      asked.current.add(a.id);
      void api
        .checkAccount(a.id)
        .then((u) => useApp.getState().upsertAccount(u))
        .catch(() => {})
        .finally(() => setChecked((c) => [...c, a.id]));
    }
  }, [candidates]);
  const checking = candidates.filter((a) => !checked.includes(a.id));
  const offers = candidates.filter((a) => !checking.includes(a));
  const shown = offeredFirst(accounts, candidates);
  const signedIn = accounts.filter((a) => a.status?.loggedIn).length;

  return (
    <>
      <StepHeader
        title="Sign in once, switch in one click"
        description={
          offers.length > 0
            ? "Sign in to the tool you just installed, so your first agent can start."
            : accounts.length === 0
              ? "Add the login your agents will use: Claude, ChatGPT (Codex) or Grok."
              : "Kvistcode found sign-ins already on this computer. Add more accounts (a second Claude Max, a work ChatGPT) and run agents on all of them at once."
        }
      />
      {checking.length > 0 && offers.length === 0 && (
        <p className="mb-3 text-small text-muted">Checking if you're already signed in…</p>
      )}
      {offers.length > 0 && (
        <div className="mb-3 space-y-2 rounded-xl border border-accent/30 bg-accent/[0.06] p-3 edge">
          {offers.map((a, i) => (
            <div key={a.id} className="flex items-center gap-3.5">
              <ProviderGlyph provider={a.provider} size="lg" />
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium">{PROVIDERS[a.provider].name} is installed</div>
                <div className="text-caption text-muted">
                  Sign in to use it. A window opens, and then your browser for the login.
                </div>
              </div>
              <Button
                variant={i === 0 ? "primary" : "secondary"}
                autoFocus={i === 0}
                onClick={() => void startLogin(a)}
              >
                <LogIn /> Sign in to {PROVIDERS[a.provider].name}
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-line bg-card edge">
        {accounts.length > 0 && (
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-small text-muted">
              <span className="text-fg tabular">{signedIn}</span> of {accounts.length} signed in
            </span>
            <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
              <UserPlus /> Add account
            </Button>
          </div>
        )}
        <div className="max-h-[300px] divide-y divide-line overflow-y-auto">
          {shown.map((a) => (
            <AccountRow key={a.id} account={a} compact />
          ))}
          {accounts.length === 0 && (
            <div className="flex flex-col items-center px-4 py-8 text-center">
              <p className="text-[13.5px] font-medium">No accounts yet</p>
              <p className="mt-1 text-small text-muted">Nothing is signed in on this computer so far.</p>
              <Button variant="primary" className="mt-4" onClick={() => setAdding(true)}>
                <UserPlus /> Add account
              </Button>
            </div>
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
        title="Attention, not babysitting"
        description="Kvistcode pings you when an agent needs approval, finishes, or hits an error, and stays quiet otherwise."
      />
      <div className="space-y-2.5">
        <PrefCard
          icon={<Volume2 />}
          title="Sounds"
          description="Short metallic cues, designed for Kvistcode."
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
            <span className="w-9 text-caption text-muted tabular">{Math.round(volume * 100)}%</span>
            <div className="ml-auto flex gap-1">
              {(["permission", "done", "error"] as const).map((r) => (
                <Button
                  key={r}
                  size="xs"
                  variant="ghost"
                  disabled={!s.enabled}
                  onClick={() =>
                    void api
                      .previewSound(r)
                      .catch((e) => toast.error("Couldn't play the sound", { description: errorMessage(e) }))
                  }
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
          icon={<BellOff />}
          title="Smart mute"
          description="No alerts for the agent you're already looking at."
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
          title="Give each agent its own copy"
          description="Each agent works in its own copy of the project, so parallel agents don't edit each other's files."
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
          <div className="text-caption text-muted">{description}</div>
        </div>
        {control}
      </div>
      {children}
    </div>
  );
}

function DoneStep({
  onFinish,
  finishing,
  onAddAccount,
}: {
  onFinish: () => void;
  finishing: boolean;
  onAddAccount: () => void;
}) {
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
      {signedIn === 0 && (
        <div className="mt-4 flex w-full max-w-[420px] items-center gap-3 rounded-xl border border-warn/30 bg-warn/[0.06] px-4 py-3 text-left">
          <p className="min-w-0 flex-1 text-small leading-snug text-warn">
            No account is signed in yet. Claude, Codex and Grok agents need one to start.
          </p>
          <Button size="sm" variant="secondary" onClick={onAddAccount}>
            Add account
          </Button>
        </div>
      )}
      <ProjectsGlimpse />
      <Button
        variant="primary"
        size="lg"
        className="mt-8 min-w-[200px]"
        onClick={onFinish}
        disabled={finishing}
        autoFocus
      >
        <Rocket /> Launch Kvistcode
      </Button>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl border border-line bg-card px-4 py-3 edge">
      <div className="text-[20px] font-semibold tracking-tight tabular">{value}</div>
      <div className="text-meta text-muted">{label}</div>
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
  if (failed) return null;
  if (found && found.length === 0) {
    return (
      <div className="mt-4 flex w-full max-w-[420px] items-start gap-2 rounded-xl border border-line bg-card px-4 py-3 text-left text-small edge">
        <FolderGit2 className="mt-px h-4 w-4 shrink-0 text-steel" />
        <span className="text-muted">
          No projects found on this computer yet. You can pick any folder when you start an agent.
        </span>
      </div>
    );
  }
  return (
    <div className="mt-4 w-full max-w-[420px] rounded-xl border border-line bg-card px-4 py-3 text-left edge">
      <div className="flex items-center gap-2 text-small">
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
                className="inline-flex h-6 max-w-[160px] items-center rounded-full border border-line bg-base/60 px-2.5 text-meta text-muted"
              >
                <span className="truncate">{basename(p)}</span>
              </span>
            ))
          : ["w-20", "w-24", "w-16"].map((w) => <span key={w} className={cn("skeleton h-6 rounded-full", w)} />)}
        {found && found.length > 6 && (
          <span className="inline-flex h-6 items-center px-1 text-meta text-steel">+{found.length - 6} more</span>
        )}
      </div>
      <p className="mt-2 text-meta text-steel">Pick any of them when you start an agent.</p>
    </div>
  );
}
