/**
 * Xala-themed HTML for the daily digest.
 *
 * Dark is the inline default (Gmail strips most stylesheets). Light is the
 * same mark inverted via prefers-color-scheme. Failures are host cards,
 * not a five-column table. Labels are escaped.
 */
import type { Digest, DigestFailed } from "./assemble.js";
import { groupFailed, summariseDigest } from "./summary.js";

const escape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const when = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace(".000Z", " UTC");
};

const dark = {
  bg: "#0b1612",
  card: "#14241c",
  fg: "#f4efe6",
  muted: "#9aafa3",
  green: "#2f8f62",
  gold: "#c4a46a",
  line: "#24382e",
};

const THEME = `<style>
  :root { color-scheme: light dark; }
  @media (prefers-color-scheme: light) {
    .x-body, .x-canvas { background: #f4efe6 !important; color: #0b1612 !important; }
    .x-card { background: #fffdf8 !important; }
    .x-fg { color: #0b1612 !important; }
    .x-muted { color: #5c6f66 !important; }
    .x-link { color: #0b1612 !important; }
    .x-gold { color: #8a6a32 !important; }
    .x-line { border-color: #d9cfc0 !important; }
    .x-pill { color: #0b1612 !important; }
  }
</style>`;

const pill = (label: string, tone: "fail" | "error"): string => {
  const bg = tone === "error" ? dark.gold : dark.fg;
  return `<span class="x-pill" style="display:inline-block;padding:3px 9px;border-radius:999px;background:${bg};color:${dark.bg};font-size:10px;font-weight:700;letter-spacing:0.06em">${escape(label)}</span>`;
};

const heading = (label: string): string =>
  `<tr><td class="x-gold" style="padding:28px 0 10px;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:${dark.gold}">${label}</td></tr>`;

const card = (inner: string): string =>
  `<tr><td class="x-card" style="background:${dark.card};border-radius:14px;padding:18px 20px">${inner}</td></tr>`;

const failCard = (host: string, items: DigestFailed[]): string => {
  const rows = items
    .map((row) => {
      const title = `${escape(row.market)} · ${escape(row.journey)}`;
      const labels = escape(row.labels.join(" · ") || "no labelled finding");
      const name =
        row.href !== null
          ? `<a class="x-link" href="${escape(row.href)}" style="color:${dark.fg};text-decoration:underline">${escape(row.runId)}</a>`
          : `<span class="x-muted" style="color:${dark.muted}">${escape(row.runId)}</span>`;
      return `<tr>
        <td style="padding:12px 0;border-top:1px solid ${dark.line}" class="x-line">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${pill(row.verdict, row.verdict === "ERROR" ? "error" : "fail")}
            <span class="x-fg" style="color:${dark.fg};font-weight:600">${title}</span>
          </div>
          <div class="x-muted" style="color:${dark.muted};margin-top:6px;font-size:13px;line-height:1.5">${labels} · ${name}</div>
        </td>
      </tr>`;
    })
    .join("");
  return `<div class="x-card" style="background:${dark.card};border-radius:14px;padding:4px 20px 8px;margin:0 0 12px">
    <div class="x-fg" style="color:${dark.fg};padding:14px 0 4px;font-weight:700;letter-spacing:0.02em">${escape(host)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
  </div>`;
};

export function renderDigestHtml(digest: Digest): string {
  const tenant = digest.tenantId ?? "geoqa";
  const summary = summariseDigest(digest);
  const groups = groupFailed(digest.failed);
  const failBlock =
    groups.length === 0
      ? card(`<p class="x-muted" style="color:${dark.muted};margin:0">None. That is a real empty, not a missing section.</p>`)
      : `<tr><td>${groups.map((g) => failCard(g.host, g.items)).join("")}</td></tr>`;

  const filed =
    digest.filed.length === 0
      ? `<p class="x-muted" style="color:${dark.muted};margin:0">No new issues this window.</p>`
      : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${digest.filed
          .map(
            (i, idx) =>
              `<tr><td style="padding:${idx === 0 ? "0" : "10px"} 0 0;${idx === 0 ? "" : `border-top:1px solid ${dark.line};`}" class="x-line">
                <a class="x-link" href="${escape(i.url)}" style="color:${dark.fg};font-weight:600;text-decoration:underline">#${i.number}</a>
                <div class="x-muted" style="color:${dark.muted};margin-top:4px;font-size:13px">${escape(i.key)}</div>
              </td></tr>`,
          )
          .join("")}</table>`;

  const repaired =
    digest.repaired.length === 0
      ? `<p class="x-muted" style="color:${dark.muted};margin:0">No repairs landed this window.</p>`
      : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${digest.repaired
          .map((i, idx) => {
            const pr =
              i.prUrl !== undefined
                ? ` · <a class="x-link" href="${escape(i.prUrl)}" style="color:${dark.green};font-weight:600">PR</a>`
                : "";
            return `<tr><td style="padding:${idx === 0 ? "0" : "10px"} 0 0;${idx === 0 ? "" : `border-top:1px solid ${dark.line};`}" class="x-line">
              <span class="x-fg" style="color:${dark.fg};font-weight:600">${escape(i.status)}</span>${pr}
              <div class="x-muted" style="color:${dark.muted};margin-top:4px;font-size:13px">${escape(i.key)}</div>
            </td></tr>`;
          })
          .join("")}</table>`;

  const must = digest.mustKnow
    .map((line) => `<div class="x-fg" style="color:${dark.fg};margin:0 0 10px;line-height:1.5">${escape(line)}</div>`)
    .join("");
  const ideas = digest.suggestions
    .map(
      (s, idx) =>
        `<div style="padding:${idx === 0 ? "0" : "14px"} 0 0;${idx === 0 ? "" : `border-top:1px solid ${dark.line};`}" class="x-line">
          <div class="x-fg" style="color:${dark.fg};font-weight:600">${escape(s.title)}</div>
          <div class="x-muted" style="color:${dark.muted};margin-top:6px;line-height:1.55">${escape(s.why)}</div>
        </div>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>geoqa daily — ${escape(tenant)}</title>
  ${THEME}
</head>
<body class="x-body" style="margin:0;background:${dark.bg};color:${dark.fg};font-family:Georgia,'Iowan Old Style',Times,serif">
  <table class="x-canvas" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${dark.bg}">
    <tr><td align="center" style="padding:36px 16px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
        <tr><td style="padding:0 0 22px">
          <div style="font-size:11px;letter-spacing:0.28em;text-transform:uppercase;color:${dark.green};font-weight:700">Xala Technologies</div>
          <div class="x-fg" style="font-size:30px;line-height:1.15;margin-top:10px;color:${dark.fg}">geoqa daily</div>
          <div class="x-muted" style="color:${dark.muted};margin-top:8px">${escape(tenant)} · ${escape(when(digest.window.since))} → ${escape(when(digest.window.until))}</div>
        </td></tr>
        ${heading("Summary")}
        ${card(`<p class="x-fg" style="margin:0;color:${dark.fg};font-size:17px;line-height:1.55">${escape(summary)}</p>`)}
        <tr><td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px">
            <tr>
              ${stat("Runs", String(digest.runs.total))}
              ${stat("Pass", String(digest.runs.pass))}
              ${stat("Fail", String(digest.runs.fail))}
              ${stat("Error", String(digest.runs.error))}
            </tr>
          </table>
        </td></tr>
        ${heading("Must know")}
        ${card(must)}
        ${heading("What failed")}
        ${failBlock}
        ${heading("Issues recorded")}
        ${card(filed)}
        ${heading("Issues fixed")}
        ${card(repaired)}
        ${heading("Suggestions")}
        ${card(ideas)}
        <tr><td class="x-muted" style="padding:28px 0 0;color:${dark.muted};font-size:12px;line-height:1.6">
          Sent from the geoqa AgentMail inbox. Numbers come from the evidence tree — runs.jsonl, filed-issues.json, repaired-issues.json — never from a dashboard guess.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

const stat = (label: string, value: string): string =>
  `<td style="padding:0 8px 0 0;width:25%">
    <div class="x-card" style="background:${dark.card};border-radius:14px;padding:14px 12px">
      <div class="x-muted" style="font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:${dark.muted}">${label}</div>
      <div class="x-fg" style="font-size:26px;margin-top:6px;color:${dark.fg}">${value}</div>
    </div>
  </td>`;

export function renderDigestText(digest: Digest): string {
  const lines = [
    `geoqa daily — ${digest.tenantId ?? "geoqa"}`,
    `${digest.window.since} → ${digest.window.until}`,
    "",
    summariseDigest(digest),
    "",
    `${digest.runs.total} runs · ${digest.runs.pass} pass · ${digest.runs.fail} fail · ${digest.runs.error} error`,
    "",
    "Must know",
    ...digest.mustKnow.map((line) => `- ${line}`),
    "",
    "What failed",
    ...(digest.failed.length === 0
      ? ["- none"]
      : digest.failed.map((f) => `- ${f.verdict} ${f.market} ${f.journey} ${f.target} ${f.labels.join(", ")}`)),
    "",
    "Issues recorded",
    ...(digest.filed.length === 0 ? ["- none"] : digest.filed.map((i) => `- #${i.number} ${i.url}`)),
    "",
    "Issues fixed",
    ...(digest.repaired.length === 0 ? ["- none"] : digest.repaired.map((i) => `- ${i.status} ${i.key}`)),
    "",
    "Suggestions",
    ...digest.suggestions.map((s) => `- ${s.title}: ${s.why}`),
  ];
  return lines.join("\n");
}
