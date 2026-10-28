import { createPortal } from "react-dom";
import { dismissToast, holdToast } from "@/lib/controller";
import { cn } from "@/lib/cn";
import { navigate } from "@/lib/router";
import { useStore, type Toast, type ToastTone } from "@/lib/store";
import { Icon, type IconName } from "./Icon";

const TONE: Record<ToastTone, { icon: IconName; color: string }> = {
  info: { icon: "info", color: "var(--accent)" },
  ok: { icon: "check", color: "var(--ok)" },
  warn: { icon: "shield", color: "var(--warn)" },
  err: { icon: "alertCircle", color: "var(--err)" },
};

function ToastCard({ toast }: { toast: Toast }) {
  const tone = TONE[toast.tone];
  const actionable = !!toast.agentId;
  const open = () => {
    if (!toast.agentId) return;
    dismissToast(toast.id);
    navigate({ name: "agent", agentId: toast.agentId });
  };
  return (
    <div
      role={toast.tone === "err" || toast.tone === "warn" ? "alert" : "status"}
      className="animate-toast pointer-events-auto flex w-full items-stretch overflow-hidden rounded-2xl border bg-card/95 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.7)] backdrop-blur-xl"
      style={{ borderColor: `color-mix(in srgb, ${tone.color} 28%, var(--border))` }}
      onPointerDown={() => holdToast(toast.id, true)}
      onPointerUp={() => holdToast(toast.id, false)}
      onPointerCancel={() => holdToast(toast.id, false)}
    >
      <button
        type="button"
        disabled={!actionable}
        onClick={open}
        className={cn("flex min-w-0 flex-1 items-start gap-3 py-3 pl-3.5 text-left", actionable && "press-row")}
      >
        <span
          className="mt-px inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]"
          style={{ color: tone.color, background: `color-mix(in srgb, ${tone.color} 14%, transparent)` }}
        >
          <Icon name={tone.icon} size={17} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] leading-5 font-semibold text-fg">{toast.title}</span>
          {toast.body && <span className="line-clamp-2 mt-0.5 block text-[13px] leading-[18px] text-muted">{toast.body}</span>}
          {actionable && toast.reason === "permission" && (
            <span className="mt-1 inline-block text-[12.5px] font-semibold text-warn">Review</span>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={() => dismissToast(toast.id)}
        aria-label="Dismiss"
        className="press inline-flex w-11 shrink-0 items-start justify-center pt-3.5 text-steel active:text-fg"
      >
        <Icon name="x" size={17} />
      </button>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return createPortal(
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] mx-auto flex w-full max-w-[560px] flex-col gap-2 px-3 pt-[calc(var(--safe-top)+8px)]"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>,
    document.body,
  );
}
