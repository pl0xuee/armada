import type { ReactNode } from "react";
import { reconnectNow } from "@/lib/controller";
import { useDelayed } from "@/lib/hooks";
import { cn } from "@/lib/cn";
import { useStore, type Connection } from "@/lib/store";
import { Icon, Spinner } from "./Icon";

/** Sticky, translucent app header that respects the notch / status bar. */
export function TopBar({ left, children, right, below }: { left?: ReactNode; children?: ReactNode; right?: ReactNode; below?: ReactNode }) {
  return (
    <header className="chrome sticky top-0 z-30 border-b border-line/70 pt-[var(--safe-top)]">
      <div className="mx-auto flex h-14 w-full max-w-[860px] items-center gap-1 pr-[max(6px,var(--safe-right))] pl-[max(6px,var(--safe-left))]">
        {left}
        <div className="flex min-w-0 flex-1 items-center">{children}</div>
        {right}
      </div>
      {below}
      <ConnectionBanner />
    </header>
  );
}

const PILL: Record<Connection, { label: string; color: string }> = {
  live: { label: "Live", color: "var(--ok)" },
  connecting: { label: "Connecting", color: "var(--steel)" },
  reconnecting: { label: "Reconnecting", color: "var(--warn)" },
  offline: { label: "Offline", color: "var(--err)" },
};

export function ConnectionPill({ className }: { className?: string }) {
  const connection = useStore((s) => s.connection);
  const meta = PILL[connection];
  return (
    <span
      role="status"
      aria-label={`Connection: ${meta.label}`}
      className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium", className)}
      style={{
        color: connection === "live" ? "var(--text-2)" : meta.color,
        borderColor: `color-mix(in srgb, ${meta.color} 28%, var(--border))`,
        background: `color-mix(in srgb, ${meta.color} 8%, transparent)`,
      }}
    >
      {connection === "live" ? (
        <span className="relative inline-flex h-1.5 w-1.5">
          <span className="animate-pulse-ring absolute inset-0 rounded-full" style={{ background: meta.color }} />
          <span className="relative h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
        </span>
      ) : connection === "offline" ? (
        <Icon name="wifiOff" size={13} strokeWidth={2} />
      ) : (
        <Spinner size={11} />
      )}
      <span className={cn(connection === "live" && "max-[359px]:sr-only")}>{meta.label}</span>
    </span>
  );
}

/** Explains a lost connection once it has lasted long enough to matter. */
function ConnectionBanner() {
  const connection = useStore((s) => s.connection);
  const ready = useStore((s) => s.stateStatus === "ready");
  const down = ready && (connection === "reconnecting" || connection === "offline");
  const show = useDelayed(down, connection === "offline" ? 0 : 2_500);
  if (!show || !down) return null;
  const offline = connection === "offline";
  return (
    <div
      className={cn(
        "animate-fade flex items-center gap-2.5 border-t px-safe py-2 text-[13px]",
        offline ? "border-err/25 bg-err/10 text-[#ffb3ba]" : "border-warn/20 bg-warn/8 text-[#f8d494]",
      )}
      role="status"
    >
      <span className="mx-auto flex w-full max-w-[828px] items-center gap-2.5">
        {offline ? <Icon name="wifiOff" size={16} className="shrink-0" /> : <Spinner size={14} className="shrink-0" />}
        <span className="min-w-0 flex-1 leading-snug">
          {offline ? "You're offline. Showing the last known state." : "Connection lost. Reconnecting to Armada…"}
        </span>
        {!offline && (
          <button type="button" onClick={reconnectNow} className="press -my-2 h-9 shrink-0 rounded-lg px-2 font-semibold text-warn">
            Retry now
          </button>
        )}
      </span>
    </div>
  );
}
