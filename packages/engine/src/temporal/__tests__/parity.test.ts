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
describe("there is only ONE run implementation", () => {
  const durable = read("temporal/activities.ts");
  const workflow = read("temporal/workflows.ts");

  it("the durable path calls executeRun itself, not a re-sequencing of it", () => {
    // The guard that replaced a list of shared functions. Six behaviours had drifted apart while
    // the durable path re-sequenced `executeRun` by hand (D-5), and the re-sequencing was ALSO
    // wrong in a way no list could catch: each step built its own browser, so the run was split
    // across four of them (D-6). Both classes disappear when there is one implementation.
    expect(durable).toContain("executeRun(");
  });

  it("the workflow orchestrates and does not reimplement", () => {
    // A workflow that grew a second browser-touching activity would be re-splitting the session
    // a browser cannot survive being split across. `prepare` is the one exception and touches no
    // browser.
    const activities = [...workflow.matchAll(/const \{ ([^}]+) \} = proxyActivities/g)]
      .flatMap((m) => (m[1] ?? "").split(",").map((n) => n.trim()))
      .filter((n) => n !== "");
    expect(activities.toSorted()).toEqual(["executeRunActivity", "prepare"]);
  });

  it("neither path reimplements the journey repeat loop", () => {
    // `mergeAttempts` belongs to `repeatJourney`, which `executeRun` calls. A caller merging
    // attempts itself is the shape of drift this file exists for.
    expect(read("run/execute.ts"), "executeRun merges attempts itself again").not.toContain("mergeAttempts(");
    expect(durable, "an activity merges attempts itself again").not.toContain("mergeAttempts(");
  });
});
