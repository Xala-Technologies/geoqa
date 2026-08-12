import { describe, expect, it } from "vitest";
import { flagBool, flagNumber, flagString, flagVars, parseArgs, USAGE } from "../args.js";

describe("parseArgs", () => {
  it("reads a two-word command", () => {
    expect(parseArgs(["journey", "run"]).command).toEqual(["journey", "run"]);
  });

  it("reads --key value and --key=value", () => {
    const args = parseArgs(["journey", "run", "--url", "https://x", "--geo=oslo-mobile"]);
    expect(args.flags).toEqual({ url: "https://x", geo: "oslo-mobile" });
  });

  it("treats a --key followed by another --key as a boolean", () => {
    expect(parseArgs(["browser", "verify", "--json", "--headed"]).flags).toEqual({ json: true, headed: true });
  });

  it("treats a trailing --key as a boolean", () => {
    expect(parseArgs(["profile", "list", "--json"]).flags.json).toBe(true);
  });

  it("keeps extra positionals after the command", () => {
    const args = parseArgs(["experiment", "run", "EXP-001", "--samples", "5"]);
    expect(args.command).toEqual(["experiment", "run"]);
    expect(args.positional).toEqual(["EXP-001"]);
  });

  it("stops the command at a non-word positional", () => {
    const args = parseArgs(["evidence", "inspect", "run_123_oslo"]);
    expect(args.command).toEqual(["evidence", "inspect"]);
    expect(args.positional).toEqual(["run_123_oslo"]);
  });

  it("handles an empty argv", () => {
    expect(parseArgs([])).toEqual({ command: [], flags: {}, positional: [] });
  });

  it("allows an empty value in --key=", () => {
    expect(parseArgs(["--url="]).flags.url).toBe("");
  });
});

describe("flag readers", () => {
  const args = parseArgs(["x", "--url", "https://x", "--samples", "25", "--json", "--bad", "nope"]);

  it("reads strings with a fallback", () => {
    expect(flagString(args, "url", "d")).toBe("https://x");
    expect(flagString(args, "missing", "d")).toBe("d");
    expect(flagString(args, "json", "d")).toBe("d"); // a boolean is not a string
  });

  it("reads numbers with a fallback, rejecting non-numeric text", () => {
    expect(flagNumber(args, "samples", 10)).toBe(25);
    expect(flagNumber(args, "missing", 10)).toBe(10);
    expect(flagNumber(args, "bad", 10)).toBe(10);
    expect(flagNumber(args, "json", 10)).toBe(10);
  });

  it("reads booleans from a bare flag and from the string 'true'", () => {
    expect(flagBool(args, "json")).toBe(true);
    expect(flagBool(args, "missing")).toBe(false);
    expect(flagBool(parseArgs(["x", "--json=true"]), "json")).toBe(true);
    expect(flagBool(parseArgs(["x", "--json=false"]), "json")).toBe(false);
  });
});

describe("flagVars", () => {
  it("collects repeated --var k=v pairs", () => {
    expect(flagVars(["--var", "a=1", "--var", "b=two", "--url", "x"])).toEqual({ a: "1", b: "two" });
  });

  it("ignores a --var with no pair or no equals sign", () => {
    expect(flagVars(["--var"])).toEqual({});
    expect(flagVars(["--var", "novalue"])).toEqual({});
    expect(flagVars(["--var", "=noKey"])).toEqual({});
  });

  it("keeps an equals sign inside the value", () => {
    expect(flagVars(["--var", "q=a=b"])).toEqual({ q: "a=b" });
  });
});

describe("USAGE", () => {
  it("documents every command group and says why --json exists", () => {
    for (const word of ["browser verify", "proxy verify", "journey run", "experiment run", "evidence inspect"]) {
      expect(USAGE).toContain(word);
    }
    expect(USAGE).toContain("integration contract");
  });
});
