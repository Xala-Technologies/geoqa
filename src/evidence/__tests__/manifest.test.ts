import { describe, expect, it } from "vitest";
import {
  GEOQA_SCHEMA_VERSION,
  RETENTION,
  REQUIRED_QUESTIONS,
  buildManifest,
  completenessOf,
  emptyArtifacts,
  missingArtifacts,
  tierFor,
  type Artifact,
} from "../manifest.js";

const art = (kind: Artifact["kind"], bytes = 100, risk?: Artifact["risk"]): Artifact => ({
  kind,
  label: kind,
  path: `${kind}.json`,
  bytes,
  mime: "application/json",
  ...(risk ? { risk } : {}),
});

describe("tierFor", () => {
  it("maps each verdict, and sends ERROR to investigation rather than fail", () => {
    expect(tierFor("PASS")).toBe("pass");
    expect(tierFor("PASS_WITH_WARNINGS")).toBe("warning");
    expect(tierFor("FAIL")).toBe("fail");
    // When we could not read the page we know least and need most.
    expect(tierFor("ERROR")).toBe("investigation");
  });
});

describe("RETENTION", () => {
  it("keeps almost nothing on a pass and everything on a failure", () => {
    expect(RETENTION.pass).toEqual(["metadata", "screenshot", "vitals"]);
    expect(RETENTION.fail.length).toBeGreaterThan(RETENTION.warning.length);
    expect(RETENTION.warning.length).toBeGreaterThan(RETENTION.pass.length);
    expect(RETENTION.investigation).toContain("a11y");
  });
});

describe("missingArtifacts", () => {
  it("names what the tier required and did not get", () => {
    expect(missingArtifacts("pass", [art("metadata"), art("screenshot")])).toEqual(["vitals"]);
  });

  it("treats a ZERO-BYTE artifact as absent — an empty file looks like evidence", () => {
    expect(missingArtifacts("pass", [art("metadata"), art("screenshot"), art("vitals", 0)])).toEqual(["vitals"]);
  });

  it("is empty when everything required is present", () => {
    expect(missingArtifacts("pass", [art("metadata"), art("screenshot"), art("vitals")])).toEqual([]);
  });
});

describe("completenessOf", () => {
  it("is the share of REQUIRED kinds, so extra screenshots cannot mask a missing trace", () => {
    const many = [art("metadata"), art("screenshot"), art("screenshot"), art("screenshot"), art("console"), art("network")];
    // fail tier requires 8 kinds; 4 distinct present (metadata, screenshot, console, network)
    expect(completenessOf("fail", many)).toBe(50);
  });

  it("is 100 when nothing is missing and 0 when everything is", () => {
    expect(completenessOf("pass", [art("metadata"), art("screenshot"), art("vitals")])).toBe(100);
    expect(completenessOf("pass", [])).toBe(0);
  });
});

describe("emptyArtifacts", () => {
  it("finds zero-byte files", () => {
    expect(emptyArtifacts([art("metadata"), art("trace", 0)]).map((a) => a.kind)).toEqual(["trace"]);
  });
});

describe("buildManifest", () => {
  const base = { evidenceId: "ev_1", runId: "run_1", createdAt: "2026-08-12T00:00:00.000Z" };

  it("records the tier, what is missing and how complete the package is", () => {
    const manifest = buildManifest({ ...base, verdict: "FAIL", artifacts: [art("metadata"), art("screenshot")] });
    expect(manifest.tier).toBe("fail");
    expect(manifest.missing).toContain("trace");
    expect(manifest.missing).toContain("har");
    expect(manifest.completeness).toBe(25);
  });

  it("is 100% complete for a clean pass", () => {
    const manifest = buildManifest({
      ...base,
      verdict: "PASS",
      artifacts: [art("metadata"), art("screenshot"), art("vitals")],
    });
    expect(manifest.completeness).toBe(100);
    expect(manifest.missing).toEqual([]);
  });

  it("raises a privacy note naming the screenshots that need review", () => {
    const manifest = buildManifest({
      ...base,
      verdict: "PASS",
      artifacts: [art("metadata"), art("screenshot", 100, "review"), art("vitals")],
    });
    expect(manifest.privacyNote).toContain("review before sharing");
    expect(manifest.privacyNote).toContain("screenshot.json");
  });

  it("has no privacy note when every screenshot is low risk", () => {
    const manifest = buildManifest({
      ...base,
      verdict: "PASS",
      artifacts: [art("screenshot", 100, "low")],
    });
    expect(manifest.privacyNote).toBeNull();
  });

  it("STAMPS the schema version on every manifest, so a consumer can refuse a shape it does not know", () => {
    // An evidence package is opened by whatever tool a human points at it months
    // later. Without a version its only way to notice the shape changed is to
    // crash on a field that moved.
    const manifest = buildManifest({ ...base, verdict: "PASS", artifacts: [] });
    expect(manifest.schemaVersion).toBe(GEOQA_SCHEMA_VERSION);
  });

  it("PINS the manifest's top-level keys, so adding or removing one is deliberate", () => {
    // Key sets, not values: the values change on every unrelated behaviour change
    // (a new tier, a different completeness), and a test that failed on all of
    // those would be deleted within a week. The KEYS are the part a consumer
    // wrote code against, so they are the part worth freezing — a removal or a
    // rename must break here and be re-stated on purpose.
    const manifest = buildManifest({ ...base, verdict: "FAIL", artifacts: [art("metadata")] });
    expect(Object.keys(manifest).sort()).toEqual(
      [
        "artifacts",
        "completeness",
        "createdAt",
        "evidenceId",
        "missing",
        "privacyNote",
        "runId",
        "schemaVersion",
        "tier",
        "verdict",
      ].sort(),
    );
  });
});

describe("REQUIRED_QUESTIONS", () => {
  it("states the eight questions an evidence package must answer", () => {
    expect(REQUIRED_QUESTIONS).toHaveLength(8);
    expect(REQUIRED_QUESTIONS).toContain("Can we reproduce it?");
    expect(REQUIRED_QUESTIONS).toContain("In which market?");
  });
});
