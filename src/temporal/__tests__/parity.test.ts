import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The guard for gaps D-5: an improvement to one execution mode that the other silently does not
 * receive.
 *
 * Six behaviours had drifted apart before anyone noticed, because nothing could START a durable
 * run — so nothing exercised the omissions. The worst of them was introduced by the fix for B-3
 * on the very day it landed: the HAR prune went into `executeRun`'s teardown and not into
 * `closeSession`, leaving a durable passing run with an unlisted network recording on disk.
 *
 * A behavioural test cannot catch this class. Both modes pass their own tests precisely because
 * each is asserted against what it does. What catches it is naming the shared functions and
 * requiring BOTH callers to reach them — so a seventh behaviour added to one side and not the
 * other fails here rather than in six months.
 *
 * Deliberately a source check rather than a mock-call assertion: the point is that there is ONE
 * implementation, and a test that stubbed the function would pass against two copies of it.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(path.join(here, "..", "..", rel), "utf8");

/**
 * Every behaviour a run performs that is NOT the journey itself, and where it lives.
 *
 * Adding a row is the cheap half. The expensive half — the one this file exists to force — is
 * that adding a behaviour to `executeRun` without a home in `stages.ts` or an activity means
 * the durable path silently does less, and the run that notices is somebody's overnight sweep.
 */
const SHARED = [
  { what: "runs the journey N times and merges the attempts", fn: "repeatJourney" },
  { what: "confirms the egress held for the whole run", fn: "closeEgress" },
  { what: "writes the evidence package", fn: "collectEvidence" },
  { what: "assembles the run result", fn: "assembleResult" },
  { what: "deletes a HAR the manifest does not retain", fn: "pruneUnlistedHar" },
];

describe("the two execution modes call the same implementations", () => {
  const local = read("run/execute.ts");
  const durable = read("temporal/activities.ts");

  it.each(SHARED)("both reach $fn — $what", ({ fn }) => {
    expect(local, `executeRun does not call ${fn}`).toContain(fn);
    expect(durable, `no activity calls ${fn}, so a durable run skips it`).toContain(fn);
  });

  it("the durable path records the provider outcome and the run history", () => {
    // Neither existed on the durable side: a vendor that failed a durable sweep was never
    // frozen, and the run never entered runs.jsonl — invisible to `geoqa runs`, to the trends
    // and to regression detection.
    expect(durable).toContain("noteProviderOutcome");
    expect(durable).toContain("appendRun");
    expect(local).toContain("noteProviderOutcome");
    expect(local).toContain("appendRun");
  });

  it("the durable path records what kind of visitor it actually tested", () => {
    // Without it, durable evidence carried `visitorType: returning` off the profile whether or
    // not a session was restored — the declaration, not the observation.
    expect(durable).toContain("resolveVisitorState");
    expect(local).toContain("resolveVisitorState");
  });

  it("neither mode reimplements the journey repeat loop", () => {
    // `mergeAttempts` belongs to `repeatJourney` now. A caller doing its own merge is the exact
    // shape of the drift this file guards: two copies that agree until one is improved.
    expect(local, "executeRun merges attempts itself again").not.toContain("mergeAttempts(");
    expect(durable, "an activity merges attempts itself again").not.toContain("mergeAttempts(");
  });
});
