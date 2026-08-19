import { describe, expect, it } from "vitest";
import { draftsFromRuns, hostOf, type TicketRun } from "../tickets.js";

const run = (over: Partial<TicketRun> = {}): TicketRun => ({
  runId: "run_1",
  target: "https://digilist.no",
  profileId: "bergen-desktop",
  journeyId: "search",
  verdict: "FAIL",
  findings: { labels: ["has a search box"], byCategory: { functional: 1 } },
  geo: {
    requestedCountry: "NO",
    requestedCity: "Bergen",
    observedCountry: "NO",
    observedCity: "Bergen",
    country: "match",
    city: "match",
    egressHeld: "match",
  },
  ...over,
});

describe("hostOf", () => {
  it("strips the scheme, and keeps a string that is not a URL rather than inventing a host", () => {
    expect(hostOf("https://app.digilist.no/path")).toBe("app.digilist.no");
    expect(hostOf("not a url")).toBe("not a url");
  });
});

describe("draftsFromRuns", () => {
  it("files nothing for a clean pass — a green sweep is not a ticket", () => {
    expect(draftsFromRuns([run({ verdict: "PASS", findings: { labels: [], byCategory: {} } })])).toEqual([]);
  });

  it("groups a site check by host so six cities are one issue, not six", () => {
    const drafts = draftsFromRuns([
      run({ runId: "a", profileId: "bergen-desktop", target: "https://xala.no/" }),
      run({ runId: "b", profileId: "tromso-desktop", target: "https://xala.no/search" }),
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.urgent).toBe(false);
    expect(drafts[0]?.key).toBe("site:has a search box:xala.no");
    expect(drafts[0]?.labels).toEqual(["findings", "bug", "site:xala.no"]);
    expect(drafts[0]?.site).toBe("xala.no");
    expect(drafts[0]?.hosts).toEqual(["xala.no"]);
    expect(drafts[0]?.runIds).toEqual(["a", "b"]);
    expect(drafts[0]?.title).toContain("has a search box");
    expect(drafts[0]?.title).toContain("xala.no");
    expect(drafts[0]?.body).toContain("## Problem");
    expect(drafts[0]?.body).toContain("## Root cause");
    expect(drafts[0]?.body).toContain("does not invent");
    expect(drafts[0]?.body).toContain("## Breaking changes");
    expect(drafts[0]?.body).toContain("additive");
    expect(drafts[0]?.body).toContain("bergen");
    expect(drafts[0]?.body).toContain("tromso");
  });

  it("a navigate that never completed is urgent, and a fill that follows a missing search box is not", () => {
    const drafts = draftsFromRuns([
      run({
        runId: "nav",
        verdict: "ERROR",
        journeyId: "browse",
        findings: { labels: ["open target"], byCategory: { instrumentation: 1 } },
      }),
      run({
        runId: "search",
        verdict: "ERROR",
        findings: { labels: ["has a search box", "type the query"], byCategory: { functional: 1, instrumentation: 1 } },
      }),
    ]);
    const keys = drafts.map((d) => d.key).sort();
    expect(keys).toEqual(["site:has a search box:digilist.no", "urgent:run:open target"]);
    expect(drafts.find((d) => d.key.startsWith("urgent:"))?.urgent).toBe(true);
    expect(drafts.find((d) => d.key.startsWith("urgent:"))?.labels).toContain("urgent");
    expect(drafts.find((d) => d.key.startsWith("urgent:"))?.labels).toContain("site:digilist.no");
    expect(drafts.find((d) => d.key.startsWith("urgent:"))?.site).toBe("geoqa");
    expect(drafts.find((d) => d.key.startsWith("urgent:"))?.body).toContain("not a site defect");
    expect(drafts.find((d) => d.key.startsWith("urgent:"))?.body).toContain("No product breaking change");
    expect(drafts.some((d) => d.key.includes("type the query"))).toBe(false);
  });

  it("a city or country mismatch is one urgent Decodo ticket, even on a pass", () => {
    const drafts = draftsFromRuns([
      run({
        runId: "stav",
        verdict: "PASS",
        findings: { labels: [], byCategory: {} },
        geo: {
          requestedCountry: "NO",
          requestedCity: "Stavanger",
          observedCountry: "NO",
          observedCity: "Oslo",
          country: "match",
          city: "mismatch",
          egressHeld: "match",
        },
      }),
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.key).toBe("urgent:geo-mismatch");
    expect(drafts[0]?.urgent).toBe(true);
    expect(drafts[0]?.body).toContain("Stavanger");
    expect(drafts[0]?.body).toContain("Oslo");
    expect(drafts[0]?.body).toContain("## Problem");
    expect(drafts[0]?.body).toContain("distance");
    expect(drafts[0]?.body).toContain("load-bearing");
    expect(drafts[0]?.body).toContain("No product breaking change");
  });

  it("an egress that rotated mid-journey is urgent, and a broken console URL is not a link", () => {
    const drafts = draftsFromRuns(
      [
        run({
          verdict: "ERROR",
          findings: { labels: [], byCategory: {} },
          geo: {
            requestedCountry: "NO",
            requestedCity: "Oslo",
            observedCountry: "NO",
            observedCity: "Oslo",
            country: "match",
            city: "match",
            egressHeld: "mismatch",
          },
        }),
      ],
      { consoleBase: "::::" },
    );
    expect(drafts.map((d) => d.key)).toEqual(["urgent:run:egress-held"]);
    expect(drafts[0]?.body).not.toContain("#/run/");
    expect(drafts[0]?.body).toContain("rotated");
    expect(drafts[0]?.body).toContain("cannot be attributed to one visitor");
  });

  it("links the console when a base URL is given, and stays silent when it is not", () => {
    const withLink = draftsFromRuns([run()], { consoleBase: "https://geoqa.example/#/ignored" });
    expect(withLink[0]?.body).toContain("https://geoqa.example/#/run/run_1");
    expect(withLink[0]?.body).toContain("https://geoqa.example/#/findings");
    const bare = draftsFromRuns([run()]);
    expect(bare[0]?.body).not.toContain("#/run/");
  });
});
