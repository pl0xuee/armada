import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";

export function EmptyState({
  icon,
  title,
  body,
  action,
  tone = "steel",
  className,
}: {
  icon: IconName;
  title: string;
  body?: ReactNode;
  action?: { label: string; onClick: () => void };
  tone?: "steel" | "ok" | "accent";
  className?: string;
}) {
  const color = tone === "ok" ? "var(--ok)" : tone === "accent" ? "var(--accent)" : "var(--steel)";
  return (
    <div className={cn("animate-enter flex flex-col items-center px-6 py-16 text-center", className)}>
      <span
        className="mb-5 inline-flex h-16 w-16 items-center justify-center rounded-[20px] border edge-strong"
        style={{
          color,
          borderColor: `color-mix(in srgb, ${color} 25%, var(--border))`,
          background: `linear-gradient(180deg, color-mix(in srgb, ${color} 14%, var(--bg-2)), var(--bg-1))`,
        }}
      >
        <Icon name={icon} size={28} strokeWidth={1.6} />
      </span>
      <h2 className="text-[17px] font-semibold text-fg">{title}</h2>
      {body && <p className="mt-1.5 max-w-[320px] text-[14px] leading-relaxed text-muted">{body}</p>}
      {action && (
        <Button variant="secondary" className="mt-6" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

export function ErrorState({ title, body, onRetry }: { title: string; body: string | null; onRetry: () => void }) {
  return (
    <div className="animate-enter flex flex-col items-center px-6 py-14 text-center" role="alert">
      <span className="mb-5 inline-flex h-16 w-16 items-center justify-center rounded-[20px] border border-err/30 bg-err/10 text-err edge">
        <Icon name="alertCircle" size={28} strokeWidth={1.6} />
      </span>
      <h2 className="text-[17px] font-semibold text-fg">{title}</h2>
      {body && <p className="mt-1.5 max-w-[320px] text-[14px] leading-relaxed text-muted">{body}</p>}
      <Button variant="secondary" icon="refresh" className="mt-6" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
