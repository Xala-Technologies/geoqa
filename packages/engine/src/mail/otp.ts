/**
 * Pull a one-time login code out of an inbox thread.
 *
 * The code is a SECRET the moment it exists. This module returns it to the
 * journey engine so a `receive-otp` step can type it; nothing here logs,
 * stringifies a thread for a human, or writes the digits to disk.
 *
 * A year (`2026`) and a 5-digit ref are not a login code. Matching on a
 * standalone 6-digit token is what stops those from being typed into `#otp`.
 */

export interface InboxThread {
  thread_id: string;
  timestamp: string;
  subject?: string | null;
  preview?: string | null;
  senders?: string[];
}

export interface PickedOtp {
  thread_id: string;
  code: string;
}

const OTP = /\b(\d{6})\b/;

export function extractOtp(text: string | null | undefined): string | null {
  if (text === null || text === undefined || text === "") return null;
  return OTP.exec(text)?.[1] ?? null;
}

export function pickOtpThread(threads: readonly InboxThread[], afterMs: number): PickedOtp | null {
  const newestFirst = [...threads].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  for (const thread of newestFirst) {
    if (Date.parse(thread.timestamp) < afterMs) continue;
    const code = extractOtp(thread.preview) ?? extractOtp(thread.subject);
    if (code !== null) return { thread_id: thread.thread_id, code };
  }
  return null;
}
