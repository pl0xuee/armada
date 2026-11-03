import type { ReactNode } from "react";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The body of a view that has nothing to show yet: one plain line on what the page is for, and the one obvious next
 * step as a button. Centred in whatever room the page has, so every view looks the same when it is empty.
 */
export function EmptyPane({
  icon,
  title,
  description,
  actionLabel,
  actionIcon,
  onAction,
  className,
}: {
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  actionLabel?: string;
  actionIcon?: ReactNode;
  onAction?: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col justify-center overflow-y-auto", className)}>
      <EmptyState
        icon={icon}
        title={title}
        description={description}
        action={
          actionLabel && onAction ? (
            <Button variant="primary" onClick={onAction}>
              {actionIcon} {actionLabel}
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
