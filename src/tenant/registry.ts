/**
 * Tenants: YAML in, validated `Tenant` out — and the path safety that makes
 * per-tenant evidence isolation real rather than nominal.
 *
 * Same shape as `geo/profile.ts` and `journeys/spec.ts` on purpose: a tenant is
 * DATA. It cannot reach the browser, a non-engineer can edit it, and it diffs in a
 * review. A database arrives at run persistence, where queries across runs are the
 * actual requirement; introducing one here would buy a schema and a migration path
 * to store six fields nobody queries yet.
 *
 * The part of this file that matters is not the loader. It is
 * `tenantEvidenceRoot`, and the rule it enforces: **a path that can escape its
 * tenant's root is a security defect, not a bug.** One tenant reading another's
 * screenshots is the failure that ends a product, and the ingredients are all
 * present — the tenant id comes from a file on disk, becomes a directory name, and
 * is joined with a root. So it is constrained by pattern AND re-checked after
 * resolution, because a single line of defence against path traversal is a line
 * somebody eventually finds a way round.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Tenant } from "./types.js";

/**
 * The tenant id, constrained hard.
 *
 * Lowercase alphanumerics with inner hyphens, 2–40 characters. Every exclusion is
 * deliberate:
 *
 * - No `/` or `\`, no `.`, and therefore no `..` — the id is a directory name.
 * - No uppercase, because macOS and Windows filesystems are case-INSENSITIVE while
 *   Linux is not: `Acme` and `acme` would be two tenants in CI and one tenant on a
 *   developer's laptop, which is a cross-tenant read that only reproduces on the
 *   machine nobody tests on.
 * - No leading or trailing hyphen, so an id cannot look like a CLI flag.
 * - No empty string, which `path.join` treats as "no segment at all" and which would
 *   silently resolve to the shared root.
 *
 * A regex rather than a sanitiser, because sanitising invites the question "what did
 * it become", and the answer is a second identity for the same tenant.
 */
export const TenantIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/,
    "a tenant id is 2–40 characters of lowercase letters, digits and inner hyphens — it becomes a directory name, so dots, slashes and uppercase are refused",
  );

export const TenantQuotaSchema = z.object({
  trafficMb: z.number().positive(),
  runsPerDay: z.number().int().positive(),
});

export const TenantSchema = z
  .object({
    id: TenantIdSchema,
    name: z.string().min(1),
    markets: z.array(z.string().min(1)).min(1),
    targets: z.array(z.string().url()).min(1),
    // Absent means "use the shared default", which is different from a tenant that
    // names an empty variable — hence a nullable field rather than an optional one
    // defaulted to "".
    proxyCredentials: z.string().min(1).nullable().default(null),
    proxySubUser: z.string().min(1).nullable().default(null),
    quota: TenantQuotaSchema,
    retentionDays: z.number().int().positive(),
  })
  // Unknown keys are an ERROR, matching the config loader's reasoning: a misspelled
  // `retentionDay` that silently became the default is a retention policy somebody
  // set on purpose and never got.
  .strict();

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const issues = (error: z.ZodError): string[] => error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

export function parseTenant(doc: unknown): ParseResult<Tenant> {
  const parsed = TenantSchema.safeParse(doc);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, errors: issues(parsed.error) };
}

/**
 * Load one tenant from disk.
 *
 * `read` is injectable for the same reason `loadJourney`'s is: the unit suite must
 * not depend on a fixture tree it can accidentally point at the real one.
 */
export function loadTenant(file: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): ParseResult<Tenant> {
  let doc: unknown;
  try {
    doc = parseYaml(read(file));
  } catch (e) {
    return { ok: false, errors: [`${file}: ${(e as Error).message}`] };
  }
  const parsed = parseTenant(doc);
  return parsed.ok ? parsed : { ok: false, errors: parsed.errors.map((e) => `${file}: ${e}`) };
}

/**
 * A path under `root`, or a refusal — the containment primitive.
 *
 * Separate and exported because it is the check, not a detail of one caller. Every
 * per-tenant path has to make it: evidence today, and tenant-scoped profiles and
 * journeys next. A containment rule reimplemented per call site is a containment rule
 * that is subtly different in one of them.
 *
 * `path.relative` rather than `startsWith`, and this is the trap worth naming:
 * `/evidence/acme` starts with `/evidence/ac`, so a prefix test would place tenant
 * `acme` inside tenant `ac`'s root and call it contained.
 *
 * Three ways out, all refused. `..` climbs above the root. An ABSOLUTE segment
 * discards the root entirely — `path.resolve("/evidence", "/etc")` is `/etc`, which
 * is the one most likely to surprise. And an empty relative result means the segment
 * resolved to the root itself, which would hand one tenant the shared tree containing
 * everybody's evidence.
 */
export function containedPath(root: string, segment: string): ParseResult<string> {
  const base = path.resolve(root);
  const resolved = path.resolve(base, segment);
  const relative = path.relative(base, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      ok: false,
      errors: [`"${segment}" resolves to ${resolved}, which is not inside ${base} — refusing, because a path that escapes its tenant's root is a cross-tenant read`],
    };
  }
  return { ok: true, value: resolved };
}

/**
 * Where a tenant's evidence lives: `<root>/<tenantId>`.
 *
 * Two independent checks, and the second is not redundant even though the first
 * currently makes it unreachable. The pattern refuses every id that could traverse;
 * `containedPath` refuses anything that got past it — a future relaxation of the
 * pattern, a caller that never went through the schema, or a platform difference in
 * `path.resolve`. Defence in depth is warranted precisely because the consequence is
 * one tenant reading another's evidence, and because the second check costs one
 * comparison.
 */
export function tenantEvidenceRoot(evidenceRoot: string, tenantId: string): ParseResult<string> {
  const validId = TenantIdSchema.safeParse(tenantId);
  if (!validId.success) return { ok: false, errors: issues(validId.error) };
  return containedPath(evidenceRoot, validId.data);
}

/**
 * May this tenant be run against this URL?
 *
 * Origin comparison, not prefix: `https://digilist.no.evil.test` starts with
 * `https://digilist.no` as a string, and a prefix test would authorise an attacker's
 * host. A path under an allowed origin IS allowed, because a tenant that owns a site
 * owns its pages.
 *
 * Refusing here is not bureaucracy. This engine drives a real browser from
 * residential IPs on a schedule, so a target allowlist is the difference between a
 * QA runner and something that looks like distributed traffic aimed at whoever the
 * URL names.
 */
export function tenantOwnsTarget(tenant: Tenant, url: string): boolean {
  let asked: URL;
  try {
    asked = new URL(url);
  } catch {
    return false;
  }
  return tenant.targets.some((target) => {
    try {
      const owned = new URL(target);
      // Origin covers scheme, host and port. An http target does not authorise https
      // or the reverse: a tenant that declared one has not declared the other, and a
      // scheme change is exactly what a downgrade attack looks like.
      return owned.origin === asked.origin;
    } catch {
      return false;
    }
  });
}
