/**
 * The bounded worker pool, and the concurrency bound both execution modes share.
 *
 * **Its own module, with no imports at all, and that is the whole point.** Invariant 12 says
 * two execution modes, one implementation — but `run/matrix.ts` reaches `executeRun`, which
 * reaches the browser, the filesystem and the network. A Temporal workflow cannot import that
 * graph: workflow code runs in a deterministic sandbox, so pulling in a module that opens a
 * browser is either rejected or silently bundles a great deal that must never execute there.
 *
 * So the part both modes genuinely share — how many things run at once, and the loop that
 * enforces it — lives here, dependency-free. Anything that touches the outside world stays in
 * the caller. That is why this file has no `import` line, and it should stay that way.
 */

/**
 * How many scenarios run at once by default.
 *
 * **4, and it is measured rather than guessed.** EXP-007 ran on a 14-core / 36 GB laptop
 * against a local fixture server and reported 100% completion, 100% verdict agreement and 100%
 * egress-held at 2, 4, 8, 12 and 16, with wall clock per session at x1.01, x1.01, x1.14, x1.09
 * and x1.30.
 *
 * 4 rather than 16 because the default must be safe on the smallest machine that will run it,
 * and because the marginal gain past 4 is inside the noise while the per-session cost is not:
 * each scenario is its own Chrome process, and a machine that swaps produces slow readings that
 * look like slow sites.
 */
export const DEFAULT_MATRIX_CONCURRENCY = 4;

/**
 * The bound a caller asked for, or the default.
 *
 * A non-finite request — `NaN` from a mistyped flag, `Infinity` from a clever one — takes the
 * default rather than becoming unbounded. "As many as possible" is not a concurrency setting,
 * it is the absence of one, and it fails as an OOM halfway through a sweep rather than as an
 * error at the start.
 */
export function resolveConcurrency(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_MATRIX_CONCURRENCY;
  // Below 1 means nothing would ever run; 1 is legitimate and means "sequential".
  return Math.max(1, Math.floor(requested));
}

/** What a completed pool reports about how it actually behaved. */
export interface PoolOutcome<R> {
  /** Results in COMPLETION order. Callers that need input order sort them back. */
  results: R[];
  /** The most that were ever in flight at once — evidence the bound held. */
  peakInFlight: number;
}

/**
 * Run `work` over `items`, never more than `limit` at a time.
 *
 * **`work` must not throw.** The pool has no error arm on purpose: a rejected task would reject
 * the `Promise.all` below and every queued item would simply never be attempted, leaving a
 * matrix whose gaps are indistinguishable from markets that were fine. Both callers already
 * turn a failure into a RECORDED outcome with its error attached, which is the only honest
 * shape — so the contract here is that they keep doing it, stated rather than defended against
 * with a catch that would have to invent a result.
 *
 * Results arrive in completion order, not input order. That is deliberate rather than
 * incidental: a pool that preserved input order would have to hold completed results waiting
 * for a slow earlier item, and a caller that wants input order can sort by an index it already
 * has. `peakInFlight` is returned so a test can prove the bound held rather than assuming it.
 */
export async function boundedPool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<PoolOutcome<R>> {
  let peakInFlight = 0;
  let inFlight = 0;
  let next = 0;
  const results: R[] = [];

  const worker = async (): Promise<void> => {
    for (;;) {
      const item = items[next++];
      if (item === undefined) return;
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        results.push(await work(item));
      } finally {
        // In a `finally` so a bug in the bookkeeping above cannot leave the pool believing a
        // slot is permanently occupied — which would quietly reduce concurrency to zero and
        // hang the sweep rather than failing it.
        inFlight--;
      }
    }
  };

  // Never more workers than items, so an empty list starts nothing at all.
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return { results, peakInFlight };
}
