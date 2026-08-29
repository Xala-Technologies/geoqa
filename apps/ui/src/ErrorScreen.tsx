import type { JSX } from "react";
import { Logo } from "./Logo.tsx";
import type { FatalSource } from "./fatal-error.ts";

const sourceLabel: Record<FatalSource, string> = {
  react: "React render",
  window: "Uncaught script error",
  promise: "Unhandled promise",
  boot: "Startup",
};

export function ErrorScreen({
  source,
  message,
  detail,
  onRetry,
}: {
  source: FatalSource;
  message: string;
  detail: string | null;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className="fatal-screen" role="alert">
      <div className="fatal-card">
        <div className="fatal-brand">
          <Logo size={32} lockup />
        </div>
        <p className="fatal-kicker">{sourceLabel[source]}</p>
        <h1 className="fatal-title">The console stopped</h1>
        <p className="fatal-message">{message}</p>
        {detail !== null && detail !== "" ? (
          <p className="fatal-detail">
            <code>{detail}</code>
          </p>
        ) : null}
        <div className="fatal-actions">
          <button className="btn btn-primary" type="button" onClick={onRetry}>
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
