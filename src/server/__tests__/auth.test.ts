import { createHmac, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  clearedCookie,
  cookieValue,
  hashPassword,
  readAuthConfig,
  readSession,
  safeEqual,
  sessionCookie,
  signSession,
  verifyPassword,
  PASSWORD_ENV,
  SECRET_ENV,
} from "../auth.js";

const SECRET = "a".repeat(64);

describe("hashPassword / verifyPassword", () => {
  it("verifies the right password and rejects the wrong one", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("Correct horse battery staple", stored)).toBe(false);
  });

  it("produces a DIFFERENT hash for the same password every time", () => {
    // A random salt per hash. Without it two accounts with the same password have the same
    // stored value, which tells an attacker who cracks one that they have cracked both.
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("stores its cost, so it can be raised without invalidating existing hashes", () => {
    expect(hashPassword("x").startsWith("pbkdf2:210000:")).toBe(true);

    // A hash genuinely computed at a LOWER cost still verifies, which is the whole point of
    // writing the iteration count into the stored value: raising the cost for new credentials
    // must not lock out existing ones. Built with pbkdf2 directly rather than by editing a
    // string, because editing the count without recomputing the hash tests nothing — it just
    // produces a corrupt value, which the malformed-input test already covers.
    const cheap = `pbkdf2:1000:deadbeef:${pbkdf2Sync("x", "deadbeef", 1000, 64, "sha512").toString("hex")}`;
    expect(verifyPassword("x", cheap)).toBe(true);
    expect(verifyPassword("wrong", cheap)).toBe(false);
  });

  it("contains NO character a shell would expand, because that is how it is transported", () => {
    // Found by putting a `$`-separated hash in a .env file and sourcing it: `$210000` expanded
    // to nothing, the hash silently became `pbkdf2dde57daa…`, and it failed as "sign-in failed"
    // — the least diagnosable error available. Every unit test passed throughout, because none
    // of them sent the value through a shell.
    const stored = hashPassword("x");
    for (const hostile of ["$", "`", '"', "'", "\\", "!"]) {
      expect(stored, `hash contains ${hostile}, which a shell will eat`).not.toContain(hostile);
    }
  });

  it("returns false for a malformed stored hash rather than throwing", () => {
    // A typo in an environment variable must not become a crash loop, which is an outage that
    // looks like an attack.
    for (const bad of ["", "nonsense", "pbkdf2:x:y:z", "bcrypt:1:a:b", "pbkdf2:210000:onlythree"]) {
      expect(() => verifyPassword("x", bad)).not.toThrow();
      expect(verifyPassword("x", bad)).toBe(false);
    }
  });
});

describe("safeEqual", () => {
  it("compares equal strings as equal and different ones as different", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
  });

  it("returns false for different lengths instead of throwing", () => {
    // `timingSafeEqual` throws on a length mismatch, so something has to check first. The
    // length of a hash is public — fixed by the algorithm — so checking it leaks nothing.
    expect(() => safeEqual("short", "much longer")).not.toThrow();
    expect(safeEqual("short", "much longer")).toBe(false);
  });
});

describe("session tokens", () => {
  it("round-trips a session", () => {
    const token = signSession({ user: "admin", expiresAt: 2_000 }, SECRET);
    expect(readSession(token, SECRET, 1_000)).toEqual({ user: "admin", expiresAt: 2_000 });
  });

  it("REJECTS a token signed with a different secret", () => {
    const token = signSession({ user: "admin", expiresAt: 2_000 }, SECRET);
    expect(readSession(token, "b".repeat(64), 1_000)).toBeNull();
  });

  it("REJECTS an edited expiry, because the signature covers it", () => {
    // The attack this stops: take a valid token, change the timestamp, keep the signature.
    const token = signSession({ user: "admin", expiresAt: 2_000 }, SECRET);
    const forged = token.replace("2000", "9999999999999");
    expect(readSession(forged, SECRET, 1_000)).toBeNull();
  });

  it("REJECTS an expired token even though its signature is valid", () => {
    const token = signSession({ user: "admin", expiresAt: 1_000 }, SECRET);
    expect(readSession(token, SECRET, 1_000)).toBeNull();
    expect(readSession(token, SECRET, 999)).not.toBeNull();
  });

  it("returns null for every malformed shape rather than throwing", () => {
    for (const bad of ["", ".", "no-dots", "a.b", "user.notanumber.sig"]) {
      expect(() => readSession(bad, SECRET, 1)).not.toThrow();
      expect(readSession(bad, SECRET, 1)).toBeNull();
    }
  });

  it("rejects a payload whose expiry is not a number, even when correctly signed", () => {
    // Reachable by signing a malformed payload with the real secret — which an attacker who
    // ever obtains the secret can do. `Number("")` is 0 and `Number("abc")` is NaN, and only
    // the explicit isFinite check separates "expired long ago" from "not a timestamp".
    const forge = (payload: string): string =>
      `${payload}.${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
    expect(readSession(forge("admin.notanumber"), SECRET, 1)).toBeNull();
    expect(readSession(forge("admin.Infinity"), SECRET, 1)).toBeNull();
    // And a payload with no dot at all, correctly signed.
    expect(readSession(forge("nodothere"), SECRET, 1)).toBeNull();
  });

  it("survives a user name containing a dot", () => {
    // The payload is split on the LAST dot for exactly this reason.
    const token = signSession({ user: "first.last@example.com", expiresAt: 2_000 }, SECRET);
    expect(readSession(token, SECRET, 1_000)?.user).toBe("first.last@example.com");
  });
});

describe("readAuthConfig", () => {
  it("REFUSES when no password hash is set, and never defaults to one", () => {
    // "admin/admin until you change it" is how every exposed dashboard is exposed.
    const out = readAuthConfig({});
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toContain(PASSWORD_ENV);
    expect(out.ok === false && out.error).toContain("no default password");
  });

  it("REFUSES when the signing secret is missing", () => {
    const out = readAuthConfig({ [PASSWORD_ENV]: "pbkdf2:1:a:b" });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toContain(SECRET_ENV);
  });

  it("REFUSES a short signing secret, which looks configured and is guessable", () => {
    const out = readAuthConfig({ [PASSWORD_ENV]: "pbkdf2:1:a:b", [SECRET_ENV]: "tooshort" });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toContain("32 characters");
  });

  it("accepts a complete configuration", () => {
    const out = readAuthConfig({ [PASSWORD_ENV]: "pbkdf2:1:a:b", [SECRET_ENV]: SECRET });
    expect(out.ok).toBe(true);
    expect(out.ok === true && out.config.secret).toBe(SECRET);
  });
});

describe("cookies", () => {
  it("is HttpOnly and SameSite=Strict, so script cannot read it and a cross-site form cannot ride it", () => {
    const cookie = sessionCookie("tok", 3_600_000, false);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=3600");
    expect(cookie).not.toContain("Secure");
  });

  it("adds Secure when the server is behind TLS", () => {
    expect(sessionCookie("tok", 1000, true)).toContain("Secure");
  });

  it("clears with the SAME attributes, or the browser keeps the old cookie", () => {
    const cleared = clearedCookie(false);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("HttpOnly");
  });

  it("reads its own cookie out of a header carrying several", () => {
    expect(cookieValue("other=1; geoqa_session=abc; third=2")).toBe("abc");
    expect(cookieValue("geoqa_session=abc")).toBe("abc");
  });

  it("returns null rather than an empty string for an absent or empty cookie", () => {
    expect(cookieValue(undefined)).toBeNull();
    expect(cookieValue("other=1")).toBeNull();
    expect(cookieValue("geoqa_session=")).toBeNull();
    expect(cookieValue("malformed")).toBeNull();
  });
});
