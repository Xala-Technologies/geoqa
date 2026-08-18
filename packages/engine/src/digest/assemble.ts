/**
 * A day's evidence, reduced to what an operator email can say honestly.
 *
 * Counts and names only. Suggestions are derived from the same numbers —
 * a digest that invents a story the index does not support is worse than
 * a short one.
 */
import type { RepairedItem } from "../assist/repair-store.js";
import type { FiledIssue } from "../findings/github.js";
import type { RunRecord } from "../history/records.js";

export interface DigestFailed {
  runId: string;
  target: string;
  market: string;
  journey: string;
  verdict: RunRecord["verdict"];
  labels: string[];
  href: string | null;
}

export interface DigestSuggestion {
  title: string;
  why: string;
}

export interface Digest {
  tenantId: string | null;
  window: { since: string; until: string };
  runs: { total: number; pass: number; fail: number; error: number; warning: number };
  failed: DigestFailed[];
  filed: FiledIssue[];
  repaired: RepairedItem[];
  mustKnow: string[];
  suggestions: DigestSuggestion[];
}

export interface AssembleDigestInput {
  records: RunRecord[];
  filed: FiledIssue[];
  repaired: RepairedItem[];
  sinceMs: number;
  untilMs: number;
  tenantId: string | null;
  consoleUrl: string | null;
}

const inWindow = (iso: string, sinceMs: number, untilMs: number): boolean => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= sinceMs && ms < untilMs;
};

const marketOf = (profileId: string): string => profileId.replace(/-(mobile|desktop)$/, "");

const hostOf = (target: string): string => {
  try {
    return new URL(target).host;
  } catch {
    return target;
  }
};

const runHref = (consoleUrl: string | null, runId: string): string | null => {
  if (consoleUrl === null || consoleUrl === "") return null;
  return `${consoleUrl.replace(/\/$/, "")}/#/run/${runId}`;
};

export function assembleDigest(input: AssembleDigestInput): Digest {
  const runs = input.records.filter((r) => inWindow(r.startedAt, input.sinceMs, input.untilMs));
  const counts = { total: runs.length, pass: 0, fail: 0, error: 0, warning: 0 };
  const failed: DigestFailed[] = [];
  let cityMismatch = 0;
  let instrumentation = 0;
  const hosts = new Set<string>();

  for (const run of runs) {
    hosts.add(hostOf(run.target));
    if (run.verdict === "PASS") counts.pass += 1;
    else if (run.verdict === "PASS_WITH_WARNINGS") counts.warning += 1;
    else if (run.verdict === "FAIL") counts.fail += 1;
    else counts.error += 1;
    if (run.geo.city === "mismatch") cityMismatch += 1;
    if ((run.findings.byCategory.instrumentation ?? 0) > 0 || run.verdict === "ERROR") instrumentation += 1;
    if (run.verdict === "FAIL" || run.verdict === "ERROR") {
      failed.push({
        runId: run.runId,
        target: run.target,
        market: marketOf(run.profileId),
        journey: run.journeyId,
        verdict: run.verdict,
        labels: run.findings.labels,
        href: runHref(input.consoleUrl, run.runId),
      });
    }
  }

  const filed = input.filed.filter((issue) => inWindow(issue.at, input.sinceMs, input.untilMs));
  const repaired = input.repaired.filter((item) => item.at !== "legacy" && inWindow(item.at, input.sinceMs, input.untilMs));

  const mustKnow: string[] = [];
  if (counts.error > 0) {
    mustKnow.push(`${counts.error} ERROR run(s) — that is our instrumentation, not a site defect`);
  }
  if (counts.fail > 0) {
    const top = failed.find((f) => f.verdict === "FAIL");
    if (top !== undefined) {
      mustKnow.push(`${counts.fail} FAIL on ${hostOf(top.target)} from ${top.market}`);
    }
  }
  for (const issue of filed.slice(0, 5)) {
    mustKnow.push(`filed #${issue.number}: ${issue.key}`);
  }
  if (mustKnow.length === 0 && counts.total > 0) {
    mustKnow.push("No FAIL or ERROR in this window. The pulse held.");
  }
  if (mustKnow.length === 0) {
    mustKnow.push("No runs in this window — the watch may be paused or not yet due.");
  }

  const suggestions = suggest({ counts, cityMismatch, instrumentation, filed, repaired, hosts: [...hosts] });

  return {
    tenantId: input.tenantId,
    window: { since: new Date(input.sinceMs).toISOString(), until: new Date(input.untilMs).toISOString() },
    runs: counts,
    failed,
    filed,
    repaired,
    mustKnow,
    suggestions,
  };
}

function suggest(input: {
  counts: Digest["runs"];
  cityMismatch: number;
  instrumentation: number;
  filed: FiledIssue[];
  repaired: RepairedItem[];
  hosts: string[];
}): DigestSuggestion[] {
  const out: DigestSuggestion[] = [];
  if (input.counts.total === 0) {
    out.push({
      title: "No runs processed",
      why: "Arm Watch or click Run now. A silent day is not a green day.",
    });
    return out;
  }
  if (input.cityMismatch > 0) {
    out.push({
      title: "City mismatches are still in the data",
      why: `${input.cityMismatch} run(s) reported a city miss. Decodo names the exchange suburb; treat country as the load-bearing axis and keep city as a distance, not a string.`,
    });
  }
  if (input.instrumentation > 0) {
    out.push({
      title: "Separate tool failures from site failures",
      why: `${input.instrumentation} run(s) look like ours (ERROR or instrumentation). Do not file those against Digilist.`,
    });
  }
  if (input.filed.length > 0 && input.repaired.length === 0) {
    out.push({
      title: "Issues were recorded and none were repaired",
      why: "Run findings repair, or open the tickets and decide they are product work rather than a one-line fix.",
    });
  }
  if (input.hosts.includes("dashboard.digilist.no") === false && input.counts.total > 0) {
    out.push({
      title: "Dashboard was not in this window",
      why: "It is a fourth pulse URL plus one Oslo e2e login. If the clock has not reached either, that is expected — not a gap to invent.",
    });
  }
  if (input.counts.fail === 0 && input.counts.error === 0) {
    out.push({
      title: "Keep the two clocks independent",
      why: "Geo pulse at 4 hours and e2e login at 12 hours is the spend we can afford. Tightening both at once buys more Decodo GB than signal.",
    });
  }
  if (out.length === 0) {
    out.push({
      title: "Nothing extra to change today",
      why: "The window has runs, no city-miss cluster, and repairs are moving. Leave the pulse as it is.",
    });
  }
  return out;
}
