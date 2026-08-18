import { describe, expect, it } from "vitest";
import { routeTicket, siteLabel, type SiteRepo } from "../repos.js";

const sites: SiteRepo[] = [
  { host: "digilist.no", repo: "Xala-Technologies/booking-brilliance", base: "main" },
  { host: "app.digilist.no", repo: "Xala-Technologies/Digilist", base: "dev" },
  { host: "dashboard.digilist.no", repo: "Xala-Technologies/Digilist", base: "dev" },
  { host: "xala.no", repo: "xalatechnologies/xala-web-cloner", base: "main" },
];

describe("siteLabel", () => {
  it("is the host, so a filter on GitHub is the site the visitor saw", () => {
    expect(siteLabel("app.digilist.no")).toBe("site:app.digilist.no");
  });
});

describe("routeTicket", () => {
  it("sends a site finding to that host's repo, and Digilist PRs start on dev", () => {
    const app = routeTicket(
      { urgent: false, hosts: ["app.digilist.no"], site: "app.digilist.no" },
      sites,
      "Xala-Technologies/geoqa",
    );
    expect(app).toEqual({ repo: "Xala-Technologies/Digilist", base: "dev", site: "app.digilist.no" });
    const dashboard = routeTicket(
      { urgent: false, hosts: ["dashboard.digilist.no"], site: "dashboard.digilist.no" },
      sites,
      "Xala-Technologies/geoqa",
    );
    expect(dashboard).toEqual({ repo: "Xala-Technologies/Digilist", base: "dev", site: "dashboard.digilist.no" });
    const marketing = routeTicket(
      { urgent: false, hosts: ["digilist.no"], site: "digilist.no" },
      sites,
      "Xala-Technologies/geoqa",
    );
    expect(marketing.repo).toBe("Xala-Technologies/booking-brilliance");
    expect(marketing.base).toBe("main");
  });

  it("keeps instrumentation on geoqa/main even when the run hit a mapped host", () => {
    const dest = routeTicket(
      { urgent: true, hosts: ["digilist.no", "xala.no"], site: "geoqa" },
      sites,
      "Xala-Technologies/geoqa",
    );
    expect(dest).toEqual({ repo: "Xala-Technologies/geoqa", base: "main", site: "geoqa" });
  });

  it("an unmapped host stays on the fallback repo rather than inventing a destination", () => {
    const dest = routeTicket(
      { urgent: false, hosts: ["dev.digilist.no"], site: "dev.digilist.no" },
      sites,
      "Xala-Technologies/geoqa",
    );
    expect(dest).toEqual({ repo: "Xala-Technologies/geoqa", base: "main", site: "dev.digilist.no" });
  });
});
