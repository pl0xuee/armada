import { useEffect, useRef, useState } from "react";
import {
  highlight,
  hunkSides,
  langFromPath,
  prewarmHighlighter,
  STREAMING_HIGHLIGHT_LINES,
  mapDiffTokens,
  peekHighlight,
  type HlLine,
  type TokenizableDiffLine,
} from "@/lib/highlight";

/** Wait this long after the last change before re-highlighting a growing (streaming) block. */
const STREAM_DEBOUNCE_MS = 250;
/** Beyond this many lines the wait grows, since each pass re-tokenizes everything shown. */
const SLOW_STREAM_LINES = 300;
const SLOW_STREAM_DEBOUNCE_MS = 1000;
/** A block that hasn't changed for this long is finished: highlight all of it. */
const SETTLE_MS = 1500;

function lineCount(code: string): number {
  let n = 1;
  for (let i = code.indexOf("\n"); i >= 0; i = code.indexOf("\n", i + 1)) n++;
  return n;
}

/** Debounce before re-highlighting a block of `lines` lines that is still growing. */
export function streamDebounceMs(lines: number): number {
  return lines > SLOW_STREAM_LINES ? SLOW_STREAM_DEBOUNCE_MS : STREAM_DEBOUNCE_MS;
}

// Load Shiki and the common grammars shortly after startup, off the critical path.
if (typeof window !== "undefined") {
  const warm = () => void prewarmHighlighter();
  setTimeout(() => {
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(warm, { timeout: 10_000 });
    else setTimeout(warm, 0);
  }, 4000);
}

/**
 * Highlighted lines for `code`, or null until ready (callers render plain text meanwhile).
 * The first highlight of a block runs immediately; later changes are debounced. While waiting,
 * `lines` is the previous (possibly stale) result — see mergeStale for how callers reuse it.
 */
export function useHighlight(lang: string | null, code: string): HlLine[] | null {
  const cached = peekHighlight(lang, code);
  const [state, setState] = useState<{ lang: string | null; code: string; lines: HlLine[] | null }>({
    lang,
    code,
    lines: cached,
  });
  const had = useRef(false);
  useEffect(() => {
    if (!lang || peekHighlight(lang, code)) return;
    let cancelled = false;
    const lines = lineCount(code);
    // A big block may still be streaming (the hook can't tell): cap the first passes, then
    // highlight everything once it stops changing.
    const big = lines > STREAMING_HIGHLIGHT_LINES;
    const run = (maxLines?: number) =>
      void highlight(lang, code, { maxLines }).then((hl) => {
        if (!cancelled && hl) {
          had.current = true;
          setState({ lang, code, lines: hl });
        }
      });
    const timers: ReturnType<typeof setTimeout>[] = [];
    const cap = big ? STREAMING_HIGHLIGHT_LINES : undefined;
    if (!had.current) run(cap);
    else timers.push(setTimeout(() => run(cap), streamDebounceMs(lines)));
    if (big) timers.push(setTimeout(() => run(), SETTLE_MS));
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [lang, code]);
  if (cached) return cached;
  return state.lang === lang ? state.lines : null;
}

/** Per-hunk, per-line tokens for a diff (null entries render plain). */
export type DiffTokens = (HlLine | null)[][];

/**
 * Highlights each hunk's old and new text as a whole (so multi-line constructs stay correct),
 * then maps the tokens onto diff lines. Null until ready or when the language is unknown.
 */
export function useDiffHighlight(
  path: string,
  hunks: { lines: TokenizableDiffLine[] }[],
  enabled: boolean,
): DiffTokens | null {
  const lang = langFromPath(path);
  const [out, setOut] = useState<{ hunks: unknown; tokens: DiffTokens } | null>(null);
  useEffect(() => {
    if (!enabled || !lang || hunks.length === 0) return;
    let cancelled = false;
    void (async () => {
      const tokens: DiffTokens = [];
      for (const h of hunks) {
        const { oldText, newText } = hunkSides(h.lines);
        const [o, n] = await Promise.all([highlight(lang, oldText), highlight(lang, newText)]);
        if (cancelled) return;
        tokens.push(mapDiffTokens(h.lines, o, n));
      }
      if (!cancelled) setOut({ hunks, tokens });
    })();
    return () => {
      cancelled = true;
    };
  }, [lang, hunks, enabled]);
  return out && out.hunks === hunks ? out.tokens : null;
}
