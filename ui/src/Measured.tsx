// `JSX` is imported rather than global: React 19 removed the global JSX namespace, so
// `JSX.Element` no longer resolves on its own. Caught by the UI's own tsc, which is why the
// build runs it before Vite.
import type { JSX } from "react";
import type { Measured } from "./types.ts";

/**
 * A value that may not exist — and the one component this UI cannot get wrong.
 *
 * An absence renders as "not measured" in a muted, italic style that is visibly NOT a
 * number. That is the whole job. The engine refuses everywhere to conflate "we could not
 * look" with "it is fine", and a dashboard is where a number gets believed, so `0` standing
 * in for a null LCP here would undo all of it at the last step.
 *
 * The `title` carries the REASON, so hovering an absence explains itself rather than leaving
 * a reader to guess whether the page is broken or the measurement was.
 */
export function MeasuredValue({ value, unit }: { value: Measured<number>; unit?: string }): JSX.Element {
  if (!value.measured) {
    return (
      <span className="unmeasured" title={value.reason}>
        not measured
      </span>
    );
  }
  return (
    <span className="measured">
      {value.text}
      {unit !== undefined && !value.text.endsWith(unit) ? unit : ""}
    </span>
  );
}

/**
 * A verdict or axis result as a pill.
 *
 * `unverified` and `ERROR` get their own tone rather than borrowing the failure colour.
 * Colouring an ERROR like a site failure would be the same conflation the verdict model
 * spent so much effort avoiding — one is the site's problem and the other is ours.
 */
export function Verdict({ value }: { value: string }): JSX.Element {
  const tone =
    value === "PASS" || value === "match"
      ? "good"
      : value === "PASS_WITH_WARNINGS"
        ? "warn"
        : value === "FAIL" || value === "mismatch"
          ? "bad"
          : "unknown";
  return <span className={`pill ${tone}`}>{value}</span>;
}
