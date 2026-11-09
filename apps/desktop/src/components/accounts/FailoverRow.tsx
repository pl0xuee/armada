import { toast } from "sonner";
import { FieldError } from "@/components/settings/FieldError";
import { saveSettingsPatch } from "@/components/settings/settingsErrors";
import { Segmented } from "@/components/ui/segmented";
import type { Settings } from "@/lib/types";
import { useApp } from "@/store/app";

export const FAILOVER: { value: Settings["failover"]; label: string; description: string }[] = [
  { value: "off", label: "Off", description: "The agent stops with an error. You decide what to do next." },
  {
    value: "ask",
    label: "Ask me",
    description: "Kvistcode shows a banner on the agent offering your other signed-in accounts of the same provider.",
  },
  {
    value: "auto",
    label: "Switch automatically",
    description: "Kvistcode moves the agent to another signed-in account of the same provider and keeps going.",
  },
];

/** The rate-limit failover setting (same one as Settings, Behavior), one line at the top of Accounts. */
export function FailoverRow() {
  const failover = useApp((s) => s.settings?.failover);
  if (!failover) return null;
  return (
    <div className="mb-4 rounded-xl border border-line bg-card/60 px-4 py-2.5 @2xl:mb-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-body font-medium text-fg">If an account hits its limit</span>
        <Segmented
          size="sm"
          aria-label="If an account hits its limit"
          value={failover}
          onChange={(v) =>
            void saveSettingsPatch({ failover: v }, (message) =>
              toast.error("Couldn't save settings", { description: message }),
            )
          }
          options={FAILOVER.map((f) => ({ value: f.value, label: f.value === "off" ? "Do nothing" : f.label }))}
        />
      </div>
      <p className="mt-1 text-caption text-muted">{FAILOVER.find((f) => f.value === failover)?.description}</p>
      <FieldError field="failover" />
    </div>
  );
}
