import type { Account } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ProviderMark } from "./ProviderGlyph";

export function initials(name: string): string {
  const parts = name.replace(/[()]/g, "").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function AccountAvatar({
  account,
  size = 24,
  className,
  showProvider = true,
  compact = false,
}: {
  account: Pick<Account, "name" | "color" | "provider"> & { status?: Account["status"] };
  size?: number;
  className?: string;
  showProvider?: boolean;
  /** Single-letter initial, for dense stacks. */
  compact?: boolean;
}) {
  const loggedOut = account.status ? !account.status.loggedIn : false;
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center rounded-full", className)}
      style={{ width: size, height: size }}
    >
      <span
        className="flex h-full w-full items-center justify-center rounded-full font-semibold tracking-tight text-fg"
        style={{
          fontSize: Math.max(8, size * (compact ? 0.42 : 0.36)),
          background: `radial-gradient(circle at 30% 25%, color-mix(in srgb, ${account.color} 35%, var(--bg-3)), var(--bg-2))`,
          boxShadow: `inset 0 0 0 1px var(--border), 0 0 0 1.5px ${account.color}, 0 0 0 3px var(--bg-1)`,
          opacity: loggedOut ? 0.55 : 1,
        }}
      >
        {compact ? initials(account.name)[0] : initials(account.name)}
      </span>
      {showProvider && size >= 20 && (
        <span
          className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full border border-line bg-panel"
          style={{
            width: Math.max(11, size * 0.46),
            height: Math.max(11, size * 0.46),
            color:
              account.provider === "claude"
                ? "var(--claude)"
                : account.provider === "codex"
                  ? "var(--openai)"
                  : "var(--grok)",
          }}
        >
          <ProviderMark provider={account.provider} size={Math.max(7, size * 0.3)} />
        </span>
      )}
    </span>
  );
}
