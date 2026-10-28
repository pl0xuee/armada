import type { AgentStatus } from "@/lib/types";
import { STATUS } from "@/lib/providers";
import { cn } from "@/lib/utils";

export function StatusDot({ status, size = 8, className }: { status: AgentStatus; size?: number; className?: string }) {
  const meta = STATUS[status];
  const pulse = status === "working" || status === "needs_permission" || status === "starting";
  return (
    <span
      role="img"
      aria-label={meta.label}
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      {pulse && (
        <span
          className="absolute inset-0 rounded-full animate-pulse-ring"
          style={{ background: meta.colorVar }}
          aria-hidden
        />
      )}
      <span
        className={cn("relative rounded-full", status === "starting" && "animate-breathe")}
        style={{
          width: size,
          height: size,
          background: status === "stopped" ? "transparent" : meta.colorVar,
          border: status === "stopped" ? `1.5px solid ${meta.colorVar}` : undefined,
          boxShadow: pulse ? `0 0 8px 1px color-mix(in srgb, ${meta.colorVar} 70%, transparent)` : undefined,
        }}
      />
    </span>
  );
}

export function StatusPill({ status, className }: { status: AgentStatus; className?: string }) {
  const meta = STATUS[status];
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11.5px] font-medium",
        className,
      )}
      style={{
        color: status === "idle" || status === "stopped" ? "var(--text-2)" : meta.colorVar,
        borderColor: `color-mix(in srgb, ${meta.colorVar} 30%, var(--border))`,
        background: `color-mix(in srgb, ${meta.colorVar} 9%, transparent)`,
      }}
    >
      <StatusDot status={status} size={6} />
      {meta.label}
    </span>
  );
}
