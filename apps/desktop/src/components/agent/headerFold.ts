/**
 * Header widths (px) below which parts of the agent header make way for the title: the budget chip goes first,
 * then the account chip and every secondary button (they fold into the ⋯ menu).
 */
export const HEADER_NO_BUDGET_WIDTH = 600;
export const HEADER_TIGHT_WIDTH = 520;

export function headerFold(width: number): { noBudget: boolean; tight: boolean } {
  // Width 0 means not measured yet: show everything rather than flash a folded header.
  return { noBudget: width > 0 && width < HEADER_NO_BUDGET_WIDTH, tight: width > 0 && width < HEADER_TIGHT_WIDTH };
}
