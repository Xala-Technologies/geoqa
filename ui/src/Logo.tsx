/**
 * The mark and the wordmark.
 *
 * Drawn rather than an emoji or a raster — four shapes, inherits the signal colour, stays
 * crisp at any density. Square crosshair rather than a globe: this is an instrument that
 * takes a reading at a coordinate, and a globe would say "international" when the product's
 * actual claim is "measured from exactly here".
 *
 * The same paths live in `public/favicon.svg` so the tab icon and the chrome cannot drift.
 */
import type { JSX } from "react";

export function Logo({ size = 22, lockup = false }: { size?: number; lockup?: boolean }): JSX.Element {
  return (
    <span className={lockup ? "logo logo-lockup" : "logo"} aria-label="geoqa">
      <Mark size={size} />
      <span className="logo-word">
        <span className="logo-name">
          geo<b>qa</b>
        </span>
        <span className="logo-tag">geographic qa</span>
      </span>
    </span>
  );
}

export function Mark({ size = 22 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="19" height="19" stroke="var(--signal)" strokeWidth="1.25" opacity="0.5" />
      <path d="M11 1.5v19M1.5 11h19" stroke="var(--signal)" strokeWidth="1" opacity="0.3" />
      <rect x="7.5" y="7.5" width="7" height="7" stroke="var(--signal)" strokeWidth="1.25" opacity="0.7" />
      <rect x="9.5" y="9.5" width="3" height="3" fill="var(--signal)" />
    </svg>
  );
}
