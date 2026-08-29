import { Component, type ErrorInfo, type ReactNode } from "react";
import { describeError } from "./describe-error.ts";
import { ErrorScreen } from "./ErrorScreen.tsx";

type Props = {
  children: ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
};

type State = {
  error: Error | null;
};

/**
 * Catches render/lifecycle errors in the React tree. Async and event-handler throws
 * still need `installGlobalErrorHandlers`.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error !== null) {
      return (
        <ErrorScreen
          source="react"
          message={describeError(error)}
          detail={error.stack ?? null}
          onRetry={() => window.location.reload()}
        />
      );
    }
    return this.props.children;
  }
}
