import { describe, expect, it } from "vitest";
import {
  MASK,
  isSensitiveKey,
  redact,
  redactCredentials,
  redactDeep,
  redactEmails,
  redactNationalIds,
  redactQueryParams,
  screenshotRisk,
} from "../redact.js";

describe("redactCredentials", () => {
  it("masks user:pass in a proxy URL — the most likely leak in this engine", () => {
    expect(redactCredentials("http://user:s3cret@gw.vendor.io:7777")).toBe(`http://${MASK}:${MASK}@gw.vendor.io:7777`);
  });

  it("masks credentials inside a longer log line, and every occurrence", () => {
    const line = "launch --proxy socks5://a:b@x:1 then --proxy http://c:d@y:2";
    const out = redactCredentials(line);
    expect(out).not.toContain("a:b@");
    expect(out).not.toContain("c:d@");
  });

  it("leaves a credential-free URL alone", () => {
    expect(redactCredentials("https://digilist.no/blogg")).toBe("https://digilist.no/blogg");
  });
});

describe("redactQueryParams", () => {
  it("masks sensitive values and keeps the parameter name visible", () => {
    expect(redactQueryParams("https://x/?token=abc123&page=2")).toBe(`https://x/?token=${MASK}&page=2`);
  });

  it("masks every sensitive key it knows", () => {
    const out = redactQueryParams("https://x/?password=a&api_key=b&sessionId=c&safe=d");
    expect(out).toContain("safe=d");
    expect(out).not.toContain("=a&");
    expect(out).not.toContain("=b&");
  });

  it("leaves an empty value alone rather than masking nothing", () => {
    expect(redactQueryParams("https://x/?token=&page=2")).toBe("https://x/?token=&page=2");
  });
});

describe("redactNationalIds and redactEmails", () => {
  it("masks an 11-digit Norwegian personnummer, spaced or not", () => {
    expect(redactNationalIds("fodselsnummer 01019012345 ok")).toBe(`fodselsnummer ${MASK} ok`);
    expect(redactNationalIds("010190 12345")).toBe(MASK);
  });

  it("leaves shorter and longer digit runs alone", () => {
    expect(redactNationalIds("order 12345")).toBe("order 12345");
  });

  it("masks email addresses", () => {
    expect(redactEmails("kontakt ola.nordmann+tag@digilist.no her")).toBe(`kontakt ${MASK} her`);
  });
});

describe("redact", () => {
  it("applies every rule in one pass", () => {
    const out = redact("proxy http://u:p@gw:1 ?token=xyz user ola@x.no id 01019012345");
    expect(out).not.toContain("u:p@");
    expect(out).not.toContain("xyz");
    expect(out).not.toContain("ola@x.no");
    expect(out).not.toContain("01019012345");
  });
});

describe("redactDeep", () => {
  it("masks the VALUE of a sensitive key outright, whatever its type", () => {
    expect(redactDeep({ password: { nested: "secret" }, page: 2 })).toEqual({ password: MASK, page: 2 });
  });

  it("recurses through nested objects and arrays", () => {
    const input = { session: { proxy: "http://u:p@gw:1" }, list: ["https://x/?token=abc", 5, null] };
    const out = redactDeep(input) as Record<string, unknown>;
    expect(out.session).toBe(MASK); // `session` is itself a sensitive key
    expect((out.list as unknown[])[0]).toBe(`https://x/?token=${MASK}`);
    expect((out.list as unknown[])[1]).toBe(5);
    expect((out.list as unknown[])[2]).toBeNull();
  });

  it("redacts a proxy URL nested under a non-sensitive key", () => {
    const out = redactDeep({ config: { proxy: "http://u:p@gw:1" } }) as { config: { proxy: string } };
    expect(out.config.proxy).toBe(`http://${MASK}:${MASK}@gw:1`);
  });

  it("passes through numbers, booleans, null and undefined", () => {
    expect(redactDeep(5)).toBe(5);
    expect(redactDeep(true)).toBe(true);
    expect(redactDeep(null)).toBeNull();
    expect(redactDeep(undefined)).toBeUndefined();
  });
});

describe("isSensitiveKey", () => {
  it("matches case-insensitively on whole words", () => {
    expect(isSensitiveKey("Authorization")).toBe(true);
    expect(isSensitiveKey("api_key")).toBe(true);
    expect(isSensitiveKey("page")).toBe(false);
  });
});

describe("screenshotRisk", () => {
  it("flags a page with a form or an authenticated session for review", () => {
    expect(screenshotRisk({ hadForm: true, authenticated: false })).toBe("review");
    expect(screenshotRisk({ hadForm: false, authenticated: true })).toBe("review");
  });

  it("is low for an anonymous page with no form", () => {
    expect(screenshotRisk({ hadForm: false, authenticated: false })).toBe("low");
  });
});
