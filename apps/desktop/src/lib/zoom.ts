import { api } from "@/lib/api";
import { useApp } from "@/store/app";

export const MIN_SCALE = 75;
export const MAX_SCALE = 150;
export const DEFAULT_SCALE = 100;
export const SCALE_STEP = 5;
export const SCALE_PRESETS = [90, 100, 110, 125, 150];

export function clampScale(percent: number): number {
  if (!Number.isFinite(percent)) return DEFAULT_SCALE;
  const stepped = Math.round(percent / SCALE_STEP) * SCALE_STEP;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, stepped));
}

/** Persists a new interface scale (the app applies it when the setting changes). */
export function setInterfaceScale(percent: number): Promise<void> {
  return useApp.getState().patchSettings({ interfaceScale: clampScale(percent) });
}

/** One step bigger (+1) or smaller (-1); 0 resets. */
export function stepInterfaceScale(dir: -1 | 0 | 1): void {
  const current = useApp.getState().settings?.interfaceScale ?? DEFAULT_SCALE;
  const next = dir === 0 ? DEFAULT_SCALE : clampScale(current + dir * SCALE_STEP);
  if (next !== current) void setInterfaceScale(next).catch(() => {});
}

export function applyInterfaceScale(percent: number): void {
  void api.setInterfaceZoom(clampScale(percent)).catch(() => {});
}
