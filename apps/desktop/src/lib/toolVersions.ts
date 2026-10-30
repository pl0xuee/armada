// Version maths and display labels for Armada's own copies of the agent tools.
import type { ProviderInfo } from "./types";

/** Numeric parts of a dotted version ("v0.166.0-beta.1" -> [0, 166, 0]); null when there are none. */
function parts(v: string): number[] | null {
  const m = /^\s*v?(\d+(?:\.\d+)*)/.exec(v);
  return m ? m[1].split(".").map(Number) : null;
}

/** Negative / 0 / positive like a sort comparator. Unparsable versions compare equal. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function isNewerVersion(a: string | null, b: string | null): boolean {
  return !!a && !!b && compareVersions(a, b) > 0;
}

/** Armada's copy is newer than the version it was tested with, so there is a way back. */
export function canRollBack(p: ProviderInfo): boolean {
  return p.managed && isNewerVersion(p.managedVersion, p.testedVersion);
}

export type ToolSource = "bundled" | "system" | "none";

export function toolSource(p: ProviderInfo): ToolSource {
  if (p.managed) return "bundled";
  return p.installed ? "system" : "none";
}

export const SOURCE_LABEL: Record<ToolSource, string> = {
  bundled: "Bundled with Armada",
  system: "Using system install",
  none: "Not installed",
};

export type ToolStatusKind = "uptodate" | "update" | "setup" | "missing";

export interface ToolStatus {
  kind: ToolStatusKind;
  label: string;
}

export function toolStatus(p: ProviderInfo): ToolStatus {
  if (!p.installed && !p.managed) return { kind: "missing", label: "Not installed" };
  if (!p.managed) return { kind: "setup", label: "Setting up…" };
  if (p.updateAvailable) {
    return { kind: "update", label: p.latestVersion ? `Update available → ${p.latestVersion}` : "Update available" };
  }
  return { kind: "uptodate", label: "Up to date" };
}

/** The ACP adapter (Claude) is missing or needs updating, so the install button applies even to a system install. */
export function needsAdapter(p: ProviderInfo): boolean {
  return p.installed && p.adapterRequired && !p.adapterInstalled;
}

/** Offer "Install": nothing of Armada's own yet and nothing usable, or the adapter is missing. */
export function canInstall(p: ProviderInfo): boolean {
  return !p.managed && (!p.installed || needsAdapter(p));
}

/** "Installed 0.166.0 · Latest 0.167.0 · Tested 0.166.0", leaving out what isn't known. Claude shows both versions. */
export function versionParts(p: ProviderInfo): string[] {
  const out: string[] = [];
  if (p.provider === "claude") {
    if (p.version) out.push(`Claude Code ${p.version}`);
    if (p.managedVersion) out.push(`Adapter ${p.managedVersion}`);
  } else {
    const v = p.managedVersion ?? p.version;
    if (v) out.push(`Installed ${v}`);
  }
  if (p.latestVersion) out.push(`Latest ${p.latestVersion}`);
  if (p.testedVersion) out.push(`Tested ${p.testedVersion}`);
  return out;
}

export function updateCount(providers: ProviderInfo[]): number {
  return providers.filter((p) => p.managed && p.updateAvailable).length;
}

/** Most recent update check across providers (unix ms), or null if never. */
export function lastChecked(providers: ProviderInfo[]): number | null {
  let max: number | null = null;
  for (const p of providers)
    if (p.updatesCheckedAt != null && (max == null || p.updatesCheckedAt > max)) max = p.updatesCheckedAt;
  return max;
}
