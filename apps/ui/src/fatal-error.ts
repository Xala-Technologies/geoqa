export type FatalSource = "react" | "window" | "promise" | "boot";

export type FatalError = {
  source: FatalSource;
  message: string;
  detail: string | null;
  at: string;
};

let current: FatalError | null = null;
const listeners = new Set<() => void>();

export function readFatalError(): FatalError | null {
  return current;
}

export function reportFatal(report: Omit<FatalError, "at"> & { at?: string }): void {
  current = {
    source: report.source,
    message: report.message,
    detail: report.detail,
    at: report.at ?? new Date().toISOString(),
  };
  for (const listener of listeners) listener();
}

export function clearFatalError(): void {
  if (current === null) return;
  current = null;
  for (const listener of listeners) listener();
}

export function subscribeFatalError(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
