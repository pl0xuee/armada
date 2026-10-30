import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { capText, parseCap } from "@/lib/budget";
import type { BudgetAction, Settings } from "@/lib/types";
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
    label: "Pause agents",
    description:
      "Also interrupts the running turn: the agent that reached its cap, or every running agent when the daily cap is reached. Queued messages stay queued, and nothing auto-resumes until you continue.",
  },
];

/** A dollar amount field that saves on blur or Enter; empty means no cap. */
function CapField({
  id,
  label,
  value,
  onSave,
}: {
  id: string;
  label: string;
  value: number | null;
  onSave: (value: number | null) => Promise<boolean>;
}) {
  const [text, setText] = useState(capText(value));
  const [error, setError] = useState<string>();
  // Follow the stored value when it changes elsewhere (the phone, another window).
  useEffect(() => setText(capText(value)), [value]);

  const commit = () => {
    const parsed = parseCap(text);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    setError(undefined);
    if (parsed.value === value) {
      setText(capText(value));
      return;
    }
    void onSave(parsed.value).then((ok) => {
      if (!ok) setText(capText(value));
    });
  };
  useCommitOnUnmount(() => {
    const parsed = parseCap(text);
    if (!parsed.error && parsed.value !== value) void onSave(parsed.value);
  });

  return (
    <div className="flex flex-col items-end">
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-steel">$</span>
        <Input
          id={id}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          inputMode="decimal"
          placeholder="No cap"
          className="h-8 w-[140px] pl-6 tabular"
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
      </div>
      {error && (
        <p role="alert" className="mt-1.5 flex items-start gap-1.5 text-[11.5px] text-err">
          <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

export function BudgetsSection({ settings }: { settings: Settings }) {
  const save = (patch: Partial<Settings>) =>
    saveSettingsPatch(patch, (message) => toast.error("Couldn't save budgets", { description: message }));
  const action = ACTIONS.find((a) => a.value === settings.budgetAction) ?? ACTIONS[0]!;
  const off = settings.dailyBudgetUsd == null && settings.agentBudgetUsd == null;

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Budgets"
        description="Spending caps and alerts, from the cost each agent reports. Leave a field empty for no cap."
      />
      <SettingGroup>
        <SettingRow
          title="Daily budget"
          description="Total across all agents since midnight, your local time. Warns at 80% and again when reached."
          htmlFor="budget-daily"
        >
          <CapField
            id="budget-daily"
            label="Daily budget in dollars"
            value={settings.dailyBudgetUsd}
            onSave={(v) => save({ dailyBudgetUsd: v })}
          />
        </SettingRow>
        <SettingRow
          title="Budget per agent"
          description="What one agent (one task) may spend in total. Warns at 80% and again when reached."
          htmlFor="budget-agent"
        >
          <CapField
            id="budget-agent"
            label="Budget per agent in dollars"
            value={settings.agentBudgetUsd}
            onSave={(v) => save({ agentBudgetUsd: v })}
          />
        </SettingRow>
        <SettingRow stack title="When a budget is reached" description={action.description}>
          <Segmented
            aria-label="When a budget is reached"
            value={settings.budgetAction}
            onChange={(v) => void save({ budgetAction: v })}
            className="w-full"
            options={ACTIONS.map((a) => ({ value: a.value, label: a.label }))}
          />
        </SettingRow>
      </SettingGroup>
      <p className="px-0.5 text-[12px] leading-relaxed text-muted">
        {off
          ? "No budget is set, so nothing is watched. "
          : "Alerts use your notification and sound settings for errors. "}
        Costs are what each runtime reports, as in the Usage view; subscription plans show an API-equivalent price. A
        restarted or reset agent never lowers today&rsquo;s total.
      </p>
    </div>
  );
}
