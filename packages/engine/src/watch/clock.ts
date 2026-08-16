/**
 * The watch's clock, persisted so a restarted server does not look like a
 * first sweep.
 *
 * `lastStartedMs` / `lastFinishedMs` live in memory in `watch-loop.ts`. Without
 * this file, every process start is `lastStartedMs === null`, and `decideTick`
 * treats that as "first sweep" — an armed watch would fire the moment the
 * server came back, even if it had run five minutes earlier. The interval is
 * a promise to the operator; forgetting it across a restart is a silent
 * extra bill.
 *
 * Under the evidence root, not next to `watch.yaml`. The spec is what to run;
 * the clock is a fact about what already ran. Mixing them would make a git
 * pull reset the cadence.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ParseResult } from "./spec.js";

export interface WatchClock {
  lastStartedMs: number | null;
  lastFinishedMs: number | null;
  /**
   * Next scenario index in the expanded matrix. Continuous mode walks
   * this instead of launching every combination. Default 0 so a clock
   * written before the cursor existed is "start of the matrix", not an error.
   */
  cursor: number;
}

const ClockSchema = z
  .object({
    lastStartedMs: z.number().nonnegative().nullable(),
    lastFinishedMs: z.number().nonnegative().nullable(),
    cursor: z.number().int().nonnegative().default(0),
  })
  .strict();

const issues = (error: z.ZodError): string[] => error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

export const emptyClock = (): WatchClock => ({ lastStartedMs: null, lastFinishedMs: null, cursor: 0 });

export function watchClockPath(evidenceRoot: string): string {
  return path.join(evidenceRoot, "watch-clock.json");
}

export function parseWatchClock(doc: unknown): ParseResult<WatchClock> {
  const parsed = ClockSchema.safeParse(doc);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, errors: issues(parsed.error) };
}

export function loadWatchClock(
  file: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): ParseResult<WatchClock> {
  let text: string;
  try {
    text = read(file);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { ok: true, value: emptyClock() };
    return { ok: false, errors: [`${file}: ${err.message}`] };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`${file}: ${(e as Error).message}`] };
  }
  const parsed = parseWatchClock(doc);
  return parsed.ok ? parsed : { ok: false, errors: parsed.errors.map((e) => `${file}: ${e}`) };
}

export function saveWatchClock(
  file: string,
  clock: WatchClock,
  write: (p: string, text: string) => void = (p, text) => {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text, "utf8");
  },
): void {
  write(file, `${JSON.stringify(clock, null, 2)}\n`);
}
