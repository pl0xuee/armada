import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** One labelled setting: title + description on the left, control on the right. */
export function SettingRow({
  title,
  description,
  children,
  htmlFor,
  className,
  stack,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
  /** Put the control under the text instead of beside it. */
  stack?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex gap-4 px-4 py-3.5",
        stack ? "flex-col items-stretch" : "items-center justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-[13px] font-medium text-fg">
          {title}
        </label>
        {description && <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{description}</p>}
      </div>
      <div className={cn("flex shrink-0 items-center gap-2", stack && "w-full")}>{children}</div>
    </div>
  );
}

/** A card grouping several SettingRows with hairline dividers. */
export function SettingGroup({
  title,
  description,
  children,
  right,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-2.5", className)}>
      {(title || right) && (
        <div className="flex items-end justify-between gap-4 px-0.5">
          <div>
            {title && <h3 className="text-[13px] font-semibold tracking-tight text-fg">{title}</h3>}
            {description && <p className="mt-0.5 text-[12px] text-muted">{description}</p>}
          </div>
          {right}
        </div>
      )}
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card edge">{children}</div>
    </section>
  );
}

export function SectionHeader({
  title,
  description,
  right,
}: {
  title: ReactNode;
  description?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-fg">{title}</h2>
        {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
      </div>
      {right}
    </div>
  );
}
