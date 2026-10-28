import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({
  text,
  className,
  label = "Copy",
  ariaLabel,
}: {
  text: string;
  className?: string;
  /** Visible text; empty for an icon-only button (then `ariaLabel` names it). */
  label?: string;
  ariaLabel?: string;
}) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const name = ariaLabel ?? (label || "Copy");
  return (
    <button
      type="button"
      aria-label={done ? "Copied" : name}
      title={label ? undefined : done ? "Copied" : name}
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyText(text)) {
          setDone(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setDone(false), 1400);
        } else {
          toast.error("Couldn't copy to the clipboard");
        }
      }}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-steel transition-colors hover:bg-raised hover:text-fg",
        className,
      )}
    >
      {done ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
      {label ? (
        <span>{done ? "Copied" : label}</span>
      ) : (
        <span className="sr-only" role="status">
          {done ? "Copied" : ""}
        </span>
      )}
    </button>
  );
}
