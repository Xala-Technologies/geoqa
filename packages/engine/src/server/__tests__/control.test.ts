import { describe, expect, it } from "vitest";
import { routeControl, type ControlDeps } from "../control.js";

const control = (over: Partial<ControlDeps> = {}): ControlDeps => ({
  watch: () => ({ enabled: false }),
  saveWatch: () => ({ ok: true, value: { enabled: true } }),
  addTarget: () => ({ ok: true, value: { targets: ["https://digilist.no"] } }),
  removeTarget: () => ({ ok: true, value: { targets: [] } }),
  startNow: () => ({ ok: true, value: { started: true } }),
  live: () => ({ sessions: [], inFlight: 0 }),
  liveFrame: () => null,
  liveSession: () => null,
  runNow: () => ({ ok: true, value: { started: true } }),
  runStatus: () => ({ inFlight: 0, events: [] }),
  ...over,
});

const req = (path: string, method = "GET", body = ""): { method: string; path: string; body: string } => ({
  method,
  path,
  body,
});

describe("routeControl", () => {
  it("says watch is unavailable when this console has no control plane", () => {
    const out = routeControl(req("/api/watch"), undefined);
    expect(out.status).toBe(404);
    expect(out.body).toContain("geoqa server");
  });

  it("returns the current watch and the live board", () => {
    const c = control();
    expect(JSON.parse(routeControl(req("/api/watch"), c).body)).toEqual({ enabled: false });
    expect(JSON.parse(routeControl(req("/api/live"), c).body)).toEqual({ sessions: [], inFlight: 0 });
  });

  it("saves a watch patch and refuses a body that is not an object", () => {
    const c = control();
    expect(routeControl(req("/api/watch", "PUT", '{"enabled":true}'), c).status).toBe(200);
    expect(routeControl(req("/api/watch", "PUT", ""), c).status).toBe(200);
    expect(routeControl(req("/api/watch", "PUT", "null"), c).status).toBe(400);
    expect(routeControl(req("/api/watch", "PUT", "not json"), c).status).toBe(400);
    expect(routeControl(req("/api/watch", "PUT", "[1]"), c).status).toBe(400);
  });

  it("adds and removes a target, and names a missing url", () => {
    const c = control();
    expect(routeControl(req("/api/watch/targets", "POST", '{"url":"https://xala.no"}'), c).status).toBe(200);
    expect(routeControl(req("/api/watch/targets", "DELETE", '{"url":"https://xala.no"}'), c).status).toBe(200);
    expect(JSON.parse(routeControl(req("/api/watch/targets", "POST", "{}"), c).body).error).toContain("url");
    expect(routeControl(req("/api/watch/targets", "POST", "not json"), c).status).toBe(400);
    expect(routeControl(req("/api/watch/targets", "DELETE", '{"url":1}'), c).status).toBe(400);
  });

  it("starts a sweep, and surfaces a refusal as 409 rather than 200", () => {
    expect(routeControl(req("/api/watch/start", "POST"), control()).status).toBe(200);
    const busy = control({ startNow: () => ({ ok: false, error: "a sweep is already in flight" }) });
    expect(routeControl(req("/api/watch/start", "POST"), busy).status).toBe(409);
  });

  it("returns one live session by id, or says there is none", () => {
    const session = { id: "run_1", market: "alesund", steps: [{ index: 0, label: "open target" }] };
    const c = control({
      liveSession: (id) => (id === "run_1" || id === "run_1_alesund-desktop-landing-page-0" ? session : null),
    });
    expect(JSON.parse(routeControl(req("/api/live/run_1"), c).body)).toEqual(session);
    expect(JSON.parse(routeControl(req("/api/live/run_1_alesund-desktop-landing-page-0"), c).body)).toEqual(session);
    expect(routeControl(req("/api/live/missing"), c).status).toBe(404);
  });

  it("returns a live frame or says there is none", () => {
    const c = control({
      liveFrame: (id) => (id === "run_1" ? { mime: "image/png", data: "abc" } : null),
    });
    expect(JSON.parse(routeControl(req("/api/live/run_1/frame"), c).body)).toEqual({ mime: "image/png", data: "abc" });
    expect(routeControl(req("/api/live/missing/frame"), c).status).toBe(404);
  });

  it("accepts a run and surfaces a refusal as 400", () => {
    expect(routeControl(req("/api/run", "POST", '{"url":"https://digilist.no"}'), control()).status).toBe(202);
    expect(JSON.parse(routeControl(req("/api/run"), control()).body)).toEqual({ inFlight: 0, events: [] });
    expect(routeControl(req("/api/run", "POST", "null"), control()).status).toBe(400);
    const refused = control({ runNow: () => ({ ok: false, error: "no such city" }) });
    expect(routeControl(req("/api/run", "POST", '{"url":"https://x"}'), refused).status).toBe(400);
  });

  it("404s an unknown control path rather than falling through", () => {
    const out = routeControl(req("/api/watch/nope"), control());
    expect(out.status).toBe(404);
    expect(out.body).toContain("no such endpoint");
  });

  it("passes a save refusal through as 400 with the store's own words", () => {
    const c = control({ saveWatch: () => ({ ok: false, error: "no such journey: nope" }) });
    const out = routeControl(req("/api/watch", "PUT", '{"journeys":["nope"]}'), c);
    expect(out.status).toBe(400);
    expect(JSON.parse(out.body).error).toContain("nope");
  });

  it("passes an add/remove refusal through as 400", () => {
    const c = control({
      addTarget: () => ({ ok: false, error: "already on the list" }),
      removeTarget: () => ({ ok: false, error: "not on the list" }),
    });
    expect(JSON.parse(routeControl(req("/api/watch/targets", "POST", '{"url":"https://x"}'), c).body).error).toContain(
      "already",
    );
    expect(JSON.parse(routeControl(req("/api/watch/targets", "DELETE", '{"url":"https://x"}'), c).body).error).toContain(
      "not on the list",
    );
  });
});
