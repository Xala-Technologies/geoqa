import { describe, expect, it } from "vitest";
import type { BrowserResult, BrowserRuntime } from "../../browser/types.js";
import {
  BROWSER_ENV_EXPRESSION,
  UNKNOWN_BROWSER,
  UNKNOWN_NETWORK,
  observeBrowser,
  observeNetwork,
  parseBrowserObservation,
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
