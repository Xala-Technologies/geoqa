import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { expandKeywordTasks, opportunities, researchKeywords } from "../research.js";
import { loadKeywordSeeds, parseKeywordSeeds } from "../seeds.js";
import type { KeywordReport, KeywordSeed } from "../types.js";
import type { Market } from "../../geo/types.js";
import type { SearchOutcome, SearchProvider } from "../../search/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const market = (id: string, city: string, country = "NO"): Market => ({
  id,
  country,
  city,
  language: "nb-NO",
  timezone: "Europe/Oslo",
  currency: "NOK",
  coordinates: [59.9, 10.7],
});

const OSLO = market("oslo", "Oslo");
const BERGEN = market("bergen", "Bergen");

const provider = (
  answer: (query: string) => SearchOutcome,
  health: SearchProvider extends { health: () => Promise<infer H> } ? Partial<H> : never = {} as never,
): SearchProvider => ({
  name: "fake",
  health: () => Promise.resolve({ state: "usable", detail: "ok", searchesLeft: 1000, ...health }),
  search: (q) => Promise.resolve(answer(q.query)),
});

const populated = (urls: string[]): SearchOutcome => ({
  ok: true,
  totalResults: 100,
  results: urls.map((url, i) => ({ position: i + 1, url, title: "t" })),
});

describe("parseKeywordSeeds", () => {
  it("parses terms with a generic intent and a free-text audience", () => {
    // `audience` is the tenant's own segmentation. The version this was generalised from
    // had "municipal" and "private" as first-class INTENTS, which are segments of one
    // market rather than kinds of search — wrong for the second tenant.
    const parsed = parseKeywordSeeds({ terms: [{ term: "leie lokaler", intent: "local", audience: "private" }] });
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    expect(parsed.value[0]).toEqual({ term: "leie lokaler", intent: "local", audience: "private" });
  });

  it("refuses an intent outside the fixed vocabulary", () => {
    expect(parseKeywordSeeds({ terms: [{ term: "x", intent: "municipal" }] }).ok).toBe(false);
  });

  it("REFUSES a duplicate term rather than de-duplicating it", () => {
    // Each query costs a real search credit, so a term listed twice is a doubled bill for
    // that term plus a second identical row in the report — not a harmless typo.
    const parsed = parseKeywordSeeds({
      terms: [{ term: "leie lokaler", intent: "local" }, { term: "Leie Lokaler", intent: "commercial" }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected a refusal");
    expect(parsed.errors[0]).toContain("doubled bill");
  });

  it("allows the same term in DIFFERENT markets, which is not a duplicate", () => {
    const parsed = parseKeywordSeeds({
      terms: [
        { term: "leie lokaler", intent: "local", markets: ["oslo"] },
        { term: "leie lokaler", intent: "local", markets: ["bergen"] },
      ],
    });
    expect(parsed.ok).toBe(true);
  });

  it("refuses unknown keys and an empty list", () => {
    expect(parseKeywordSeeds({ terms: [{ term: "x", intent: "local", volume: 100 }] }).ok).toBe(false);
    expect(parseKeywordSeeds({ terms: [] }).ok).toBe(false);
  });

  it("loads tenant zero's seeds, and none of them live in src/", () => {
    const loaded = loadKeywordSeeds(path.join(repoRoot, "tenants", "digilist", "keywords.yaml"), (p) => readFileSync(p, "utf8"));
    if (!loaded.ok) throw new Error(loaded.errors.join("\n"));
    expect(loaded.value.length).toBeGreaterThan(5);
    expect(loaded.value.some((t) => t.audience === "public-sector")).toBe(true);
  });

  it("reports a bad file with its name", () => {
    const result = loadKeywordSeeds("/t/bad.yaml", () => "terms: [unclosed");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.errors[0]).toContain("/t/bad.yaml");
  });
});

describe("expandKeywordTasks", () => {
  const seeds: KeywordSeed[] = [
    { term: "a", intent: "local" },
    { term: "b", intent: "local", markets: ["bergen"] },
  ];

  it("checks a plain term in every market and a scoped term only where it is named", () => {
    // Not an optimisation: a term about winter access is a real question in Tromsø and
    // noise in Berlin, and querying it everywhere spends credits to learn nothing.
    const { tasks } = expandKeywordTasks(seeds, [OSLO, BERGEN]);
    expect(tasks.map((t) => `${t.seed.term}@${t.market.id}`)).toEqual(["a@oslo", "a@bergen", "b@bergen"]);
  });

  it("WARNS about a market the tenant does not have rather than ignoring it", () => {
    // It is a typo in a config file, and the alternative is a term that quietly stops
    // being tracked.
    const { tasks, warnings } = expandKeywordTasks([{ term: "c", intent: "local", markets: ["atlantis"] }], [OSLO]);
    expect(tasks).toEqual([]);
    expect(warnings[0]).toContain("atlantis");
    expect(warnings[0]).toContain("skipped");
  });
});

describe("researchKeywords", () => {
  const seeds: KeywordSeed[] = [{ term: "leie lokaler", intent: "local" }];

  it("scores a ranking and names who holds position 1", () => {
    return researchKeywords({
      tenantId: "acme",
      ownUrl: "https://acme.test",
      seeds,
      markets: [OSLO],
      provider: provider(() => populated(["https://rival.test/a", "https://acme.test/lokaler"])),
    }).then((report) => {
      expect(report.observations[0]?.position).toBe(2);
      expect(report.observations[0]?.topCompetitor).toBe("rival.test");
      expect(report.measured).toBe(1);
    });
  });

  it("REFUSES the whole run when the provider is unusable, instead of N unmeasured rows", async () => {
    // Without this an exhausted account produces a report that looks like a tenant with
    // no search presence rather than like a billing problem.
    const search = vi.fn(() => Promise.resolve(populated([])));
    const report = await researchKeywords({
      tenantId: "acme",
      ownUrl: "https://acme.test",
      seeds,
      markets: [OSLO],
      provider: { name: "f", health: () => Promise.resolve({ state: "unusable", detail: "no searches left", searchesLeft: 0 }), search },
    });
    expect(report.queried).toBe(0);
    expect(report.observations).toEqual([]);
    expect(report.warnings.join(" ")).toContain("no searches left");
    // Not a single credit spent.
    expect(search).not.toHaveBeenCalled();
  });

  it("REFUSES a run that would exceed the budget, before spending anything", async () => {
    // A provider exhausted halfway leaves the second half silently unmeasured, and a
    // report with a hole in it that averages the rest is worse than no report.
    const search = vi.fn(() => Promise.resolve(populated([])));
    const many: KeywordSeed[] = Array.from({ length: 5 }, (_, i) => ({ term: `t${i}`, intent: "local" }));
    const report = await researchKeywords({
      tenantId: "acme",
      ownUrl: "https://acme.test",
      seeds: many,
      markets: [OSLO, BERGEN],
      budget: 4,
      provider: { name: "f", health: () => Promise.resolve({ state: "usable", detail: "ok", searchesLeft: 1000 }), search },
    });
    expect(report.queried).toBe(0);
    expect(report.warnings.join(" ")).toContain("10 query(ies) would exceed the 4");
    expect(search).not.toHaveBeenCalled();
  });

  it("takes the provider's remaining quota as the ceiling when no budget is given", async () => {
    const search = vi.fn(() => Promise.resolve(populated([])));
    const report = await researchKeywords({
      tenantId: "acme",
      ownUrl: "https://acme.test",
      seeds: [{ term: "a", intent: "local" }, { term: "b", intent: "local" }],
      markets: [OSLO],
      provider: { name: "f", health: () => Promise.resolve({ state: "usable", detail: "ok", searchesLeft: 1 }), search },
    });
    expect(report.queried).toBe(0);
    expect(search).not.toHaveBeenCalled();
  });

  it("averages the MEASURED rows only, so a failure cannot read as poor visibility", async () => {
    // One ranking at #1 (100) and one failed query. The mean must be 100, not 50.
    const report = await researchKeywords({
      tenantId: "acme",
      ownUrl: "https://acme.test",
      seeds: [{ term: "good", intent: "local" }, { term: "bad", intent: "local" }],
      markets: [OSLO],
      provider: provider((q) =>
        q === "good" ? populated(["https://acme.test/"]) : { ok: false, reason: "rate limited", kind: "quota" },
      ),
    });
    expect(report.queried).toBe(2);
    expect(report.measured).toBe(1);
    expect(report.meanScore).toBe(100);
    const failed = report.observations.find((o) => o.term === "bad");
    expect(failed?.score).toBeNull();
    expect(failed?.topCompetitor).toBeNull();
  });

  it("reports NULL mean when nothing was measured, never zero", async () => {
    const report = await researchKeywords({
      tenantId: "acme",
      ownUrl: "https://acme.test",
      seeds,
      markets: [OSLO],
      provider: provider(() => ({ ok: false, reason: "down", kind: "transport" })),
    });
    expect(report.measured).toBe(0);
    expect(report.meanScore).toBeNull();
  });

  it("reports no competitor when the top result's own URL will not parse", async () => {
    // A malformed link in a SERP response must not crash a report, and it must not become
    // a competitor name either — an unreadable URL is not a host.
    const report = await researchKeywords({
      tenantId: "acme",
      ownUrl: "https://acme.test",
      seeds,
      markets: [OSLO],
      provider: provider(() => ({ ok: true, totalResults: 1, results: [{ position: 1, url: ":::", title: "" }] })),
    });
    expect(report.observations[0]?.topCompetitor).toBeNull();
    // And the row is still a MEASURED absence, because a SERP did come back.
    expect(report.observations[0]?.score).not.toBeNull();
  });

  it("carries the tenant's own audience through untouched", async () => {
    const report = await researchKeywords({
      tenantId: "acme",
      ownUrl: "https://acme.test",
      seeds: [{ term: "x", intent: "local", audience: "hospitals" }],
      markets: [OSLO],
      provider: provider(() => populated(["https://acme.test/"])),
    });
    expect(report.observations[0]?.audience).toBe("hospitals");
  });
});

describe("opportunities", () => {
  const report = (obs: KeywordReport["observations"]): KeywordReport => ({
    tenantId: "acme",
    queried: obs.length,
    measured: obs.filter((o) => o.score !== null).length,
    observations: obs,
    meanScore: null,
    warnings: [],
  });

  it("lists measured absences and EXCLUDES the unmeasured ones", () => {
    // A "things to fix" list containing queries nobody managed to run would send somebody
    // to rewrite a page over a billing problem — and it is exactly the kind of list that
    // gets acted on without being read closely.
    const gaps = opportunities(
      report([
        { term: "absent", intent: "local", audience: null, marketId: "oslo", score: 2, position: null, examined: 9, reason: "", topCompetitor: "a.test" },
        { term: "unmeasured", intent: "local", audience: null, marketId: "oslo", score: null, position: null, examined: null, reason: "", topCompetitor: null },
        { term: "ranking", intent: "local", audience: null, marketId: "oslo", score: 90, position: 3, examined: 10, reason: "", topCompetitor: "a.test" },
      ]),
    );
    expect(gaps.map((o) => o.term)).toEqual(["absent"]);
  });

  it("orders the most contested term first", () => {
    // A term with a full page of competitors is a real market; one with two results may
    // be a phrase nobody searches.
    const gaps = opportunities(
      report([
        { term: "thin", intent: "local", audience: null, marketId: "oslo", score: 2, position: null, examined: 2, reason: "", topCompetitor: null },
        { term: "contested", intent: "local", audience: null, marketId: "oslo", score: 2, position: null, examined: 10, reason: "", topCompetitor: null },
      ]),
    );
    expect(gaps.map((o) => o.term)).toEqual(["contested", "thin"]);
  });
});
