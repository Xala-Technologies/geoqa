/**
 * What an assist call returns. Same envelope rule as the browser seam:
 * success has text, failure has a kind. There is no empty success.
 */
export type AssistFailureKind = "spawn" | "exit" | "timeout" | "empty";

export type AssistOutcome =
  | { ok: true; text: string }
  | { ok: false; failure: { kind: AssistFailureKind; detail: string } };
