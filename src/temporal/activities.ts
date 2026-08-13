/**
 * Activities — every piece of real I/O in a run. There are two.
 *
 * Each is a thin wrapper that delegates to `src/run/`. The judgement lives there, at 100%
 * coverage; this file is deliberately dumb, and is coverage-excluded for that reason.
 *
 * **The comment this replaces was the cause of gaps D-6, and it is worth keeping the correction
 * visible.** It said: *rebuilding the runtime per activity is not a workaround, it is the
 * correct model here — agent-browser is a daemon, so the browser survives between activities and
 * is addressed by its launch flags rather than held as a handle.*
 *
 * That is TRUE of agent-browser and FALSE of Playwright, which launches a new browser on every
 * opener call. The browser seam makes the two look identical from above — which is its whole
 * purpose — so a fact about one engine got recorded as a fact about the model. Six activities
 * later, a durable run was split across four browsers: the closing egress read ran in a context
 * that never visited the site, and evidence was collected from a blank one. Measured against a
 * real Chromium, `vitals.json` recorded a null LCP for a page that had demonstrably rendered.
 *
 * So the run is ONE activity, and it is literally `executeRun` — the same function the CLI
 * calls. A browser session cannot cross an activity boundary on either engine, because an
 * activity may be retried on a different worker; the daemon only made that survivable by
 * accident, and never for Playwright. `prepare` stays separate because it opens no browser.
 */
import { loadGeoProfile } from "../geo/profile.js";
import { StageError } from "../run/stages.js";
import type { GeoQaRunResult } from "../findings/types.js";
import { selectProvider } from "../network/provider.js";
import { type RunSpec } from "../run/context.js";
import { executeRun, prepareRun } from "../run/execute.js";

const profileOf = (spec: RunSpec) => {
  const loaded = loadGeoProfile(spec.profilePath);
  if (!loaded.ok) throw new StageError(`invalid profile: ${loaded.errors.join("; ")}`, "load");
  return loaded.value;
};

export interface PrepareArgs {
  base: Omit<RunSpec, "proxyUrl" | "proxyBypass" | "initScriptPath">;
  providerName: string;
  cooldownPath?: string;
}

export async function prepare(args: PrepareArgs): Promise<{ spec: RunSpec; warnings: string[] }> {
  const { provider, warning } = selectProvider(args.providerName, {
    ...(args.cooldownPath ? { cooldownPath: args.cooldownPath } : {}),
  });
  const prepared = await prepareRun(args.base, provider, Date.now());
  return { spec: prepared.spec, warnings: warning ? [warning, ...prepared.warnings] : prepared.warnings };
}











/**
 * The WHOLE run, in one activity, sharing one browser — because it has to.
 *
 * **The defect this replaces (gaps D-6).** Each activity built its own runtime from the spec,
 * and `playwrightOpener` launches a new browser on every use. So `verifyGeoActivity`,
 * `runJourneyActivity`, `verifyEgressHeldActivity` and `collectEvidenceActivity` each got a
 * DIFFERENT browser. Measured against a real Chromium: the closing egress read ran in a context
 * that never visited the site, so the axis came back `unverified`; and evidence was collected
 * from a blank context, so `vitals.json` recorded null LCP for a page that had demonstrably
 * rendered. The durable path's evidence described a browser that had never been anywhere.
 *
 * "One journey is one network session" is the invariant the entire geographic claim rests on,
 * and a run split across four browsers has no single session for it to be true of. There is no
 * arrangement of per-step activities that fixes that: a browser session cannot cross an activity
 * boundary, because an activity may be retried on a different worker.
 *
 * **So the whole run is one activity, and it is literally `executeRun`.** Not a re-sequencing of
 * it — the same function the CLI calls. That is invariant 12 achieved rather than approximated,
 * and it makes the D-5 class of drift structurally impossible: there is no second copy to
 * diverge.
 *
 * **What this costs, stated plainly.** Per-step retry granularity: a flaky geo read used to
 * retry alone and now restarts the run. That granularity was never sound here — a retried step
 * ran in a fresh browser, which is the bug above, so what looked like fine-grained durability
 * was fine-grained incorrectness. The durability that matters at matrix scale is per-SCENARIO,
 * and that is preserved: each run is still its own child workflow with its own history.
 *
 * The provider is rebuilt from its NAME rather than passed, because a provider holds functions
 * and an activity argument must be serialisable — the same reason `prepare` takes a name.
 */
export interface ExecuteRunArgs {
  spec: RunSpec;
  providerName: string;
  startedAt: string;
  repeat?: number;
  cooldownPath?: string;
  cooldownMs?: number;
  tenantId?: string | null;
}

export async function executeRunActivity(args: ExecuteRunArgs): Promise<GeoQaRunResult> {
  const { provider } = selectProvider(args.providerName, {
    ...(args.cooldownPath ? { cooldownPath: args.cooldownPath } : {}),
  });
  return executeRun({
    spec: args.spec,
    provider,
    // A workflow may not read the clock, so the run's own timestamp comes from the input it was
    // started with — and `executeRun` uses it for the cooldown window, which must not differ
    // between an execution and its replay.
    now: () => Date.parse(args.startedAt),
    repeat: args.repeat ?? 1,
    ...(args.cooldownPath ? { cooldownPath: args.cooldownPath } : {}),
    ...(args.cooldownMs !== undefined ? { cooldownMs: args.cooldownMs } : {}),
    ...(args.tenantId !== undefined && args.tenantId !== null ? { tenantId: args.tenantId } : {}),
  });
}




