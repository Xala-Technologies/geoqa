/**
 * The words on a growth work item.
 *
 * `formatBrief` and its eight sections, unchanged, so `parseBrief`, the console
 * panels and `prBody` keep working with no edit. What is different is where the
 * text comes from: every section is either a column read verbatim or a FIXED
 * paragraph written here. None of it is model-generated, and none of it names a
 * cause.
 *
 * That is the same rule `brief.ts` states and `buildRepairPrompt` repeats, and
 * it matters more here than it does for a geoqa ticket. A row in
 * `growth.agent_findings` is a rule match observed on a live page — it says a
 * description is 187 characters, not why. A "Root cause" that guessed a CMS
 * field or a template would be a diagnosis nobody made, handed to a model with
 * commit rights.
 */
import { formatBrief } from "../findings/brief.js";
import type { GrowthFindingRow } from "./growth-db.js";

/** How many example URLs go in the brief before it stops listing them. */
export const MAX_BRIEF_URLS = 20;

/**
 * A title for a group of rows.
 *
 * No column supplies one, so this is INVENTED — modelled on the shape the
 * fleet's own issue #343 already uses ("meta lengths on 339 pages"), because a
 * title that reads differently from the issue it is about makes the two look
 * like two problems.
 *
 * A group of one keeps the row's own title: it is a better sentence than
 * anything derived, and 339 is the interesting case, not 1.
 */
export function groupTitle(group: { rule: string; site: string; reach: number; first: GrowthFindingRow }): string {
  if (group.reach <= 1) return group.first.title === "" ? `${group.rule || "finding"} on ${group.site || "site"}` : group.first.title;
  const what = group.rule || group.first.category || "finding";
  const where = group.site || group.first.site || "site";
  return `${what} on ${group.reach} pages — ${where}`;
}

const urlLines = (rows: readonly GrowthFindingRow[]): string[] => {
  const urls = [...new Set(rows.map((row) => row.url).filter((url) => url !== ""))];
  const shown = urls.slice(0, MAX_BRIEF_URLS).map((url) => `- ${url}`);
  return urls.length > MAX_BRIEF_URLS ? [...shown, `…and ${urls.length - MAX_BRIEF_URLS} more.`] : shown;
};

/**
 * Eight sections from a group of rows.
 *
 * `rows` is never empty — `triage` builds a group from at least one row — so
 * there is no "no rows" branch to defend. A guard here would be a claim that
 * the invariant above it might not hold.
 */
export function growthBrief(input: {
  title: string;
  rows: readonly GrowthFindingRow[];
  codeRepo: string;
  daysOpen: number;
  grafanaUrl?: string;
}): string {
  const first = input.rows[0] as GrowthFindingRow;
  const ids = input.rows.map((row) => row.id).join(", ");
  const evidence = [
    input.rows.length === 1 ? "1 row in `growth.agent_findings`." : `${input.rows.length} rows in \`growth.agent_findings\`.`,
    first.estimatedImpact === "" ? "No impact estimate was recorded." : `Estimated impact: ${first.estimatedImpact}`,
    `Row ids: ${ids}`,
    ...(input.grafanaUrl === undefined || input.grafanaUrl === "" ? [] : [`Grafana: ${input.grafanaUrl}`]),
  ].join("\n");

  return formatBrief({
    problem: [input.title, "", first.detail === "" ? "The agent recorded no detail beyond the rule name." : first.detail].join("\n"),
    what: `A ${first.category || "rule"} match (${first.rule || "unnamed rule"}) reported by the ${first.agent} agent on the ${first.surface || "site"} surface.`,
    // FIXED text. See the file header: a growth row is an observation, and the
    // one thing this brief must not do is invent the diagnosis that follows it.
    rootCause: `Not determined. This is a rule match observed on the live site, not a diagnosis. The cause is in \`${input.codeRepo}\`.`,
    notThis:
      "Not a crawl error and not a human report. The row is a rule violation, so a page that renders correctly for a visitor can still match it.",
    observed: [
      `${input.rows.length} ${input.rows.length === 1 ? "row" : "rows"}. First seen ${first.firstSeen || "unrecorded"}, last seen ${first.lastSeen || "unrecorded"} (${input.daysOpen} ${input.daysOpen === 1 ? "day" : "days"} open). Severity ${first.severity || "unrecorded"}.`,
      ...(urlLines(input.rows).length === 0 ? [] : ["", ...urlLines(input.rows)]),
    ].join("\n"),
    next:
      first.recommendedAction === ""
        ? "No action proposed by the agent — this is a complaint, not a fix."
        : first.recommendedAction,
    breaking:
      "Restoring or correcting the asserted value is typically additive. Removing or renaming a route, API, auth flow, locale string or migration is breaking. Nothing here classifies a diff it has not seen.",
    evidence,
  });
}

/**
 * Labels for a growth item.
 *
 * geoqa's existing set plus the category when it is already in the live
 * vocabulary. No new label is invented: a label nobody's board filters on is a
 * label nobody sees, and `createWithLabelRetry` would drop the whole set on a
 * repo that has never heard of it.
 */
export const KNOWN_CATEGORY_LABELS = new Set(["seo", "a11y", "performance", "content", "security"]);

export function growthLabels(input: { site: string; category: string }): string[] {
  return [
    "findings",
    "bug",
    ...(input.site === "" ? [] : [`site:${input.site}`]),
    ...(KNOWN_CATEGORY_LABELS.has(input.category) ? [input.category] : []),
  ];
}
