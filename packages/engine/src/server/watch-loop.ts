/**
 * The in-process scheduler: tick the watch, launch a matrix, update the live board.
 *
 * Coverage-excluded with `start.ts`. Every decision it makes is in `watch/tick.ts`,
 * `watch/store.ts` and `watch/live.ts`, which are fully covered. This file binds a
 * timer, reads YAML, and calls `matrixRun` — exercising it means launching Chrome.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { controlRun, DEFAULT_ENGINE, defaultDeps, matrixRun, resolveProfileId } from "../cli/commands.js";
import { liveDashboardUrl } from "../cli/events.js";
import { loadJourney } from "../journeys/spec.js";
import { acceptRun, type AcceptedRun } from "./accept-run.js";
import type { Tenant } from "../tenant/types.js";
import type { GeoQaConfig } from "../config/schema.js";
import { LiveRegistry } from "../watch/live.js";
import { decideTick, planSweep } from "../watch/tick.js";
import { addTarget, removeTarget } from "../watch/targets.js";
import { applyWatchPatch, loadWatch, saveWatch, watchPath, type WatchAllowed } from "../watch/store.js";
import { emptyClock, loadWatchClock, saveWatchClock, watchClockPath } from "../watch/clock.js";
import { journeysRoot, tenantsRoot } from "../repo.js";
import { nextSlice } from "../watch/cursor.js";
import { pickSeededCells } from "../watch/journey-pick.js";
import { parseWatch, type WatchSpec } from "../watch/spec.js";
import { expandMatrix } from "../run/matrix.js";
import type { ControlDeps, ControlOutcome } from "./control.js";

export interface WatchLoopOptions {
  repoRoot: string;
  evidenceRoot: string;
  tenant: Tenant;
  markets: string[];
  journeys: { id: string; title: string; writes: boolean; requiredVars: string[] }[];
  config: GeoQaConfig;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  now: () => number;
  rebuild: () => void;
}

export interface WatchLoop {
  control: ControlDeps;
  stop: () => void;
}

const TICK_MS = 5_000;
const KEEP_LIVE_MS = 30 * 60_000;

export function attachWatch(options: WatchLoopOptions): WatchLoop {
  const live = new LiveRegistry();
  const file = watchPath(tenantsRoot(options.repoRoot), options.tenant.id);
  const clockFile = watchClockPath(options.evidenceRoot);
  const loadedClock = loadWatchClock(clockFile);
  if (!loadedClock.ok) {
    options.log(`watch: clock unreadable (${loadedClock.errors.join("; ")}) — treating as never swept`);
  }
  const clock = loadedClock.ok ? loadedClock.value : emptyClock();
  let lastStartedMs: number | null = clock.lastStartedMs;
  let lastFinishedMs: number | null = clock.lastFinishedMs;
  let cursor = clock.cursor;
  let inFlight = 0;
  const persistClock = (): void => saveWatchClock(clockFile, { lastStartedMs, lastFinishedMs, cursor });

  const allowed = (): WatchAllowed => ({
    markets: options.markets,
    journeys: options.journeys,
  });

  const current = (): WatchSpec => {
    if (!existsSync(file)) return defaultWatch(options.tenant);
    const loaded = loadWatch(file);
    return loaded.ok ? loaded.value : defaultWatch(options.tenant);
  };

  const persist = (spec: WatchSpec): void => saveWatch(file, spec);

  const view = (): unknown => {
    const spec = current();
    const decision = decideTick({ spec, nowMs: options.now(), lastStartedMs, lastFinishedMs, inFlight });
    return {
      tenantId: options.tenant.id,
      tenantName: options.tenant.name,
      spec,
      allowedMarkets: options.markets,
      availableJourneys: options.journeys.map((j) => ({ id: j.id, title: j.title, writes: j.writes })),
      lastStartedAt: lastStartedMs === null ? null : new Date(lastStartedMs).toISOString(),
      lastFinishedAt: lastFinishedMs === null ? null : new Date(lastFinishedMs).toISOString(),
      inFlight,
      nextDueAt: decision.nextMs === null ? null : new Date(decision.nextMs).toISOString(),
      decision: { action: decision.action, reason: decision.reason },
    };
  };

  const fail = (error: string): ControlOutcome<unknown> => ({ ok: false, error });

  const launch = async (spec: WatchSpec, reason: string): Promise<void> => {
    const planned = planSweep(spec, options.tenant, options.journeys);
    if (!planned.ok) {
      options.log(`watch: refused ${planned.error}`);
      return;
    }
    inFlight += 1;
    const startedMs = options.now();
    lastStartedMs = startedMs;
    persistClock();
    options.log(`watch: starting sweep (${reason}) — ${planned.axes.targets.length} url(s) × ${planned.axes.markets.length} market(s)`);
    const deps = defaultDeps(options.repoRoot, {
      evidenceRoot: options.evidenceRoot,
      env: options.env,
      now: options.now,
      log: options.log,
      tenantId: options.tenant.id,
      cooldownMs: options.config.network.cooldownMs,
    });
    const inner = deps.runOnce;
    deps.runOnce = async (runOptions) => {
      const id = runOptions.spec.runId;
      const frameDir = path.join(options.evidenceRoot, "live");
      mkdirSync(frameDir, { recursive: true });
      const framePath = live.safeId(id) ? path.join(frameDir, `${id}.png`) : undefined;
      const label = runOptions.label;
      live.upsert({
        id,
        tenantId: options.tenant.id,
        target: label?.target ?? runOptions.spec.target,
        market: label?.market ?? "",
        device: label?.device ?? "",
        journey: label?.journey ?? "",
        startedAt: new Date(options.now()).toISOString(),
        phase: "prepare",
        stepLabel: null,
        stepIndex: null,
        stepsTotal: null,
        status: "preparing",
        verdict: null,
        writes: false,
        frameUpdatedAt: null,
      });
      try {
        const result = await inner({
          ...runOptions,
          ...(framePath !== undefined ? { liveFramePath: framePath } : {}),
          onProgress: (event) => {
            live.progress(
              id,
              {
                phase: event.phase,
                status: event.phase === "done" ? "done" : event.phase === "journey" ? "running" : "preparing",
                stepLabel: event.stepLabel ?? null,
                stepIndex: event.stepIndex ?? null,
                stepsTotal: event.stepsTotal ?? null,
                ...(framePath !== undefined && existsSync(framePath)
                  ? { frameUpdatedAt: new Date(options.now()).toISOString() }
                  : {}),
              },
              new Date(options.now()).toISOString(),
            );
          },
        });
        live.finish(id, result.verdict);
        return result;
      } catch (thrown) {
        live.finish(id, "ERROR");
        throw thrown;
      }
    };
    try {
      const pick =
        spec.mode === "continuous"
          ? (() => {
              const stepped = nextSlice(expandMatrix(planned.axes), cursor, spec.maxConcurrent);
              cursor = stepped.nextCursor;
              persistClock();
              return stepped.slice.map((s) => ({
                market: s.market,
                device: s.device,
                journey: s.journey,
                target: s.target ?? "",
              }));
            })()
          : spec.journeyPick === "seeded"
            ? pickSeededCells({ ...planned.axes, atMs: startedMs })
            : undefined;
      if (pick !== undefined && pick.length === 0) {
        options.log("watch: continuous slice is empty");
        return;
      }
      await matrixRun(deps, {
        url: planned.axes.targets[0] ?? "",
        markets: planned.axes.markets,
        devices: planned.axes.devices,
        journeys: planned.axes.journeys,
        targets: planned.axes.targets,
        providerName: options.config.network.provider,
        allowWrites: spec.allowWrites,
        ...(pick !== undefined ? { pick } : {}),
      });
      options.rebuild();
    } catch (thrown) {
      options.log(`watch: sweep failed — ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    } finally {
      inFlight = Math.max(0, inFlight - 1);
      lastFinishedMs = options.now();
      persistClock();
      live.prune(options.now(), KEEP_LIVE_MS);
    }
  };

  const launchOne = async (accepted: AcceptedRun): Promise<void> => {
    inFlight += 1;
    const id = `api_${options.now()}`;
    live.upsert({
      id,
      tenantId: options.tenant.id,
      target: accepted.request.url,
      market: accepted.market,
      device: accepted.device,
      journey: accepted.request.journey,
      startedAt: new Date(options.now()).toISOString(),
      phase: "prepare",
      stepLabel: null,
      stepIndex: null,
      stepsTotal: null,
      status: "preparing",
      verdict: null,
      writes: accepted.request.allowWrites === true,
      frameUpdatedAt: null,
    });
    const deps = defaultDeps(options.repoRoot, {
      evidenceRoot: options.evidenceRoot,
      env: options.env,
      now: options.now,
      log: options.log,
      tenantId: options.tenant.id,
      cooldownMs: options.config.network.cooldownMs,
    });
    try {
      const { result } = await controlRun(deps, {
        url: accepted.request.url,
        profileId: accepted.profileId,
        journeyId: accepted.request.journey,
        providerName: options.config.network.provider,
        ...(accepted.request.locale ? { locale: accepted.request.locale } : {}),
        ...(accepted.request.timezone ? { timezone: accepted.request.timezone } : {}),
        ...(accepted.request.sessionDurationMinutes !== undefined
          ? { sessionDurationMinutes: accepted.request.sessionDurationMinutes }
          : {}),
        onEvent: (event) => {
          live.appendEvent({
            at: new Date(options.now()).toISOString(),
            level: event.level,
            message: event.message,
            ...(event.observedIp !== undefined ? { observedIp: event.observedIp } : {}),
            ...(event.liveUrl !== undefined ? { liveUrl: event.liveUrl } : {}),
            ...(event.confidence !== undefined ? { confidence: event.confidence } : {}),
            ...(event.verdict !== undefined ? { verdict: event.verdict } : {}),
            ...(event.runId !== undefined ? { runId: event.runId } : {}),
            ...(event.evidenceId !== undefined ? { evidenceId: event.evidenceId } : {}),
          });
          live.progress(
            id,
            {
              phase: event.verdict !== undefined ? "done" : "running",
              stepLabel: event.message,
              status: event.verdict !== undefined ? "done" : "running",
              ...(event.verdict !== undefined ? { verdict: event.verdict } : {}),
              ...(event.runId !== undefined ? { runId: event.runId } : {}),
              ...(event.observedIp !== undefined ? { observedIp: event.observedIp } : {}),
              ...(event.confidence !== undefined ? { confidence: event.confidence } : {}),
            },
            new Date(options.now()).toISOString(),
          );
        },
      });
      live.finish(id, result.verdict);
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      live.appendEvent({ at: new Date(options.now()).toISOString(), level: "error", message });
      live.finish(id, "ERROR");
      options.log(`run: failed — ${message}`);
    } finally {
      inFlight = Math.max(0, inFlight - 1);
      live.prune(options.now(), KEEP_LIVE_MS);
    }
  };

  const startIfDue = (force: boolean): ControlOutcome<unknown> => {
    const spec = current();
    const decision = decideTick({ spec, nowMs: options.now(), lastStartedMs, lastFinishedMs, inFlight, ...(force ? { force: true } : {}) });
    if (decision.action !== "start") return fail(decision.reason);
    void launch(spec, decision.reason);
    return { ok: true, value: { started: true, reason: decision.reason } };
  };

  const timer = setInterval(() => {
    startIfDue(false);
  }, TICK_MS);

  const boot = current();
  options.log(
    `watch: ${boot.enabled ? "armed" : "paused"} for ${options.tenant.id} (${boot.mode}, ${boot.targets.length} url(s), ${boot.markets.length} market(s))`,
  );

  return {
    stop: () => clearInterval(timer),
    control: {
      watch: view,
      saveWatch: (body) => {
        const patched = applyWatchPatch(current(), body, allowed());
        if (!patched.ok) return fail(patched.errors.join("; "));
        persist(patched.value);
        return { ok: true, value: view() };
      },
      addTarget: (body) => {
        const url = typeof (body as { url?: unknown }).url === "string" ? (body as { url: string }).url : "";
        const added = addTarget(current().targets, url);
        if (!added.ok) return fail(added.errors.join("; "));
        persist({ ...current(), targets: added.value });
        return { ok: true, value: view() };
      },
      removeTarget: (body) => {
        const url = typeof (body as { url?: unknown }).url === "string" ? (body as { url: string }).url : "";
        const removed = removeTarget(current().targets, url);
        if (!removed.ok) return fail(removed.errors.join("; "));
        persist({ ...current(), targets: removed.value });
        return { ok: true, value: view() };
      },
      startNow: () => startIfDue(true),
      live: () => ({ sessions: live.list(), inFlight }),
      liveSession: (id) => {
        if (!live.safeId(id)) return null;
        return live.find(id) ?? null;
      },
      liveFrame: (id) => {
        if (!live.safeId(id)) return null;
        const frame = path.join(options.evidenceRoot, "live", `${id}.png`);
        if (!existsSync(frame)) return null;
        return { mime: "image/png", data: readFileSync(frame).toString("base64") };
      },
      runNow: (body) => {
        const deps = defaultDeps(options.repoRoot, {
          evidenceRoot: options.evidenceRoot,
          env: options.env,
          now: options.now,
          log: options.log,
          tenantId: options.tenant.id,
          cooldownMs: options.config.network.cooldownMs,
        });
        const accepted = acceptRun({
          body,
          tenant: options.tenant,
          extraTargets: current().targets,
          resolveProfile: (selection) => resolveProfileId(deps, selection),
          loadJourney: (id) => {
            const file = path.join(journeysRoot(options.repoRoot), `${id}.yaml`);
            const loaded = loadJourney(file);
            return loaded.ok ? { ok: true, writes: loaded.value.writes === true } : loaded;
          },
        });
        if (!accepted.ok) return fail(accepted.error);
        void launchOne(accepted);
        const liveUrl = liveDashboardUrl(options.env, DEFAULT_ENGINE);
        return {
          ok: true,
          value: {
            started: true,
            url: accepted.request.url,
            profileId: accepted.profileId,
            journey: accepted.request.journey,
            ...(liveUrl !== null ? { liveUrl } : {}),
          },
        };
      },
      runStatus: () => ({ inFlight, events: live.events(), sessions: live.list() }),
    },
  };
}

function defaultWatch(tenant: Tenant): WatchSpec {
  const parsed = parseWatch({
    tenantId: tenant.id,
    enabled: false,
    mode: "periodic",
    everyMinutes: 30,
    restSeconds: 15,
    markets: tenant.markets.slice(0, 5),
    devices: ["mobile", "desktop"],
    journeys: ["landing-page"],
    targets: tenant.targets,
    allowWrites: false,
  });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
}
