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

export function prBody(job: {
  title: string;
  body: string;
  issueUrl: string;
  site: string;
  codeRepo: string;
  base: string;
}): string {
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
    "",
    `Fixes ${job.issueUrl}`,
  ].join("\n");
}
