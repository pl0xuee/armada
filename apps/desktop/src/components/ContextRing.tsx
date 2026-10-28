import { clamp } from "@/lib/utils";

export function ContextRing({
  used,
  size,
  diameter = 64,
  stroke = 6,
  label,
}: {
  used: number;
  size: number;
  diameter?: number;
  stroke?: number;
  label?: string;
}) {
  const ratio = size > 0 ? clamp(used / size, 0, 1) : 0;
  const r = (diameter - stroke) / 2;
  const c = 2 * Math.PI * r;
  const color = ratio > 0.85 ? "var(--err)" : ratio > 0.65 ? "var(--warn)" : "var(--accent)";
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: diameter, height: diameter }}>
      <svg width={diameter} height={diameter} className="-rotate-90" aria-hidden>
        <circle cx={diameter / 2} cy={diameter / 2} r={r} stroke="var(--bg-3)" strokeWidth={stroke} fill="none" />
        <circle
          cx={diameter / 2}
          cy={diameter / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - ratio)}
          style={{
            transition: "stroke-dashoffset 400ms ease",
            filter: `drop-shadow(0 0 4px color-mix(in srgb, ${color} 50%, transparent))`,
          }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[13px] font-semibold tabular">{Math.round(ratio * 100)}%</span>
        {label && <span className="text-[9.5px] uppercase tracking-wider text-steel">{label}</span>}
      </div>
    </div>
  );
}
