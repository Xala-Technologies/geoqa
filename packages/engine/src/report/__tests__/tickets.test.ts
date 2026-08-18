import { describe, expect, it } from "vitest";
import type { TicketDraft } from "../../findings/tickets.js";
import { ticketsForView } from "../tickets.js";

const draft = (over: Partial<TicketDraft> = {}): TicketDraft => ({
  key: "site:has a search box:xala.no",
  title: "has a search box on xala.no",
  body: "failed",
  labels: ["findings", "bug", "site:xala.no"],
  urgent: false,
  runIds: ["run_1"],
  site: "xala.no",
  hosts: ["xala.no"],
  ...over,
});

describe("ticketsForView", () => {
  it("one draft is one row, and an unfiled issue is an absence not a blank", () => {
    const rows = ticketsForView([draft()], [], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.site).toBe("xala.no");
    expect(rows[0]?.issue.measured).toBe(false);
    if (rows[0]?.issue.measured === false) expect(rows[0].issue.reason).toContain("not filed");
    expect(rows[0]?.pr.measured).toBe(false);
  });

  it("attaches the GitHub issue and the PR when both exist", () => {
    const rows = ticketsForView(
      [draft()],
      [{ key: draft().key, number: 48, url: "https://github.com/xalatechnologies/xala-web-cloner/issues/48" }],
      [{ key: draft().key, status: "opened", prUrl: "https://github.com/xalatechnologies/xala-web-cloner/pull/3" }],
    );
    expect(rows[0]?.issue).toEqual({
      measured: true,
      value: { number: 48, url: "https://github.com/xalatechnologies/xala-web-cloner/issues/48" },
      text: "#48",
    });
    expect(rows[0]?.pr.measured).toBe(true);
    if (rows[0]?.pr.measured) expect(rows[0].pr.value.url).toContain("/pull/3");
  });

  it("a cannot-fix or no-change is a measured absence of a PR, not a missing row", () => {
    const cannot = ticketsForView([draft()], [], [{ key: draft().key, status: "cannot-fix" }]);
    expect(cannot[0]?.pr.measured).toBe(false);
    if (cannot[0]?.pr.measured === false) expect(cannot[0].pr.reason).toContain("could not fix");
    const none = ticketsForView([draft({ key: "other" })], [], [{ key: "other", status: "no-changes" }]);
    if (none[0]?.pr.measured === false) expect(none[0].pr.reason).toContain("no code change");
  });
});
