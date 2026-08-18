/**
 * The control plane the console talks to: watch state, live sessions, a
 * forced start.
 *
 * Pure request handling. The loop that actually launches browsers lives in
 * `watch-loop.ts` (I/O, coverage-excluded). Everything a test can assert
 * about "did this POST do the right thing" is here.
 */
/** Structural — the same shape `router.ts` uses, without importing it (a cycle). */
interface ControlRequest {
  method: string;
  path: string;
  body: string;
}

interface ControlResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ControlResult<T> {
  ok: true;
  value: T;
}

export interface ControlFailure {
  ok: false;
  error: string;
}

export type ControlOutcome<T> = ControlResult<T> | ControlFailure;

export interface ControlDeps {
  watch: () => unknown;
  saveWatch: (body: unknown) => ControlOutcome<unknown>;
  addTarget: (body: unknown) => ControlOutcome<unknown>;
  removeTarget: (body: unknown) => ControlOutcome<unknown>;
  startNow: () => ControlOutcome<unknown>;
  /** Persisted operator log — stalls, sweep failures. Survives a restart. */
  watchLog: () => unknown;
  live: () => unknown;
  liveFrame: (id: string) => { mime: string; data: string } | null;
  /** One session, by board id or by the run id the engine named. */
  liveSession: (id: string) => unknown | null;
  /** Start one journey. Same runtime as `geoqa run`. */
  runNow: (body: unknown) => ControlOutcome<unknown>;
  /** Recent control-plane events and whether a run is in flight. */
  runStatus: () => unknown;
}

const json = (status: number, value: unknown): ControlResponse => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(value),
});

const readUrl = (body: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "url" in parsed) {
      const url = (parsed as { url: unknown }).url;
      return typeof url === "string" ? url : null;
    }
  } catch {
    return null;
  }
  return null;
};

const liveFrameId = (path: string): string | null => {
  const match = /^\/api\/live\/([^/]+)\/frame$/.exec(path);
  return match?.[1] ?? null;
};

/**
 * Routes under `/api/watch` and `/api/live`.
 *
 * Session is already checked by the caller. A missing `control` is a 404 with
 * a reason — the static console has no watch, and a bare 404 reads as a
 * broken install.
 */
export function routeControl(request: ControlRequest, control: ControlDeps | undefined): ControlResponse {
  if (control === undefined) {
    return json(404, { error: "watch is not available on this console — run `geoqa server`" });
  }

  const { method, path } = request;

  if (path === "/api/watch" && method === "GET") return json(200, control.watch());
  if (path === "/api/watch/log" && method === "GET") return json(200, control.watchLog());
  if (path === "/api/watch" && method === "PUT") {
    const parsed = safeObject(request.body);
    if (parsed === null) return json(400, { error: "a watch patch must be a JSON object" });
    const out = control.saveWatch(parsed);
    return out.ok ? json(200, out.value) : json(400, { error: out.error });
  }
  if (path === "/api/watch/targets" && method === "POST") {
    const url = readUrl(request.body);
    if (url === null) return json(400, { error: "a target url is required" });
    const out = control.addTarget({ url });
    return out.ok ? json(200, out.value) : json(400, { error: out.error });
  }
  if (path === "/api/watch/targets" && method === "DELETE") {
    const url = readUrl(request.body);
    if (url === null) return json(400, { error: "a target url is required" });
    const out = control.removeTarget({ url });
    return out.ok ? json(200, out.value) : json(400, { error: out.error });
  }
  if (path === "/api/watch/start" && method === "POST") {
    const out = control.startNow();
    return out.ok ? json(200, out.value) : json(409, { error: out.error });
  }
  if (path === "/api/live" && method === "GET") return json(200, control.live());
  const sessionId = /^\/api\/live\/([^/]+)$/.exec(path)?.[1];
  if (sessionId !== undefined && method === "GET") {
    const session = control.liveSession(sessionId);
    if (session === null) return json(404, { error: "no live session with that id" });
    return json(200, session);
  }
  if (path === "/api/run" && method === "GET") return json(200, control.runStatus());
  if (path === "/api/run" && method === "POST") {
    const parsed = safeObject(request.body);
    if (parsed === null) return json(400, { error: "a run request must be a JSON object" });
    const out = control.runNow(parsed);
    return out.ok ? json(202, out.value) : json(400, { error: out.error });
  }

  const frameId = liveFrameId(path);
  if (frameId !== null && method === "GET") {
    const frame = control.liveFrame(frameId);
    if (frame === null) return json(404, { error: "no frame for this session" });
    return json(200, frame);
  }

  return json(404, { error: `no such endpoint: ${method} ${path}` });
}

const safeObject = (body: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(body === "" ? "{}" : body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};
