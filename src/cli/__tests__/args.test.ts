import { describe, expect, it } from "vitest";
import { flagBool, flagList, flagNumber, flagPairs, flagString, flagVars, parseArgs, parseEngine, USAGE } from "../args.js";

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

describe("flagList", () => {
  it("collects a repeated flag instead of letting the last one win", () => {
    // The failure this protects against: `flags` is a record, so a repeated
    // --market would silently reduce the matrix to one market and then report a
    // verdict over a third of the coverage that was asked for.
    expect(flagList(["--market", "oslo", "--market", "berlin"], "market")).toEqual(["oslo", "berlin"]);
  });

  it("splits comma-separated values and accepts the --key=value spelling", () => {
    expect(flagList(["--market=oslo,berlin", "--market", "london"], "market")).toEqual(["oslo", "berlin", "london"]);
  });

  it("drops empty entries rather than expanding a trailing comma into a scenario", () => {
    // An empty market becomes a profile lookup that fails thirty scenarios into
    // an overnight matrix.
    expect(flagList(["--market", "oslo, berlin ,", "--device"], "market")).toEqual(["oslo", "berlin"]);
  });

  it("reads a flag with no value as absent, not as a value named after the next flag", () => {
    expect(flagList(["--market", "--json"], "market")).toEqual([]);
    expect(flagList(["--json"], "market")).toEqual([]);
  });
});

describe("flagPairs", () => {
  it("collects repeated key=value flags under any name", () => {
    expect(flagPairs(["--max-age", "pass=7", "--max-age=fail=null"], "max-age")).toEqual({ pass: "7", fail: "null" });
  });

  it("ignores a pair with no key and a value with no equals sign", () => {
    expect(flagPairs(["--max-age", "=7", "--max-age", "pass"], "max-age")).toEqual({});
  });
});

describe("parseEngine", () => {
  it("REFUSES an unknown engine rather than falling back to the default one", () => {
    // The previous form read anything that was not exactly "playwright" as
    // agent-browser, so `--engine playwrite` reported a perfectly successful run
    // of an engine nobody asked for.
    expect(parseEngine("playwrite")).toBeNull();
    expect(parseEngine("")).toBeNull();
  });

  it("accepts both engines by name", () => {
    expect(parseEngine("agent-browser")).toBe("agent-browser");
    expect(parseEngine("playwright")).toBe("playwright");
  });
});

describe("USAGE", () => {
  it("documents every command group and says why --json exists", () => {
    for (const word of [
      "browser verify",
      "proxy verify",
      "journey run",
      "matrix run",
      "experiment run",
      "evidence inspect",
      "evidence prune",
    ]) {
      expect(USAGE).toContain(word);
    }
    expect(USAGE).toContain("integration contract");
  });

  it("states the config precedence, and that a bad config is an error rather than a fallback", () => {
    expect(USAGE).toContain("geoqa.config.json");
    expect(USAGE).toContain("FLAG > config file > built-in default");
    expect(USAGE).toContain("An absent file is not an error");
    expect(USAGE).toContain("GEOQA_PROXY_");
  });

  it("says that matrix validates before launching and that writes must be asked for", () => {
    expect(USAGE).toContain("--allow-writes");
    expect(USAGE).toContain("--dry-run");
    expect(USAGE).toContain("BEFORE anything");
    expect(USAGE).toContain("unmeasured");
  });

  it("says that prune plans by default and that not knowing is not a licence to delete", () => {
    expect(USAGE).toContain("--apply");
    expect(USAGE).toContain("--delete-unreadable");
    expect(USAGE).toContain("SHORTENS");
    expect(USAGE).toContain("not a licence to delete");
  });
});

describe("USAGE for --repeat", () => {
  it("says that repeats MEASURE flakiness and never mask it", () => {
    expect(USAGE).toContain("--repeat");
    expect(USAGE).toContain("MEASURES flakiness");
    expect(USAGE).toContain("never retries");
    expect(USAGE).toContain("WORST outcome");
    expect(USAGE).toContain("reproduced");
  });

  it("contains no backtick, because USAGE is itself a template literal", () => {
    // A backtick here does not read as a typo — it ends the string and the file
    // stops compiling.
    expect(USAGE).not.toContain("`");
  });
});
