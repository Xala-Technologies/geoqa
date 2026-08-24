/**
 * geoqa's own filed tickets → work items.
 *
 * This is `jobsFromFiled`'s inner join, lifted one type upward: a draft with no
 * filed issue is still skipped silently, and `routeTicket` still decides where
 * the PR goes, urgent still going to the fallback repo. Nothing about geoqa's
 * routing changes here — the point of the lift is that one budget, one ranking
 * and one retry cap now cover both sources instead of geoqa having its own.
 *
 * Pure.
 */
import type { FiledIssue } from "../findings/github.js";
import { routeTicket, type SiteRepo } from "../findings/repos.js";
import type { TicketDraft } from "../findings/tickets.js";
import type { WorkItem } from "./types.js";

/**
 * A draft's severity, on growth's 0..5 scale.
 *
 * INVENTED: a `TicketDraft` has no severity column, only `urgent`, so this is a
 * mapping and not a reading. 4 and 3 are chosen so an urgent geoqa ticket
 * outranks a routine one and both sit at or above the default eligibility
 * threshold — the alternative was inventing a finer scale out of a boolean.
 */
export const URGENT_SEVERITY_RANK = 4;
export const SITE_SEVERITY_RANK = 3;

export function itemsFromGeoqa(
  drafts: readonly TicketDraft[],
  filed: readonly FiledIssue[],
  sites: readonly SiteRepo[],
  fallbackRepo: string,
): WorkItem[] {
  const byKey = new Map(filed.map((issue) => [issue.key, issue]));
  const items: WorkItem[] = [];
  for (const draft of drafts) {
    const issue = byKey.get(draft.key);
    if (issue === undefined) continue;
    const dest = routeTicket(draft, sites, fallbackRepo);
    items.push({
      key: draft.key,
      source: "geoqa",
      title: draft.title,
      body: draft.body,
      labels: draft.labels,
      urgent: draft.urgent,
      severityRank: draft.urgent ? URGENT_SEVERITY_RANK : SITE_SEVERITY_RANK,
      // Runs, not pages. A check that failed in nine markets is a wider finding
      // than one that failed in one, which is the same thing reach means for a
      // growth row.
      reach: draft.runIds.length,
      fixability: 0,
      daysOpen: 0,
      category: draft.urgent ? "instrumentation" : "site",
      rule: "",
      issue: { repo: issue.repo ?? fallbackRepo, number: issue.number, url: issue.url },
      route: {
        codeRepo: dest.repo,
        base: dest.base,
        site: dest.site,
        reason: draft.urgent ? "urgent" : "site-host",
      },
      members: [{ source: "geoqa", draftKey: draft.key }],
    });
  }
  return items.sort((a, b) => a.key.localeCompare(b.key));
}
