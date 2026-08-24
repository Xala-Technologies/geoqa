import { describe, expect, it } from "vitest";
import { formatBrief, parseBrief, prBody, seenLine } from "../brief.js";

describe("formatBrief", () => {
  it("is a short brief with named sections, not a table alone", () => {
    const text = formatBrief({
      problem: "the check failed",
      what: "a site finding",
      rootCause: "the assertion did not hold",
      notThis: "not a proxy miss",
      observed: "2 runs",
      next: "open the run",
      breaking: "none expected in the product",
      evidence: "| a |",
    });
    expect(text).toContain("## Problem");
    expect(text).toContain("the check failed");
    expect(text).toContain("## Root cause");
    expect(text).toContain("## What this is not");
    expect(text).toContain("## Breaking changes");
    expect(text).toContain("none expected");
    expect(text).toContain("| a |");
  });

  it("splits a brief into named sections, and a thin body is still a Problem", () => {
    const sections = parseBrief(
      formatBrief({
        problem: "the check failed",
        what: "a site finding",
        rootCause: "the assertion did not hold",
        notThis: "not a proxy miss",
        observed: "2 runs",
        next: "open the run",
        breaking: "additive",
        evidence: "| a |",
      }),
    );
    expect(sections.map((s) => s.heading)).toEqual([
      "Problem",
      "What this is",
      "Root cause",
      "What this is not",
      "What we saw",
      "Suggested next step",
      "Breaking changes",
      "Evidence",
    ]);
    expect(sections.find((s) => s.heading === "Breaking changes")?.text).toBe("additive");
    expect(parseBrief("one line from an old ticket")).toEqual([{ heading: "Problem", text: "one line from an old ticket" }]);
    expect(parseBrief("")).toEqual([]);
    expect(parseBrief("preamble\n## Problem\nlater")).toEqual([{ heading: "Problem", text: "later" }]);
  });
});

describe("seenLine", () => {
  it("names counts, markets and journeys without inventing a host", () => {
    expect(
      seenLine([
        { profileId: "bergen-desktop", journeyId: "search", verdict: "FAIL" },
        { profileId: "tromso-desktop", journeyId: "search", verdict: "FAIL" },
      ]),
    ).toBe("2 runs. Markets: bergen, tromso. Journeys: search. Verdicts: FAIL.");
    expect(seenLine([{ profileId: "oslo-desktop", journeyId: "login", verdict: "ERROR" }])).toBe(
      "1 run. Markets: oslo. Journeys: login. Verdicts: ERROR.",
    );
  });
});

describe("prBody", () => {
  it("repeats the issue brief and adds a Change section that names the repo", () => {
    const text = prBody({
      title: "has a search box on xala.no",
      body: "## Problem\nvisitors missed the search box",
      issueUrl: "https://github.com/x/y/issues/9",
      site: "xala.no",
      codeRepo: "x/y",
      base: "dev",
    });
    expect(text).toContain("## Problem");
    expect(text).toContain("visitors missed the search box");
    expect(text).toContain("## Change");
    expect(text).toContain("x/y");
    expect(text).toContain("dev");
    expect(text).toContain("Fixes https://github.com/x/y/issues/9");
    expect(text).toContain("## Breaking changes");
    const thin = prBody({
      title: "thin title",
      body: "one line",
      issueUrl: "https://github.com/x/y/issues/1",
      site: "xala.no",
      codeRepo: "x/y",
      base: "main",
    });
    expect(thin).toContain("## Problem\nthin title");
    expect(thin).toContain("one line");
  });
});

describe("prBody — the review note", () => {
  const job = {
    title: "Meta description is 187 characters",
    body: "## Problem\ntoo long",
    issueUrl: "https://github.com/x/y/issues/343",
    site: "digilist.no",
    codeRepo: "x/y",
    base: "main",
  };

  it("prints nothing at all when there was no review — `findings repair` keeps its old body", () => {
    expect(prBody(job)).not.toContain("## Review");
  });

  it("says a MODEL reviewed it, never a human, and states that no check was weakened", () => {
    const text = prBody(job, {
      verdict: "approve",
      verifyState: "passed",
      steps: [
        { name: "install", exitCode: 0 },
        { name: "test", exitCode: 0 },
      ],
    });
    expect(text).toContain("## Review");
    expect(text).toContain("Reviewed by a second model, not a human");
    expect(text).toContain("could not edit the checkout");
    expect(text).toContain("This repository's own checks ran in the clone and passed.");
    expect(text).toContain("No check, threshold or lint rule in this repository was changed to make this diff pass");
    expect(text).toContain("| `install` | pass |");
    expect(text).toContain("| `test` | pass |");
  });

  it("says in words that a SKIPPED verify verified nothing, rather than implying a pass", () => {
    const text = prBody(job, { verdict: "approve", verifyState: "skipped", steps: [] });
    expect(text).toContain("NOTHING was verified");
    expect(text).toContain("A human must read the diff.");
    expect(text).toContain("| — | — |");
  });

  it("prints a non-zero exit code rather than the word pass", () => {
    const text = prBody(job, { verdict: "approve", verifyState: "failed", steps: [{ name: "test", exitCode: 1 }] });
    expect(text).toContain("This repository's own checks failed.");
    expect(text).toContain("| `test` | exit 1 |");
  });
});
