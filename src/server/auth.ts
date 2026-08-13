/**
 * Authentication: password verification and session tokens.
 *
 * **Why this file has no I/O.** Every security decision here is a pure function over strings, so
 * the whole of it is testable without a socket, a clock or a filesystem — and a security control
 * that is hard to test is a security control nobody has checked. `http.ts` does the plumbing.
 *
 * Four rules, each of which has a specific failure it exists to prevent:
 *
 * 1. **No default credential.** A server with no configured password REFUSES to start rather
 *    than falling back to one. The same default-deny the publish gate uses: a lock that opens
 *    when it cannot see is not a lock, and "admin/admin until you change it" is how every
 *    exposed dashboard is exposed.
 * 2. **The password is never stored, only its hash** — and the hash comes from the ENVIRONMENT,
 *    never a config file (R-26). A file is committed, backed up and diffed by people who never
 *    intended to handle a credential.
 * 3. **Comparisons are timing-safe.** A `===` on a token leaks its prefix to anyone willing to
 *    measure, and a session token is a credential.
 * 4. **A session token is signed, not stored.** No server-side session table, so there is no
 *    state to lose on restart and nothing to grow without bound — the cost is that revoking one
 *    session early means rotating the secret, which is stated rather than discovered.
 */
import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

/** The env var holding the password hash. Named here so nothing else spells it. */
export const PASSWORD_ENV = "GEOQA_ADMIN_PASSWORD_HASH";
/** The env var holding the HMAC key that signs session tokens. */
export const SECRET_ENV = "GEOQA_SESSION_SECRET";

/**
 * PBKDF2 rather than a bare hash, and the parameters are part of the stored format.
 *
 * A password hash whose cost is fixed in code cannot be raised without invalidating every
 * existing hash; storing the iteration count with the hash means an old credential keeps
 * verifying while new ones get the newer cost. 210,000 is OWASP's 2023 figure for PBKDF2-SHA512.
 *
 * PBKDF2 and not scrypt because it is synchronous in Node without a callback dance and its
 * parameters serialise to one line. scrypt is the better algorithm; this is the one whose
 * misuse-surface is smallest, and a correctly-used weaker KDF beats a badly-used stronger one.
 */
const ITERATIONS = 210_000;
const KEY_LENGTH = 64;
const DIGEST = "sha512";

/**
 * `pbkdf2:<iterations>:<salt-hex>:<hash-hex>` — self-describing, so the cost can be raised.
 *
 * **Colons, not the conventional `$`, and this was measured rather than chosen.** The PHC
 * format uses `$`, and a `$` in an environment variable is a variable reference to every shell
 * there is. Put a `$`-separated hash in a `.env` file, a docker-compose `environment:` block or
 * a shell profile without single quotes and `$210000` expands to nothing — leaving
 * `pbkdf2dde57daa…`, which fails verification as "sign-in failed", the least diagnosable error
 * available. Found by doing exactly that while testing this server.
 *
 * A colon appears in no shell expansion and in no hex digit, so the format survives every way a
 * person will actually transport it. Compatibility with PHC buys nothing here: nothing else
 * reads these hashes.
 */
export function hashPassword(password: string, salt: string = randomBytes(16).toString("hex")): string {
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString("hex");
  return `pbkdf2:${ITERATIONS}:${salt}:${hash}`;
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false for a malformed stored hash rather than throwing, because the alternative is a
 * server that crashes on a typo in an environment variable — and a crash loop is an outage that
 * looks like an attack.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = parts[3];
  if (!Number.isInteger(iterations) || iterations < 1 || salt === undefined || expected === undefined) return false;
  const actual = pbkdf2Sync(password, salt, iterations, KEY_LENGTH, DIGEST).toString("hex");
  return safeEqual(actual, expected);
}

/**
 * Constant-time string comparison.
 *
 * Length is compared first and NOT in constant time, which is deliberate and safe: the length of
 * a hash is public — it is fixed by the algorithm — and `timingSafeEqual` throws on a length
 * mismatch rather than returning false, so something has to check it.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface Session {
  user: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** Eight hours. Long enough for a working day, short enough that a forgotten tab is not a key. */
export const SESSION_MS = 8 * 60 * 60 * 1000;

/**
 * `<user>.<expiry>.<hmac>` — signed, not encrypted.
 *
 * Nothing secret is in it, so encryption would add a key to manage and hide nothing. The
 * signature covers the expiry as well as the user, which is the part that matters: an unsigned
 * expiry is an expiry the holder can edit.
 */
export function signSession(session: Session, secret: string): string {
  const payload = `${encodeURIComponent(session.user)}.${session.expiresAt}`;
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

/**
 * Verify and decode, or null.
 *
 * Null for every failure — bad shape, bad signature, expired — rather than distinguishing them.
 * A caller has nothing different to do about a forged token and an expired one, and an error
 * message that told them apart would tell an attacker apart too.
 */
export function readSession(token: string, secret: string, nowMs: number): Session | null {
  const cut = token.lastIndexOf(".");
  if (cut <= 0) return null;
  const payload = token.slice(0, cut);
  const signature = token.slice(cut + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  if (!safeEqual(signature, expected)) return null;

  const dot = payload.lastIndexOf(".");
  if (dot <= 0) return null;
  const user = decodeURIComponent(payload.slice(0, dot));
  const expiresAt = Number(payload.slice(dot + 1));
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return null;
  return { user, expiresAt };
}

export interface AuthConfig {
  passwordHash: string;
  secret: string;
}

/**
 * The configuration, or the reason there is none.
 *
 * **Refuses rather than defaults**, and says which variable is missing and how to produce it.
 * A server that started with a generated password nobody saw would be a server nobody can log
 * into; one that started with a KNOWN default is worse. Both are avoided by not starting.
 */
export function readAuthConfig(env: NodeJS.ProcessEnv): { ok: true; config: AuthConfig } | { ok: false; error: string } {
  const passwordHash = env[PASSWORD_ENV];
  const secret = env[SECRET_ENV];
  if (passwordHash === undefined || passwordHash === "") {
    return {
      ok: false,
      error: `${PASSWORD_ENV} is not set, and this server will not start without it — there is no default password on purpose. Generate one with: pnpm geoqa server hash <password>`,
    };
  }
  if (secret === undefined || secret === "") {
    return {
      ok: false,
      error: `${SECRET_ENV} is not set. It signs session cookies; without it a session token could be forged. Generate one with: node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`,
    };
  }
  // A short secret is worse than an obviously absent one, because it looks configured.
  if (secret.length < 32) {
    return { ok: false, error: `${SECRET_ENV} is shorter than 32 characters. A guessable signing key forges sessions.` };
  }
  return { ok: true, config: { passwordHash, secret } };
}

/** The cookie a browser gets. `HttpOnly` so script cannot read it; `SameSite=Strict` so a
 * cross-site form cannot ride it; `Secure` omitted only for localhost, where there is no TLS. */
export function sessionCookie(token: string, maxAgeMs: number, secure: boolean): string {
  const attrs = ["Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (secure) attrs.push("Secure");
  return `geoqa_session=${token}; ${attrs.join("; ")}`;
}

/** The cookie that ends a session: same attributes, zero lifetime. */
export function clearedCookie(secure: boolean): string {
  return sessionCookie("", 0, secure);
}

/** Pull our cookie out of a `Cookie` header. Returns null rather than an empty string. */
export function cookieValue(header: string | undefined, name = "geoqa_session"): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value === "" ? null : value;
    }
  }
  return null;
}
