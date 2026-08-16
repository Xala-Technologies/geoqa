#!/usr/bin/env node
/**
 * `geoqa` entrypoint. Runs the TypeScript CLI through tsx — there is no build
 * step, the source ships and executes directly.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli", "index.ts");

const child = spawn("npx", ["tsx", cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
