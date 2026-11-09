import type { CompanionInfo } from "./types";

export interface CompanionGroup {
  group: string;
  items: CompanionInfo[];
}

/**
 * The list under its section headings. Sections and tools keep the order the core sends them in
 * (so a row doesn't jump when it gets installed); a section appears once, where its first tool is.
 */
export function groupCompanions(list: CompanionInfo[]): CompanionGroup[] {
  const out: CompanionGroup[] = [];
  for (const item of list) {
    const found = out.find((g) => g.group === item.group);
    if (found) found.items.push(item);
    else out.push({ group: item.group, items: [item] });
  }
  return out;
}

/** Recommended tools that aren't installed yet. */
export function missingRecommended(list: CompanionInfo[]): CompanionInfo[] {
  return list.filter((c) => c.recommended && !c.installed);
}

/** "Installed · v2.45.2" / "Not installed". */
export function companionStatus(c: CompanionInfo): string {
  if (!c.installed) return "Not installed";
  return c.version ? `Installed · v${c.version}` : "Installed";
}

/** What the confirm window says about the install: the manager, and that a password may be asked for. */
export function installExplanation(c: CompanionInfo): string {
  const via = c.manager ? ` with ${c.manager}` : "";
  return `Kvistcode will install ${c.name}${via} by running the command below. It may ask for your computer's password in the window that opens.`;
}

/**
 * winget's "nothing to do" exits: 0x8A150061 (package already installed) and 0x8A15002B (no
 * applicable upgrade). Windows reports them as a signed or unsigned number, so both are compared.
 */
const WINGET_NOTHING_TO_DO = [0x8a150061, 0x8a15002b];

export function isWingetNothingToDo(manager: string | null, code: number | null): boolean {
  return manager === "winget" && code !== null && WINGET_NOTHING_TO_DO.includes(code >>> 0);
}

/** Package lists on Linux go stale; "can't find the package" is then fixed by updating them first. */
export function failureHint(manager: string | null): string | null {
  if (manager === "apt" || manager === "pacman" || manager === "zypper" || manager === "dnf") {
    return "If it says it can't find the package, update your package list first (for example: sudo apt update) and try again.";
  }
  return null;
}

export type CompanionOutcome =
  | { kind: "stopped" }
  | { kind: "ready" }
  | { kind: "not-visible"; description: string }
  | { kind: "failed"; description: string };

/** What to tell the person once a companion install's terminal ended, given the list as checked just after. */
export function companionOutcome(
  c: CompanionInfo | undefined,
  manager: string | null,
  code: number | null,
): CompanionOutcome {
  if (code === 130 || code === 143) return { kind: "stopped" };
  const nothingToDo = isWingetNothingToDo(manager, code);
  if (code === 0 || nothingToDo) {
    if (c?.installed) return { kind: "ready" };
    return {
      kind: "not-visible",
      description: nothingToDo
        ? "winget says it is already installed. If it still shows as not installed, restart Kvistcode so it can see it."
        : "If it still shows as not installed, check again in a minute, or restart Kvistcode.",
    };
  }
  const hint = failureHint(manager);
  return {
    kind: "failed",
    description: ["See the terminal for details, then try again.", hint].filter(Boolean).join(" "),
  };
}
