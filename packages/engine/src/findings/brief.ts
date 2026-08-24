/**
 * The words on an issue or a PR.
 *
 * Counts and names only. A root cause that guesses CSS or a missing
 * React key is the same defect as a dashboard showing 0 for a null LCP.
 */

export interface BriefParts {
  problem: string;
  what: string;
  rootCause: string;
  notThis: string;
  observed: string;
  next: string;
  breaking: string;
  evidence: string;
}

export interface BriefSection {
  heading: string;
  text: string;
}

/** Split a filed body into the sections a console can render one panel at a time. */
export function parseBrief(body: string): BriefSection[] {
  const trimmed = body.trim();
  if (trimmed === "") return [];
  if (!/^## /m.test(trimmed)) return [{ heading: "Problem", text: trimmed }];
  const sections: BriefSection[] = [];
  let heading = "";
  let buf: string[] = [];
  const flush = (): void => {
    if (heading === "") return;
    sections.push({ heading, text: buf.join("\n").trim() });
  };
  for (const line of trimmed.split("\n")) {
    const match = /^## (.+)$/.exec(line);
    if (match?.[1] !== undefined) {
      flush();
      heading = match[1];
      buf = [];
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
}

export function formatBrief(parts: BriefParts): string {
  return [
    "## Problem",
    parts.problem,
    "",
    "## What this is",
    parts.what,
    "",
    "## Root cause",
    parts.rootCause,
    "",
    "## What this is not",
    parts.notThis,
    "",
    "## What we saw",
    parts.observed,
    "",
    "## Suggested next step",
    parts.next,
    "",
    "## Breaking changes",
    parts.breaking,
    "",
    "## Evidence",
    parts.evidence,
  ].join("\n");
}

const marketOf = (profileId: string): string => profileId.replace(/-(mobile|desktop)$/, "");

const listed = (values: string[]): string => [...new Set(values)].sort().join(", ");

export function seenLine(runs: { profileId: string; journeyId: string; verdict: string }[]): string {
  const n = runs.length;
  return `${n} ${n === 1 ? "run" : "runs"}. Markets: ${listed(runs.map((r) => marketOf(r.profileId)))}. Journeys: ${listed(runs.map((r) => r.journeyId))}. Verdicts: ${listed(runs.map((r) => r.verdict))}.`;
}

/**
 * What a second model and the target repo's own checks said about this diff.
 *
 * Optional because `findings repair` has neither and must keep printing the
 * body it always printed. When it IS present the wording is deliberately flat:
 * a model approving another model's diff is a filter, not an approval, and a PR
 * that implied otherwise would manufacture exactly the confidence this is meant
 * to avoid.
 */
export interface PrReviewNote {
  verdict: "approve" | "reject";
  verifyState: "passed" | "failed" | "skipped";
  steps: { name: string; exitCode: number }[];
}

const reviewBlock = (note: PrReviewNote): string => {
  const rows =
    note.steps.length === 0
      ? ["| — | — |"]
      : note.steps.map((step) => `| \`${step.name}\` | ${step.exitCode === 0 ? "pass" : `exit ${step.exitCode}`} |`);
  const verify =
    note.verifyState === "passed"
      ? "This repository's own checks ran in the clone and passed."
      : note.verifyState === "skipped"
        ? "This repository defines no checks this agent could run, so NOTHING was verified. A human must read the diff."
        : "This repository's own checks failed.";
  return [
    "",
    "## Review",
    `Reviewed by a second model, not a human. Verdict: **${note.verdict}**.`,
    "The reviewer could not edit the checkout and answered from the issue and the diff only.",
    "",
    verify,
    "No check, threshold or lint rule in this repository was changed to make this diff pass — a fix that needed that is rejected before it reaches a branch.",
    "",
    "| Step | Result |",
    "|---|---|",
    ...rows,
  ].join("\n");
};

export function prBody(
  job: {
    title: string;
    body: string;
    issueUrl: string;
    site: string;
    codeRepo: string;
    base: string;
  },
  note?: PrReviewNote,
): string {
  const brief = job.body.includes("## Problem") ? job.body : `## Problem\n${job.title}\n\n${job.body}`;
  const breaking = job.body.includes("## Breaking changes")
    ? ""
    : [
        "",
        "## Breaking changes",
        "Review this diff. Restoring a missing check is typically additive. Removing or renaming a route, API, auth flow, or locale string is breaking — re-run the other markets before merge. geoqa does not classify the diff; a human does.",
      ].join("\n");
  return [
    brief,
    "",
    "---",
    "",
    "## Change",
    `Opened by geoqa after a watch finding on **${job.site}**. Proposed fix in \`${job.codeRepo}\` from \`${job.base}\`. The issue is the authority — review the diff against that brief.`,
    "If this diff removes a public route, API, or locale string, treat it as breaking even when the finding looked additive.",
    breaking,
    ...(note === undefined ? [] : [reviewBlock(note)]),
    "",
    `Fixes ${job.issueUrl}`,
  ].join("\n");
}
