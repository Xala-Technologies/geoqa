import { describe, expect, it } from "vitest";
import { formatIssueBrief, issuesFromSteps, parseConsoleLog } from "../issue.js";

const failed = {
  label: "cls-below",
  outcome: "failed",
  severity: "medium",
  detail: "cls-below: expected CLS below 0.1, observed 0.12",
  expected: "CLS < 0.1",
  observed: "0.12",
};

describe("issuesFromSteps", () => {
  it("keeps failed and errored steps, and drops a pass", () => {
    const issues = issuesFromSteps([
      { ...failed, label: "title-exists", outcome: "passed", detail: "ok", expected: null, observed: "Digilist" },
      failed,
      {
        label: "open target",
        outcome: "errored",
        severity: "critical",
        detail: "open failed: timeout",
        expected: null,
        observed: null,
      },
    ]);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      label: "cls-below",
      outcome: "failed",
      reason: "Expected CLS < 0.1, observed 0.12",
    });
    expect(issues[1]?.reason).toContain("Could not verify");
    expect(issues[1]?.reason).toContain("open failed: timeout");
  });
});

describe("parseConsoleLog", () => {
  it("reads messages and treats a missing or null log as empty, not clean", () => {
    expect(parseConsoleLog([{ type: "error", text: "boom" }, { type: "log", text: "ok" }])).toEqual([
      { type: "error", text: "boom" },
      { type: "log", text: "ok" },
    ]);
    expect(parseConsoleLog(null)).toEqual([]);
    expect(parseConsoleLog("nope")).toEqual([]);
    expect(parseConsoleLog([{ text: "only text" }])).toEqual([{ type: "log", text: "only text" }]);
  });
});

describe("formatIssueBrief — the text someone pastes into a ticket", () => {
  it("names the failure, the reason, and the page console", () => {
    const text = formatIssueBrief({
      runId: "run_1_alesund-desktop",
      target: "https://digilist.no",
      journeyId: "landing-page",
      verdict: "PASS_WITH_WARNINGS",
      issues: issuesFromSteps([failed]),
      console: [
        { type: "error", text: "Uncaught TypeError: x is not a function" },
        { type: "log", text: "hydrated" },
      ],
    });
    expect(text).toContain("PASS_WITH_WARNINGS");
    expect(text).toContain("https://digilist.no");
    expect(text).toContain("landing-page");
    expect(text).toContain("Expected CLS < 0.1, observed 0.12");
    expect(text).toContain("error: Uncaught TypeError: x is not a function");
    expect(text).toContain("log: hydrated");
    expect(text).toContain("run_1_alesund-desktop");
  });

  it("says when the console was not recorded, rather than implying it was clean", () => {
    const text = formatIssueBrief({
      runId: "run_1",
      target: "https://x",
      journeyId: "browse",
      verdict: "FAIL",
      issues: issuesFromSteps([failed]),
      console: [],
    });
    expect(text).toContain("console was not recorded");
  });
});
