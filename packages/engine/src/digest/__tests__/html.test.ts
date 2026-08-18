import { describe, expect, it } from "vitest";
import { renderDigestHtml, renderDigestText } from "../html.js";
import type { Digest } from "../assemble.js";

const digest = (): Digest => ({
  tenantId: "digilist",
  window: { since: "2026-08-18T00:00:00.000Z", until: "2026-08-19T00:00:00.000Z" },
  runs: { total: 2, pass: 1, fail: 1, error: 0, warning: 0 },
      failed: [
    {
      runId: "run_bad",
      target: "https://app.digilist.no/",
      market: "bergen",
      journey: "search",
      verdict: "FAIL",
      labels: ["search box"],
      href: "https://geoqa.example/#/run/run_bad",
    },
    {
      runId: "run_err",
      target: "https://xala.no/",
      market: "oslo",
      journey: "browse",
      verdict: "ERROR",
      labels: [],
      href: null,
    },
  ],
  filed: [{ key: "k", number: 9, url: "https://github.com/x/y/issues/9", at: "2026-08-18T15:00:00.000Z" }],
  repaired: [{ key: "k", status: "opened", at: "2026-08-18T16:00:00.000Z", prUrl: "https://github.com/x/y/pull/2" }],
  mustKnow: ["1 FAIL on app.digilist.no from bergen"],
  suggestions: [{ title: "Watch the search box", why: "it failed once in 24h" }],
});

describe("renderDigestHtml", () => {
  it("is a full HTML document in the Xala palette and never leaves a raw angle-bracket label unescaped", () => {
    const html = renderDigestHtml({
      ...digest(),
      failed: [{ ...digest().failed[0]!, labels: ["<script>alert(1)</script>"] }],
    });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("#0b1612");
    expect(html).toContain("#2f8f62");
    expect(html).toContain("Xala");
    expect(html).toContain("geoqa");
    expect(html).toContain("search");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders empty sections and a missing run link without inventing a number", () => {
    const empty = renderDigestHtml({
      tenantId: null,
      window: { since: "not-a-date", until: "2026-08-19T00:00:00.000Z" },
      runs: { total: 0, pass: 0, fail: 0, error: 0, warning: 0 },
      failed: [],
      filed: [],
      repaired: [],
      mustKnow: ["none"],
      suggestions: [{ title: "stay", why: "quiet" }],
    });
    expect(empty).toContain("real empty");
    expect(empty).toContain("No new issues");
    expect(empty).toContain("No repairs");
    const linked = renderDigestHtml({
      ...digest(),
      failed: [{ ...digest().failed[0]!, href: null, labels: [] }],
      repaired: [{ key: "k", status: "opened", at: "2026-08-18T16:00:00.000Z" }],
    });
    expect(linked).not.toContain("href=\"null\"");
    const text = renderDigestText({
      ...digest(),
      tenantId: null,
      failed: [],
      filed: [],
      repaired: [],
    });
    expect(text).toContain("- none");
  });
});

describe("renderDigestText", () => {
  it("is a readable fallback that still names the failures", () => {
    const text = renderDigestText(digest());
    expect(text).toContain("2 runs");
    expect(text).toContain("FAIL");
    expect(text).toContain("search box");
    expect(text).toContain("issues/9");
  });
});
