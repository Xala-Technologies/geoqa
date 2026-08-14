/**
 * Pruning an evidence tree (gap D-4).
 *
 * `evidence/` grows without bound, and because a flagged screenshot "may
 * contain personal data" that is more than a disk problem. Retention tiers
 * decide what a run CAPTURES; this module decides how long it is KEPT.
 *
 * Two rules shape the API:
 *
 *  1. **Planning is separate from deleting.** `planPrune` reads and computes;
 *     `executePrune` deletes, and only when handed `{ apply: true }`. A
 *     destructive default is how someone loses the one trace that mattered, so
 *     the plan is a document a human can read — with sizes — before anything is
 *     removed.
 *  2. **Not knowing is never permission.** A run directory whose manifest will
 *     not parse is reported as `unknown` and left on disk: we cannot tell
 *     whether it was a throwaway green run or the only capture of a bug. The
 *     same reflex as everywhere else in this codebase — a refusal beats a
 *     silent no-op, and in this direction a silent DO would be worse still.
 *
 * The filesystem arrives through `PruneFs` so the unit suite runs against
 * fixtures and can never be pointed at the repo's real `evidence/`.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { RETENTION, type EvidenceManifest, type RetentionTier } from "./manifest.js";
import { readManifest } from "./store.js";
import { describeThrown } from "../errors.js";

const DAY_MS = 86_400_000;

/** Bytes and file count of one run directory, measured on disk. */
export interface DirSize {
  bytes: number;
  files: number;
}

/**
 * The only filesystem this module may touch.
 *
 * Injected rather than imported so a test can hand over a fixture tree (or a
 * plain object) — nothing in the unit suite is allowed to walk, let alone
 * delete inside, the repo's real evidence directory.
 */
export interface PruneFs {
  /** Immediate child DIRECTORY names of the root. Not paths, not files. */
  listRunDirs(root: string): string[];
  readManifest(dir: string): EvidenceManifest | null;
  measure(dir: string): DirSize;
  removeDir(dir: string): void;
}

/**
 * Shelf life per tier — the same asymmetry `RETENTION` already encodes, applied
 * to time instead of to capture.
 *
 * A passing run's screenshot and vitals are cheap to discard because they are
 * cheap to REGENERATE: run the journey again and you get equivalent artifacts.
 * A failing run's trace and HAR may be impossible to reproduce, because the bug
 * may not recur — the run itself is the only copy of that evidence. So a pass
 * ages out in a week and a failure gets six months. `investigation` (an ERROR
 * verdict: our own tooling was blind) is treated like a failure for the same
 * reason.
 *
 * `null` means "age never selects this tier".
 */
export const DEFAULT_MAX_AGE_DAYS: Record<RetentionTier, number | null> = {
  pass: 7,
  warning: 30,
  fail: 180,
  investigation: 180,
};

/**
 * Which tiers a size sweep is allowed to reach for, cheapest first.
 *
 * Disk pressure is an operational problem; losing the trace of a failure is a
 * QA one. So the sweep spends the regenerable runs and stops — if that is not
 * enough it reports a shortfall (see `sizeShortfallBytes`) instead of quietly
 * eating a failure. Deleting those is a decision a human makes on purpose, by
 * lowering the tier's age ceiling.
 */
export const SIZE_SWEEP_TIER_ORDER: RetentionTier[] = ["pass", "warning", "fail", "investigation"];

export interface RetentionPolicy {
  /** Per-tier age ceiling in days; `null` disables age selection for that tier. */
  maxAgeDays: Record<RetentionTier, number | null>;
  /**
   * Age ceiling for privacy-flagged runs, which overrides the tier's ceiling
   * when it is SHORTER — never when it is longer.
   *
   * These are the artifacts most worth deleting on a schedule: a screenshot
   * taken on a form or an authenticated page plausibly holds a name or an email
   * and no redaction pass can find that in an image, so its value decays much
   * faster than its liability. They are also the most dangerous to delete
   * silently — the flagged frame may be the only record of what was exposed —
   * which is why they carry their own reason (`privacy`) and their manifest
   * note into the plan, and why a size sweep will not touch them at all.
   *
   * `null` means privacy does not shorten anything (the tier ceiling stands).
   */
  privacyMaxAgeDays: number | null;
  /** Total-size cap for the whole root. Omitted ⇒ no size selection at all. */
  maxTotalBytes?: number;
  /** Tiers a size sweep may select from, in the order it spends them. */
  sizeSweepTiers: RetentionTier[];
  /**
   * Delete run directories we could not identify. Default `false`: an
   * unreadable manifest is a reason to look, not a licence to delete.
   */
  deleteUnreadable: boolean;
}

/** Age-only, tier-aware, keeps everything it cannot identify. */
export const DEFAULT_POLICY: RetentionPolicy = {
  maxAgeDays: DEFAULT_MAX_AGE_DAYS,
  privacyMaxAgeDays: 14,
  sizeSweepTiers: ["pass", "warning"],
  deleteUnreadable: false,
};

/** Why a run was selected. `unreadable` only ever appears under an explicit flag. */
export type PruneReason = "age" | "privacy" | "size" | "unreadable";

export interface PrunePlanEntry {
  runId: string;
  /** Absolute, already proven to resolve inside the root. */
  dir: string;
  /** `null` for an unidentifiable run selected under `deleteUnreadable`. */
  tier: RetentionTier | null;
  createdAt: string | null;
  ageDays: number | null;
  bytes: number;
  files: number;
  reason: PruneReason;
  /** Carried verbatim so the dry run shows what a human would be destroying. */
  privacyNote: string | null;
}

/** A run directory left in place because we could not tell what it was. */
export interface UnknownRun {
  runId: string;
  dir: string;
  bytes: number;
  files: number;
  why: string;
}

/** A name that will never be deleted, whatever the policy says. */
export interface RefusedRun {
  runId: string;
  why: string;
}

export interface PrunePlan {
  root: string;
  /** The rules that produced this plan, so the JSON is self-describing. */
  policy: RetentionPolicy;
  nowMs: number;
  /** Run directories considered (refused names are not among them). */
  runCount: number;
  /** Bytes across every run directory we could measure, before pruning. */
  totalBytes: number;
  doomed: PrunePlanEntry[];
  unknown: UnknownRun[];
  refused: RefusedRun[];
  keptBytes: number;
  reclaimedBytes: number;
  /**
   * Bytes still over `maxTotalBytes` once the sweep ran out of tiers it is
   * allowed to spend. `null` means there was no cap, or the cap was met.
   * Never silently 0 — "we could not get under the cap" must not read as "we
   * did".
   */
  sizeShortfallBytes: number | null;
}

/**
 * Resolve a run name inside the root, or `null` if it escapes.
 *
 * The root is a parameter and this is the only way a directory becomes
 * deletable. `..`, an absolute path, and the root itself are all refused — the
 * root itself because `prune` must never be able to remove the evidence tree
 * wholesale.
 */
export function resolveRunDir(root: string, runId: string): string | null {
  const base = path.resolve(root);
  const full = path.resolve(base, runId);
  if (full === base) return null;
  return full.startsWith(base + path.sep) ? full : null;
}

const isTier = (value: unknown): value is RetentionTier =>
  typeof value === "string" && Object.hasOwn(RETENTION, value);

interface KnownRun {
  runId: string;
  dir: string;
  tier: RetentionTier;
  createdAt: string;
  ageDays: number;
  bytes: number;
  files: number;
  privacyFlagged: boolean;
  privacyNote: string | null;
}

type Classified = { ok: true; run: KnownRun } | { ok: false; why: string };

/**
 * Decide what a run directory is — or say we cannot.
 *
 * `readManifest` casts `JSON.parse` output, so every field here is checked
 * rather than trusted: a truncated write or a hand-edit must produce an
 * `unknown` we leave alone, not a crash that stops the whole prune and not a
 * default that makes the run look prunable.
 */
function classifyRun(
  runId: string,
  dir: string,
  manifest: EvidenceManifest | null,
  size: DirSize,
  nowMs: number,
): Classified {
  if (!manifest) return { ok: false, why: `no readable manifest.json` };
  if (!isTier(manifest.tier)) return { ok: false, why: `unknown retention tier ${JSON.stringify(manifest.tier)}` };
  const createdMs = Date.parse(String(manifest.createdAt));
  // An unparseable timestamp is not age zero and not the epoch: one of those
  // exempts the run forever and the other deletes it immediately. We do not
  // know its age, so we do not get a verdict on it.
  if (Number.isNaN(createdMs)) {
    return { ok: false, why: `unparseable createdAt ${JSON.stringify(manifest.createdAt)}` };
  }
  // `manifest.artifacts` is typed, but the value came off disk.
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const note = typeof manifest.privacyNote === "string" ? manifest.privacyNote : null;
  return {
    ok: true,
    run: {
      runId,
      dir,
      tier: manifest.tier,
      createdAt: manifest.createdAt,
      // Clamped: a createdAt in the future means a skewed clock or a copied
      // tree, and negative-age arithmetic must not select anything.
      ageDays: Math.max(0, (nowMs - createdMs) / DAY_MS),
      bytes: size.bytes,
      files: size.files,
      // Both sources, because the note is DERIVED from the risk flags at build
      // time. Trusting only the note would let a change to its wording — or an
      // older manifest — silently un-flag every affected run.
      privacyFlagged: note !== null || artifacts.some((artifact) => artifact?.risk === "review"),
      privacyNote: note,
    },
  };
}

/** The binding age ceiling for a run, and which rule bound it. */
function ageCeiling(
  policy: RetentionPolicy,
  run: KnownRun,
): { days: number | null; reason: "age" | "privacy" } {
  const byTier = policy.maxAgeDays[run.tier];
  const byPrivacy = policy.privacyMaxAgeDays;
  if (!run.privacyFlagged || byPrivacy === null) return { days: byTier, reason: "age" };
  // Privacy only ever shortens. A generous privacy window must not extend the
  // life of a run the tier policy already wanted gone.
  if (byTier === null || byPrivacy < byTier) return { days: byPrivacy, reason: "privacy" };
  return { days: byTier, reason: "age" };
}

const entryFor = (run: KnownRun, reason: PruneReason): PrunePlanEntry => ({
  runId: run.runId,
  dir: run.dir,
  tier: run.tier,
  createdAt: run.createdAt,
  ageDays: run.ageDays,
  bytes: run.bytes,
  files: run.files,
  reason,
  privacyNote: run.privacyNote,
});

export interface PlanPruneInput {
  root: string;
  policy: RetentionPolicy;
  nowMs: number;
  fs: PruneFs;
}

/** Read the tree and decide what should go. Deletes nothing, ever. */
export function planPrune(input: PlanPruneInput): PrunePlan {
  const { root, policy, nowMs, fs } = input;
  const doomed: PrunePlanEntry[] = [];
  const unknown: UnknownRun[] = [];
  const refused: RefusedRun[] = [];
  const survivors: KnownRun[] = [];
  let totalBytes = 0;
  let runCount = 0;

  for (const runId of fs.listRunDirs(root)) {
    const dir = resolveRunDir(root, runId);
    if (dir === null) {
      refused.push({ runId, why: "does not resolve inside the evidence root" });
      continue;
    }
    const size = fs.measure(dir);
    totalBytes += size.bytes;
    runCount += 1;
    const classified = classifyRun(runId, dir, fs.readManifest(dir), size, nowMs);
    if (!classified.ok) {
      if (policy.deleteUnreadable) {
        doomed.push({
          runId,
          dir,
          tier: null,
          createdAt: null,
          ageDays: null,
          bytes: size.bytes,
          files: size.files,
          reason: "unreadable",
          privacyNote: null,
        });
      } else {
        unknown.push({ runId, dir, bytes: size.bytes, files: size.files, why: classified.why });
      }
      continue;
    }
    const ceiling = ageCeiling(policy, classified.run);
    if (ceiling.days !== null && classified.run.ageDays > ceiling.days) {
      doomed.push(entryFor(classified.run, ceiling.reason));
    } else {
      survivors.push(classified.run);
    }
  }

  // Unknown and refused runs still occupy disk, so they count against the cap
  // even though the sweep may not spend them.
  let keptBytes = totalBytes - doomed.reduce((sum, entry) => sum + entry.bytes, 0);
  let sizeShortfallBytes: number | null = null;
  const cap = policy.maxTotalBytes;

  if (cap !== undefined && keptBytes > cap) {
    const rank = (tier: RetentionTier): number => SIZE_SWEEP_TIER_ORDER.indexOf(tier);
    const eligible = survivors
      .filter((run) => !run.privacyFlagged && policy.sizeSweepTiers.includes(run.tier))
      .sort((a, b) => rank(a.tier) - rank(b.tier) || b.ageDays - a.ageDays);
    for (const run of eligible) {
      if (keptBytes <= cap) break;
      doomed.push(entryFor(run, "size"));
      keptBytes -= run.bytes;
    }
    if (keptBytes > cap) sizeShortfallBytes = keptBytes - cap;
  }

  return {
    root,
    policy,
    nowMs,
    runCount,
    totalBytes,
    doomed,
    unknown,
    refused,
    keptBytes,
    reclaimedBytes: totalBytes - keptBytes,
    sizeShortfallBytes,
  };
}

export interface PruneExecution {
  /** True unless the caller explicitly passed `{ apply: true }`. */
  dryRun: boolean;
  deletedRunIds: string[];
  /** Bytes ACTUALLY removed. Zero on a dry run; the projection lives on the plan. */
  reclaimedBytes: number;
  refused: RefusedRun[];
  /** A delete that threw. Never counted as reclaimed, never silent. */
  failed: { runId: string; error: string }[];
}

/**
 * Carry out a plan — or, by default, walk it without touching anything.
 *
 * A dry run still re-validates every path, so a refusal surfaces while it is
 * still free, rather than the first time someone types `--apply`.
 */
export function executePrune(
  plan: PrunePlan,
  fs: PruneFs,
  options: { apply?: boolean } = {},
): PruneExecution {
  const apply = options.apply === true;
  const deletedRunIds: string[] = [];
  const refused: RefusedRun[] = [...plan.refused];
  const failed: { runId: string; error: string }[] = [];
  let reclaimedBytes = 0;

  for (const entry of plan.doomed) {
    // Re-derived rather than trusted. A plan is JSON: it can be printed,
    // transported, edited and handed back, and the code that deletes must not
    // take a path on faith from something it did not compute this second.
    if (resolveRunDir(plan.root, entry.runId) !== entry.dir) {
      refused.push({ runId: entry.runId, why: `${entry.dir} is not this run's directory under the root` });
      continue;
    }
    if (!apply) continue;
    try {
      fs.removeDir(entry.dir);
      deletedRunIds.push(entry.runId);
      reclaimedBytes += entry.bytes;
    } catch (error) {
      failed.push({ runId: entry.runId, error: describeThrown(error) });
    }
  }

  return { dryRun: !apply, deletedRunIds, reclaimedBytes, refused, failed };
}

/**
 * Iterated rather than indexed: with `noUncheckedIndexedAccess` an index into
 * the unit table needs a fallback that can never be reached, and an
 * unreachable arm is exactly what the coverage gate exists to keep out.
 */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = "B";
  for (const next of ["KB", "MB", "GB"]) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return unit === "B" ? `${value} B` : `${value.toFixed(1)} ${unit}`;
}

/**
 * The plan as lines a human reads before deciding.
 *
 * Every doomed run gets its size and its reason, and the privacy note is
 * repeated verbatim — the point of the dry run is that nobody discovers what
 * was in a flagged screenshot after it is gone.
 */
export function describePrunePlan(plan: PrunePlan): string[] {
  const lines = [
    `evidence prune plan (planning deletes nothing)`,
    `  root:  ${plan.root}`,
    `  now:   ${formatBytes(plan.totalBytes)} across ${plan.runCount} run directories`,
    `  would delete ${plan.doomed.length} run(s), reclaiming ${formatBytes(plan.reclaimedBytes)}; keeping ${formatBytes(plan.keptBytes)}`,
  ];
  for (const entry of plan.doomed) {
    const age = entry.ageDays === null ? "age unknown" : `${entry.ageDays.toFixed(1)}d`;
    lines.push(
      `    ${entry.runId}  ${entry.tier ?? "tier unknown"}  ${age}  ${formatBytes(entry.bytes)}  [${entry.reason}]`,
    );
    if (entry.privacyNote !== null) lines.push(`      PRIVACY: ${entry.privacyNote}`);
  }
  if (plan.unknown.length > 0) {
    lines.push(`  left in place — we cannot tell what these were (${formatBytes(plan.unknown.reduce((sum, run) => sum + run.bytes, 0))}):`);
    for (const run of plan.unknown) lines.push(`    ${run.runId}  ${formatBytes(run.bytes)}  ${run.why}`);
  }
  for (const run of plan.refused) lines.push(`  REFUSED ${run.runId}: ${run.why}`);
  if (plan.sizeShortfallBytes !== null) {
    lines.push(
      `  size cap NOT met: ${formatBytes(plan.sizeShortfallBytes)} still over. The sweep will not spend` +
        ` privacy-flagged runs or tiers outside ${plan.policy.sizeSweepTiers.join(", ")} — lower those age ceilings on purpose instead.`,
    );
  }
  return lines;
}

/**
 * The real filesystem.
 *
 * Everything here is I/O with one judgement call: only DIRECTORIES are run
 * candidates. `browser verify` writes `verify.png` straight into the evidence
 * root, and `Dirent` reports a symlink as a symlink rather than as a directory
 * — so a loose file cannot be mistaken for a run, and a link pointing outside
 * the root is neither walked nor deleted.
 */
export function nodePruneFs(): PruneFs {
  const walk = (dir: string): DirSize => {
    let bytes = 0;
    let files = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const inner = walk(full);
        bytes += inner.bytes;
        files += inner.files;
      } else {
        bytes += statSync(full).size;
        files += 1;
      }
    }
    return { bytes, files };
  };
  return {
    // An absent root is knowably nothing to prune. Any OTHER read error (a
    // permission problem, say) propagates: that is blindness, not emptiness.
    listRunDirs: (root) =>
      existsSync(root)
        ? readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort()
        : [],
    readManifest,
    measure: walk,
    removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
  };
}
