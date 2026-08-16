/**
 * The real `claude` spawn. Coverage-excluded: exercising it talks to the
 * operator's Claude Code CLI, which the unit suite must never do.
 */
import { spawn } from "node:child_process";
import type { ClaudeSpawn } from "./claude.js";

export const nodeClaudeSpawn: ClaudeSpawn = (args, options) =>
  new Promise((resolve) => {
    const child = spawn(options.bin, args, {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: "", exitCode: null, error });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code,
        ...(signal === "SIGKILL" ? { error: Object.assign(new Error("claude -p timed out"), { code: "ETIMEDOUT" }) } : {}),
      });
    });
    child.stdin?.end(options.stdin);
  });
