/**
 * Attach stills to the step that produced them.
 *
 * Auto-frames are named `NN-slug` by the engine (`frameName` in
 * journeys/engine.ts). This app cannot import that module, so the
 * slug is re-derived here and the pairing is tested against the same
 * labels the Ålesund login run actually wrote.
 */
import type { RunView } from "../types.ts";

export type Shot = RunView["screenshots"][number];
export type Step = RunView["steps"][number];

export interface FlowStep extends Step {
  shot: Shot | null;
}

export function autoFrameLabel(index: number, label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${String(index).padStart(2, "0")}-${slug || "frame"}`;
}

export function shotForStep(step: Pick<Step, "index" | "action" | "label">, shots: Shot[]): Shot | null {
  const present = shots.filter((s) => s.present);
  const wanted = step.action === "screenshot" ? step.label : autoFrameLabel(step.index, step.label);
  return present.find((s) => s.label === wanted) ?? null;
}

export function attachShotsToSteps(steps: Step[], shots: Shot[]): FlowStep[] {
  return steps.map((step) => ({ ...step, shot: shotForStep(step, shots) }));
}

export function leftoverShots(steps: Step[], shots: Shot[]): Shot[] {
  const used = new Set(
    attachShotsToSteps(steps, shots)
      .map((step) => step.shot?.label)
      .filter((label): label is string => label !== undefined),
  );
  return shots.filter((s) => s.present && !used.has(s.label));
}
