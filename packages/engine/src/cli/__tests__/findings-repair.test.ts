import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultDeps, findingsRepair, renderFindingsRepair } from "../commands.js";
import { findRepoRoot } from "../../repo.js";
import type { FindingsRepairResult } from "../commands.js";
import type { RepairExec } from "../../assist/repair.js";

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
let evidenceRoot: string;
beforeEach(() => {
  evidenceRoot = mkdtempSync(path.join(tmpdir(), "geoqa-repair-"));
});
afterEach(() => {
  rmSync(evidenceRoot, { recursive: true, force: true });
});

const record = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schemaVersion: 1,
    runId: "run_1",
    tenantId: "digilist",
    target: "https://app.digilist.no/",
    profileId: "oslo-desktop",
    journeyId: "search",
    verdict: "FAIL",
    startedAt: "2026-08-18T21:00:00.000Z",
    durationMs: 5,
    seed: 1,
    engine: "playwright",
    evidenceId: null,
    findings: { total: 1, bySeverity: { high: 1 }, byCategory: { functional: 1 }, labels: ["has a search box"] },
    confidence: { overall: 80, geo: 100, browser: 100, journey: 80, evidence: 80 },
    geo: {
      requestedCountry: "NO",
      requestedCity: "Oslo",
      observedCountry: "NO",
      observedCity: "Oslo",
      country: "match",
      city: "match",
      egressHeld: "match",
      agreement: "unverified",
    },
    latencyMs: 10,
    vitals: { lcp: null, cls: null, ttfb: null, inp: null },
    ...over,
  });

const filed = {
  issues: [
    {
      key: "site:has a search box:app.digilist.no",
      number: 46,
      url: "https://github.com/Xala-Technologies/geoqa/issues/46",
      at: "2026-08-18T21:00:00.000Z",
    },
  ],
};

const okExec = (): RepairExec => ({
  mkdir: () => undefined,
  exists: () => false,
  rm: () => undefined,
  run: async (input) => {
    if (input.argv.includes("status")) return { stdout: " M src/x.ts\n", stderr: "", exitCode: 0 };
    if (input.argv.includes("log")) return { stdout: "", stderr: "", exitCode: 0 };
    if (input.argv.includes("create")) return { stdout: "https://github.com/Xala-Technologies/Digilist/pull/1\n", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  },
});

describe("findingsRepair", () => {
  it("dry-runs a Digilist job from dev, then opens a PR and remembers so a second call is nothing-new", async () => {
    writeFileSync(path.join(evidenceRoot, "runs.jsonl"), `${record()}\n`);
    writeFileSync(path.join(evidenceRoot, "filed-issues.json"), `${JSON.stringify(filed)}\n`);
    const d = defaultDeps(repoRoot, {
      evidenceRoot,
      tenantId: "digilist",
      env: { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "Xala-Technologies/geoqa" },
      now: () => 1,
      log: () => undefined,
    });
    const dry = await findingsRepair(d, { dryRun: true });
    expect(dry.skipped).toBe("dry-run");
    expect(dry.wouldRepair[0]?.codeRepo).toBe("Xala-Technologies/Digilist");
    expect(dry.wouldRepair[0]?.base).toBe("dev");
    expect(renderFindingsRepair(dry)).toContain("dev");

    const first = await findingsRepair(d, {
      exec: okExec(),
      claude: async () => ({ ok: true, text: "fixed" }),
    });
    expect(first.repaired[0]?.status).toBe("opened");
    expect(first.repaired[0]?.prUrl).toContain("Digilist/pull/1");
    expect(renderFindingsRepair(first)).toContain("opened");
    const board = JSON.parse(readFileSync(path.join(evidenceRoot, "dashboard.json"), "utf8")) as {
      tickets: { site: string; pr: { measured: boolean } }[];
    };
    expect(board.tickets.some((t) => t.site === "app.digilist.no" && t.pr.measured)).toBe(true);

    const second = await findingsRepair(d, {
      exec: okExec(),
      claude: async () => ({ ok: true, text: "fixed" }),
    });
    expect(second.skipped).toBe("nothing-new");
    expect(renderFindingsRepair(second)).toContain("nothing new");
  });

  it("names every skip, and a failed repair is not remembered", async () => {
    writeFileSync(path.join(evidenceRoot, "runs.jsonl"), `${record()}\n`);
    const base = defaultDeps(repoRoot, { evidenceRoot, env: {}, now: () => 1, log: () => undefined });
    expect(renderFindingsRepair(await findingsRepair(base))).toContain("GitHub is off");

    writeFileSync(path.join(evidenceRoot, "filed-issues.json"), "{\n");
    const broken = defaultDeps(repoRoot, {
      evidenceRoot,
      env: { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "acme/geoqa" },
      now: () => 1,
      log: () => undefined,
    });
    expect(renderFindingsRepair(await findingsRepair(broken))).toContain("unreadable");

    writeFileSync(path.join(evidenceRoot, "filed-issues.json"), `${JSON.stringify(filed)}\n`);
    writeFileSync(path.join(evidenceRoot, "repaired-issues.json"), "{\n");
    expect(renderFindingsRepair(await findingsRepair(broken))).toContain("unreadable");

    writeFileSync(path.join(evidenceRoot, "repaired-issues.json"), `${JSON.stringify({ keys: [] })}\n`);
    const empty = await findingsRepair(broken, { onlyKeys: [] });
    expect(empty.skipped).toBe("nothing-new");

    const failed = await findingsRepair(
      defaultDeps(repoRoot, {
        evidenceRoot,
        tenantId: "digilist",
        env: { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "Xala-Technologies/geoqa" },
        now: () => 1,
        log: () => undefined,
      }),
      {
        exec: {
          mkdir: () => undefined,
          exists: () => false,
          rm: () => undefined,
          run: async () => ({ stdout: "", stderr: "clone failed", exitCode: 1 }),
        },
        claude: async () => ({ ok: true, text: "x" }),
      },
    );
    expect(failed.failed[0]?.key).toContain("search box");
    expect(renderFindingsRepair(failed)).toContain("FAILED");

    const retry = await findingsRepair(
      defaultDeps(repoRoot, {
        evidenceRoot,
        tenantId: "digilist",
        env: { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "Xala-Technologies/geoqa" },
        now: () => 1,
        log: () => undefined,
      }),
      { dryRun: true },
    );
    expect(retry.wouldRepair).toHaveLength(1);
  });

  it("renders a cannot-fix as skipped, not opened", () => {
    const result: FindingsRepairResult = {
      skipped: "none",
      repaired: [{ key: "urgent:geo-mismatch", status: "cannot-fix", detail: "CANNOT_FIX: vendor" }],
      failed: [],
      wouldRepair: [],
    };
    const text = renderFindingsRepair(result);
    expect(text).toContain("opened 0");
    expect(text).toContain("cannot-fix");
  });
});
