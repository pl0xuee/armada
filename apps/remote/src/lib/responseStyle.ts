/** "How agents report": the three styles and what each one means (the wording of the desktop's Settings). */
import type { ResponseStyle } from "./types";

export const RESPONSE_STYLES: { value: ResponseStyle; label: string; description: string }[] = [
  { value: "concise", label: "Concise", description: "The outcome first, then only what you need to decide, verify or act on." },
  { value: "balanced", label: "Balanced", description: "The outcome, then a short account of what changed, how it was checked and what is left." },
  { value: "detailed", label: "Detailed", description: "A structured write-up: what was done and why, how it was verified, open risks and next steps." },
];

export const isResponseStyle = (v: unknown): v is ResponseStyle => RESPONSE_STYLES.some((s) => s.value === v);
