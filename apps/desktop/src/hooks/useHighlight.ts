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
  /** Review mode: highlight in small slices, one file at a time, whenever the browser is idle. */
  deferred = false,
): DiffTokens | null {
  const lang = langFromPath(path);
  const [out, setOut] = useState<{ hunks: unknown; tokens: DiffTokens } | null>(null);
  useEffect(() => {
    if (!enabled || !lang || hunks.length === 0) return;
    let cancelled = false;
    if (deferred) {
      void highlightDeferred(
        lang,
        hunks,
        () => cancelled,
        (tokens) => setOut({ hunks, tokens }),
      );
      return () => {
        cancelled = true;
      };
    }
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
  }, [lang, hunks, enabled, deferred]);
  return out && out.hunks === hunks ? out.tokens : null;
}

// ---------------------------------------------------------------- deferred (Review) highlighting

/** Lines tokenized per task: small enough that one slice never blocks input for long. */
export const HL_SLICE_LINES = 250;
/** Past this many diff lines a file's remainder stays plain text. */
export const HL_MAX_FILE_LINES = 6000;

let hlTail: Promise<void> = Promise.resolve();

function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function")
      window.requestIdleCallback(() => resolve(), { timeout: 300 });
    else setTimeout(resolve, 16);
  });
}

/** Run `job` after everything queued before it, once the browser is idle (skipped when cancelled). */
function enqueueHighlight(job: () => Promise<void>, cancelled: () => boolean): Promise<void> {
  const run = hlTail.then(async () => {
    if (cancelled()) return;
    await whenIdle();
    if (cancelled()) return;
    await job();
  });
  hlTail = run.catch(() => {});
  return run;
}

/** Split a hunk's lines into slices; a slice break only costs accuracy of multi-line constructs. */
export function sliceLines<T>(lines: T[], size = HL_SLICE_LINES): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < lines.length; i += size) out.push(lines.slice(i, i + size));
  return out.length ? out : [[]];
}

async function highlightDeferred(
  lang: string,
  hunks: { lines: TokenizableDiffLine[] }[],
  cancelled: () => boolean,
  publish: (tokens: DiffTokens) => void,
) {
  const tokens: DiffTokens = hunks.map(() => []);
  let budget = HL_MAX_FILE_LINES;
  let lastPublish = 0;
  for (let hi = 0; hi < hunks.length && budget > 0; hi++) {
    for (const slice of sliceLines(hunks[hi].lines)) {
      if (cancelled() || budget <= 0) return;
      budget -= slice.length;
      const { oldText, newText } = hunkSides(slice);
      const hit = peekHighlight(lang, oldText) && peekHighlight(lang, newText);
      const work = async () => {
        const [o, n] = await Promise.all([highlight(lang, oldText), highlight(lang, newText)]);
        if (!cancelled()) tokens[hi].push(...mapDiffTokens(slice, o, n));
      };
      if (hit) await work();
      else await enqueueHighlight(work, cancelled);
      if (cancelled()) return;
      const now = performance.now();
      if (now - lastPublish > 200) {
        lastPublish = now;
        publish(tokens.map((t) => t.slice()));
      }
    }
  }
  if (!cancelled()) publish(tokens.map((t) => t.slice()));
}
