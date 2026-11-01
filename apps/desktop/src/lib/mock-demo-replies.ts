// Long-form agent replies for the browser mock: used to review how output reads (hierarchy, tables,
// code, progressive disclosure). Fictional. Excluded from release builds together with the mock.

export const REPORT_FINAL = `Found it, fixed it, and covered it with tests. The checkout total was off by one cent on roughly **1 in 40 orders** because line totals were rounded **per item** while tax was rounded **per order**.

## What was wrong

- **Float arithmetic on money.** \`subtotal\` was a JavaScript number built from \`price * qty\`, so \`19.99 * 3\` became \`59.97000000000001\`.
- **Two different rounding points.** \`lineTotal()\` rounded half-up per line, \`orderTax()\` rounded half-even on the sum. They only agree when the cents divide evenly.
- **Discounts applied after tax.** A 10% code on a taxed subtotal drifted by up to 1 cent versus the invoice PDF, which discounts first.

## Reproduced orders

| Order | Items | Before | After | Difference |
| --- | --- | ---: | ---: | ---: |
| \`#48213\` | 3 x 19.99 | 64.77 | 64.76 | -0.01 |
| \`#48377\` | 7 x 4.35 | 33.58 | 33.57 | -0.01 |
| \`#48590\` | 2 x 12.50 + code \`SPRING10\` | 26.43 | 26.44 | +0.01 |
| \`#48611\` | 1 x 99.00 | 106.92 | 106.92 | 0.00 |
| \`#48702\` | 12 x 0.99 | 12.83 | 12.82 | -0.01 |

The \`After\` column now matches the Stripe charge and the invoice PDF for every order above.

## What I changed

- \`src/billing/money.ts\` (new): integer-cent \`Money\` helpers, one rounding mode (half-up) used everywhere.
- \`src/billing/totals.ts\`: rebuilt on top of \`Money\`; discounts apply before tax, tax rounds once per order.
- \`src/billing/invoice.ts\`: reads totals from the same function instead of recomputing them.
- \`test/billing/totals.test.ts\`: 14 cases, including the five orders above and a property test over 5,000 random carts.

## What I left alone

- **Historical orders.** Their stored totals are already charged; recomputing would create refund noise. I added a \`legacy_rounding\` flag so reports can tell them apart.
- **Multi-currency.** Zero-decimal currencies (JPY) still go through the old path. It is correct today, but worth migrating next.

## Verification

All 212 tests pass (14 new) and the type check is clean. I also replayed last month's 9,041 orders through the new code: **9,041 of 9,041** match the charged amount, versus 8,998 before.

## Suggested follow-ups

1. Backfill the \`legacy_rounding\` flag for orders before March.
2. Move the JPY path onto \`Money\` and delete \`lineTotal()\`.
3. Add the property test to the nightly job so new pricing rules can't reintroduce drift.

Nothing here needs a migration or a deploy ordering. It is safe to merge on its own.`;

export const INVEST_NARRATION = {
  a: "Let me start with where the totals are computed.",
  b: "Found two places that round. Let me read both before deciding anything.",
  c: "That explains half of it. Checking how the invoice builds its numbers, since the complaint came from the PDF.",
  d: `The invoice **does not** call \`orderTotal()\`. It re-implements the sum, and it discounts before tax while the checkout discounts after. So even with identical rounding the two would disagree.

Before changing code I want a reproducible set of orders, so I'm going to pull the ones support flagged and compute them both ways. That tells me whether this is one bug or two, and gives the regression tests real data instead of invented numbers.

A few things I'll look at while I do that:

- whether the mismatch only shows up on orders with a discount code, or also on plain carts;
- whether it depends on the number of line items (rounding errors accumulate with more lines);
- whether the tax region matters, since two regions use different rounding rules;
- and whether any of the flagged orders were created before the March pricing change.

If all four come back negative, the cause is the per-line rounding by itself, and the fix is small.`,
  e: "Five of the six flagged orders reproduce. The sixth (\`#48611\`) is a shipping-rate change, unrelated to rounding. Writing the fix now.",
  f: "Tests are red for the right reason. Applying the change.",
};

export const SUMMARY_FINAL = `## Summary

The retry logic now lives in one place and every outbound call uses it. Here is the shape of the change, then how to use it.

### The new helper

\`\`\`ts
// src/net/retry.ts
export interface RetryOptions {
  /** Total attempts including the first. */
  attempts?: number;
  /** Base delay in ms; doubles each attempt with jitter. */
  baseMs?: number;
  /** Cap for a single delay. */
  maxMs?: number;
  /** Return false to stop retrying (for example on a 4xx). */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  signal?: AbortSignal;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });

export async function withRetry<T>(
  run: (attempt: number) => Promise<T>,
  { attempts = 4, baseMs = 200, maxMs = 5_000, shouldRetry = isTransient, signal }: RetryOptions = {},
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await run(attempt);
    } catch (error) {
      last = error;
      if (attempt === attempts || !shouldRetry(error, attempt)) break;
      const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      await sleep(exp / 2 + Math.random() * (exp / 2), signal);
    }
  }
  throw last;
}

export function isTransient(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status === undefined) return true; // network failure
  return status === 408 || status === 429 || status >= 500;
}

export class RetryExhausted extends Error {
  constructor(readonly attempts: number, readonly cause: unknown) {
    super(\`gave up after \${attempts} attempts\`);
  }
}
\`\`\`

### Using it

\`\`\`ts
const user = await withRetry(() => api.get(\`/users/\${id}\`), { attempts: 3 });
\`\`\`

To run it from the terminal against staging:

\`\`\`bash
ARMADA_ENV=staging npm run smoke -- --only retry
\`\`\`

### Behaviour at a glance

| Situation | Retried? | Notes |
| --- | :---: | --- |
| Network error | Yes | Counts as transient |
| \`408\`, \`429\`, \`5xx\` | Yes | \`Retry-After\` is honoured when present |
| Other \`4xx\` | No | Fails on the first attempt |
| Aborted via \`signal\` | No | Rejects with the abort reason |

> The jitter keeps clients from retrying in lockstep after an outage. Without it, a short blip turns into a thundering herd.

### Checklist

- [x] Helper with exponential backoff and jitter
- [x] \`api.get\`, \`api.post\` and the webhook sender migrated
- [x] Unit tests for each row of the table above
- [ ] Dashboard for retry counts (not started; needs a metrics decision)

Nested detail for the reviewer:

- **Call sites**
  - 11 files now import \`withRetry\`
  - 3 hand-rolled loops were deleted
- **Not migrated**
  - the S3 uploader, because its SDK already retries

---

That is everything. The one thing I would double check is the default of **4 attempts**: it matches the old behaviour for reads, but writes used to try only twice.`;

export const PRIOR_ANSWER = `Here is how the retry behaviour works today, before any change.

## Where retries happen

Each client rolls its own loop, so behaviour depends on which file you read.

- \`src/net/http.ts\` retries GETs three times with a fixed 500 ms pause.
- \`src/webhooks/send.ts\` retries twice, doubling the pause, but never on a timeout.
- \`src/jobs/sync.ts\` retries forever on any error, which is how one bad record stalled the queue last week.
- \`src/auth/session.ts\` does not retry at all; it refreshes the token and replays once.

## What counts as retryable

1. Network errors (connection reset, DNS failure).
2. HTTP \`429\` and \`503\`, in two of the four places.
3. HTTP \`500\`, in one place.
4. Timeouts, in two places, but with different limits (5 s and 30 s).

## Problems this causes

- **Inconsistent limits.** The same failing dependency is retried 3 times by one caller and forever by another.
- **No jitter.** After an outage every client retries on the same beat, which prolongs it.
- **No cancellation.** A navigation away does not stop in-flight retries.
- **Hard to test.** Each loop sleeps with a real timer, so the tests either wait or skip the path entirely.

## What I would do

Replace the four loops with one helper that takes an attempt count, a base delay with exponential growth and jitter, an abort signal, and a predicate for what is retryable. The defaults should match the safest current behaviour (reads: 4 attempts, writes: 2), and every call site should state its intent explicitly.

None of this changes behaviour for users on a healthy network. It only matters when something is already failing, which is when consistent behaviour matters most.`;
