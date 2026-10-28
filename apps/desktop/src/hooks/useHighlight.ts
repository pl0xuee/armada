import { useEffect, useRef, useState } from "react";
import {
  highlight,
  hunkSides,
  langFromPath,
  mapDiffTokens,
  peekHighlight,
  type HlLine,
  type TokenizableDiffLine,
} from "@/lib/highlight";

/** Wait this long after the last change before re-highlighting a growing (streaming) block. */
const STREAM_DEBOUNCE_MS = 250;

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
    const run = () =>
      void highlight(lang, code).then((lines) => {
        if (!cancelled && lines) {
          had.current = true;
          setState({ lang, code, lines });
        }
      });
    if (!had.current) {
      run();
      return () => void (cancelled = true);
    }
    const t = setTimeout(run, STREAM_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
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
