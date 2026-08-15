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

  it("defaults restSeconds, allowWrites and maxConcurrent so a short file is still complete", () => {
    const { restSeconds: _r, allowWrites: _w, ...short } = valid;
    const parsed = parseWatch(short);
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    expect(parsed.value.restSeconds).toBe(15);
    expect(parsed.value.allowWrites).toBe(false);
    expect(parsed.value.maxConcurrent).toBe(2);
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
});

describe("WatchSpecSchema shape", () => {
  it("is the schema the store and the UI both honour", () => {
    expect(WatchSpecSchema.safeParse(valid).success).toBe(true);
  });
});
