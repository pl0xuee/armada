import { cn } from "@/lib/utils";

/** Kvistcode brand mark: a K whose arms branch off the stem (kvist is Norwegian for twig), in ice-blue. */
export function AppMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={cn("shrink-0", className)} aria-hidden>
      <defs>
        <linearGradient id="kvistcode-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#BDEBFF" />
          <stop offset="0.55" stopColor="#4FC3F7" />
          <stop offset="1" stopColor="#2385B3" />
        </linearGradient>
      </defs>
      <path d="M6 3H11.5V13.2L22 3H29L16.4 15.6L29.4 29H22.6L12.6 18.6L11.5 19.7V29H6Z" fill="url(#kvistcode-g)" stroke="url(#kvistcode-g)" strokeWidth="0.9" strokeLinejoin="round" />
    </svg>
  );
}
