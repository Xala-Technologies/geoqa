import { describe, expect, it, vi } from "vitest";
import { AgentBrowserRuntime, mapOk, type ExecFn } from "../agent-browser.js";
import type { ExecOutcome } from "../exec.js";

const meta = { stdout: "", stderr: "", durationMs: 1, command: "cmd" };
const ok = (data: unknown): ExecOutcome<unknown> => ({ ok: true, data, ...meta });
const fail = (): ExecOutcome<unknown> => ({
  ok: false,
  failure: { kind: "exit", detail: "boom", exitCode: 1, signal: null },
  ...meta,
});

/** Records every argv the runtime issues, and replies with a canned payload. */
function recorder(reply: unknown = {}): { exec: ExecFn; calls: string[][]; envs: NodeJS.ProcessEnv[] } {
  const calls: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const exec: ExecFn = (args, env) => {
    calls.push(args);
    envs.push(env);
    return Promise.resolve(ok(reply));
  };
  return { exec, calls, envs };
}

const make = (reply: unknown = {}) => {
  const rec = recorder(reply);
  return { rt: new AgentBrowserRuntime({ sessionId: "run1" }, { exec: rec.exec }), ...rec };
};

describe("mapOk", () => {
  it("maps the payload on success and preserves the metadata", () => {
    const out = mapOk(ok({ n: 1 }), (d) => (d as { n: number }).n * 2);
    expect(out).toEqual({ ok: true, data: 2, ...meta });
  });

  it("passes a failure through untouched, without running the mapper", () => {
    const mapper = vi.fn();
    expect(mapOk(fail(), mapper)).toEqual(fail());
    expect(mapper).not.toHaveBeenCalled();
  });
});

describe("AgentBrowserRuntime", () => {
  it("exposes the session id", () => {
    expect(make().rt.sessionId).toBe("run1");
  });

  it("issues session globals then the command then --json", async () => {
    const { rt, calls } = make({ url: "u", title: "t", targetId: "x" });
    await rt.open("https://example.com");
    expect(calls[0]).toEqual(["--session", "run1", "open", "https://example.com", "--json"]);
  });

  it("layers the session env over the base env, so a profile's TZ wins", async () => {
    const rec = recorder();
    const rt = new AgentBrowserRuntime(
      { sessionId: "run1", env: { TZ: "Europe/Berlin" } },
      { exec: rec.exec, env: { TZ: "Europe/Oslo", PATH: "/usr/bin" } },
    );
    await rt.getTitle();
    expect(rec.envs[0]).toEqual({ TZ: "Europe/Berlin", PATH: "/usr/bin" });
  });

  it("rebuilds the launch flags on every command, so a later call cannot hit a different browser", async () => {
    const rec = recorder();
    const rt = new AgentBrowserRuntime(
      { sessionId: "run1", namespace: "oslo", proxy: "http://p:1", initScripts: ["/l.js"] },
      { exec: rec.exec },
    );
    await rt.open("https://a");
    await rt.getTitle();
    expect(rec.calls[0]?.slice(0, 8)).toEqual(rec.calls[1]?.slice(0, 8));
    expect(rec.calls[1]).toContain("--init-script");
  });

  it("maps open and reload through the navigate mapper", async () => {
    const { rt } = make({ url: "https://x/", title: "T", targetId: "id" });
    for (const out of [await rt.open("https://x"), await rt.reload()]) {
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("expected ok");
      expect(out.data).toMatchObject({ url: "https://x/", title: "T" });
    }
  });

  it("parses a JSON-shaped eval result", async () => {
    const { rt, calls } = make({ result: '{"lang":"de-DE"}' });
    const out = await rt.evaluate<{ lang: string }>("navigator.language");
    if (!out.ok) throw new Error("expected ok");
    expect(out.data).toEqual({ lang: "de-DE" });
    expect(calls[0]).toContain("eval");
  });

  it("returns an unparseable eval result as the raw string", async () => {
    const { rt } = make({ result: "not json" });
    const out = await rt.evaluate<string>("1");
    if (!out.ok) throw new Error("expected ok");
    expect(out.data).toBe("not json");
  });

  it("reads text, title, url, count and visibility", async () => {
    const cases: [Promise<ExecOutcome<unknown>>, unknown][] = [
      [make({ text: "Example" }).rt.getText("h1"), "Example"],
      [make({ title: "T" }).rt.getTitle(), "T"],
      [make({ url: "https://x/" }).rt.getUrl(), "https://x/"],
      [make({ count: 2 }).rt.count("p"), 2],
      [make({ visible: true }).rt.isVisible("h1"), true],
    ];
    for (const [p, expected] of cases) {
      const out = await p;
      if (!out.ok) throw new Error("expected ok");
      expect(out.data).toEqual(expected);
    }
  });

  it("passes snapshot options through and returns the tree", async () => {
    const { rt, calls } = make({ snapshot: "- heading" });
    const out = await rt.snapshot({ interactiveOnly: true });
    if (!out.ok) throw new Error("expected ok");
    expect(out.data).toBe("- heading");
    expect(calls[0]).toEqual(["--session", "run1", "snapshot", "-i", "--json"]);
    const bare = make({ snapshot: "" });
    await bare.rt.snapshot();
    expect(bare.calls[0]).toEqual(["--session", "run1", "snapshot", "--json"]);
  });

  it("issues the interaction commands verbatim", async () => {
    const { rt, calls } = make();
    await rt.click("@e2");
    await rt.scroll("down", 500);
    await rt.scroll("up");
    await rt.waitFor("main");
    expect(calls.map((c) => c.slice(2, -1))).toEqual([
      ["click", "@e2"],
      ["scroll", "down", "500"],
      ["scroll", "up"],
      ["wait", "main"],
    ]);
  });

  it("issues the environment commands, stringifying numbers and headers", async () => {
    const { rt, calls } = make();
    await rt.setViewport(390, 844);
    await rt.setDevice("iPhone 15 Pro");
    await rt.setGeo(52.52, 13.405);
    await rt.setHeaders({ "Accept-Language": "de-DE" });
    expect(calls.map((c) => c.slice(2, -1))).toEqual([
      ["set", "viewport", "390", "844"],
      ["set", "device", "iPhone 15 Pro"],
      ["set", "geo", "52.52", "13.405"],
      ["set", "headers", '{"Accept-Language":"de-DE"}'],
    ]);
  });

  it("issues the evidence commands", async () => {
    const { rt, calls } = make();
    await rt.screenshot("/e/a.png", { fullPage: true });
    await rt.harStart();
    await rt.harStop("/e/n.har");
    await rt.traceStart();
    await rt.traceStop("/e/t.json");
    await rt.close();
    expect(calls.map((c) => c.slice(2, -1))).toEqual([
      ["screenshot", "/e/a.png", "--full"],
      ["network", "har", "start"],
      ["network", "har", "stop", "/e/n.har"],
      ["trace", "start"],
      ["trace", "stop", "/e/t.json"],
      ["close"],
    ]);
    const plain = make();
    await plain.rt.screenshot("/e/b.png");
    expect(plain.calls[0]?.slice(2, -1)).toEqual(["screenshot", "/e/b.png"]);
  });

  it("maps console, errors, network, vitals and a11y", async () => {
    const c = make({ messages: [{ type: "error", text: "bad" }] });
    const consoleOut = await c.rt.console();
    if (!consoleOut.ok) throw new Error("expected ok");
    expect(consoleOut.data).toEqual([{ type: "error", text: "bad" }]);

    const e = make({ errors: [{ text: "boom", url: null }] });
    const errOut = await e.rt.errors();
    if (!errOut.ok) throw new Error("expected ok");
    expect(errOut.data).toEqual([{ message: "boom", stack: null }]);

    const n = make({ requests: [{ url: "https://x/", method: "GET", status: 200, resourceType: "Document" }] });
    const netOut = await n.rt.networkRequests();
    if (!netOut.ok) throw new Error("expected ok");
    expect(netOut.data).toHaveLength(1);

    const v = make({ lcp: { startTime: 44 }, cls: { score: 0 }, ttfb: 7.6, fcp: 44, inp: null });
    const vitalsOut = await v.rt.vitals();
    if (!vitalsOut.ok) throw new Error("expected ok");
    expect(vitalsOut.data).toMatchObject({ lcp: 44, inp: null });

    const a = make({ violations: [{ id: "landmark-one-main", impact: "moderate", help: "h", nodeCount: 1 }] });
    const a11yOut = await a.rt.a11y();
    if (!a11yOut.ok) throw new Error("expected ok");
    expect(a11yOut.data).toEqual([{ id: "landmark-one-main", impact: "moderate", help: "h", nodes: 1 }]);
  });

  const notFound = (): ExecOutcome<unknown> => ({
    ok: false,
    failure: { kind: "reported", detail: "Element not found: h1. Verify the selector…", exitCode: 0, signal: null },
    ...meta,
  });

  it("treats a CONFIRMED missing element as not-visible, because that is the answer to the question", async () => {
    // agent-browser reports `Element not found` as success:false. Passing it
    // through made "the page has no CTA" indistinguishable from "the browser
    // broke", so a real site defect was filed against us. EXP-006 detection was
    // 75% before this, 100% after.
    const exec: ExecFn = () => Promise.resolve(notFound());
    const out = await new AgentBrowserRuntime({ sessionId: "r" }, { exec, absenceSettleMs: 1 }).isVisible("h1");
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.data).toBe(false);
  });

  it("RETRIES once before calling an element absent — a first miss may just be a page that has not rendered", async () => {
    // The defect this exists for: under concurrent load the same "Element not
    // found" fires for a heading that is demonstrably present. Measured with
    // ~55 concurrent browsers, a real h1 failed 3 of 4 runs and passed every
    // time it ran alone. A single miss is not evidence of absence.
    const calls: string[][] = [];
    const exec: ExecFn = (args) => {
      calls.push(args);
      const isCheck = args.includes("visible");
      // Miss first, then find it — exactly the not-ready-yet shape.
      if (isCheck && calls.filter((c) => c.includes("visible")).length === 1) return Promise.resolve(notFound());
      return Promise.resolve({ ok: true, data: { visible: true }, ...meta });
    };
    const out = await new AgentBrowserRuntime({ sessionId: "r" }, { exec, absenceSettleMs: 5 }).isVisible("h1");
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.data).toBe(true);
    // Settled between the two looks rather than hammering immediately.
    expect(calls.map((c) => c.slice(2, -1))).toEqual([
      ["is", "visible", "h1"],
      ["wait", "5"],
      ["is", "visible", "h1"],
    ]);
  });

  it("RETRIES a plain `visible: false` too — an entrance animation reads as invisible", async () => {
    // xala.no's h1 fades in from opacity 0. The check ran during the fade and
    // failed 4 of 4 runs — deterministic, not flaky. A negative arriving as
    // `false` deserves the same confirmation as one arriving as an error.
    let checks = 0;
    const exec: ExecFn = (args) => {
      if (!args.includes("visible")) return Promise.resolve({ ok: true, data: null, ...meta });
      checks++;
      return Promise.resolve({ ok: true, data: { visible: checks > 1 }, ...meta });
    };
    const out = await new AgentBrowserRuntime({ sessionId: "r" }, { exec, absenceSettleMs: 5 }).isVisible("h1");
    if (!out.ok) throw new Error("expected ok");
    expect(out.data).toBe(true);
    expect(checks).toBe(2);
  });

  it("keeps a `false` that SURVIVES the retry — a genuinely hidden element stays hidden", async () => {
    const exec: ExecFn = () => Promise.resolve({ ok: true, data: { visible: false }, ...meta });
    const out = await new AgentBrowserRuntime({ sessionId: "r" }, { exec, absenceSettleMs: 5 }).isVisible("h1");
    if (!out.ok) throw new Error("expected ok");
    expect(out.data).toBe(false);
  });

  it("does not retry when the element is found first time — the common path costs nothing", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = (args) => {
      calls.push(args);
      return Promise.resolve({ ok: true, data: { visible: true }, ...meta });
    };
    await new AgentBrowserRuntime({ sessionId: "r" }, { exec }).isVisible("h1");
    expect(calls).toHaveLength(1);
  });

  it("does NOT swallow any other failure on isVisible — those really are our defect", async () => {
    for (const failure of [
      { kind: "timeout" as const, detail: "Element not found", exitCode: null, signal: null },
      { kind: "reported" as const, detail: "daemon is gone", exitCode: 0, signal: null },
    ]) {
      const exec: ExecFn = () => Promise.resolve({ ok: false, failure, ...meta });
      const out = await new AgentBrowserRuntime({ sessionId: "r" }, { exec }).isVisible("h1");
      expect(out.ok, failure.kind).toBe(false);
    }
  });

  it("propagates a transport failure instead of returning empty data", async () => {
    const exec: ExecFn = () => Promise.resolve(fail());
    const rt = new AgentBrowserRuntime({ sessionId: "r" }, { exec });
    const out = await rt.console();
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected failure");
    expect(out.failure.kind).toBe("exit");
  });

  it("builds a real exec closure when none is injected, honouring bin and timeouts", async () => {
    // No `exec` override: exercises the default branch that constructs
    // execAgentBrowser options. `/nonexistent` fails to spawn, which is the
    // outcome we assert — the point is that the closure was built and called.
    const rt = new AgentBrowserRuntime(
      { sessionId: "r" },
      { bin: "/nonexistent/agent-browser", env: { PATH: "" }, timeoutMs: 500, idleMs: 500 },
    );
    const out = await rt.getTitle();
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected failure");
    expect(out.failure.kind).toBe("spawn");
  });

  it("builds the default exec closure with no bin or timeout overrides", async () => {
    const rt = new AgentBrowserRuntime({ sessionId: "r" }, { env: { PATH: "/nonexistent" } });
    const out = await rt.close();
    expect(out.ok).toBe(false);
  });
});

describe("input", () => {
  it("fills, presses, selects and checks through the CLI", async () => {
    const { rt, calls } = make();
    await rt.fill("#email", "qa@example.test");
    await rt.press("Enter");
    await rt.select("#topic", ["support", "billing"]);
    await rt.check("#consent");
    expect(calls[0]).toEqual(["--session", "run1", "fill", "#email", "qa@example.test", "--json"]);
    expect(calls[1]).toEqual(["--session", "run1", "press", "Enter", "--json"]);
    expect(calls[2]).toEqual(["--session", "run1", "select", "#topic", "support", "billing", "--json"]);
    expect(calls[3]).toEqual(["--session", "run1", "check", "#consent", "--json"]);
  });

  it("MASKS the filled value in the outcome's command string", async () => {
    // `command` is kept so a failing call is reproducible by hand. For this one
    // command that would write a password into every evidence package that
    // recorded the outcome, so the reproducibility is deliberately given up.
    const { rt } = make();
    const out = await rt.fill("#password", "hunter2-the-real-one");
    expect(out.command).toBe("fill #password <redacted>");
    expect(JSON.stringify(out)).not.toContain("hunter2-the-real-one");
  });

  it("still reports a failed fill as a failure", async () => {
    const rt = new AgentBrowserRuntime({ sessionId: "r" }, { exec: () => Promise.resolve(fail()) });
    const out = await rt.fill("#email", "x");
    expect(out.ok).toBe(false);
    expect(out.command).toBe("fill #email <redacted>");
  });
});

describe("visibleCount", () => {
  it("REFUSES rather than answering with a hidden-inclusive count", async () => {
    // `get count` includes hidden elements, so returning it here would report an unambiguous
    // click as having had ten candidates. A named refusal costs the caller a note in the
    // report; a wrong number costs them a wrong conclusion about their own page.
    const { rt, calls } = make({ count: 12 });
    const out = await rt.visibleCount("nav a");
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.failure.kind).toBe("reported");
    expect(out.stderr).toContain("visible-only");
    expect(out.stderr).toContain("--engine playwright");
    // And it does not reach the browser at all — no cost, no misleading argv in the evidence.
    expect(calls).toEqual([]);
  });
});

describe("close", () => {
  it("closes once, and answers ok without touching the daemon a second time", async () => {
    // `executeRun`'s finally closes, and so does any caller that closed explicitly. Re-running
    // `close` against a daemon that has already gone reports a transport failure for a close
    // that succeeded.
    const { rt, calls } = make({});
    expect((await rt.close()).ok).toBe(true);
    const again = await rt.close();
    expect(again.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("close");
  });
});

describe("getText settles an EMPTY reading", () => {
  it("confirms an empty read on the DEFAULT engine too", async () => {
    // Leaving this to the Playwright adapter would give the default engine the weaker
    // protection. `assertions.ts` refuses a still-empty read on either engine, so the safety
    // property held regardless — what the retry adds is the difference between a genuine PASS
    // and an honest refusal, and a run that could have read the page should read it.
    const replies = [{ text: "" }, { text: "Vi bygger saksbehandlingssystemer" }];
    const calls: string[][] = [];
    let i = 0;
    const exec: ExecFn = (args) => {
      calls.push(args);
      if (args.includes("wait")) return Promise.resolve(ok({}));
      return Promise.resolve(ok(replies[i++] ?? {}));
    };
    const rt = new AgentBrowserRuntime({ sessionId: "run1" }, { exec });
    const out = await rt.getText("body");
    expect(out.ok && out.data).toBe("Vi bygger saksbehandlingssystemer");
    expect(calls.some((c) => c.includes("wait"))).toBe(true);
  });

  it("does NOT re-read a page that rendered text and simply lacks the value", async () => {
    const { rt, calls } = make({ text: "hello" });
    expect((await rt.getText("body")).ok).toBe(true);
    expect(calls.some((c) => c.includes("wait"))).toBe(false);
  });
});
