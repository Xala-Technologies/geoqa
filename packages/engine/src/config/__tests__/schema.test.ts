import { describe, expect, it } from "vitest";
import { RETENTION } from "../../evidence/manifest.js";
import { DEFAULT_VERIFY_ENDPOINT } from "../../geo/observe.js";
import { DEFAULT_COOLDOWN_MS } from "../../network/provider.js";
import {
  DEFAULT_EVIDENCE_DIRNAME,
  DEFAULT_PROVIDER,
  defaultConfig,
  findCredentialKeys,
  parseConfig,
} from "../schema.js";

/** The smallest document the schema accepts: nothing set, everything defaulted. */
const empty = {};

describe("defaults", () => {
  it("takes every default from the constant the running code already uses, so a moved constant cannot leave the config serving a stale number", () => {
    const config = defaultConfig();
    expect(config.network.provider).toBe(DEFAULT_PROVIDER);
    expect(config.network.verifyEndpoint).toBe(DEFAULT_VERIFY_ENDPOINT);
    expect(config.network.cooldownMs).toBe(DEFAULT_COOLDOWN_MS);
    expect(config.evidence.root).toBe(DEFAULT_EVIDENCE_DIRNAME);
    expect(config.evidence.retention).toEqual(RETENTION);
  });

  it("LEAVES the browser timeouts unset rather than restating exec.ts's private defaults as a second source of truth", () => {
    expect(defaultConfig().browser).toEqual({});
    expect("commandTimeoutMs" in defaultConfig().browser).toBe(false);
  });

  it("hands out a COPY of the retention table, so a caller narrowing a tier cannot narrow what every later run in the process collects", () => {
    const config = defaultConfig();
    config.evidence.retention.fail.length = 0;
    expect(RETENTION.fail.length).toBeGreaterThan(0);
    expect(defaultConfig().evidence.retention.fail).toEqual(RETENTION.fail);
  });

  it("resolves an empty document to exactly the defaults, because a config file that sets nothing must behave like no config file", () => {
    const parsed = parseConfig(empty);
    expect(parsed.ok && parsed.value).toEqual(defaultConfig());
  });
});

describe("honouring what the file says", () => {
  it("returns each value the file set, which is the entire point of the loader existing", () => {
    const parsed = parseConfig({
      network: { provider: "http-proxy", verifyEndpoint: "http://127.0.0.1:8181/ipinfo", cooldownMs: 1_000 },
      browser: { commandTimeoutMs: 5_000, idleTimeoutMs: 2_500 },
      evidence: { root: "artifacts" },
    });
    expect(parsed.ok && parsed.value.network).toEqual({
      provider: "http-proxy",
      verifyEndpoint: "http://127.0.0.1:8181/ipinfo",
      cooldownMs: 1_000,
    });
    expect(parsed.ok && parsed.value.browser).toEqual({ commandTimeoutMs: 5_000, idleTimeoutMs: 2_500 });
    expect(parsed.ok && parsed.value.evidence.root).toBe("artifacts");
  });

  it("passes a relative evidence root through VERBATIM, because this module does not know the repo root and a guessed one writes evidence where nobody looks", () => {
    const parsed = parseConfig({ evidence: { root: "./out/evidence" } });
    expect(parsed.ok && parsed.value.evidence.root).toBe("./out/evidence");
  });

  it("REPLACES a named retention tier and leaves every unnamed tier at its default, so a tier can be narrowed as well as widened", () => {
    const parsed = parseConfig({ evidence: { retention: { pass: ["metadata"] } } });
    expect(parsed.ok && parsed.value.evidence.retention.pass).toEqual(["metadata"]);
    expect(parsed.ok && parsed.value.evidence.retention.fail).toEqual(RETENTION.fail);
  });

  it("accepts an override for every retention tier the manifest defines, including `investigation`", () => {
    const parsed = parseConfig({
      evidence: {
        retention: {
          pass: ["metadata"],
          warning: ["metadata", "console"],
          fail: ["metadata", "trace"],
          investigation: ["metadata", "a11y"],
        },
      },
    });
    expect(parsed.ok && parsed.value.evidence.retention).toEqual({
      pass: ["metadata"],
      warning: ["metadata", "console"],
      fail: ["metadata", "trace"],
      investigation: ["metadata", "a11y"],
    });
  });

  it("does not let a retention override alias the file's own array, so mutating the config cannot rewrite what was validated", () => {
    const document = { evidence: { retention: { pass: ["metadata", "vitals"] } } };
    const parsed = parseConfig(document);
    if (!parsed.ok) throw new Error("expected a valid config");
    parsed.value.evidence.retention.pass.push("a11y");
    expect(document.evidence.retention.pass).toEqual(["metadata", "vitals"]);
  });

  it("accepts $comment as a string or a list of lines at every level, since rationale nobody can read is rationale nobody keeps current", () => {
    const parsed = parseConfig({
      $comment: ["line one", "line two"],
      network: { $comment: "why direct", provider: "direct" },
      browser: { $comment: "why slow" },
      evidence: { $comment: "why here", retention: { $comment: "why wide", pass: ["metadata"] } },
    });
    expect(parsed.ok).toBe(true);
  });
});

describe("refusing what it cannot honour", () => {
  it("REJECTS an unknown key rather than ignoring it — a dropped typo is the same silent failure as a config nothing reads", () => {
    const parsed = parseConfig({ network: { verifyEndoint: "https://example.com/json" } });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.errors.join("\n")).toContain("verifyEndoint");
  });

  it("REJECTS a key the design deliberately does not have, so `markets` cannot look configured while profiles stay self-contained", () => {
    const parsed = parseConfig({ markets: [{ id: "oslo" }], site: { id: "digilist" }, run: { readOnly: true } });
    expect(parsed.ok).toBe(false);
    const errors = !parsed.ok ? parsed.errors.join("\n") : "";
    expect(errors).toContain("markets");
    expect(errors).toContain("site");
    expect(errors).toContain("run");
  });

  it("names the offending path in every message, because the reader's next action is to open the file at that key", () => {
    const parsed = parseConfig({ network: { cooldownMs: "an hour" } });
    expect(!parsed.ok && parsed.errors[0]).toContain("network.cooldownMs");
  });

  it("REFUSES an unknown provider name instead of falling back to direct, because a run that quietly egresses from this machine while claiming Berlin is the worst output available", () => {
    const parsed = parseConfig({ network: { provider: "residential-magic" } });
    expect(parsed.ok).toBe(false);
  });

  it("REFUSES a verify endpoint the page cannot fetch, since a bad scheme would not fail loudly — it would make the network axis unverified", () => {
    const parsed = parseConfig({ network: { verifyEndpoint: "ftp://example.com/json" } });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.errors[0]).toContain("http(s)");
  });

  it("REFUSES a zero cooldown, which records a cooldown already expired and is indistinguishable from a provider that never failed", () => {
    expect(parseConfig({ network: { cooldownMs: 0 } }).ok).toBe(false);
  });

  it("REFUSES a zero timeout, because it uncaps the wall clock and an uncapped run does not fail — it hangs, and reports nothing at all", () => {
    expect(parseConfig({ browser: { commandTimeoutMs: 0 } }).ok).toBe(false);
    expect(parseConfig({ browser: { idleTimeoutMs: -1 } }).ok).toBe(false);
  });

  it("REFUSES an empty retention tier, which would divide by zero in completenessOf and report NaN completeness", () => {
    const parsed = parseConfig({ evidence: { retention: { pass: [] } } });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.errors[0]).toContain("at least one artifact kind");
  });

  it("REFUSES an artifact kind the manifest does not define, so a tier cannot list evidence the engine will never produce", () => {
    expect(parseConfig({ evidence: { retention: { fail: ["heatmap"] } } }).ok).toBe(false);
  });

  it("REFUSES a document that is not an object at all", () => {
    expect(parseConfig(["network"]).ok).toBe(false);
    expect(parseConfig("network").ok).toBe(false);
    expect(parseConfig(null).ok).toBe(false);
  });
});

describe("credentials", () => {
  it("REFUSES a credential-shaped key and says where the value belongs, because 'unrecognized key' invites the reader to try harder instead of using the environment", () => {
    const parsed = parseConfig({ network: { provider: "http-proxy", proxyUrl: "http://u:p@proxy.example:8080" } });
    expect(parsed.ok).toBe(false);
    const message = !parsed.ok ? (parsed.errors[0] ?? "") : "";
    expect(message).toContain("network.proxyUrl");
    expect(message).toContain("GEOQA_PROXY_<MARKET>");
  });

  it("catches a credential key wherever it is buried, since the wrong place to put a password is every place", () => {
    const errors = findCredentialKeys({ evidence: { retention: { pass: [{ apiKey: "x" }] } } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("evidence.retention.pass.0.apiKey");
  });

  it("catches every spelling of the same mistake — separators, case and prefixes all collapse to one shape", () => {
    for (const key of ["password", "proxy_password", "PROXY-URL", "apiKey", "authorization", "bearerToken", "cookie", "login", "username", "clientSecret"]) {
      expect(findCredentialKeys({ [key]: "value" }), key).toHaveLength(1);
    }
  });

  it("inherits the redactor's own sensitive-key list rather than keeping a second copy that can drift from it", () => {
    // `personnummer` is in evidence/redact.ts's list and in no list here.
    expect(findCredentialKeys({ personnummer: "01019012345" })).toHaveLength(1);
  });

  it("does not recurse into a rejected subtree, so one clear 'this does not belong here' is not buried under its own children", () => {
    expect(findCredentialKeys({ proxy: { username: "u", password: "p" } })).toEqual([
      expect.stringContaining("proxy:"),
    ]);
  });

  it("does NOT mistake a legitimate key for a credential — `evidence.retention.pass` must survive a guard aimed at `password`", () => {
    expect(
      findCredentialKeys({
        network: { provider: "direct", verifyEndpoint: "https://x/json", cooldownMs: 1 },
        browser: { commandTimeoutMs: 1, idleTimeoutMs: 1 },
        evidence: { root: "evidence", retention: { pass: ["metadata"], warning: [], fail: [], investigation: [] } },
        $comment: "prose",
      }),
    ).toEqual([]);
  });

  it("reports a credential BEFORE any schema complaint, so the message the user reads is the one that says where the value goes", () => {
    const parsed = parseConfig({ nonsense: 1, network: { proxyPassword: "p" } });
    expect(!parsed.ok && parsed.errors.every((e) => e.includes("GEOQA_PROXY_<MARKET>"))).toBe(true);
  });
});
