/**
 * Shared between `worker.ts` and any client that starts a workflow.
 *
 * Deliberately its own file rather than an export from `worker.ts`. `worker.ts`
 * has an unguarded top-level `main()` — the standard entrypoint shape — so
 * merely IMPORTING it to read a constant would start a real worker, connect to
 * Temporal and block forever. agent-fleet hit exactly this and left the same
 * note in its own temporal pilot.
 */
export const TASK_QUEUE = "geoqa";
export const DEFAULT_ADDRESS = "127.0.0.1:7233";
export const DEFAULT_NAMESPACE = "default";
