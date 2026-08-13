/**
 * Keyword research, as a capability rather than one company's spreadsheet.
 *
 * Copied in from `agent-fleet` and generalised. What arrived was 60-odd hardcoded
 * Norwegian phrases and an intent taxonomy naming one product's market segments
 * ("municipal", with a comment about kommune framing). None of that survives into the
 * engine: the terms are **tenant data**, the intents are a generic vocabulary, and the
 * only thing this module knows about a market is its country, city and language.
 *
 * The division the loop insists on, and the reason this file measures nothing itself:
 * **agents produce, geoqa verifies.** A keyword agent that scored its own output would
 * be the failure this whole project exists to catch. So research here means "ask the
 * SERP where the tenant actually stands", and the answer comes from `search/`, which is
 * the measuring side — the same provider, the same three-state observation, the same
 * refusal to turn "could not look" into a reading.
 */

/**
 * Why somebody types a phrase.
 *
 * Generic on purpose. The version that arrived had `municipal` and `private` as
 * first-class intents, which are segments of one tenant's market rather than kinds of
 * search — a tenant selling to hospitals or to schools would have had to pick the wrong
 * one. These five are properties of the QUERY, so they apply to any tenant, and a
 * tenant that wants its own segmentation puts it in `audience`.
 */
export type SearchIntent =
  /** Ready to buy or book: "pris", "demo", "kjøp", "book". */
  | "commercial"
  /** Learning: "hva er", "hvordan", "guide". */
  | "informational"
  /** Comparing named options: "X vs Y", "beste", "alternativ til". */
  | "comparison"
  /** Looking for a place or thing to use: a venue, a room, a piece of equipment. */
  | "local"
  /** Looking for the brand itself. */
  | "navigational";

export interface KeywordSeed {
  term: string;
  intent: SearchIntent;
  /**
   * The tenant's own segmentation, free text, carried through to the report and
   * interpreted by nobody here.
   *
   * This is where "municipal" and "private" belong. The engine has no business having an
   * opinion about a tenant's market segments, and a taxonomy that tried to would be
   * wrong for the second tenant.
   */
  audience?: string | undefined;
  /**
   * Markets to check this term in, as market ids. Absent means every market the tenant
   * declared.
   *
   * Per-term because relevance is not uniform: a term about winter access matters in
   * Tromsø and not in Berlin, and checking it everywhere spends credits to learn nothing.
   */
  markets?: string[] | undefined;
}

/** What was found for one term in one market. */
export interface KeywordObservation {
  term: string;
  intent: SearchIntent;
  audience: string | null;
  marketId: string;
  /**
   * 0..100, or **null when nothing could be measured**.
   *
   * Null and a low score are different facts and the distinction is the point: an
   * exhausted SERP account returns nothing, and so does a term nobody ranks for. One is
   * "we failed to look" and the other is "you are not there".
   */
  score: number | null;
  /** Where the tenant's own page appeared, or null when it did not. */
  position: number | null;
  /** How many organic results were examined. Null when the query failed. */
  examined: number | null;
  /** Always populated, including on a good result. */
  reason: string;
  /** Who holds the top spot, when there was one. Null when the query failed. */
  topCompetitor: string | null;
}

export interface KeywordReport {
  tenantId: string;
  /** Terms × markets actually queried. */
  queried: number;
  /** Terms × markets that produced a reading of any kind. */
  measured: number;
  observations: KeywordObservation[];
  /**
   * Mean score over the MEASURED observations, or null when none were.
   *
   * Never averaged over the unmeasured ones, which would let a broken SERP account read
   * as a site with poor visibility — the same rule as `rate()` returning null on an
   * empty denominator.
   */
  meanScore: number | null;
  /** Said out loud: what was skipped, refused or could not be read. */
  warnings: string[];
}
