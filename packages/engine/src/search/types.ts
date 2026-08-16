/**
 * Observing what a search engine actually shows, per market.
 *
 * This closes the fifth confidence axis. `searchObservation` was hardcoded `null`
 * because inventing a number for it is the one thing that is definitely wrong — and
 * that stays true; what changes is that a real source can now produce one.
 *
 * The interface is shaped like `GeoNetworkProvider` on purpose, and `health()` is
 * async and probe-based for exactly the reason recorded there: agent-fleet shipped a
 * synchronous credentials-present check for DataForSEO, and a **zero-balance account
 * satisfied it happily for weeks**. That failure is worse here than almost anywhere
 * else in this system, because an exhausted SERP account returns no results, and no
 * results reads as "nobody ranks for this" — a confident, coherent, completely wrong
 * finding about a tenant's search visibility.
 *
 * That account is still overdrawn at the time of writing. The lesson is not
 * historical.
 */

export type SearchHealthState = "usable" | "unusable" | "unconfigured";

export interface SearchHealth {
  state: SearchHealthState;
  detail: string;
  /**
   * Searches left this period, or null when the provider does not report one.
   *
   * Null is "the provider does not say", NOT "unlimited" and NOT "zero". A provider
   * that cannot tell us its remaining quota is usable-but-unmetered, and that is a
   * different thing from one that told us it has nothing left.
   */
  searchesLeft: number | null;
}

/** One organic result, reduced to what a ranking question needs. */
export interface SearchResult {
  position: number;
  url: string;
  title: string;
}

export type SearchOutcome =
  | { ok: true; results: SearchResult[]; totalResults: number | null }
  /**
   * The provider could not answer. Distinct from "answered with nothing".
   *
   * The whole point of the union. An empty result list and a failed query are the same
   * shape in most SERP clients, and collapsing them is how an exhausted API becomes a
   * report that a site ranks nowhere.
   */
  | { ok: false; reason: string; kind: "credentials" | "quota" | "transport" | "unusable-response" };

export interface SearchQuery {
  /** What a visitor would type. */
  query: string;
  /** ISO-3166 alpha-2, lowercased by the adapter if its API wants that. */
  country: string;
  /** The city, when the provider supports local results. */
  city?: string | undefined;
  /** BCP-47 or the provider's own language code. */
  language?: string | undefined;
  /** How many organic results to ask for. */
  limit?: number | undefined;
}

/**
 * A SERP source.
 *
 * `health()` performs a REAL probe. `search()` returns a three-state outcome. Neither
 * is allowed to turn "we could not look" into a reading.
 */
export interface SearchProvider {
  readonly name: string;
  health(): Promise<SearchHealth>;
  search(query: SearchQuery): Promise<SearchOutcome>;
}
