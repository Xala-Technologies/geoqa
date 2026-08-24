import { describe, expect, it } from "vitest";
import { itemsFromGrowth, growthGroupKey, issueNumberOf } from "../intake-growth.js";
import { itemsFromGeoqa, SITE_SEVERITY_RANK, URGENT_SEVERITY_RANK } from "../intake-geoqa.js";
import { itemsFromGithub, githubItemKey } from "../intake-github.js";
import { growthBrief, groupTitle, growthLabels, MAX_BRIEF_URLS } from "../brief-growth.js";
import { hostOf, routeGrowth, routeIssueLabels } from "../route.js";
import { toFindingRow, growthDbConfig } from "../growth-db.js";
import { parseBrief } from "../../findings/brief.js";
import type { TicketDraft } from "../../findings/tickets.js";
import { REPO_KEYS, SITES, row } from "./fixtures.js";

describe("hostOf", () => {
  it("prefers the site column when it is a hostname, falls back to the URL, and never throws", () => {
    expect(hostOf({ site: "digilist.no", url: "" })).toBe("digilist.no");
    expect(hostOf({ site: "WWW.Digilist.no", url: "" })).toBe("digilist.no");
    // The `site` column is documented as a site ID, so this is the case that
    // decides whether every growth item routes or none of them do.
    expect(hostOf({ site: "marketing", url: "https://www.digilist.no/priser" })).toBe("digilist.no");
    expect(hostOf({ site: "marketing", url: "not a url" })).toBe("");
    expect(hostOf({ site: "", url: "" })).toBe("");
  });
});

describe("routeGrowth", () => {
  it("takes target_repo first, then the host, and REFUSES rather than falling back", () => {
    expect(routeGrowth({ targetRepo: "marketing", site: "digilist.no", url: "" }, REPO_KEYS, SITES)).toEqual({
      codeRepo: "Xala-Technologies/booking-brilliance",
      base: "main",
      site: "digilist.no",
      reason: "target-repo",
    });
    expect(routeGrowth({ targetRepo: "", site: "app.digilist.no", url: "" }, REPO_KEYS, SITES)?.base).toBe("dev");
    // An unknown key does not become an unknown repository.
    expect(routeGrowth({ targetRepo: "nope", site: "elsewhere.example", url: "" }, REPO_KEYS, SITES)).toBeNull();
    expect(routeGrowth({ targetRepo: "", site: "", url: "" }, REPO_KEYS, SITES)).toBeNull();
  });

  it("routes an opted-in issue by its site: label, and refuses one with no label", () => {
    expect(routeIssueLabels(["bug", "site:app.digilist.no"], SITES)?.codeRepo).toBe("Xala-Technologies/Digilist");
    expect(routeIssueLabels(["bug"], SITES)).toBeNull();
    expect(routeIssueLabels(["site:unknown.example"], SITES)).toBeNull();
  });
});

describe("itemsFromGrowth", () => {
  it("collapses 341 rows across three rules into ONE item, because they share issue 343", () => {
    const rows = [
      ...Array.from({ length: 179 }, (_, i) => row({ id: i + 1, rule: "description.long", findingKey: `d${i}`, url: `https://digilist.no/p${i}` })),
      ...Array.from({ length: 160 }, (_, i) => row({ id: 500 + i, rule: "title.long", findingKey: `t${i}`, url: `https://digilist.no/q${i}` })),
      ...Array.from({ length: 2 }, (_, i) => row({ id: 900 + i, rule: "title.short", findingKey: `s${i}`, url: `https://digilist.no/r${i}` })),
    ];
    const items = itemsFromGrowth(rows, { repoKeys: REPO_KEYS, sites: SITES });
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item?.key).toBe("issue:343");
    expect(item?.reach).toBe(341);
    expect(item?.members).toHaveLength(341);
    expect(item?.issue?.number).toBe(343);
    expect(item?.route?.codeRepo).toBe("Xala-Technologies/booking-brilliance");
    // Never urgent: `urgent` is an ownership claim that routes to the geoqa
    // repo, and a marketing meta description is not geoqa's defect.
    expect(item?.urgent).toBe(false);
  });

  it("groups by (agent, rule, site) when no issue exists yet, and by finding key when there is no rule", () => {
    expect(growthGroupKey(row({ githubIssue: "" }))).toBe("growth:seo:description.long:digilist.no");
    expect(growthGroupKey(row({ githubIssue: "", rule: "" }))).toBe("growth:seo:digilist.no/:description.long");
    const items = itemsFromGrowth(
      [row({ githubIssue: "", findingKey: "a" }), row({ githubIssue: "", findingKey: "b" }), row({ githubIssue: "", rule: "title.long", findingKey: "c" })],
      { repoKeys: REPO_KEYS, sites: SITES },
    );
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.issue)).toEqual([null, null]);
  });

  it("reads an issue reference however it was written, and refuses one that is not a number", () => {
    expect(issueNumberOf("343")).toBe(343);
    expect(issueNumberOf("#343")).toBe(343);
    expect(issueNumberOf("https://github.com/o/n/issues/343")).toBe(343);
    expect(issueNumberOf("")).toBeNull();
    expect(issueNumberOf("none")).toBeNull();
    expect(issueNumberOf("0")).toBeNull();
  });

  it("has no issue when the row is unroutable, because an issue number without a repo names nothing", () => {
    const items = itemsFromGrowth([row({ targetRepo: "", site: "elsewhere.example", url: "" })], { repoKeys: REPO_KEYS, sites: SITES });
    expect(items[0]?.route).toBeNull();
    expect(items[0]?.issue).toBeNull();
  });

  it("honours an agent allowlist", () => {
    const rows = [row({ agent: "seo" }), row({ agent: "blog", findingKey: "b", githubIssue: "" })];
    expect(itemsFromGrowth(rows, { repoKeys: REPO_KEYS, sites: SITES, agents: ["seo"] })).toHaveLength(1);
    expect(itemsFromGrowth(rows, { repoKeys: REPO_KEYS, sites: SITES, agents: [] })).toHaveLength(2);
  });
});

describe("growthBrief", () => {
  it("writes eight sections, names no cause, and caps the URL list", () => {
    const rows = Array.from({ length: 25 }, (_, i) => row({ id: i, url: `https://digilist.no/p${i}` }));
    const body = growthBrief({ title: "t", rows, codeRepo: "o/n", daysOpen: 4, grafanaUrl: "https://grafana.example/d/x" });
    const sections = parseBrief(body);
    expect(sections.map((section) => section.heading)).toEqual([
      "Problem",
      "What this is",
      "Root cause",
      "What this is not",
      "What we saw",
      "Suggested next step",
      "Breaking changes",
      "Evidence",
    ]);
    expect(sections.find((section) => section.heading === "Root cause")?.text).toContain("Not determined");
    expect(body).toContain(`…and ${25 - MAX_BRIEF_URLS} more.`);
    expect(body).toContain("4 days open");
    expect(body).toContain("https://grafana.example/d/x");
  });

  it("says so when the agent proposed nothing, rather than inventing a next step", () => {
    const body = growthBrief({ title: "t", rows: [row({ recommendedAction: "", detail: "", estimatedImpact: "", url: "" })], codeRepo: "o/n", daysOpen: 1 });
    expect(body).toContain("this is a complaint, not a fix");
    expect(body).toContain("recorded no detail");
    expect(body).toContain("No impact estimate");
    expect(body).toContain("1 day open");
  });

  it("names the group in the shape the fleet's own issue uses, and keeps a single row's own title", () => {
    expect(groupTitle({ rule: "description.long", site: "digilist.no", reach: 339, first: row() })).toBe("description.long on 339 pages — digilist.no");
    expect(groupTitle({ rule: "", site: "", reach: 2, first: row({ rule: "", category: "" }) })).toBe("finding on 2 pages — digilist.no");
    expect(groupTitle({ rule: "x", site: "s", reach: 1, first: row() })).toBe("Meta description is 187 characters");
    expect(groupTitle({ rule: "x", site: "s", reach: 1, first: row({ title: "" }) })).toBe("x on s");
    expect(groupTitle({ rule: "", site: "", reach: 1, first: row({ title: "" }) })).toBe("finding on site");
  });

  it("invents no label vocabulary", () => {
    expect(growthLabels({ site: "digilist.no", category: "seo" })).toEqual(["findings", "bug", "site:digilist.no", "seo"]);
    expect(growthLabels({ site: "", category: "made-up" })).toEqual(["findings", "bug"]);
  });
});

describe("itemsFromGeoqa", () => {
  const draft = (over: Partial<TicketDraft> = {}): TicketDraft => ({
    key: "site:has a search box:app.digilist.no",
    title: "has a search box on app.digilist.no",
    body: "## Problem\nfailed",
    labels: ["findings", "bug", "site:app.digilist.no"],
    urgent: false,
    runIds: ["run_1", "run_2"],
    site: "app.digilist.no",
    hosts: ["app.digilist.no"],
    ...over,
  });

  it("is jobsFromFiled's inner join, lifted — an unfiled draft is silently skipped", () => {
    const items = itemsFromGeoqa(
      [draft(), draft({ key: "orphan" })],
      [{ key: draft().key, number: 46, url: "https://github.com/o/n/issues/46", at: "t", repo: "o/n" }],
      SITES,
      "Xala-Technologies/geoqa",
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.route?.base).toBe("dev");
    expect(items[0]?.reach).toBe(2);
    expect(items[0]?.severityRank).toBe(SITE_SEVERITY_RANK);
  });

  it("keeps urgent routing to the fallback repo, which is what urgent MEANS in geoqa", () => {
    const items = itemsFromGeoqa(
      [draft({ key: "urgent:geo-mismatch", urgent: true, site: "geoqa", hosts: [] })],
      [{ key: "urgent:geo-mismatch", number: 9, url: "u", at: "t" }],
      SITES,
      "Xala-Technologies/geoqa",
    );
    expect(items[0]?.route).toEqual({ codeRepo: "Xala-Technologies/geoqa", base: "main", site: "geoqa", reason: "urgent" });
    expect(items[0]?.severityRank).toBe(URGENT_SEVERITY_RANK);
    expect(items[0]?.issue?.repo).toBe("Xala-Technologies/geoqa");
  });
});

describe("itemsFromGithub", () => {
  const issue = (over: Partial<Parameters<typeof itemsFromGithub>[0][number]> = {}) => ({
    number: 342,
    title: "a geoqa watch finding",
    body: "b",
    url: "https://github.com/o/n/issues/342",
    labels: ["findings", "bug", "agent: approved", "site:digilist.no"],
    pullRequest: false,
    ...over,
  });

  it("takes ONLY an issue a human labelled agent: approved", () => {
    const items = itemsFromGithub(
      [
        issue(),
        issue({ number: 335, labels: ["bug"] }),
        issue({ number: 344, labels: ["findings", "agent: approved", "agent: changes-requested", "site:digilist.no"] }),
        issue({ number: 345, pullRequest: true }),
      ],
      { repo: "o/n", sites: SITES, claimed: new Set() },
    );
    expect(items.map((item) => item.issue?.number)).toEqual([342]);
    expect(items[0]?.key).toBe(githubItemKey("o/n", 342));
  });

  it("does not claim an issue another source already owns", () => {
    expect(itemsFromGithub([issue()], { repo: "o/n", sites: SITES, claimed: new Set(["o/n#342"]) })).toEqual([]);
  });

  it("refuses an approved issue with no site label rather than sending it to the fallback repo", () => {
    const items = itemsFromGithub([issue({ labels: ["findings", "agent: approved"] })], { repo: "o/n", sites: SITES, claimed: new Set() });
    expect(items[0]?.route).toBeNull();
  });
});

describe("growth-db", () => {
  it("maps a row defensively, because a mapping that assumed a type would fail at the end of a run", () => {
    const mapped = toFindingRow({ id: "5", run_id: null, agent: "seo", days_open: "3", severity_rank: 3, status: "weird", site: null });
    expect(mapped.id).toBe(5);
    expect(mapped.runId).toBeNull();
    expect(mapped.daysOpen).toBe(3);
    expect(mapped.status).toBe("open");
    expect(mapped.site).toBe("");
    expect(toFindingRow({ id: 1, run_id: 4, days_open: "x" }).daysOpen).toBe(0);
  });

  it("treats POSTGRES_PASSWORD as the gate, exactly as goals-store.ts does", () => {
    expect(growthDbConfig({})).toBeNull();
    expect(growthDbConfig({ POSTGRES_PASSWORD: "" })).toBeNull();
    expect(growthDbConfig({ POSTGRES_PASSWORD: "p" })).toMatchObject({ host: "postgres", port: 5432, user: "digilist", database: "digilist_growth" });
    expect(growthDbConfig({ POSTGRES_PASSWORD: "p", POSTGRES_HOST: "h", POSTGRES_PORT: "6543", POSTGRES_USER: "u", POSTGRES_DB: "d" })).toMatchObject({
      host: "h",
      port: 6543,
      user: "u",
      database: "d",
    });
  });
});
