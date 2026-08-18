/**
 * Headers for Decodo's control-plane API.
 *
 * Two failures that look like a dead key:
 * - no User-Agent → Cloudflare 1010 (python-urllib is banned as a signature)
 * - `Authorization: Token <key>` → 401 "Invalid Api key provided"
 *
 * The live contract is the raw key and a named client. `usage-probe.ts` is
 * the socket; this is the judgement about what to send.
 */
export const DECODO_USER_AGENT = "geoqa/0.1";

export function decodoHeaders(apiKey: string): { authorization: string; accept: string; "user-agent": string } {
  return { authorization: apiKey, accept: "application/json", "user-agent": DECODO_USER_AGENT };
}
