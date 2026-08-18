/**
 * Where a finding is filed, and which branch a repair PR starts from.
 *
 * Site checks belong on the site's repo. Instrumentation and a Decodo miss
 * belong on geoqa — they are ours or the vendor's, not a page defect.
 * `app.digilist.no` is the one site whose working branch is `dev`; every
 * other mapped repo starts from `main`.
 *
 * Pure. The tenant file supplies the map; this module does not load it.
 */

export interface SiteRepo {
  host: string;
  repo: string;
  base: string;
}

export interface TicketRoute {
  repo: string;
  base: string;
  site: string;
}

export const siteLabel = (host: string): string => `site:${host}`;

export function routeTicket(
  draft: { urgent: boolean; hosts: string[]; site: string },
  sites: readonly SiteRepo[],
  fallbackRepo: string,
): TicketRoute {
  if (draft.urgent) {
    return { repo: fallbackRepo, base: "main", site: "geoqa" };
  }
  const host = draft.hosts[0] ?? draft.site;
  const mapped = sites.find((entry) => entry.host === host);
  if (mapped === undefined) {
    return { repo: fallbackRepo, base: "main", site: host };
  }
  return { repo: mapped.repo, base: mapped.base, site: host };
}
