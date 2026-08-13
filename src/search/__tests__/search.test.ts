import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startFixtureServer, type FixtureServer } from "../../fixtures/server.js";
import { googleLanguage, nodeJsonFetch, parseAccountHealth, pickLocation, parseSearchResults, serpApiProvider, serpApiUrl, type JsonFetch } from "../serpapi.js";
import { ABSENT_FROM_SERP_SCORE, observeSearch, scoreForPosition } from "../observation.js";
import type { SearchOutcome } from "../types.js";

/** The real /account body, captured live. */
const LIVE_ACCOUNT = {
  account_status: "Active",
  plan_name: "Developer Plan",
  searches_per_month: 5000,
  plan_searches_left: 2505,
  extra_credits: 0,
  total_searches_left: 2505,
  this_month_usage: 2495,
  account_rate_limit_per_hour: 1000,
};

/** The real 401 body, captured live. */
const LIVE_401 = { error: "Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key" };

describe("parseAccountHealth — the three states a credentials check cannot see", () => {
  it("is USABLE with a live account, and reports the remaining quota", () => {
    const health = parseAccountHealth(200, LIVE_ACCOUNT);
    expect(health.state).toBe("usable");
    expect(health.searchesLeft).toBe(2505);
    expect(health.detail).toContain("2505");
  });

  it("is UNUSABLE for a rejected key, and quotes what the API said", () => {
    const health = parseAccountHealth(401, LIVE_401);
    expect(health.state).toBe("unusable");
    expect(health.detail).toContain("Invalid API key");
  });

  it("is UNUSABLE with valid credentials and NO searches left — the DataForSEO case", () => {
    // The failure this whole file exists for. A credentials-present check reports this
    // account as fine, and then empty results read as "nobody ranks".
    const health = parseAccountHealth(200, { ...LIVE_ACCOUNT, total_searches_left: 0 });
    expect(health.state).toBe("unusable");
    expect(health.searchesLeft).toBe(0);
    expect(health.detail).toContain("NO searches left");
    expect(health.detail).toContain("worse than an absent one");
  });

  it("treats a MISSING quota field as 'does not say', never as zero", () => {
    // Reading a missing field as 0 would make an adapter change look like an exhausted
    // account — and would refuse work for no reason.
    const { total_searches_left: _omitted, ...withoutQuota } = LIVE_ACCOUNT;
    const health = parseAccountHealth(200, withoutQuota);
    expect(health.state).toBe("usable");
    expect(health.searchesLeft).toBeNull();
    expect(health.detail).toContain("did not report a remaining quota");
  });

  it("is unusable for any other status or an unreadable body", () => {
    expect(parseAccountHealth(500, {}).state).toBe("unusable");
    expect(parseAccountHealth(200, null).state).toBe("unusable");
    expect(parseAccountHealth(200, "text").state).toBe("unusable");
    expect(parseAccountHealth(403, {}).state).toBe("unusable");
  });
});

describe("parseSearchResults", () => {
  const ok = {
    search_metadata: { status: "Success" },
    search_information: { total_results: 12_300 },
    organic_results: [
      { position: 1, link: "https://other.test/a", title: "Other" },
      { position: 2, link: "https://digilist.no/priser", title: "Priser" },
    ],
  };

  it("reads organic results and the total", () => {
    const outcome = parseSearchResults(200, ok);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[1]?.url).toBe("https://digilist.no/priser");
    expect(outcome.totalResults).toBe(12_300);
  });

  it("keeps the API's OWN position, so an ad or a snippet does not renumber the list", () => {
    const gapped = { ...ok, organic_results: [{ position: 4, link: "https://a.test/", title: "A" }] };
    const outcome = parseSearchResults(200, gapped);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.results[0]?.position).toBe(4);
  });

  it("falls back to list order when the API gives no position", () => {
    const outcome = parseSearchResults(200, { ...ok, organic_results: [{ link: "https://a.test/" }, { link: "https://b.test/" }] });
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.results.map((r) => r.position)).toEqual([1, 2]);
  });

  it("reports an in-body error as QUOTA when it reads like one, not as transport", () => {
    // SerpApi answers HTTP 200 for a spent plan with the failure inside the body.
    // Guessing "transport" would send somebody to look at the network.
    const outcome = parseSearchResults(200, { error: "Your account has run out of searches" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.kind).toBe("quota");
  });

  it("reports a non-quota in-body error as an unusable response", () => {
    const outcome = parseSearchResults(200, { error: "Unsupported location" });
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.kind).toBe("unusable-response");
  });

  it("refuses a search that did not COMPLETE, even at HTTP 200", () => {
    // Reading only the HTTP status would turn this into an empty result list, and an
    // empty result list is the reading that must never be manufactured.
    const outcome = parseSearchResults(200, { search_metadata: { status: "Processing" }, organic_results: [] });
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toContain("did not complete");
  });

  it("treats NO organic results as UNMEASURED, not as a ranking of nowhere", () => {
    // The central rule. A SERP with genuinely nothing on it is vanishingly rare for a
    // real query; a response we failed to understand is not.
    for (const body of [{ search_metadata: { status: "Success" } }, { search_metadata: { status: "Success" }, organic_results: [] }]) {
      const outcome = parseSearchResults(200, body);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected a refusal");
      expect(outcome.reason).toContain("UNMEASURED");
    }
  });

  it("refuses results whose links it could not read", () => {
    const outcome = parseSearchResults(200, { search_metadata: { status: "Success" }, organic_results: [{ title: "no link" }, null] });
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toContain("no usable links");
  });

  it("maps credentials and rate limits to their own kinds", () => {
    expect(parseSearchResults(401, {})).toMatchObject({ ok: false, kind: "credentials" });
    expect(parseSearchResults(403, {})).toMatchObject({ ok: false, kind: "credentials" });
    expect(parseSearchResults(429, {})).toMatchObject({ ok: false, kind: "quota" });
    expect(parseSearchResults(200, null)).toMatchObject({ ok: false, kind: "unusable-response" });
  });
});

describe("serpApiUrl", () => {
  it("lowercases the country, because an uppercase gl is silently ignored", () => {
    // Silently ignored means worldwide results while the caller believed they had asked
    // about one market — the exact class of lie this project is built around.
    const url = new URL(serpApiUrl("k", { query: "booking", country: "NO" }));
    expect(url.searchParams.get("gl")).toBe("no");
    expect(url.searchParams.get("q")).toBe("booking");
  });

  it("sets `location` only from a RESOLVED canonical name, never from the city as typed", () => {
    // `location=Bergen,NO` is refused by the API. The URL builder therefore takes a
    // resolved name and nothing else, so there is no path by which an unresolved city
    // reaches the query.
    const resolved = new URL(serpApiUrl("k", { query: "lokaler", country: "no", city: "Bergen" }, "Bergen,Vestland,Norway"));
    expect(resolved.searchParams.get("location")).toBe("Bergen,Vestland,Norway");
    // A city with no resolved name sends no location at all — and the PROVIDER refuses
    // such a query outright rather than letting it become a country-wide search.
    const unresolved = new URL(serpApiUrl("k", { query: "lokaler", country: "no", city: "Bergen" }));
    expect(unresolved.searchParams.has("location")).toBe(false);
  });

  it("maps nb-NO to Google's `no`, because `nb` is REFUSED — measured on the first live query", () => {
    // SerpApi answered "Unsupported `nb` interface language - hl parameter." Google's hl
    // for Norwegian is the macrolanguage `no`, not the correct BCP-47 tag a browser
    // sends. The two namespaces genuinely differ.
    expect(new URL(serpApiUrl("k", { query: "q", country: "NO", language: "nb-NO" })).searchParams.get("hl")).toBe("no");
    expect(new URL(serpApiUrl("k", { query: "q", country: "NO", language: "nn-NO" })).searchParams.get("hl")).toBe("no");
  });

  it("reduces every other tag to its primary subtag, which is correct for the rest", () => {
    expect(googleLanguage("sv-SE")).toBe("sv");
    expect(googleLanguage("de-DE")).toBe("de");
    expect(googleLanguage("da-DK")).toBe("da");
    expect(googleLanguage("en-GB")).toBe("en");
    expect(googleLanguage("de")).toBe("de");
  });

  it("passes the limit through and defaults it", () => {
    expect(new URL(serpApiUrl("k", { query: "q", country: "NO" })).searchParams.get("num")).toBe("10");
    expect(new URL(serpApiUrl("k", { query: "q", country: "NO", limit: 25 })).searchParams.get("num")).toBe("25");
  });
});

describe("pickLocation — the first match is not always the right place", () => {
  /** The real /locations.json body for "Oslo", captured live. */
  const OSLO = [
    { canonical_name: "Oslo,Oslo,Norway", country_code: "NO", target_type: "City", reach: 1_360_000 },
    { canonical_name: "Oslo,Minnesota,United States", country_code: "US", target_type: "City", reach: 0 },
    { canonical_name: "Oslo,Norway", country_code: "NO", target_type: "County", reach: 2_500_000 },
    { canonical_name: "Oslo Municipality,Oslo,Norway", country_code: "NO", target_type: "Municipality", reach: 2_500_000 },
  ];

  it("filters by COUNTRY, so Oslo Minnesota cannot answer for Oslo Norway", () => {
    // Taking the first result would have run a Norwegian market's SERP from Minnesota
    // and reported it as Oslo — a silent geographic substitution arriving through a
    // helper nobody would have looked at.
    expect(pickLocation(OSLO, "NO")).toBe("Oslo,Oslo,Norway");
    expect(pickLocation(OSLO, "US")).toBe("Oslo,Minnesota,United States");
  });

  it("prefers a CITY over the County and Municipality that share its name", () => {
    // Even though both of those have a higher `reach`. "Oslo" from a human means the
    // city.
    expect(pickLocation(OSLO, "NO")).toBe("Oslo,Oslo,Norway");
  });

  it("prefers the larger city when two cities share a name in one country", () => {
    const twins = [
      { canonical_name: "Small,Region,Norway", country_code: "NO", target_type: "City", reach: 100 },
      { canonical_name: "Large,Region,Norway", country_code: "NO", target_type: "City", reach: 900_000 },
    ];
    expect(pickLocation(twins, "NO")).toBe("Large,Region,Norway");
  });

  it("falls back to a non-city entry when that is all the country has", () => {
    const only = [{ canonical_name: "Somewhere,Norway", country_code: "NO", target_type: "County", reach: 5 }];
    expect(pickLocation(only, "NO")).toBe("Somewhere,Norway");
  });

  it("returns NULL for no match, an empty list or a shape it did not expect", () => {
    expect(pickLocation(OSLO, "SE")).toBeNull();
    expect(pickLocation([], "NO")).toBeNull();
    expect(pickLocation(null, "NO")).toBeNull();
    expect(pickLocation([null, 42, { country_code: "NO" }], "NO")).toBeNull();
  });

  it("is case-insensitive about the country code", () => {
    expect(pickLocation(OSLO, "no")).toBe("Oslo,Oslo,Norway");
  });
});

describe("serpApiProvider", () => {
  const fetching = (status: number, body: unknown): JsonFetch => () => Promise.resolve({ status, body });

  it("is UNCONFIGURED without a key, which is not the same as unusable", () => {
    // An absent key is a setup step; a rejected one is a broken account. Collapsing them
    // would send a new operator to check their billing.
    return Promise.all([
      serpApiProvider({ apiKey: undefined }).health(),
      serpApiProvider({ apiKey: "" }).health(),
    ]).then(([a, b]) => {
      expect(a.state).toBe("unconfigured");
      expect(b.state).toBe("unconfigured");
      expect(a.detail).toContain("SERPAPI_KEY is not set");
    });
  });

  it("probes the account for real, and never consumes a search to do it", async () => {
    const fetchJson = vi.fn(fetching(200, LIVE_ACCOUNT));
    const health = await serpApiProvider({ apiKey: "k", fetchJson }).health();
    expect(health.state).toBe("usable");
    // /account, not /search: a health check that spent quota would be a health check
    // nobody could afford to run.
    expect(fetchJson.mock.calls[0]?.[0]).toContain("/account");
    expect(fetchJson.mock.calls[0]?.[0]).not.toContain("/search");
  });

  it("is unusable when the API does not answer at all", async () => {
    const health = await serpApiProvider({ apiKey: "k", fetchJson: () => Promise.resolve(null) }).health();
    expect(health.state).toBe("unusable");
    expect(health.detail).toContain("could not verify");
  });

  it("refuses to search without a key, and reports a transport failure as one", async () => {
    expect(await serpApiProvider({ apiKey: undefined }).search({ query: "q", country: "NO" })).toMatchObject({ ok: false, kind: "credentials" });
    const dead = serpApiProvider({ apiKey: "k", fetchJson: () => Promise.resolve(null) });
    expect(await dead.search({ query: "q", country: "NO" })).toMatchObject({ ok: false, kind: "transport" });
  });

  it("RESOLVES a city before searching, and never sends the city as typed", async () => {
    // `location=Oslo,NO` is refused by the API — measured. The accepted form is a
    // canonical name from the vendor's gazetteer whose shape is not derivable.
    const calls: string[] = [];
    const fetchJson: JsonFetch = (url) => {
      calls.push(url);
      if (url.includes("/locations.json")) {
        return Promise.resolve({ status: 200, body: [{ canonical_name: "Oslo,Oslo,Norway", country_code: "NO", target_type: "City", reach: 1 }] });
      }
      return Promise.resolve({ status: 200, body: { search_metadata: { status: "Success" }, organic_results: [{ position: 1, link: "https://a.test/" }] } });
    };
    const outcome = await serpApiProvider({ apiKey: "k", fetchJson }).search({ query: "q", country: "NO", city: "Oslo" });
    expect(outcome.ok).toBe(true);
    expect(calls[0]).toContain("/locations.json");
    expect(calls[1]).toContain(encodeURIComponent("Oslo,Oslo,Norway"));
    expect(calls[1]).not.toContain(encodeURIComponent("Oslo,NO"));
  });

  it("REFUSES an unresolvable city instead of silently searching the whole country", async () => {
    // The worst available option would be to drop the city: the caller asked what a
    // visitor in that city sees, and would be handed the whole country with nothing
    // saying so.
    const fetchJson: JsonFetch = () => Promise.resolve({ status: 200, body: [] });
    const outcome = await serpApiProvider({ apiKey: "k", fetchJson }).search({ query: "q", country: "NO", city: "Atlantis" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toContain("Refusing rather than running a country-wide search");
  });

  it("reports an unreachable gazetteer as a transport failure", async () => {
    const outcome = await serpApiProvider({ apiKey: "k", fetchJson: () => Promise.resolve(null) }).search({ query: "q", country: "NO", city: "Oslo" });
    expect(outcome).toMatchObject({ ok: false, kind: "transport" });
  });

  it("does not look up a location when no city was asked for", async () => {
    const calls: string[] = [];
    const fetchJson: JsonFetch = (url) => {
      calls.push(url);
      return Promise.resolve({ status: 200, body: { search_metadata: { status: "Success" }, organic_results: [{ position: 1, link: "https://a.test/" }] } });
    };
    await serpApiProvider({ apiKey: "k", fetchJson }).search({ query: "q", country: "NO" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/search");
  });

  it("searches and parses", async () => {
    const provider = serpApiProvider({
      apiKey: "k",
      fetchJson: fetching(200, { search_metadata: { status: "Success" }, organic_results: [{ position: 1, link: "https://a.test/" }] }),
    });
    const outcome = await provider.search({ query: "q", country: "NO" });
    expect(outcome.ok).toBe(true);
  });
});

describe("scoreForPosition", () => {
  it("is steep near the top, because the gap between 1st and 3rd is what matters", () => {
    // A linear scale would flatter a page nobody clicks.
    expect(scoreForPosition(1)).toBe(100);
    expect(scoreForPosition(3)).toBe(90);
    expect(scoreForPosition(10)).toBe(55);
  });

  it("floors rather than going negative — 40th and 400th are the same to a visitor", () => {
    expect(scoreForPosition(40)).toBe(5);
    expect(scoreForPosition(400)).toBe(5);
    expect(scoreForPosition(0)).toBe(100);
  });
});

describe("observeSearch — the three states", () => {
  const populated = (urls: string[]): SearchOutcome => ({
    ok: true,
    totalResults: 100,
    results: urls.map((url, i) => ({ position: i + 1, url, title: "t" })),
  });

  it("is NULL when the provider could not answer — never a zero", () => {
    // An exhausted account returns no results, and "your site is invisible" is far too
    // alarming a claim to make on the strength of that.
    const observation = observeSearch({ ok: false, reason: "no searches left", kind: "quota" }, "https://digilist.no/");
    expect(observation.score).toBeNull();
    expect(observation.reason).toContain("unmeasured");
    expect(observation.reason).toContain("no searches left");
  });

  it("scores a real ranking by position", () => {
    const observation = observeSearch(populated(["https://other.test/", "https://digilist.no/priser"]), "https://digilist.no/");
    expect(observation.position).toBe(2);
    expect(observation.score).toBe(95);
    expect(observation.examined).toBe(2);
  });

  it("gives a populated SERP without us a real LOW score, distinguishable from unmeasured", () => {
    // The case worth having a SERP source for at all: the engine looked, the SERP was
    // populated, the tenant was not on it. Hedging that into null would waste the one
    // honest signal the axis can produce — and it is a small NUMBER rather than 0 so a
    // reader can tell a measured absence from an unmeasured one at a glance.
    const observation = observeSearch(populated(["https://a.test/", "https://b.test/"]), "https://digilist.no/");
    expect(observation.score).toBe(ABSENT_FROM_SERP_SCORE);
    expect(observation.score).not.toBeNull();
    expect(observation.position).toBeNull();
    expect(observation.reason).toContain("MEASURED absence");
  });

  it("matches by ORIGIN, so a lookalike host cannot be credited to the tenant", () => {
    // `https://digilist.no.evil.test` contains `https://digilist.no`, and a containment
    // test would credit a typosquatter's page as the tenant ranking.
    const observation = observeSearch(populated(["https://digilist.no.evil.test/"]), "https://digilist.no/");
    expect(observation.position).toBeNull();
    expect(observation.score).toBe(ABSENT_FROM_SERP_SCORE);
  });

  it("credits a deep link to the tenant's own site", () => {
    const observation = observeSearch(populated(["https://digilist.no/blogg/en-post"]), "https://digilist.no/");
    expect(observation.position).toBe(1);
  });

  it("treats a different scheme or port as a different site", () => {
    expect(observeSearch(populated(["http://digilist.no/"]), "https://digilist.no/").position).toBeNull();
  });

  it("is NULL when the URL to look for is not a URL", () => {
    const observation = observeSearch(populated(["https://a.test/"]), "not a url");
    expect(observation.score).toBeNull();
    expect(observation.reason).toContain("not a URL");
  });

  it("skips a result whose own link will not parse rather than failing", () => {
    const outcome: SearchOutcome = { ok: true, totalResults: null, results: [{ position: 1, url: ":::", title: "" }, { position: 2, url: "https://digilist.no/", title: "" }] };
    expect(observeSearch(outcome, "https://digilist.no/").position).toBe(2);
  });
});

describe("nodeJsonFetch", () => {
  // The real HTTP adapter, exercised over loopback against the local fixture server —
  // the same treatment `nodeHistoryFs` and `nodePruneFs` get, and consistent with the
  // fixture-server tests that already use `fetch` on 127.0.0.1. Every other test in this
  // file replaces it, so without this the one piece that actually talks HTTP would be
  // the one piece never run. No third party is involved and no quota is spent.
  let server: FixtureServer;
  beforeAll(async () => {
    server = await startFixtureServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it("returns the status and the parsed body", async () => {
    const result = await nodeJsonFetch(`${server.origin}/ipinfo`);
    expect(result?.status).toBe(200);
    expect((result?.body as { country?: string }).country).toBe("NO");
  });

  it("returns NULL when the body is not JSON — a transport failure, not an empty answer", async () => {
    // This is the distinction the whole module turns on: "could not read" must never
    // arrive as "read nothing".
    expect(await nodeJsonFetch(`${server.origin}/no-such-fixture`)).toBeNull();
  });

  it("returns NULL when nothing is listening", async () => {
    // Port 1 has no listener, so this exercises the catch rather than a status code.
    expect(await nodeJsonFetch("http://127.0.0.1:1/account")).toBeNull();
  });
});
