import type { JSX, ReactNode } from "react";
import { LiveDots, NAV_ICONS, type NavIcon } from "./icons.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

export type ModeId = "work" | "compare" | "setup";

export type ShellLink = {
  id: string;
  href: string;
  label: string;
  hint: string;
  icon: NavIcon;
  current: boolean;
  count?: number;
  alert?: boolean;
};

export type ShellMode = {
  id: ModeId;
  href: string;
  label: string;
  icon: NavIcon;
};

export type ShellStat = { k: string; v: string };

type ShellProps = {
  modes: ShellMode[];
  mode: ModeId;
  title: string;
  hint: string;
  paneTitle: string;
  paneHint: string;
  links: ShellLink[];
  liveCount: number;
  stats: ShellStat[];
  servedWithSession: boolean;
  rebuilding: string | null;
  onRebuild: () => void;
  onSignOut: () => void;
  children: ReactNode;
};

export function Shell({
  modes,
  mode,
  title,
  hint,
  paneTitle,
  paneHint,
  links,
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
        <nav className="mode-rail" aria-label="Product mode">
          {modes.map((item) => {
            const on = mode === item.id;
            return (
              <a
                key={item.id}
                href={item.href}
                aria-current={on ? "page" : undefined}
                data-mode={item.id}
                className={`pressable mode-link${on ? " on" : ""}`}
              >
                <span className={on ? "text-accent" : ""}>{NAV_ICONS[item.icon]}</span>
                <span className="mode-label">{item.label}</span>
              </a>
            );
          })}
        </nav>
        <div className="sidebar-panel">
          <header className="sidebar-head">
            <span className={`mark-blob${live ? " avatar-breathe" : ""}${mode === "work" && live ? " filament" : ""}`}>
              <span className="mark-dot" />
            </span>
            <div className="min-w-0">
              <p className="sidebar-title">{title}</p>
              <p className="sidebar-hint">{hint}</p>
            </div>
          </header>
          <nav className="sidebar-nav scrollbar-thin" aria-label={title}>
            {links.map((item) => (
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
          </nav>
        </div>
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
            <p>
              {liveCount === 1 ? "1 session just woke up" : `${liveCount} sessions are awake`}
            </p>
          </div>
        ) : null}
        <div className="readout scrollbar-thin">{children}</div>
      </section>
    </main>
  );
}
