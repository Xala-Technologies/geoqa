/**
 * Indexing an array at a position the caller has already bounded.
 *
 * Zero imports, for the reason `errors.ts` and `run/pool.ts` have none: every layer needs
 * this, including the ones the boundary rules keep at the bottom of the map.
 *
 * **Why this exists at all.** `noUncheckedIndexedAccess` types every `array[i]` as
 * `T | undefined`, which is correct in general and wrong at a site that just computed `i`
 * from `array.length`. The reflex is to write `?? someDefault`, and that reflex is how this
 * repo accumulated fallbacks that can never be taken — four of them found in one week, one
 * with a comment arguing it was reachable.
 *
 * A fallback nobody can reach is worse than it looks. It cannot be tested, so it is never
 * exercised; it silences the compiler, so it is never revisited; and it decides, invisibly,
 * what happens if the invariant it assumes ever breaks. In `selectFromPool` the fallback was
 * `?? null` — and `null` there does not mean "something went wrong", it means **"no proxy
 * exit"**, which a caller turns into direct egress. A geographic tool would have quietly
 * measured the wrong country rather than failed.
 *
 * Throwing is the right answer for exactly that reason: an index out of range is a bug in
 * the caller, and a bug that announces itself costs one stack trace, while one that returns
 * a plausible value costs a wrong measurement nobody questions.
 */

/**
 * The element at `index`, which the caller has already proven is in range.
 *
 * @throws if it is not — deliberately, rather than returning a default that would be
 * indistinguishable from a real value.
 */
export function elementAt<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`index ${index} is out of range for ${items.length} item(s) — the caller's bounds check is wrong`);
  }
  return value;
}
