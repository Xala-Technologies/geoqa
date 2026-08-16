/**
 * Walk a coverage matrix one slice at a time.
 *
 * Continuous used to mean "launch the whole cartesian product again".
 * Four URLs × 32 cities × 2 devices × 4 journeys is 1,024 residential
 * sessions. That is a bill, not a sample. A cursor takes the next N
 * scenarios, wraps, and the next tick continues — so coverage accumulates
 * without ever opening the whole matrix at once.
 */
export function nextSlice<T>(items: readonly T[], cursor: number, take: number): { slice: T[]; nextCursor: number } {
  if (items.length === 0) return { slice: [], nextCursor: 0 };
  const count = Math.min(Math.max(take, 0), items.length);
  const start = ((cursor % items.length) + items.length) % items.length;
  const slice: T[] = [];
  for (let i = 0; i < count; i++) {
    slice.push(items[(start + i) % items.length] as T);
  }
  return { slice, nextCursor: (start + slice.length) % items.length };
}
