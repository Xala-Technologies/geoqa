import { describe, expect, it } from "vitest";
import { seedFrom } from "../../journeys/random.js";
import { expandWatchCells, journeySeedMaterial, pickSeededCells, pickSeededJourney } from "../journey-pick.js";

const POOL = ["landing-page", "browse", "search", "reader", "returning-visitor"] as const;

/** 2026-08-18T14:00:00.000Z — the hour in "why did Oslo get search at 14:00?" */
const FOURTEEN = Date.UTC(2026, 7, 18, 14, 0, 0);

describe("journeySeedMaterial", () => {
  it("is UTC date-hour + market + url — device is not in the seed", () => {
    expect(journeySeedMaterial(FOURTEEN, "oslo", "https://digilist.no")).toBe(
      "2026-08-18T14\0oslo\0https://digilist.no",
    );
    expect(journeySeedMaterial(FOURTEEN + 59 * 60_000, "oslo", "https://digilist.no")).toBe(
      journeySeedMaterial(FOURTEEN, "oslo", "https://digilist.no"),
    );
    expect(journeySeedMaterial(FOURTEEN, "oslo", "https://digilist.no")).not.toBe(
      journeySeedMaterial(FOURTEEN, "bergen", "https://digilist.no"),
    );
    expect(journeySeedMaterial(FOURTEEN, "oslo", "https://digilist.no")).not.toBe(
      journeySeedMaterial(FOURTEEN, "oslo", "https://app.digilist.no"),
    );
  });

  it("moves when the UTC hour does, so 14:00 and 15:00 are different evidence", () => {
    expect(journeySeedMaterial(FOURTEEN + 60 * 60_000, "oslo", "https://digilist.no")).toBe(
      "2026-08-18T15\0oslo\0https://digilist.no",
    );
  });
});

describe("pickSeededJourney", () => {
  it("is a function of seedFrom(material) over the sorted unique pool — not Math.random", () => {
    const material = journeySeedMaterial(FOURTEEN, "oslo", "https://digilist.no");
    const sorted = [...POOL].sort();
    expect(pickSeededJourney(POOL, material)).toBe(sorted[seedFrom(material) % sorted.length]);
  });

  it("gives the same journey for the same material, every time", () => {
    const material = journeySeedMaterial(FOURTEEN, "oslo", "https://digilist.no");
    expect(pickSeededJourney(POOL, material)).toBe(pickSeededJourney(POOL, material));
  });

  it("ignores pool order and duplicates, so YAML shuffle is not a different draw", () => {
    const material = journeySeedMaterial(FOURTEEN, "oslo", "https://digilist.no");
    expect(pickSeededJourney(["search", "browse", "browse", "landing-page", "reader", "returning-visitor"], material)).toBe(
      pickSeededJourney(POOL, material),
    );
  });

  it("REFUSES an empty pool — that is zero evidence, not a lucky skip", () => {
    expect(() => pickSeededJourney([], "2026-08-18T14\0oslo\0https://digilist.no")).toThrow(/empty pool/);
  });
});

describe("pickSeededCells", () => {
  const axes = {
    markets: ["oslo", "bergen"],
    devices: ["mobile"] as const,
    journeys: [...POOL],
    targets: ["https://digilist.no", "https://app.digilist.no"],
    atMs: FOURTEEN,
  };

  it("draws one journey per market × device × url, not the cartesian product of the pool", () => {
    const cells = pickSeededCells(axes);
    expect(cells).toHaveLength(4);
    expect(new Set(cells.map((c) => `${c.market}/${c.device}/${c.target}`)).size).toBe(4);
    for (const cell of cells) {
      expect(POOL).toContain(cell.journey);
    }
  });

  it("is replayable: the same hour + city + url is the same journey", () => {
    expect(pickSeededCells(axes)).toEqual(pickSeededCells(axes));
  });

  it("gives mobile and desktop the same journey that hour — the seed is city × url", () => {
    const cells = pickSeededCells({ ...axes, devices: ["mobile", "desktop"] });
    expect(cells).toHaveLength(8);
    const osloSite = cells.filter((c) => c.market === "oslo" && c.target === "https://digilist.no");
    expect(osloSite).toHaveLength(2);
    expect(osloSite[0]!.journey).toBe(osloSite[1]!.journey);
  });

  it("answers why Oslo got that journey at 14:00 from the seed material, not chance", () => {
    const cells = pickSeededCells(axes);
    const oslo = cells.find((c) => c.market === "oslo" && c.target === "https://digilist.no");
    expect(oslo?.journey).toBe(
      pickSeededJourney(POOL, journeySeedMaterial(FOURTEEN, "oslo", "https://digilist.no")),
    );
  });

  it("keeps 26 cities × 2 URLs × 1 device at 52 cells", () => {
    const markets = Array.from({ length: 26 }, (_, i) => `city-${i}`);
    const cells = pickSeededCells({
      markets,
      devices: ["mobile"],
      journeys: [...POOL],
      targets: ["https://digilist.no", "https://app.digilist.no"],
      atMs: FOURTEEN,
    });
    expect(cells).toHaveLength(52);
  });

  it("is empty when there is nothing to visit, not a throw", () => {
    expect(pickSeededCells({ ...axes, targets: [] })).toEqual([]);
    expect(pickSeededCells({ ...axes, markets: [] })).toEqual([]);
    expect(pickSeededCells({ ...axes, devices: [] })).toEqual([]);
  });

  it("REFUSES an empty journey pool the same way a single draw does", () => {
    expect(() => pickSeededCells({ ...axes, journeys: [] })).toThrow(/empty pool/);
  });

  it("uses a per-target pool so dashboard does not draw browse or search", () => {
    const dashboard = "https://dashboard.digilist.no/login";
    const cells = pickSeededCells({
      ...axes,
      targets: ["https://digilist.no", dashboard],
      journeysByTarget: { [dashboard]: ["login-reachable"] },
    });
    const dash = cells.filter((c) => c.target === dashboard);
    expect(dash).toHaveLength(2);
    expect(dash.every((c) => c.journey === "login-reachable")).toBe(true);
    expect(cells.filter((c) => c.target === "https://digilist.no").every((c) => POOL.includes(c.journey as (typeof POOL)[number]))).toBe(true);
  });
});

describe("expandWatchCells", () => {
  it("keeps the marketing cartesian product and pins dashboard to its own pool", () => {
    const dashboard = "https://dashboard.digilist.no/login";
    const cells = expandWatchCells({
      markets: ["oslo"],
      devices: ["desktop"],
      journeys: ["landing-page", "browse"],
      targets: ["https://digilist.no", dashboard],
      journeysByTarget: { [dashboard]: ["login-reachable"] },
    });
    expect(cells).toEqual([
      { market: "oslo", device: "desktop", journey: "landing-page", target: "https://digilist.no" },
      { market: "oslo", device: "desktop", journey: "browse", target: "https://digilist.no" },
      { market: "oslo", device: "desktop", journey: "login-reachable", target: dashboard },
    ]);
  });
});
