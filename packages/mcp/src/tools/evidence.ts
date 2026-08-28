import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  evidenceInspect,
  evidencePrune,
  loadEvidencePackage,
  loadEvidenceShot,
  nodePackageFs,
  parsePrunePolicy,
  type CommandDeps,
} from "@geoqa/engine/mcp.js";
import { jsonError, jsonText, runTool } from "../json.js";
import { runIdSchema } from "../schemas.js";

export function registerEvidenceTools(server: McpServer, deps: CommandDeps): void {
  server.registerTool(
    "evidence_manifest",
    { description: "Evidence manifest for one run (artifacts, tier, completeness)", inputSchema: z.object({ runId: runIdSchema }) },
    async ({ runId }) => jsonText(evidenceInspect(deps, runId)),
  );

  server.registerTool(
    "evidence_get",
    { description: "Full evidence package: steps, issues, console, brief", inputSchema: z.object({ runId: runIdSchema }) },
    async ({ runId }) => {
      const loaded = loadEvidencePackage(deps.evidenceRoot, runId, nodePackageFs);
      return loaded.ok ? jsonText(loaded.value) : jsonError(loaded.error);
    },
  );

  server.registerTool(
    "evidence_screenshot",
    {
      description: "Screenshot from a run as base64",
      inputSchema: z.object({ runId: runIdSchema, label: z.string().regex(/^[A-Za-z0-9._-]+$/) }),
    },
    async ({ runId, label }) => {
      const shot = loadEvidenceShot(deps.evidenceRoot, runId, label, nodePackageFs);
      return shot === null ? jsonError(`no screenshot "${label}" for run "${runId}"`) : jsonText({ runId, label, mime: shot.type, dataBase64: shot.body.toString("base64") });
    },
  );

  server.registerTool(
    "evidence_prune",
    {
      description: "Plan evidence pruning (dry run by default). Pass apply:true to delete.",
      inputSchema: z.object({
        apply: z.boolean().optional().describe("When true, deletes planned runs"),
        maxAge: z.record(z.string()).optional().describe('e.g. {"pass":"7","fail":"30"}'),
        maxTotal: z.string().optional(),
        privacyDays: z.string().optional(),
        sweepTiers: z.string().optional(),
        deleteUnreadable: z.boolean().optional(),
      }),
      annotations: { destructiveHint: true },
    },
    async (input) =>
      runTool(() => {
        const flags = {
          ...(input.maxAge !== undefined ? { maxAge: input.maxAge } : {}),
          ...(input.maxTotal !== undefined ? { maxTotal: input.maxTotal } : {}),
          ...(input.privacyDays !== undefined ? { privacyDays: input.privacyDays } : {}),
          ...(input.sweepTiers !== undefined ? { sweepTiers: input.sweepTiers.split(",").map((s) => s.trim()) } : {}),
          ...(input.deleteUnreadable !== undefined ? { deleteUnreadable: input.deleteUnreadable } : {}),
        };
        const policy = Object.keys(flags).length > 0 ? parsePrunePolicy(flags) : { ok: true as const, value: undefined };
        if (!policy.ok) throw new Error(policy.errors.join("\n"));
        return evidencePrune(deps, { ...(policy.value !== undefined ? { policy: policy.value } : {}), apply: input.apply === true });
      }),
  );
}
