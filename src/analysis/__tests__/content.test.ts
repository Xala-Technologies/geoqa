import { describe, expect, it } from "vitest";
import {
  analyseContent,
  CONTENT_EXPRESSION,
  DUPLICATE_SIMILARITY,
  parsePageContent,
  similarity,
  THIN_PAGE_WORDS,
  type ContentRecord,
  type PageContent,
} from "../content.js";

const content = (over: Partial<PageContent> = {}): PageContent => ({
  wordCount: 800,
  shingles: ["a b c d e", "b c d e f"],
  headings: ["A heading"],
  h1Count: 1,
  internalLinks: [],
  title: "T",
  ...over,
});

const page = (target: string, over: Partial<PageContent> = {}): ContentRecord => ({ target, content: content(over) });

describe("CONTENT_EXPRESSION", () => {
  it("reads innerText, not textContent", () => {
    // textContent includes <script> bodies and hidden elements, so a page with a large inlined
    // JSON-LD blob would measure as substantial content while a reader sees an empty page.
    // "Thin" is a claim about what a person reads.
    // Precisely: the BODY text is innerText. Headings use textContent, which is right for them
    // — a heading is not hidden and its markup is what it says. The first version of this
    // assertion banned textContent outright and failed against correct code.
    expect(CONTENT_EXPRESSION).toContain("main.innerText");
    expect(CONTENT_EXPRESSION).not.toContain("main.textContent");
  });

  it("stores no prose — a word count and shingles, never the page text", () => {
    // A page can contain personal data: a name in a testimonial, an address in a footer. An
    // evidence tree accumulating the rendered text of every page on a customer's site would be
    // a data-protection liability created for a word count.
    expect(CONTENT_EXPRESSION).toContain("wordCount");
    expect(CONTENT_EXPRESSION).not.toMatch(/\btext:\s*text\b/);
  });

  it("keeps same-origin links only, normalised", () => {
    // A link graph is about a site's own structure; an outbound link is somebody else's site.
    expect(CONTENT_EXPRESSION).toContain("url.origin === origin");
    expect(CONTENT_EXPRESSION).toContain("url.pathname");
  });
});

describe("parsePageContent", () => {
  it("parses the real shape, from a JSON string or an object", () => {
    const raw = { wordCount: 42, shingles: ["a b c d e"], headings: ["H"], h1Count: 1, internalLinks: ["/x"], title: "T" };
    expect(parsePageContent(JSON.stringify(raw))).toEqual(raw);
    expect(parsePageContent(raw)).toEqual(raw);
  });

  it("returns null rather than a partial record when the count is missing", () => {
    // A content record with no word count cannot answer the only question it exists for.
    expect(parsePageContent({ shingles: [] })).toBeNull();
    expect(parsePageContent("not json")).toBeNull();
    expect(parsePageContent(null)).toBeNull();
    expect(parsePageContent([1, 2])).toBeNull();
  });

  it("drops non-string entries rather than trusting the array", () => {
    const parsed = parsePageContent({ wordCount: 1, shingles: ["ok", 5, null], internalLinks: [{}, "/x"] });
    expect(parsed?.shingles).toEqual(["ok"]);
    expect(parsed?.internalLinks).toEqual(["/x"]);
    expect(parsed?.h1Count).toBe(0);
  });
});

describe("similarity", () => {
  it("is 1 for identical shingle sets and 0 for disjoint ones", () => {
    expect(similarity(["a", "b"], ["a", "b"])).toBe(1);
    expect(similarity(["a", "b"], ["c", "d"])).toBe(0);
  });

  it("is 0 when either side is empty — never 1 by vacuity", () => {
    // Two pages we could not read are not "identical", and reporting them as a duplicate pair
    // would be a finding invented out of a failed read.
    expect(similarity([], [])).toBe(0);
    expect(similarity(["a"], [])).toBe(0);
  });

  it("computes a real Jaccard overlap", () => {
    expect(similarity(["a", "b", "c", "d"], ["c", "d", "e", "f"])).toBe(0.33);
  });

  it("does not double-count a repeated shingle on either side", () => {
    expect(similarity(["a", "b"], ["a", "a", "a"])).toBe(0.5);
  });
});

describe("analyseContent", () => {
  it("lists thin pages, thinnest first, and calls it a list rather than a verdict", () => {
    // A pricing table, a contact page and a login screen are all legitimately short, so this
    // cannot be a verdict on its own.
    const f = analyseContent([
      page("https://a.test/long", { wordCount: 900 }),
      page("https://a.test/tiny", { wordCount: 40 }),
      page("https://a.test/short", { wordCount: 150 }),
    ]);
    expect(f.thin.map((t) => t.target)).toEqual(["https://a.test/tiny", "https://a.test/short"]);
    expect(THIN_PAGE_WORDS).toBe(200);
  });

  it("finds a page nothing else links to, and SCOPES the claim to the sweep", () => {
    // A page linked only from a page that was not crawled is not orphaned on the site, and a
    // report that blurred the two would send somebody hunting for links that exist.
    const f = analyseContent([
      page("https://a.test/", { internalLinks: ["/hub"] }),
      page("https://a.test/hub", { internalLinks: ["/"] }),
      page("https://a.test/lonely", { internalLinks: ["/"] }),
    ]);
    expect(f.orphans).toEqual(["https://a.test/lonely"]);
    expect(f.warnings.join(" ")).toContain("scoped to the 3 page(s) in this sweep");
  });

  it("skips a target that is not a URL rather than throwing mid-report", () => {
    // A malformed target cannot be placed in a link graph, and one bad row must not cost the
    // other twenty-three their analysis.
    const f = analyseContent([page("not a url"), page("https://a.test/", { internalLinks: [] })]);
    expect(f.orphans).toEqual([]);
    expect(f.thin).toEqual([]);
  });

  it("never calls the site ROOT an orphan", () => {
    // The root is reached directly, not by a link.
    const f = analyseContent([page("https://a.test/", { internalLinks: [] })]);
    expect(f.orphans).toEqual([]);
  });

  it("matches a link whether or not the target had a trailing slash", () => {
    const f = analyseContent([
      page("https://a.test/", { internalLinks: ["/faq"] }),
      page("https://a.test/faq/", { internalLinks: ["/"] }),
    ]);
    expect(f.orphans).toEqual([]);
  });

  it("reports near-duplicates above the threshold, most similar first", () => {
    const shared = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const f = analyseContent([
      page("https://a.test/one", { shingles: shared }),
      page("https://a.test/two", { shingles: shared }),
      page("https://a.test/other", { shingles: ["x", "y", "z"] }),
    ]);
    expect(f.duplicates).toHaveLength(1);
    expect(f.duplicates[0]?.similarity).toBe(1);
  });

  it("sets the threshold HIGH on purpose, so a shared nav is not a duplicate", () => {
    // Measured against the digilist finding that started this: 23 near-duplicate slug pairs
    // whose content was only 6–14% similar. A threshold low enough to catch those would flag
    // every page that shares a header and a footer.
    expect(DUPLICATE_SIMILARITY).toBeGreaterThanOrEqual(0.5);
    const f = analyseContent([
      page("https://a.test/one", { shingles: ["nav1", "nav2", "a", "b", "c", "d"] }),
      page("https://a.test/two", { shingles: ["nav1", "nav2", "e", "f", "g", "h"] }),
    ]);
    expect(f.duplicates).toEqual([]);
  });

  it("flags a page with no h1 and a page with several", () => {
    const f = analyseContent([
      page("https://a.test/none", { h1Count: 0 }),
      page("https://a.test/two", { h1Count: 2 }),
      page("https://a.test/ok", { h1Count: 1 }),
    ]);
    expect(f.headingProblems.map((h) => h.h1Count).sort()).toEqual([0, 2]);
  });

  it("says when pages produced no comparable text", () => {
    const f = analyseContent([page("https://a.test/x", { shingles: [] }), page("https://a.test/y")]);
    expect(f.warnings.join(" ")).toContain("1 page(s) produced no comparable text");
  });

  it("says plainly when nothing was captured, rather than reporting a clean site", () => {
    // Zero findings from zero pages is not a clean site, and a report that looked the same for
    // both would be the emptiest possible green tick.
    const f = analyseContent([]);
    expect(f.warnings[0]).toContain("no page content was captured");
    expect(f.thin).toEqual([]);
  });
});
