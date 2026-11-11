import * as A from "@radix-ui/react-alert-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Spinner } from "./misc";
import { useReturnFocus } from "./returnFocus";

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
        <A.Overlay className="anim-fade fixed inset-0 z-[60] bg-[var(--scrim)]" />
        <ConfirmContent
          className={cn(
            "anim-dialog fixed left-1/2 top-1/2 z-[60] flex max-h-[calc(100dvh-16px)] w-[min(440px,calc(100vw-16px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-[0_24px_80px_-12px_rgba(0,0,0,0.6)] edge-strong focus:outline-none",
          )}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 px-5 pb-1 pt-4">
            <A.Title className="min-w-0 text-[15px] font-semibold tracking-tight text-fg">{title}</A.Title>
            <A.Cancel
              aria-label="Close"
              className="-mr-1.5 -mt-0.5 rounded-md p-1.5 text-steel transition-colors hover:bg-raised hover:text-fg"
            >
              <X className="h-4 w-4" />
            </A.Cancel>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
            {description ? (
              <A.Description className="text-body leading-relaxed text-muted">{description}</A.Description>
            ) : (
              <A.Description className="sr-only">{typeof title === "string" ? title : "Confirm"}</A.Description>
            )}
            {children && <div className="mt-3">{children}</div>}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-panel/60 px-5 py-3">
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
              {busy && <Spinner className="h-3.5 w-3.5" />}
              {confirmLabel}
            </Button>
          </div>
        </ConfirmContent>
      </A.Portal>
    </A.Root>
  );
}

/** A.Content that returns focus to wherever it was when the dialog opened. */
function ConfirmContent({ className, children }: { className?: string; children: ReactNode }) {
  const focus = useReturnFocus();
  return (
    <A.Content className={className} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
      {children}
    </A.Content>
  );
}
