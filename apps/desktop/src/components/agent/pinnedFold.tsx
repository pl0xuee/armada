import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Matches the fold's height transition, so it unmounts after it has collapsed. */
export const COLLAPSE_MS = 220;

/** True for `ms` after `active` went from true to false (a finish worth showing). */
export function useLinger(active: boolean, ms: number): boolean {
  const [lingering, setLingering] = useState(false);
  const wasActive = useRef(false);
  useEffect(() => {
    if (active) {
      wasActive.current = true;
      setLingering(false);
      return;
    }
    if (!wasActive.current) return;
    wasActive.current = false;
    setLingering(true);
    const t = setTimeout(() => setLingering(false), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return lingering;
}

/** Mount while open and a moment after, with `expanded` flipping a frame later so the height animates. */
export function useCollapse(open: boolean): { mounted: boolean; expanded: boolean } {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setExpanded(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setExpanded(false);
    const t = setTimeout(() => setMounted(false), COLLAPSE_MS);
    return () => clearTimeout(t);
  }, [open]);
  return { mounted, expanded };
}

/** The last non-null value: lets a section keep showing its content while it folds away. */
export function useRetained<T>(value: T | null): T | null {
  const last = useRef<T | null>(value);
  if (value !== null) last.current = value;
  return value ?? last.current;
}

/**
 * Height transition (~200 ms, none with reduced motion) for something that comes and goes. Renders
 * nothing once folded away. Children are only rendered while it is open or folding.
 */
export function Fold({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const { mounted, expanded } = useCollapse(open);
  // Clipping is only needed while the height moves; once it has settled, sticky children and focus rings work.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!expanded) {
      setSettled(false);
      return;
    }
    const t = setTimeout(() => setSettled(true), COLLAPSE_MS);
    return () => clearTimeout(t);
  }, [expanded]);
  if (!mounted) return null;
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
        expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        className,
      )}
    >
      <div className={cn("min-h-0 min-w-0", !settled && "overflow-hidden")}>{children}</div>
    </div>
  );
}
