import { cn } from "@/lib/utils";
import type { VaPhase } from "@/lib/voiceAssistant";

const TONE: Record<VaPhase, string> = {
  off: "var(--steel)",
  connecting: "var(--steel)",
  listening: "var(--accent)",
  thinking: "var(--warn)",
  speaking: "var(--ok)",
  error: "var(--err)",
};

/**
 * The assistant's orb. Its size follows the live level (your voice while listening, the
 * assistant's while speaking). With reduced motion the size is fixed and the ring
 * opacity carries the level instead.
 */
export function VoiceOrb({
  phase,
  level,
  muted,
  size = 64,
  className,
}: {
  phase: VaPhase;
  level: number;
  muted?: boolean;
  size?: number;
  className?: string;
}) {
  const tone = muted && phase === "listening" ? "var(--steel)" : TONE[phase];
  const lvl = Math.min(1, Math.max(0, level));
  const busy = phase === "thinking" || phase === "connecting";
  return (
    <div
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
      aria-hidden="true"
      data-phase={phase}
    >
      {/* soft glow */}
      <span
        className="absolute -inset-3 rounded-full opacity-40 blur-xl transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none"
        style={{
          background: tone,
          transform: `scale(${0.85 + lvl * 0.5})`,
          opacity: 0.25 + lvl * 0.4,
        }}
      />
      {/* ripples while the assistant talks */}
      {phase === "speaking" && (
        <span
          className="absolute inset-0 animate-ping rounded-full border opacity-40 motion-reduce:hidden"
          style={{ borderColor: tone, animationDuration: "1.6s" }}
        />
      )}
      {/* level ring (static fallback for reduced motion) */}
      <span
        className="absolute inset-0 hidden rounded-full border-2 motion-reduce:block"
        style={{ borderColor: tone, opacity: 0.3 + lvl * 0.7 }}
      />
      {/* the orb */}
      <span
        className={cn(
          "absolute inset-[6%] rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-8px_16px_rgba(0,0,0,0.25)] transition-transform duration-100 ease-out motion-reduce:transition-none",
          busy && "animate-pulse motion-reduce:animate-none",
        )}
        style={{
          transform: `scale(${1 + lvl * 0.22})`,
          background: `radial-gradient(circle at 32% 28%, color-mix(in srgb, ${tone} 35%, white), ${tone} 55%, color-mix(in srgb, ${tone} 55%, black))`,
        }}
      />
    </div>
  );
}
