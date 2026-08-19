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
import { getJson, postJson, signOut } from "./api.ts";
import { Login } from "./Login.tsx";
import { Overview } from "./views/Overview.tsx";
import { Runs } from "./views/Runs.tsx";
import { Geography } from "./views/Geography.tsx";
import { Coverage } from "./views/Coverage.tsx";
import { Trends } from "./views/Trends.tsx";
import { Findings } from "./views/Findings.tsx";
import { RunDetail } from "./views/RunDetail.tsx";
import { Settings } from "./views/Settings.tsx";
import { Watch } from "./views/Watch.tsx";
import { Live } from "./views/Live.tsx";
import { Shell } from "./Shell.tsx";
import { navSections, viewMeta } from "./nav.ts";
import { routeFromHash, type ViewId } from "./route.ts";
import { pageLabel } from "./views/geography.ts";

/**
 * `#/runs`, `#/run/<id>` for a finished visit, `#/live/<id>` for one on the board,
 * `#/findings/<key>` for a ticket brief.
 *
 * A live card must stay on Now. Sending it to `#/run/<id>` left the feed and
 * opened a page that only knows the dashboard index — which is rebuilt after
 * the sweep, so the visit you were watching said it did not exist.
 */

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
  /** Null when idle; a message while a rebuild is in flight or has just finished. */
  const [rebuilding, setRebuilding] = useState<string | null>(null);
  const [route, setRoute] = useState(() => routeFromHash(window.location.hash));
  /** Sessions currently on the live board — the badge that says something is on screen. */
  const [liveCount, setLiveCount] = useState(0);

  useEffect(() => {
    const onHash = (): void => setRoute(routeFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // The tab title follows the view. With five of them, a static title makes two open tabs
  // indistinguishable — and this is a console somebody keeps open beside their work.
  useEffect(() => {
    const ticket =
      route.findingKey !== undefined && view !== null ? view.tickets.find((row) => row.key === route.findingKey) : undefined;
    document.title =
      ticket !== undefined
        ? `geoqa — ${ticket.title}`
        : route.pageTarget !== undefined
          ? `geoqa — ${pageLabel(route.pageTarget)}`
          : route.runId
            ? `geoqa — run ${route.runId}`
            : `geoqa — ${viewMeta(route.view)?.label.toLowerCase() ?? "runs"}`;
  }, [route, view]);

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
    const accept = (value: DashboardView): void => {
      setView(value);
      setNeedsSignIn(false);
      setError(null);
      void getJson<{ user: string }>("/api/whoami").then((who) => setServedWithSession(who.ok));
    };

    void getJson<DashboardView>("./dashboard.json").then((result) => {
      if (result.ok) {
        accept(result.value);
        return;
      }
      if (result.signedOut) {
        setNeedsSignIn(true);
        return;
      }
      // A 404 here is not a failed password. Sign-in already succeeded; the index
      // simply has not been written yet. Build it and read again, once.
      if (result.error.includes("no dashboard has been built")) {
        void postJson<{ total: number; warnings: string[] }>("/api/dashboard/rebuild").then((rebuilt) => {
          if (!rebuilt.ok) {
            if (rebuilt.signedOut) setNeedsSignIn(true);
            else setError(rebuilt.error);
            return;
          }
          void getJson<DashboardView>("./dashboard.json").then((again) => {
            if (again.ok) accept(again.value);
            else if (again.signedOut) setNeedsSignIn(true);
            else setError(again.error);
          });
        });
        return;
      }
      setError(result.error);
    });
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    if (!servedWithSession) return;
    let cancelled = false;
    const poll = (): void => {
      void getJson<{ inFlight: number }>("/api/live").then((result) => {
        if (!cancelled && result.ok) setLiveCount(result.value.inFlight);
      });
    };
    poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [servedWithSession]);

  /**
   * Rebuild, then re-read.
   *
   * The console showed whatever `geoqa dashboard build` last wrote, so the `built` stamp in
   * the header was the only clue that a reader was looking at a snapshot — and a stamp is a
   * clue, not an answer. This makes the stamp actionable: press it and it becomes true.
   *
   * It reloads afterwards rather than trusting the response, because the response says what
   * the builder wrote and the view must show what the server will actually serve. Those are
   * the same file, and the way to be sure is to read it.
   */
  const rebuild = useCallback((): void => {
    setRebuilding("Rebuilding…");
    void postJson<{ total: number; warnings: string[] }>("/api/dashboard/rebuild").then((result) => {
      if (result.ok) {
        // Warnings first when there are any: "rebuilt, 32 runs" beside a skipped-lines warning
        // reads as success, and the count is the part that is not the whole story.
        setRebuilding(result.value.warnings[0] ?? `Rebuilt · ${result.value.total} run(s)`);
        load();
        return;
      }
      // A session that lapsed while the page sat open is the realistic failure here, and the
      // useful answer to it is the sign-in screen rather than an error about rebuilding.
      if (result.signedOut) {
        setRebuilding(null);
        setNeedsSignIn(true);
        return;
      }
      setRebuilding(result.error);
    });
  }, [load]);

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
    live: liveCount,
    runs: view.runs.length,
    // Distinct failing CHECKS, not total findings: the number somebody has to work through.
    findings: new Set(view.runs.flatMap((r) => r.findings.labels)).size,
    geography: view.site.geographicallyDivergent.length,
    coverage: view.site.coverageGaps.length,
    trends: view.trends.length,
    // No badge: a settings page has nothing a number could usefully say about it.
    watch: 0,
    settings: 0,
  };
  const alerts: Record<string, boolean> = {
    live: liveCount > 0,
    findings: view.runs.some((r) => r.findings.total > 0),
    geography: view.site.geographicallyDivergent.length > 0,
    coverage: view.site.coverageGaps.length > 0,
    trends: view.allTrends.some((s) => s.direction === "worsening"),
  };

  const current = viewMeta(route.view);
  const run = route.runId === undefined ? undefined : view.runs.find((r) => r.runId === route.runId);
  const ticket =
    route.findingKey === undefined ? undefined : view.tickets.find((row) => row.key === route.findingKey);
  const sections = navSections(route.view, counts, alerts);

  return (
    <Shell
      title="geoqa"
      hint={liveCount ? `${liveCount} waking` : `${view.summary.total} visits`}
      paneTitle={
        run !== undefined
          ? run.journeyId
          : ticket !== undefined
            ? ticket.title
            : route.pageTarget !== undefined
              ? pageLabel(route.pageTarget)
              : route.liveId !== undefined
                ? "Now"
                : (current?.label ?? "geoqa")
      }
      paneHint={
        run !== undefined
          ? "This one visit — what it did, the frames it kept, and whether we can trust it."
          : ticket !== undefined
            ? "The same brief that is on the GitHub issue — problem, cause, breaking changes, evidence."
            : route.pageTarget !== undefined
              ? "This page from every city that measured it. Click a city to open the visit."
              : route.liveId !== undefined
                ? "Still on Now — the frame and the steps, as they happen."
                : (current?.purpose ?? "")
      }
      sections={sections}
      liveCount={liveCount}
      stats={[
        { k: "runs", v: String(view.summary.total) },
        { k: "confidence", v: view.summary.meanConfidence.text },
        { k: "markets", v: String(view.site.markets.length) },
        { k: "built", v: new Date(view.generatedAt).toISOString().slice(0, 16).replace("T", " ") },
      ]}
      servedWithSession={servedWithSession}
      rebuilding={rebuilding}
      onRebuild={rebuild}
      onSignOut={() => {
        void signOut().then(() => setNeedsSignIn(true));
      }}
    >
      {route.runId !== undefined && <RunDetail view={view} runId={route.runId} />}
      {route.runId === undefined && route.view === "overview" && <Overview view={view} />}
      {route.runId === undefined && route.view === "live" && <Live selectedId={route.liveId} />}
      {route.runId === undefined && route.view === "runs" && <Runs view={view} />}
      {route.runId === undefined && route.view === "findings" && (
        <Findings
          view={view}
          onReload={load}
          {...(route.findingKey !== undefined ? { ticketKey: route.findingKey } : {})}
        />
      )}
      {route.runId === undefined && route.view === "geography" && (
        <Geography view={view} {...(route.pageTarget !== undefined ? { pageTarget: route.pageTarget } : {})} />
      )}
      {route.runId === undefined && route.view === "coverage" && <Coverage view={view} />}
      {route.runId === undefined && route.view === "trends" && (
        <Trends view={view} {...(route.trendKey !== undefined ? { trendKey: route.trendKey } : {})} />
      )}
      {route.runId === undefined && route.view === "watch" && <Watch />}
      {route.runId === undefined && route.view === "settings" && <Settings />}
    </Shell>
  );
}
