import { z } from "zod";

export const historyFilter = {
  url: z.string().optional().describe("Filter by target URL prefix"),
  geo: z.string().optional().describe("Filter by profile id (e.g. oslo-mobile)"),
  journey: z.string().optional().describe("Filter by journey id"),
  verdict: z.enum(["PASS", "FAIL", "ERROR", "WARNING"]).optional(),
  since: z.string().optional().describe("ISO timestamp — runs started at or after this instant"),
};

export const engineSchema = z.enum(["agent-browser", "playwright"]).optional();
export const providerSchema = z.enum(["direct", "http-proxy"]).optional();

export const runIdSchema = z.string().regex(/^run_[A-Za-z0-9._-]+$/);

export const varsSchema = z.record(z.string()).optional().describe("Journey --var values (secrets not written to evidence)");

export const gateThresholds = {
  blockAtOrAbove: z.enum(["critical", "high", "medium", "low"]).optional(),
  minConfidence: z.number().min(0).max(100).optional(),
  minGeoConfidence: z.number().min(0).max(100).optional(),
};
