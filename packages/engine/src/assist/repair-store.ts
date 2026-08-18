/**
 * Keys already sent through repair. A second sweep must not open a twin PR.
 *
 * Unreadable is a skip, not a licence to repair everything again — same
 * rule as filed-issues.json. The PR URL is stored so the Findings page
 * can render it as a Measured reading rather than going back to GitHub.
 */
import path from "node:path";
import { z } from "zod";
import type { FiledStore } from "../findings/github.js";

export const REPAIRED_ISSUES_FILE = "repaired-issues.json";

export interface RepairedItem {
  key: string;
  status: "opened" | "cannot-fix" | "no-changes";
  at: string;
  prUrl?: string;
}

const ItemSchema = z
  .object({
    key: z.string().min(1),
    status: z.enum(["opened", "cannot-fix", "no-changes"]),
    at: z.string().min(1),
    prUrl: z.string().min(1).optional(),
  })
  .strict();

const Schema = z.union([
  z.object({ items: z.array(ItemSchema) }).strict(),
  z.object({ keys: z.array(z.string().min(1)) }).strict(),
]);

export const repairedIssuesPath = (evidenceRoot: string): string => path.join(evidenceRoot, REPAIRED_ISSUES_FILE);

export function loadRepairedItems(
  evidenceRoot: string,
  store: FiledStore,
): { ok: true; items: RepairedItem[] } | { ok: false } {
  const file = repairedIssuesPath(evidenceRoot);
  if (!store.exists(file)) return { ok: true, items: [] };
  try {
    const parsed = Schema.safeParse(JSON.parse(store.read(file)));
    if (!parsed.success) return { ok: false };
    if ("items" in parsed.data) {
      return {
        ok: true,
        items: parsed.data.items.map((item) => ({
          key: item.key,
          status: item.status,
          at: item.at,
          ...(item.prUrl !== undefined ? { prUrl: item.prUrl } : {}),
        })),
      };
    }
    return {
      ok: true,
      items: parsed.data.keys.map((key) => ({ key, status: "opened" as const, at: "legacy" })),
    };
  } catch {
    return { ok: false };
  }
}

export function loadRepairedKeys(
  evidenceRoot: string,
  store: FiledStore,
): { ok: true; keys: string[] } | { ok: false } {
  const loaded = loadRepairedItems(evidenceRoot, store);
  return loaded.ok ? { ok: true, keys: loaded.items.map((item) => item.key) } : loaded;
}

export function saveRepairedItems(evidenceRoot: string, items: RepairedItem[], store: FiledStore): void {
  store.mkdir(evidenceRoot);
  store.write(repairedIssuesPath(evidenceRoot), `${JSON.stringify({ items }, null, 2)}\n`);
}

export function saveRepairedKeys(evidenceRoot: string, keys: string[], store: FiledStore): void {
  saveRepairedItems(
    evidenceRoot,
    keys.map((key) => ({ key, status: "opened", at: "legacy" })),
    store,
  );
}
