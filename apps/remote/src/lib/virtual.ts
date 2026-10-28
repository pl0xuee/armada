/** Offset math for the windowed timeline (pure, tested). */

/** offsets[i] = top of row i; offsets[n] = total height. */
export function prefixSums(n: number, height: (i: number) => number): Float64Array {
  const out = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) out[i + 1] = out[i] + Math.max(0, height(i));
  return out;
}

/** Smallest i in [0, n] with offsets[i] > y (n = offsets.length - 1 if none). */
export function firstIndexAfter(offsets: ArrayLike<number>, y: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] > y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Rows to mount for a viewport [top, bottom] (list coordinates), with overscan. */
export function visibleRange(offsets: ArrayLike<number>, top: number, bottom: number, overscan: number): [number, number] {
  const n = offsets.length - 1;
  if (n <= 0) return [0, 0];
  const start = Math.min(n - 1, Math.max(0, firstIndexAfter(offsets, top - overscan) - 1));
  const end = Math.min(n, Math.max(start + 1, firstIndexAfter(offsets, bottom + overscan)));
  return [start, end];
}
