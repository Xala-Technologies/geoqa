import type { JSX, ReactNode } from "react";
import { LiveDots, NAV_ICONS } from "./icons.tsx";
import { Mark } from "./Logo.tsx";
import type { NavSection } from "./nav.ts";
import { ThemeToggle } from "./ThemeToggle.tsx";

export type ShellStat = { k: string; v: string };

type ShellProps = {
  title: string;
  hint: string;
  paneTitle: string;
  paneHint: string;
  sections: NavSection[];
  liveCount: number;
  stats: ShellStat[];
  servedWithSession: boolean;
  rebuilding: string | null;
  onRebuild: () => void;
  onSignOut: () => void;
  children: ReactNode;
};

export function Shell({
  title,
  hint,
  paneTitle,
  paneHint,
  sections,
  liveCount,
  stats,
  servedWithSession,
  rebuilding,
  onRebuild,
  onSignOut,
  children,
}: ShellProps): JSX.Element {
  const live = liveCount > 0;
  return (
    <main className="app">
      <aside className="sidebar">
        <header className="sidebar-head">
          <span className={`mark-blob${live ? " avatar-breathe" : ""}`}>
            <Mark size={18} />
          </span>
          <div className="min-w-0">
            <p className="sidebar-title">{title}</p>
            <p className="sidebar-hint">{hint}</p>
          </div>
        </header>
        <nav className="sidebar-nav scrollbar-thin" aria-label="geoqa">
          {sections.map((section) => (
            <div className="nav-section" key={section.id}>
              <p className="nav-section-k">{section.label}</p>
              <p className="nav-section-hint">{section.hint}</p>
              {section.links.map((item) => (
                <a
                  key={item.id}
                  href={item.href}
                  aria-current={item.current ? "page" : undefined}
                  className={`pressable nav-row${item.current ? " on" : ""}${item.id === "live" && live ? " row-awake" : ""}`}
                >
                  <span className="nav-icon">{NAV_ICONS[item.icon]}</span>
                  <span className="min-w-0 grow">
                    <span className="nav-label">{item.label}</span>
                    <span className={`nav-hint${item.id === "live" && live ? " text-accent" : ""}`}>
                      {item.id === "live" && live ? <LiveDots /> : null}
                      {item.hint}
                    </span>
                  </span>
                  {item.count !== undefined && item.count > 0 ? (
                    <span className={`nav-count${item.alert === true ? " alert" : ""}`}>{item.count}</span>
                  ) : null}
                </a>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <section className="pane">
        <header className="pane-head">
          <div className="min-w-0 grow">
            <p className="pane-title">{paneTitle}</p>
            <p className="pane-hint">{paneHint}</p>
          </div>
          <div className="pane-tools">
            <div className="bar-stats">
              {stats.map((stat) => (
                <span className="stat" key={stat.k}>
                  <span className="stat-k">{stat.k}</span>
                  <span className="stat-v">{stat.v}</span>
                </span>
              ))}
            </div>
            <div className="toolbar">
              <ThemeToggle />
              {servedWithSession ? (
                <button className="tool-text" type="button" onClick={onRebuild} disabled={rebuilding === "Rebuilding…"}>
                  {rebuilding ?? "Rebuild"}
                </button>
              ) : null}
              {servedWithSession ? (
                <button className="tool-text" type="button" onClick={onSignOut}>
                  Sign out
                </button>
              ) : null}
            </div>
          </div>
        </header>
        {live ? (
          <div className="strip-wake activity-strip">
            <LiveDots />
            <p>{liveCount === 1 ? "1 session just woke up" : `${liveCount} sessions are awake`}</p>
          </div>
        ) : null}
        <div className="readout scrollbar-thin">{children}</div>
      </section>
    </main>
  );
}
