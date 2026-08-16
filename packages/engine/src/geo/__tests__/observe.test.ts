import { describe, expect, it } from "vitest";
import type { BrowserResult, BrowserRuntime } from "../../browser/types.js";
import {
  BROWSER_ENV_EXPRESSION,
  UNKNOWN_BROWSER,
  UNKNOWN_NETWORK,
  GEOJS_SOURCE,
  IPINFO_SOURCE,
  observeBrowser,
  observeNetwork,
  observeNetworkVia,
  parseBrowserObservation,
  parseGeoJsObservation,
  parseLoc,
  parseNetworkObservation,
} from "../observe.js";

const meta = { stdout: "", stderr: "", durationMs: 1, command: "c" };
const ok = <T,>(data: T): BrowserResult<T> => ({ ok: true, data, ...meta });
const bad = <T,>(): BrowserResult<T> => ({
  ok: false,
  failure: { kind: "exit", detail: "no", exitCode: 1, signal: null },
  ...meta,
});

/** The real ipinfo.io body captured during EXP-000 from the Norway baseline. */
const IPINFO_REAL = JSON.stringify({
  ip: "213.52.15.251",
  hostname: "static251.banetele-cust.com",
  city: "Lysaker",
  region: "Akershus",
  country: "NO",
  loc: "59.8927,10.6190",
  org: "AS2116 GLOBALCONNECT AS",
  postal: "1364",
  timezone: "Europe/Oslo",
});

function fakeRuntime(parts: Partial<BrowserRuntime>): BrowserRuntime {
  return parts as BrowserRuntime;
}

describe("parseNetworkObservation", () => {
  it("maps the real Norway baseline payload", () => {
    expect(parseNetworkObservation(IPINFO_REAL, 42)).toEqual({
      ip: "213.52.15.251",
      country: "NO",
      city: "Lysaker",
      region: "Akershus",
      org: "AS2116 GLOBALCONNECT AS",
      timezone: "Europe/Oslo",
      // `loc` parsed rather than discarded: this is what lets a city verdict be a distance
      // instead of a string comparison.
      coordinates: [59.8927, 10.619],
      latencyMs: 42,
    });
  });

  it("upper-cases the country so comparison is never case-sensitive", () => {
    expect(parseNetworkObservation('{"country":"no"}', null).country).toBe("NO");
  });

  it("returns everything-null for unparseable or non-object bodies, keeping latency", () => {
    expect(parseNetworkObservation("<html>blocked</html>", 7)).toEqual({ ...UNKNOWN_NETWORK, latencyMs: 7 });
    expect(parseNetworkObservation("[1,2]", 7)).toEqual({ ...UNKNOWN_NETWORK, latencyMs: 7 });
  });

  it("never invents a value for a missing field", () => {
    expect(parseNetworkObservation("{}", null)).toEqual(UNKNOWN_NETWORK);
  });
});

describe("parseBrowserObservation", () => {
  it("maps a full reading", () => {
    expect(
      parseBrowserObservation({
        language: "de-DE",
        languages: ["de-DE", "de"],
        timezone: "Europe/Berlin",
        userAgent: "UA",
        viewport: { width: 390, height: 844 },
        geolocation: { latitude: 52.52, longitude: 13.405 },
      }),
    ).toEqual({
      language: "de-DE",
      languages: ["de-DE", "de"],
      timezone: "Europe/Berlin",
      userAgent: "UA",
      viewport: { width: 390, height: 844 },
      geolocation: { latitude: 52.52, longitude: 13.405 },
    });
  });

  it("records the headless default of a DENIED geolocation as its own state", () => {
    // Measured in EXP-000: `set geo` stores coordinates but the page still gets
    // "User denied Geolocation". That is a limitation, and it is recorded, not
    // silently turned into null-or-fine.
    expect(parseBrowserObservation({ geolocation: "denied" }).geolocation).toBe("denied");
  });

  it("treats a partial viewport or coordinate pair as unread rather than half-true", () => {
    expect(parseBrowserObservation({ viewport: { width: 390 } }).viewport).toBeNull();
    expect(parseBrowserObservation({ geolocation: { latitude: 1 } }).geolocation).toBeNull();
  });

  it("drops non-string entries from languages", () => {
    expect(parseBrowserObservation({ languages: ["nb", 5, null] }).languages).toEqual(["nb"]);
    expect(parseBrowserObservation({ languages: "nb" }).languages).toEqual([]);
  });

  it("returns everything-unread for a non-object", () => {
    expect(parseBrowserObservation("nope")).toEqual(UNKNOWN_BROWSER);
  });
});

describe("observeNetwork", () => {
  it("navigates the BROWSER to the endpoint and parses the body", async () => {
    const opened: string[] = [];
    let clock = 100;
    const runtime = fakeRuntime({
      open: (url) => {
        opened.push(url);
        clock = 150;
        return Promise.resolve(ok({ url, title: "", targetId: "", launchHash: null, browserLaunched: false }));
      },
      getText: () => Promise.resolve(ok(IPINFO_REAL)),
    });
    const out = await observeNetwork(runtime, "https://ipinfo.io/json", () => clock);
    expect(opened).toEqual(["https://ipinfo.io/json"]);
    expect(out.ip).toBe("213.52.15.251");
    expect(out.latencyMs).toBe(50);
  });

  it("returns an unread observation when navigation fails", async () => {
    const runtime = fakeRuntime({ open: () => Promise.resolve(bad()) });
    expect(await observeNetwork(runtime, "https://ipinfo.io/json")).toEqual(UNKNOWN_NETWORK);
  });

  it("keeps the measured latency when the body cannot be read", async () => {
    let clock = 0;
    const runtime = fakeRuntime({
      open: () => {
        clock = 30;
        return Promise.resolve(ok({ url: "", title: "", targetId: "", launchHash: null, browserLaunched: false }));
      },
      getText: () => Promise.resolve(bad()),
    });
    const out = await observeNetwork(runtime, "e", () => clock);
    expect(out).toEqual({ ...UNKNOWN_NETWORK, latencyMs: 30 });
  });

  it("defaults its clock to Date.now", async () => {
    const runtime = fakeRuntime({
      open: () => Promise.resolve(ok({ url: "", title: "", targetId: "", launchHash: null, browserLaunched: false })),
      getText: () => Promise.resolve(ok("{}")),
    });
    const out = await observeNetwork(runtime, "e");
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("observeBrowser", () => {
  it("evaluates the environment expression and maps the result", async () => {
    let asked = "";
    const runtime = fakeRuntime({
      evaluate: <T,>(expr: string) => {
        asked = expr;
        return Promise.resolve(ok({ language: "nb-NO", timezone: "Europe/Oslo" }) as BrowserResult<T>);
      },
    });
    const out = await observeBrowser(runtime);
    expect(asked).toBe(BROWSER_ENV_EXPRESSION);
    expect(out.language).toBe("nb-NO");
  });

  it("parses a string payload that evaluate could not decode", async () => {
    const runtime = fakeRuntime({
      evaluate: <T,>() => Promise.resolve(ok('{"language":"de-DE"}') as BrowserResult<T>),
    });
    expect((await observeBrowser(runtime)).language).toBe("de-DE");
  });

  it("returns an unread observation for unparseable text or a failed evaluate", async () => {
    const junk = fakeRuntime({ evaluate: <T,>() => Promise.resolve(ok("not json") as BrowserResult<T>) });
    expect(await observeBrowser(junk)).toEqual(UNKNOWN_BROWSER);
    const failed = fakeRuntime({ evaluate: <T,>() => Promise.resolve(bad<T>()) });
    expect(await observeBrowser(failed)).toEqual(UNKNOWN_BROWSER);
  });
});

/** A real geojs body, captured live from this machine over IPv4. */
const GEOJS_REAL = JSON.stringify({
  accuracy: 5,
  asn: 2119,
  city: "Rykkin",
  continent_code: "EU",
  country: "Norway",
  country_code: "NO",
  country_code3: "NOR",
  ip: "88.88.18.137",
  latitude: "59.9281",
  longitude: "10.4965",
  organization: "AS2119 Telenor Norge AS",
  organization_name: "Telenor Norge AS",
  region: "Viken",
  timezone: "Europe/Oslo",
});

describe("parseGeoJsObservation", () => {
  it("maps a real payload onto the same shape as the primary source", () => {
    // Same shape is the point: two sources are only comparable if they answer in
    // the same units, including ipinfo's `AS<n> <org>` rendering.
    expect(parseGeoJsObservation(GEOJS_REAL, 55)).toEqual({
      ip: "88.88.18.137",
      country: "NO",
      city: "Rykkin",
      region: "Viken",
      org: "AS2119 Telenor Norge AS",
      timezone: "Europe/Oslo",
      // geojs gives latitude and longitude as separate STRING fields, so each parser
      // normalises its own shape into the same pair.
      coordinates: [59.9281, 10.4965],
      latencyMs: 55,
    });
  });

  it("reads `organization`, not the bare `organization_name`", () => {
    const both = JSON.stringify({ organization: "AS1 Telco", organization_name: "Telco" });
    expect(parseGeoJsObservation(both, null).org).toBe("AS1 Telco");
  });

  it("returns everything-null for the HTML 404 this endpoint answers a bad path with", () => {
    // geojs has no JSON error shape — a failure is openresty HTML. Unlike
    // `ipwho.is`, which answers a spent quota with HTTP 200 and success:false, and
    // which a naive parser would read as a real "no country" reading that then
    // disagrees with every primary observation forever.
    expect(parseGeoJsObservation("<html><title>404 Not Found</title></html>", 3)).toEqual({ ...UNKNOWN_NETWORK, latencyMs: 3 });
    expect(parseGeoJsObservation("[1,2]", 3)).toEqual({ ...UNKNOWN_NETWORK, latencyMs: 3 });
  });

  it("never invents a value for a missing field", () => {
    expect(parseGeoJsObservation("{}", null)).toEqual({ ...UNKNOWN_NETWORK, latencyMs: null });
  });

  it("upper-cases the country code", () => {
    expect(parseGeoJsObservation('{"country_code":"no"}', null).country).toBe("NO");
  });
});

describe("observeNetworkVia", () => {
  it("navigates to the source's own endpoint and parses with the source's own parser", async () => {
    // The pairing is the guard: a configurable URL with a hardcoded parser reads
    // every field as null, which looks like a network problem rather than a
    // mismatched parser.
    const opened: string[] = [];
    const runtime = fakeRuntime({
      open: async (url: string) => {
        opened.push(url);
        return ok({ status: 200, url });
      },
      getText: async () => ok(GEOJS_REAL),
    } as Partial<BrowserRuntime>);
    const observation = await observeNetworkVia(runtime, GEOJS_SOURCE, () => 0);
    expect(opened).toEqual(["https://ipv4.geojs.io/v1/ip/geo.json"]);
    expect(observation.country).toBe("NO");
    expect(observation.org).toBe("AS2119 Telenor Norge AS");
  });

  it("carries the primary source's endpoint and parser too", async () => {
    const runtime = fakeRuntime({
      open: async (url: string) => ok({ status: 200, url }),
      getText: async () => ok(IPINFO_REAL),
    } as Partial<BrowserRuntime>);
    expect(IPINFO_SOURCE.endpoint).toBe("https://ipinfo.io/json");
    expect((await observeNetworkVia(runtime, IPINFO_SOURCE, () => 0)).city).toBe("Lysaker");
  });

  it("uses two DIFFERENT vendors, because two mirrors of one database would agree about being wrong", () => {
    expect(new URL(IPINFO_SOURCE.endpoint).hostname).not.toBe(new URL(GEOJS_SOURCE.endpoint).hostname);
    // HTTPS both, because the browser NAVIGATES to them.
    expect(new URL(GEOJS_SOURCE.endpoint).protocol).toBe("https:");
  });

  it("pins the corroborating source to IPv4, or it could never corroborate anything", () => {
    // Measured, not assumed. ipinfo.io publishes no AAAA record, so a dual-stack
    // corroborating host gets read over IPv6 and the two sources see two different
    // addresses — permanently `unverified`. A real Playwright run reported
    // 88.88.18.137 from ipinfo and 2001:4656:e2f2:... from the dual-stack candidate.
    expect(new URL(GEOJS_SOURCE.endpoint).hostname.startsWith("ipv4.")).toBe(true);
  });
});

describe("parseLoc rejects what a third party might send", () => {
  /**
   * Every guard here, because these coordinates decide a CITY VERDICT by distance.
   *
   * `loc` arrives from an IP-geo vendor, so malformed input is not hypothetical — and the
   * failure mode is the worst kind: `Number("")` is 0, so a blank field parses to the Gulf of
   * Guinea at 0,0. That is 5,000km from Oslo, which would report a correctly-routed Norwegian
   * exit as a proven city MISMATCH — a confident wrong answer about somebody's vendor.
   */
  it("accepts a well-formed pair", () => {
    expect(parseLoc("59.9139,10.7522")).toEqual([59.9139, 10.7522]);
    expect(parseLoc("-33.87,151.21")).toEqual([-33.87, 151.21]);
  });

  it("rejects anything that is not a string", () => {
    for (const value of [undefined, null, 59.9139, {}, ["59", "10"]]) expect(parseLoc(value)).toBeNull();
  });

  it("rejects a wrong number of parts, rather than reading the first two", () => {
    // "59.9139" alone would otherwise become [59.9139, NaN]; a three-part value is a format
    // this code does not understand, and guessing which two to keep is how a silent wrong
    // answer starts.
    expect(parseLoc("59.9139")).toBeNull();
    expect(parseLoc("59.9139,10.7522,100")).toBeNull();
    expect(parseLoc("")).toBeNull();
  });

  it("rejects non-numeric parts INCLUDING the empty string", () => {
    // The one that matters most: `Number("")` is 0, not NaN. Without `Number.isFinite` a blank
    // half would place the exit on the equator or the prime meridian.
    expect(parseLoc("59.9139,")).toBeNull();
    expect(parseLoc(",10.7522")).toBeNull();
    expect(parseLoc("north,east")).toBeNull();
    expect(parseLoc("Infinity,10")).toBeNull();
  });

  it("rejects coordinates outside the earth", () => {
    // A latitude of 91 parses fine and cannot exist. Passing it on would compute a distance to
    // a place that is not anywhere.
    expect(parseLoc("91,10")).toBeNull();
    expect(parseLoc("-91,10")).toBeNull();
    expect(parseLoc("59,181")).toBeNull();
    expect(parseLoc("59,-181")).toBeNull();
    // The boundaries themselves are valid — the poles and the antimeridian are real places.
    expect(parseLoc("90,180")).toEqual([90, 180]);
    expect(parseLoc("-90,-180")).toEqual([-90, -180]);
  });
});
