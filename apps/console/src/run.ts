/**
 * `pnpm dev` entrypoint: load `.env`, refuse without auth, spawn API + Vite.
 *
 * Coverage-excluded — it binds no port of its own and makes no judgement.
 * Every decision lives in `console.ts` and is covered against an injected spawn.
 * Exercising this file starts the real server and Vite.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDev, type DevChild } from "./console.js";
import { findRepoRoot } from "@geoqa/engine/repo.js";

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

function prefixStream(stream: NodeJS.ReadableStream | null, tag: string): void {
  if (stream === null) return;
  let leftover = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    leftover += chunk;
    const lines = leftover.split("\n");
    leftover = lines.pop() ?? "";
    for (const line of lines) process.stdout.write(`[${tag}] ${line}\n`);
  });
  stream.on("end", () => {
    if (leftover !== "") process.stdout.write(`[${tag}] ${leftover}\n`);
  });
}

let nextTag: "api" | "ui" = "api";
const result = startDev({
  repoRoot,
  env: process.env,
  exists: existsSync,
  read: (p) => readFileSync(p, "utf8"),
  spawn: (command, args, options) => {
    const tag = nextTag;
    nextTag = "ui";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    prefixStream(child.stdout, tag);
    prefixStream(child.stderr, tag);
    child.on("exit", (code) => {
      if (code !== null && code !== 0) process.exitCode = code;
    });
    const handle: DevChild = {
      onExit: (fn) => {
        child.on("exit", fn);
      },
      kill: (signal) => {
        child.kill((signal ?? "SIGTERM") as NodeJS.Signals);
      },
    };
    return handle;
  },
  log: (line) => {
    process.stderr.write(`${line}\n`);
  },
  probe: async (url) => {
    try {
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  },
});

if (!result.ok) {
  process.stderr.write(`${result.error}\n`);
  process.exit(2);
}

const shutdown = (): void => {
  result.stop();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

void result.ready.then((ready) => {
  if (!ready.ok) {
    process.stderr.write(`${ready.error}\n`);
    process.exit(2);
  }
});
