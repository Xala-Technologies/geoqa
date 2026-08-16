import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultPackageRoot, resolveAgentBrowserBin, withBinOnPath } from "../bin.js";

const never = (): boolean => false;
const only = (...wanted: string[]) => (p: string): boolean => wanted.includes(p);

describe("resolveAgentBrowserBin", () => {
  it("prefers an explicit GEOQA_AGENT_BROWSER_BIN that exists", () => {
    const bin = resolveAgentBrowserBin({
      env: { GEOQA_AGENT_BROWSER_BIN: "/custom/ab" },
      exists: only("/custom/ab"),
    });
    expect(bin).toBe("/custom/ab");
  });

  it("accepts AGENT_BROWSER_BIN as the alternate override", () => {
    const bin = resolveAgentBrowserBin({
      env: { AGENT_BROWSER_BIN: "/alt/ab" },
      exists: only("/alt/ab"),
    });
    expect(bin).toBe("/alt/ab");
  });

  it("ignores an override that does not exist and falls through to candidates", () => {
    const local = path.join("/repo", "node_modules", ".bin", "agent-browser");
    const bin = resolveAgentBrowserBin({
      env: { GEOQA_AGENT_BROWSER_BIN: "/gone/ab" },
      packageRoot: "/repo",
      exists: only(local),
    });
    expect(bin).toBe(local);
  });

  it("prefers the repo's own node_modules over a global install", () => {
    const local = path.join("/repo", "node_modules", ".bin", "agent-browser");
    const bin = resolveAgentBrowserBin({
      env: {},
      packageRoot: "/repo",
      home: "/home/me",
      exists: only(local, "/usr/local/bin/agent-browser"),
    });
    expect(bin).toBe(local);
  });

  it("falls back through home, /usr/local and homebrew in order", () => {
    const home = path.join("/home/me", ".local", "bin", "agent-browser");
    expect(
      resolveAgentBrowserBin({ env: {}, packageRoot: "/repo", home: "/home/me", exists: only(home) }),
    ).toBe(home);
    expect(
      resolveAgentBrowserBin({
        env: {},
        packageRoot: "/repo",
        home: "/home/me",
        exists: only("/opt/homebrew/bin/agent-browser"),
      }),
    ).toBe("/opt/homebrew/bin/agent-browser");
  });

  it("returns the bare name when nothing is found, so PATH still gets a chance", () => {
    expect(resolveAgentBrowserBin({ env: {}, packageRoot: "/repo", home: "/h", exists: never })).toBe(
      "agent-browser",
    );
  });

  it("defaults env, home, packageRoot and exists when given nothing", () => {
    // Exercises every `??` default. The real repo has the binary installed, so
    // this resolves to the local node_modules copy.
    expect(resolveAgentBrowserBin()).toContain("agent-browser");
  });

  it("resolves the package root two levels above src/browser", () => {
    expect(defaultPackageRoot()).toMatch(/packages[\\/]engine$/);
  });
});

describe("withBinOnPath", () => {
  it("prepends the binary's directory to PATH", () => {
    const out = withBinOnPath({ PATH: "/usr/bin" }, "/opt/tools/agent-browser");
    expect(out.PATH).toBe(`/opt/tools${path.delimiter}/usr/bin`);
  });

  it("sets PATH when there was none", () => {
    expect(withBinOnPath({}, "/opt/tools/agent-browser").PATH).toBe("/opt/tools");
  });

  it("leaves PATH alone when the directory is already on it", () => {
    const env = { PATH: `/opt/tools${path.delimiter}/usr/bin` };
    expect(withBinOnPath(env, "/opt/tools/agent-browser")).toBe(env);
  });

  it("changes nothing for a bare binary name", () => {
    const env = { PATH: "/usr/bin" };
    expect(withBinOnPath(env, "agent-browser")).toBe(env);
  });
});
