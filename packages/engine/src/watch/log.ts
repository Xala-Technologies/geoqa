/**
 * The watch's own log, persisted under the evidence root.
 *
 * Live events die with the process. The hung-proxy stall lived only in
 * journalctl, and a restart wiped the board. This file is the operator
 * record: sweep start/finish/fail, and a stall the health check named.
 * Appending must never be able to fail a sweep — same rule as the run index.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { describeThrown } from "../errors.js";
import type { WatchFinding } from "./health.js";

export const WATCH_LOG_FILE = "watch-log.jsonl";
export const KEEP_WATCH_LOG = 400;

export const WatchLogKindSchema = z.enum([
  "sweep-started",
  "sweep-finished",
  "sweep-failed",
  "sweep-refused",
  "session-stalled",
  "sweep-hung",
  "clock-unreadable",
]);

export const WatchLogLevelSchema = z.enum(["info", "warning", "error"]);

export const WatchLogEventSchema = z
  .object({
    at: z.string().min(1),
    level: WatchLogLevelSchema,
    kind: WatchLogKindSchema,
    message: z.string().min(1),
    sessionId: z.string().min(1).optional(),
  })
  .strict();

export type WatchLogKind = z.infer<typeof WatchLogKindSchema>;
export type WatchLogLevel = z.infer<typeof WatchLogLevelSchema>;
export type WatchLogEvent = z.infer<typeof WatchLogEventSchema>;

export interface WatchLogFs {
  exists: (p: string) => boolean;
  read: (p: string) => string;
  append: (p: string, text: string) => void;
  write: (p: string, text: string) => void;
  mkdir: (p: string) => void;
}

export const nodeWatchLogFs: WatchLogFs = {
  exists: existsSync,
  read: (p) => readFileSync(p, "utf8"),
  append: (p, text) => appendFileSync(p, text),
  write: (p, text) => writeFileSync(p, text, "utf8"),
  mkdir: (p) => mkdirSync(p, { recursive: true }),
};

export const watchLogPath = (evidenceRoot: string): string => path.join(evidenceRoot, WATCH_LOG_FILE);

export function parseWatchEvent(line: string): WatchLogEvent | null {
  if (line.trim() === "") return null;
  try {
    const parsed = WatchLogEventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Newest first, capped. The console polls; dumping the whole ring is a screenshot of 400 stalls. */
export function recentWatchEvents(events: WatchLogEvent[], limit = 50): WatchLogEvent[] {
  return events.slice(-limit).reverse();
}

export function eventFromFinding(finding: WatchFinding, at: string): WatchLogEvent {
  return {
    at,
    level: "error",
    kind: finding.kind,
    message: finding.message,
    ...(finding.sessionId !== undefined ? { sessionId: finding.sessionId } : {}),
  };
}

export interface WatchLogRead {
  events: WatchLogEvent[];
  skipped: number;
}

/**
 * Read the log, oldest first.
 *
 * A missing file is empty, not an error: a first boot has never swept.
 */
export function readWatchLog(evidenceRoot: string, fs: WatchLogFs = nodeWatchLogFs): WatchLogRead {
  const file = watchLogPath(evidenceRoot);
  if (!fs.exists(file)) return { events: [], skipped: 0 };
  let text: string;
  try {
    text = fs.read(file);
  } catch {
    return { events: [], skipped: 0 };
  }
  const events: WatchLogEvent[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const event = parseWatchEvent(line);
    if (event === null) skipped += 1;
    else events.push(event);
  }
  return { events, skipped };
}

/**
 * Append one event. Returns the problem it hit, or null.
 *
 * A trailing newline per line, always — an omitted newline joins two
 * records and makes the *next* event look broken.
 */
export function appendWatchEvent(
  evidenceRoot: string,
  event: WatchLogEvent,
  fs: WatchLogFs = nodeWatchLogFs,
): string | null {
  const file = watchLogPath(evidenceRoot);
  try {
    fs.mkdir(evidenceRoot);
    fs.append(file, `${JSON.stringify(event)}\n`);
  } catch (e) {
    return `could not append to the watch log: ${describeThrown(e)}`;
  }
  return trimWatchLog(evidenceRoot, fs);
}

function trimWatchLog(evidenceRoot: string, fs: WatchLogFs): string | null {
  const read = readWatchLog(evidenceRoot, fs);
  if (read.events.length <= KEEP_WATCH_LOG) return null;
  const kept = read.events.slice(read.events.length - KEEP_WATCH_LOG);
  try {
    fs.write(watchLogPath(evidenceRoot), `${kept.map((event) => JSON.stringify(event)).join("\n")}\n`);
    return null;
  } catch (e) {
    return `could not trim the watch log: ${describeThrown(e)}`;
  }
}
