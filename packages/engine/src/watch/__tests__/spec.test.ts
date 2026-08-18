import { describe, expect, it } from "vitest";
import { parseWatch, WatchSpecSchema } from "../spec.js";

const valid = {
  tenantId: "digilist",
  enabled: true,
  mode: "periodic",
  everyMinutes: 30,
  restSeconds: 15,
  markets: ["oslo"],
  devices: ["mobile"],
  journeys: ["landing-page"],
  targets: ["https://digilist.no"],
  allowWrites: false,
};

describe("WatchSpecSchema", () => {
  it("parses a complete watch", () => {
    const parsed = parseWatch(valid);
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    expect(parsed.value.mode).toBe("periodic");
    expect(parsed.value.everyMinutes).toBe(30);
  });

  it("defaults restSeconds, allowWrites, maxConcurrent and journeyPick so a short file is still complete", () => {
    const { restSeconds: _r, allowWrites: _w, ...short } = valid;
    const parsed = parseWatch(short);
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    expect(parsed.value.restSeconds).toBe(15);
    expect(parsed.value.allowWrites).toBe(false);
    expect(parsed.value.maxConcurrent).toBe(2);
    expect(parsed.value.journeyPick).toBe("all");
  });

  it("accepts a seeded pick and REFUSES an unseeded random — that draw cannot be replayed", () => {
    const seeded = parseWatch({ ...valid, journeyPick: "seeded" });
    if (!seeded.ok) throw new Error(seeded.errors.join("\n"));
    expect(seeded.value.journeyPick).toBe("seeded");
    expect(parseWatch({ ...valid, journeyPick: "random" }).ok).toBe(false);
  });

  it("REFUSES an unknown key rather than ignoring it", () => {
    expect(parseWatch({ ...valid, interval: 10 }).ok).toBe(false);
  });

  it("refuses a zero interval — that would spin a sweep on every tick", () => {
    expect(parseWatch({ ...valid, everyMinutes: 0 }).ok).toBe(false);
  });

  it("REFUSES a 4-minute interval — five minutes is the floor so a watch cannot spend the proxy allowance in an afternoon", () => {
    expect(parseWatch({ ...valid, everyMinutes: 4 }).ok).toBe(false);
    expect(parseWatch({ ...valid, everyMinutes: 5 }).ok).toBe(true);
  });

  it("allows an empty target list, because a paused watch with nothing to hit is a state, not a defect", () => {
    const parsed = parseWatch({ ...valid, targets: [] });
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    expect(parsed.value.targets).toEqual([]);
  });

  it("refuses a target that is not a URL", () => {
    expect(parseWatch({ ...valid, targets: ["digilist.no"] }).ok).toBe(false);
  });

  it("refuses a device that is not mobile or desktop", () => {
    expect(parseWatch({ ...valid, devices: ["tablet"] }).ok).toBe(false);
  });

  it("defaults e2e and targetJourneys so a pulse file without either still parses", () => {
    const parsed = parseWatch(valid);
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    expect(parsed.value.e2e).toEqual({ everyMinutes: 720, journeys: [] });
    expect(parsed.value.targetJourneys).toEqual({});
  });

  it("REFUSES extras — that list is e2e now, so a leftover key is a typo", () => {
    expect(parseWatch({ ...valid, extras: [] }).ok).toBe(false);
  });

  it("accepts an e2e journey and REFUSES one that is not a URL", () => {
    const journey = { market: "oslo", device: "desktop", journey: "login", url: "https://dashboard.digilist.no/login" };
    const parsed = parseWatch({ ...valid, e2e: { everyMinutes: 480, journeys: [journey] } });
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    expect(parsed.value.e2e).toEqual({ everyMinutes: 480, journeys: [journey] });
    expect(parseWatch({ ...valid, e2e: { journeys: [{ ...journey, url: "dashboard.digilist.no" }] } }).ok).toBe(false);
    expect(parseWatch({ ...valid, e2e: { everyMinutes: 4, journeys: [journey] } }).ok).toBe(false);
  });

  it("accepts a per-target pool and REFUSES an empty one or a key that is not a URL", () => {
    const dashboard = "https://dashboard.digilist.no/login";
    const parsed = parseWatch({ ...valid, targetJourneys: { [dashboard]: ["login-reachable"] } });
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    expect(parsed.value.targetJourneys).toEqual({ [dashboard]: ["login-reachable"] });
    expect(parseWatch({ ...valid, targetJourneys: { [dashboard]: [] } }).ok).toBe(false);
    expect(parseWatch({ ...valid, targetJourneys: { "dashboard.digilist.no": ["login-reachable"] } }).ok).toBe(false);
  });

});

describe("WatchSpecSchema shape", () => {
  it("is the schema the store and the UI both honour", () => {
    expect(WatchSpecSchema.safeParse(valid).success).toBe(true);
  });
});
