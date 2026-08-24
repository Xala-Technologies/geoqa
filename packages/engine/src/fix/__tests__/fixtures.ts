/**
 * Shared fakes for the fix suite.
 *
 * Everything here is an injected port, never a mock of a module specifier: a
 * `vi.mock` path that stops resolving does not error, it silently stops
 * mocking, and a suite that quietly stopped faking `claude` would spend a Max
 * subscription in CI.
 */
import type { RepairExec, RepairExecResult } from "../../assist/repair.js";
import type { AssistOutcome } from "../../assist/types.js";
import type { FiledStore } from "../../findings/github.js";
import type { GrowthFindingRow } from "../growth-db.js";

export const row = (over: Partial<GrowthFindingRow> = {}): GrowthFindingRow => ({
  id: 1,
  runId: 7,
  agent: "seo",
  foundAt: "2026-08-24T05:00:00Z",
  firstSeen: "2026-08-24",
  lastSeen: "2026-08-24",
  daysOpen: 0,
  findingKey: "digilist.no/:description.long",
  severity: "warn",
  severityRank: 3,
  category: "seo",
  rule: "description.long",
  surface: "page",
  site: "digilist.no",
  url: "https://digilist.no/",
  keyword: "",
  title: "Meta description is 187 characters",
  detail: "The description on this page is 187 characters; the target is 155.",
  recommendedAction: "Shorten the description to 155 characters.",
  estimatedImpact: "SERP truncation on 339 pages",
  status: "filed",
  targetRepo: "marketing",
  linearIssue: "",
  githubIssue: "343",
  ...over,
});

export const REPO_KEYS = [
  { key: "marketing", repo: "Xala-Technologies/booking-brilliance", base: "main" },
  { key: "app", repo: "Xala-Technologies/Digilist", base: "dev" },
];

export const SITES = [
  { host: "digilist.no", repo: "Xala-Technologies/booking-brilliance", base: "main" },
  { host: "app.digilist.no", repo: "Xala-Technologies/Digilist", base: "dev" },
];

export const ok = (text: string): AssistOutcome => ({ ok: true, text });

/** An in-memory `FiledStore`. The suite must never write into the repo's evidence tree. */
export function memoryStore(seed: Record<string, string> = {}): FiledStore & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    exists: (p) => files.has(p),
    read: (p) => files.get(p) ?? "",
    write: (p, text) => {
      files.set(p, text);
    },
    mkdir: () => undefined,
  };
}

export interface ScriptedExec extends RepairExec {
  argv: string[][];
  removed: string[];
}

/**
 * An exec fake matched by argv SUBSTRING, the same idiom
 * `assist/__tests__/repair.test.ts` uses — the gate needs
 * `git diff --numstat` and `npm ci` distinguished, which a positional fake
 * cannot do.
 */
export function scripted(replies: Record<string, Partial<RepairExecResult>> = {}): ScriptedExec {
  const argv: string[][] = [];
  const removed: string[] = [];
  return {
    argv,
    removed,
    mkdir: () => undefined,
    exists: () => false,
    rm: (p) => {
      removed.push(p);
    },
    run: async (input) => {
      argv.push(input.argv);
      const key = input.argv.join(" ");
      const hit = Object.entries(replies).find(([pattern]) => key.includes(pattern));
      const reply = hit?.[1] ?? {};
      return {
        stdout: reply.stdout ?? "",
        stderr: reply.stderr ?? "",
        exitCode: reply.exitCode ?? 0,
        ...(reply.error !== undefined ? { error: reply.error } : {}),
      };
    },
  };
}
