import { describe, expect, it } from "vitest";
import { createRepairGate, keysFromBody } from "../repair-control.js";

describe("keysFromBody", () => {
  it("an empty body means every filed ticket, not an empty list", () => {
    expect(keysFromBody("")).toEqual({ ok: true });
    expect(keysFromBody("{}")).toEqual({ ok: true });
    expect(keysFromBody(JSON.stringify({ n: 1 }))).toEqual({ ok: true });
  });

  it("names the keys a row asked to fix", () => {
    expect(keysFromBody(JSON.stringify({ keys: ["site:x", "urgent:y"] }))).toEqual({
      ok: true,
      keys: ["site:x", "urgent:y"],
    });
  });

  it("an empty keys array is a real choice: fix nothing", () => {
    expect(keysFromBody(JSON.stringify({ keys: [] }))).toEqual({ ok: true, keys: [] });
  });

  it("REFUSES a body that is not an object with an optional keys array", () => {
    expect(keysFromBody("not json").ok).toBe(false);
    expect(keysFromBody("[]").ok).toBe(false);
    expect(keysFromBody(JSON.stringify({ keys: "site:x" })).ok).toBe(false);
    expect(keysFromBody(JSON.stringify({ keys: [1] })).ok).toBe(false);
  });
});

describe("createRepairGate", () => {
  it("starts once, then refuses a second start until it finishes", () => {
    const gate = createRepairGate();
    const first = gate.begin();
    expect(first.started).toBe(true);
    expect(first.running).toBe(true);
    expect(gate.begin().started).toBe(false);
    expect(gate.begin().reason).toBe("already running");
    gate.finish("opened 1");
    expect(gate.status().running).toBe(false);
    expect(gate.status().last).toBe("opened 1");
    expect(gate.begin().started).toBe(true);
  });

  it("a queued count of zero is nothing to fix, not a start", () => {
    const gate = createRepairGate();
    const out = gate.begin(0);
    expect(out.started).toBe(false);
    expect(out.reason).toBe("nothing to fix");
    expect(gate.status().running).toBe(false);
  });

  it("counts a finished job so the console can say how far it is", () => {
    const gate = createRepairGate();
    gate.begin(2);
    gate.note("opened site:x", "done");
    gate.note("FAILED urgent:y", "failed");
    expect(gate.status()).toMatchObject({ queued: 2, done: 1, failed: 1, last: "FAILED urgent:y" });
  });
});
