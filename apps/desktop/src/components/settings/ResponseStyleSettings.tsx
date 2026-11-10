import { toast } from "sonner";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { LANGUAGES } from "@/lib/languages";
import type { ResponseStyle, Settings } from "@/lib/types";
import { SettingGroup, SettingRow } from "./SettingRow";
import { saveSettingsPatch } from "./settingsErrors";

/** The select's stand-in for "no language chosen" (an item can't have an empty value). */
const MATCH = "match";

const RESPONSE_STYLES: { value: ResponseStyle; label: string; description: string }[] = [
  {
    value: "concise",
    label: "Concise",
    description:
      "The outcome first, then only what you need to decide, verify or act on. Logs, diffs and long listings stay out of the reply; agents say where to look and offer to expand.",
  },
  {
    value: "balanced",
    label: "Balanced",
    description:
      "The outcome first, then a short account of what changed, how it was checked and what is left, with the reasoning behind non-obvious choices.",
  },
  {
    value: "detailed",
    label: "Detailed",
    description:
      "A structured, skimmable write-up: what was done and why, how it was verified, open risks and next steps.",
  },
];

/** "Agent replies" group in Settings → New agents. */
export function ResponseStyleSettings({ settings }: { settings: Settings }) {
  const style = settings.responseStyle ?? "concise";
  return (
    <SettingGroup title="Agent replies">
      <SettingRow
        stack
        title="How agents report"
        description={
          <>
            {RESPONSE_STYLES.find((o) => o.value === style)?.description}{" "}
            <span className="mt-1 block">
              This shapes how agents write their replies; it doesn&rsquo;t limit the work they do. It applies to new
              agents, and to existing ones the next time their session resumes.
            </span>
          </>
        }
      >
        <Segmented
          aria-label="How agents report"
          value={style}
          onChange={(v) =>
            void saveSettingsPatch({ responseStyle: v }, (message) =>
              toast.error("Couldn't save settings", { description: message }),
            )
          }
          className="w-full"
          options={RESPONSE_STYLES.map((o) => ({ value: o.value, label: o.label }))}
        />
      </SettingRow>
      <SettingRow
        title="Reply language"
        description="The language agents and the voice assistant reply in. “Match what I write” leaves it to them: they answer in the language you write or speak. Code, commands and file names stay as they are. Applies like the style above."
        htmlFor="reply-language"
      >
        <Select
          id="reply-language"
          aria-label="Reply language"
          className="h-8 w-[200px]"
          value={settings.defaultLanguage || MATCH}
          onValueChange={(v) =>
            void saveSettingsPatch({ defaultLanguage: v === MATCH ? "" : v }, (message) =>
              toast.error("Couldn't save settings", { description: message }),
            )
          }
          options={[
            { value: MATCH, label: "Match what I write" },
            ...LANGUAGES.map((l) => ({ value: l, label: l })),
          ]}
        />
      </SettingRow>
    </SettingGroup>
  );
}
