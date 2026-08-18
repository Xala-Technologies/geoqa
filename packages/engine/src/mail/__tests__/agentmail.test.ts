import { describe, expect, it } from "vitest";
import { mailboxFromEnv, pollAgentMail, type MailboxPoll } from "../agentmail.js";

const inbox = "digilist-e2e@agentmail.to";

const thread = {
  thread_id: "t1",
  timestamp: "2026-08-19T00:00:20.000Z",
  subject: "Your login code",
  preview: "Use 482913 to sign in",
  senders: ["noreply@digilist.no"],
};

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("mailboxFromEnv", () => {
  it("is absent when the key or the inbox email is missing — never a half-configured mailbox", () => {
    expect(mailboxFromEnv({})).toBeUndefined();
    expect(mailboxFromEnv({ AGENTMAIL_API_KEY: "am_x" })).toBeUndefined();
    expect(mailboxFromEnv({ GEOQA_LOGIN_EMAIL: inbox })).toBeUndefined();
  });

  it("is present only when both the key and the inbox email are set", () => {
    expect(mailboxFromEnv({ AGENTMAIL_API_KEY: "am_x", GEOQA_LOGIN_EMAIL: inbox })).toBeTypeOf("function");
  });

  it("the returned mailbox polls with the env credentials", async () => {
    const box = mailboxFromEnv(
      { AGENTMAIL_API_KEY: "am_x", GEOQA_LOGIN_EMAIL: inbox },
      {
        timeoutMs: 5,
        pollMs: 5,
        now: () => Date.parse("2026-08-19T00:00:30.000Z"),
        sleep: () => Promise.resolve(),
        fetch: () => Promise.resolve(okJson({ count: 1, threads: [thread] })),
      },
    );
    expect(box).toBeTypeOf("function");
    const out = await box!({ afterMs: Date.parse("2026-08-19T00:00:10.000Z") });
    expect(out).toEqual({ ok: true, code: "482913" });
  });
});

describe("pollAgentMail", () => {
  it("returns the code from a thread that arrived after submit", async () => {
    const fetched: string[] = [];
    const out = await pollAgentMail({
      apiKey: "am_x",
      inbox,
      afterMs: Date.parse("2026-08-19T00:00:10.000Z"),
      timeoutMs: 20,
      pollMs: 5,
      now: () => Date.parse("2026-08-19T00:00:30.000Z"),
      sleep: () => Promise.resolve(),
      fetch: (url, init) => {
        fetched.push(String(url));
        expect(init?.headers).toEqual({ Authorization: "Bearer am_x" });
        return Promise.resolve(okJson({ count: 1, threads: [thread] }));
      },
    });
    expect(out).toEqual({ ok: true, code: "482913" });
    expect(fetched[0]).toContain("digilist-e2e%40agentmail.to");
    expect(fetched[0]).toContain("after=");
  });

  it("times out as our defect when the inbox stays empty", async () => {
    let now = 0;
    const out = await pollAgentMail({
      apiKey: "am_x",
      inbox,
      afterMs: 0,
      timeoutMs: 15,
      pollMs: 5,
      now: () => now,
      sleep: () => {
        now += 5;
        return Promise.resolve();
      },
      fetch: () => Promise.resolve(okJson({ count: 0, threads: [] })),
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected timeout");
    expect(out.detail).toContain("no login code");
  });

  it("does not return a code when the request throws — that is unverified, not a site defect", async () => {
    const out = await pollAgentMail({
      apiKey: "am_x",
      inbox,
      afterMs: 0,
      timeoutMs: 5,
      pollMs: 5,
      now: () => 0,
      sleep: () => Promise.resolve(),
      fetch: () => Promise.reject(new Error("ECONNRESET")),
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected failure");
    expect(out.detail).toContain("ECONNRESET");
    const bare = await pollAgentMail({
      apiKey: "am_x",
      inbox,
      afterMs: 0,
      timeoutMs: 5,
      pollMs: 5,
      now: () => 0,
      sleep: () => Promise.resolve(),
      fetch: () => Promise.reject("down"),
    });
    expect(bare.ok).toBe(false);
    if (bare.ok) throw new Error("expected failure");
    expect(bare.detail).toContain("down");
  });

  it("uses the real sleeper when none is injected, and still times out on an empty inbox", async () => {
    const out = await pollAgentMail({
      apiKey: "am_x",
      inbox,
      afterMs: 0,
      timeoutMs: 8,
      pollMs: 4,
      fetch: () => Promise.resolve(okJson({ count: 0, threads: [] })),
    });
    expect(out.ok).toBe(false);
  });

  it("does not return a code when AgentMail is down — that is unverified, not a site defect", async () => {
    const out = await pollAgentMail({
      apiKey: "am_x",
      inbox,
      afterMs: 0,
      timeoutMs: 5,
      pollMs: 5,
      now: () => 0,
      sleep: () => Promise.resolve(),
      fetch: () => Promise.resolve(new Response("no", { status: 503 })),
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected failure");
    expect(out.detail).toContain("503");
  });
});
