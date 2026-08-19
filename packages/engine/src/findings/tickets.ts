/**
 * Findings → GitHub issue drafts.
 *
 * The watch produces many runs. Filing one issue per cell would bury the
 * ones that matter. This file is the grouping: a site check is one ticket
 * per host, a hung navigate is urgent, and a fill that timed out because
 * the search box was already absent is not a second urgent ticket.
 *
 * Pure. Talking to GitHub is `github.ts`. A draft here is what would be
 * filed, not a promise that it was.
 */
import { formatBrief, seenLine } from "./brief.js";

export interface TicketRun {
  runId: string;
  target: string;
  profileId: string;
  journeyId: string;
  verdict: string;
  findings: { labels: string[]; byCategory: Record<string, number> };
  geo: {
    requestedCountry: string;
    requestedCity: string;
    observedCountry: string | null;
    observedCity: string | null;
    country: string;
    city: string;
    egressHeld: string;
  };
}

export interface TicketDraft {
  key: string;
  title: string;
  body: string;
  labels: string[];
  urgent: boolean;
  runIds: string[];
  /** Primary host, or `geoqa` when the defect is ours / the vendor's. */
  site: string;
  /** Every host that contributed runs — each becomes a `site:<host>` label. */
  hosts: string[];
}

export interface TicketOptions {
  consoleBase?: string;
}

/** Labels that are actions the engine failed to complete, not checks on the page. */
const RUN_ACTION_LABELS = new Set(["open target", "land on the page", "type the query"]);

export function hostOf(target: string): string {
  try {
    return new URL(target).host || target;
  } catch {
    return target;
  }
}

const consoleOrigin = (base: string | undefined): string | null => {
  if (base === undefined || base.trim() === "") return null;
  try {
    const url = new URL(base);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
};

const link = (origin: string | null, hash: string): string => (origin === null ? "" : `${origin}/${hash}`);

const siteKey = (label: string, target: string): string => `site:${label}:${hostOf(target)}`;

const isCascadeFill = (run: TicketRun, label: string): boolean =>
  label === "type the query" && run.findings.labels.includes("has a search box");

export function draftsFromRuns(runs: TicketRun[], options: TicketOptions = {}): TicketDraft[] {
  const origin = consoleOrigin(options.consoleBase);
  const site = new Map<string, TicketRun[]>();
  const urgentRun = new Map<string, TicketRun[]>();
  const geoMiss: TicketRun[] = [];

  for (const run of runs) {
    if (run.geo.country === "mismatch" || run.geo.city === "mismatch") geoMiss.push(run);
    if (run.geo.egressHeld === "mismatch") {
      const list = urgentRun.get("egress-held") ?? [];
      list.push(run);
      urgentRun.set("egress-held", list);
    }
    for (const label of run.findings.labels) {
      if (isCascadeFill(run, label)) continue;
      if (RUN_ACTION_LABELS.has(label) && (run.findings.byCategory.instrumentation ?? 0) > 0) {
        const list = urgentRun.get(label) ?? [];
        list.push(run);
        urgentRun.set(label, list);
        continue;
      }
      const key = siteKey(label, run.target);
      const list = site.get(key) ?? [];
      list.push(run);
      site.set(key, list);
    }
  }

  const drafts: TicketDraft[] = [];
  if (geoMiss.length > 0) {
    drafts.push(
      draft({
        key: "urgent:geo-mismatch",
        urgent: true,
        title: "Decodo city or country mismatch",
        runs: geoMiss,
        origin,
        body: geoBody(geoMiss, origin),
      }),
    );
  }
  for (const [label, group] of urgentRun) {
    drafts.push(
      draft({
        key: `urgent:run:${label}`,
        urgent: true,
        title: `Run could not finish: ${label}`,
        runs: group,
        origin,
        body: runBody(label, group, origin),
      }),
    );
  }
  for (const [key, group] of site) {
    const label = key.slice("site:".length).replace(/:[^:]+$/, "");
    const host = hostOf(group[0]?.target ?? "");
    drafts.push(
      draft({
        key,
        urgent: false,
        title: `${label} on ${host}`,
        runs: group,
        origin,
        body: siteBody(label, host, group, origin),
      }),
    );
  }
  return drafts.sort((a, b) => a.key.localeCompare(b.key));
}

function draft(input: {
  key: string;
  urgent: boolean;
  title: string;
  runs: TicketRun[];
  origin: string | null;
  body: string;
}): TicketDraft {
  const hosts = [...new Set(input.runs.map((run) => hostOf(run.target)))];
  const site = input.urgent ? "geoqa" : (hosts[0] ?? "geoqa");
  const labels = [
    ...(input.urgent ? ["urgent", "instrumentation"] : []),
    "findings",
    "bug",
    ...hosts.map((host) => `site:${host}`),
  ];
  const findings = link(input.origin, "#/findings");
  const tail = findings === "" ? "" : `\n\nFindings: ${findings}`;
  return {
    key: input.key,
    title: input.urgent ? `URGENT: ${input.title}` : input.title,
    body: `${input.body}${tail}`,
    labels,
    urgent: input.urgent,
    runIds: [...new Set(input.runs.map((r) => r.runId))],
    site,
    hosts,
  };
}

function runLine(run: TicketRun, origin: string | null): string {
  const href = link(origin, `#/run/${run.runId}`);
  const ref = href === "" ? `\`${run.runId}\`` : `[${run.runId}](${href})`;
  return `| ${ref} | ${run.profileId} | ${run.journeyId} | ${run.target} | ${run.verdict} |`;
}

const TABLE = "| Run | Profile | Journey | URL | Verdict |\n|---|---|---|---|---|";

function runBody(label: string, runs: TicketRun[], origin: string | null): string {
  const evidence = [TABLE, ...runs.map((r) => runLine(r, origin))].join("\n");
  if (label === "egress-held") {
    return formatBrief({
      problem: "The egress IP rotated mid-journey. One session used more than one exit.",
      what: "An instrumentation / vendor defect. geoqa marks this ERROR.",
      rootCause:
        "A rotating residential exit mid-journey takes LCP from one visitor and CLS from another. Those readings cannot be attributed to one visitor.",
      notThis: "Not a site defect. Do not change product markup to 'fix' a rotated exit.",
      observed: seenLine(runs),
      next: "Check the closing IP probe on the run. If the vendor rotated the sticky session, hold the session or drop the cell — do not file the page.",
      breaking: "No product breaking change. A markup or copy change filed against this would itself be the break.",
      evidence,
    });
  }
  return formatBrief({
    problem: `geoqa could not complete **${label}**. The run ended ERROR.`,
    what: "Ours or the vendor's — not a site defect. ERROR means we could not finish the action, not that the page was wrong.",
    rootCause:
      "The named step never produced a page reading (instrumentation). Typical companions already seen: a residential CONNECT miss, a hung navigation, or a tool timeout. The evidence names the step; it does not prove which companion it was unless the run log says so.",
    notThis: "Not a content or markup bug. Do not change Digilist or xala.no to 'fix' this.",
    observed: seenLine(runs),
    next: "Open the run log. If it is ERR_TUNNEL_CONNECTION_FAILED or a proxy 407, that is Decodo — retry the cell, do not file the site.",
    breaking: "No product breaking change. Do not ship a site or API change to 'clear' an ERROR.",
    evidence,
  });
}

function geoBody(runs: TicketRun[], origin: string | null): string {
  const rows = runs.map((run) => {
    const href = link(origin, `#/run/${run.runId}`);
    const ref = href === "" ? `\`${run.runId}\`` : `[${run.runId}](${href})`;
    const asked = `${run.geo.requestedCity}, ${run.geo.requestedCountry}`;
    const seen = `${run.geo.observedCity ?? "unverified"}, ${run.geo.observedCountry ?? "unverified"}`;
    return `| ${ref} | ${asked} | ${seen} | city ${run.geo.city} / country ${run.geo.country} |`;
  });
  return formatBrief({
    problem: "The exit was not the city or country we asked Decodo for.",
    what: "A vendor / routing finding. Urgent because a wrong-country run dresses a Norwegian claim in the wrong exit.",
    rootCause:
      "A city verdict is a distance, not a string comparison. Decodo names the exchange suburb, so Skui can sit 15 km from Oslo and still be the right country. Country is the load-bearing axis.",
    notThis: "A city mismatch with a country match is not proof the page was served from the wrong country, and it is not a site defect.",
    observed: seenLine(runs),
    next: "Keep country as the gate. Treat city as a distance band. Do not 'fix' the product to match an exchange suburb name.",
    breaking: "No product breaking change. Changing city copy or hreflang to match an exchange suburb would be the break.",
    evidence: ["| Run | Asked | Observed | Verdicts |", "|---|---|---|---|", ...rows].join("\n"),
  });
}

function siteBody(label: string, host: string, runs: TicketRun[], origin: string | null): string {
  return formatBrief({
    problem: `The check **${label}** failed on **${host}** after geoqa read the page. A visitor in the markets below did not get what the journey required.`,
    what: "A site finding. The page was readable. This is not a proxy failure and not an instrumentation ERROR.",
    rootCause:
      "The journey asserted this check after load, and the assertion did not hold. geoqa does not invent whether markup, CSS, a geo-specific template, or a broken selector is at fault — that belongs in the product repo.",
    notThis: "Not an ERROR, not a Decodo city-string miss, and not a reason to 'fix' geoqa instead of the page.",
    observed: seenLine(runs),
    next: "Open a failing run, confirm the screenshot, then change the page or the journey — not both at once.",
    breaking:
      "Restoring the missing check (the element, copy, or status the journey already expected) is typically additive. Removing or renaming a route, API, auth flow, or locale string is breaking — re-run the other markets in this table before merge. geoqa does not classify a diff it has not seen.",
    evidence: [TABLE, ...runs.map((r) => runLine(r, origin))].join("\n"),
  });
}
