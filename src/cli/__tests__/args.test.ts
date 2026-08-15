import { describe, expect, it } from "vitest";
import {
  flagBool,
  flagList,
  flagNumber,
  flagPairs,
  flagString,
  flagVars,
  parseArgs,
  parseDurationMs,
  parseEngine,
  parseUrlList,
  USAGE,
} from "../args.js";

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
      "geoqa server",
      "geoqa run",
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

  it("says geoqa run streams JSONL and does not invent a second runtime", () => {
    expect(USAGE).toContain("geoqa run");
    expect(USAGE).toContain("Same runtime as journey run");
    expect(USAGE).toContain("one event per line");
    expect(USAGE).toContain("observedIp");
    expect(USAGE).toContain("liveUrl");
    expect(USAGE).toContain("{sessionduration}");
  });

  it("says the server is the operator console and that Live is not remote control", () => {
    expect(USAGE).toContain("geoqa server");
    expect(USAGE).toContain("Watch writes tenants/");
    expect(USAGE).toContain("Settings stays read-only");
    expect(USAGE).toContain("not remote control");
    expect(USAGE).toContain("first sweep");
    expect(USAGE).toContain("GEOQA_ADMIN_PASSWORD_HASH");
    expect(USAGE).toContain("POST /api/run");
    expect(USAGE).toContain("GEOQA_API_TOKEN");
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

describe("parseDurationMs", () => {
  it("reads bare ms and every suffix", () => {
    expect(parseDurationMs("600000")).toBe(600_000);
    expect(parseDurationMs("500ms")).toBe(500);
    expect(parseDurationMs("24s")).toBe(24_000);
    expect(parseDurationMs("10m")).toBe(600_000);
    expect(parseDurationMs("10min")).toBe(600_000);
    expect(parseDurationMs("1h")).toBe(3_600_000);
    expect(parseDurationMs("1.5s")).toBe(1_500);
    expect(parseDurationMs("  10m  ")).toBe(600_000);
  });

  it("returns null for a value it cannot read, so a caller can refuse instead of defaulting", () => {
    // The point of the union. EXP-002's default window is 24s against a PRD
    // asking for ten minutes, so a --stability-window that silently fell back
    // would answer the cheap question while the caller read the expensive one.
    expect(parseDurationMs("ten minutes")).toBeNull();
    expect(parseDurationMs("10 m")).toBeNull();
    expect(parseDurationMs("10sec")).toBeNull();
    expect(parseDurationMs("")).toBeNull();
    expect(parseDurationMs("-5s")).toBeNull();
  });

  it("refuses zero, because a zero-length window reports perfect stability having waited for nothing", () => {
    expect(parseDurationMs("0")).toBeNull();
    expect(parseDurationMs("0s")).toBeNull();
  });
});

describe("parseUrlList", () => {
  it("reads one URL per line and skips blanks and comments", () => {
    const parsed = parseUrlList("# sitemap\n\nhttps://a.no/x\n  https://a.no/y  \n\n# end\n");
    expect(parsed).toEqual({ ok: true, urls: ["https://a.no/x", "https://a.no/y"] });
  });

  it("PRESERVES order and KEEPS duplicates", () => {
    // Sitemap order is meaningful to whoever reads the results, and a repeated
    // URL is a legitimate way to ask for a second sample of one page.
    const parsed = parseUrlList("https://a.no/b\nhttps://a.no/a\nhttps://a.no/b\n");
    expect(parsed).toEqual({ ok: true, urls: ["https://a.no/b", "https://a.no/a", "https://a.no/b"] });
  });

  it("keeps a fragment rather than treating # as a trailing comment", () => {
    // `#` is legal in a URL, so cutting at one would silently rewrite the target.
    expect(parseUrlList("https://a.no/x#pricing")).toEqual({ ok: true, urls: ["https://a.no/x#pricing"] });
  });

  it("refuses the WHOLE file on a bad line, and names every bad line with its number", () => {
    // Same rule as a mistyped --market: refuse the expansion, not the
    // two-hundredth run of it.
    const parsed = parseUrlList("https://a.no/x\n/relative/path\nhttps://a.no/y\nnot a url\n");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected a refusal");
    expect(parsed.errors).toHaveLength(2);
    expect(parsed.errors[0]).toContain("line 2");
    expect(parsed.errors[1]).toContain("line 4");
  });

  it("refuses a non-http scheme by name", () => {
    // A file: URL would make a matrix pass against local disk while claiming to
    // have visited a site.
    const parsed = parseUrlList("file:///etc/hosts\n");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected a refusal");
    expect(parsed.errors[0]).toContain("only http and https");
  });

  it("refuses a file with no URLs at all rather than returning an empty sweep", () => {
    const parsed = parseUrlList("# nothing here\n\n");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected a refusal");
    expect(parsed.errors[0]).toContain("every line was blank or a comment");
  });

  it("reads CRLF, because a URL list is the file most likely to arrive from a spreadsheet", () => {
    expect(parseUrlList("https://a.no/x\r\nhttps://a.no/y\r\n")).toEqual({
      ok: true,
      urls: ["https://a.no/x", "https://a.no/y"],
    });
  });
});

describe("USAGE for the page axis and the experiment knobs", () => {
  it("documents --urls-file and why the axis is inside the pool", () => {
    expect(USAGE).toContain("--urls-file");
    expect(USAGE).toContain("PAGE axis");
    expect(USAGE).toContain("invents defects out of its own load");
  });

  it("documents the stability window, its default and the PRD's window", () => {
    expect(USAGE).toContain("--stability-window");
    expect(USAGE).toContain("Default 24s");
    expect(USAGE).toContain("--stability-window 10m --samples 3");
  });

  it("documents identity by place, and that two identities refuse", () => {
    expect(USAGE).toContain("--country");
    expect(USAGE).toContain("--city");
    expect(USAGE).toContain("REFUSES and lists the ones there are");
    expect(USAGE).toContain("matrix run uses --market instead");
  });
});
