import { GEOQA_SCHEMA_VERSION } from "@geoqa/engine/mcp.js";

export const jsonText = (value: unknown): { content: [{ type: "text"; text: string }] } => ({
  content: [{ type: "text", text: JSON.stringify(wrap(value), null, 2) }],
});

export const jsonError = (message: string): { isError: true; content: [{ type: "text"; text: string }] } => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

export const wrap = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? { schemaVersion: GEOQA_SCHEMA_VERSION, ...value as object }
    : { schemaVersion: GEOQA_SCHEMA_VERSION, value };

export async function runTool<T>(fn: () => Promise<T> | T): Promise<{ content: [{ type: "text"; text: string }]; isError?: true }> {
  try {
    return jsonText(await fn());
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : String(e));
  }
}
