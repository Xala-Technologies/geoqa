import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadGeoProfile, localeInitScript, parseGeoProfile, toSessionConfig } from "../profile.js";
import type { GeoProfile } from "../types.js";
import { findRepoRoot, profilesRoot } from "../../repo.js";

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

const RAW = {
  id: "oslo-mobile",
  label: "Oslo, mobile",
  market: {
    id: "oslo",
    country: "no",
    city: "Oslo",
    language: "nb-NO",
    timezone: "Europe/Oslo",
    currency: "NOK",
    coordinates: [59.9139, 10.7522],
  },
  device: { id: "mobile", kind: "mobile", viewport: { width: 390, height: 844 } },
};

const profile = (): GeoProfile => {
  const out = parseGeoProfile(RAW);
  if (!out.ok) throw new Error(out.errors.join());
  return out.value;
};

describe("parseGeoProfile", () => {
  it("normalises the country to upper case and defaults visitorType", () => {
    const p = profile();
    expect(p.market.country).toBe("NO");
    expect(p.visitorType).toBe("anonymous");
  });

  it("rejects a country that is not two letters", () => {
    const out = parseGeoProfile({ ...RAW, market: { ...RAW.market, country: "NOR" } });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected failure");
    expect(out.errors[0]).toContain("market.country");
  });

  it("rejects a non-positive viewport and a malformed coordinate pair", () => {
    expect(parseGeoProfile({ ...RAW, device: { ...RAW.device, viewport: { width: 0, height: 844 } } }).ok).toBe(false);
    expect(parseGeoProfile({ ...RAW, market: { ...RAW.market, coordinates: [1] } }).ok).toBe(false);
  });

  it("names the failing path so a bad profile explains itself", () => {
    const out = parseGeoProfile({ label: "x" });
    if (out.ok) throw new Error("expected failure");
    expect(out.errors.join()).toContain("id");
  });

  it("reports a root-level failure without a path", () => {
    const out = parseGeoProfile("not an object");
    if (out.ok) throw new Error("expected failure");
    expect(out.errors[0]).toContain("(root)");
  });
});

describe("loadGeoProfile", () => {
  it("reads YAML from disk", () => {
    const out = loadGeoProfile(path.join(profilesRoot(repoRoot), "oslo-mobile.yaml"));
    if (!out.ok) throw new Error(out.errors.join());
    expect(out.value.market.timezone).toBe("Europe/Oslo");
  });

  it("reports YAML syntax and validation errors against the path", () => {
    expect(loadGeoProfile("bad.yaml", () => "a: [\n b").ok).toBe(false);
    const invalid = loadGeoProfile("bad.yaml", () => "id: x\n");
    if (invalid.ok) throw new Error("expected failure");
    expect(invalid.errors[0]).toContain("bad.yaml:");
  });
});

describe("the profiles that actually ship", () => {
  const dir = profilesRoot(repoRoot);
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));

  it("covers every market on both devices", () => {
    // The matrix is the unit of coverage: a market tested on one device only
    // cannot catch a device-specific defect, which is the class the very first
    // live run hit (CLS 0.76 on desktop, passing on mobile).
    //
    // Derived from the directory rather than a literal list. A hardcoded roster
    // is a maintenance tax that fires on every market added, and it fired twice
    // in one day — once at 4 markets, once at 8.
    // Derived from the files that ARE a market x device pair, rather than from every
    // file. The previous form stripped `-(mobile|desktop).yaml` from every name and
    // treated whatever was left as a market, so the first profile that was not a
    // plain market x device pair — the returning-visitor one — became a "market"
    // whose desktop file was then reported missing. The rule being tested is about
    // pairs, so only pairs are enumerated.
    const cities = [...new Set(files.filter((f) => /-(mobile|desktop)\.yaml$/.test(f)).map((f) => f.replace(/-(mobile|desktop)\.yaml$/, "")))].sort();
    expect(cities.length).toBeGreaterThanOrEqual(8);
    for (const city of cities) {
      expect(files, `${city} desktop`).toContain(`${city}-desktop.yaml`);
      expect(files, `${city} mobile`).toContain(`${city}-mobile.yaml`);
    }
    // Every pair is accounted for, and anything else is a deliberate extra rather
    // than a market missing half its coverage.
    const extras = files.filter((f) => !/-(mobile|desktop)\.yaml$/.test(f));
    expect(files).toHaveLength(cities.length * 2 + extras.length);
  });

  it.each(files)("%s parses, and its id matches its filename", (file) => {
    const out = loadGeoProfile(path.join(dir, file), (p) => readFileSync(p, "utf8"));
    if (!out.ok) throw new Error(out.errors.join("\n"));
    expect(out.value.id).toBe(file.replace(/\.yaml$/, ""));
  });
});

describe("localeInitScript", () => {
  it("overrides navigator.language and languages with the market's tag and its primary subtag", () => {
    const script = localeInitScript(profile());
    expect(script).toContain('["nb-NO","nb"]');
    expect(script).toContain("navigator, 'language'");
    expect(script).toContain("navigator, 'languages'");
  });

  it("stubs the Geolocation API with the market's coordinates", () => {
    // Necessary because `set geo` alone leaves a headless page with
    // "User denied Geolocation" — measured in EXP-000.
    const script = localeInitScript(profile());
    expect(script).toContain("latitude: 59.9139");
    expect(script).toContain("longitude: 10.7522");
    expect(script).toContain("getCurrentPosition");
    expect(script).toContain("watchPosition");
  });

  it("handles a language tag with no region", () => {
    const p = profile();
    const script = localeInitScript({ ...p, market: { ...p.market, language: "nb" } });
    expect(script).toContain('["nb","nb"]');
  });
});

describe("toSessionConfig", () => {
  it("always sets TZ, the only thing that actually moves the browser's clock", () => {
    const config = toSessionConfig(profile(), { sessionId: "run1" });
    expect(config.env).toEqual({ TZ: "Europe/Oslo" });
  });

  it("namespaces by market, so two markets cannot share one browser process", () => {
    expect(toSessionConfig(profile(), { sessionId: "run1" }).namespace).toBe("oslo");
  });

  it("omits proxy, init scripts, user agent and headed when not supplied", () => {
    const config = toSessionConfig(profile(), { sessionId: "run1" });
    expect(config.proxy).toBeUndefined();
    expect(config.initScripts).toBeUndefined();
    expect(config.userAgent).toBeUndefined();
    expect(config.headed).toBeUndefined();
  });

  it("carries every supplied option through", () => {
    const p = profile();
    const config = toSessionConfig(
      { ...p, device: { ...p.device, userAgent: "UA/1" } },
      {
        sessionId: "run1",
        proxyUrl: "http://gw:1",
        proxyBypass: "localhost",
        initScriptPath: "/tmp/locale.js",
        headed: true,
        baseEnv: { PATH: "/usr/bin" },
      },
    );
    expect(config).toMatchObject({
      sessionId: "run1",
      namespace: "oslo",
      proxy: "http://gw:1",
      proxyBypass: "localhost",
      userAgent: "UA/1",
      initScripts: ["/tmp/locale.js"],
      headed: true,
      env: { PATH: "/usr/bin", TZ: "Europe/Oslo" },
    });
  });

  it("treats a null proxy as direct egress rather than an empty flag", () => {
    const config = toSessionConfig(profile(), { sessionId: "r", proxyUrl: null, proxyBypass: null });
    expect(config.proxy).toBeUndefined();
    expect(config.proxyBypass).toBeUndefined();
  });
});
