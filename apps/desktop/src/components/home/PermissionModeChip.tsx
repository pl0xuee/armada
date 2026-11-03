import { ShieldCheck, Zap } from "lucide-react";
import { useState } from "react";
import { useApp } from "@/store/app";
import { cn } from "@/lib/utils";
import { Tooltip } from "../ui/tooltip";

export type PermissionMode = "auto" | "ask";

/**
 * Per-launch permission mode, starting from settings.defaultPermissionMode each time the
 * launcher opens (an override isn't remembered, so the default stays the source of truth).
 */
export function usePermissionMode(): [PermissionMode, (m: PermissionMode) => void] {
  const fallback = useApp((s) => s.settings?.defaultPermissionMode ?? "ask");
  const [override, setOverride] = useState<PermissionMode | null>(null);
  return [override ?? fallback, setOverride];
}

/** Plain names for the two modes, shared by the home chip and the New agent dialog. */
export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  ask: "Ask before changes",
  auto: "Run without asking",
};

/** "Ask before changes / Run without asking" toggle for the launch about to happen. `compact` is just the icon. */
export function PermissionModeChip({
  value,
  onChange,
  className,
  compact = false,
}: {
  value: PermissionMode;
  onChange: (m: PermissionMode) => void;
  className?: string;
  compact?: boolean;
}) {
  const auto = value === "auto";
  const isDefault = useApp((s) => (s.settings?.defaultPermissionMode ?? "ask") === value);
  return (
    <Tooltip
      content={
        <span className="block max-w-[260px] leading-snug">
          <span className="font-medium">{PERMISSION_LABEL[value]}.</span>{" "}
          {auto
            ? "Auto means this agent edits files and runs commands without asking you first."
            : "This agent asks you before it edits files or runs commands."}{" "}
          Click to switch for this launch{isDefault ? " (this is your default)" : ""}. The default lives in Settings →
          Behavior.
        </span>
      }
    >
      <button
        type="button"
        role="switch"
        aria-checked={auto}
        aria-label={`${PERMISSION_LABEL[value]}. Click to switch.`}
        onClick={() => onChange(auto ? "ask" : "auto")}
        className={cn(
          "inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-full border text-[11.5px] font-medium transition-colors",
          compact ? "w-7" : "px-2",
          auto
            ? "border-accent/35 bg-accent/10 text-accent hover:bg-accent/15"
            : "border-line-strong bg-raised text-muted hover:text-fg",
          className,
        )}
      >
        {auto ? <Zap className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
        {!compact && PERMISSION_LABEL[value]}
      </button>
    </Tooltip>
  );
}
