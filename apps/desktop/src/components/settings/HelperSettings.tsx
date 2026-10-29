import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { CUSTOM_ACCOUNT_ID, PROVIDERS } from "@/lib/providers";
import type { BusySend, HelperDefaults, Settings } from "@/lib/types";
import { useApp } from "@/store/app";
import { SettingGroup, SettingRow } from "./SettingRow";
import { saveSettingsPatch } from "./settingsErrors";

const SAME = "same";

const BUSY_SEND: { value: BusySend; label: string; description: string }[] = [
  { value: "ask", label: "Ask", description: "A small chooser appears each time: queue it, or start a helper." },
  { value: "queue", label: "Queue it", description: "The message runs right after the current turn." },
  {
    value: "helper",
    label: "Start a helper",
    description: "A helper agent starts now, works on a copy of the agent's files in parallel, and merges back.",
  },
];

function save(patch: Partial<Settings>) {
  return saveSettingsPatch(patch, (message) => toast.error("Couldn't save settings", { description: message }));
}

/** "Helper agents" group in Settings → Behavior. */
export function HelperSettings({ settings }: { settings: Settings }) {
  const accounts = useApp((s) => s.accounts);
  const d = settings.helperDefaults;
  const customAgents = useMemo(() => settings.customAgents.filter((c) => c.enabled), [settings.customAgents]);
  const value = d.customAgentId ? `custom:${d.customAgentId}` : d.accountId ? `acc:${d.accountId}` : SAME;
  const [model, setModel] = useState(d.model ?? "");
  useEffect(() => setModel(d.model ?? ""), [d.model]);

  const setDefaults = (next: HelperDefaults) => void save({ helperDefaults: next });
  const pick = (v: string) => {
    if (v === SAME) return setDefaults({ provider: null, accountId: null, customAgentId: null, model: null });
    if (v.startsWith("custom:"))
      return setDefaults({
        provider: "custom",
        accountId: CUSTOM_ACCOUNT_ID,
        customAgentId: v.slice(7),
        model: null,
      });
    const acc = accounts.find((a) => a.id === v.slice(4));
    if (acc) setDefaults({ provider: acc.provider, accountId: acc.id, customAgentId: null, model: d.model });
  };
  const commitModel = () => {
    const next = model.trim() || null;
    if (next !== d.model) setDefaults({ ...d, model: next });
  };

  const options = [
    { value: SAME, label: "Same as the main agent" },
    ...accounts
      .filter((a) => a.provider !== "custom")
      .map((a) => ({ value: `acc:${a.id}`, label: `${PROVIDERS[a.provider].short} · ${a.name}` })),
    ...customAgents.map((c) => ({ value: `custom:${c.id}`, label: c.name })),
  ];
  // A saved account that no longer exists still shows, instead of a blank select.
  if (!options.some((o) => o.value === value)) options.push({ value, label: "Unavailable account" });

  return (
    <SettingGroup title="Helper agents">
      <SettingRow
        stack
        title="When an agent is busy and you send a message"
        description={BUSY_SEND.find((o) => o.value === (settings.busySend ?? "ask"))?.description}
      >
        <Segmented
          aria-label="When an agent is busy and you send a message"
          value={settings.busySend ?? "ask"}
          onChange={(v) => void save({ busySend: v })}
          className="w-full"
          options={BUSY_SEND.map((o) => ({ value: o.value, label: o.label }))}
        />
      </SettingRow>
      <SettingRow
        title="Helpers use"
        description="Which account runs new helpers. They always work on a copy of the main agent's files."
      >
        <Select
          aria-label="Helpers use"
          className="h-8 w-[240px]"
          value={value}
          onValueChange={pick}
          options={options}
        />
      </SettingRow>
      {value !== SAME && !d.customAgentId && (
        <SettingRow title="Helper model" description="Leave empty for the account's default model." htmlFor="helper-model">
          <Input
            id="helper-model"
            value={model}
            placeholder="Default"
            onChange={(e) => setModel(e.target.value)}
            onBlur={commitModel}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
            className="h-8 w-[240px] font-mono text-[12px]"
            spellCheck={false}
          />
        </SettingRow>
      )}
    </SettingGroup>
  );
}
