import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { formatTokens } from "@/lib/format";
import { HELPER_EFFORTS, HELPER_MODELS } from "@/lib/modelSetup";
import type { OutputFilterStats, Settings, TokenSaverOptions } from "@/lib/types";
import { useApp } from "@/store/app";
import { MoreRows } from "./Disclosure";
import { SettingGroup, SettingRow } from "./SettingRow";
import { saveSettingsPatch } from "./settingsErrors";

const SIZES = [150_000, 200_000, 250_000, 300_000, 400_000, 500_000];
const COMPACT_PERCENTS = [60, 70, 80, 90];
const OUTPUT_LIMITS = [8_000, 12_000, 20_000, 30_000, 60_000];

/** Applies the "Save tokens" preset (shared by Settings and the Usage insights). */
export async function applyTokenSaver(): Promise<boolean> {
  try {
    const saved = await api.applyTokenSaver();
    await useApp.getState().setSettings(saved);
    toast.success("Saving tokens", {
      description:
        "Claude agents summarize at 250k tokens, tidy noisy command output, keep long output in a file, run their helpers on Sonnet and answer concisely; new Claude agents start at medium effort. Running agents pick this up when they next restart.",
    });
    return true;
  } catch (e) {
    toast.error("Couldn't apply the preset", { description: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/** About 3.5 characters per token. */
const tokensOf = (chars: number) => Math.round(chars / 3.5);

/** "Save tokens" group on the General page. */
export function TokenSavingSettings({ settings }: { settings: Settings }) {
  const value = settings.autoCompactWindow;
  const opts = settings.tokenSaver;
  const patch = (next: Partial<TokenSaverOptions>) =>
    void saveSettingsPatch({ tokenSaver: { ...opts, ...next } }, (message) =>
      toast.error("Couldn't save settings", { description: message }),
    );
  const options = [
    { value: "auto", label: "Claude's default (off)" },
    ...[...new Set([...SIZES, ...(value && !SIZES.includes(value) ? [value] : [])])]
      .sort((a, b) => a - b)
      .map((n) => ({ value: String(n), label: `${Math.round(n / 1000)}k tokens` })),
  ];
  const limit = opts.bashOutputMaxChars;
  const limitOptions = [
    { value: "auto", label: "Claude's default (30k)" },
    ...[...new Set([...OUTPUT_LIMITS, ...(limit && !OUTPUT_LIMITS.includes(limit) ? [limit] : [])])]
      .sort((a, b) => a - b)
      .map((n) => ({ value: String(n), label: `${Math.round(n / 1000)}k characters` })),
  ];

  const [stats, setStats] = useState<OutputFilterStats | null>(null);
  useEffect(() => {
    if (!opts.outputFilter) return;
    let live = true;
    void api
      .outputFilterStats()
      .then((s) => live && setStats(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [opts.outputFilter]);
  const saved = stats && stats.before > stats.after ? tokensOf(stats.before - stats.after) : 0;

  return (
    <SettingGroup title="Save tokens">
      <SettingRow
        title="Save tokens preset"
        description="One click: summarize at 250k tokens, helpers on Sonnet, tidy command output, a 12k output limit, concise replies, and new Claude agents start at medium effort. It never changes the model you chose for an agent, or your budgets."
      >
        <Button size="sm" variant="secondary" onClick={() => void applyTokenSaver()}>
          Apply preset
        </Button>
      </SettingRow>
      <SettingRow
        title="Summarize conversations at"
        description="Claude agents only: Claude Code summarizes mid-turn at a fixed size. Every step an agent takes re-reads its whole conversation, so a shorter one uses far fewer tokens. Claude agents on 1M-token models otherwise grow to several hundred thousand before they summarize. Applies to Claude agents as they start."
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
        title="Compact when the context is full"
        description="Between turns, once an agent's context reaches this share of its window, Kvistcode compacts it for you (the same as typing /compact) and leaves a note in the conversation. Works for every agent that can compact, and only once until usage drops again. Off by default."
      >
        <Select
          aria-label="Compact when the context is full"
          className="h-8 w-[170px]"
          value={settings.autoCompactPercent == null ? "off" : String(settings.autoCompactPercent)}
          onValueChange={(v) =>
            void saveSettingsPatch({ autoCompactPercent: v === "off" ? null : Number(v) }, (message) =>
              toast.error("Couldn't save settings", { description: message }),
            )
          }
          options={[
            { value: "off", label: "Off" },
            ...[
              ...new Set([
                ...COMPACT_PERCENTS,
                ...(settings.autoCompactPercent && !COMPACT_PERCENTS.includes(settings.autoCompactPercent)
                  ? [settings.autoCompactPercent]
                  : []),
              ]),
            ]
              .sort((a, b) => a - b)
              .map((n) => ({ value: String(n), label: `${n}% full` })),
          ]}
        />
      </SettingRow>
      <SettingRow
        title="Helper agents use"
        description="Claude splits work into helper agents, each with its own conversation and its own usage. In one measured install, four in five tool calls came from helpers. Running them on a smaller model saves usage and rarely changes the result. This applies even when an agent asks for another model for a helper. Running Claude agents get it for their next helper. To choose for one agent, use Helpers in its message box."
      >
        <Select
          aria-label="Helper agents use"
          className="h-8 w-[170px]"
          value={opts.subagentModel ?? "same"}
          onValueChange={(v) => patch({ subagentModel: v === "same" ? null : v })}
          options={HELPER_MODELS}
        />
      </SettingRow>
      <SettingRow
        title="Helper effort"
        description="How hard helper agents think. Lower is faster and uses less of your limits; most helper work (searching, reading, small edits) does fine at Low or Medium. Like the model, this applies even when an agent asks for another effort for a helper."
      >
        <Select
          aria-label="Helper effort"
          className="h-8 w-[170px]"
          value={opts.subagentEffort ?? "auto"}
          onValueChange={(v) => patch({ subagentEffort: v === "auto" ? null : v })}
          options={HELPER_EFFORTS}
        />
      </SettingRow>
      <MoreRows label="More options">
        <SettingRow
          title="Tidy build and test output"
          description={
            saved > 0
              ? `Removes colors, progress spam and long runs of passing-test or "Compiling" lines before an agent reads them. Errors, warnings and failures always stay. So far about ${formatTokens(saved)} tokens saved over ${stats?.calls} commands. Never touches file contents or search results.`
              : 'Removes colors, progress spam and long runs of passing-test or "Compiling" lines before an agent reads them. Errors, warnings and failures always stay. Never touches file contents or search results. Helps most in build- and test-heavy projects.'
          }
        >
          <Switch
            checked={opts.outputFilter}
            onCheckedChange={(v) => patch({ outputFilter: v })}
            aria-label="Tidy build and test output"
          />
        </SettingRow>
        <SettingRow
          title="Longest command output an agent reads"
          description="Longer output is kept in a file with a short preview, and the agent reads the parts it needs. Everything an agent reads is re-read on every later step, so a 30k-character dump costs far more than its size. Applies to Claude agents as they start."
        >
          <Select
            aria-label="Longest command output an agent reads"
            className="h-8 w-[190px]"
            value={limit == null ? "auto" : String(limit)}
            onValueChange={(v) => patch({ bashOutputMaxChars: v === "auto" ? null : Number(v) })}
            options={limitOptions}
          />
        </SettingRow>
      </MoreRows>
    </SettingGroup>
  );
}
