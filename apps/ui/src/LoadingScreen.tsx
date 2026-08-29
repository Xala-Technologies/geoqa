import type { JSX } from "react";
import { Mark } from "./Logo.tsx";

/**
 * Full-viewport boot state — dashboard index, watch, settings, anything that
 * blocks the shell until one JSON document arrives.
 */
export function LoadingScreen({
  message,
  detail,
}: {
  message: string;
  detail?: string | null;
}): JSX.Element {
  return (
    <div className="loading-screen" role="status" aria-live="polite" aria-busy="true">
      <div className="loading-screen-card">
        <div className="loading-spinner" aria-hidden="true">
          <span className="loading-spinner-orbit" />
          <span className="loading-spinner-mark">
            <Mark size={28} />
          </span>
        </div>
        <p className="loading-screen-message">{message}</p>
        {detail !== undefined && detail !== null && detail !== "" ? (
          <p className="loading-screen-detail">{detail}</p>
        ) : null}
      </div>
    </div>
  );
}
