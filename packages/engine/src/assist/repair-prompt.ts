/**
 * Prompt for an unattended repair. The issue is the authority; the model
 * edits the checkout. Inventing a metric or a URL here would undo the
 * verdict at the last step — same defect as a dashboard showing 0 for a
 * null LCP.
 */
export function buildRepairPrompt(job: {
  title: string;
  body: string;
  issueUrl: string;
  issueNumber: number;
  codeRepo: string;
  base: string;
  site: string;
  urgent: boolean;
  branch: string;
}): string {
  return [
    `You are Claude Code in a git checkout of ${job.codeRepo}.`,
    `The current branch is ${job.branch}, created from ${job.base}.`,
    "",
    "Fix this geoqa finding in this repository. Commit locally when you change files.",
    "Do not push. Do not open a pull request — the porter does that.",
    "",
    `Issue: ${job.title}`,
    `Number: #${job.issueNumber}`,
    `URL: ${job.issueUrl}`,
    `Site: ${job.site}`,
    job.urgent ? "This is an instrumentation / vendor defect. Only change this repo if the fix belongs here." : "This is a site finding after reading the page.",
    "",
    "Rules:",
    "- Use only the facts in the issue. Do not invent metrics, verdicts, or URLs.",
    "- If a value was not measured, do not guess it.",
    "- If you cannot fix this without guessing, or the defect is not in this repo, print exactly:",
    "  CANNOT_FIX: <one-line reason>",
    "  and change no files.",
    "- Keep the change small. Do not refactor unrelated code.",
    "- Do not weaken this repository's own checks to make your change pass. Deleting or skipping a",
    "  test, lowering a threshold, widening a type, adding @ts-ignore or eslint-disable, regenerating",
    "  a snapshot, or passing --force is a rejected fix, not a fix. If the repo's checks fail on your",
    "  change, change your change.",
    "- Prefer an additive restore of the asserted check. Do not remove a route, API, auth flow, or locale string unless the issue says to.",
    `- Commit message starts with Fix #${job.issueNumber}:`,
    "",
    "The issue has Problem, Root cause, What we saw, Breaking changes, and Evidence. Those are the brief.",
    "Do not add a cause the issue does not state.",
    "",
    "ISSUE",
    "-----",
    job.body,
  ].join("\n");
}
