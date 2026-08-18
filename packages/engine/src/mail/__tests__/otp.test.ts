import { describe, expect, it } from "vitest";
import { extractOtp, pickOtpThread, type InboxThread } from "../otp.js";

describe("extractOtp", () => {
  it("takes the first standalone 6-digit code", () => {
    expect(extractOtp("Your Digilist code is 482913. It expires in 10 minutes.")).toBe("482913");
  });

  it("ignores years and shorter numbers — those are not a login code", () => {
    expect(extractOtp("Sent 2026-08-19, ref 42")).toBeNull();
    expect(extractOtp("code 12345 is too short")).toBeNull();
  });

  it("returns null for an empty preview rather than inventing a code", () => {
    expect(extractOtp("")).toBeNull();
    expect(extractOtp(null)).toBeNull();
    expect(extractOtp(undefined)).toBeNull();
  });
});

const thread = (over: Partial<InboxThread> = {}): InboxThread => ({
  thread_id: "t1",
  timestamp: "2026-08-19T00:00:10.000Z",
  subject: "Your login code",
  preview: "Use 482913 to sign in",
  senders: ["Digilist <noreply@digilist.no>"],
  ...over,
});

describe("pickOtpThread", () => {
  it("takes the newest thread at or after the submit time that carries a code", () => {
    const picked = pickOtpThread(
      [
        thread({ thread_id: "old", timestamp: "2026-08-19T00:00:00.000Z", preview: "Use 111111 to sign in" }),
        thread({ thread_id: "new", timestamp: "2026-08-19T00:00:20.000Z", preview: "Use 222222 to sign in" }),
      ],
      Date.parse("2026-08-19T00:00:15.000Z"),
    );
    expect(picked?.thread_id).toBe("new");
    expect(picked?.code).toBe("222222");
  });

  it("ignores a thread that arrived before submit — that is yesterday's code", () => {
    expect(pickOtpThread([thread({ timestamp: "2026-08-19T00:00:00.000Z" })], Date.parse("2026-08-19T00:00:10.000Z"))).toBeNull();
  });

  it("ignores a thread with no code rather than guessing", () => {
    expect(pickOtpThread([thread({ preview: "Welcome to Digilist", subject: "Hi" })], 0)).toBeNull();
  });
});
