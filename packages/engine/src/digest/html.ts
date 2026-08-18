/**
 * Xala-themed HTML for the daily digest.
 *
 * Colours from the xala.no / Xala Technologies mark: deep forest ground,
 * cream type, leaf green, a warm gold for attention. Email clients strip
 * stylesheets, so every colour is inline. Labels are escaped — a step
 * named `<h1>` must not become markup.
 */
import type { Digest } from "./assemble.js";

const escape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const when = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace(".000Z", " UTC");
};

const bg = "#0b1612";
const card = "#14241c";
const cream = "#f4efe6";
const muted = "#9aafa3";
const green = "#2f8f62";
const gold = "#c4a46a";
const line = "#24382e";

const pill = (label: string, color: string): string =>
  `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${color};color:${bg};font-size:11px;font-weight:700;letter-spacing:0.04em">${escape(label)}</span>`;

export function renderDigestHtml(digest: Digest): string {
  const tenant = digest.tenantId ?? "geoqa";
  const failRows =
    digest.failed.length === 0
      ? `<tr><td colspan="5" style="padding:14px;color:${muted}">None. That is a real empty, not a missing section.</td></tr>`
      : digest.failed
          .map((row) => {
            const name = row.href !== null ? `<a href="${escape(row.href)}" style="color:${cream}">${escape(row.runId)}</a>` : escape(row.runId);
            return `<tr>
              <td style="padding:10px 12px;border-top:1px solid ${line}">${name}</td>
              <td style="padding:10px 12px;border-top:1px solid ${line}">${escape(row.market)}</td>
              <td style="padding:10px 12px;border-top:1px solid ${line}">${escape(row.journey)}</td>
              <td style="padding:10px 12px;border-top:1px solid ${line}">${pill(row.verdict, row.verdict === "ERROR" ? gold : cream)}</td>
              <td style="padding:10px 12px;border-top:1px solid ${line};color:${muted}">${escape(row.labels.join(", ") || "—")}</td>
            </tr>`;
          })
          .join("");

  const filed =
    digest.filed.length === 0
      ? `<p style="color:${muted};margin:0">No new issues this window.</p>`
      : `<ul style="margin:0;padding-left:18px">${digest.filed
          .map((i) => `<li style="margin:0 0 8px"><a href="${escape(i.url)}" style="color:${cream}">#${i.number}</a> <span style="color:${muted}">${escape(i.key)}</span></li>`)
          .join("")}</ul>`;

  const repaired =
    digest.repaired.length === 0
      ? `<p style="color:${muted};margin:0">No repairs landed this window.</p>`
      : `<ul style="margin:0;padding-left:18px">${digest.repaired
          .map((i) => {
            const pr =
              i.prUrl !== undefined ? ` — <a href="${escape(i.prUrl)}" style="color:${green}">PR</a>` : "";
            return `<li style="margin:0 0 8px">${escape(i.key)} <span style="color:${muted}">${escape(i.status)}</span>${pr}</li>`;
          })
          .join("")}</ul>`;

  const must = digest.mustKnow.map((line) => `<li style="margin:0 0 8px">${escape(line)}</li>`).join("");
  const ideas = digest.suggestions
    .map(
      (s) =>
        `<tr><td style="padding:12px 0;border-top:1px solid ${line}"><div style="color:${cream};font-weight:600">${escape(s.title)}</div><div style="color:${muted};margin-top:4px">${escape(s.why)}</div></td></tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>geoqa daily — ${escape(tenant)}</title>
</head>
<body style="margin:0;background:${bg};color:${cream};font-family:Georgia,'Iowan Old Style',Times,serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg}">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%">
        <tr><td style="padding:0 0 28px">
          <div style="font-size:11px;letter-spacing:0.28em;text-transform:uppercase;color:${green};font-weight:700">Xala Technologies</div>
          <div style="font-size:28px;line-height:1.2;margin-top:8px">geoqa daily</div>
          <div style="color:${muted};margin-top:8px">${escape(tenant)} · ${escape(when(digest.window.since))} → ${escape(when(digest.window.until))}</div>
        </td></tr>
        <tr><td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              ${stat("Runs", String(digest.runs.total))}
              ${stat("Pass", String(digest.runs.pass))}
              ${stat("Fail", String(digest.runs.fail))}
              ${stat("Error", String(digest.runs.error))}
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:28px 0 8px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${gold}">Must know</td></tr>
        <tr><td style="background:${card};border-radius:12px;padding:18px 20px"><ul style="margin:0;padding-left:18px">${must}</ul></td></tr>
        <tr><td style="padding:28px 0 8px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${gold}">What failed</td></tr>
        <tr><td style="background:${card};border-radius:12px;overflow:hidden">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px">
            <tr style="color:${muted}">
              <td style="padding:10px 12px">Run</td>
              <td style="padding:10px 12px">Market</td>
              <td style="padding:10px 12px">Journey</td>
              <td style="padding:10px 12px">Verdict</td>
              <td style="padding:10px 12px">Findings</td>
            </tr>
            ${failRows}
          </table>
        </td></tr>
        <tr><td style="padding:28px 0 8px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${gold}">Issues recorded</td></tr>
        <tr><td style="background:${card};border-radius:12px;padding:18px 20px">${filed}</td></tr>
        <tr><td style="padding:28px 0 8px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${gold}">Issues fixed</td></tr>
        <tr><td style="background:${card};border-radius:12px;padding:18px 20px">${repaired}</td></tr>
        <tr><td style="padding:28px 0 8px;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:${gold}">Suggestions</td></tr>
        <tr><td style="background:${card};border-radius:12px;padding:8px 20px 12px"><table role="presentation" width="100%">${ideas}</table></td></tr>
        <tr><td style="padding:28px 0 0;color:${muted};font-size:12px;line-height:1.6">
          Sent from the geoqa AgentMail inbox. Numbers come from the evidence tree — runs.jsonl, filed-issues.json, repaired-issues.json — never from a dashboard guess.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

const stat = (label: string, value: string): string =>
  `<td style="padding:0 6px 16px 0;width:25%">
    <div style="background:${card};border-radius:12px;padding:16px 14px">
      <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${muted}">${label}</div>
      <div style="font-size:28px;margin-top:6px;color:${cream}">${value}</div>
    </div>
  </td>`;

export function renderDigestText(digest: Digest): string {
  const lines = [
    `geoqa daily — ${digest.tenantId ?? "geoqa"}`,
    `${digest.window.since} → ${digest.window.until}`,
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
