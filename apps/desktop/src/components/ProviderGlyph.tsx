import type { Provider } from "@/lib/types";
import { cn } from "@/lib/utils";
import { monogram } from "@/lib/identity";
import { useIdentity } from "@/hooks/useIdentity";

const SIZES = {
  xs: { box: 16, icon: 10, radius: 5 },
  sm: { box: 20, icon: 12, radius: 6 },
  md: { box: 26, icon: 15, radius: 8 },
  lg: { box: 34, icon: 19, radius: 10 },
  xl: { box: 48, icon: 26, radius: 14 },
} as const;

/** Original monogram marks (not vendor logos), drawn in the provider's identity color. */
export function ProviderMark({
  provider,
  size = 16,
  className,
}: {
  provider: Provider;
  size?: number;
  className?: string;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
  if (provider === "claude") {
    // Open "C" with a small orbiting spark.
    return (
      <svg {...common}>
        <path d="M17.6 7.2A7.5 7.5 0 1 0 17.6 16.8" />
        <circle cx="18.6" cy="12" r="1.5" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (provider === "codex") {
    // Hexagonal "O" ring (⌬-style).
    return (
      <svg {...common}>
        <path d="M12 3.2 19.6 7.6v8.8L12 20.8 4.4 16.4V7.6Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    );
  }
  if (provider === "local") {
    // A chip on a board: the model runs on your own hardware.
    return (
      <svg {...common}>
        <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
        <rect x="9.5" y="9.5" width="5" height="5" rx="0.8" />
        <path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3" />
      </svg>
    );
  }
  if (provider === "custom") {
    // Generic ACP agent: a node joined to two peers.
    return (
      <svg {...common}>
        <circle cx="7" cy="12" r="2.6" />
        <circle cx="17" cy="6.5" r="2.2" />
        <circle cx="17" cy="17.5" r="2.2" />
        <path d="M9.4 10.9 15 7.6M9.4 13.1 15 16.4" />
      </svg>
    );
  }
  // Grok: angular "G".
  return (
    <svg {...common}>
      <path d="M18.4 6.6A7.6 7.6 0 1 0 19.6 13H12.6" />
      <path d="M19.6 13v5.2" />
    </svg>
  );
}

export function ProviderGlyph({
  provider,
  customAgentId,
  size = "sm",
  className,
  title,
}: {
  provider: Provider;
  /** For provider "custom": which user-defined agent, so it shows its own name and color. */
  customAgentId?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
  title?: string;
}) {
  const s = SIZES[size];
  const id = useIdentity(provider, customAgentId);
  const color = id.color;
  return (
    <span
      title={title ?? id.name}
      className={cn("relative inline-flex shrink-0 items-center justify-center border", className)}
      style={{
        width: s.box,
        height: s.box,
        borderRadius: s.radius,
        color,
        background: `linear-gradient(180deg, color-mix(in srgb, ${color} 20%, var(--bg-2)), color-mix(in srgb, ${color} 9%, var(--bg-1)))`,
        borderColor: `color-mix(in srgb, ${color} 32%, var(--border))`,
        boxShadow: "inset 0 1px 0 var(--edge-strong)",
      }}
    >
      {provider === "custom" ? (
        <span className="font-semibold leading-none tracking-tight" style={{ fontSize: Math.round(s.icon * 0.78) }}>
          {size === "xs" || size === "sm" ? monogram(id.name).charAt(0) : monogram(id.name)}
        </span>
      ) : (
        <ProviderMark provider={provider} size={s.icon} />
      )}
    </span>
  );
}
