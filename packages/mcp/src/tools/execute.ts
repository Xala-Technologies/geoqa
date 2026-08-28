import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  browserVerify,
  experimentRun,
  findExperiment,
  gateCheck,
  journeyRun,
  loadUrlList,
  matrixRun,
  proxyVerify,
  SAMPLERS,
  type CommandDeps,
  type ExperimentOptions,
  type GateCheckOptions,
  type JourneyRunOptions,
  type MatrixRunOptions,
} from "@geoqa/engine/mcp.js";
import { runTool } from "../json.js";
import { engineSchema, gateThresholds, providerSchema, varsSchema } from "../schemas.js";

const execHint = { destructiveHint: true, openWorldHint: true } as const;

export function registerExecutionTools(server: McpServer, deps: CommandDeps): void {
  server.registerTool(
    "browser_verify",
    {
      description: "Verify browser engine primitives (launches real Chrome)",
      inputSchema: z.object({ url: z.string().optional(), profileId: z.string().optional(), engine: engineSchema }),
      annotations: execHint,
    },
    async (input) =>
      runTool(() =>
        browserVerify(deps, input.url ?? "https://example.com", {
          ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
          ...(input.engine !== undefined ? { engine: input.engine } : {}),
        }),
      ),
  );

  server.registerTool(
    "proxy_verify",
    {
      description: "Verify geographic egress for a profile (launches browser + network session)",
      inputSchema: z.object({
        profileId: z.string(),
        provider: providerSchema,
        engine: engineSchema,
        corroborate: z.boolean().optional(),
        verifyEndpoint: z.string().optional(),
      }),
      annotations: execHint,
    },
    async (input) =>
      runTool(() =>
        proxyVerify(deps, {
          profileId: input.profileId,
          ...(input.provider !== undefined ? { providerName: input.provider } : {}),
          ...(input.engine !== undefined ? { engine: input.engine } : {}),
          ...(input.corroborate !== undefined ? { corroborate: input.corroborate } : {}),
          ...(input.verifyEndpoint !== undefined ? { verifyEndpoint: input.verifyEndpoint } : {}),
        }),
      ),
  );

  server.registerTool(
    "journey_run",
    {
      description: "Run one journey against a URL (real browser, proxy traffic, writes evidence)",
      inputSchema: z.object({
        url: z.string().url(),
        profileId: z.string(),
        journeyId: z.string(),
        provider: providerSchema,
        engine: engineSchema,
        seed: z.number().int().optional(),
        repeat: z.number().int().min(1).max(10).optional(),
        corroborate: z.boolean().optional(),
        headed: z.boolean().optional(),
        tenantId: z.string().optional(),
        vars: varsSchema,
        verifyEndpoint: z.string().optional(),
      }),
      annotations: execHint,
    },
    async (input) => {
      const options: JourneyRunOptions = {
        url: input.url,
        profileId: input.profileId,
        journeyId: input.journeyId,
        ...(input.provider !== undefined ? { providerName: input.provider } : {}),
        ...(input.engine !== undefined ? { engine: input.engine } : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        ...(input.repeat !== undefined ? { repeat: input.repeat } : {}),
        ...(input.corroborate !== undefined ? { corroborate: input.corroborate } : {}),
        ...(input.headed !== undefined ? { headed: input.headed } : {}),
        ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
        ...(input.vars !== undefined ? { vars: input.vars } : {}),
        ...(input.verifyEndpoint !== undefined ? { verifyEndpoint: input.verifyEndpoint } : {}),
      };
      return runTool(() => journeyRun(deps, options));
    },
  );

  server.registerTool(
    "gate_check",
    {
      description: "Publish gate: run a journey and return allow/block/unknown",
      inputSchema: z.object({
        url: z.string().url(),
        profileId: z.string(),
        journeyId: z.string(),
        provider: providerSchema,
        engine: engineSchema,
        tenantId: z.string().optional(),
        seed: z.number().int().optional(),
        ...gateThresholds,
      }),
      annotations: execHint,
    },
    async (input) => {
      const options: GateCheckOptions = {
        url: input.url,
        profileId: input.profileId,
        journeyId: input.journeyId,
        ...(input.provider !== undefined ? { providerName: input.provider } : {}),
        ...(input.engine !== undefined ? { engine: input.engine } : {}),
        ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        ...(input.blockAtOrAbove !== undefined ? { blockAtOrAbove: input.blockAtOrAbove } : {}),
        ...(input.minConfidence !== undefined ? { minConfidence: input.minConfidence } : {}),
        ...(input.minGeoConfidence !== undefined ? { minGeoConfidence: input.minGeoConfidence } : {}),
      };
      return runTool(() => gateCheck(deps, options));
    },
  );

  server.registerTool(
    "matrix_run",
    {
      description: "Run a market × journey matrix (bounded pool, real browsers)",
      inputSchema: z.object({
        url: z.string().url(),
        urlsFile: z.string().optional(),
        markets: z.array(z.string()).min(1),
        journeys: z.array(z.string()).min(1),
        devices: z.array(z.enum(["mobile", "desktop"])).optional(),
        provider: providerSchema,
        engine: engineSchema,
        concurrency: z.number().int().min(1).max(32).optional(),
        seed: z.number().int().optional(),
        repeat: z.number().int().optional(),
        dryRun: z.boolean().optional(),
        durable: z.boolean().optional(),
        allowWrites: z.boolean().optional(),
        corroborate: z.boolean().optional(),
        tenantId: z.string().optional(),
        vars: varsSchema,
      }),
      annotations: execHint,
    },
    async (input) =>
      runTool(async () => {
        let targets: string[] | undefined;
        if (input.urlsFile !== undefined) {
          const listed = loadUrlList(input.urlsFile);
          if (!listed.ok) throw new Error(listed.errors.join("\n"));
          targets = listed.urls;
        }
        const options: MatrixRunOptions = {
          url: input.url,
          markets: input.markets,
          journeys: input.journeys,
          ...(targets !== undefined ? { targets } : {}),
          ...(input.provider !== undefined ? { providerName: input.provider } : {}),
          ...(input.devices !== undefined ? { devices: input.devices } : {}),
          ...(input.engine !== undefined ? { engine: input.engine } : {}),
          ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
          ...(input.repeat !== undefined ? { repeat: input.repeat } : {}),
          ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
          ...(input.durable !== undefined ? { durable: input.durable } : {}),
          ...(input.allowWrites !== undefined ? { allowWrites: input.allowWrites } : {}),
          ...(input.corroborate !== undefined ? { corroborate: input.corroborate } : {}),
          ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
          ...(input.vars !== undefined ? { vars: input.vars } : {}),
        };
        return matrixRun(deps, options);
      }),
  );

  server.registerTool(
    "experiment_run",
    {
      description: "Run a Phase-0 experiment (EXP-001, etc.) with statistical sampling",
      inputSchema: z.object({
        id: z.string().describe("Experiment id, e.g. EXP-001 or 001"),
        samples: z.number().int().min(1).max(500).optional(),
        profileId: z.string().optional(),
        url: z.string().optional(),
        provider: providerSchema,
        engine: engineSchema,
        verifyEndpoint: z.string().optional(),
        concurrency: z.number().int().optional(),
        stabilityWindowMs: z.number().int().optional(),
        stabilityReads: z.number().int().optional(),
      }),
      annotations: execHint,
    },
    async (input) =>
      runTool(async () => {
        const spec = findExperiment(input.id);
        if (!spec) throw new Error(`unknown experiment "${input.id}"`);
        const pair = SAMPLERS[spec.id];
        if (!pair) throw new Error(`experiment "${spec.id}" has no sampler`);
        const options = {
          id: spec.id,
          samples: input.samples ?? 10,
          profileId: input.profileId ?? "oslo-mobile",
          url: input.url ?? "https://example.com",
          ...(input.provider !== undefined ? { providerName: input.provider } : {}),
          ...(input.engine !== undefined ? { engine: input.engine } : {}),
          ...(input.verifyEndpoint !== undefined ? { verifyEndpoint: input.verifyEndpoint } : {}),
          ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
          ...(input.stabilityWindowMs !== undefined ? { stabilityWindowMs: input.stabilityWindowMs } : {}),
          ...(input.stabilityReads !== undefined ? { stabilityReads: input.stabilityReads } : {}),
        } as ExperimentOptions & Record<string, unknown>;
        return experimentRun(deps, options, pair.sample, pair.summarise);
      }),
  );
}
