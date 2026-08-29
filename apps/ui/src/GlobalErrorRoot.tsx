import { useEffect, useReducer, type JSX, type ReactNode } from "react";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { ErrorScreen } from "./ErrorScreen.tsx";
import { clearFatalError, readFatalError, subscribeFatalError } from "./fatal-error.ts";
import { installGlobalErrorHandlers } from "./global-handlers.ts";

/**
 * One place for errors React cannot catch and errors it can.
 * Window/promise failures replace the whole app; render failures stay inside the boundary.
 */
export function GlobalErrorRoot({ children }: { children: ReactNode }): JSX.Element {
  const [, refresh] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const offHandlers = installGlobalErrorHandlers();
    const offSubscribe = subscribeFatalError(refresh);
    return () => {
      offHandlers();
      offSubscribe();
    };
  }, []);

  const fatal = readFatalError();
  if (fatal !== null) {
    return (
      <ErrorScreen
        source={fatal.source}
        message={fatal.message}
        detail={fatal.detail}
        onRetry={() => {
          clearFatalError();
          window.location.reload();
        }}
      />
    );
  }

  return <ErrorBoundary>{children}</ErrorBoundary>;
}
