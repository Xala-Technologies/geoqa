/**
 * Many findings → few work items, ranked.
 *
 * Two things happen here and only one of them is the interesting one.
 *
 * The interesting one is the collapse: two items that point at the same
 * `owner/name#N` are ONE item, whatever source produced them. The clone
 * directory and the branch are both derived from the issue number, so two
 * items sharing an issue would clone into the same path and each `rm` the
 * other's work before starting. `assertUniqueIssues` is that invariant made
 * checkable, and it is asserted in a test rather than trusted.
 *
 * The other is the ranking, and every number in it is invented — flagged as
 * such below, because a score presented as if it were measured is the same
 * defect as a dashboard showing 0 for a null reading.
 *
 * Pure.
 */
import type { WorkItem } from "./types.js";

/**
 * How likely a rule is to be fixable by an unattended model, 0..1. INVENTED.
 *
 * The text-length rules are 0.9 for a reason that is not a hunch: the edit is a
 * string in a known file and the postcondition is a character count, so a
 * reviewer and a verify step can both tell whether it worked. Nothing else in
 * the vocabulary is that checkable, so everything else sits at the default and
 * ranks below it.
 *
 * Only `title.long`, `title.short` and `description.long` are CONFIRMED to
 * exist as rule ids — they are today's 341 rows. `description.short` is a guess
 * at the vocabulary and costs nothing if it never appears.
 */
export const DEFAULT_FIXABILITY = 0.4;
export const FIXABILITY: Record<string, number> = {
  "title.long": 0.9,
  "title.short": 0.9,
  "description.long": 0.9,
  "description.short": 0.9,
};

export const fixabilityOf = (rule: string): number => FIXABILITY[rule] ?? DEFAULT_FIXABILITY;

/**
 * `log2`, not linear.
 *
 * 339 pages should outrank 1 page by about four times, not three hundred. A
 * linear weight lets one noisy rule permanently starve every other finding —
 * which is not a hypothetical, since the fleet's first run was 341 rows of
 * three rules.
 */
export const reachWeight = (reach: number): number => 1 + Math.log2(1 + Math.max(reach, 0));

export const score = (item: WorkItem): number => item.severityRank * reachWeight(item.reach) * item.fixability;

/** `owner/name#N`, or null for an item with no issue yet. */
export const issueSlot = (item: WorkItem): string | null =>
  item.issue === null ? null : `${item.route?.codeRepo ?? item.issue.repo}#${item.issue.number}`;

/**
 * The invariant: no two work items share a clone directory.
 *
 * Returns the offending slots rather than throwing. A run that discovered it
 * had built a colliding plan should say so and drop the collision, not die
 * holding the correct plan for everything else.
 */
export function assertUniqueIssues(items: readonly WorkItem[]): string[] {
  const seen = new Set<string>();
  const clashes: string[] = [];
  for (const item of items) {
    const slot = issueSlot(item);
    if (slot === null) continue;
    if (seen.has(slot)) clashes.push(slot);
    seen.add(slot);
  }
  return clashes;
}

const mergeTwo = (into: WorkItem, other: WorkItem): WorkItem => ({
  ...into,
  reach: into.reach + other.reach,
  severityRank: Math.max(into.severityRank, other.severityRank),
  daysOpen: Math.max(into.daysOpen, other.daysOpen),
  urgent: into.urgent || other.urgent,
  labels: [...new Set([...into.labels, ...other.labels])],
  members: [...into.members, ...other.members],
});

export interface TriageResult {
  items: WorkItem[];
  /** How many items were absorbed into another. */
  merged: number;
  /** Issue slots that were still duplicated after the collapse. Should be empty. */
  clashes: string[];
}

/**
 * Collapse by issue, score, and order.
 *
 * The survivor of a collapse is the item with the greater `reach`, ties going
 * to the lower key: the bigger group's brief lists more evidence, and a
 * deterministic tiebreak is what makes a re-run pick the same item as the run
 * it is repeating.
 */
export function triage(items: readonly WorkItem[]): TriageResult {
  const bySlot = new Map<string, WorkItem>();
  const loose: WorkItem[] = [];
  let merged = 0;

  const ordered = [...items].sort((a, b) => b.reach - a.reach || a.key.localeCompare(b.key));
  for (const item of ordered) {
    const slot = issueSlot(item);
    if (slot === null) {
      loose.push(item);
      continue;
    }
    const held = bySlot.get(slot);
    if (held === undefined) {
      bySlot.set(slot, item);
      continue;
    }
    bySlot.set(slot, mergeTwo(held, item));
    merged += 1;
  }

  const scored = [...bySlot.values(), ...loose]
    .map((item) => ({ ...item, fixability: fixabilityOf(item.rule) }))
    .sort((a, b) => score(b) - score(a) || b.daysOpen - a.daysOpen || a.key.localeCompare(b.key));

  return { items: scored, merged, clashes: assertUniqueIssues(scored) };
}
