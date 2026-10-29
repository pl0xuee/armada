import { TriangleAlert } from "lucide-react";
import { pluralize } from "@/lib/format";
import type { LfsInfo } from "@/lib/types";
import { isMac } from "@/lib/utils";
import { CopyButton } from "../CopyButton";

export const LFS_BLOCK_REASON =
  "Git LFS isn't installed, so Armada can't tell which asset files really changed. Install it, then refresh.";

/** Install command for the current platform (plus the one-time `git lfs install`). */
export function lfsInstallHint(): { label: string; command: string; note?: string; alt?: string } {
  const ua = typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`;
  if (isMac) return { label: "macOS", command: "brew install git-lfs && git lfs install" };
  if (/Win/i.test(ua))
    return { label: "Windows", command: "git lfs install", note: "Git LFS is included with Git for Windows." };
  return {
    label: "Linux",
    command: "sudo apt install git-lfs && git lfs install",
    alt: "On Arch: sudo pacman -S git-lfs, then git lfs install.",
  };
}

export function LfsNotice({ lfs, blocking }: { lfs: LfsInfo | null; blocking: boolean }) {
  if (!lfs) return null;
  if (!lfs.toolMissing) {
    if (lfs.hidden <= 0) return null;
    return (
      <p role="note" className="shrink-0 border-b border-line bg-panel px-5 py-1.5 text-[11.5px] text-steel">
        {lfs.hidden.toLocaleString()} unchanged LFS {lfs.hidden === 1 ? "file" : "files"} hidden
      </p>
    );
  }
  const hint = lfsInstallHint();
  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-2.5 border-b border-warn/30 bg-warn/[0.08] px-5 py-2.5 text-[12.5px]"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-fg">This repository stores assets with Git LFS, but Git LFS isn't installed.</p>
        <p className="mt-0.5 text-muted">
          {lfs.hidden > 0 &&
            `${pluralize(lfs.hidden, "asset file")} that only looked changed ${lfs.hidden === 1 ? "is" : "are"} hidden. `}
          {blocking
            ? "Commit and merge are paused until it's installed: asset files changed."
            : "Install it before committing any asset changes."}
        </p>
        <div className="mt-1.5 flex items-start gap-2 text-muted">
          <span className="shrink-0 pt-0.5">{hint.note ?? `Install on ${hint.label}:`}</span>
          <code className="selectable min-w-0 whitespace-pre-wrap break-words rounded-md border border-line bg-base/60 px-2 py-0.5 font-mono text-[11.5px] text-fg">
            {hint.command}
          </code>
          <CopyButton text={hint.command} ariaLabel="Copy install command" />
          {hint.alt && <span className="pt-0.5 text-[11.5px] text-steel">{hint.alt}</span>}
        </div>
      </div>
    </div>
  );
}
