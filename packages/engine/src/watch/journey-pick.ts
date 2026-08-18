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

export function journeyPoolForTarget(
  target: string,
  defaultPool: readonly string[],
  journeysByTarget: Readonly<Record<string, readonly string[]>> = {},
): readonly string[] {
  const override = journeysByTarget[target];
  return override !== undefined && override.length > 0 ? override : defaultPool;
}

export function pickSeededCells(axes: {
  markets: readonly string[];
  devices: readonly string[];
  journeys: readonly string[];
  targets: readonly string[];
  atMs: number;
  /**
   * A URL that is not a marketing page (dashboard login) must not draw
   * browse/search from the pulse pool. Absent means every target uses `journeys`.
   */
  journeysByTarget?: Readonly<Record<string, readonly string[]>>;
}): SeededCell[] {
  const cells: SeededCell[] = [];
  for (const market of axes.markets) {
    for (const device of axes.devices) {
      for (const target of axes.targets) {
        const pool = journeyPoolForTarget(target, axes.journeys, axes.journeysByTarget ?? {});
        cells.push({
          market,
          device,
          journey: pickSeededJourney(pool, journeySeedMaterial(axes.atMs, market, target)),
          target,
        });
      }
    }
  }
  return cells;
}

/**
 * Cartesian product, but each URL draws from its own pool.
 *
 * `expandMatrix` cannot do this: it applies one journey list to every
 * target. Dashboard login in the pulse must never see browse/search.
 * Continuous and `journeyPick: all` both go through here when a
 * per-target pool exists.
 */
export function expandWatchCells(axes: {
  markets: readonly string[];
  devices: readonly string[];
  journeys: readonly string[];
  targets: readonly string[];
  journeysByTarget?: Readonly<Record<string, readonly string[]>>;
}): SeededCell[] {
  const cells: SeededCell[] = [];
  for (const market of axes.markets) {
    for (const device of axes.devices) {
      for (const target of axes.targets) {
        const pool = [...new Set(journeyPoolForTarget(target, axes.journeys, axes.journeysByTarget ?? {}))];
        for (const journey of pool) {
          cells.push({ market, device, journey, target });
        }
      }
    }
  }
  return cells;
}
