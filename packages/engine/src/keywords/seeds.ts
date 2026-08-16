/**
 * A tenant's keyword seeds, from `tenants/<id>/keywords.yaml`.
 *
 * Data, in a tenant's own directory, for the same reason profiles and journeys are: a
 * non-engineer edits it, it diffs in a review, and it cannot reach the browser. The
 * version this was generalised from held ~60 Norwegian phrases in a TypeScript array,
 * which meant every change to one company's vocabulary was a code change to the engine.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { KeywordSeed } from "./types.js";

export const SearchIntentSchema = z.enum(["commercial", "informational", "comparison", "local", "navigational"]);

export const KeywordSeedSchema = z
  .object({
    term: z.string().min(1),
    intent: SearchIntentSchema,
    // The tenant's own segmentation. Carried through and interpreted by nobody here.
    audience: z.string().min(1).optional(),
    markets: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export const KeywordSeedsSchema = z.object({ terms: z.array(KeywordSeedSchema).min(1) }).strict();

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function parseKeywordSeeds(doc: unknown): ParseResult<KeywordSeed[]> {
  const parsed = KeywordSeedsSchema.safeParse(doc);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  // Duplicates REFUSED rather than de-duplicated: each query costs a real search credit,
  // and a term listed twice by accident silently doubles the bill for that term while
  // adding a second identical row to the report.
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const term of parsed.data.terms) {
    const key = `${term.term.toLowerCase()}|${(term.markets ?? []).join(",")}`;
    if (seen.has(key)) duplicates.push(term.term);
    seen.add(key);
  }
  if (duplicates.length > 0) {
    return { ok: false, errors: [`duplicate term(s): ${duplicates.join(", ")} — each query costs a search credit, so a repeat is a doubled bill rather than a harmless typo`] };
  }
  return { ok: true, value: parsed.data.terms };
}

export function loadKeywordSeeds(file: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): ParseResult<KeywordSeed[]> {
  let doc: unknown;
  try {
    doc = parseYaml(read(file));
  } catch (e) {
    return { ok: false, errors: [`${file}: ${(e as Error).message}`] };
  }
  const parsed = parseKeywordSeeds(doc);
  return parsed.ok ? parsed : { ok: false, errors: parsed.errors.map((e) => `${file}: ${e}`) };
}
