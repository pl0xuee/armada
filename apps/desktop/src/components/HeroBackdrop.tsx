import { cn } from "@/lib/utils";

/** The faint grid and soft accent glow behind a welcome screen (first run and the home page). Static: no animation, no layers. */
export function HeroBackdrop({ className, top = "18%" }: { className?: string; top?: string }) {
  return (
    <div className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)} aria-hidden>
      <div
        className="absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse 60% 55% at 50% 40%, black, transparent)",
          WebkitMaskImage: "radial-gradient(ellipse 60% 55% at 50% 40%, black, transparent)",
        }}
      />
      <div
        className="absolute left-1/2 h-[420px] w-[620px] -translate-x-1/2 rounded-full bg-accent/[0.07] blur-[90px]"
        style={{ top }}
      />
    </div>
  );
}

/** A phrase drawn in the theme's accent as a soft gradient. */
export function AccentText({ children }: { children: React.ReactNode }) {
  return <span className="accent-text">{children}</span>;
}
