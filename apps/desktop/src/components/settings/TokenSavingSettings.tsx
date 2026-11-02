import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import type { Settings } from "@/lib/types";
import { useApp } from "@/store/app";
import { SettingGroup, SettingRow } from "./SettingRow";
import { saveSettingsPatch } from "./settingsErrors";

const SIZES = [150_000, 200_000, 250_000, 300_000, 400_000, 500_000];

/** Applies the "Save tokens" preset (shared by Settings and the Usage insights). */
export async function applyTokenSaver(): Promise<boolean> {
  try {
    const saved = await api.applyTokenSaver();
    await useApp.getState().setSettings(saved);
    toast.success("Saving tokens", {
      description:
        "Claude agents summarize at 250k tokens, replies are concise and new Claude agents start at medium effort. Running agents pick up the size when they next restart.",
    });
    return true;
  } catch (e) {
    toast.error("Couldn't apply the preset", { description: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/** "Save tokens" group in Settings → Behavior. */
export function TokenSavingSettings({ settings }: { settings: Settings }) {
  const value = settings.autoCompactWindow;
  const options = [
    { value: "auto", label: "Claude's default" },
    ...[...new Set([...SIZES, ...(value && !SIZES.includes(value) ? [value] : [])])]
      .sort((a, b) => a - b)
      .map((n) => ({ value: String(n), label: `${Math.round(n / 1000)}k tokens` })),
  ];
  return (
    <SettingGroup title="Save tokens">
      <SettingRow
        title="Summarize conversations at"
        description="Every step an agent takes re-reads its whole conversation, so a shorter one uses far fewer tokens. Claude agents on 1M-token models otherwise grow to several hundred thousand before they summarize. Applies to Claude agents as they start."
      >
        <Select
          aria-label="Summarize conversations at"
          className="h-8 w-[170px]"
          value={value == null ? "auto" : String(value)}
          onValueChange={(v) =>
            void saveSettingsPatch({ autoCompactWindow: v === "auto" ? null : Number(v) }, (message) =>
              toast.error("Couldn't save settings", { description: message }),
            )
          }
          options={options}
        />
      </SettingRow>
      <SettingRow
        title="Save tokens preset"
        description="One click: summarize at 250k tokens, concise replies, and new Claude agents start at medium effort. It never changes your model or your budgets."
      >
        <Button size="sm" variant="secondary" onClick={() => void applyTokenSaver()}>
          Apply preset
        </Button>
      </SettingRow>
    </SettingGroup>
  );
}
