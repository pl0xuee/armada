import { Check } from "lucide-react";
import type { Settings } from "@/lib/types";
import { cn } from "@/lib/utils";

type ThemeId = Settings["theme"];

export const THEMES: { id: ThemeId; name: string; description: string }[] = [
  { id: "gunmetal", name: "Gunmetal", description: "Cool steel. The default." },
  { id: "carbon", name: "Carbon", description: "Neutral, deepest blacks" },
  { id: "titanium", name: "Titanium", description: "Light, brushed metal" },
];

export function ThemeCard({ id, active, onSelect }: { id: ThemeId; active: boolean; onSelect: () => void }) {
  const meta = THEMES.find((t) => t.id === id)!;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "group rounded-xl border p-2 text-left transition-[border-color,transform,box-shadow] duration-150 hover:-translate-y-0.5 active:scale-[0.98]",
        active
          ? "border-accent/70 shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_16%,transparent)]"
          : "border-line hover:border-line-strong",
      )}
    >
      {/* Mini app preview */}
      <div
        data-theme={id}
        className="relative flex h-[92px] overflow-hidden rounded-lg bg-base shadow-[inset_0_0_0_1px_var(--border)]"
        aria-hidden
      >
        <div className="flex w-5 flex-col items-center gap-1.5 border-r border-line bg-panel pt-2">
          <span className="h-2 w-2 rounded-[3px] bg-accent" />
          <span className="h-2 w-2 rounded-[3px] bg-line" />
          <span className="h-2 w-2 rounded-[3px] bg-line" />
        </div>
        <div className="flex w-[34%] flex-col gap-1 border-r border-line bg-panel p-1.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={cn("flex items-center gap-1 rounded-[4px] px-1 py-[3px]", i === 0 && "bg-card")}>
              <span
                className={cn("h-1.5 w-1.5 rounded-full", i === 0 ? "bg-accent" : i === 1 ? "bg-warn" : "bg-steel")}
              />
              <span className="h-1 flex-1 rounded-full bg-steel/45" />
            </div>
          ))}
        </div>
        <div className="flex flex-1 flex-col gap-1.5 p-2">
          <span className="h-1.5 w-2/3 rounded-full bg-fg/80" />
          <span className="h-1 w-full rounded-full bg-steel/40" />
          <span className="h-1 w-5/6 rounded-full bg-steel/40" />
          <div className="mt-1 rounded-[5px] bg-card p-1.5 shadow-[inset_0_0_0_1px_var(--border)]">
            <span className="block h-1 w-1/2 rounded-full bg-steel/50" />
          </div>
          <div className="mt-auto flex justify-end">
            <span className="h-2.5 w-7 rounded-[4px] bg-accent" />
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between px-1 pb-0.5 pt-2.5">
        <div>
          <div className="text-[13px] font-medium text-fg">{meta.name}</div>
          <div className="text-[11.5px] text-muted">{meta.description}</div>
        </div>
        <span
          className={cn(
            "flex h-[18px] w-[18px] items-center justify-center rounded-full border transition-colors",
            active ? "border-accent bg-accent" : "border-line-strong",
          )}
        >
          {active && <Check className="h-3 w-3 text-accent-fg" strokeWidth={3} />}
        </span>
      </div>
    </button>
  );
}
