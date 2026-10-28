import { agentIdentity, statusMeta } from "@/lib/meta";
import { useStore } from "@/lib/store";
import type { Agent, AgentStatus } from "@/lib/types";
import { cn } from "@/lib/cn";

/**
 * Original monogram marks, identical to the desktop app (an open "C" for
 * Claude, a hex "O" for Codex, an angular "G" for Grok); never vendor logos.
 * Custom agents get the first letter of their name.
 */
export function ProviderMark({ provider, size }: { provider: "claude" | "codex" | "grok"; size: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (provider === "claude") {
    return (
      <svg {...common}>
        <path d="M17.6 7.2A7.5 7.5 0 1 0 17.6 16.8" />
        <circle cx="18.6" cy="12" r="1.5" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (provider === "codex") {
    return (
      <svg {...common}>
        <path d="M12 3.2 19.6 7.6v8.8L12 20.8 4.4 16.4V7.6Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M18.4 6.6A7.6 7.6 0 1 0 19.6 13H12.6" />
      <path d="M19.6 13v5.2" />
    </svg>
  );
}

/** Provider identity chip in the provider's color. */
export function ProviderBadge({
  agent,
  size = 40,
  status,
  className,
}: {
  agent: Pick<Agent, "provider" | "customAgentId">;
  size?: number;
  /** Overlay a status dot in the corner. */
  status?: AgentStatus;
  className?: string;
}) {
  const customAgents = useStore((s) => s.customAgents);
  const id = agentIdentity(agent, customAgents);
  const radius = Math.round(size * 0.3);
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      <span
        role="img"
        aria-label={id.name}
        className="inline-flex h-full w-full items-center justify-center border font-semibold select-none"
        style={{
          borderRadius: radius,
          color: id.color,
          fontSize: Math.round(size * 0.42),
          letterSpacing: "-0.02em",
          background: `linear-gradient(180deg, color-mix(in srgb, ${id.color} 18%, var(--bg-2)), color-mix(in srgb, ${id.color} 7%, var(--bg-1)))`,
          borderColor: `color-mix(in srgb, ${id.color} 30%, var(--border))`,
          boxShadow: "inset 0 1px 0 var(--edge-strong)",
        }}
      >
        {id.provider === "custom" ? id.letter : <ProviderMark provider={id.provider} size={Math.round(size * 0.52)} />}
      </span>
      {status && (
        <span
          className="absolute -right-[3px] -bottom-[3px] inline-flex items-center justify-center rounded-full bg-base p-[3px]"
          aria-hidden
        >
          <StatusDot status={status} size={Math.max(8, Math.round(size * 0.24))} />
        </span>
      )}
    </span>
  );
}

export function StatusDot({ status, size = 8, className }: { status: AgentStatus; size?: number; className?: string }) {
  const meta = statusMeta(status);
  const hollow = status === "stopped";
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }} aria-hidden>
      {meta.live && (
        <span className="animate-pulse-ring absolute inset-0 rounded-full" style={{ background: meta.color }} />
      )}
      <span
        className={cn("relative h-full w-full rounded-full", status === "starting" && "animate-breathe")}
        style={{
          background: hollow ? "transparent" : meta.color,
          border: hollow ? `1.5px solid ${meta.color}` : undefined,
          boxShadow: meta.live ? `0 0 8px 1px color-mix(in srgb, ${meta.color} 60%, transparent)` : undefined,
        }}
      />
    </span>
  );
}

export function StatusText({ status, className }: { status: AgentStatus; className?: string }) {
  const meta = statusMeta(status);
  const quiet = status === "idle" || status === "stopped";
  return (
    <span className={cn("font-medium", className)} style={{ color: quiet ? "var(--text-2)" : meta.color }}>
      {meta.label}
    </span>
  );
}

export function AccountDot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: color, boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.25)" }}
      aria-hidden
    />
  );
}
