import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { interpolate, loadJourney, parseJourney, parseStep, resolveSteps, type Step } from "../spec.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const journey = (steps: unknown[]): unknown => ({ id: "j", title: "J", steps });

describe("parseStep", () => {
  it("parses each non-assert action", () => {
    const cases: unknown[] = [
      { action: "open", url: "https://x" },
      { action: "reload", probability: 1 },
      { action: "click", selector: "@e1" },
      { action: "scroll" },
      { action: "wait", target: "500" },
      { action: "screenshot", label: "hero" },
      { action: "snapshot", label: "tree" },
    ];
    for (const [i, c] of cases.entries()) expect(parseStep(c, i).ok).toBe(true);
  });

  it("defaults scroll direction to down and screenshot fullPage to false", () => {
    const scroll = parseStep({ action: "scroll" }, 0);
    if (!scroll.ok) throw new Error("expected ok");
    expect(scroll.value).toMatchObject({ direction: "down" });
    const shot = parseStep({ action: "screenshot", label: "hero" }, 0);
    if (!shot.ok) throw new Error("expected ok");
    expect(shot.value).toMatchObject({ fullPage: false });
  });

  it("parses an assert in two passes and defaults severity to high", () => {
    const out = parseStep({ action: "assert", check: "title-exists" }, 0);
    if (!out.ok) throw new Error("expected ok");
    // `probability` defaults to 1: a step with no declared probability always
    // happens, and — see random.ts — does not consume the generator either.
    expect(out.value).toEqual({
      action: "assert",
      severity: "high",
      probability: 1,
      optional: false,
      spec: { check: "title-exists" },
    });
  });

  it("keeps an assert label when one is given", () => {
    const out = parseStep({ action: "assert", check: "title-exists", label: "has a title" }, 0);
    if (!out.ok) throw new Error("expected ok");
    expect(out.value).toMatchObject({ label: "has a title" });
  });

  it("rejects an assert with no check rather than silently accepting a no-op step", () => {
    const out = parseStep({ action: "assert" }, 2);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected failure");
    expect(out.errors.join()).toContain("steps[2]");
  });

  it("rejects an assert whose envelope is malformed", () => {
    const out = parseStep({ action: "assert", check: "title-exists", severity: "urgent" }, 1);
    expect(out.ok).toBe(false);
  });

  it("rejects a non-object, an unknown action and a missing required field", () => {
    expect(parseStep("open", 0).ok).toBe(false);
    expect(parseStep(null, 0).ok).toBe(false);
    expect(parseStep({ action: "teleport" }, 0).ok).toBe(false);
    expect(parseStep({ action: "open" }, 0).ok).toBe(false);
  });
});

describe("parseJourney", () => {
  it("collects EVERY step error, not just the first", () => {
    const out = parseJourney(journey([{ action: "open" }, { action: "teleport" }]));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected failure");
    expect(out.errors.length).toBeGreaterThanOrEqual(2);
    expect(out.errors.join()).toContain("steps[0]");
    expect(out.errors.join()).toContain("steps[1]");
  });

  it("rejects an empty or headless journey", () => {
    expect(parseJourney(journey([])).ok).toBe(false);
    expect(parseJourney({ title: "no id", steps: [{ action: "reload", probability: 1 }] }).ok).toBe(false);
  });

  it("defaults description to empty", () => {
    const out = parseJourney(journey([{ action: "reload", probability: 1 }]));
    if (!out.ok) throw new Error("expected ok");
    expect(out.value.description).toBe("");
  });
});

describe("loadJourney", () => {
  it("reads and validates a YAML file", () => {
    const out = loadJourney("x.yaml", () => "id: j\ntitle: J\nsteps:\n  - { action: reload }\n");
    if (!out.ok) throw new Error("expected ok");
    expect(out.value.id).toBe("j");
  });

  it("reports a YAML syntax error against the file path", () => {
    const out = loadJourney("bad.yaml", () => "steps: [\n  - unclosed");
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected failure");
    expect(out.errors[0]).toContain("bad.yaml");
  });

  it("prefixes validation errors with the file path", () => {
    const out = loadJourney("bad.yaml", () => "id: j\ntitle: J\nsteps:\n  - { action: teleport }\n");
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected failure");
    expect(out.errors[0]).toContain("bad.yaml: steps[0]");
  });

  it("defaults its reader to the real filesystem", () => {
    const out = loadJourney(path.join(repoRoot, "journeys", "landing-page.yaml"));
    expect(out.ok).toBe(true);
  });
});

describe("the journeys that actually ship", () => {
  // Guards the thing a unit test normally cannot see: a journey file that is
  // shipped but unparseable is invisible until a live run fails on it.
  const dir = path.join(repoRoot, "journeys");
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));

  /**
   * The journeys something else DEPENDS on, not an inventory of the directory.
   *
   * This was an exact-equality roster and it broke on every addition — twice in one
   * day, once at four journeys and once at eight, each time reporting a red suite
   * for a new file that was perfectly fine. A test that fails when the thing it
   * guards is working correctly gets deleted or ignored, and then it guards
   * nothing.
   *
   * A containment check still catches the failure worth catching: a journey being
   * REMOVED while a default, a doc or an experiment still names it. `landing-page`
   * is the CLI's default journey; `sweep` is what the page axis is for; the rest are
   * the five flows the PRD's J01–J05 name.
   */
  it("still ships every journey something else depends on", () => {
    for (const required of [
      "browse.yaml",
      "contact-form.yaml",
      "conversion-probe.yaml",
      "landing-page.yaml",
      "localization.yaml",
      "reader.yaml",
      "search.yaml",
      "sweep.yaml",
      "explore.yaml",
    ]) {
      expect(files).toContain(required);
    }
  });

  it("ships nothing but YAML, so a stray file cannot be silently unloadable", () => {
    expect(files.filter((f) => !f.endsWith(".yaml"))).toEqual([]);
  });

  it("declares writes on exactly the journeys that change state", () => {
    // A journey that submits, registers or books must say so. Getting this wrong
    // in the safe direction means a run creates records while reporting that it
    // only read pages — and the screenshot privacy flag stays off.
    const writes = files.filter((file) => {
      const out = loadJourney(path.join(dir, file), (p) => readFileSync(p, "utf8"));
      return out.ok && out.value.writes;
    });
    expect(writes).toEqual(["contact-form.yaml"]);
  });

  it.each(files)("%s parses, and its id matches its filename", (file) => {
    const out = loadJourney(path.join(dir, file), (p) => readFileSync(p, "utf8"));
    if (!out.ok) throw new Error(out.errors.join("\n"));
    expect(out.value.id).toBe(file.replace(/\.yaml$/, ""));
    expect(out.value.steps.length).toBeGreaterThan(2);
  });
});

describe("interpolate", () => {
  it("substitutes known placeholders", () => {
    expect(interpolate("{a}/b/{c}", { a: "x", c: "y" })).toBe("x/b/y");
  });

  it("LEAVES an unknown placeholder intact rather than emptying it", () => {
    // `open ""` would navigate nowhere and be reported as a page failure for
    // what is really a config typo.
    expect(interpolate("{missing}/b", {})).toBe("{missing}/b");
  });
});

describe("resolveSteps", () => {
  it("substitutes into open urls and string check values", () => {
    const steps: Step[] = [
      { action: "open", url: "{target}/blogg", probability: 1 },
      { action: "assert", severity: "high", probability: 1, spec: { check: "text-contains", selector: "body", value: "{brand}" } },
    ];
    const out = resolveSteps(steps, { target: "https://digilist.no", brand: "Digilist" });
    expect(out[0]).toMatchObject({ url: "https://digilist.no/blogg" });
    expect(out[1]).toMatchObject({ spec: { value: "Digilist" } });
  });

  it("leaves steps without substitutable fields untouched", () => {
    const steps: Step[] = [
      { action: "reload", probability: 1 },
      { action: "assert", severity: "high", probability: 1, spec: { check: "lcp-below", value: 2500 } },
    ];
    expect(resolveSteps(steps, { target: "x" })).toEqual(steps);
  });
});

describe("a step whose ENVELOPE is wrong, before its action is even considered", () => {
  it("rejects a probability outside 0..1 and names the step by index", () => {
    // Checked before the action, because `probability: 1.5` is not a question about what
    // `click` means. A number above 1 is almost always a percentage written by hand, and
    // silently clamping it would make "runs 150% of the time" mean the same as "always" —
    // which hides that the author believed something the engine cannot do.
    const parsed = parseStep({ action: "click", selector: "#buy", probability: 1.5 }, 3);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.errors.join(" ")).toContain("steps[3]");
  });

  it("rejects a probability that is not a number at all", () => {
    const parsed = parseStep({ action: "click", selector: "#buy", probability: "sometimes" }, 0);
    expect(parsed.ok).toBe(false);
  });

  it("defaults optional to false, and keeps a declared true", () => {
    // A click that is not on this page must not halt an organic visit. The flag
    // is off unless asked for, so every existing journey keeps today's meaning.
    const plain = parseStep({ action: "click", selector: "#buy" }, 0);
    if (!plain.ok) throw new Error("expected ok");
    expect(plain.value.optional).toBe(false);
    const flagged = parseStep({ action: "click", selector: "#buy", optional: true }, 0);
    if (!flagged.ok) throw new Error("expected ok");
    expect(flagged.value.optional).toBe(true);
  });
});

describe("pinch", () => {
  it("parses in and out, and refuses a missing selector", () => {
    const inn = parseStep({ action: "pinch", selector: ".leaflet-container", direction: "in" }, 0);
    if (!inn.ok) throw new Error("expected ok");
    expect(inn.value).toMatchObject({ action: "pinch", selector: ".leaflet-container", direction: "in" });
    const out = parseStep({ action: "pinch", selector: ".map", direction: "out" }, 1);
    if (!out.ok) throw new Error("expected ok");
    expect(out.value).toMatchObject({ direction: "out" });
    expect(parseStep({ action: "pinch", direction: "in" }, 2).ok).toBe(false);
  });
});
