/**
 * One paragraph and a host-grouped failure list.
 *
 * The mail leads with this, not a five-column table. Counts only —
 * a summary that invents a cause is the defect the digest exists to avoid.
 */
import type { Digest, DigestFailed } from "./assemble.js";

export interface FailedGroup {
  host: string;
  items: DigestFailed[];
}

export function hostOf(target: string): string {
  try {
    return new URL(target).host;
  } catch {
    return target;
  }
}

const counted = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function summariseDigest(digest: Digest): string {
  const r = digest.runs;
  if (r.total === 0) return "No runs in this window.";
  const parts = [
    `${counted(r.total, "run", "runs")} in this window`,
    `${r.pass} passed`,
    ...(r.warning > 0 ? [`${r.warning} passed with warnings`] : []),
    `${r.fail} failed`,
    r.error === 0 ? "None were our errors" : `${r.error} were our errors`,
    ...(digest.filed.length > 0 ? [counted(digest.filed.length, "issue recorded", "issues recorded")] : []),
    ...(digest.repaired.length > 0 ? [counted(digest.repaired.length, "repair landed", "repairs landed")] : []),
  ];
  return parts.map((part) => `${part}.`).join(" ");
}

export function groupFailed(failed: DigestFailed[]): FailedGroup[] {
  const groups: FailedGroup[] = [];
  for (const item of failed) {
    const host = hostOf(item.target);
    const existing = groups.find((group) => group.host === host);
    if (existing !== undefined) existing.items.push(item);
    else groups.push({ host, items: [item] });
  }
  return groups;
}
