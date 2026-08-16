/**
 * What to say about something that was thrown.
 *
 * **Zero imports, on purpose.** Every layer needs this, including `browser/`, which the
 * boundary rules keep at the bottom of the map, and the Temporal workflow sandbox, which
 * cannot pull in a heavy module graph. A leaf with no dependencies is importable from
 * everywhere without inverting anything — the same reason `run/pool.ts` has none.
 *
 * **Why this is a function and not an idiom.** `e instanceof Error ? e.message : String(e)`
 * was written ten times across ten files. Ten copies is ten chances to write the half of it
 * that reads `.message` off whatever arrived, and the value of getting it wrong is the
 * string `"undefined"` — which sends an operator looking for a bug in the reporter instead
 * of at the disk, the network or the browser that actually failed. It is also ten branches
 * that each need their own test to prove they handle a non-Error, and nine of those tests
 * would be proving the same thing.
 *
 * A non-Error throw is not hypothetical. Node throws strings from some native paths, a
 * rejected promise carries whatever it was rejected with, and `throw` accepts any value at
 * all — including `undefined`, which is why the null-ish cases are named rather than left to
 * `String()`. `String(undefined)` is `"undefined"`: correct, and indistinguishable from a
 * message that genuinely says so.
 */

/**
 * A human-readable cause for any thrown value.
 *
 * Never throws itself. A reporter that can fail while reporting turns a diagnosable problem
 * into an undiagnosable one, so the object case is guarded: `String(value)` on an object with
 * a throwing `toString` would propagate out of a catch block.
 */
export function describeThrown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value === undefined) return "an undefined value was thrown";
  if (value === null) return "a null value was thrown";
  try {
    return String(value);
  } catch {
    // Reachable: an object with a `toString` that throws, or a symbol-keyed proxy. Rare, and
    // the one case where saying nothing useful still beats replacing the original failure.
    return "an unprintable value was thrown";
  }
}
