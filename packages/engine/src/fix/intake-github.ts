/**
 * Issues a human asked for, and only those.
 *
 * GitHub is NOT a general intake here, and refusing to make it one is the
 * single most load-bearing decision in this file. Listing every open issue
 * carrying `findings` would re-derive what the two real sources already know —
 * #343's rows are in Postgres, #342 is in `filed-issues.json` — and on a bad
 * label day it hands an unattended model something like #335, which is nginx
 * configuration and nobody's finding at all.
 *
 * So an issue reaches this agent only when a human has put `agent: approved` on
 * it. That label is already in the live vocabulary and this is exactly the
 * affordance it describes. The agent READS it and never writes it: an agent
 * that can grant itself permission has none.
 *
 * Pure. The HTTP read is `findings/github.ts`.
 */
import type { GithubIssueRef } from "../findings/github.js";
import type { SiteRepo } from "../findings/repos.js";
import { routeIssueLabels } from "./route.js";
import type { WorkItem } from "./types.js";

export const FINDINGS_LABEL = "findings";
export const APPROVED_LABEL = "agent: approved";
export const CHANGES_REQUESTED_LABEL = "agent: changes-requested";
export const REVIEWED_LABEL = "agent: reviewed";

/** The labels `githubListIssues` ANDs. Both must be present, and a human puts both there. */
export const GITHUB_INTAKE_LABELS = [FINDINGS_LABEL, APPROVED_LABEL];

/** An opted-in issue outranks a routine finding: somebody looked at it and said yes. */
export const APPROVED_SEVERITY_RANK = 4;

export const githubItemKey = (repo: string, number: number): string => `github:${repo}#${number}`;

export function itemsFromGithub(
  issues: readonly GithubIssueRef[],
  input: { repo: string; sites: readonly SiteRepo[]; claimed: ReadonlySet<string> },
): WorkItem[] {
  const items: WorkItem[] = [];
  for (const issue of issues) {
    // `/issues` returns pull requests too. A repair agent handed its own PR
    // would clone the repository to fix the fix.
    if (issue.pullRequest) continue;
    if (!issue.labels.includes(APPROVED_LABEL)) continue;
    if (issue.labels.includes(CHANGES_REQUESTED_LABEL)) continue;
    // Already owned by a source that knows more about it than a label does.
    if (input.claimed.has(`${input.repo}#${issue.number}`)) continue;
    const route = routeIssueLabels(issue.labels, input.sites);
    items.push({
      key: githubItemKey(input.repo, issue.number),
      source: "github",
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      urgent: false,
      severityRank: APPROVED_SEVERITY_RANK,
      reach: 1,
      fixability: 0,
      daysOpen: 0,
      category: "approved",
      rule: "",
      issue: { repo: input.repo, number: issue.number, url: issue.url },
      route,
      members: [{ source: "github" }],
    });
  }
  return items.sort((a, b) => a.key.localeCompare(b.key));
}
