import { cn } from "@/lib/utils";

/** Armada brand mark: a chevron "A" hull, machined in ice-blue. */
export function AppMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={cn("shrink-0", className)} aria-hidden>
      <defs>
        <linearGradient id="armada-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#BDEBFF" />
          <stop offset="0.55" stopColor="#4FC3F7" />
          <stop offset="1" stopColor="#2385B3" />
        </linearGradient>
      </defs>
      <path d="M16 3 29 28h-6.4L16 14.6 9.4 28H3z" fill="url(#armada-g)" />
      <path d="M11.5 23.5h9" stroke="var(--bg-0)" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
