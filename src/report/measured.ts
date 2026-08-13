/**
 * `Measured<T>` — the type that stops a dashboard turning "we could not look" into a number.
 *
 * Its own module because both the view model and the trend builder need it, and having either
 * own it made them import each other (caught by `pnpm boundaries` on the first run). It is
 * also the right shape for it: this is the primitive the whole reporting layer is built on,
 * not a detail of one consumer.
 *
 * The engine refuses everywhere to conflate an absent reading with a real one. A dashboard is
 * where a number gets believed, so the last mile cannot rely on a renderer remembering that a
 * null LCP is not `0`. Making an absence a different TYPE from a reading moves that from a
 * convention to something the compiler enforces.
 */

export type Measured<T> = { measured: true; value: T; text: string } | { measured: false; reason: string; text: "not measured" };

export const measured = <T,>(value: T, text: string): Measured<T> => ({ measured: true, value, text });

/** An absence, carrying WHY — so hovering it in a UI explains itself. */
export const unmeasured = <T,>(reason: string): Measured<T> => ({ measured: false, reason, text: "not measured" });

/** Milliseconds, or an explicit absence. Never 0 standing in for "unread". */
export const ms = (value: number | null, reason = "the browser reported no value"): Measured<number> =>
  value === null ? unmeasured(reason) : measured(value, `${Math.round(value)}ms`);

/**
 * A unitless metric such as CLS.
 *
 * Separate from `ms` because ZERO IS A REAL READING here: a CLS of 0 means nothing moved,
 * which is the best possible answer. A truthy check instead of a null check would hide every
 * perfect score, which is why the null check is explicit in both.
 *
 * `reason` is REQUIRED, unlike `score`'s. It had a default of "the browser reported no value",
 * which no caller ever used — and a default here is worse than an absent one: this codebase's
 * whole position is that an absence must say WHY, and a generic house reason is the shape of
 * answer that stops anybody asking. A required parameter makes the call site state it.
 */
export const ratio = (value: number | null, reason: string): Measured<number> =>
  value === null ? unmeasured(reason) : measured(value, String(Math.round(value * 1000) / 1000));

/** A 0..100 score. */
export const score = (value: number | null, reason = "not computed"): Measured<number> =>
  value === null ? unmeasured(reason) : measured(value, String(Math.round(value)));
