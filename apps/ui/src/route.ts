/**
 * Hash routes for a static console. A path router would 404 off disk.
 *
 * `#/findings/<key>` is the ticket brief. The key is encoded because a
 * site ticket looks like `site:has a search box:xala.no`.
 */
export type ViewId =
  | "overview"
  | "live"
  | "runs"
  | "findings"
  | "geography"
  | "coverage"
  | "trends"
  | "watch"
  | "settings";

const VIEWS: ViewId[] = [
  "overview",
  "live",
  "runs",
  "findings",
  "geography",
  "coverage",
  "trends",
  "watch",
  "settings",
];

export type Route = {
  view: ViewId;
  runId?: string;
  liveId?: string;
  findingKey?: string;
  pageTarget?: string;
  trendKey?: string;
};

export function findingHref(key: string): string {
  return `#/findings/${encodeURIComponent(key)}`;
}

export function decodeHashRest(rest: string[]): string {
  const joined = rest.join("/");
  try {
    return decodeURIComponent(joined);
  } catch {
    return joined;
  }
}

export function routeFromHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [head, ...rest] = raw.split("/");
  if (head === "run" && rest.length > 0) return { view: "runs", runId: rest.join("/") };
  if (head === "live" && rest.length > 0) return { view: "live", liveId: rest.join("/") };
  if (head === "findings" && rest.length > 0) {
    return { view: "findings", findingKey: decodeHashRest(rest) };
  }
  if (head === "geography" && rest.length > 0) {
    return { view: "geography", pageTarget: decodeHashRest(rest) };
  }
  if (head === "trends" && rest.length > 0) {
    return { view: "trends", trendKey: decodeHashRest(rest) };
  }
  return { view: VIEWS.some((id) => id === head) ? (head as ViewId) : "runs" };
}
