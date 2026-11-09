import { CircleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { capText, parseCap } from "@/lib/budget";
import { parseTokenCap, parseTurnCap, tokenCapText, turnCapText } from "@/lib/budgetMeters";
import type { BudgetAction, BudgetCap, Settings } from "@/lib/types";
import { basename } from "@/lib/utils";
import { useApp } from "@/store/app";
import { saveSettingsPatch } from "./settingsErrors";
import { SectionHeader, SettingGroup, SettingRow } from "./SettingRow";
import { useCommitOnUnmount } from "./useCommitOnUnmount";

const ACTIONS: { value: BudgetAction; label: string; description: string }[] = [
  {
    value: "notify",
    label: "Alert only",
    description: "You get a notice in the conversation and a desktop notification; agents keep working.",
  },
  {
    value: "pause",
    label: "Pause at the end of the turn",
    description:
      "At 80% you get a quiet heads-up. At 100% the agent finishes the step it is on (a running tool is never cut off), then waits for you in Needs you: raise the limit, continue once, or stop. Queued messages stay queued.",
  },
];

type Unit = "usd" | "tokens" | "turns";

const PLACEHOLDER = { usd: "No cost limit", tokens: "No token limit", turns: "No turn limit" } as const;
const PARSE = { usd: parseCap, tokens: parseTokenCap, turns: parseTurnCap } as const;
const SHOW = { usd: capText, tokens: tokenCapText, turns: turnCapText } as const;

/** A limit field that saves on blur or Enter; empty means no limit. Dollars, tokens or turns. */
function CapField({
  id,
  label,
  unit,
  value,
  onSave,
  width = 140,
}: {
  id: string;
  label: string;
  unit: Unit;
  value: number | null;
  onSave: (value: number | null) => Promise<boolean>;
  width?: number;
}) {
  const parse = PARSE[unit];
  const show = SHOW[unit];
  const [text, setText] = useState(show(value));
  const [error, setError] = useState<string>();
  // Follow the stored value when it changes elsewhere (the phone, another window).
  useEffect(() => setText(show(value)), [value, show]);

  const commit = () => {
    const parsed = parse(text);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    setError(undefined);
    if (parsed.value === value) {
      setText(show(value));
      return;
    }
    void onSave(parsed.value).then((ok) => {
      if (!ok) setText(show(value));
    });
  };
  useCommitOnUnmount(() => {
    const parsed = parse(text);
    if (!parsed.error && parsed.value !== value) void onSave(parsed.value);
  });

  return (
    <div className="flex flex-col items-end">
      <div className="relative">
        {unit === "usd" && (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-body text-steel">$</span>
        )}
        <Input
          id={id}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          inputMode={unit === "usd" ? "decimal" : unit === "turns" ? "numeric" : "text"}
          placeholder={PLACEHOLDER[unit]}
          className={`h-8 tabular ${unit === "usd" ? "pl-6" : ""}`}
          style={{ width }}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(undefined);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        {unit !== "usd" && text !== "" && (
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-micro text-steel">
            {unit}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-1.5 flex max-w-[260px] items-start gap-1.5 text-right text-meta text-err">
          <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

/** Cost, token and turn fields for one scope, side by side. */
function CapPair({
  idBase,
  what,
  usd,
  tokens,
  turns,
  onUsd,
  onTokens,
  onTurns,
}: {
  idBase: string;
  what: string;
  usd: number | null;
  tokens: number | null;
  turns: number | null;
  onUsd: (v: number | null) => Promise<boolean>;
  onTokens: (v: number | null) => Promise<boolean>;
  onTurns: (v: number | null) => Promise<boolean>;
}) {
  return (
    <div className="flex flex-wrap items-start justify-end gap-2">
      <CapField id={`${idBase}-usd`} label={`${what} in dollars`} unit="usd" value={usd} onSave={onUsd} width={120} />
      <CapField
        id={`${idBase}-tokens`}
        label={`${what} in tokens`}
        unit="tokens"
        value={tokens}
        onSave={onTokens}
        width={150}
      />
      <CapField
        id={`${idBase}-turns`}
        label={`${what} in turns`}
        unit="turns"
        value={turns}
        onSave={onTurns}
        width={130}
      />
    </div>
  );
}

export function BudgetsSection({ settings }: { settings: Settings }) {
  const save = (patch: Partial<Settings>) =>
    saveSettingsPatch(patch, (message) => toast.error("Couldn't save budgets", { description: message }));
  const action = ACTIONS.find((a) => a.value === settings.budgetAction) ?? ACTIONS[0]!;
  const projects = settings.projectBudgets;
  const off =
    settings.dailyBudgetUsd == null &&
    settings.agentBudgetUsd == null &&
    settings.dailyBudgetTokens == null &&
    settings.agentBudgetTokens == null &&
    settings.dailyBudgetTurns == null &&
    settings.agentBudgetTurns == null &&
    Object.keys(projects).length === 0;

  const setProject = (path: string, cap: BudgetCap) => {
    const next = { ...projects };
    if (cap.usd == null && cap.tokens == null && cap.turns == null) delete next[path];
    else next[path] = cap;
    return save({ projectBudgets: next });
  };

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Budgets"
        description="Optional limits, in dollars, tokens and/or turns. Leave a field empty for no limit."
      />
      <SettingGroup>
        <SettingRow
          title="Per day, all agents"
          description="Everything the agents spend since midnight, your local time. Warns at 80% and again when reached."
          htmlFor="budget-daily-usd"
        >
          <CapPair
            idBase="budget-daily"
            what="Daily limit"
            usd={settings.dailyBudgetUsd}
            tokens={settings.dailyBudgetTokens}
            turns={settings.dailyBudgetTurns}
            onUsd={(v) => save({ dailyBudgetUsd: v })}
            onTokens={(v) => save({ dailyBudgetTokens: v })}
            onTurns={(v) => save({ dailyBudgetTurns: v })}
          />
        </SettingRow>
        <SettingRow
          title="Per agent"
          description="What one agent (one task) may spend in total. A limit raised for a single agent from Needs you wins over this."
          htmlFor="budget-agent-usd"
        >
          <CapPair
            idBase="budget-agent"
            what="Limit per agent"
            usd={settings.agentBudgetUsd}
            tokens={settings.agentBudgetTokens}
            turns={settings.agentBudgetTurns}
            onUsd={(v) => save({ agentBudgetUsd: v })}
            onTokens={(v) => save({ agentBudgetTokens: v })}
            onTurns={(v) => save({ agentBudgetTurns: v })}
          />
        </SettingRow>
        <ProjectLimits projects={projects} onChange={setProject} />
        <SettingRow stack title="When a limit is reached" description={action.description}>
          <Segmented
            aria-label="When a limit is reached"
            value={settings.budgetAction}
            onChange={(v) => void save({ budgetAction: v })}
            className="w-full"
            options={ACTIONS.map((a) => ({ value: a.value, label: a.label }))}
          />
        </SettingRow>
      </SettingGroup>
      <div className="space-y-1.5 text-caption leading-relaxed text-muted">
        <p>
          {off
            ? "No limit is set, so nothing is watched. "
            : "Alerts use your notification and sound settings; a pause also sends the Budget alert to Slack, Discord and webhooks. "}
          Limits are checked as usage is reported, and a pause waits for the end of the turn, so one long turn can
          overshoot.
        </p>
        <p>
          <span className="text-fg/80">Dollars</span> are what each runtime reports, as in the Usage view. API-key
          accounts are billed that amount; subscription plans (Claude Max, ChatGPT Pro, …) show an API-equivalent figure
          and are not billed per token; local models report no cost at all. <span className="text-fg/80">Tokens</span>{" "}
          are counted for every agent, so use a token limit for those. <span className="text-fg/80">Turns</span> count
          every completed reply to a prompt (a failed or cancelled turn doesn&rsquo;t count) and are the simplest limit
          for a subscription. A restarted or reset agent never lowers today&rsquo;s total.
        </p>
      </div>
    </div>
  );
}

/** Limits on everything the agents of one project spend. */
function ProjectLimits({
  projects,
  onChange,
}: {
  projects: Record<string, BudgetCap>;
  onChange: (path: string, cap: BudgetCap) => Promise<boolean>;
}) {
  const agents = useApp((s) => s.agents);
  const recent = useApp((s) => s.settings?.recentProjects);
  const known = useMemo(() => {
    const set = new Set<string>(recent ?? []);
    for (const a of Object.values(agents)) set.add(a.projectPath);
    return [...set].filter((p) => p && !(p in projects)).sort((a, b) => basename(a).localeCompare(basename(b)));
  }, [agents, recent, projects]);
  const paths = Object.keys(projects).sort((a, b) => basename(a).localeCompare(basename(b)));

  return (
    <SettingRow
      stack
      title="Per project"
      description="What all the agents of one project (past and present) may use together. Warns at 80% and again when reached."
    >
      <div className="w-full space-y-2.5">
        {paths.map((path) => {
          const cap = projects[path]!;
          const id = `budget-project-${path}`;
          return (
            <div key={path} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1 basis-[160px] pt-1.5">
                <p className="truncate text-body font-medium">{basename(path)}</p>
                <p className="truncate font-mono text-micro text-steel" title={path}>
                  {path}
                </p>
              </div>
              <div className="flex items-start gap-1.5">
                <CapPair
                  idBase={id}
                  what={`${basename(path)} limit`}
                  usd={cap.usd}
                  tokens={cap.tokens}
                  turns={cap.turns ?? null}
                  onUsd={(usd) => onChange(path, { ...cap, usd })}
                  onTokens={(tokens) => onChange(path, { ...cap, tokens })}
                  onTurns={(turns) => onChange(path, { ...cap, turns })}
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove the limit for ${basename(path)}`}
                  onClick={() => void onChange(path, { usd: null, tokens: null, turns: null })}
                >
                  <X />
                </Button>
              </div>
            </div>
          );
        })}
        {known.length > 0 && (
          <Select
            aria-label="Add a project limit"
            value=""
            placeholder="Add a project limit…"
            className="h-8 max-w-[320px]"
            // A limit needs a value: start with a token-free, cost-free row the user then fills in.
            onValueChange={(path) => void onChange(path, { usd: 10, tokens: null, turns: null })}
            options={known.map((p) => ({ value: p, label: basename(p), description: p }))}
          />
        )}
        {paths.length === 0 && known.length === 0 && (
          <p className="text-caption text-steel">Start an agent in a project folder to set a limit for it.</p>
        )}
      </div>
    </SettingRow>
  );
}
