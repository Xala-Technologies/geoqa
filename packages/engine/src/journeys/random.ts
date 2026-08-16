/**
 * Seeded randomness, so "behaves like a human" does not cost reproducibility.
 *
 * A journey that pauses 1.2–3.5s before the next action, sometimes opens the
 * gallery and sometimes does not, is a more representative test than one that
 * clicks every 500ms. It is also, if the variation is unseeded, a journey whose
 * failures cannot be re-run — and "it failed, and I cannot tell you what it did"
 * is where a QA system starts being ignored.
 *
 * So every decision comes from a seeded generator. The seed defaults to a hash of
 * the run id, which makes each run's pacing different from the last while making
 * any single run repeatable: pass `--seed` from a failing run's `run.json` and
 * the same choices are made again, in the same order.
 *
 * The generator only needs to be cheap and evenly distributed. It is not used for
 * anything security-relevant, and deliberately is not `Math.random` — which
 * cannot be seeded, and which the experiment harness already bans for the same
 * reproducibility reason.
 */

/** mulberry32: 32-bit state, one multiply-xor round. Fast and well distributed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 61), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Derive a stable 32-bit seed from a string (FNV-1a).
 *
 * Used on the run id, so two runs of the same journey pace differently while one
 * run always paces the same way.
 */
export function seedFrom(text: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/**
 * A whole number of milliseconds in `[minMs, maxMs]`.
 *
 * Inclusive of both ends, and tolerant of a reversed range: a journey author
 * writing `minMs: 3000, maxMs: 1000` means a pause of one to three seconds, and
 * failing the run over the argument order would be pedantry.
 */
export function pauseMs(random: () => number, minMs: number, maxMs: number): number {
  const low = Math.min(minMs, maxMs);
  const high = Math.max(minMs, maxMs);
  return Math.round(low + random() * (high - low));
}

/**
 * Whether an optional step happens this run.
 *
 * `probability >= 1` is always taken and `<= 0` never is, WITHOUT drawing from
 * the generator — so adding a `probability: 1` step to a journey does not shift
 * every later decision and silently change an otherwise identical run.
 */
export function takesStep(random: () => number, probability: number): boolean {
  if (probability >= 1) return true;
  if (probability <= 0) return false;
  return random() < probability;
}
