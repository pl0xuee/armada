import { Lightbulb } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { saveSettingsPatch } from "@/components/settings/settingsErrors";
import { applyTokenSaver } from "@/components/settings/TokenSavingSettings";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { tokenInsights, type Insight, type InsightAction } from "@/lib/tokenInsights";
import type { Agent } from "@/lib/types";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";

const DOT: Record<Insight["severity"], string> = {
  high: "bg-err",
  medium: "bg-warn",
  info: "bg-steel",
};

/** What is using tokens, with one-click fixes. Renders nothing when there is nothing to say. */
export function TokenInsights({ agents }: { agents: Agent[] }) {
  const accounts = useApp((s) => s.accounts);
  const settings = useApp((s) => s.settings);
  const openAgent = useUi((s) => s.openAgent);
  const openSettings = useUi((s) => s.openSettings);
  const insights = useMemo(() => tokenInsights({ agents, accounts, settings }), [agents, accounts, settings]);
  if (!insights.length) return null;

  const run = async (action: InsightAction) => {
    switch (action.kind) {
      case "preset":
        await applyTokenSaver();
        break;
      case "open-agent":
        openAgent(action.agentId);
        break;
      case "open-settings":
        openSettings("toolkit");
        break;
      case "helper-model": {
        const current = useApp.getState().settings?.tokenSaver;
        if (!current) break;
        const saved = await saveSettingsPatch({ tokenSaver: { ...current, subagentModel: action.model } }, (message) =>
          toast.error("Couldn't save settings", { description: message }),
        );
        if (saved) toast.success("Helpers run on Sonnet", { description: "Claude agents pick this up as they start." });
        break;
      }
      case "lower-effort": {
        const results = await Promise.allSettled(
          action.agentIds.map((id) => api.setAgentConfig(id, "effort", "medium")),
        );
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed) toast.error(`Couldn't change effort on ${failed} of ${results.length} agents`);
        else toast.success(`Effort set to medium on ${results.length} ${results.length === 1 ? "agent" : "agents"}`);
        break;
      }
    }
  };

  return (
    <section className="rounded-xl border border-line bg-card edge" aria-label="Token insights">
      <h2 className="flex items-center gap-2 px-4 pb-2 pt-3.5 eyebrow text-steel [&_svg]:h-3.5 [&_svg]:w-3.5">
        <Lightbulb />
        Save tokens
      </h2>
      <ul className="divide-y divide-line/70">
        {insights.map((i) => (
          <li key={i.id} className="flex items-start gap-3 px-4 py-3">
            <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[i.severity]}`} />
            <div className="min-w-0 flex-1">
              <div className="text-body font-medium text-fg">{i.title}</div>
              <p className="mt-0.5 text-caption leading-relaxed text-muted">{i.detail}</p>
            </div>
            {i.action && (
              <Button size="sm" variant="secondary" className="shrink-0" onClick={() => void run(i.action!)}>
                {i.action.label}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
