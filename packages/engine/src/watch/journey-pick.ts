/**
 * One journey per city × URL, drawn from the watch pool, seeded.
 *
 * Periodic used to expand the full cartesian product of the journey list.
 * Five read-only journeys × 26 cities × 2 URLs is 260 residential sessions
 * an hour. The VPS pulse is 52: one drawn journey per cell.
 *
 * The draw is `seedFrom(UTC-hour + market + url) % pool`. Same inputs, same
 * journey. "Why did Oslo get search at 14:00?" is that string, not chance.
 * Device is in the cell (mobile still launches once) and not in the seed, so
 * a two-device watch does the same journey from both devices that hour.
 *
 * `Math.random` is banned here for the same reason the journey harness bans
 * it: an unseeded pick cannot be replayed, and this engine treats seeds as
 * part of the evidence.
 */
import { seedFrom } from "../journeys/random.js";

export function journeySeedMaterial(atMs: number, market: string, url: string): string {
  return `${new Date(atMs).toISOString().slice(0, 13)}\0${market}\0${url}`;
}

export function pickSeededJourney(pool: readonly string[], material: string): string {
  const sorted = [...new Set(pool)].sort();
  if (sorted.length === 0) throw new Error("seeded journey pick needs a non-empty pool");
  return sorted[seedFrom(material) % sorted.length] as string;
}

export interface SeededCell {
  market: string;
  device: string;
  journey: string;
  target: string;
}

export function pickSeededCells(axes: {
  markets: readonly string[];
  devices: readonly string[];
  journeys: readonly string[];
  targets: readonly string[];
  atMs: number;
}): SeededCell[] {
  const cells: SeededCell[] = [];
  for (const market of axes.markets) {
    for (const device of axes.devices) {
      for (const target of axes.targets) {
        cells.push({
          market,
          device,
          journey: pickSeededJourney(axes.journeys, journeySeedMaterial(axes.atMs, market, target)),
          target,
        });
      }
    }
  }
  return cells;
}
