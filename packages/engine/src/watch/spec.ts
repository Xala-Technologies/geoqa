/**
 * A watch: which pages to visit, from which markets, how often, and whether
 * the server is allowed to start that on its own.
 *
 * This is the operator-controlled surface. The tenant file remains the
 * committed floor — markets they asked about, origins they declared they own.
 * A watch can add origins (the UI's job) and pick a subset of markets; it
 * cannot invent a market the tenant never listed, and it cannot run a
 * state-changing journey unless `allowWrites` is on. Those two refusals are
 * why a typo in the console does not become a bill or a form submitted to
 * production.
 *
 * Stored as YAML under `tenants/<id>/watch.yaml` so it diffs, so a
 * non-engineer can read it, and so the console is not a second author of
 * `tenants/<id>.yaml` (which carries comments the engine must not destroy).
 */
import { z } from "zod";

export const WatchModeSchema = z.enum(["periodic", "continuous"]);

export const WatchSpecSchema = z
  .object({
    tenantId: z.string().min(1),
    enabled: z.boolean(),
    mode: WatchModeSchema,
    /**
     * Minutes between sweep STARTS when `mode` is periodic.
     *
     * A zero would fire on every server tick and spend the proxy allowance
     * in an afternoon. Capped at a day because a number larger than that is
     * almost always a unit mistake (someone typed 86400 thinking seconds).
     */
    everyMinutes: z.number().int().min(5).max(24 * 60),
    /**
     * Seconds to sit idle after a sweep FINISHES when `mode` is continuous.
     *
     * Continuous is "when the last one ended", not "as fast as possible".
     * Five seconds is the floor so a failing sweep cannot tight-loop.
     */
    restSeconds: z.number().int().min(5).max(3600).default(15),
    markets: z.array(z.string().min(1)),
    devices: z.array(z.enum(["mobile", "desktop"])).min(1),
    journeys: z.array(z.string().min(1)),
    /** May be empty: a watch with nothing to hit is paused-in-effect, not invalid. */
    targets: z.array(z.string().url()),
    /**
     * How many scenarios one continuous tick launches.
     *
     * Continuous samples the matrix; it does not dump it. Two is the
     * starting bound — each slot is a residential browser. Periodic still
     * launches the selected axes in full, because the operator named that
     * subset on purpose.
     */
    maxConcurrent: z.number().int().min(1).max(16).default(2),
    allowWrites: z.boolean().default(false),
  })
  .strict();

export type WatchMode = z.infer<typeof WatchModeSchema>;
export type WatchSpec = z.infer<typeof WatchSpecSchema>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const issues = (error: z.ZodError): string[] => error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

export function parseWatch(doc: unknown): ParseResult<WatchSpec> {
  const parsed = WatchSpecSchema.safeParse(doc);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, errors: issues(parsed.error) };
}
