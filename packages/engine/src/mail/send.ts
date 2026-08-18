/**
 * Send one message from an AgentMail inbox.
 *
 * Credentials stay in the header. The body is subject + text + html —
 * never the key. Injectable fetch so the suite opens no socket.
 */
import { AGENTMAIL_THREADS } from "./agentmail.js";

export const AGENTMAIL_SEND = AGENTMAIL_THREADS;

export type SendMailResult = { ok: true; messageId: string; threadId: string } | { ok: false; detail: string };

export interface SendMailInput {
  apiKey: string;
  inbox: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  fetch?: typeof fetch;
}

export async function sendAgentMail(input: SendMailInput): Promise<SendMailResult> {
  const get = input.fetch ?? fetch;
  const url = `${AGENTMAIL_SEND}/${encodeURIComponent(input.inbox)}/messages/send`;
  let response: Response;
  try {
    response = await get(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        to: [input.to],
        subject: input.subject,
        text: input.text,
        html: input.html,
      }),
    });
  } catch (thrown) {
    return { ok: false, detail: `AgentMail request failed: ${thrown instanceof Error ? thrown.message : String(thrown)}` };
  }
  if (!response.ok) return { ok: false, detail: `AgentMail HTTP ${response.status}` };
  const body = (await response.json()) as { message_id?: string; thread_id?: string };
  if (body.message_id === undefined || body.thread_id === undefined) {
    return { ok: false, detail: "AgentMail send returned no message id" };
  }
  return { ok: true, messageId: body.message_id, threadId: body.thread_id };
}
