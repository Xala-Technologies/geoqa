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
  const labels = input.urgent ? ["urgent", "instrumentation", "findings", "bug"] : ["findings", "bug"];
  const findings = link(input.origin, "#/findings");
  const tail = findings === "" ? "" : `\n\nFindings: ${findings}`;
  return {
    key: input.key,
    title: input.urgent ? `URGENT: ${input.title}` : input.title,
    body: `${input.body}${tail}`,
    labels,
    urgent: input.urgent,
    runIds: [...new Set(input.runs.map((r) => r.runId))],
  };
}

function runLine(run: TicketRun, origin: string | null): string {
  const href = link(origin, `#/run/${run.runId}`);
  const ref = href === "" ? `\`${run.runId}\`` : `[${run.runId}](${href})`;
  return `| ${ref} | ${run.profileId} | ${run.journeyId} | ${run.target} | ${run.verdict} |`;
}

const TABLE = "| Run | Profile | Journey | URL | Verdict |\n|---|---|---|---|---|";

function runBody(label: string, runs: TicketRun[], origin: string | null): string {
  return [
    `geoqa could not complete **${label}**. An ERROR is ours or the vendor's, not a site defect.`,
    "",
    TABLE,
    ...runs.map((r) => runLine(r, origin)),
  ].join("\n");
}

function geoBody(runs: TicketRun[], origin: string | null): string {
  const rows = runs.map((run) => {
    const href = link(origin, `#/run/${run.runId}`);
    const ref = href === "" ? `\`${run.runId}\`` : `[${run.runId}](${href})`;
    const asked = `${run.geo.requestedCity}, ${run.geo.requestedCountry}`;
    const seen = `${run.geo.observedCity ?? "unverified"}, ${run.geo.observedCountry ?? "unverified"}`;
    return `| ${ref} | ${asked} | ${seen} | city ${run.geo.city} / country ${run.geo.country} |`;
  });
  return [
    "The exit was not the city or country we asked Decodo for.",
    "",
    "| Run | Asked | Observed | Verdicts |",
    "|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function siteBody(label: string, host: string, runs: TicketRun[], origin: string | null): string {
  return [
    `Check **${label}** failed on **${host}** after reading the page. This is a site finding.`,
    "",
    TABLE,
    ...runs.map((r) => runLine(r, origin)),
  ].join("\n");
}
