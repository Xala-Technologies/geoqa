/**
 * A durable sweep, end to end: a REAL Temporal server, a real worker running the REAL
 * activities, a real Chromium, a real HTTP fixture, and real evidence on disk.
 *
 * This is the one claim `docs/gaps.md` explicitly refused to make. D-2 proved a client can start
 * a workflow; D-5 proved both execution modes call the same functions. Neither proved that a
 * durable run actually produces what a local run produces — the parity was structural, and a
 * structural guard cannot tell you that the evidence tree comes out right.
 *
 * It matters because the durable path's activities each rebuild their own runtime from the spec,
 * rather than sharing one `BrowserRuntime` the way `executeRun` does. That is a real difference
 * in execution, not just in orchestration, and nothing until now had exercised it against an
 * actual browser.
 *
 * Separate file from `playwright-run.e2e.ts` so a machine without a Temporal test server can
 * still run the browser suite.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServer } from "../src/fixtures/server.js";
import * as activities from "../src/temporal/activities.js";
import { durableMatrix, type TemporalConnector } from "../src/temporal/client.js";
import { TASK_QUEUE } from "../src/temporal/constants.js";
import type { GeoQaRunInput } from "../src/temporal/workflows.js";
import type { RunSpec } from "../src/run/context.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowsPath = path.join(repoRoot, "src", "temporal", "workflows.ts");

let env: TestWorkflowEnvironment;
let fixtures: FixtureServer;
let evidenceRoot: string;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
  fixtures = await startFixtureServer();
  evidenceRoot = mkdtempSync(path.join(tmpdir(), "geoqa-durable-"));
}, 180_000);

afterAll(async () => {
  await fixtures?.close();
  await env?.teardown();
  rmSync(evidenceRoot, { recursive: true, force: true });
});

const baseSpec = (runId: string, target: string): GeoQaRunInput["base"] => ({
  runId,
  engine: "playwright",
  seed: 7,
  corroborateGeo: false,
  target,
  profilePath: path.join(repoRoot, "profiles", "oslo-mobile.yaml"),
  journeyPath: path.join(repoRoot, "journeys", "landing-page.yaml"),
  evidenceRoot,
  vars: {},
  headed: false,
  verifyEndpoint: `${fixtures.origin}/ipinfo`,
});

const connector = (): TemporalConnector => ({
  connect: () => Promise.resolve({ client: env.client as never, close: () => Promise.resolve() }),
});

const runDurable = async (runs: GeoQaRunInput[], workflowId: string) => {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath,
    // The REAL activities, not stubs. Every other Temporal test in this repo substitutes them.
    activities,
  });
  return worker.runUntil(durableMatrix(runs, { connector: connector(), workflowId, concurrency: 2 }));
};

const evidenceFile = (runId: string, file: string): string => path.join(evidenceRoot, runId, file);

describe("a durable sweep, against a real browser and a real site", () => {
  let out: Awaited<ReturnType<typeof runDurable>>;

  beforeAll(async () => {
    out = await runDurable(
      [
        { base: baseSpec("d_healthy", `${fixtures.origin}/healthy`), providerName: "direct", startedAt: "2026-08-13T00:00:00.000Z" },
        { base: baseSpec("d_missing", `${fixtures.origin}/missing-cta`), providerName: "direct", startedAt: "2026-08-13T00:00:00.000Z" },
      ],
      "wf-durable-e2e-1",
    );
  }, 300_000);

  it("produces the same verdicts a local run produces", () => {
    // /healthy passes and /missing-cta has no h1, which the landing-page journey asserts at
    // critical severity. Identical to the in-process suite's expectations, which is the point:
    // the execution mode must not change the finding.
    expect(out.results.map((r) => r.result.verdict)).toEqual(["PASS", "FAIL"]);
    expect(out.results[1]?.result.findings.some((f) => f.title.includes("heading"))).toBe(true);
  });

  it("reports NO instrumentation findings — the activities really drove a browser", () => {
    // Each activity rebuilds its own runtime from the spec rather than sharing one, which is a
    // real difference from `executeRun`. If that were broken, it would surface here as our
    // defect rather than as a site finding.
    for (const r of out.results) {
      expect(r.result.findings.filter((f) => f.category === "instrumentation")).toEqual([]);
    }
  });

  it("writes a real evidence package, with the visitor state a durable run used to omit", () => {
    // `resolveVisitorState` reached durable evidence only in the D-5 fix. Before it, a durable
    // run recorded the profile's DECLARATION whether or not a session had been restored.
    const run = JSON.parse(readFileSync(evidenceFile("d_healthy", "run.json"), "utf8")) as {
      visitor?: { declared: string; restored: boolean };
      journey: { verdict: string };
    };
    expect(existsSync(evidenceFile("d_healthy", "manifest.json"))).toBe(true);
    expect(run.journey.verdict).toBe("PASS");
    expect(run.visitor).toEqual({ declared: "anonymous", restored: false, unmet: null });
  });

  it("DELETES the unlisted HAR on a passing tier, which it used to leave behind", () => {
    // The divergence introduced by the B-3 fix itself: the prune went into `executeRun`'s
    // teardown and not into `closeSession`, so a durable passing run left a full network
    // recording on disk that no manifest listed — and nothing walks unlisted files.
    expect(existsSync(evidenceFile("d_healthy", "network.har"))).toBe(false);
    // The failing tier RETAINS one, so this is not simply "never writes a HAR".
    expect(existsSync(evidenceFile("d_missing", "network.har"))).toBe(true);
  });

  it("appends both runs to the history index, which a durable run used to skip", () => {
    // Without this a durable sweep was invisible to `geoqa runs`, to the trends and to
    // regression detection — it happened, and left no trace where a human looks across runs.
    const lines = readFileSync(path.join(evidenceRoot, "runs.jsonl"), "utf8").trim().split("\n");
    const ids = lines.map((l) => (JSON.parse(l) as { runId: string }).runId);
    expect(ids).toContain("d_healthy");
    expect(ids).toContain("d_missing");
  });

  /**
   * The assertions that were `unverified` and `null` before gaps D-6 was fixed.
   *
   * `playwrightOpener` launches a NEW browser on every use, and the workflow used to build one
   * runtime per activity — so `verifyGeoActivity`, `runJourneyActivity`,
   * `verifyEgressHeldActivity` and `collectEvidenceActivity` each got a DIFFERENT browser. The
   * closing egress read ran in a context that never visited the site, and evidence was collected
   * from a blank one.
   *
   * The run is one activity now, and it is `executeRun` itself. These two assertions are the
   * only way to know that: both were measured wrong first, and neither a unit test nor the
   * structural parity guard could see it — the guard compared which FUNCTIONS each mode calls,
   * and both called the same ones. What differed was what the runtime handed to them had seen.
   */
  it("verifies the egress HELD for the whole run — one run is one browser again", () => {
    expect(out.results[0]?.result.geo.network.egressHeld.verdict).toBe("match");
  });

  it("records REAL vitals, from the context that actually loaded the page", () => {
    const vitals = JSON.parse(readFileSync(evidenceFile("d_healthy", "vitals.json"), "utf8")) as {
      lcp: number | null;
      ttfb: number | null;
    };
    // A real LCP from a real Chromium against a real fixture. Null here is the D-6 symptom.
    expect(vitals.lcp).toBeGreaterThan(0);
    expect(vitals.ttfb).not.toBeNull();
  });

  it("matches what the in-process runner reports for the same page", () => {
    // The claim the whole file exists for: the execution mode must not change the finding.
    // `playwright-run.e2e.ts` asserts PASS with no findings and 100 evidence confidence for
    // /healthy; this is the durable path saying the same thing.
    expect(out.results[0]?.result.confidence.evidence).toBe(100);
    expect(out.results[0]?.result.findings).toEqual([]);
  });
});
