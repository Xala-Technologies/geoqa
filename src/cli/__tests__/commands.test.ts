import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoQaRunResult } from "../../findings/types.js";
import type { ExecuteOptions } from "../../run/execute.js";
import { fakeRuntime, bad, ok } from "../../run/__tests__/fake-runtime.js";
import {
  browserVerify,
  defaultDeps,
  evidenceInspect,
  experimentRun,
  journeyList,
  journeyPath,
  journeyRun,
  loadProfileOrThrow,
  profileList,
  profilePath,
  proxyVerify,
  renderRunResult,
  type CommandDeps,
} from "../commands.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let evidenceRoot: string;
beforeEach(() => {
  evidenceRoot = mkdtempSync(path.join(tmpdir(), "geoqa-cmd-"));
});
afterEach(() => {
  rmSync(evidenceRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const deps = (over: Partial<CommandDeps> = {}): CommandDeps =>
  defaultDeps(repoRoot, {
    evidenceRoot,
    env: {},
    now: () => 1_000,
    log: () => {},
    makeRuntime: () => fakeRuntime(),
    probe: () => Promise.resolve(true),
    ...over,
  });

describe("defaultDeps", () => {
  it("builds real defaults when nothing is overridden", () => {
    const d = defaultDeps(repoRoot);
    expect(d.repoRoot).toBe(repoRoot);
    expect(d.evidenceRoot).toBe(path.join(repoRoot, "evidence"));
    expect(typeof d.now()).toBe("number");
    expect(d.makeRuntime({ sessionId: "s" }).sessionId).toBe("s");
    // The default logger writes to stderr so `--json` on stdout stays clean.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    d.log("hello");
    expect(spy).toHaveBeenCalledWith("hello");
  });
});

describe("path helpers", () => {
  it("appends .yaml only when it is missing", () => {
    expect(profilePath(deps(), "oslo-mobile")).toMatch(/profiles\/oslo-mobile\.yaml$/);
    expect(profilePath(deps(), "oslo-mobile.yaml")).toMatch(/profiles\/oslo-mobile\.yaml$/);
    expect(journeyPath(deps(), "landing-page")).toMatch(/journeys\/landing-page\.yaml$/);
    expect(journeyPath(deps(), "landing-page.yaml")).toMatch(/journeys\/landing-page\.yaml$/);
  });

  it("throws a named error for a missing profile", () => {
    expect(() => loadProfileOrThrow(deps(), "atlantis")).toThrow(/profile "atlantis"/);
  });
});

describe("list commands", () => {
  it("lists the shipped profiles with their market and device", () => {
    const { profiles } = profileList(deps());
    expect(profiles.map((p) => p.id)).toEqual(["berlin-mobile", "oslo-desktop", "oslo-mobile", "stockholm-mobile"]);
    expect(profiles.find((p) => p.id === "oslo-mobile")).toMatchObject({ country: "NO", city: "Oslo", device: "mobile" });
  });

  it("lists the shipped journeys with their step counts", () => {
    const { journeys } = journeyList(deps());
    expect(journeys.map((j) => j.id)).toContain("landing-page");
    expect(journeys.every((j) => j.steps > 0)).toBe(true);
  });

  it("marks an invalid file INVALID rather than throwing the whole listing away", () => {
    const brokenRoot = mkdtempSync(path.join(tmpdir(), "geoqa-broken-"));
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(path.join(brokenRoot, "profiles"), { recursive: true });
    mkdirSync(path.join(brokenRoot, "journeys"), { recursive: true });
    writeFileSync(path.join(brokenRoot, "profiles", "bad.yaml"), "id: x\n");
    writeFileSync(path.join(brokenRoot, "journeys", "bad.yaml"), "id: x\n");
    const d = deps({ repoRoot: brokenRoot });
    expect(profileList(d).profiles[0]?.label).toContain("INVALID");
    expect(journeyList(d).journeys[0]?.title).toContain("INVALID");
    rmSync(brokenRoot, { recursive: true, force: true });
  });
});

describe("browserVerify", () => {
  it("proves each primitive by USING it", () => {
    return browserVerify(deps()).then((result) => {
      expect(result.total).toBe(10);
      expect(result.passed).toBe(10);
      expect(result.launchHash).toBe("h");
      expect(result.primitives.map((p) => p.name)).toContain("vitals");
    });
  });

  it("records a failing primitive without aborting the rest", async () => {
    const result = await browserVerify(
      deps({ makeRuntime: () => fakeRuntime({ a11y: () => Promise.resolve(bad()) }) }),
    );
    expect(result.passed).toBe(9);
    expect(result.primitives.find((p) => p.name === "a11y")).toMatchObject({ ok: false, detail: "nope" });
  });

  it("counts an empty title or snapshot as a FAILED primitive, not a passing one", async () => {
    const result = await browserVerify(
      deps({
        makeRuntime: () =>
          fakeRuntime({ getTitle: () => Promise.resolve(ok("")), snapshot: () => Promise.resolve(ok("")) }),
      }),
    );
    expect(result.primitives.find((p) => p.name === "get-title")?.ok).toBe(false);
    expect(result.primitives.find((p) => p.name === "snapshot")?.ok).toBe(false);
  });

  it("records a THROWN primitive rather than failing the command", async () => {
    const result = await browserVerify(
      deps({
        makeRuntime: () =>
          fakeRuntime({
            console: () => {
              throw new Error("exploded");
            },
          }),
      }),
    );
    expect(result.primitives.find((p) => p.name === "console")).toMatchObject({ ok: false, detail: "exploded" });
  });

  it("leaves the launch hash null when open failed", async () => {
    const result = await browserVerify(deps({ makeRuntime: () => fakeRuntime({ open: () => Promise.resolve(bad()) }) }));
    expect(result.launchHash).toBeNull();
  });
});

describe("proxyVerify", () => {
  it("reports both axes and warns that direct egress is not geographic", async () => {
    const result = await proxyVerify(deps(), { profileId: "oslo-mobile" });
    expect(result.provider).toBe("direct");
    expect(result.proxy).toBeNull();
    expect(result.verification.network.country.verdict).toBe("match");
    expect(result.verification.network.city.verdict).toBe("unverified");
    expect(result.warnings.join(" ")).toContain("egress is DIRECT");
  });

  it("REDACTS the proxy URL it reports", async () => {
    const result = await proxyVerify(
      deps({ env: { GEOQA_PROXY_NO: "http://user:s3cret@gw.io:7777" } }),
      { profileId: "oslo-mobile", providerName: "http-proxy" },
    );
    expect(result.proxy).not.toContain("s3cret");
    expect(result.proxy).toContain("gw.io");
  });

  it("warns loudly about an unknown provider name and falls back to direct", async () => {
    const result = await proxyVerify(deps(), { profileId: "oslo-mobile", providerName: "magic" });
    expect(result.warnings.join(" ")).toContain("NOT geographic");
  });

  it("refuses when the provider cannot serve the market", async () => {
    await expect(
      proxyVerify(deps({ env: { GEOQA_PROXY_SE: "http://gw:1" } }), {
        profileId: "oslo-mobile",
        providerName: "http-proxy",
      }),
    ).rejects.toThrow(/could not open a network session/);
  });
});

describe("journeyRun", () => {
  it("prepares, runs and returns the warnings alongside the result", async () => {
    const logged: string[] = [];
    const runOnce = vi.fn(async () => ({ runId: "run_1", verdict: "PASS" }) as GeoQaRunResult);
    const result = await journeyRun(deps({ log: (l) => logged.push(l), runOnce }), {
      url: "https://digilist.no",
      profileId: "oslo-mobile",
      journeyId: "landing-page",
    });
    expect(result.verdict).toBe("PASS");
    expect(result.warnings.join(" ")).toContain("egress is DIRECT");
    expect(logged.join(" ")).toContain("warning:");
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("passes variables and the headed flag through to the spec", async () => {
    let captured: ExecuteOptions | null = null;
    const runOnce = vi.fn(async (o: ExecuteOptions) => {
      captured = o;
      return { runId: "r", verdict: "PASS" } as GeoQaRunResult;
    });
    await journeyRun(deps({ runOnce }), {
      url: "https://x",
      profileId: "oslo-mobile",
      journeyId: "localization",
      vars: { forbiddenCurrency: "EUR" },
      headed: true,
    });
    const spec = (captured as ExecuteOptions | null)?.spec;
    expect(spec?.vars).toEqual({ forbiddenCurrency: "EUR" });
    expect(spec?.headed).toBe(true);
    expect(spec?.target).toBe("https://x");
  });
});

describe("evidenceInspect", () => {
  it("reads a manifest a run wrote", async () => {
    const runOnce = vi.fn(async () => ({ runId: "run_1", verdict: "PASS" }) as GeoQaRunResult);
    await journeyRun(deps({ runOnce }), { url: "https://x", profileId: "oslo-mobile", journeyId: "landing-page" });
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(path.join(evidenceRoot, "run_x"), { recursive: true });
    writeFileSync(path.join(evidenceRoot, "run_x", "manifest.json"), JSON.stringify({ evidenceId: "ev_x", tier: "pass" }));
    expect(evidenceInspect(deps(), "run_x").manifest).toMatchObject({ evidenceId: "ev_x" });
  });

  it("says which directory it looked in when there is no manifest", () => {
    expect(() => evidenceInspect(deps(), "run_missing")).toThrow(new RegExp(evidenceRoot));
  });
});

describe("experimentRun", () => {
  const sampler = async (): Promise<Record<string, unknown>> => ({ ok: true });
  const summariser = () => ({
    metrics: [
      { key: "connection-success", description: "d", value: 100, target: 97, unit: "percent" as const, direction: "min" as const, verdict: "pass" as const, reason: "100%" },
    ],
    notes: ["a note"],
  });

  it("writes results.jsonl and summary.json under the experiment id", async () => {
    const d = deps({ repoRoot: evidenceRoot });
    const result = await experimentRun(
      d,
      { id: "EXP-001", samples: 3, profileId: "oslo-mobile", url: "https://x" },
      sampler,
      summariser,
    );
    expect(result.summary.samples).toBe(3);
    expect(readFileSync(result.paths.results, "utf8").trim().split("\n")).toHaveLength(3);
    expect(JSON.parse(readFileSync(result.paths.summary, "utf8")).verdict).toBe("pass");
    expect(result.rendered).toContain("EXP-001-geo-ip");
  });

  it("writes each sample AS IT HAPPENS, so a killed run keeps what it measured", async () => {
    const d = deps({ repoRoot: evidenceRoot });
    const seen: string[] = [];
    let paths = "";
    await experimentRun(
      { ...d, log: (l) => seen.push(l) },
      { id: "EXP-001", samples: 2, profileId: "oslo-mobile", url: "https://x" },
      async (deps2, o, i) => {
        if (i === 1) {
          // By now sample 0 must already be on disk.
          paths = readFileSync(path.join(evidenceRoot, "experiments", "EXP-001-geo-ip", "results.jsonl"), "utf8");
        }
        return { i };
      },
      summariser,
    );
    expect(paths.trim().split("\n")).toHaveLength(1);
    expect(seen.join(" ")).toContain("sample 1/2");
  });

  it("rejects an unknown experiment id", async () => {
    await expect(
      experimentRun(deps(), { id: "EXP-999", samples: 1, profileId: "p", url: "u" }, sampler, summariser),
    ).rejects.toThrow(/unknown experiment/);
  });
});

describe("renderRunResult", () => {
  const result = (over: Partial<GeoQaRunResult> = {}): GeoQaRunResult =>
    ({
      runId: "run_1",
      target: "https://digilist.no",
      profileId: "oslo-mobile",
      verdict: "PASS_WITH_WARNINGS",
      confidence: { geo: 85, browser: 100, journey: 100, evidence: 100, searchObservation: null, overall: 91, notes: ["a note"] },
      findings: [],
      evidenceId: "ev_1",
      ...over,
    }) as GeoQaRunResult;

  it("renders the verdict, confidence line, notes and evidence id", () => {
    const rendered = renderRunResult(result());
    expect(rendered).toContain("PASS_WITH_WARNINGS — https://digilist.no via oslo-mobile");
    expect(rendered).toContain("overall 91");
    expect(rendered).toContain("· a note");
    expect(rendered).toContain("evidence: ev_1");
  });

  it("lists up to ten findings and counts the rest", () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({
      severity: "low", title: `f${i}`, expected: "e", observed: "o",
    })) as GeoQaRunResult["findings"];
    const rendered = renderRunResult(result({ findings }));
    expect(rendered).toContain("[low] f0");
    expect(rendered).toContain("and 2 more");
  });

  it("omits the evidence line when nothing was captured", () => {
    expect(renderRunResult(result({ evidenceId: null }))).not.toContain("evidence:");
  });
});
