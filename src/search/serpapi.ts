/**
 * SerpApi as a `SearchProvider`.
 *
 * Named for the vendor we actually have credentials for. The gap register said
 * "Serper"; the working account is SerpApi, and building against a vendor whose key
 * nobody has would have produced an adapter nothing could prove.
 *
 * Both response shapes were captured live rather than taken from docs:
 *
 *   GET /account?api_key=…            → 200 {"account_status":"Active",
 *                                            "total_searches_left":2505,
 *                                            "account_rate_limit_per_hour":1000, …}
 *   GET /account?api_key=deadbeef     → 401 {"error":"Invalid API key. …"}
 *
 * Those two are the whole reason this file can have an honest `health()`: a 401 and a
 * `total_searches_left: 0` are different failures that need different actions — fix the
 * key, versus top up the account — and a credentials-present check cannot tell them
 * apart. That is the DataForSEO failure recorded in `network/types.ts`, and the
 * DataForSEO account is overdrawn right now while still authenticating.
 *
 * `fetchJson` is injected so the unit suite opens no socket and consumes no search
 * quota. A search costs real money here; a test that spent one would be a test nobody
 * runs twice.
 */
import type { SearchHealth, SearchOutcome, SearchProvider, SearchQuery, SearchResult } from "./types.js";

export const SERPAPI_BASE = "https://serpapi.com";

/** What one HTTP call returned: a status and a parsed body, or a transport failure. */
export type JsonFetch = (url: string) => Promise<{ status: number; body: unknown } | null>;

export const nodeJsonFetch: JsonFetch = async (url) => {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      // A SERP lookup must never be the thing that hangs a run.
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, body: await response.json() };
  } catch {
    return null;
  }
};

/**
 * Parse `/account`.
 *
 * The three states are the point, and the middle one is the one everybody gets wrong:
 *
 * - 401 → `unusable`, because the key is wrong. Actionable: fix the key.
 * - 200 with `total_searches_left: 0` → **`unusable`**, because a source that cannot
 *   answer is worse than an absent one. Actionable: top up. This is the case a
 *   credentials-present check reports as fine.
 * - 200 with quota → `usable`, carrying the remaining count so a caller can refuse a
 *   sweep that would exhaust it.
 *
 * A body that parses but carries no `total_searches_left` is `usable` with
 * `searchesLeft: null` — "the provider does not say" — never `0`. Reading a missing
 * field as zero would make an adapter change look like an exhausted account.
 */
export function parseAccountHealth(status: number, body: unknown): SearchHealth {
  if (status === 401 || status === 403) {
    const message = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "the API rejected the key";
    return { state: "unusable", detail: `SerpApi rejected the credentials: ${message}`, searchesLeft: null };
  }
  if (status !== 200 || typeof body !== "object" || body === null) {
    return { state: "unusable", detail: `SerpApi answered HTTP ${status} with a body this adapter could not read`, searchesLeft: null };
  }
  const record = body as Record<string, unknown>;
  const left = typeof record.total_searches_left === "number" ? record.total_searches_left : null;
  const statusText = typeof record.account_status === "string" ? record.account_status : "unknown";
  if (left !== null && left <= 0) {
    return {
      state: "unusable",
      detail: `SerpApi credentials are valid and the account has NO searches left (${statusText}). A search source that cannot answer is worse than an absent one: empty results read as "nobody ranks", which is a confident wrong finding rather than a missing one.`,
      searchesLeft: left,
    };
  }
  return {
    state: "usable",
    detail: left === null ? `SerpApi account ${statusText}; it did not report a remaining quota` : `SerpApi account ${statusText}, ${left} search(es) left`,
    searchesLeft: left,
  };
}

/**
 * Parse a search response into organic results.
 *
 * `search_metadata.status` is checked first: SerpApi answers HTTP 200 for a query it
 * could not complete, with the failure inside the body. Reading only the HTTP status
 * would turn that into an empty result list, and an empty result list is the reading
 * that must never be manufactured.
 *
 * `organic_results` ABSENT and `organic_results` EMPTY are also different, and both are
 * treated as unusable rather than as "no results". A SERP with genuinely nothing on it
 * is vanishingly rare for a real query; a response we failed to understand is not. When
 * in doubt this returns "could not measure", because the alternative is reporting a
 * tenant as invisible on the strength of a parse we got wrong.
 */
export function parseSearchResults(status: number, body: unknown): SearchOutcome {
  if (status === 401 || status === 403) return { ok: false, reason: "SerpApi rejected the credentials", kind: "credentials" };
  if (status === 429) return { ok: false, reason: "SerpApi rate limit or quota reached", kind: "quota" };
  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: `SerpApi answered HTTP ${status} with a body this adapter could not read`, kind: "unusable-response" };
  }
  const record = body as Record<string, unknown>;
  if (typeof record.error === "string") {
    // SerpApi reports a spent plan in the body with a 200, so the message decides which
    // failure this is. Guessing "transport" for a quota problem would send somebody to
    // look at the network.
    const quota = /run out|exhaust|limit|plan/i.test(record.error);
    return { ok: false, reason: `SerpApi: ${record.error}`, kind: quota ? "quota" : "unusable-response" };
  }
  const metadata = typeof record.search_metadata === "object" && record.search_metadata !== null ? (record.search_metadata as Record<string, unknown>) : null;
  const metaStatus = metadata !== null && typeof metadata.status === "string" ? metadata.status : null;
  if (metaStatus !== null && metaStatus !== "Success") {
    return { ok: false, reason: `SerpApi search did not complete (status "${metaStatus}")`, kind: "unusable-response" };
  }
  if (!Array.isArray(record.organic_results) || record.organic_results.length === 0) {
    return {
      ok: false,
      reason: "SerpApi returned no organic results. Treated as UNMEASURED rather than as a ranking: a SERP with genuinely nothing on it is vanishingly rare for a real query, while a response we failed to understand is not, and reporting a site as invisible on the strength of that would be a confident wrong finding.",
      kind: "unusable-response",
    };
  }
  const results: SearchResult[] = [];
  for (const [index, entry] of record.organic_results.entries()) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const url = typeof item.link === "string" ? item.link : null;
    if (url === null) continue;
    results.push({
      // The API's own position when it gives one, so a gap in the list (an ad, a
      // feature snippet) does not silently renumber everything below it.
      position: typeof item.position === "number" ? item.position : index + 1,
      url,
      title: typeof item.title === "string" ? item.title : "",
    });
  }
  if (results.length === 0) {
    return { ok: false, reason: "SerpApi returned organic results with no usable links", kind: "unusable-response" };
  }
  const info = typeof record.search_information === "object" && record.search_information !== null ? (record.search_information as Record<string, unknown>) : null;
  return {
    ok: true,
    results,
    totalResults: info !== null && typeof info.total_results === "number" ? info.total_results : null,
  };
}

/**
 * Google's interface-language code for a BCP-47 tag.
 *
 * A blind reduction to the primary subtag is WRONG, and it was wrong for the first
 * market this project was built for. `nb-NO` reduces to `nb`, and SerpApi answered:
 *
 *   "Unsupported `nb` interface language - hl parameter."
 *
 * Google's `hl` for Norwegian is `no` — the macrolanguage — not `nb` (Bokmål) or `nn`
 * (Nynorsk), even though both are the correct BCP-47 tags a browser sends. So the two
 * namespaces genuinely differ and a mapping is required rather than a convenience.
 *
 * Only the divergences are listed; everything else reduces to its primary subtag, which
 * is right for `sv-SE`, `de-DE`, `da-DK` and `en-GB`. The failure was LOUD — reported as
 * an unusable response rather than as an empty SERP — which is the only reason it was
 * caught on the first live query instead of becoming a silent "digilist ranks nowhere in
 * Norway".
 */
export const GOOGLE_INTERFACE_LANGUAGE: Record<string, string> = {
  nb: "no",
  nn: "no",
};

export function googleLanguage(tag: string): string {
  const primary = tag.toLowerCase().split("-")[0] ?? tag.toLowerCase();
  return GOOGLE_INTERFACE_LANGUAGE[primary] ?? primary;
}

/**
 * Resolve a city to the canonical location name SerpApi will accept.
 *
 * Required, not convenience. `location=Oslo,NO` is REFUSED — measured:
 *
 *   "Unsupported `Oslo,NO` location - location parameter."
 *
 * The accepted form is a canonical name from the vendor's own gazetteer, and its shape
 * is not derivable: `Oslo,Oslo,Norway`, `Bergen,Vestland,Norway`,
 * `Stockholm,Stockholm Municipality,Stockholm County,Sweden`, `Berlin,Germany`. One,
 * two, three or four segments depending on the country's administrative divisions. So it
 * has to be looked up.
 *
 * **Filtered by country code, because the first match is not always the right place.**
 * A search for "Oslo" returns `Oslo,Minnesota,United States` in the same list as
 * `Oslo,Oslo,Norway`. Taking the first result would have run a Norwegian market's SERP
 * from Minnesota and reported it as Oslo — the exact class of silent geographic lie this
 * whole project exists to prevent, arriving through a helper nobody would have looked at.
 *
 * Prefers `target_type: "City"` over the County and Municipality entries that share the
 * name, then the highest `reach`. Both are guesses about intent and both are stated:
 * "Oslo" from a human means the city, and where two cities share a name the larger one is
 * the likelier subject.
 *
 * The lookup is FREE — `/locations.json` costs no search credit — so this does not make
 * a city-scoped observation more expensive, only slower by one round trip.
 */
export function pickLocation(entries: unknown, country: string): string | null {
  if (!Array.isArray(entries)) return null;
  const wanted = country.toUpperCase();
  const candidates = entries
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .filter((e) => typeof e.canonical_name === "string" && String(e.country_code ?? "").toUpperCase() === wanted);
  if (candidates.length === 0) return null;
  const score = (e: Record<string, unknown>): number =>
    (e.target_type === "City" ? 1_000_000_000 : 0) + (typeof e.reach === "number" ? e.reach : 0);
  const best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a));
  return best.canonical_name as string;
}

export const SERPAPI_LOCATIONS_URL = `${SERPAPI_BASE}/locations.json`;

/** The query string for a market-scoped organic search. */
export function serpApiUrl(apiKey: string, query: SearchQuery, location: string | null = null): string {
  const params = new URLSearchParams({
    engine: "google",
    q: query.query,
    // Lowercase: SerpApi's `gl` is a lowercase country code, and an uppercase one is
    // silently ignored rather than rejected — which would return worldwide results
    // while the caller believed they had asked about one market.
    gl: query.country.toLowerCase(),
    num: String(query.limit ?? 10),
    api_key: apiKey,
  });
  if (query.language !== undefined) params.set("hl", googleLanguage(query.language));
  // `location` is what makes a result LOCAL rather than merely country-scoped, which is
  // the difference this whole project is about. It is a RESOLVED canonical name, never
  // the city as typed — see `pickLocation`.
  if (location !== null) params.set("location", location);
  return `${SERPAPI_BASE}/search?${params.toString()}`;
}

export interface SerpApiOptions {
  apiKey: string | undefined;
  fetchJson?: JsonFetch;
}

export function serpApiProvider(options: SerpApiOptions): SearchProvider {
  const fetchJson = options.fetchJson ?? nodeJsonFetch;
  const key = options.apiKey;
  return {
    name: "serpapi",
    async health() {
      // `unconfigured` is its own state, distinct from `unusable`. An absent key is a
      // setup step; a rejected one is a broken account. Collapsing them would send a
      // new operator to check their billing.
      if (key === undefined || key === "") {
        return { state: "unconfigured", detail: "SERPAPI_KEY is not set, so no search observation can be taken", searchesLeft: null };
      }
      const response = await fetchJson(`${SERPAPI_BASE}/account?api_key=${encodeURIComponent(key)}`);
      if (response === null) {
        return { state: "unusable", detail: "SerpApi did not answer — could not verify the account, so a search observation cannot be trusted", searchesLeft: null };
      }
      return parseAccountHealth(response.status, response.body);
    },
    async search(query) {
      if (key === undefined || key === "") return { ok: false, reason: "SERPAPI_KEY is not set", kind: "credentials" };

      /**
       * A city must be RESOLVED, and an unresolvable one REFUSES the query.
       *
       * Dropping it and running a country-wide search would be the worst available
       * option: the caller asked what a visitor in Bergen sees, and would be handed
       * what a visitor somewhere in Norway sees, with nothing saying so. That is the
       * silent geographic substitution this entire project is built to prevent, and it
       * would be introduced by an error path rather than by a decision.
       */
      let location: string | null = null;
      if (query.city !== undefined) {
        const found = await fetchJson(`${SERPAPI_LOCATIONS_URL}?q=${encodeURIComponent(query.city)}&limit=10`);
        if (found === null) {
          return { ok: false, reason: `could not reach SerpApi's location gazetteer to resolve "${query.city}"`, kind: "transport" };
        }
        location = pickLocation(found.body, query.country);
        if (location === null) {
          return {
            ok: false,
            reason: `SerpApi's gazetteer has no location "${query.city}" in ${query.country.toUpperCase()}. Refusing rather than running a country-wide search: the caller asked what a visitor in that city sees, and answering with the whole country while saying nothing would be a silent geographic substitution.`,
            kind: "unusable-response",
          };
        }
      }
      const response = await fetchJson(serpApiUrl(key, query, location));
      if (response === null) return { ok: false, reason: "SerpApi did not answer", kind: "transport" };
      return parseSearchResults(response.status, response.body);
    },
  };
}
