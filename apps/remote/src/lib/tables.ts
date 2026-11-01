/**
 * Tables in agent replies: columns whose cells are all numbers line up on the right (the desktop does the
 * same), unless the writer set an alignment. Pure, so it is tested without rendering.
 */

type Align = "left" | "center" | "right" | null | undefined;

/** 12, -3.5, +4%, $1,200, 38 ms, 1.2k, 3x, ~40 */
const NUMBER = /^[+\-−~≈<>]?\s?[$€£¥]?\s?\d[\d,._]*\s?(?:%|ms|s|x|×|px|[kKmMgGtT]?[bB]?)$/;

const plain = (cell: string) => cell.replace(/[*_`~]/g, "").trim();

export const isNumericCell = (cell: string) => NUMBER.test(plain(cell));

/** For each column: does it hold only numbers (empty cells and "-" placeholders are ignored; at least one number is needed)? */
export function numericColumns(head: readonly string[], rows: readonly (readonly string[])[], align: readonly Align[]): boolean[] {
  return head.map((_, j) => {
    if (align[j]) return false;
    let numbers = 0;
    for (const r of rows) {
      const c = plain(r[j] ?? "");
      if (!c || c === "-" || c === "—" || c === "–") continue;
      if (!isNumericCell(c)) return false;
      numbers++;
    }
    return numbers > 0;
  });
}
