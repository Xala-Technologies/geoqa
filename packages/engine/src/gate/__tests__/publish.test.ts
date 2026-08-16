import { describe, expect, it } from "vitest";
import { actionableFindings, gateExitCode, gateFromRun, gateWithoutRun } from "../publish.js";
import type { Finding, GeoQaRunResult } from "../../findings/types.js";

const finding = (over: Partial<Finding> = {}): Finding =>
  ({
    id: "f1",
    title: "has a primary heading",
    severity: "critical",
    category: "functional",
    expected: "h1 is visible",
    observed: "not visible",
    stepLabel: "has a primary heading",
    ...over,
  }) as Finding;

const run = (over: Partial<GeoQaRunResult> = {}): GeoQaRunResult =>
  ({
    runId: "run_1_oslo-desktop",
    evidenceId: "ev_1_oslo-desktop",
    verdict: "PASS",
    findings: [],
    confidence: { overall: 100, geo: 100, browser: 100, journey: 100, evidence: 100, searchObservation: null, notes: [] },
    ...over,
  }) as GeoQaRunResult;

describe("gateFromRun", () => {
  it("ALLOWS a clean, confident run", () => {
    const gate = gateFromRun(run());
    expect(gate.decision).toBe("allow");
    expect(gate.blockers).toEqual([]);
    expect(gate.runId).toBe("run_1_oslo-desktop");
    expect(gate.evidenceId).toBe("ev_1_oslo-desktop");
  });

  it("BLOCKS on a measured problem at or above the floor, and quotes it", () => {
    const gate = gateFromRun(run({ verdict: "FAIL", findings: [finding()] }));
    expect(gate.decision).toBe("block");
    expect(gate.blockers[0]).toContain("has a primary heading");
    expect(gate.blockers[0]).toContain("expected h1 is visible");
  });

  it("records a lower-severity finding as a WARNING rather than dropping it", () => {
    // A gate that silently discarded everything below its floor would make the floor
    // invisible to whoever set it.
    const gate = gateFromRun(run({ findings: [finding({ severity: "low" })] }));
    expect(gate.decision).toBe("allow");
    expect(gate.warnings[0]).toContain("[low]");
    expect(gate.reason).toContain("1 lower-severity finding(s) recorded");
  });

  it("honours the severity floor in both directions", () => {
    const medium = run({ findings: [finding({ severity: "medium" })] });
    expect(gateFromRun(medium).decision).toBe("allow");
    expect(gateFromRun(medium, { blockAtOrAbove: "medium" }).decision).toBe("block");
    expect(gateFromRun(run({ findings: [finding({ severity: "critical" })] }), { blockAtOrAbove: "critical" }).decision).toBe("block");
  });

  it("is UNKNOWN, not block, when instrumentation failed — that is OUR defect", () => {
    // Telling an author their page is broken when the truth is that our browser could not
    // read it wastes their time and costs the gate its credibility.
    const gate = gateFromRun(run({ verdict: "ERROR", findings: [finding({ category: "instrumentation", title: "open page" })] }));
    expect(gate.decision).toBe("unknown");
    expect(gate.reason).toContain("geoqa defect, not a problem with the page");
    expect(gate.blockers[0]).toContain("could not verify");
  });

  it("is UNKNOWN on an instrumentation finding even when the verdict is not ERROR", () => {
    // A run can pass overall while one step went unread. That step is still an unknown, and
    // an unknown must not be averaged into an allow.
    expect(gateFromRun(run({ findings: [finding({ category: "instrumentation" })] })).decision).toBe("unknown");
  });

  it("does NOT allow on an ERROR verdict, whatever the findings say", () => {
    expect(gateFromRun(run({ verdict: "ERROR" })).decision).toBe("unknown");
  });

  it("blocks on low overall confidence even with no findings at all", () => {
    // A run with nothing to report and readings nobody should trust is not an approval.
    const gate = gateFromRun(run({ confidence: { overall: 55, geo: 100, browser: 100, journey: 100, evidence: 100, searchObservation: null, notes: [] } }));
    expect(gate.decision).toBe("block");
    expect(gate.blockers[0]).toContain("not trustworthy enough");
  });

  it("only checks geographic confidence when asked to", () => {
    // Most pages are not market-specific, so a geo floor is opt-in — but for a page whose
    // whole point is a market it is the check that matters.
    const weakGeo = run({ confidence: { overall: 90, geo: 40, browser: 100, journey: 100, evidence: 100, searchObservation: null, notes: [] } });
    expect(gateFromRun(weakGeo).decision).toBe("allow");
    expect(gateFromRun(weakGeo, { minGeoConfidence: 80 }).decision).toBe("block");
  });

  it("reports EVERY blocker, not just the first", () => {
    const gate = gateFromRun(
      run({
        findings: [finding(), finding({ id: "f2", title: "no 5xx", severity: "high" })],
        confidence: { overall: 20, geo: 100, browser: 100, journey: 100, evidence: 100, searchObservation: null, notes: [] },
      }),
    );
    expect(gate.blockers).toHaveLength(3);
  });
});

describe("gateWithoutRun", () => {
  it("is UNKNOWN and says the absence of a verdict is not a verdict", () => {
    // Exists so a caller cannot express "publish without checking" by omission.
    const gate = gateWithoutRun("the URL was unreachable");
    expect(gate.decision).toBe("unknown");
    expect(gate.reason).toContain("absence of a verdict is not a verdict");
    expect(gate.blockers).toEqual(["the URL was unreachable"]);
    expect(gate.runId).toBeNull();
  });
});

describe("gateExitCode", () => {
  it("is 0 ONLY for allow — unknown must not publish", () => {
    // A publisher conditioning on this cannot accidentally publish on a run that could not
    // be read.
    expect(gateExitCode(gateFromRun(run()))).toBe(0);
    expect(gateExitCode(gateFromRun(run({ findings: [finding()] })))).toBe(1);
    expect(gateExitCode(gateWithoutRun("nothing ran"))).toBe(1);
    expect(gateExitCode(gateFromRun(run({ verdict: "ERROR" })))).toBe(1);
  });
});

describe("actionableFindings", () => {
  it("excludes instrumentation findings — a producer cannot fix our browser", () => {
    const findings = actionableFindings(run({ findings: [finding({ category: "instrumentation" }), finding({ id: "f2" })] }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("f2");
  });

  it("orders worst first, so a truncated list keeps what matters", () => {
    const findings = actionableFindings(
      run({
        findings: [
          finding({ id: "low", severity: "low" }),
          finding({ id: "crit", severity: "critical" }),
          finding({ id: "med", severity: "medium" }),
        ],
      }),
    );
    expect(findings.map((f) => f.id)).toEqual(["crit", "med", "low"]);
  });
});
