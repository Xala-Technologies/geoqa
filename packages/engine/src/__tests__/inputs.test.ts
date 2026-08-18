/**
 * The committed input trees, loaded the way a run loads them.
 *
 * Profiles, journeys, the tenant file, its overrides, watch, keywords and
 * experiment records are data, not code. A file that does not parse is a
 * silent hole in the matrix: the suite that only exercised fixtures would
 * stay green while `geoqa journey run` refused the name on the watch.
 *
 * `watch/store` tests deliberately never point at `tenants/digilist/watch.yaml`
 * so they cannot rewrite it. This file is the one that reads the committed
 * trees, and it is read-only.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { EXPERIMENTS } from "../experiments/definitions.js";
import { loadGeoProfile } from "../geo/profile.js";
import { loadJourney } from "../journeys/spec.js";
import { loadKeywordSeeds } from "../keywords/seeds.js";
import {
  experimentsRoot,
  findRepoRoot,
  journeysRoot,
  profilesRoot,
  tenantsRoot,
} from "../repo.js";
import { loadTenant } from "../tenant/registry.js";
import { MB_PER_PAGE_LOAD } from "../tenant/quota.js";
import { loadWatch } from "../watch/store.js";

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const yamlIn = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort() : [];

describe("shared profiles", () => {
  const dir = profilesRoot(repoRoot);
  const files = yamlIn(dir);

  it.each(files)("%s parses, id matches filename, and never sets isMobile or emulate", (file) => {
    const full = path.join(dir, file);
    const loaded = loadGeoProfile(full, (p) => readFileSync(p, "utf8"));
    if (!loaded.ok) throw new Error(loaded.errors.join("\n"));
    expect(loaded.value.id).toBe(file.replace(/\.yaml$/, ""));
    expect(loaded.value.device.emulate).toBeUndefined();
    const raw = parseYaml(readFileSync(full, "utf8")) as { device?: Record<string, unknown> };
    expect(raw.device).not.toHaveProperty("emulate");
    expect(raw.device).not.toHaveProperty("isMobile");
  });

  it("gives every market a mobile 390×844 and a desktop 1440×900", () => {
    const pairs = files.filter((f) => /-(mobile|desktop)\.yaml$/.test(f));
    const cities = [...new Set(pairs.map((f) => f.replace(/-(mobile|desktop)\.yaml$/, "")))];
    for (const city of cities) {
      const mobile = loadGeoProfile(path.join(dir, `${city}-mobile.yaml`));
      const desktop = loadGeoProfile(path.join(dir, `${city}-desktop.yaml`));
      if (!mobile.ok || !desktop.ok) throw new Error(`${city}: ${[...(!mobile.ok ? mobile.errors : []), ...(!desktop.ok ? desktop.errors : [])].join()}`);
      expect(mobile.value.device.viewport).toEqual({ width: 390, height: 844 });
      expect(desktop.value.device.viewport).toEqual({ width: 1440, height: 900 });
      expect(mobile.value.market.id).toBe(city);
      expect(desktop.value.market.id).toBe(city);
    }
  });
});

describe("shared journeys", () => {
  const dir = journeysRoot(repoRoot);
  const files = yamlIn(dir);

  it.each(files)("%s parses and its id matches its filename", (file) => {
    const loaded = loadJourney(path.join(dir, file), (p) => readFileSync(p, "utf8"));
    if (!loaded.ok) throw new Error(loaded.errors.join("\n"));
    expect(loaded.value.id).toBe(file.replace(/\.yaml$/, ""));
  });
});

describe("tenant digilist", () => {
  const tenantsDir = tenantsRoot(repoRoot);
  const tenantFile = path.join(tenantsDir, "digilist.yaml");
  const tenantJourneys = path.join(tenantsDir, "digilist", "journeys");
  const tenant = loadTenant(tenantFile, (p) => readFileSync(p, "utf8"));
  if (!tenant.ok) throw new Error(tenant.errors.join("\n"));

  it("loads, and every market has both device profiles on disk", () => {
    expect(tenant.value.id).toBe("digilist");
    const profiles = new Set(yamlIn(profilesRoot(repoRoot)).map((f) => f.replace(/\.yaml$/, "")));
    for (const market of tenant.value.markets) {
      expect(profiles, `${market} mobile`).toContain(`${market}-mobile`);
      expect(profiles, `${market} desktop`).toContain(`${market}-desktop`);
    }
  });

  it.each(yamlIn(tenantJourneys))("override %s parses, and its id matches its filename", (file) => {
    const loaded = loadJourney(path.join(tenantJourneys, file), (p) => readFileSync(p, "utf8"));
    if (!loaded.ok) throw new Error(loaded.errors.join("\n"));
    expect(loaded.value.id).toBe(file.replace(/\.yaml$/, ""));
  });

  it("keywords parse, and a scoped market is one this tenant asked about", () => {
    const loaded = loadKeywordSeeds(path.join(tenantsDir, "digilist", "keywords.yaml"), (p) =>
      readFileSync(p, "utf8"),
    );
    if (!loaded.ok) throw new Error(loaded.errors.join("\n"));
    for (const seed of loaded.value) {
      for (const market of seed.markets ?? []) {
        expect(tenant.value.markets, market).toContain(market);
      }
    }
  });

  it("watch.yaml parses as the seeded pulse, and every name it uses exists", () => {
    const watch = loadWatch(path.join(tenantsDir, "digilist", "watch.yaml"), (p) => readFileSync(p, "utf8"));
    if (!watch.ok) throw new Error(watch.errors.join("\n"));
    expect(watch.value.tenantId).toBe("digilist");
    expect(watch.value.journeyPick).toBe("seeded");
    expect(watch.value.allowWrites).toBe(false);
    expect(watch.value.enabled).toBe(true);
    expect(watch.value.mode).toBe("periodic");
    expect(watch.value.everyMinutes).toBe(180);
    expect(watch.value.devices).toEqual(["desktop"]);
    expect(watch.value.targets).toEqual([
      "https://digilist.no",
      "https://app.digilist.no",
      "https://xala.no",
    ]);
    expect(watch.value.markets).toEqual(tenant.value.markets);
    expect(watch.value.markets).toEqual(expect.arrayContaining([
      "moss",
      "asker",
      "lorenskog",
      "sandvika",
      "horten",
      "steinkjer",
      "lillestrom",
      "sola",
    ]));

    for (const market of watch.value.markets) {
      expect(tenant.value.markets, market).toContain(market);
    }
    const journeyIds = new Set([
      ...yamlIn(journeysRoot(repoRoot)).map((f) => f.replace(/\.yaml$/, "")),
      ...yamlIn(tenantJourneys).map((f) => f.replace(/\.yaml$/, "")),
    ]);
    const writes = new Set(
      [...yamlIn(journeysRoot(repoRoot)), ...yamlIn(tenantJourneys)].flatMap((file) => {
        const root = yamlIn(tenantJourneys).includes(file) ? tenantJourneys : journeysRoot(repoRoot);
        const loaded = loadJourney(path.join(root, file));
        return loaded.ok && loaded.value.writes ? [loaded.value.id] : [];
      }),
    );
    for (const id of watch.value.journeys) {
      expect(journeyIds, id).toContain(id);
      if (!watch.value.allowWrites) expect(writes.has(id), id).toBe(false);
    }
    // Audit 2026-08-18 §2: returning-visitor asserts a restored session as a
    // site defect. The pulse is desktop + agent-browser + anonymous; that
    // engine isolates cookies per run. The journey still does not belong
    // on this watch.
    expect(watch.value.journeys).not.toContain("returning-visitor");

    // cells × hours-per-day. A ceiling below that refuses mid-day and looks
    // like a broken proxy.
    const cells = watch.value.markets.length * watch.value.devices.length * watch.value.targets.length;
    const runsPerDay = cells * Math.floor((24 * 60) / watch.value.everyMinutes);
    expect(tenant.value.quota.runsPerDay).toBeGreaterThanOrEqual(runsPerDay);
    expect(tenant.value.quota.trafficMb).toBeGreaterThanOrEqual(runsPerDay * 30 * MB_PER_PAGE_LOAD);
  });
});

describe("experiments on disk", () => {
  const dir = experimentsRoot(repoRoot);
  const folders = readdirSync(dir).filter((name) => name.startsWith("EXP-")).sort();

  it("has one directory per registered experiment, and each record is JSON", () => {
    expect(folders).toEqual([...Object.keys(EXPERIMENTS)].sort());
    for (const folder of folders) {
      const hypothesis = JSON.parse(readFileSync(path.join(dir, folder, "hypothesis.json"), "utf8")) as { id: string };
      expect(hypothesis.id).toBe(folder);
      JSON.parse(readFileSync(path.join(dir, folder, "configuration.json"), "utf8"));
      JSON.parse(readFileSync(path.join(dir, folder, "summary.json"), "utf8"));
    }
  });
});
