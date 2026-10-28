import { Check } from "lucide-react";
import { m, useReducedMotion } from "motion/react";

const PARTICLES = Array.from({ length: 14 }, (_, i) => {
  const angle = (i / 14) * Math.PI * 2 + (i % 2 ? 0.2 : -0.1);
  const dist = 62 + (i % 3) * 16;
  return {
    x: Math.cos(angle) * dist,
    y: Math.sin(angle) * dist,
    size: i % 3 === 0 ? 6 : 4,
    color: ["var(--accent)", "var(--ok)", "var(--warn)", "var(--violet)", "var(--claude)"][i % 5],
    delay: 0.05 + (i % 4) * 0.03,
    round: i % 2 === 0,
  };
});

/** Inbox-zero celebration: a check that lands, a ring that ripples, a burst of confetti-lite. */
export function InboxZero({ handled }: { handled: number }) {
  const reduce = useReducedMotion();
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="relative mb-7 flex h-24 w-24 items-center justify-center">
        <div className="absolute inset-0 -m-8 rounded-full bg-ok/10 blur-2xl" aria-hidden />
        {!reduce &&
          PARTICLES.map((p, i) => (
            <m.span
              key={i}
              aria-hidden
              className="absolute left-1/2 top-1/2"
              style={{
                width: p.size,
                height: p.size,
                marginLeft: -p.size / 2,
                marginTop: -p.size / 2,
                background: p.color,
                borderRadius: p.round ? 999 : 1.5,
              }}
              initial={{ x: 0, y: 0, opacity: 0, scale: 0.4, rotate: 0 }}
              animate={{ x: p.x, y: p.y, opacity: [0, 1, 0], scale: 1, rotate: 120 }}
              transition={{ duration: 0.9, delay: 0.15 + p.delay, ease: [0.15, 0.8, 0.3, 1] }}
            />
          ))}
        {!reduce && (
          <m.span
            aria-hidden
            className="absolute inset-0 rounded-full border border-ok/50"
            initial={{ scale: 0.7, opacity: 0.9 }}
            animate={{ scale: 1.7, opacity: 0 }}
            transition={{ duration: 1.1, delay: 0.15, ease: "easeOut" }}
          />
        )}
        <m.div
          initial={reduce ? false : { scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 380, damping: 18 }}
          className="relative flex h-20 w-20 items-center justify-center rounded-full border border-ok/40 bg-gradient-to-b from-ok/25 to-ok/5 shadow-[0_0_40px_-6px_color-mix(in_srgb,var(--ok)_55%,transparent)] edge-strong"
        >
          <Check className="h-9 w-9 text-ok" strokeWidth={2.5} />
        </m.div>
      </div>
      <m.div
        initial={reduce ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, delay: 0.2 }}
      >
        <h2 className="text-[20px] font-semibold tracking-tight">Inbox zero</h2>
        <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted">
          {handled > 0
            ? `You cleared ${handled} ${handled === 1 ? "request" : "requests"}. Your agents are back to work.`
            : "Nothing is waiting on you. When an agent needs approval, it lands here."}
        </p>
      </m.div>
    </div>
  );
}
