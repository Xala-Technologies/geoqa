import { describe, expect, it } from "vitest";
import { buildExplainPrompt } from "../prompt.js";

describe("buildExplainPrompt", () => {
  it("embeds the brief and forbids inventing a reading", () => {
    const prompt = buildExplainPrompt("FAIL: browse on https://digilist.no/\nRun: run_1");
    expect(prompt).toContain("FAIL: browse on https://digilist.no/");
    expect(prompt).toContain("Do not invent");
    expect(prompt).toContain("not measured");
    expect(prompt).toContain("Do not change the verdict");
  });

  it("refuses an empty brief rather than asking the model to guess", () => {
    expect(buildExplainPrompt("")).toBeNull();
    expect(buildExplainPrompt("   \n")).toBeNull();
  });
});
