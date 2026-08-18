/**
 * The real git/gh spawn for repair. Coverage-excluded: exercising it
 * talks to GitHub and writes a clone. Every decision lives in repair.ts.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import type { RepairExec } from "./repair.js";

export const nodeRepairExec: RepairExec = {
  mkdir: (p) => {
    mkdirSync(p, { recursive: true });
  },
  exists: existsSync,
  rm: (p) => {
    rmSync(p, { recursive: true, force: true });
  },
  run: (input) =>
    new Promise((resolve) => {
      const bin = input.argv[0];
      if (bin === undefined) {
        resolve({ stdout: "", stderr: "repair exec has no command", exitCode: 1 });
        return;
      }
      const child = spawn(bin, input.argv.slice(1), {
        cwd: input.cwd,
        env: input.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, input.timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({ stdout: "", stderr: "", exitCode: 1, error: error.message });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: code ?? 1,
          ...(signal === "SIGKILL" ? { error: "repair command timed out" } : {}),
        });
      });
    }),
};
