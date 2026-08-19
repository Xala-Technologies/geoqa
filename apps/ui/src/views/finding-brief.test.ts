import { describe, expect, it } from "vitest";
import { parseBrief, parseMarkdownTable, tokenizeInline } from "./finding-brief.ts";

describe("parseBrief", () => {
  it("keeps every named section, and a thin body is still a Problem", () => {
    const sections = parseBrief("## Problem\nmissing search\n\n## Breaking changes\nadditive");
    expect(sections).toEqual([
      { heading: "Problem", text: "missing search" },
      { heading: "Breaking changes", text: "additive" },
    ]);
    expect(parseBrief("old one-liner")).toEqual([{ heading: "Problem", text: "old one-liner" }]);
    expect(parseBrief("")).toEqual([]);
    expect(parseBrief("preamble\n## Problem\nlater")).toEqual([{ heading: "Problem", text: "later" }]);
  });
});

describe("parseMarkdownTable", () => {
  it("reads a pipe table and ignores the separator row", () => {
    const table = parseMarkdownTable("| Run | Verdict |\n|---|---|\n| a | FAIL |");
    expect(table).toEqual({ headers: ["Run", "Verdict"], rows: [["a", "FAIL"]] });
    expect(parseMarkdownTable("no table here")).toBeNull();
    expect(parseMarkdownTable("|")).toBeNull();
    expect(parseMarkdownTable("| Run |\n|---|")).toBeNull();
    expect(parseMarkdownTable("|\n|foo|")).toBeNull();
  });
});

describe("tokenizeInline", () => {
  it("keeps bold, code, and a markdown link as distinct tokens", () => {
    expect(tokenizeInline("see **xala.no** and `search` at [the run](https://geoqa.example/#/run/a)")).toEqual([
      { kind: "text", text: "see " },
      { kind: "strong", text: "xala.no" },
      { kind: "text", text: " and " },
      { kind: "code", text: "search" },
      { kind: "text", text: " at " },
      { kind: "link", text: "the run", href: "https://geoqa.example/#/run/a" },
    ]);
    expect(tokenizeInline("plain")).toEqual([{ kind: "text", text: "plain" }]);
    expect(tokenizeInline("")).toEqual([{ kind: "text", text: "" }]);
  });
});
