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

export type Route = { view: ViewId; runId?: string; liveId?: string; findingKey?: string };

export function findingHref(key: string): string {
  return `#/findings/${encodeURIComponent(key)}`;
}

export function routeFromHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [head, ...rest] = raw.split("/");
  if (head === "run" && rest.length > 0) return { view: "runs", runId: rest.join("/") };
  if (head === "live" && rest.length > 0) return { view: "live", liveId: rest.join("/") };
  if (head === "findings" && rest.length > 0) {
    return { view: "findings", findingKey: decodeURIComponent(rest.join("/")) };
  }
  return { view: VIEWS.some((id) => id === head) ? (head as ViewId) : "runs" };
}
