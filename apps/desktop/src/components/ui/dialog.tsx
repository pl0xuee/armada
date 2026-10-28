import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  children,
  className,
  title,
  description,
  hideClose,
  onOpenAutoFocus,
  overlayClassName,
}: {
  children: ReactNode;
  className?: string;
  title: ReactNode;
  description?: ReactNode;
  hideClose?: boolean;
  onOpenAutoFocus?: (e: Event) => void;
  overlayClassName?: string;
}) {
  return (
    <D.Portal>
      <D.Overlay
        className={cn("anim-fade fixed inset-0 z-50 bg-[var(--scrim)] backdrop-blur-[3px]", overlayClassName)}
      />
      <D.Content
        onOpenAutoFocus={onOpenAutoFocus}
        className={cn(
          "anim-dialog fixed left-1/2 top-1/2 z-50 flex max-h-[min(88vh,820px)] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-[0_24px_80px_-12px_rgba(0,0,0,0.6)] edge-strong focus:outline-none",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pb-1 pt-4">
          <div className="min-w-0">
            <D.Title className="text-[15px] font-semibold tracking-tight text-fg">{title}</D.Title>
            {description ? (
              <D.Description className="mt-0.5 text-[12.5px] text-muted">{description}</D.Description>
            ) : (
              <D.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</D.Description>
            )}
          </div>
          {!hideClose && (
            <D.Close
              aria-label="Close"
              className="-mr-1.5 -mt-0.5 rounded-md p-1.5 text-steel transition-colors hover:bg-raised hover:text-fg"
            >
              <X className="h-4 w-4" />
            </D.Close>
          )}
        </div>
        {children}
      </D.Content>
    </D.Portal>
  );
}

export function DialogBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-3", className)}>{children}</div>;
}

export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-end gap-2 border-t border-line bg-panel/60 px-5 py-3", className)}>
      {children}
    </div>
  );
}
