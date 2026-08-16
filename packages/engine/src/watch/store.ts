/**
 * Watch files on disk: YAML in, validated `WatchSpec` out, and the patch
 * the console applies when an operator changes a checkbox.
 *
 * Same shape as `tenant/registry.ts` on purpose. `read` and `write` are
 * injectable so the suite never points at `tenants/digilist/watch.yaml`.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseWatch, type ParseResult, type WatchSpec } from "./spec.js";

export function watchPath(tenantsDir: string, tenantId: string): string {
  return path.join(tenantsDir, tenantId, "watch.yaml");
}

export function loadWatch(file: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): ParseResult<WatchSpec> {
  let doc: unknown;
  try {
    doc = parseYaml(read(file));
  } catch (e) {
    return { ok: false, errors: [`${file}: ${(e as Error).message}`] };
  }
  const parsed = parseWatch(doc);
  return parsed.ok ? parsed : { ok: false, errors: parsed.errors.map((e) => `${file}: ${e}`) };
}

export function saveWatch(
  file: string,
  spec: WatchSpec,
  write: (p: string, text: string) => void = (p, text) => {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text, "utf8");
  },
): void {
  const body = stringifyYaml(spec, { lineWidth: 0 });
  write(
    file,
    [
      "# Operator-controlled watch. The console writes this file; do not put credentials here.",
      "# Markets must be ones the tenant listed. A writes journey needs allowWrites: true.",
      body,
    ].join("\n"),
  );
}

export interface WatchAllowed {
  markets: string[];
  journeys: { id: string; writes: boolean }[];
}

/**
 * Markets this tenant asked for AND we can actually serve.
 *
 * The disk list includes every profile (Berlin, London, …). Offering those
 * as Watch checkboxes lets the operator arm a market `planSweep` then
 * refuses — a checkbox that cannot start is a bill, not a choice. Tenant
 * order is kept: that is the operator's order, not the filesystem's.
 */
export function watchableMarkets(tenantMarkets: string[], profilesOnDisk: string[]): string[] {
  const have = new Set(profilesOnDisk);
  return tenantMarkets.filter((m) => have.has(m));
}

/**
 * Apply a partial update from the console.
 *
 * Unknown keys are refused by `parseWatch` on the merged object, so a typo
 * in a PATCH cannot silently drop a field. Markets and journeys are checked
 * against what is actually on disk — a checkbox for a profile that was
 * deleted is not a sweep, it is a bill for a market we cannot serve.
 */
export function applyWatchPatch(current: WatchSpec, patch: unknown, allowed: WatchAllowed): ParseResult<WatchSpec> {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, errors: ["a watch patch must be an object"] };
  }
  const merged = parseWatch({ ...current, ...patch });
  if (!merged.ok) return merged;

  const unknownMarkets = merged.value.markets.filter((m) => !allowed.markets.includes(m));
  if (unknownMarkets.length > 0) {
    return { ok: false, errors: [`no profile on disk for market(s): ${unknownMarkets.join(", ")}`] };
  }

  const byId = new Map(allowed.journeys.map((j) => [j.id, j]));
  for (const id of merged.value.journeys) {
    const found = byId.get(id);
    if (found === undefined) return { ok: false, errors: [`no such journey: ${id}`] };
    if (found.writes && !merged.value.allowWrites) {
      return {
        ok: false,
        errors: [`journey "${id}" declares writes:true — turn on allowWrites before selecting it`],
      };
    }
  }
  return merged;
}
