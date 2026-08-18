import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultDeps, findingsFile, renderFindingsFile } from "../commands.js";
import { findRepoRoot } from "../../repo.js";
import type { FileTicketsResult } from "../../findings/github.js";

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
let evidenceRoot: string;
beforeEach(() => {
  evidenceRoot = mkdtempSync(path.join(tmpdir(), "geoqa-file-"));
});
afterEach(() => {
  rmSync(evidenceRoot, { recursive: true, force: true });
});

const record = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schemaVersion: 1,
    runId: "run_1",
    tenantId: null,
    target: "https://xala.no/",
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

describe("findingsFile", () => {
  it("opens one issue per grouped draft, and a second call is already-filed", async () => {
    writeFileSync(path.join(evidenceRoot, "runs.jsonl"), `${record()}\n`);
    const d = defaultDeps(repoRoot, {
      evidenceRoot,
      env: { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "acme/geoqa", GEOQA_CONSOLE_URL: "https://geoqa.example" },
      now: () => 1,
      log: () => undefined,
    });
    const first = await findingsFile(d, {
      create: async () => ({ number: 42, html_url: "https://github.com/acme/geoqa/issues/42" }),
      addLabels: async () => undefined,
    });
    expect(first.filed).toHaveLength(1);
    expect(first.filed[0]?.number).toBe(42);
    const board = JSON.parse(readFileSync(path.join(evidenceRoot, "dashboard.json"), "utf8")) as {
      tickets: { site: string; issue: { measured: boolean; text: string } }[];
    };
    expect(board.tickets[0]?.site).toBe("xala.no");
    expect(board.tickets[0]?.issue.measured).toBe(true);
    expect(board.tickets[0]?.issue.text).toBe("#42");
    const rendered = renderFindingsFile(first);
    expect(rendered).toContain("#42");
    const second = await findingsFile(d, {
      create: async () => {
        throw new Error("should not re-file");
      },
      addLabels: async () => undefined,
    });
    expect(second.already).toHaveLength(1);
  });

  it("names every skip the operator can hit", async () => {
    writeFileSync(path.join(evidenceRoot, "runs.jsonl"), `${record()}\n`);
    const base = defaultDeps(repoRoot, { evidenceRoot, env: {}, now: () => 1, log: () => undefined });
    expect(renderFindingsFile(await findingsFile(base))).toContain("GitHub is off");
    const dry = await findingsFile(
      defaultDeps(repoRoot, {
        evidenceRoot,
        env: { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "acme/geoqa" },
        now: () => 1,
        log: () => undefined,
      }),
      { dryRun: true },
    );
    expect(renderFindingsFile(dry)).toContain("dry run");
    expect(renderFindingsFile(dry)).toContain("has a search box");
    const badStore = await findingsFile(
      defaultDeps(repoRoot, {
        evidenceRoot,
        env: { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "acme/geoqa" },
        now: () => 1,
        log: () => undefined,
      }),
      {
        store: {
          exists: () => true,
          read: () => "{",
          write: () => undefined,
          mkdir: () => undefined,
        },
      },
    );
    expect(renderFindingsFile(badStore)).toContain("unreadable");
  });

  it("renders a GitHub refusal without throwing", () => {
    const result: FileTicketsResult = {
      skipped: "none",
      filed: [],
      already: [],
      failed: [{ key: "urgent:run:open target", error: "403" }],
      wouldFile: [],
    };
    expect(renderFindingsFile(result)).toContain("FAILED");
    expect(renderFindingsFile(result)).toContain("403");
  });

  it("an unknown tenant id does not invent a site repo", async () => {
    writeFileSync(path.join(evidenceRoot, "runs.jsonl"), `${record()}\n`);
    const created: string[] = [];
    await findingsFile(
      defaultDeps(repoRoot, {
        evidenceRoot,
        tenantId: "no-such-tenant",
        env: { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "acme/geoqa" },
        now: () => 1,
        log: () => undefined,
      }),
      {
        create: async (input) => {
          created.push(input.repo);
          return { number: 1, html_url: "https://x/1" };
        },
        addLabels: async () => undefined,
      },
    );
    expect(created).toEqual(["acme/geoqa"]);
  });
});
