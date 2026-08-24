/**
 * Which items this run is allowed to attempt, and how many.
 *
 * Every clause is a refusal, and each one exists because the alternative is a
 * pull request somebody has to close. The two worth arguing about:
 *
 * `security` and `compliance` are excluded by default. A security finding
 * "fixed" by an unattended model in a production repository is the one class
 * where a wrong fix is strictly worse than the untouched finding — an
 * authorisation check that now passes is indistinguishable, from the outside,
 * from one that was repaired. A human adding `agent: approved` overrides it,
 * which is the right shape: the exception needs a name on it.
 *
 * `agent: changes-requested` is absolute. A human said no. The agent does not
 * argue, does not re-file, and does not try a different diff.
 *
 * Pure.
 */
import { DEFAULT_REPAIR_TIMEOUT_MS } from "../assist/repair.js";
import type { AttemptLedger } from "./attempts.js";
import { APPROVED_LABEL, CHANGES_REQUESTED_LABEL } from "./intake-github.js";
import { score } from "./triage.js";
import type { IneligibleReason, WorkItem } from "./types.js";
import { VERIFY_INSTALL_TIMEOUT_MS, VERIFY_SCRIPTS, VERIFY_STEP_TIMEOUT_MS } from "./verify.js";

export interface SelectPolicy {
  maxItems: number;
  budgetMs: number;
  minSeverityRank: number;
  categories: readonly string[];
  maxAttempts: number;
}

/**
 * Worst case for one item, DERIVED from the timeouts that actually bound it
 * rather than asserted as a number.
 *
 * It was asserted, as 3_120_000 — "clone 60s + repair 1200s + review 600s +
 * verify 900s" — and three of those four figures were wrong against the
 * codebase's own constants. The review model is the SAME 1200s binding as the
 * repair model (`defaultRepairClaude` for both, `DEFAULT_REPAIR_TIMEOUT_MS`),
 * and verify is not 900s but an install plus up to four scripts at
 * `VERIFY_STEP_TIMEOUT_MS` each, which is 3000s. The true ceiling is 97
 * minutes, not 52.
 *
 * That understatement is not cosmetic. `geoqa-fix.service` sets
 * `TimeoutStartSec=18000` — five hours — and says in words that a oneshot
 * SIGTERMed mid-item "leav[es] a pushed branch with no pull request". Three
 * items at the real ceiling is 291 minutes, and an item allowed to START at
 * minute 239 of a 240-minute budget ends at 336: past the SIGTERM, in exactly
 * the state that comment exists to prevent.
 *
 * Used to decide whether to START an item, never to interrupt one.
 */
export const WORST_CASE_ITEM_MS =
  // clone, fetch, checkout, status, log, add, commit, diff ×2, rev-parse ×2,
  // fetch, rebase, push, pr create, pr merge — every one at its own timeout.
  420_000 +
  // the repair model
  DEFAULT_REPAIR_TIMEOUT_MS +
  // the review model, on the same binding
  DEFAULT_REPAIR_TIMEOUT_MS +
  // the target repository's own checks: one install plus every script
  VERIFY_INSTALL_TIMEOUT_MS +
  VERIFY_SCRIPTS.length * VERIFY_STEP_TIMEOUT_MS;

/**
 * Three, and the honest reason is not arithmetic.
 *
 * Three worst-case items is about 2.6 hours inside a four-hour budget and
 * finishes long before the fleet's next timer. But the real reason is that
 * nobody has watched this merge a pull request yet, and ten rejected PRs on
 * night one is a worse outcome than one good one. `FixOutcome.ms` is recorded
 * so that in a week this number can be a measurement instead of a guess.
 */
export const DEFAULT_SELECT_POLICY: SelectPolicy = {
  maxItems: 3,
  budgetMs: 240 * 60_000,
  minSeverityRank: 3,
  categories: ["seo", "a11y", "performance", "content", "site", "instrumentation", "approved"],
  maxAttempts: 2,
};

export interface SelectInput {
  items: readonly WorkItem[];
  ledger: AttemptLedger;
  /** Keys already in `repaired-issues.json`. geoqa's own memory, unchanged. */
  repaired: ReadonlySet<string>;
  /** Issue labels, keyed `owner/name#N`, for the items that have an issue. */
  issueLabels: ReadonlyMap<string, readonly string[]>;
  /** Slots with a pull request already open on the branch, keyed `owner/name#N`. */
  prOpen: ReadonlySet<string>;
  policy: SelectPolicy;
}

export interface SelectResult {
  chosen: WorkItem[];
  ineligible: { key: string; reason: IneligibleReason }[];
  stoppedOnBudget: boolean;
}

const slotOf = (item: WorkItem): string | null =>
  item.issue === null ? null : `${item.route?.codeRepo ?? item.issue.repo}#${item.issue.number}`;

/** The first reason this item is refused, or null. Order matters: the cheapest truth first. */
export function ineligibleReason(item: WorkItem, input: SelectInput): IneligibleReason | null {
  if (item.route === null) return "unroutable";
  if (item.issue === null) return "no-issue";
  const slot = slotOf(item) as string;
  const labels = input.issueLabels.get(slot) ?? [];
  if (labels.includes(CHANGES_REQUESTED_LABEL)) return "changes-requested";
  const approved = labels.includes(APPROVED_LABEL);
  if (!approved && item.severityRank < input.policy.minSeverityRank) return "below-severity";
  if (!approved && !input.policy.categories.includes(item.category)) return "category-not-allowed";
  if (input.repaired.has(item.key)) return "already-repaired";
  if (input.ledger.attempts(item.key) >= input.policy.maxAttempts) return "attempts-exhausted";
  if (input.prOpen.has(slot)) return "pr-open";
  return null;
}

/**
 * Eligibility, then budget.
 *
 * The budget is checked BEFORE an item starts and never inside one. An item
 * that begins runs to its own step timeouts: a half-finished clone with a
 * pushed branch and no pull request is a worse state than an overrun, and it
 * is the state a mid-item abort produces.
 */
export function select(input: SelectInput): SelectResult {
  const ineligible: { key: string; reason: IneligibleReason }[] = [];
  const eligible: WorkItem[] = [];
  for (const item of input.items) {
    const reason = ineligibleReason(item, input);
    if (reason !== null) {
      ineligible.push({ key: item.key, reason });
      continue;
    }
    eligible.push(item);
  }
  eligible.sort((a, b) => score(b) - score(a) || b.daysOpen - a.daysOpen || a.key.localeCompare(b.key));

  const affordable = Math.min(input.policy.maxItems, Math.floor(input.policy.budgetMs / WORST_CASE_ITEM_MS));
  const chosen = eligible.slice(0, Math.max(affordable, 0));
  return { chosen, ineligible, stoppedOnBudget: chosen.length < Math.min(eligible.length, input.policy.maxItems) };
}
