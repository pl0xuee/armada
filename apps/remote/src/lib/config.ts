/** Session options (mode / model / reasoning effort …): whatever each provider advertises. */
import type { ConfigOption } from "./types";

/** Display name of an option's current value (falls back to the raw value). */
export function choiceName(o: ConfigOption): string {
  return o.options.find((c) => c.value === o.currentValue)?.name ?? o.currentValue;
}

/** The options worth showing: ones with at least one choice. */
export function visibleOptions(options: ConfigOption[] | undefined): ConfigOption[] {
  return (options ?? []).filter((o) => Array.isArray(o.options) && o.options.length > 0);
}

export function applyConfigValue<T extends { id: string; currentValue: string }>(options: T[], optionId: string, value: string): T[] {
  return options.map((o) => (o.id === optionId ? { ...o, currentValue: value } : o));
}
