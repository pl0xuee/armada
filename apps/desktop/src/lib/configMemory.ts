// Which composer options Armada remembers (mirrors crates/armada-core/src/config_memory.rs).
import type { ConfigOption, CustomAgent, Provider } from "./types";
import { identityFor } from "./identity";

const SAFETY_IDS = new Set([
  "mode",
  "approval",
  "approvalpolicy",
  "approval_policy",
  "sandbox",
  "sandboxmode",
  "sandbox_mode",
  "permission",
  "permissions",
  "permissionmode",
  "permission_mode",
]);
const SAFETY_CATEGORIES = new Set(["mode", "approval", "sandbox", "permission", "permissions"]);
const BYPASS_VALUES = new Set(["bypasspermissions", "never", "danger-full-access", "dangerfullaccess", "yolo", "dontask", "acceptedits"]);
const BYPASS_FRAGMENTS = ["bypass", "danger", "yolo", "full-access", "full_access", "fullaccess", "dont_ask", "dont-ask"];
const isBypass = (v: string) => {
  const l = v.toLowerCase();
  return BYPASS_VALUES.has(l) || BYPASS_FRAGMENTS.some((f) => l.includes(f));
};

/** Permission/sandbox options are never remembered: the mode is a per-agent choice. */
export function isRememberableOption(option: ConfigOption): boolean {
  const id = option.id.toLowerCase();
  if (SAFETY_IDS.has(id) || id.includes("sandbox") || id.includes("approval") || id.includes("permission") || id.includes("bypass")) return false;
  if (option.category && SAFETY_CATEGORIES.has(option.category.toLowerCase())) return false;
  return !option.options.some((c) => isBypass(c.value));
}

/** The key remembered defaults are stored under for a provider identity. */
export function configDefaultsKey(provider: Provider, customAgentId?: string | null): string {
  return provider === "custom" && customAgentId ? `custom:${customAgentId}` : provider;
}

export interface RememberedGroup {
  key: string;
  label: string;
  entries: { id: string; value: string }[];
}

/** Remembered defaults as display groups, named by provider (or custom agent). */
export function rememberedGroups(
  defaults: Record<string, Record<string, string>>,
  customAgents: CustomAgent[] | undefined,
): RememberedGroup[] {
  return Object.entries(defaults)
    .map(([key, values]) => {
      const custom = key.startsWith("custom:");
      const provider = (custom ? "custom" : key) as Provider;
      let label: string;
      try {
        label = identityFor(provider, custom ? key.slice(7) : null, customAgents).short;
      } catch {
        label = key;
      }
      return {
        key,
        label,
        entries: Object.entries(values)
          .map(([id, value]) => ({ id, value }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    })
    .filter((g) => g.entries.length > 0)
    .sort((a, b) => a.label.localeCompare(b.label));
}
