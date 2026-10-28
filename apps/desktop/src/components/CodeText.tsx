import { Fragment, memo, useMemo } from "react";
import { mergeStale, type HlLine } from "@/lib/highlight";
import { useHighlight } from "@/hooks/useHighlight";

const FONT_ITALIC = 1;
const FONT_BOLD = 2;
const FONT_UNDERLINE = 4;

/** Render pre-tokenized lines (joined by newlines) as colored spans. */
export function HighlightedLines({ lines }: { lines: HlLine[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && "\n"}
          <TokenLine line={line} />
        </Fragment>
      ))}
    </>
  );
}

/** One line's tokens. */
export const TokenLine = memo(function TokenLine({ line }: { line: HlLine }) {
  return (
    <>
      {line.map((tk, i) =>
        tk.c || tk.s ? (
          <span
            key={i}
            style={{
              color: tk.c,
              fontStyle: tk.s && tk.s & FONT_ITALIC ? "italic" : undefined,
              fontWeight: tk.s && tk.s & FONT_BOLD ? 600 : undefined,
              textDecoration: tk.s && tk.s & FONT_UNDERLINE ? "underline" : undefined,
            }}
          >
            {tk.t}
          </span>
        ) : (
          tk.t
        ),
      )}
    </>
  );
});

/** Syntax-highlighted code text (put inside a <pre>/<code>). Plain until highlighting is ready; identical metrics either way. */
export function CodeText({ code, lang }: { code: string; lang: string | null }) {
  const hl = useHighlight(lang, code);
  const lines = useMemo(() => (hl ? mergeStale(hl, code) : null), [hl, code]);
  if (!lines) return <>{code}</>;
  return <HighlightedLines lines={lines} />;
}
