/**
 * Which repository a growth finding belongs to — or a refusal.
 *
 * `routeTicket` falls through to `GEOQA_GITHUB_REPO` for anything it cannot
 * map, and that is right for geoqa's own tickets: an instrumentation defect
 * IS ours. It is catastrophic here. The growth fleet measures sites geoqa has
 * never run against, and an unmapped SEO finding routed to the fallback would
 * open a marketing-copy PR against the geoqa engine.
 *
 * So this returns `null` and the item is counted `unroutable` and printed by
 * name. A refusal a human can read beats a PR in the wrong repository, and
 * "we could not tell where this belongs" is a true statement that a fallback
 * would have turned into a false one.
 *
 * Pure. The tenant file supplies both maps; this module does not load them.
 */
import type { SiteRepo } from "../findings/repos.js";
import type { WorkRoute } from "./types.js";

/**
 * A logical repo key from the fleet's own config — `marketing`, `app`,
 * `platform` — mapped to a real repository.
 *
 * Separate from `repositories[]` because `agent_findings.target_repo` is a key
 * and not a host: the fleet routes by which product a finding is about, and a
 * host map cannot answer a row whose `site` column is a site id.
 */
export interface GrowthRepoKey {
  key: string;
  repo: string;
  base: string;
}

const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * The bare host a row is about, or `""`.
 *
 * `site` first because it is the fleet's own identifier, but only when it
 * LOOKS like a hostname — the column is documented as a site id from
 * `seo-targets.yaml`, and whether that id is `digilist.no` or `marketing` was
 * not confirmed against the live table. When it is not a hostname the `url`
 * column carries one, and a row with neither is honestly unroutable rather
 * than guessed at.
 *
 * Never throws: an unparseable URL is a missing host, not a dead run.
 */
export function hostOf(row: { site: string; url: string }): string {
  const strip = (value: string): string => value.replace(/^www\./i, "").toLowerCase();
  const site = row.site.trim();
  if (HOST.test(site)) return strip(site);
  try {
    const host = new URL(row.url).hostname;
    return host === "" ? "" : strip(host);
  } catch {
    return "";
  }
}

/**
 * `target_repo` → `site` → refuse.
 *
 * `target_repo` wins because it is the fleet's own answer to this question and
 * a derived host is a second opinion about a fact somebody already recorded.
 */
export function routeGrowth(
  row: { targetRepo: string; site: string; url: string },
  repoKeys: readonly GrowthRepoKey[],
  sites: readonly SiteRepo[],
): WorkRoute | null {
  const key = row.targetRepo.trim();
  if (key !== "") {
    const mapped = repoKeys.find((entry) => entry.key === key);
    if (mapped !== undefined) {
      return { codeRepo: mapped.repo, base: mapped.base, site: hostOf(row), reason: "target-repo" };
    }
  }
  const host = hostOf(row);
  if (host !== "") {
    const mapped = sites.find((entry) => entry.host.replace(/^www\./i, "").toLowerCase() === host);
    if (mapped !== undefined) {
      return { codeRepo: mapped.repo, base: mapped.base, site: host, reason: "site-host" };
    }
  }
  return null;
}

/**
 * Route a GitHub issue a human opted in, by its `site:<host>` label.
 *
 * No site label is a refusal for the same reason as above, and more sharply:
 * the three issues open on the geoqa repo today include one that is nginx
 * configuration and nobody's finding. An unlabelled issue handed to an
 * unattended model is precisely that issue.
 */
export function routeIssueLabels(labels: readonly string[], sites: readonly SiteRepo[]): WorkRoute | null {
  for (const label of labels) {
    if (!label.startsWith("site:")) continue;
    const host = label.slice("site:".length).replace(/^www\./i, "").toLowerCase();
    const mapped = sites.find((entry) => entry.host.replace(/^www\./i, "").toLowerCase() === host);
    if (mapped !== undefined) {
      return { codeRepo: mapped.repo, base: mapped.base, site: host, reason: "site-host" };
    }
  }
  return null;
}
