/**
 * The operator surface: which URLs to visit, from which markets, how often.
 *
 * Settings stays read-only — it reports the files the engine already reads.
 * This page is the one that writes `tenants/<id>/watch.yaml`. A second author
 * of the tenant file would destroy the comments that file exists to carry.
 */
import { useCallback, useEffect, useState, type FormEvent, type JSX } from "react";
import { getJson, sendJson } from "../api.ts";
import { WatchHealth, type WatchHealthView, type WatchLogLine } from "./WatchHealth.tsx";

interface JourneyInfo {
  id: string;
  title: string;
  writes: boolean;
}

interface WatchSpec {
  enabled: boolean;
  mode: "periodic" | "continuous";
  everyMinutes: number;
  restSeconds: number;
  markets: string[];
  devices: ("mobile" | "desktop")[];
  journeys: string[];
  targets: string[];
  maxConcurrent: number;
  allowWrites: boolean;
  journeyPick?: "all" | "seeded";
  e2e?: {
    everyMinutes: number;
    journeys: { market: string; device: string; journey: string; url: string }[];
  };
  targetJourneys?: Record<string, string[]>;
}

interface WatchView {
  tenantId: string;
  tenantName: string;
  spec: WatchSpec;
  allowedMarkets: string[];
  availableJourneys: JourneyInfo[];
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  inFlight: number;
  nextDueAt: string | null;
  decision: { action: string; reason: string };
  health?: WatchHealthView;
  log?: WatchLogLine[];
}

export function Watch(): JSX.Element {
  const [data, setData] = useState<WatchView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback((): void => {
    void getJson<WatchView>("/api/watch").then((result) => {
      if (result.ok) {
        setData(result.value);
        setProblem(null);
        return;
      }
      setProblem(result.signedOut ? "this console is not signed in" : result.error);
    });
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 3_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = (label: string, work: Promise<{ ok: true } | { ok: false; signedOut: boolean; error?: string }>): void => {
    setBusy(label);
    void work.then((result) => {
      setBusy(null);
      if ("ok" in result && result.ok) {
        load();
        return;
      }
      if ("signedOut" in result && result.signedOut) {
        setProblem("this console is not signed in");
        return;
      }
      setProblem("error" in result && typeof result.error === "string" ? result.error : "request failed");
    });
  };

  if (problem !== null && data === null) {
    return (
      <>
        <div className="head">
          <p className="hint">
            Periodic and continuous sweeps against the URLs you name. Needs <code>geoqa server</code> — a static
            build can read evidence, it cannot start a browser.
          </p>
        </div>
        <div className="empty">
          <strong>Watch is not running.</strong>
          {problem}
        </div>
      </>
    );
  }
  if (data === null) return <div className="load">reading watch…</div>;

  const { spec } = data;
  const journeyPick = spec.journeyPick ?? "all";
  const patch = (body: Partial<WatchSpec>): void => {
    act("Saving…", sendJson("/api/watch", "PUT", body));
  };

  const add = (event: FormEvent): void => {
    event.preventDefault();
    if (draft.trim() === "") return;
    act("Adding…", sendJson("/api/watch/targets", "POST", { url: draft.trim() }));
    setDraft("");
  };

  return (
    <>
      <div className="head">
        <p className="hint">
          {data.tenantName} — each sweep mints a new proxy session, so the residential pool rotates the exit.
          A writes journey stays off unless you turn on <b>allow writes</b>.
        </p>
      </div>

      {problem !== null && <div className="note">{problem}</div>}

      {data.health !== undefined ? <WatchHealth health={data.health} log={data.log ?? []} /> : null}

      <div className="panel">
        <div className="panel-head">
          <h3>Cadence</h3>
          <p className="hint">
            {data.decision.reason}
            {data.nextDueAt !== null ? ` · next ${data.nextDueAt.slice(11, 16)} UTC` : ""}
            {data.lastStartedAt !== null ? ` · last start ${data.lastStartedAt.slice(11, 16)} UTC` : ""}
            {data.lastFinishedAt !== null ? ` · last finish ${data.lastFinishedAt.slice(11, 16)} UTC` : ""}
            {data.inFlight > 0 ? ` · ${data.inFlight} in flight` : ""}
          </p>
        </div>
        <div className="watch-row">
          <label className="check">
            <input type="checkbox" checked={spec.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
            Armed
          </label>
          <label className="check">
            <input
              type="radio"
              name="mode"
              checked={spec.mode === "periodic"}
              onChange={() => patch({ mode: "periodic" })}
            />
            Periodic
          </label>
          <label className="check">
            <input
              type="radio"
              name="mode"
              checked={spec.mode === "continuous"}
              onChange={() => patch({ mode: "continuous" })}
            />
            Continuous
          </label>
          {spec.mode === "periodic" ? (
            <label className="field field-inline">
              <span className="field-label">every</span>
              <input
                className="input input-narrow"
                type="number"
                min={5}
                max={1440}
                value={spec.everyMinutes}
                onChange={(e) => patch({ everyMinutes: Number(e.target.value) })}
              />
              <span className="dim">min</span>
            </label>
          ) : (
            <label className="field field-inline">
              <span className="field-label">rest</span>
              <input
                className="input input-narrow"
                type="number"
                min={5}
                max={3600}
                value={spec.restSeconds}
                onChange={(e) => patch({ restSeconds: Number(e.target.value) })}
              />
              <span className="dim">sec</span>
            </label>
          )}
          {(["mobile", "desktop"] as const).map((device) => (
            <label className="check" key={device}>
              <input
                type="checkbox"
                checked={spec.devices.includes(device)}
                onChange={(e) =>
                  patch({
                    devices: e.target.checked
                      ? [...spec.devices, device]
                      : spec.devices.filter((d) => d !== device),
                  })
                }
              />
              {device}
            </label>
          ))}
          <button className="btn btn-primary" type="button" disabled={busy !== null} onClick={() => act("Starting…", sendJson("/api/watch/start", "POST"))}>
            {busy ?? "Run now"}
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Brand URLs</h3>
          <p className="hint">Origins this watch will open. A host without a scheme becomes https.</p>
        </div>
        <form className="watch-row" onSubmit={add}>
          <input
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="app.digilist.no"
            aria-label="Add a URL"
          />
          <button className="btn" type="submit" disabled={busy !== null || draft.trim() === ""}>
            Add
          </button>
        </form>
        {spec.targets.length === 0 ? (
          <div className="empty">
            <strong>No URLs yet.</strong>
            Add one above. A watch with an empty list will not start.
          </div>
        ) : (
          <ul className="target-list">
            {spec.targets.map((url) => (
              <li key={url}>
                <span className="mono">{url}</span>
                <button
                  className="btn btn-quiet"
                  type="button"
                  onClick={() => act("Removing…", sendJson("/api/watch/targets", "DELETE", { url }))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Markets</h3>
          <p className="hint">Norwegian cities first. A market without a profile cannot be selected.</p>
        </div>
        <div className="chip-grid">
          {data.allowedMarkets.map((id) => (
            <label className="check" key={id}>
              <input
                type="checkbox"
                checked={spec.markets.includes(id)}
                onChange={(e) =>
                  patch({
                    markets: e.target.checked ? [...spec.markets, id] : spec.markets.filter((m) => m !== id),
                  })
                }
              />
              {id}
            </label>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Journeys</h3>
          <p className="hint">
            Read-only by default. A journey that submits a form is marked. Seeded pick draws one
            journey per city × URL from this list — same hour, same city, same URL, same journey.
          </p>
        </div>
        <div className="watch-row">
          <label className="check">
            <input
              type="radio"
              name="journeyPick"
              checked={journeyPick === "all"}
              onChange={() => patch({ journeyPick: "all" })}
            />
            Every journey
          </label>
          <label className="check">
            <input
              type="radio"
              name="journeyPick"
              checked={journeyPick === "seeded"}
              onChange={() => patch({ journeyPick: "seeded" })}
            />
            One seeded journey
          </label>
        </div>
        <div className="chip-grid">
          {data.availableJourneys.map((j) => (
            <label className="check" key={j.id}>
              <input
                type="checkbox"
                checked={spec.journeys.includes(j.id)}
                disabled={j.writes && !spec.allowWrites}
                onChange={(e) =>
                  patch({
                    journeys: e.target.checked ? [...spec.journeys, j.id] : spec.journeys.filter((id) => id !== j.id),
                  })
                }
              />
              {j.id}
              {j.writes ? <span className="pill warn">writes</span> : null}
            </label>
          ))}
        </div>
        <label className="check" style={{ marginTop: "var(--s-4)" }}>
          <input type="checkbox" checked={spec.allowWrites} onChange={(e) => patch({ allowWrites: e.target.checked })} />
          Allow writes — submits real forms
        </label>
      </div>

      {Object.keys(spec.targetJourneys ?? {}).length > 0 ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Per-URL journeys</h3>
            <p className="hint">
              These URLs do not draw from the marketing pool. Dashboard login stays
              login-reachable so browse and search never run against the sign-in page.
            </p>
          </div>
          <ul className="target-list">
            {Object.entries(spec.targetJourneys ?? {}).map(([url, pool]) => (
              <li key={url}>
                {url} · {pool.join(", ")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {(spec.e2e?.journeys ?? []).length > 0 ? (
        <div className="panel">
          <div className="panel-head">
            <h3>E2E</h3>
            <p className="hint">
              One cell each, on their own clock — not the city grid. Login, checkout, a form
              that actually submits. Add more here; leave the pulse for geography.
            </p>
            <label className="field field-inline">
              <span className="field-label">every</span>
              <input
                className="input input-narrow"
                type="number"
                min={5}
                max={1440}
                value={spec.e2e?.everyMinutes ?? 720}
                onChange={(e) => patch({ e2e: { everyMinutes: Number(e.target.value) } })}
              />
              <span className="dim">min</span>
            </label>
          </div>
          <ul className="target-list">
            {(spec.e2e?.journeys ?? []).map((row) => (
              <li key={`${row.journey}:${row.url}`}>
                {row.market} · {row.device} · {row.journey} · {row.url}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
