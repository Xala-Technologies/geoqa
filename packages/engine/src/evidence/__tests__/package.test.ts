import { describe, expect, it } from "vitest";
import {
  evidenceRunDir,
  loadEvidencePackage,
  loadEvidenceShot,
  parseEvidencePackage,
  readJourneyFromRunJson,
  type PackageFs,
} from "../package.js";

const runJson = {
  runId: "run_1786798894551_bergen-mobile",
  target: "https://digilist.no/",
  journey: {
    id: "browse",
    verdict: "PASS",
    seed: 7,
    writes: false,
    steps: [
      {
        index: 0,
        action: "open",
        label: "open target",
        outcome: "passed",
        detail: "open https://digilist.no/ ok",
        expected: null,
        observed: "https://digilist.no/",
        durationMs: 1200,
      },
      {
        index: 1,
        action: "click",
        label: "open the first result",
        outcome: "passed",
        detail: "click #results a ok",
        expected: null,
        observed: "https://digilist.no/cases/1",
        durationMs: 400,
      },
      {
        index: 2,
        action: "screenshot",
        label: "landing",
        outcome: "passed",
        detail: "screenshot landing ok",
        expected: null,
        observed: null,
        durationMs: 80,
      },
      {
        index: 3,
        action: "screenshot",
        label: "after-scroll",
        outcome: "passed",
        detail: "screenshot after-scroll ok",
        expected: null,
        observed: null,
        durationMs: 70,
      },
    ],
  },
};

describe("parseEvidencePackage", () => {
  it("reads the step log and the screenshots that actually landed", () => {
    const pack = parseEvidencePackage(runJson, ["run.json", "landing.png", "manifest.json"]);
    expect(pack).not.toBeNull();
    expect(pack?.steps).toHaveLength(4);
    expect(pack?.steps[1]).toMatchObject({
      action: "click",
      label: "open the first result",
      detail: "click #results a ok",
      observed: "https://digilist.no/cases/1",
    });
    expect(pack?.screenshots).toEqual([
      { label: "after-scroll", file: "after-scroll.png", present: false },
      { label: "landing", file: "landing.png", present: true },
    ]);
  });

  it("lists every PNG in the folder as a still, not only explicit screenshot steps", () => {
    const pack = parseEvidencePackage(runJson, ["run.json", "landing.png", "00-open-target.png"]);
    expect(pack?.screenshots.map((s) => s.label)).toEqual(["00-open-target", "after-scroll", "landing"]);
    expect(pack?.screenshots.find((s) => s.label === "00-open-target")?.present).toBe(true);
  });

  it("returns null rather than inventing a package from junk", () => {
    expect(parseEvidencePackage(null, [])).toBeNull();
    expect(parseEvidencePackage({ runId: "run_1" }, [])).toBeNull();
    expect(parseEvidencePackage({ runId: "run_1", target: "https://x", journey: {} }, [])).toBeNull();
  });
});

describe("evidenceRunDir — a path that escapes the root is a security defect", () => {
  it("accepts a real run id and refuses a traversal", () => {
    expect(evidenceRunDir("/e", "run_1786798894551_bergen-mobile")).toBe("/e/run_1786798894551_bergen-mobile");
    expect(evidenceRunDir("/e", "../etc")).toBeNull();
    expect(evidenceRunDir("/e", "run_1/../secrets")).toBeNull();
    expect(evidenceRunDir("/e", "/etc/passwd")).toBeNull();
    expect(evidenceRunDir("/e", "not-a-run")).toBeNull();
  });
});

const fsFor = (files: Record<string, string | Buffer>): PackageFs => ({
  readText: (p) => {
    const v = files[p];
    if (v === undefined) throw new Error(`missing ${p}`);
    return typeof v === "string" ? v : v.toString("utf8");
  },
  exists: (p) => p in files,
  list: (dir) =>
    Object.keys(files)
      .filter((p) => p.startsWith(`${dir}/`))
      .map((p) => p.slice(dir.length + 1)),
  readBytes: (p) => {
    const v = files[p];
    if (v === undefined) throw new Error(`missing ${p}`);
    return typeof v === "string" ? Buffer.from(v) : v;
  },
});

describe("readJourneyFromRunJson", () => {
  it("reads the step log from run.json so a dashboard does not need a second request", () => {
    const root = "/e";
    const id = "run_1786798894551_bergen-mobile";
    const fs = {
      exists: (p: string) => p === `${root}/${id}/run.json` || p === `${root}/${id}/landing.png`,
      read: () => JSON.stringify(runJson),
    };
    const pack = readJourneyFromRunJson(root, id, fs);
    expect(pack?.steps).toHaveLength(4);
    expect(pack?.screenshots).toEqual([
      { label: "after-scroll", file: "after-scroll.png", present: false },
      { label: "landing", file: "landing.png", present: true },
    ]);
  });

  it("returns null when there is no run.json, rather than inventing a journey", () => {
    expect(readJourneyFromRunJson("/e", "run_1_x", { exists: () => false, read: () => "" })).toBeNull();
  });
});

describe("loadEvidencePackage", () => {
  it("loads a package from the run directory, and names a missing one", () => {
    const root = "/e";
    const id = "run_1786798894551_bergen-mobile";
    const dir = `${root}/${id}`;
    const fs = fsFor({
      [`${dir}/run.json`]: JSON.stringify(runJson),
      [`${dir}/landing.png`]: Buffer.from([0x89, 0x50]),
    });
    const loaded = loadEvidencePackage(root, id, fs);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.journeyId).toBe("browse");
      expect(loaded.value.screenshots.some((s) => s.label === "landing" && s.present)).toBe(true);
      expect(loaded.value.issues).toEqual([]);
      expect(loaded.value.console).toEqual([]);
      expect(loaded.value.brief).toContain("browse");
    }
    expect(loadEvidencePackage(root, "run_missing_x", fs).ok).toBe(false);
    expect(loadEvidencePackage(root, "../etc", fs).ok).toBe(false);
  });

  it("attaches the page console and a failed step so a ticket can be written", () => {
    const root = "/e";
    const id = "run_1786798894551_bergen-mobile";
    const dir = `${root}/${id}`;
    const failed = {
      ...runJson,
      journey: {
        ...runJson.journey,
        verdict: "FAIL",
        steps: [
          ...runJson.journey.steps,
          {
            index: 4,
            action: "assert",
            label: "cls-below",
            outcome: "failed",
            severity: "medium",
            detail: "cls-below: expected CLS below 0.1, observed 0.12",
            expected: "CLS < 0.1",
            observed: "0.12",
            durationMs: 10,
          },
        ],
      },
    };
    const fs = fsFor({
      [`${dir}/run.json`]: JSON.stringify(failed),
      [`${dir}/console.json`]: JSON.stringify([{ type: "error", text: "boom" }]),
    });
    const loaded = loadEvidencePackage(root, id, fs);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error("expected a package");
    expect(loaded.value.issues[0]?.reason).toContain("CLS < 0.1");
    expect(loaded.value.console).toEqual([{ type: "error", text: "boom" }]);
    expect(loaded.value.brief).toContain("error: boom");
  });
});

describe("loadEvidenceShot", () => {
  it("serves a screenshot that the journey took, as bytes", () => {
    const root = "/e";
    const id = "run_1786798894551_bergen-mobile";
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fs = fsFor({
      [`${root}/${id}/run.json`]: JSON.stringify(runJson),
      [`${root}/${id}/landing.png`]: png,
    });
    const shot = loadEvidenceShot(root, id, "landing", fs);
    expect(shot).toEqual({ body: png, type: "image/png" });
  });

  it("REFUSES a label the journey never screenshotted, and a path that is not a label", () => {
    // Default deny: a HAR is in the same directory and must not come out of this door.
    const root = "/e";
    const id = "run_1786798894551_bergen-mobile";
    const fs = fsFor({
      [`${root}/${id}/run.json`]: JSON.stringify(runJson),
      [`${root}/${id}/landing.png`]: Buffer.from([1]),
      [`${root}/${id}/network.har`]: "cookie: secret",
    });
    expect(loadEvidenceShot(root, id, "network", fs)).toBeNull();
    expect(loadEvidenceShot(root, id, "../landing", fs)).toBeNull();
    expect(loadEvidenceShot(root, id, "after-scroll", fs)).toBeNull();
  });
});
