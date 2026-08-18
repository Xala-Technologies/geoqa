import { describe, expect, it } from "vitest";
import { buildSettings, sharedCredentials, type SettingsInput } from "../settings.js";
import type { Tenant } from "../../tenant/types.js";

const tenant = (over: Partial<Tenant> = {}): Tenant => ({
  id: "digilist",
  name: "Digilist AS",
  markets: ["oslo", "bergen"],
  targets: ["https://digilist.no"],
  proxyCredentials: null,
  proxySubUser: "GEOQA_SUBUSER_DIGILIST",
  quota: { trafficMb: 5000, runsPerDay: 200 },
  retentionDays: 30,
  ...over,
});

const input = (over: Partial<SettingsInput> = {}): SettingsInput => ({
  tenants: [tenant()],
  markets: ["oslo", "bergen"],
  journeys: [{ id: "landing-page", title: "Landing page validation", writes: false, requiredVars: [] }],
  config: {
    network: { provider: "direct", verifyEndpoint: "https://ipinfo.io/json", cooldownMs: 3_600_000 },
    browser: {},
    evidence: { root: "evidence", retention: { pass: ["metadata"], warning: [], fail: [], investigation: [] } },
  } as unknown as SettingsInput["config"],
  configSource: "built-in defaults",
  evidenceRoot: "/e",
  env: {},
  ...over,
});

describe("buildSettings never exposes a credential", () => {
  it("reports PRESENCE and never a value, even when the variable is set", () => {
    // The rule the whole file exists for. A tenant stores the NAME of a variable, never a
    // secret (R-26), and a settings page that echoed the value would move a credential from a
    // host into a browser, a proxy log and a screenshot.
    const secret = "user:hunter2@gw.example:7777";
    const out = buildSettings(input({ env: { GEOQA_SUBUSER_DIGILIST: secret, GEOQA_PROXY_TEMPLATE: secret } }));
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain("hunter2");
    expect(serialised).not.toContain(secret);
    // The NAME is public — it is written in a checked-in tenant file — and is what an operator
    // needs in order to set it.
    expect(serialised).toContain("GEOQA_SUBUSER_DIGILIST");
    expect(out.tenants[0]?.credentials[0]?.present).toBe(true);
  });

  it("distinguishes a variable set to EMPTY from one never set", () => {
    // Different problems with different fixes: one person typed nothing, the other typed
    // nothing at all. Reporting both as absent sends an operator to fix the wrong one.
    const set = buildSettings(input({ env: { GEOQA_SUBUSER_DIGILIST: "" } }));
    const unset = buildSettings(input({ env: {} }));
    expect(set.tenants[0]?.credentials[0]?.present).toBe(true);
    expect(unset.tenants[0]?.credentials[0]?.present).toBe(false);
  });

  it("says every credential is missing when the environment is empty", () => {
    const out = buildSettings(input());
    expect(out.credentials.every((c) => !c.present)).toBe(true);
    expect(out.tenants[0]?.credentials.every((c) => !c.present)).toBe(true);
  });
});

describe("metering honesty", () => {
  it("is NOT meterable when the tenant shares the default account", () => {
    // The vendor reports one figure for every tenant on an account, so attributing it to one
    // would be a fabrication. Unmeasurable, not unlimited.
    const out = buildSettings(input({ tenants: [tenant({ proxySubUser: null })] }));
    expect(out.tenants[0]?.meterable).toBe(false);
  });

  it("is NOT meterable when the sub-user variable is named but unset", () => {
    // Naming a variable is an intention; setting it is the fact. Only the second meters.
    expect(buildSettings(input()).tenants[0]?.meterable).toBe(false);
  });

  it("is meterable only when the variable is both named and set", () => {
    const out = buildSettings(input({ env: { GEOQA_SUBUSER_DIGILIST: "sub-1" } }));
    expect(out.tenants[0]?.meterable).toBe(true);
  });
});

describe("what the page shows", () => {
  it("carries the tenant's domains, quota and retention", () => {
    const out = buildSettings(input());
    expect(out.tenants[0]?.targets).toEqual(["https://digilist.no"]);
    expect(out.tenants[0]?.quota).toEqual({ trafficMb: 5000, runsPerDay: 200 });
    expect(out.tenants[0]?.retentionDays).toBe(30);
  });

  it("lists a tenant's OWN proxy credentials when it has them", () => {
    const out = buildSettings(input({ tenants: [tenant({ proxyCredentials: "GEOQA_PROXY_DIGILIST" })] }));
    expect(out.tenants[0]?.credentials.map((c) => c.name)).toContain("GEOQA_PROXY_DIGILIST");
  });

  it("lists the shared template and login vars, not one fake secret per city", () => {
    const empty = sharedCredentials({});
    expect(empty.map((c) => c.name)).toEqual([
      "GEOQA_PROXY_TEMPLATE",
      "GEOQA_LOGIN_EMAIL",
      "AGENTMAIL_API_KEY",
      "DECODO_API_KEY",
      "GEOQA_GITHUB_TOKEN",
      "GEOQA_GITHUB_REPO",
    ]);
    expect(empty.every((c) => !c.present)).toBe(true);
    const set = sharedCredentials({ GEOQA_PROXY_TEMPLATE: "http://u:p@gw:1", GEOQA_PROXY_OSLO: "http://override" });
    expect(set.find((c) => c.name === "GEOQA_PROXY_TEMPLATE")?.present).toBe(true);
    expect(set.find((c) => c.name === "GEOQA_PROXY_OSLO")).toEqual({
      name: "GEOQA_PROXY_OSLO",
      present: true,
      purpose: "override for one market or country — city still works from the template without this",
    });
    expect(set.some((c) => c.name === "GEOQA_PROXY_BERGEN")).toBe(false);
  });

  it("reports which config file is in force, so a run on defaults is not mistaken for one that honoured it", () => {
    const out = buildSettings(input({ configSource: "/repo/geoqa.config.json" }));
    expect(out.config.source).toBe("/repo/geoqa.config.json");
    expect(out.config.provider).toBe("direct");
  });
});
