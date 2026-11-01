import { cn } from "@/lib/cn";
import { setResponseStyle } from "@/lib/phoneActions";
import { RESPONSE_STYLES } from "@/lib/responseStyle";
import { useStore } from "@/lib/store";

/**
 * "How agents report" in the phone's settings: concise, balanced or detailed. The same setting as on the computer;
 * it shapes how agents write their replies (new agents, and existing ones the next time their session resumes).
 * Hidden when the server doesn't send it (an older Kvistcode, or a read-only link).
 */
export function ResponseStyleRow() {
  const style = useStore((s) => s.responseStyle);
  if (!style) return null;
  const current = RESPONSE_STYLES.find((o) => o.value === style);
  return (
    <div className="py-3">
      <p id="response-style-label" className="text-[14px] text-muted">
        How agents report
      </p>
      <div role="radiogroup" aria-labelledby="response-style-label" className="mt-2 grid grid-cols-3 gap-1 rounded-xl border border-line bg-panel p-1">
        {RESPONSE_STYLES.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === style}
            onClick={() => void setResponseStyle(o.value)}
            className={cn(
              "press h-10 min-w-0 truncate rounded-lg px-2 text-[13.5px] font-medium",
              o.value === style ? "bg-raised text-fg shadow-[inset_0_0_0_1px_var(--border-strong)]" : "text-muted",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[12.5px] leading-snug text-steel">{current?.description}</p>
    </div>
  );
}
