/**
 * A real CONNECT through a proxy, reporting what the proxy said.
 *
 * Split out from `provider.ts` and coverage-excluded for the same reason
 * `playwright-launch.ts` is: it is a raw socket and a wire-format parse with no
 * judgement in it. The judgement — what a refusal means for a run — lives in
 * `httpProxyProvider.health()`, where it is fully covered against an injected
 * probe.
 *
 * Why this exists at all. `health()` used to prove only that the gateway was
 * listening, and reported `usable` for a proxy whose credentials were dead and
 * whose traffic was exhausted. That is the zero-balance failure `types.ts` warns
 * about for DataForSEO, and it cost an hour of guessing at usernames.
 *
 * Vendors DO report it, on the 407. Measured against Decodo, two distinct
 * refusals arrive in an `x-error-message` header:
 *
 *   "We couldn't log you in with the details provided"  -> wrong user or password
 *   "You've reached your current traffic limit"          -> credentials fine, no credit
 *
 * Those lead a human to completely different actions, and collapsing both into an
 * opaque 407 is the same mistake as reporting an unread console as clean.
 *
 * CONNECT rather than a plain request, because that is what a browser issues for
 * an https:// target — so this probes the path a run will actually take.
 */
import net from "node:net";
import type { AuthProbe, ProxyAuthResult } from "./types.js";

/** Any https host will do; the CONNECT is refused or accepted before it matters. */
const PROBE_TARGET = "ip.decodo.com:443";

export const authProbe: AuthProbe = (proxyUrl, timeoutMs) =>
  new Promise<ProxyAuthResult>((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(proxyUrl);
    } catch {
      resolve({ ok: false, status: null, detail: "proxy url is not parseable" });
      return;
    }
    const port = parsed.port ? Number(parsed.port) : 80;
    // Credentials are percent-encoded inside a URL and the wire wants raw bytes.
    const auth =
      parsed.username || parsed.password
        ? `Proxy-Authorization: Basic ${Buffer.from(
            `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
          ).toString("base64")}\r\n`
        : "";

    const socket = net.connect({ host: parsed.hostname, port });
    let settled = false;
    let buffer = "";
    const finish = (result: ProxyAuthResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs, () => finish({ ok: false, status: null, detail: "timed out" }));
    socket.once("error", (e: Error) => finish({ ok: false, status: null, detail: e.message }));
    socket.once("connect", () => {
      socket.write(`CONNECT ${PROBE_TARGET} HTTP/1.1\r\nHost: ${PROBE_TARGET}\r\n${auth}\r\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      // Wait for the end of the status line and headers before parsing.
      if (!buffer.includes("\r\n\r\n")) return;
      const status = Number(/HTTP\/1\.[01] (\d{3})/.exec(buffer)?.[1] ?? 0) || null;
      const vendor = /x-error-message:\s*(.+)/i.exec(buffer)?.[1]?.trim() ?? null;
      finish({ ok: status !== null && status >= 200 && status < 300, status, detail: vendor });
    });
  });
