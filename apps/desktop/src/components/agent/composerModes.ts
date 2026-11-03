import type { Agent, ConfigOption } from "@/lib/types";
import { PERMISSION_LABEL } from "../home/PermissionModeChip";

/** Which of each provider's own permission values is the same thing as the shared "ask" / "auto" modes. */
const PLAIN_MODE: Partial<Record<Agent["provider"], Record<string, "ask" | "auto">>> = {
  claude: { default: "ask", bypassPermissions: "auto" },
  // Codex's "Auto" (on-request) is what the launcher's "Run without asking" starts it with.
  codex: { untrusted: "ask", "on-request": "auto" },
  local: { untrusted: "ask", "on-request": "auto" },
  grok: { ask: "ask", auto: "auto" },
};

/**
 * The agent's session options with permission choices renamed to the shared plain words
 * ("Ask before changes" / "Run without asking"). The values stay the provider's own; the
 * provider's exact name moves into the hint under the choice.
 */
export function plainConfigOptions(agent: Agent): ConfigOption[] {
  const map = PLAIN_MODE[agent.provider];
  if (!map) return agent.configOptions;
  return agent.configOptions.map((opt) => {
    if (opt.category !== "mode" || (opt.id !== "mode" && opt.id !== "approval")) return opt;
    return {
      ...opt,
      options: opt.options.map((o) => {
        const plain = map[o.value];
        if (!plain || PERMISSION_LABEL[plain] === o.name) return o;
        return {
          ...o,
          name: PERMISSION_LABEL[plain],
          description: o.description ? `${o.description} (“${o.name}”)` : `“${o.name}”`,
        };
      }),
    };
  });
}
