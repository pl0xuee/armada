import * as A from "@radix-ui/react-alert-dialog";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  onConfirm,
  children,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  children?: ReactNode;
  busy?: boolean;
}) {
  return (
    <A.Root open={open} onOpenChange={onOpenChange}>
      <A.Portal>
        <A.Overlay className="anim-fade fixed inset-0 z-[60] bg-[var(--scrim)] backdrop-blur-[3px]" />
        <A.Content
          className={cn(
            "anim-dialog fixed left-1/2 top-1/2 z-[60] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line-strong bg-card p-5 shadow-[0_24px_80px_-12px_rgba(0,0,0,0.6)] edge-strong focus:outline-none",
          )}
        >
          <A.Title className="text-[15px] font-semibold tracking-tight">{title}</A.Title>
          {description && (
            <A.Description className="mt-1.5 text-[13px] leading-relaxed text-muted">{description}</A.Description>
          )}
          {children && <div className="mt-4">{children}</div>}
          <div className="mt-5 flex justify-end gap-2">
            <A.Cancel asChild>
              <Button variant="ghost">{cancelLabel}</Button>
            </A.Cancel>
            <Button
              variant={danger ? "danger-solid" : "primary"}
              disabled={busy}
              onClick={async (e) => {
                e.preventDefault();
                await onConfirm();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </A.Content>
      </A.Portal>
    </A.Root>
  );
}
