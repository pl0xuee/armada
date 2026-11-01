// "What you can do" tour: when it shows by itself. It is shown once per install, to new users right after
// setup and to existing users the first time they launch the version that introduced it. Both are the same
// rule: onboarding is done and the "seen" flag isn't set. The flag lives in its own localStorage key
// (the tour is newer than the app's legacy `armada.*` ids, which stay as they are: docs/RELEASING.md).

export const TOUR_KEY = "kvistcode.tour.v1";

/** Has the tour been shown? When storage can't be read it counts as seen: better silent than on every launch. */
export function tourSeen(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  try {
    return storage.getItem(TOUR_KEY) !== null;
  } catch {
    return true;
  }
}

export function markTourSeen(storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(TOUR_KEY, "1");
  } catch {
    /* storage unavailable: the tour just isn't remembered */
  }
}

/** Forget it, so the tour shows again on the next launch (Settings offers it directly, this is for tests). */
export function resetTourSeen(storage: Pick<Storage, "removeItem"> = localStorage): void {
  try {
    storage.removeItem(TOUR_KEY);
  } catch {
    /* nothing to forget */
  }
}

export interface TourContext {
  /** Settings are loaded and setup is finished (the tour never covers onboarding). */
  onboarded: boolean;
  seen: boolean;
  /** Driven by WebDriver / Playwright: a modal would block scripted clicks, so stay out of the way. */
  automated: boolean;
  /** `?tour` in the URL: show it regardless (review and screenshots). */
  forced: boolean;
}

export function shouldAutoShowTour(c: TourContext): boolean {
  if (!c.onboarded) return false;
  if (c.forced) return true;
  return !c.seen && !c.automated;
}

export function tourContext(onboarded: boolean): TourContext {
  let forced = false;
  try {
    forced = new URLSearchParams(location.search).has("tour");
  } catch {
    /* no location: not forced */
  }
  return { onboarded, seen: tourSeen(), automated: !!navigator.webdriver, forced };
}
