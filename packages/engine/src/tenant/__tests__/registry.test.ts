import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { containedPath, consoleEvidenceRoot, loadTenant, parseTenant, tenantEvidenceRoot, tenantOwnsTarget, TenantIdSchema } from "../registry.js";
import type { Tenant } from "../types.js";
import { findRepoRoot, tenantsRoot } from "../../repo.js";

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const tenantsDir = tenantsRoot(repoRoot);

const valid = {
  id: "acme",
  name: "Acme AS",
  markets: ["oslo"],
  targets: ["https://acme.example"],
  proxyCredentials: null,
  proxySubUser: null,
  quota: { trafficMb: 100, runsPerDay: 10 },
  retentionDays: 30,
};

const tenant = (over: Partial<Tenant> = {}): Tenant => ({ ...valid, ...over });

describe("TenantSchema", () => {
  it("parses a complete tenant", () => {
    const parsed = parseTenant(valid);
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    expect(parsed.value.id).toBe("acme");
  });

  it("defaults proxyCredentials to null rather than an empty string", () => {
    // Absent means "use the shared default". A tenant naming an EMPTY variable is a
    // different thing — a credential that will not resolve — so an optional field
    // defaulted to "" would collapse the two.
    const { proxyCredentials: _omitted, ...withoutCreds } = valid;
    const parsed = parseTenant(withoutCreds);
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    expect(parsed.value.proxyCredentials).toBeNull();
  });

  it("REFUSES an unknown key rather than ignoring it", () => {
    // Same reasoning as the config loader: a misspelled `retentionDay` that silently
    // became the default is a retention policy somebody set on purpose and never got.
    const parsed = parseTenant({ ...valid, retentionDay: 7 });
    expect(parsed.ok).toBe(false);
  });

  it("requires at least one market and one target", () => {
    expect(parseTenant({ ...valid, markets: [] }).ok).toBe(false);
    expect(parseTenant({ ...valid, targets: [] }).ok).toBe(false);
  });

  it("requires targets to be URLs, so an allowlist cannot be a wish", () => {
    expect(parseTenant({ ...valid, targets: ["digilist.no"] }).ok).toBe(false);
  });

  it("refuses a non-positive quota, because zero would mean an unusable tenant nobody noticed creating", () => {
    expect(parseTenant({ ...valid, quota: { trafficMb: 0, runsPerDay: 10 } }).ok).toBe(false);
    expect(parseTenant({ ...valid, quota: { trafficMb: 10, runsPerDay: 0 } }).ok).toBe(false);
    expect(parseTenant({ ...valid, retentionDays: 0 }).ok).toBe(false);
  });
});

describe("TenantIdSchema — the id becomes a directory name", () => {
  it("accepts a plain slug and inner hyphens", () => {
    for (const id of ["acme", "digilist", "acme-as", "a1", "tenant-2-b"]) {
      expect(TenantIdSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it("refuses everything that could traverse or collide", () => {
    const refused = [
      "..", "../other", "a/b", "a\\b", "a.b", // separators and dots
      "", "a", // empty and too short to be meaningful
      "-acme", "acme-", // could read as a CLI flag
      "Acme", "ACME", // case-insensitive filesystems would fold these together
      " acme", "acme ", "ac me", // whitespace
      "acme\u0000", // a NUL, written as an escape so this file stays greppable text
      "a".repeat(41), // longer than the cap
    ];
    for (const id of refused) expect(TenantIdSchema.safeParse(id).success, JSON.stringify(id)).toBe(false);
  });

  it("refuses uppercase for a stated reason, not on style", () => {
    // macOS and Windows are case-INSENSITIVE, Linux is not. `Acme` and `acme` would
    // be two tenants in CI and one on a developer's laptop — a cross-tenant read that
    // only reproduces on the machine nobody tests on.
    expect(TenantIdSchema.safeParse("Acme").success).toBe(false);
    expect(TenantIdSchema.safeParse("acme").success).toBe(true);
  });
});

describe("containedPath — the containment primitive", () => {
  const root = "/var/geoqa/evidence";

  it("returns a path under the root", () => {
    expect(containedPath(root, "acme")).toEqual({ ok: true, value: path.resolve(root, "acme") });
    expect(containedPath(root, "acme/run_1")).toEqual({ ok: true, value: path.resolve(root, "acme/run_1") });
  });

  it("REFUSES a segment that climbs above the root", () => {
    for (const segment of ["..", "../..", "../other", "acme/../../etc", "a/b/../../.."]) {
      expect(containedPath(root, segment).ok, segment).toBe(false);
    }
  });

  it("REFUSES an absolute segment, which discards the root entirely", () => {
    // The one most likely to surprise: `path.resolve("/evidence", "/etc")` is `/etc`.
    // Without this check a caller passing an absolute id would write outside the
    // evidence tree with no error at all.
    expect(containedPath(root, "/etc/passwd").ok).toBe(false);
    expect(containedPath(root, "/").ok).toBe(false);
  });

  it("REFUSES a segment that resolves to the root itself", () => {
    // Would hand one tenant the shared tree containing everybody's evidence.
    expect(containedPath(root, "").ok).toBe(false);
    expect(containedPath(root, ".").ok).toBe(false);
    expect(containedPath(root, "acme/..").ok).toBe(false);
  });

  it("does not mistake a PREFIX for containment", () => {
    // `/var/geoqa/evidence/acme` starts with `/var/geoqa/evidence/ac`. A startsWith
    // test would call `acme` contained by `ac`.
    const ac = containedPath(root, "ac");
    if (!ac.ok) throw new Error("ac should resolve");
    const escaping = containedPath(ac.value, "../acme");
    expect(escaping.ok).toBe(false);
  });

  it("says which path it refused and what it was not inside", () => {
    const result = containedPath(root, "../elsewhere");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.errors[0]).toContain("is not inside");
    expect(result.errors[0]).toContain("cross-tenant read");
  });
});

describe("consoleEvidenceRoot — the console reads the tenant it is operating", () => {
  const root = "/var/geoqa/evidence";

  it("nests under the first tenant, so a --tenant run is visible on the overview", () => {
    // The console used to read the shared root while every real run wrote
    // `<root>/<tenantId>/`. Overview then showed 0 visits next to a PASS on disk.
    expect(consoleEvidenceRoot(root, "digilist")).toBe(path.resolve(root, "digilist"));
  });

  it("stays on the shared root when there is no tenant", () => {
    expect(consoleEvidenceRoot(root, undefined)).toBe(root);
    expect(consoleEvidenceRoot(root, "")).toBe(root);
  });

  it("refuses to nest a traversing id rather than following it", () => {
    expect(consoleEvidenceRoot(root, "..")).toBe(root);
  });
});

describe("tenantEvidenceRoot — isolation DEMONSTRATED, not asserted", () => {
  const root = "/var/geoqa/evidence";

  it("puts a tenant's evidence under its own directory", () => {
    expect(tenantEvidenceRoot(root, "digilist")).toEqual({ ok: true, value: path.resolve(root, "digilist") });
  });

  it("REFUSES a traversing id — this is a security defect, not a bug", () => {
    for (const id of ["..", "../..", "../other-tenant", "..%2fother"]) {
      const result = tenantEvidenceRoot(root, id);
      expect(result.ok, id).toBe(false);
    }
  });

  it("refuses an absolute id rather than resolving away from the root", () => {
    // `path.resolve(root, "/etc")` is `/etc`: an absolute second argument DISCARDS
    // the first. Without the resolved-path check this would silently write outside
    // the evidence tree entirely.
    const result = tenantEvidenceRoot(root, "/etc/passwd");
    expect(result.ok).toBe(false);
  });

  it("refuses an id that resolves to the root itself", () => {
    // `path.join(root, "")` is the root, so an empty id would hand one tenant the
    // shared tree containing everybody's evidence.
    expect(tenantEvidenceRoot(root, "").ok).toBe(false);
    expect(tenantEvidenceRoot(root, ".").ok).toBe(false);
  });

  it("does not treat a PREFIX as containment", () => {
    // `/var/geoqa/evidence/acme` starts with `/var/geoqa/evidence/ac`, so a
    // `startsWith` test would place tenant `acme` inside tenant `ac`'s root and call
    // it contained. `path.relative` is why this holds.
    const ac = tenantEvidenceRoot(root, "ac");
    const acme = tenantEvidenceRoot(root, "acme");
    if (!ac.ok || !acme.ok) throw new Error("both should resolve");
    expect(acme.value.startsWith(ac.value)).toBe(true);
    // …and yet they are siblings, not nested.
    expect(path.dirname(acme.value)).toBe(path.dirname(ac.value));
  });

  it("keeps two tenants' roots disjoint", () => {
    const a = tenantEvidenceRoot(root, "alpha");
    const b = tenantEvidenceRoot(root, "beta");
    if (!a.ok || !b.ok) throw new Error("both should resolve");
    expect(path.relative(a.value, b.value).startsWith("..")).toBe(true);
  });
});

describe("tenantOwnsTarget", () => {
  it("allows a declared origin and any path under it", () => {
    const t = tenant({ targets: ["https://acme.example"] });
    expect(tenantOwnsTarget(t, "https://acme.example")).toBe(true);
    expect(tenantOwnsTarget(t, "https://acme.example/pricing?a=1#x")).toBe(true);
  });

  it("REFUSES a lookalike host that a prefix test would authorise", () => {
    // `https://acme.example.evil.test` starts with `https://acme.example` as a
    // string. Origin comparison is the reason this is refused.
    const t = tenant({ targets: ["https://acme.example"] });
    expect(tenantOwnsTarget(t, "https://acme.example.evil.test/")).toBe(false);
    expect(tenantOwnsTarget(t, "https://evil.test/https://acme.example")).toBe(false);
  });

  it("treats a different scheme, port or subdomain as NOT declared", () => {
    const t = tenant({ targets: ["https://acme.example"] });
    // A scheme change is what a downgrade looks like; a tenant that declared https
    // has not declared http.
    expect(tenantOwnsTarget(t, "http://acme.example/")).toBe(false);
    expect(tenantOwnsTarget(t, "https://acme.example:8443/")).toBe(false);
    expect(tenantOwnsTarget(t, "https://staging.acme.example/")).toBe(false);
  });

  it("refuses an unparseable URL instead of throwing", () => {
    expect(tenantOwnsTarget(tenant(), "not a url")).toBe(false);
  });

  it("accepts an extra origin the operator added on a watch, without rewriting the tenant file", () => {
    // The console writes watch.yaml, not tenants/digilist.yaml. Ownership must
    // see both lists or a URL added in the UI is refused the moment a sweep starts.
    const t = tenant({ targets: ["https://acme.example"] });
    expect(tenantOwnsTarget(t, "https://app.acme.example/")).toBe(false);
    expect(tenantOwnsTarget(t, "https://app.acme.example/", ["https://app.acme.example"])).toBe(true);
  });

  it("ignores an unparseable entry in the allowlist rather than failing open", () => {
    // A malformed target must not authorise everything, and must not crash a run.
    const t = tenant({ targets: ["::::", "https://acme.example"] });
    expect(tenantOwnsTarget(t, "https://acme.example/")).toBe(true);
    expect(tenantOwnsTarget(t, "https://other.example/")).toBe(false);
  });
});

describe("loadTenant", () => {
  it("loads tenant zero from the repo", () => {
    const loaded = loadTenant(path.join(tenantsDir, "digilist.yaml"), (p) => readFileSync(p, "utf8"));
    if (!loaded.ok) throw new Error(loaded.errors.join("\n"));
    expect(loaded.value.id).toBe("digilist");
    expect(loaded.value.markets).toContain("oslo");
    expect(loaded.value.targets).toContain("https://digilist.no");
    expect(loaded.value.targets).toContain("https://xala.no");
    // A NAME or null, never a value. A tenant file that held a secret would be the
    // .env mistake moved somewhere with worse odds.
    expect(loaded.value.proxyCredentials).toBeNull();
    expect(loaded.value.repositories).toEqual([
      { host: "digilist.no", repo: "Xala-Technologies/booking-brilliance", base: "main" },
      { host: "app.digilist.no", repo: "Xala-Technologies/Digilist", base: "dev" },
      { host: "xala.no", repo: "xalatechnologies/xala-web-cloner", base: "main" },
    ]);
  });

  it("defaults repositories to empty, and refuses a repo that is not owner/name", () => {
    const none = parseTenant(valid);
    if (!none.ok) throw new Error(none.errors.join("\n"));
    expect(none.value.repositories).toEqual([]);
    expect(parseTenant({ ...valid, repositories: [{ host: "x.no", repo: "not-a-repo" }] }).ok).toBe(false);
    expect(parseTenant({ ...valid, repositories: [{ host: "x.no", repo: "../x" }] }).ok).toBe(false);
    expect(parseTenant({ ...valid, repositories: [{ host: "x.no", repo: "acme/site", base: "main", extra: 1 }] }).ok).toBe(false);
  });

  it("reports unreadable YAML with the filename, not a bare parser message", () => {
    const result = loadTenant("/t/broken.yaml", () => "id: [unclosed");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.errors[0]).toContain("/t/broken.yaml");
  });

  it("reports a missing file rather than throwing", () => {
    const result = loadTenant("/t/absent.yaml", () => {
      throw new Error("ENOENT: no such file");
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.errors[0]).toContain("ENOENT");
  });

  it("attributes a schema error to the file", () => {
    const result = loadTenant("/t/bad.yaml", () => "id: Acme\nname: A\nmarkets: [oslo]\ntargets: [https://a.test]\nquota: { trafficMb: 1, runsPerDay: 1 }\nretentionDays: 1\n");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.errors[0]).toContain("/t/bad.yaml");
    expect(result.errors[0]).toContain("directory name");
  });
});
