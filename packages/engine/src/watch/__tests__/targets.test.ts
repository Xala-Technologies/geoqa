import { describe, expect, it } from "vitest";
import { addTarget, parseTargetUrl, removeTarget } from "../targets.js";

describe("parseTargetUrl", () => {
  it("accepts a bare host and fills https, because that is what an operator types", () => {
    const out = parseTargetUrl("app.digilist.no");
    if (!out.ok) throw new Error(out.errors.join());
    expect(out.value.href).toBe("https://app.digilist.no");
    expect(out.value.origin).toBe("https://app.digilist.no");
  });

  it("keeps a path, so a watch can hit a specific page rather than only an origin", () => {
    const out = parseTargetUrl("https://digilist.no/priser");
    if (!out.ok) throw new Error(out.errors.join());
    expect(out.value.href).toBe("https://digilist.no/priser");
    expect(out.value.origin).toBe("https://digilist.no");
  });

  it("REFUSES credentials in the URL — those belong in GEOQA_PROXY_*", () => {
    const out = parseTargetUrl("https://user:pass@digilist.no");
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected refusal");
    expect(out.errors[0]).toContain("credential");
  });

  it("refuses a scheme that is not http(s)", () => {
    expect(parseTargetUrl("ftp://digilist.no").ok).toBe(false);
    expect(parseTargetUrl("javascript:alert(1)").ok).toBe(false);
  });

  it("refuses empty input rather than turning it into https://", () => {
    expect(parseTargetUrl("").ok).toBe(false);
    expect(parseTargetUrl("   ").ok).toBe(false);
  });

  it("refuses a string the URL parser cannot read", () => {
    expect(parseTargetUrl("http://[").ok).toBe(false);
  });

  it("skips a malformed entry already on the list rather than treating it as a match", () => {
    const added = addTarget(["::::"], "https://xala.no");
    if (!added.ok) throw new Error(added.errors.join());
    expect(added.value).toEqual(["::::", "https://xala.no"]);
    const removed = removeTarget(["::::", "https://xala.no"], "https://xala.no");
    if (!removed.ok) throw new Error(removed.errors.join());
    expect(removed.value).toEqual(["::::"]);
  });
});

describe("addTarget / removeTarget", () => {
  it("appends a new origin and refuses a duplicate of the same href", () => {
    const added = addTarget(["https://digilist.no"], "https://app.digilist.no");
    if (!added.ok) throw new Error(added.errors.join());
    expect(added.value).toEqual(["https://digilist.no", "https://app.digilist.no"]);
    expect(addTarget(added.value, "app.digilist.no").ok).toBe(false);
  });

  it("removes by href, including when the operator typed the bare host", () => {
    const removed = removeTarget(["https://digilist.no", "https://xala.no"], "xala.no");
    if (!removed.ok) throw new Error(removed.errors.join());
    expect(removed.value).toEqual(["https://digilist.no"]);
  });

  it("names a removal that was not on the list, rather than succeeding as a no-op", () => {
    const out = removeTarget(["https://digilist.no"], "https://xala.no");
    expect(out.ok).toBe(false);
  });
});
