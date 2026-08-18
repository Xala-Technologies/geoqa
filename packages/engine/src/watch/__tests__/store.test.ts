import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyWatchPatch, dropOrphanTargetJourneys, loadWatch, saveWatch, watchPath, watchableMarkets } from "../store.js";
import type { WatchSpec } from "../spec.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

const spec = (over: Partial<WatchSpec> = {}): WatchSpec => ({
  tenantId: "digilist",
  enabled: false,
  mode: "periodic",
  everyMinutes: 30,
  restSeconds: 15,
  markets: ["oslo"],
  devices: ["mobile", "desktop"],
  journeys: ["landing-page"],
  targets: ["https://digilist.no"],
  maxConcurrent: 2,
  allowWrites: false,
  journeyPick: "all",
  e2e: { everyMinutes: 720, journeys: [] },
  targetJourneys: {},
  ...over,
});

describe("watchableMarkets", () => {
  it("keeps the tenant's order and drops a market we have no profile for", () => {
    expect(watchableMarkets(["oslo", "berlin", "bergen"], ["bergen", "oslo", "london"])).toEqual(["oslo", "bergen"]);
  });

  it("is empty when the tenant listed cities we cannot serve — not every city on disk", () => {
    expect(watchableMarkets(["atlantis"], ["oslo", "berlin"])).toEqual([]);
  });
});

describe("watchPath", () => {
  it("lives beside the tenant, not inside src/", () => {
    expect(watchPath("/repo/tenants", "digilist")).toBe("/repo/tenants/digilist/watch.yaml");
  });
});

describe("loadWatch / saveWatch", () => {
  it("round-trips a spec through YAML", () => {
    let written = "";
    saveWatch("/t/watch.yaml", spec(), (_p, text) => {
      written = text;
    });
    expect(written).toContain("tenantId: digilist");
    const loaded = loadWatch("/t/watch.yaml", () => written);
    if (!loaded.ok) throw new Error(loaded.errors.join());
    expect(loaded.value.enabled).toBe(false);
    expect(loaded.value.targets).toEqual(["https://digilist.no"]);
  });

  it("reads from disk when no reader is injected", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "geoqa-watch-"));
    temps.push(dir);
    const file = path.join(dir, "watch.yaml");
    saveWatch(file, spec());
    const loaded = loadWatch(file);
    if (!loaded.ok) throw new Error(loaded.errors.join());
    expect(loaded.value.tenantId).toBe("digilist");
  });

  it("creates the directory and writes the file when no writer is injected", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "geoqa-watch-"));
    temps.push(dir);
    const file = path.join(dir, "nested", "watch.yaml");
    saveWatch(file, spec());
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("tenantId: digilist");
  });

  it("reports YAML and schema errors against the path", () => {
    expect(loadWatch("w.yaml", () => "a: [\n").ok).toBe(false);
    const invalid = loadWatch("w.yaml", () => "tenantId: x\n");
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error("expected failure");
    expect(invalid.errors[0]).toContain("w.yaml:");
  });
});

describe("applyWatchPatch", () => {
  const allowed = {
    markets: ["oslo", "bergen", "trondheim"],
    journeys: [
      { id: "landing-page", writes: false },
      { id: "contact-form", writes: true },
      { id: "login", writes: true },
      { id: "login-reachable", writes: false },
    ],
  };

  it("merges a partial patch onto the current spec", () => {
    const out = applyWatchPatch(spec(), { enabled: true, everyMinutes: 15, journeyPick: "seeded" }, allowed);
    if (!out.ok) throw new Error(out.errors.join());
    expect(out.value.enabled).toBe(true);
    expect(out.value.everyMinutes).toBe(15);
    expect(out.value.journeyPick).toBe("seeded");
    expect(out.value.targets).toEqual(["https://digilist.no"]);
  });

  it("REFUSES a patch that fails the schema, not only one that names a missing market", () => {
    expect(applyWatchPatch(spec(), { everyMinutes: 0 }, allowed).ok).toBe(false);
  });

  it("REFUSES a market or journey that does not exist on disk", () => {
    expect(applyWatchPatch(spec(), { markets: ["atlantis"] }, allowed).ok).toBe(false);
    expect(applyWatchPatch(spec(), { journeys: ["nope"] }, allowed).ok).toBe(false);
  });

  it("REFUSES a writes journey unless allowWrites is on the resulting spec", () => {
    expect(applyWatchPatch(spec(), { journeys: ["contact-form"] }, allowed).ok).toBe(false);
    const out = applyWatchPatch(spec(), { journeys: ["contact-form"], allowWrites: true }, allowed);
    if (!out.ok) throw new Error(out.errors.join());
    expect(out.value.journeys).toEqual(["contact-form"]);
  });

  it("REFUSES an e2e market or journey that is not on disk", () => {
    const journey = { market: "oslo", device: "desktop" as const, journey: "login", url: "https://dashboard.digilist.no/login" };
    expect(applyWatchPatch(spec(), { e2e: { journeys: [{ ...journey, market: "atlantis" }] } }, allowed).ok).toBe(false);
    expect(applyWatchPatch(spec(), { e2e: { journeys: [{ ...journey, journey: "nope" }] } }, allowed).ok).toBe(false);
  });

  it("keeps a writes e2e journey without turning allowWrites on for the pulse", () => {
    const journey = { market: "oslo", device: "desktop" as const, journey: "login", url: "https://dashboard.digilist.no/login" };
    const out = applyWatchPatch(spec(), { e2e: { everyMinutes: 480, journeys: [journey] } }, allowed);
    if (!out.ok) throw new Error(out.errors.join());
    expect(out.value.allowWrites).toBe(false);
    expect(out.value.e2e).toEqual({ everyMinutes: 480, journeys: [journey] });
  });

  it("deep-merges e2e so changing the interval does not drop the journeys", () => {
    const journey = { market: "oslo", device: "desktop" as const, journey: "login", url: "https://dashboard.digilist.no/login" };
    const current = spec({ e2e: { everyMinutes: 720, journeys: [journey] } });
    const out = applyWatchPatch(current, { e2e: { everyMinutes: 480 } }, allowed);
    if (!out.ok) throw new Error(out.errors.join());
    expect(out.value.e2e).toEqual({ everyMinutes: 480, journeys: [journey] });
  });

  it("refuses a body that is not an object, rather than treating null as empty", () => {
    expect(applyWatchPatch(spec(), null, allowed).ok).toBe(false);
    expect(applyWatchPatch(spec(), ["oslo"], allowed).ok).toBe(false);
  });

  it("REFUSES a targetJourneys URL that is not a watch target, or a writes journey without allowWrites", () => {
    const dashboard = "https://dashboard.digilist.no/login";
    expect(
      applyWatchPatch(spec(), { targetJourneys: { [dashboard]: ["login-reachable"] } }, allowed).ok,
    ).toBe(false);
    expect(
      applyWatchPatch(
        spec({ targets: ["https://digilist.no", dashboard] }),
        { targetJourneys: { [dashboard]: ["login"] } },
        allowed,
      ).ok,
    ).toBe(false);
    const out = applyWatchPatch(
      spec({ targets: ["https://digilist.no", dashboard] }),
      { targetJourneys: { [dashboard]: ["login-reachable"] } },
      allowed,
    );
    if (!out.ok) throw new Error(out.errors.join());
    expect(out.value.targetJourneys).toEqual({ [dashboard]: ["login-reachable"] });
  });

  it("REFUSES an unknown target journey", () => {
    const dashboard = "https://dashboard.digilist.no/login";
    expect(
      applyWatchPatch(
        spec({ targets: ["https://digilist.no", dashboard] }),
        { targetJourneys: { [dashboard]: ["nope"] } },
        allowed,
      ).ok,
    ).toBe(false);
  });

  it("drops an orphaned targetJourneys key when the target list changes and the map is not in the patch", () => {
    const dashboard = "https://dashboard.digilist.no/login";
    const current = spec({
      targets: ["https://digilist.no", dashboard],
      targetJourneys: { [dashboard]: ["login-reachable"] },
    });
    const out = applyWatchPatch(current, { targets: ["https://digilist.no"] }, allowed);
    if (!out.ok) throw new Error(out.errors.join());
    expect(out.value.targetJourneys).toEqual({});
    expect(out.value.targets).toEqual(["https://digilist.no"]);
  });
});

describe("dropOrphanTargetJourneys", () => {
  it("leaves a matching map alone and drops a URL that is no longer a target", () => {
    const dashboard = "https://dashboard.digilist.no/login";
    const matching = spec({
      targets: ["https://digilist.no", dashboard],
      targetJourneys: { [dashboard]: ["login-reachable"] },
    });
    expect(dropOrphanTargetJourneys(matching)).toBe(matching);
    expect(
      dropOrphanTargetJourneys({
        ...matching,
        targets: ["https://digilist.no"],
      }).targetJourneys,
    ).toEqual({});
  });
});
