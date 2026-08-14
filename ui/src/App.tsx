/**
 * The application shell: chassis, wayfinding, and the view currently on the readout.
 *
 * **Hash routing, not a router.** This app ships as static files and is often opened straight
 * off disk or from behind a plain file server, because [R-147] says the dashboard needs no
 * server — evidence is files a browser can read over HTTP. A path-based router would 404 on
 * every view but the first under exactly those conditions. A hash cannot.
 *
 * The nav counts come from the data rather than being decoration, and a count of zero is not
 * rendered: a badge reading 0 competes for attention with the badges that mean something.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import type { DashboardView } from "./types.ts";
import { getJson, signOut } from "./api.ts";
import { Login } from "./Login.tsx";
import { Overview } from "./views/Overview.tsx";
import { Runs } from "./views/Runs.tsx";
import { Geography } from "./views/Geography.tsx";
import { Coverage } from "./views/Coverage.tsx";
import { Trends } from "./views/Trends.tsx";
import { Findings } from "./views/Findings.tsx";
import { RunDetail } from "./views/RunDetail.tsx";
import { Settings } from "./views/Settings.tsx";

type ViewId = "overview" | "runs" | "findings" | "geography" | "coverage" | "trends" | "settings";

/** A route is a view, or a drill-down into one run. */
type Route = { view: ViewId; runId?: string };

const VIEWS: { id: ViewId; label: string; group: string }[] = [
  { id: "overview", label: "Overview", group: "Monitor" },
  { id: "runs", label: "Runs", group: "Monitor" },
  { id: "findings", label: "Findings", group: "Monitor" },
  { id: "geography", label: "Geography", group: "Analyse" },
  { id: "coverage", label: "Coverage", group: "Analyse" },
  { id: "trends", label: "Trends", group: "Analyse" },
  { id: "settings", label: "Settings", group: "Configure" },
];

/**
 * `#/runs`, or `#/run/<id>` for a drill-down.
 *
 * A run detail is addressable rather than modal state, so a row can be linked to from a finding,
 * shared in a message, and survive a reload. A console whose deepest page has no URL is one
 * where "look at this run" means "click these four things".
 */
const routeFromHash = (): Route => {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [head, ...rest] = raw.split("/");
  if (head === "run" && rest.length > 0) return { view: "runs", runId: rest.join("/") };
  return { view: VIEWS.some((v) => v.id === head) ? (head as ViewId) : "overview" };
};

export function App(): JSX.Element {
  const [view, setView] = useState<DashboardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  /**
   * Whether there is a session to end.
   *
   * The app cannot infer this from a successful load: a static build and a server with a
   * valid cookie both just work. So it asks — once, after the data is already on screen, so
   * the answer costs nobody a wait. In a static build the request fails and the control stays
   * hidden, which is the correct outcome and the only cost is one 404 in a console nobody is
   * reading. Guessing instead would mean either a returning visitor with a live cookie having
   * no way to sign out, or a static reader being offered a button that cannot work.
   */
  const [servedWithSession, setServedWithSession] = useState(false);
  const [route, setRoute] = useState<Route>(routeFromHash);

  useEffect(() => {
    const onHash = (): void => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // The tab title follows the view. With five of them, a static title makes two open tabs
  // indistinguishable — and this is a console somebody keeps open beside their work.
  useEffect(() => {
    document.title = route.runId
      ? `geoqa — run ${route.runId}`
      : `geoqa — ${VIEWS.find((v) => v.id === route.view)?.label.toLowerCase() ?? "runs"}`;
  }, [route]);

  /**
   * Load the dashboard, and let its answer tell us which mode we are in.
   *
   * One request, not two. Asking `/api/whoami` first would be a round trip whose only purpose
   * is to decide whether to make the request we were going to make anyway — and it would
   * break the static case outright, because a plain file server has no `/api`.
   *
   * The three outcomes map exactly onto the three states this app can be in: served with a
   * session (or opened as static files, where there is no session to have), served without
   * one, or genuinely broken. That is why `getJson` returns three things rather than throwing
   * on two of them.
   */
  const load = useCallback((): void => {
    void getJson<DashboardView>("./dashboard.json").then((result) => {
      if (result.ok) {
        setView(result.value);
        setNeedsSignIn(false);
        setError(null);
        void getJson<{ user: string }>("/api/whoami").then((who) => setServedWithSession(who.ok));
        return;
      }
      if (result.signedOut) {
        setNeedsSignIn(true);
        return;
      }
      setError(result.error);
    });
  }, []);

  useEffect(load, [load]);

  // Checked before the error and before the data: being signed out is not a failure, and a
  // reader who needs to sign in is not helped by being told something went wrong first.
  if (needsSignIn) return <Login onSignedIn={load} />;

  if (error !== null) {
    return (
      <div className="err">
        Could not load <code>dashboard.json</code>: {error}
        <br />
        Run <code>geoqa dashboard build</code>, then serve this directory beside the file it wrote.
      </div>
    );
  }
  if (view === null) return <div className="load">reading dashboard.json…</div>;

  // Counts that mean "somebody has to look at this". Coverage gaps are included because a page
  // never measured in a market is not a page that works there, and the count is the only thing
  // that will make a reader open the view.
  const counts: Record<ViewId, number> = {
    overview: 0,
    runs: view.runs.length,
    // Distinct failing CHECKS, not total findings: the number somebody has to work through.
    findings: new Set(view.runs.flatMap((r) => r.findings.labels)).size,
    geography: view.site.geographicallyDivergent.length,
    coverage: view.site.coverageGaps.length,
    trends: view.trends.length,
    // No badge: a settings page has nothing a number could usefully say about it.
    settings: 0,
  };
  const alerts: Record<string, boolean> = {
    findings: view.runs.some((r) => r.findings.total > 0),
    geography: view.site.geographicallyDivergent.length > 0,
    coverage: view.site.coverageGaps.length > 0,
  };

  const groups = [...new Set(VIEWS.map((v) => v.group))];
  const current = VIEWS.find((v) => v.id === route.view);

  return (
    <div className="app">
      <div className="brand">
        <Mark />
        <span className="brand-name">
          geo<b>qa</b>
        </span>
      </div>

      <header className="bar">
        <span className="bar-title">{route.runId === undefined ? current?.label : "Run"}</span>
        <div className="bar-stats">
          <Stat k="runs" v={String(view.summary.total)} />
          <Stat k="confidence" v={view.summary.meanConfidence.text} />
          <Stat k="markets" v={String(view.site.markets.length)} />
          <Stat k="built" v={new Date(view.generatedAt).toISOString().slice(0, 16).replace("T", " ")} />
          {/* Only when there is a session to end. A static build has none, and a sign-out
              control that cannot sign anything out is a button that reports a bug when
              pressed. */}
          {servedWithSession && (
            <button
              className="btn btn-quiet"
              type="button"
              onClick={() => {
                void signOut().then(() => setNeedsSignIn(true));
              }}
            >
              Sign out
            </button>
          )}
        </div>
      </header>

      <nav className="rail" aria-label="Views">
        {groups.map((group) => (
          <div key={group}>
            <div className="rail-group">{group}</div>
            {VIEWS.filter((v) => v.group === group).map((v) => (
              <a
                key={v.id}
                className="nav"
                href={`#/${v.id}`}
                aria-current={route.view === v.id && route.runId === undefined ? "page" : undefined}
              >
                {v.label}
                {counts[v.id] > 0 && (
                  <span className={`count${alerts[v.id] === true ? " alert" : ""}`}>{counts[v.id]}</span>
                )}
              </a>
            ))}
          </div>
        ))}
      </nav>

      <main className="readout">
        {route.runId !== undefined && <RunDetail view={view} runId={route.runId} />}
        {route.runId === undefined && route.view === "overview" && <Overview view={view} />}
        {route.runId === undefined && route.view === "runs" && <Runs view={view} />}
        {route.runId === undefined && route.view === "findings" && <Findings view={view} />}
        {route.runId === undefined && route.view === "geography" && <Geography view={view} />}
        {route.runId === undefined && route.view === "coverage" && <Coverage view={view} />}
        {route.runId === undefined && route.view === "trends" && <Trends view={view} />}
        {route.runId === undefined && route.view === "settings" && <Settings />}
      </main>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <span className="stat">
      <span className="stat-k">{k}</span>
      <span className="stat-v">{v}</span>
    </span>
  );
}

/**
 * The mark: a fix on a grid.
 *
 * Drawn rather than an emoji or an image — it is four shapes, it inherits the signal colour, and
 * it stays crisp at any density. Square crosshair rather than a globe: this is an instrument
 * that takes a reading at a coordinate, and a globe icon would say "international" when the
 * product's actual claim is "measured from exactly here".
 */
function Mark(): JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="19" height="19" stroke="var(--signal)" strokeWidth="1.25" opacity="0.5" />
      <path d="M11 1.5v19M1.5 11h19" stroke="var(--signal)" strokeWidth="1" opacity="0.3" />
      <rect x="7.5" y="7.5" width="7" height="7" stroke="var(--signal)" strokeWidth="1.25" opacity="0.7" />
      <rect x="9.5" y="9.5" width="3" height="3" fill="var(--signal)" />
    </svg>
  );
}
