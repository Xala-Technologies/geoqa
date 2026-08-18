/**
 * Keys already sent through repair. A second sweep must not open a twin PR.
 *
 * Unreadable is a skip, not a licence to repair everything again — same
 * rule as filed-issues.json.
 */
import path from "node:path";
import { z } from "zod";
import type { FiledStore } from "../findings/github.js";

export const REPAIRED_ISSUES_FILE = "repaired-issues.json";

const Schema = z.object({ keys: z.array(z.string().min(1)) }).strict();

export const repairedIssuesPath = (evidenceRoot: string): string => path.join(evidenceRoot, REPAIRED_ISSUES_FILE);

export function loadRepairedKeys(
  evidenceRoot: string,
  store: FiledStore,
): { ok: true; keys: string[] } | { ok: false } {
  const file = repairedIssuesPath(evidenceRoot);
  if (!store.exists(file)) return { ok: true, keys: [] };
  try {
    const parsed = Schema.safeParse(JSON.parse(store.read(file)));
    return parsed.success ? { ok: true, keys: parsed.data.keys } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function saveRepairedKeys(evidenceRoot: string, keys: string[], store: FiledStore): void {
  store.mkdir(evidenceRoot);
  store.write(repairedIssuesPath(evidenceRoot), `${JSON.stringify({ keys }, null, 2)}\n`);
}
