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

/** The values of an option that is only On or Off: shown as a switch, not a list to pick from. */
export function onOff(o: ConfigOption): { on: string; off: string } | null {
  if (o.options.length !== 2) return null;
  const on = o.options.find((c) => c.name.trim().toLowerCase() === "on");
  const off = o.options.find((c) => c.name.trim().toLowerCase() === "off");
  return on && off ? { on: on.value, off: off.value } : null;
}

export function applyConfigValue<T extends { id: string; currentValue: string }>(options: T[], optionId: string, value: string): T[] {
  return options.map((o) => (o.id === optionId ? { ...o, currentValue: value } : o));
}
