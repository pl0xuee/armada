import { useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { Icon } from "./Icon";

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      aria-label={state === "ok" ? "Copied" : label}
      onClick={async (e) => {
        e.stopPropagation();
        const ok = await copyText(text);
        setState(ok ? "ok" : "fail");
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 1600);
      }}
      className={cn(
        "press inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg px-2 text-[11.5px] font-medium",
        state === "ok" ? "text-ok" : state === "fail" ? "text-err" : "text-steel active:text-fg",
        className,
      )}
    >
      <Icon name={state === "ok" ? "check" : "copy"} size={14} />
      <span aria-live="polite">{state === "ok" ? "Copied" : state === "fail" ? "Failed" : ""}</span>
    </button>
  );
}
