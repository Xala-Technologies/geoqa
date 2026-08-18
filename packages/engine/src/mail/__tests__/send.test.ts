import { describe, expect, it } from "vitest";
import { sendAgentMail } from "../send.js";

describe("sendAgentMail", () => {
  it("POSTs html and text to the inbox send endpoint and never puts the api key in the body", () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ message_id: "m1", thread_id: "t1" }), { status: 200 });
    };
    return sendAgentMail({
      apiKey: "am_secret",
      inbox: "digilist-e2e@agentmail.to",
      to: "ibrahim@xala.no",
      subject: "geoqa daily",
      text: "plain",
      html: "<p>rich</p>",
      fetch: fetchFn,
    }).then((out) => {
      expect(out).toEqual({ ok: true, messageId: "m1", threadId: "t1" });
      expect(calls[0]?.url).toContain("digilist-e2e%40agentmail.to");
      expect(calls[0]?.url).toContain("/messages/send");
      const body = JSON.parse(String(calls[0]?.init.body));
      expect(body).toEqual({
        to: ["ibrahim@xala.no"],
        subject: "geoqa daily",
        text: "plain",
        html: "<p>rich</p>",
      });
      expect(JSON.stringify(body)).not.toContain("am_secret");
      expect(new Headers(calls[0]?.init.headers).get("Authorization")).toBe("Bearer am_secret");
    });
  });

  it("reports an HTTP failure instead of throwing", async () => {
    const out = await sendAgentMail({
      apiKey: "am_x",
      inbox: "a@b.to",
      to: "c@d.no",
      subject: "s",
      text: "t",
      html: "<p>h</p>",
      fetch: async () => new Response("nope", { status: 403 }),
    });
    expect(out).toEqual({ ok: false, detail: "AgentMail HTTP 403" });
  });

  it("reports a transport throw and a 200 with no message id", async () => {
    const thrown = await sendAgentMail({
      apiKey: "am_x",
      inbox: "a@b.to",
      to: "c@d.no",
      subject: "s",
      text: "t",
      html: "<p>h</p>",
      fetch: async () => {
        throw new Error("offline");
      },
    });
    expect(thrown).toEqual({ ok: false, detail: "AgentMail request failed: offline" });
    const empty = await sendAgentMail({
      apiKey: "am_x",
      inbox: "a@b.to",
      to: "c@d.no",
      subject: "s",
      text: "t",
      html: "<p>h</p>",
      fetch: async () => new Response("{}", { status: 200 }),
    });
    expect(empty).toEqual({ ok: false, detail: "AgentMail send returned no message id" });
    const odd = await sendAgentMail({
      apiKey: "am_x",
      inbox: "a@b.to",
      to: "c@d.no",
      subject: "s",
      text: "t",
      html: "<p>h</p>",
      fetch: async () => {
        throw 42;
      },
    });
    expect(odd).toEqual({ ok: false, detail: "AgentMail request failed: 42" });
  });
});
