/**
 * Prompts for post-judgement assist. The brief is the authority; the model
 * is the writer. Inventing a metric here would undo the verdict model at
 * the last step — the same defect a dashboard showing 0 for a null LCP is.
 */
export function buildExplainPrompt(brief: string): string | null {
  const trimmed = brief.trim();
  if (trimmed === "") return null;
  return [
    "Draft a short ticket a human can file from this geoqa evidence brief.",
    "",
    "Rules:",
    "- Use only the facts in the brief. Do not invent metrics, verdicts, URLs, or console lines.",
    "- If a value is missing, write that it was not measured. Do not guess.",
    "- Do not change the verdict.",
    "- Write: a title, what failed, and what a human should re-check.",
    "- The brief is the authority. You are the writer, not the judge.",
    "",
    "BRIEF",
    "-----",
    trimmed,
  ].join("\n");
}
