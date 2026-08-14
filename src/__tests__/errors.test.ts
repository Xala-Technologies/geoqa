import { describe, expect, it } from "vitest";
import { describeThrown } from "../errors.js";

describe("describeThrown", () => {
  it("uses an Error's message, which is the common case", () => {
    expect(describeThrown(new Error("EROFS: read-only file system"))).toBe("EROFS: read-only file system");
  });

  it("keeps the message of an Error SUBCLASS rather than its class name", () => {
    class TimeoutError extends Error {}
    expect(describeThrown(new TimeoutError("waited 30s for #buy"))).toBe("waited 30s for #buy");
  });

  it("passes a thrown string through", () => {
    // Node throws strings from some native paths, and `throw` accepts any value. Reading
    // `.message` off this would yield undefined.
    expect(describeThrown("EIO: low-level I/O failure")).toBe("EIO: low-level I/O failure");
  });

  it("NAMES an undefined throw instead of printing the word \"undefined\"", () => {
    // `String(undefined)` is "undefined" — correct, and indistinguishable from a real message
    // that says so. A reader seeing "could not append: undefined" looks for a bug in the
    // reporter; one seeing "an undefined value was thrown" looks at the throw site.
    expect(describeThrown(undefined)).toBe("an undefined value was thrown");
  });

  it("names a null throw for the same reason", () => {
    expect(describeThrown(null)).toBe("a null value was thrown");
  });

  it("describes a plain object without pretending to know more", () => {
    expect(describeThrown({ code: "ECONNRESET" })).toBe("[object Object]");
  });

  it("survives a value whose toString THROWS, rather than replacing the original failure", () => {
    // A reporter that fails while reporting turns a diagnosable problem into an
    // undiagnosable one. This runs inside catch blocks, so it must not throw out of them.
    const hostile = {
      toString() {
        throw new Error("nice try");
      },
    };
    expect(describeThrown(hostile)).toBe("an unprintable value was thrown");
  });

  it("survives a thrown symbol, which String() rejects outright", () => {
    // `String(Symbol())` is fine, but implicit conversion is not — and a symbol reaching a
    // catch block at all means something unusual happened, which is worth not compounding.
    expect(typeof describeThrown(Symbol("odd"))).toBe("string");
  });
});
