/**
 * Read a login OTP from AgentMail.
 *
 * Credentials come from the environment only (R-26). The inbox id IS the
 * login email — `digilist-e2e@agentmail.to` — so there is one name to keep
 * correct rather than a pair that can drift. The code never reaches a log
 * line or an evidence file; `receive-otp` fills it and `describeAction`
 * refuses to render it, the same rule `fill` already has.
 *
 * `fetch` / `sleep` / `now` are injectable so the suite never opens a
 * socket. A 503 or an empty inbox is `ok: false` — our defect, not the
 * page's. Collapsing that into a site finding is how a dead mailbox
 * becomes a "login is broken" ticket.
 */
import { pickOtpThread, type InboxThread } from "./otp.js";

export type ReceiveOtpResult = { ok: true; code: string } | { ok: false; detail: string };
export type ReceiveOtp = (input: { afterMs: number }) => Promise<ReceiveOtpResult>;

export const AGENTMAIL_THREADS = "https://api.agentmail.to/v0/inboxes";
export const DEFAULT_OTP_TIMEOUT_MS = 90_000;
export const DEFAULT_OTP_POLL_MS = 2_000;

export interface MailboxPoll {
  apiKey: string;
  inbox: string;
  afterMs: number;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function pollAgentMail(input: MailboxPoll): Promise<ReceiveOtpResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_OTP_TIMEOUT_MS;
  const pollMs = input.pollMs ?? DEFAULT_OTP_POLL_MS;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? wait;
  const get = input.fetch ?? fetch;
  const started = now();
  const after = new Date(input.afterMs).toISOString();
  const url = `${AGENTMAIL_THREADS}/${encodeURIComponent(input.inbox)}/threads?limit=10&after=${encodeURIComponent(after)}`;

  while (now() - started <= timeoutMs) {
    let response: Response;
    try {
      response = await get(url, { headers: { Authorization: `Bearer ${input.apiKey}` } });
    } catch (thrown) {
      return { ok: false, detail: `AgentMail request failed: ${thrown instanceof Error ? thrown.message : String(thrown)}` };
    }
    if (!response.ok) return { ok: false, detail: `AgentMail HTTP ${response.status}` };
    const body = (await response.json()) as { threads?: InboxThread[] };
    const picked = pickOtpThread(body.threads ?? [], input.afterMs);
    if (picked !== null) return { ok: true, code: picked.code };
    if (now() - started + pollMs > timeoutMs) break;
    await sleep(pollMs);
  }
  return { ok: false, detail: "no login code arrived in the AgentMail inbox before the timeout" };
}

export function mailboxFromEnv(
  env: NodeJS.ProcessEnv,
  over: Partial<Omit<MailboxPoll, "apiKey" | "inbox" | "afterMs">> = {},
): ReceiveOtp | undefined {
  const apiKey = env.AGENTMAIL_API_KEY;
  const inbox = env.GEOQA_LOGIN_EMAIL;
  if (apiKey === undefined || apiKey === "" || inbox === undefined || inbox === "") return undefined;
  return (input) => pollAgentMail({ apiKey, inbox, afterMs: input.afterMs, ...over });
}
