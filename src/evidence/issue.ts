/**
 * Turn a failed visit into the text a human pastes into a ticket.
 *
 * A label in a table is not enough to file an issue. The brief has to name
 * what was expected, what was observed, and what the page logged — otherwise
 * somebody re-opens the run and still cannot write the ticket.
 */

export interface IssueStep {
  label: string;
  outcome: string;
  severity?: string;
  detail: string;
  expected: string | null;
  observed: string | null;
}

export interface EvidenceIssue {
  label: string;
  outcome: string;
  severity: string;
  reason: string;
  expected: string;
  observed: string;
  detail: string;
}

export interface ConsoleLine {
  type: string;
  text: string;
}

export function issuesFromSteps(steps: readonly IssueStep[]): EvidenceIssue[] {
  const issues: EvidenceIssue[] = [];
  for (const step of steps) {
    if (step.outcome !== "failed" && step.outcome !== "errored") continue;
    issues.push({
      label: step.label,
      outcome: step.outcome,
      severity: step.severity ?? (step.outcome === "errored" ? "high" : "medium"),
      reason: reasonFor(step),
      expected: step.expected ?? "—",
      observed: step.observed ?? "—",
      detail: step.detail,
    });
  }
  return issues;
}

export function parseConsoleLog(raw: unknown): ConsoleLine[] {
  if (!Array.isArray(raw)) return [];
  const lines: ConsoleLine[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const text = typeof rec.text === "string" ? rec.text : "";
    const type = typeof rec.type === "string" && rec.type !== "" ? rec.type : "log";
    lines.push({ type, text });
  }
  return lines;
}

export function formatIssueBrief(input: {
  runId: string;
  target: string;
  journeyId: string;
  verdict: string;
  issues: EvidenceIssue[];
  console: ConsoleLine[];
}): string {
  const lines = [
    `${input.verdict}: ${input.journeyId} on ${input.target}`,
    `Run: ${input.runId}`,
    "",
    "Why it failed",
  ];
  if (input.issues.length === 0) {
    lines.push("- no failed step was recorded");
  } else {
    for (const issue of input.issues) {
      lines.push(`- ${issue.label} (${issue.severity}, ${issue.outcome}): ${issue.reason}`);
      if (issue.detail !== "" && !issue.reason.includes(issue.detail)) {
        lines.push(`  ${issue.detail}`);
      }
    }
  }
  lines.push("", "Console");
  if (input.console.length === 0) {
    lines.push("- console was not recorded (or the page logged nothing we kept)");
  } else {
    for (const line of input.console) {
      lines.push(`- ${line.type}: ${line.text}`);
    }
  }
  return lines.join("\n");
}

function reasonFor(step: IssueStep): string {
  if (step.outcome === "errored") {
    return `Could not verify "${step.label}"${step.detail !== "" ? `: ${step.detail}` : " — the reading never arrived"}`;
  }
  if (step.expected !== null && step.observed !== null) {
    return `Expected ${step.expected}, observed ${step.observed}`;
  }
  return step.detail !== "" ? step.detail : `${step.label} failed`;
}
