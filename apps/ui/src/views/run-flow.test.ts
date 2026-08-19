import { describe, expect, it } from "vitest";
import { attachShotsToSteps, autoFrameLabel, leftoverShots, shotForStep } from "./run-flow.ts";

const shot = (label: string, present = true) => ({ label, file: `${label}.png`, present });

describe("autoFrameLabel", () => {
  it("matches the engine's NN-slug names so an older run's stills attach to the step that took them", () => {
    expect(autoFrameLabel(0, "open the login page")).toBe("00-open-the-login-page");
    expect(autoFrameLabel(2, "choose email login")).toBe("02-choose-email-login");
    expect(autoFrameLabel(1, "email login is offered")).toBe("01-email-login-is-offered");
    expect(autoFrameLabel(5, "no-http-5xx")).toBe("05-no-http-5xx");
  });

  it("falls back to frame when the label slugs to nothing, and caps the slug at 40", () => {
    expect(autoFrameLabel(0, "!!!")).toBe("00-frame");
    const long = "the email field is there and also a great deal of extra wording";
    expect(autoFrameLabel(3, long)).toBe("03-the-email-field-is-there-and-also-a-grea");
  });
});

describe("shotForStep", () => {
  const shots = [
    shot("00-open-the-login-page"),
    shot("02-choose-email-login"),
    shot("login-form"),
    shot("ghost", false),
  ];

  it("pairs an explicit screenshot step with its own label", () => {
    expect(shotForStep({ index: 4, action: "screenshot", label: "login-form" }, shots)?.label).toBe("login-form");
  });

  it("pairs an action or assert with the auto-frame taken at that index", () => {
    expect(shotForStep({ index: 0, action: "open", label: "open the login page" }, shots)?.label).toBe(
      "00-open-the-login-page",
    );
    expect(shotForStep({ index: 1, action: "assert", label: "email login is offered" }, shots)).toBeNull();
    expect(shotForStep({ index: 2, action: "click", label: "choose email login" }, shots)?.label).toBe(
      "02-choose-email-login",
    );
  });

  it("does not attach a still that is not present on disk", () => {
    expect(shotForStep({ index: 4, action: "screenshot", label: "ghost" }, [shot("ghost", false)])).toBeNull();
  });
});

describe("attachShotsToSteps / leftoverShots", () => {
  const steps = [
    { index: 0, action: "open", label: "open the login page", outcome: "passed", detail: "open ok", expected: null, observed: "https://x", durationMs: 10 },
    { index: 1, action: "assert", label: "email login is offered", outcome: "passed", detail: "visible", expected: "true", observed: "true", durationMs: 4 },
    { index: 4, action: "screenshot", label: "login-form", outcome: "passed", detail: "screenshot login-form ok", expected: null, observed: null, durationMs: 80 },
  ];
  const shots = [shot("00-open-the-login-page"), shot("login-form"), shot("extra-still")];

  it("puts each still on the step that produced it, and leaves unmatched stills aside", () => {
    const flow = attachShotsToSteps(steps, shots);
    expect(flow[0]?.shot?.label).toBe("00-open-the-login-page");
    expect(flow[1]?.shot).toBeNull();
    expect(flow[2]?.shot?.label).toBe("login-form");
    expect(leftoverShots(steps, shots).map((s) => s.label)).toEqual(["extra-still"]);
  });
});
