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
import { useEffect, useState, type JSX } from "react";
import type { DashboardView } from "./types.ts";
import { Overview } from "./views/Overview.tsx";
import { Runs } from "./views/Runs.tsx";
import { Geography } from "./views/Geography.tsx";
import { Coverage } from "./views/Coverage.tsx";
import { Trends } from "./views/Trends.tsx";

type ViewId = "overview" | "runs" | "geography" | "coverage" | "trends";

const VIEWS: { id: ViewId; label: string; group: string }[] = [
  { id: "overview", label: "Overview", group: "Monitor" },
  { id: "runs", label: "Runs", group: "Monitor" },
  { id: "geography", label: "Geography", group: "Analyse" },
  { id: "coverage", label: "Coverage", group: "Analyse" },
  { id: "trends", label: "Trends", group: "Analyse" },
];

const viewFromHash = (): ViewId => {
  const id = window.location.hash.replace(/^#\/?/, "") as ViewId;
  return VIEWS.some((v) => v.id === id) ? id : "overview";
};

export function App(): JSX.Element {
  const [view, setView] = useState<DashboardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<ViewId>(viewFromHash);

  useEffect(() => {
    const onHash = (): void => setRoute(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // The tab title follows the view. With five of them, a static title makes two open tabs
  // indistinguishable — and this is a console somebody keeps open beside their work.
  useEffect(() => {
    document.title = `geoqa — ${VIEWS.find((v) => v.id === route)?.label.toLowerCase() ?? "runs"}`;
  }, [route]);

  useEffect(() => {
    fetch("./dashboard.json", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`dashboard.json responded ${response.status}`);
        return response.json() as Promise<DashboardView>;
      })
      .then(setView)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

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
    geography: view.site.geographicallyDivergent.length,
    coverage: view.site.coverageGaps.length,
    trends: view.trends.length,
  };
  const alerts: Record<string, boolean> = {
    geography: view.site.geographicallyDivergent.length > 0,
    coverage: view.site.coverageGaps.length > 0,
  };

  const groups = [...new Set(VIEWS.map((v) => v.group))];
  const current = VIEWS.find((v) => v.id === route);

  return (
    <div className="app">
      <div className="brand">
        <Mark />
        <span className="brand-name">
          geo<b>qa</b>
        </span>
      </div>

      <header className="bar">
        <span className="bar-title">{current?.label}</span>
        <div className="bar-stats">
          <Stat k="runs" v={String(view.summary.total)} />
          <Stat k="confidence" v={view.summary.meanConfidence.text} />
          <Stat k="markets" v={String(view.site.markets.length)} />
          <Stat k="built" v={new Date(view.generatedAt).toISOString().slice(0, 16).replace("T", " ")} />
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
                aria-current={route === v.id ? "page" : undefined}
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
        {route === "overview" && <Overview view={view} />}
        {route === "runs" && <Runs view={view} />}
        {route === "geography" && <Geography view={view} />}
        {route === "coverage" && <Coverage view={view} />}
        {route === "trends" && <Trends view={view} />}
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
 * The mark: a globe reduced to one meridian and one parallel, with a fix on it.
 *
 * Drawn rather than an emoji or an image — it is two shapes, it inherits the accent, and it
 * stays crisp at any density. The dot is the point of the product: a measurement taken at a
 * place, not near one.
 */
function Mark(): JSX.Element {
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" stroke="var(--accent)" strokeWidth="1.3" opacity="0.75" />
      <ellipse cx="10" cy="10" rx="3.4" ry="7.5" stroke="var(--accent)" strokeWidth="1.1" opacity="0.45" />
      <path d="M2.6 10h14.8" stroke="var(--accent)" strokeWidth="1.1" opacity="0.45" />
      <circle cx="13.2" cy="6.4" r="2" fill="var(--accent)" />
    </svg>
  );
}
