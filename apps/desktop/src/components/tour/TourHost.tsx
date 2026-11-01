import { lazy, Suspense, useEffect, useState } from "react";
import { markTourSeen, shouldAutoShowTour, tourContext } from "@/lib/tour";
import { openTour, useTour } from "@/store/tour";

const WelcomeTour = lazy(() => import("./WelcomeTour").then((m) => ({ default: m.WelcomeTour })));

/** Let the main window settle before the tour appears over it. */
const SETTLE_MS = 900;

/**
 * Opens the tour by itself once (see lib/tour.ts for the rule) and mounts it when it is open. The tour's
 * code only loads the first time it is needed, and stays mounted afterwards so it can animate out.
 */
export function TourHost({ ready }: { ready: boolean }) {
  const open = useTour((s) => s.open);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (!ready || !shouldAutoShowTour(tourContext(true))) return;
    const t = setTimeout(() => {
      markTourSeen(); // once: even if the app quits mid-tour, it doesn't come back by itself
      openTour();
    }, SETTLE_MS);
    return () => clearTimeout(t);
  }, [ready]);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  if (!mounted) return null;
  return (
    <Suspense fallback={null}>
      <WelcomeTour />
    </Suspense>
  );
}
