/**
 * The in-process scheduler: tick the watch, launch a matrix, update the live board.
 *
 * Coverage-excluded with `start.ts`. Every decision it makes is in `watch/tick.ts`,
 * `watch/store.ts`, `watch/live.ts`, `watch/health.ts` and `watch/log.ts`, which
 * are fully covered. This file binds a timer, reads YAML, and calls `matrixRun`
 * — exercising it means launching Chrome.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { controlRun, defaultDeps, findingsFile, findingsRepair, loginVarsFromEnv, matrixRun, preflightSweep, renderFindingsFile, renderFindingsRepair, resolveDataPath, resolveProfileId } from "../cli/commands.js";
import { cooldownStorePath } from "../network/cooldown.js";
import { liveDashboardUrl } from "../cli/events.js";
import { describeThrown } from "../errors.js";
import { loadJourney } from "../journeys/spec.js";
import { acceptRun, type AcceptedRun } from "./accept-run.js";
import type { Tenant } from "../tenant/types.js";
import type { GeoQaConfig } from "../config/schema.js";
import { LiveRegistry } from "../watch/live.js";
import { decideTick, dueTimes, planE2e, planSweep, type TickDecision } from "../watch/tick.js";
import { addTarget, removeTarget } from "../watch/targets.js";
import { applyWatchPatch, dropOrphanTargetJourneys, loadWatch, saveWatch, watchPath, type WatchAllowed } from "../watch/store.js";
import { expandMatrix } from "../run/matrix.js";
import { emptyClock, loadWatchClock, saveWatchClock, watchClockPath } from "../watch/clock.js";
import { tenantsRoot } from "../repo.js";
import { nextSlice } from "../watch/cursor.js";
import { expandWatchCells, pickSeededCells } from "../watch/journey-pick.js";
import { parseWatch, type WatchSpec } from "../watch/spec.js";
import { assessWatch, findingKey, unreportedFindings, type WatchHealth } from "../watch/health.js";
import { appendWatchEvent, eventFromFinding, readWatchLog, recentWatchEvents, type WatchLogEvent } from "../watch/log.js";
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
/**
 * Chromium's `--proxy-server` drops userinfo. agent-browser launches that
 * way, so Decodo is reached and never authenticated — Live then sits on
 * "preparing" until the command timeout. Playwright splits username/
 * password onto the context (`playwrightProxy` in playwright-launch.ts).
 */
const WATCH_ENGINE = "playwright" as const;

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
  let lastE2eStartedMs: number | null = clock.lastE2eStartedMs;
  let cursor = clock.cursor;
  let inFlight = 0;
  let lastSweepError: string | null = null;
  const reported = new Set<string>();
  const persistClock = (): void => saveWatchClock(clockFile, { lastStartedMs, lastFinishedMs, cursor, lastE2eStartedMs });

  const record = (event: WatchLogEvent): void => {
    const problem = appendWatchEvent(options.evidenceRoot, event);
    if (problem !== null) options.log(`watch: ${problem}`);
    if (event.level === "error" || event.level === "warning") {
      options.log(`watch: ${event.kind} — ${event.message}`);
    }
  };

  const snapshot = (): WatchHealth =>
    assessWatch({
      enabled: current().enabled,
      nowMs: options.now(),
      lastStartedMs,
      lastFinishedMs,
      inFlight,
      sessions: live.list(),
      lastSweepError,
    });

  const observe = (): WatchHealth => {
    const health = snapshot();
    const present = new Set(health.findings.map(findingKey));
    for (const key of reported) {
      if (!present.has(key)) reported.delete(key);
    }
    const at = new Date(options.now()).toISOString();
    for (const finding of unreportedFindings(health.findings, reported)) {
      record(eventFromFinding(finding, at));
      reported.add(findingKey(finding));
    }
    return health;
  };

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
    const tick = { spec, nowMs: options.now(), lastStartedMs, lastFinishedMs, lastE2eStartedMs, inFlight };
    const decision = decideTick(tick);
    const due = dueTimes(tick);
    const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
    return {
      tenantId: options.tenant.id,
      tenantName: options.tenant.name,
      spec,
      allowedMarkets: options.markets,
      availableJourneys: options.journeys.map((j) => ({ id: j.id, title: j.title, writes: j.writes })),
      lastStartedAt: iso(lastStartedMs),
      lastFinishedAt: iso(lastFinishedMs),
      lastE2eStartedAt: iso(lastE2eStartedMs),
      inFlight,
      nextDueAt: iso(decision.nextMs),
      nextPulseDueAt: iso(due.pulseMs),
      nextE2eDueAt: iso(due.e2eMs),
      decision: { action: decision.action, reason: decision.reason, pulse: decision.action === "start" ? decision.pulse : false, e2e: decision.action === "start" ? decision.e2e : false },
      health: snapshot(),
      log: recentWatchEvents(readWatchLog(options.evidenceRoot).events),
    };
  };

  const fail = (error: string): ControlOutcome<unknown> => ({ ok: false, error });

  const refuse = (error: string): void => {
    options.log(`watch: refused ${error}`);
    // A quota or proxy refusal is expected operator state, not a defect. Setting
    // lastSweepError here made assessWatch report "failed" and looked like geoqa broke.
    record({
      at: new Date(options.now()).toISOString(),
      level: "warning",
      kind: "sweep-refused",
      message: error,
    });
  };

  const launch = async (spec: WatchSpec, decision: Extract<TickDecision, { action: "start" }>): Promise<void> => {
    let e2ePlan =
      spec.e2e.journeys.length > 0
        ? planE2e(spec, options.tenant, options.journeys)
        : { ok: true as const, cells: [], writes: false };
    if (!e2ePlan.ok) {
      // A missing tenant journey must not also cancel the geo pulse, and must
      // not retry every tick — that filled the watch log this morning.
      refuse(e2ePlan.error);
      if (decision.e2e) {
        lastE2eStartedMs = options.now();
        persistClock();
      }
      if (!decision.pulse) return;
      e2ePlan = { ok: true, cells: [], writes: false };
    }
    const planned = decision.pulse ? planSweep(spec, options.tenant, options.journeys) : null;
    if (planned !== null && !planned.ok) {
      refuse(planned.error);
      if (decision.pulse) {
        lastStartedMs = options.now();
        persistClock();
      }
      return;
    }
    const startedMs = options.now();
    const asPick = (s: { market: string; device: string; journey: string; target: string | null }): {
      market: string;
      device: string;
      journey: string;
      target: string;
    } => ({ market: s.market, device: s.device, journey: s.journey, target: s.target ?? "" });
    const e2eCells = decision.e2e ? e2ePlan.cells : [];
    const e2eWrites = decision.e2e ? e2ePlan.writes : false;
    const journeysByTarget = spec.targetJourneys;
    const hasTargetPools = Object.keys(journeysByTarget).length > 0;
    let nextCursor = cursor;
    const pick =
      decision.pulse && planned !== null && planned.ok
        ? spec.mode === "continuous"
          ? (() => {
              const watchAxes = { ...planned.axes, journeysByTarget };
              const stepped = nextSlice(
                hasTargetPools ? expandWatchCells(watchAxes) : expandMatrix(planned.axes).map(asPick),
                cursor,
                spec.maxConcurrent,
              );
              nextCursor = stepped.nextCursor;
              return [...stepped.slice, ...e2eCells];
            })()
          : spec.journeyPick === "seeded"
            ? [...pickSeededCells({ ...planned.axes, atMs: startedMs, journeysByTarget }), ...e2eCells]
            : hasTargetPools || e2eCells.length > 0
              ? [...(hasTargetPools ? expandWatchCells({ ...planned.axes, journeysByTarget }) : expandMatrix(planned.axes).map(asPick)), ...e2eCells]
              : undefined
        : e2eCells;
    if (pick !== undefined && pick.length === 0) {
      options.log("watch: continuous slice is empty");
      return;
    }
    const pageLoads =
      pick !== undefined
        ? pick.length
        : planned !== null && planned.ok
          ? expandMatrix(planned.axes).length + e2eCells.length
          : e2eCells.length;
    const deps = defaultDeps(options.repoRoot, {
      evidenceRoot: options.evidenceRoot,
      env: options.env,
      now: options.now,
      log: options.log,
      cooldownPath: cooldownStorePath(options.evidenceRoot),
      cooldownMs: options.config.network.cooldownMs,
    });
    const preflight = await preflightSweep(deps, options.tenant, pageLoads, options.config.network.provider, {
      directFallback: options.config.network.directFallback,
    });
    if (!preflight.ok) {
      refuse(preflight.error);
      if (decision.pulse) {
        lastStartedMs = startedMs;
        persistClock();
      }
      return;
    }
    for (const w of preflight.warnings) options.log(`warning: ${w}`);
    const sweepProvider = preflight.provider;
    cursor = nextCursor;
    inFlight += 1;
    lastSweepError = null;
    if (decision.pulse) lastStartedMs = startedMs;
    if (decision.e2e) lastE2eStartedMs = startedMs;
    persistClock();
    const scope =
      decision.pulse && planned !== null && planned.ok
        ? `${planned.axes.targets.length} url(s) × ${planned.axes.markets.length} market(s)`
        : `${e2ePlan.cells.length} e2e journey(s)`;
    options.log(`watch: starting sweep (${decision.reason}) — ${scope}`);
    record({
      at: new Date(startedMs).toISOString(),
      level: "info",
      kind: "sweep-started",
      message: `starting sweep (${decision.reason}) — ${scope}`,
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
      const axes =
        decision.pulse && planned !== null && planned.ok
          ? planned.axes
          : {
              markets: [...new Set(e2eCells.map((c) => c.market))],
              devices: [...new Set(e2eCells.map((c) => c.device))],
              journeys: [...new Set(e2eCells.map((c) => c.journey))],
              targets: [...new Set(e2eCells.map((c) => c.target))],
            };
      await matrixRun(deps, {
        url: axes.targets[0] ?? "",
        markets: axes.markets,
        devices: axes.devices,
        journeys: axes.journeys,
        targets: axes.targets,
        providerName: sweepProvider,
        allowWrites: spec.allowWrites || e2eWrites,
        concurrency: spec.maxConcurrent,
        engine: WATCH_ENGINE,
        vars: loginVarsFromEnv(options.env),
        ...(pick !== undefined ? { pick } : {}),
      });
      options.rebuild();
      lastSweepError = null;
      record({
        at: new Date(options.now()).toISOString(),
        level: "info",
        kind: "sweep-finished",
        message: "sweep finished",
      });
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      lastSweepError = message;
      options.log(`watch: sweep failed — ${message}`);
      record({
        at: new Date(options.now()).toISOString(),
        level: "error",
        kind: "sweep-failed",
        message,
      });
    } finally {
      inFlight = Math.max(0, inFlight - 1);
      lastFinishedMs = options.now();
      persistClock();
      live.prune(options.now(), KEEP_LIVE_MS);
      // The invariant is "a thrown repair must not fail a sweep". Detached with
      // no `.catch`, that held by ACCIDENT rather than by handling: a throw here
      // was an unhandled rejection on the server process, which node may take
      // the process down for. Caught, logged, sweep unaffected — the same
      // outcome, now for a reason.
      void findingsFile(deps)
        .then(async (filed) => {
          options.log(renderFindingsFile(filed));
          options.rebuild();
          if (filed.filed.length === 0) return;
          const repaired = await findingsRepair(deps, { onlyKeys: filed.filed.map((item) => item.key) });
          options.log(renderFindingsRepair(repaired));
          options.rebuild();
        })
        .catch((error: unknown) => {
          options.log(`file/repair after sweep failed: ${describeThrown(error)}`);
        });
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
      cooldownPath: cooldownStorePath(options.evidenceRoot),
      cooldownMs: options.config.network.cooldownMs,
    });
    const preflight = await preflightSweep(deps, options.tenant, 1, options.config.network.provider, {
      directFallback: options.config.network.directFallback,
    });
    if (!preflight.ok) {
      live.finish(id, "ERROR");
      inFlight = Math.max(0, inFlight - 1);
      refuse(preflight.error);
      return;
    }
    for (const w of preflight.warnings) options.log(`warning: ${w}`);
    try {
      const { result } = await controlRun(deps, {
        url: accepted.request.url,
        profileId: accepted.profileId,
        journeyId: accepted.request.journey,
        providerName: preflight.provider,
        engine: WATCH_ENGINE,
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
    const decision = decideTick({ spec, nowMs: options.now(), lastStartedMs, lastFinishedMs, lastE2eStartedMs, inFlight, ...(force ? { force: true } : {}) });
    if (decision.action !== "start") return fail(decision.reason);
    void launch(spec, decision);
    return { ok: true, value: { started: true, reason: decision.reason } };
  };

  const timer = setInterval(() => {
    observe();
    startIfDue(false);
  }, TICK_MS);

  if (!loadedClock.ok) {
    record({
      at: new Date(options.now()).toISOString(),
      level: "warning",
      kind: "clock-unreadable",
      message: loadedClock.errors.join("; "),
    });
  }

  const boot = current();
  options.log(
    `watch: ${boot.enabled ? "armed" : "paused"} for ${options.tenant.id} (${boot.mode}, ${boot.targets.length} url(s), ${boot.markets.length} market(s))`,
  );
  observe();

  return {
    stop: () => clearInterval(timer),
    control: {
      watch: view,
      watchLog: () => {
        const read = readWatchLog(options.evidenceRoot);
        return { events: recentWatchEvents(read.events), skipped: read.skipped };
      },
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
        persist(dropOrphanTargetJourneys({ ...current(), targets: removed.value }));
        return { ok: true, value: view() };
      },
      startNow: () => startIfDue(true),
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
            const file = resolveDataPath(deps, "journeys", id);
            if (!file.ok) return file;
            const loaded = loadJourney(file.value);
            return loaded.ok ? { ok: true, writes: loaded.value.writes === true } : loaded;
          },
        });
        if (!accepted.ok) return fail(accepted.error);
        void launchOne(accepted);
        const liveUrl = liveDashboardUrl(options.env, WATCH_ENGINE);
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
      live: () => ({ sessions: live.list(), inFlight, events: live.events(), health: snapshot() }),
      runStatus: () => ({ inFlight, events: live.events(), sessions: live.list(), health: snapshot() }),
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
