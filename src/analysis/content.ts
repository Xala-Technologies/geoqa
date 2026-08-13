/**
 * Page content, captured so the content-level SEO signals can be computed at all.
 *
 * This closes the gap `analysis/site.ts` had to leave open. Thin pages, orphans and
 * near-duplicate cannibalisation each need page TEXT or the internal LINK GRAPH, and a run
 * recorded neither — the journey's `getText` result was compared by a check and thrown away,
 * and `selector-count-min` counted links without keeping their targets. The honest response at
 * the time was to name the gap rather than approximate it, because a thin-page report built on
 * a guess about page length is worse than none: somebody rewrites a page over it.
 *
 * What is captured is deliberately small, and the shape matters as much as the size.
 *
 * **Text is measured, not stored.** A word count and a hash, never the prose. Three reasons,
 * and the first is the one that decides it: a page can contain personal data — a name in a
 * testimonial, an address in a footer, a review — and an evidence tree that accumulated the
 * rendered text of every page on a customer's site would be a data-protection liability
 * created for a word count. `evidence/redact.ts` exists because this project already takes that
 * seriously. Second, the tree stays small. Third, a hash answers "are these two pages the same"
 * exactly, and shingles answer "are they nearly the same" well enough, without either being
 * readable.
 *
 * **Links are stored as paths, not URLs.** Same-origin only, because a link graph is about a
 * site's own structure and an outbound link is somebody else's problem.
 */

/**
 * Read in the page. Returns JSON so it crosses both engines identically.
 *
 * `innerText` rather than `textContent`: `textContent` includes `<script>` bodies and hidden
 * elements, so a page with a large inlined JSON-LD blob would measure as substantial content
 * when a reader sees an empty page. `innerText` is what a person actually reads, which is what
 * "thin" is a claim about.
 */
export const CONTENT_EXPRESSION = `(() => {
  const main = document.querySelector("main, article, [role='main']") ?? document.body;
  const text = (main.innerText ?? "").replace(/\\s+/g, " ").trim();
  const words = text === "" ? [] : text.split(" ");
  const origin = location.origin;
  const internal = [];
  for (const a of document.querySelectorAll("a[href]")) {
    try {
      const url = new URL(a.getAttribute("href"), location.href);
      // Same-origin only: a link graph is about a site's own structure, and an outbound link
      // is somebody else's site. Hash and query dropped so /x, /x?a=1 and /x#top are one node.
      if (url.origin === origin) internal.push(url.pathname.replace(/\\/$/, "") || "/");
    } catch { /* an unparseable href is not a link */ }
  }
  return JSON.stringify({
    wordCount: words.length,
    // Lowercased shingles of 5 words, deduped. Enough to compare two pages without keeping
    // anything readable back.
    shingles: [...new Set(words.map((w, i) => words.slice(i, i + 5).join(" ").toLowerCase()).slice(0, Math.max(0, words.length - 4)))].slice(0, 400),
    headings: [...document.querySelectorAll("h1, h2")].map((h) => (h.textContent ?? "").trim()).filter((t) => t !== "").slice(0, 40),
    h1Count: document.querySelectorAll("h1").length,
    internalLinks: [...new Set(internal)].slice(0, 300),
    title: document.title,
  });
})()`;

export interface PageContent {
  wordCount: number;
  /** Deduped 5-word shingles, lowercased. Never the prose itself — see the file comment. */
  shingles: string[];
  headings: string[];
  h1Count: number;
  /** Same-origin paths this page links to, normalised and deduped. */
  internalLinks: string[];
  title: string;
}

export function parsePageContent(value: unknown): PageContent | null {
  const raw = typeof value === "string" ? safeParse(value) : value;
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.wordCount !== "number") return null;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    wordCount: r.wordCount,
    shingles: strings(r.shingles),
    headings: strings(r.headings),
    h1Count: typeof r.h1Count === "number" ? r.h1Count : 0,
    internalLinks: strings(r.internalLinks),
    title: typeof r.title === "string" ? r.title : "",
  };
}

const safeParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** One page's content as the site analysis needs it. */
export interface ContentRecord {
  target: string;
  content: PageContent;
}

/**
 * How thin is thin.
 *
 * 200 words, and it is a FLOOR for suspicion rather than a quality bar. A pricing table, a
 * contact page or a login screen are all legitimately short, so this cannot be a verdict on its
 * own — it produces a list to look at. Below roughly this length a page rarely answers a
 * search intent on its own, which is the claim being made and the only one.
 */
export const THIN_PAGE_WORDS = 200;

/**
 * How similar is too similar.
 *
 * 0.6 Jaccard over 5-word shingles. Measured against the digilist finding that started this:
 * 23 near-duplicate slug pairs whose content was only 6–14% similar — real cannibalisation
 * candidates by URL, and nothing alike once read. A threshold low enough to catch those would
 * flag every page sharing a nav and a footer, so this deliberately sits high: at 0.6 two pages
 * are substantially the same text, which is a claim worth making.
 */
export const DUPLICATE_SIMILARITY = 0.6;

/** Jaccard similarity of two shingle sets. 0 when either is empty — never 1 by vacuity. */
export function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  let shared = 0;
  const seen = new Set<string>();
  for (const s of b) {
    if (seen.has(s)) continue;
    seen.add(s);
    if (setA.has(s)) shared += 1;
  }
  const union = setA.size + seen.size - shared;
  return union === 0 ? 0 : Math.round((shared / union) * 100) / 100;
}

export interface ContentFindings {
  /** Pages under the word floor, thinnest first. A list to look at, not a verdict. */
  thin: { target: string; wordCount: number }[];
  /**
   * Pages nothing else links to.
   *
   * Computed only over the pages actually CRAWLED, and that limit is stated in the report: a
   * page can be unlinked from every page in a sweep and linked from one that was not swept, so
   * this is "orphaned within what we measured" rather than "orphaned on the site".
   */
  orphans: string[];
  /** Pairs above the similarity threshold, most similar first. */
  duplicates: { a: string; b: string; similarity: number }[];
  /** Pages with no h1, or with more than one. */
  headingProblems: { target: string; h1Count: number }[];
  warnings: string[];
}

/**
 * The content-level signals, from the pages a sweep actually captured.
 *
 * Every output states what it is scoped to. The orphan list is the one that could most easily
 * mislead — an orphan "within this sweep" is a much weaker claim than an orphan on the site, and
 * a report that blurred the two would send somebody hunting for links that exist.
 */
export function analyseContent(records: ContentRecord[]): ContentFindings {
  const warnings: string[] = [];
  if (records.length === 0) {
    return { thin: [], orphans: [], duplicates: [], headingProblems: [], warnings: ["no page content was captured — run a sweep with a journey that reads content"] };
  }

  const pathOf = (url: string): string | null => {
    try {
      return new URL(url).pathname.replace(/\/$/, "") || "/";
    } catch {
      return null;
    }
  };

  const linkedTo = new Set<string>();
  for (const r of records) for (const link of r.content.internalLinks) linkedTo.add(link);

  const orphans: string[] = [];
  for (const r of records) {
    const p = pathOf(r.target);
    // The site root is never an orphan: it is reached directly, not by a link.
    if (p === null || p === "/") continue;
    if (!linkedTo.has(p)) orphans.push(r.target);
  }

  const duplicates: ContentFindings["duplicates"] = [];
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i] as ContentRecord;
      const b = records[j] as ContentRecord;
      const score = similarity(a.content.shingles, b.content.shingles);
      if (score >= DUPLICATE_SIMILARITY) duplicates.push({ a: a.target, b: b.target, similarity: score });
    }
  }

  warnings.push(
    `orphans are scoped to the ${records.length} page(s) in this sweep: a page linked only from a page that was not crawled will appear here and is not orphaned on the site`,
  );
  const noShingles = records.filter((r) => r.content.shingles.length === 0).length;
  if (noShingles > 0) {
    warnings.push(`${noShingles} page(s) produced no comparable text, so they cannot participate in the duplicate check`);
  }

  return {
    thin: records
      .filter((r) => r.content.wordCount < THIN_PAGE_WORDS)
      .map((r) => ({ target: r.target, wordCount: r.content.wordCount }))
      .sort((a, b) => a.wordCount - b.wordCount),
    orphans,
    duplicates: duplicates.sort((a, b) => b.similarity - a.similarity),
    headingProblems: records
      .filter((r) => r.content.h1Count !== 1)
      .map((r) => ({ target: r.target, h1Count: r.content.h1Count })),
    warnings,
  };
}
