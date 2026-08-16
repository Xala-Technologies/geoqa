import { describe, expect, it } from "vitest";
import { commandArgs, fillCommand, fillCommandLabel, screenshotCommand, scrollCommand, selectCommand, sessionArgs, snapshotCommand } from "../args.js";

describe("sessionArgs", () => {
  it("emits only --session when nothing else is configured", () => {
    expect(sessionArgs({ sessionId: "run1" })).toEqual(["--session", "run1"]);
  });

  it("emits every launch-identity flag in a stable order", () => {
    expect(
      sessionArgs({
        sessionId: "run1",
        namespace: "oslo",
        proxy: "http://u:p@host:8080",
        proxyBypass: "localhost",
        userAgent: "UA/1",
        initScripts: ["/a.js", "/b.js"],
        headed: true,
      }),
    ).toEqual([
      "--session", "run1",
      "--namespace", "oslo",
      "--proxy", "http://u:p@host:8080",
      "--proxy-bypass", "localhost",
      "--user-agent", "UA/1",
      "--init-script", "/a.js",
      "--init-script", "/b.js",
      "--headed",
    ]);
  });

  it("omits --headed when false rather than passing a value", () => {
    expect(sessionArgs({ sessionId: "r", headed: false })).toEqual(["--session", "r"]);
  });
});

describe("commandArgs", () => {
  it("puts globals first, the command next, and --json last", () => {
    expect(commandArgs({ sessionId: "r" }, ["open", "https://x"])).toEqual([
      "--session", "r", "open", "https://x", "--json",
    ]);
  });
});

describe("snapshotCommand", () => {
  it("defaults to a bare snapshot", () => {
    expect(snapshotCommand()).toEqual(["snapshot"]);
  });

  it("maps every option to its flag", () => {
    expect(snapshotCommand({ interactiveOnly: true, compact: true, depth: 3, selector: "main" })).toEqual([
      "snapshot", "-i", "-c", "-d", "3", "-s", "main",
    ]);
  });

  it("passes depth 0 rather than treating it as absent", () => {
    expect(snapshotCommand({ depth: 0 })).toEqual(["snapshot", "-d", "0"]);
  });
});

describe("screenshotCommand", () => {
  it("takes a path", () => {
    expect(screenshotCommand("/e/a.png")).toEqual(["screenshot", "/e/a.png"]);
  });

  it("adds --full and --annotate", () => {
    expect(screenshotCommand("/e/a.png", { fullPage: true, annotate: true })).toEqual([
      "screenshot", "/e/a.png", "--full", "--annotate",
    ]);
  });
});

describe("scrollCommand", () => {
  it("omits the pixel count when unset", () => {
    expect(scrollCommand("down")).toEqual(["scroll", "down"]);
  });

  it("passes 0 rather than dropping it", () => {
    expect(scrollCommand("down", 0)).toEqual(["scroll", "down", "0"]);
  });
});

describe("input commands", () => {
  it("uses fill, which clears the field first", () => {
    // `type` appends, so a journey run twice against a browser that autofilled
    // would submit the value doubled.
    expect(fillCommand("#email", "qa@example.test")).toEqual(["fill", "#email", "qa@example.test"]);
  });

  it("names a filled field WITHOUT its value, for anything a human reads", () => {
    // The value reaches argv, and argv is kept in ExecMeta.command so a failing
    // call is reproducible — which for this one command would put a password in
    // the evidence package.
    expect(fillCommandLabel("#password")).toBe("fill #password <redacted>");
    expect(fillCommandLabel("#password")).not.toContain("hunter2");
  });

  it("passes every selected option through as its own argument", () => {
    expect(selectCommand("#topic", ["support"])).toEqual(["select", "#topic", "support"]);
    expect(selectCommand("#tags", ["a", "b"])).toEqual(["select", "#tags", "a", "b"]);
  });
});
