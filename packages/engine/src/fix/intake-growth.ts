/**
 * `growth.agent_findings` rows → work items.
 *
 * The grouping is the whole file, and it is the difference between one night's
 * work and 341 clones of the same repository. The fleet's first run produced
 * 179 `description.long`, 160 `title.long` and 2 `title.short` rows, and one
 * issue — #343 — already covers all of them.
 *
 * So the key is ISSUE FIRST. Grouping by `(agent, rule, site)` would have made
 * three items out of that, all three carrying issue 343, all three cloning into
 * `<workRoot>/<owner>/<name>-343`, each one `rm`-ing the previous one's work
 * before it started. `github_issue` is the authoritative identity precisely
 * because a human or the fleet already decided these rows are one problem.
 *
 * Pure: rows in, items out, no I/O.
 */
import type { SiteRepo } from "../findings/repos.js";
import { growthBrief, groupTitle, growthLabels } from "./brief-growth.js";
import type { GrowthFindingRow } from "./growth-db.js";
import { routeGrowth, type GrowthRepoKey } from "./route.js";
import type { WorkItem, WorkMember } from "./types.js";

/**
 * The grouping identity for one row.
 *
 * Three tiers, most authoritative first. The rule tier is what an agent that
 * has not filed anything yet collapses on; the last tier exists so a row with
 * neither an issue nor a rule is still one item rather than dropped, because
 * a finding nothing groups is still a finding.
 */
export function growthGroupKey(row: GrowthFindingRow): string {
  if (row.githubIssue !== "") return `issue:${row.githubIssue}`;
  if (row.rule !== "") return `growth:${row.agent}:${row.rule}:${row.site}`;
  return `growth:${row.agent}:${row.findingKey}`;
}

/**
 * `github_issue` holds whatever the writer put there — a number, `#343`, or a
 * full URL. All three mean the same issue, so all three parse to 343 and a
 * value that means none of them is honestly no issue at all.
 */
export function issueNumberOf(value: string): number | null {
  const match = /(\d+)\s*$/.exec(value.trim());
  if (match?.[1] === undefined) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export interface GrowthIntakeOptions {
  repoKeys: readonly GrowthRepoKey[];
  sites: readonly SiteRepo[];
  /** Optional allowlist of agent slugs. Empty means every agent. */
  agents?: readonly string[];
  grafanaUrl?: string;
}

export function itemsFromGrowth(rows: readonly GrowthFindingRow[], options: GrowthIntakeOptions): WorkItem[] {
  const allowed = options.agents ?? [];
  const groups = new Map<string, GrowthFindingRow[]>();
  for (const row of rows) {
    if (allowed.length > 0 && !allowed.includes(row.agent)) continue;
    const key = growthGroupKey(row);
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }

  const items: WorkItem[] = [];
  for (const [key, bucket] of groups) {
    const first = bucket[0] as GrowthFindingRow;
    const route = routeGrowth(first, options.repoKeys, options.sites);
    const site = route?.site ?? "";
    const title = groupTitle({ rule: first.rule, site, reach: bucket.length, first });
    const daysOpen = Math.max(...bucket.map((row) => row.daysOpen));
    const issueNumber = issueNumberOf(first.githubIssue);
    const codeRepo = route?.codeRepo ?? "an unmapped repository";
    const members: WorkMember[] = bucket.map((row) => ({
      source: "growth",
      agent: row.agent,
      findingKey: row.findingKey,
      url: row.url,
      severity: row.severity,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
    }));
    items.push({
      key,
      source: "growth",
      title,
      body: growthBrief({
        title,
        rows: bucket,
        codeRepo,
        daysOpen,
        ...(options.grafanaUrl !== undefined ? { grafanaUrl: options.grafanaUrl } : {}),
      }),
      labels: growthLabels({ site, category: first.category }),
      // Never urgent. `urgent` in geoqa is an OWNERSHIP claim — "this defect is
      // ours or the vendor's" — and it routes to GEOQA_GITHUB_REPO. A severity
      // of `error` on somebody's meta description is not that, and treating it
      // as urgent would send marketing copy to the engine repo.
      urgent: false,
      severityRank: Math.max(...bucket.map((row) => row.severityRank)),
      reach: bucket.length,
      fixability: 0,
      daysOpen,
      category: first.category,
      rule: first.rule,
      issue:
        issueNumber === null || route === null
          ? null
          : { repo: route.codeRepo, number: issueNumber, url: `https://github.com/${route.codeRepo}/issues/${issueNumber}` },
      route,
      members,
    });
  }
  return items.sort((a, b) => a.key.localeCompare(b.key));
}
