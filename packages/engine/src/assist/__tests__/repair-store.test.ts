import { describe, expect, it } from "vitest";
import type { FiledStore } from "../../findings/github.js";
import { loadRepairedKeys, saveRepairedKeys } from "../repair-store.js";

const memory = (initial: Record<string, string> = {}): FiledStore & { files: Record<string, string> } => {
  const files = { ...initial };
  return {
    files,
    exists: (p) => p in files,
    read: (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p] ?? "";
    },
    write: (p, text) => {
      files[p] = text;
    },
    mkdir: () => undefined,
  };
};

describe("repaired-issues store", () => {
  it("starts empty, round-trips keys, and treats a broken file as unreadable", () => {
    const store = memory();
    expect(loadRepairedKeys("/e", store)).toEqual({ ok: true, keys: [] });
    saveRepairedKeys("/e", ["site:xala.no"], store);
    expect(loadRepairedKeys("/e", store)).toEqual({ ok: true, keys: ["site:xala.no"] });
    expect(loadRepairedKeys("/e", memory({ "/e/repaired-issues.json": "{" }))).toEqual({ ok: false });
    expect(loadRepairedKeys("/e", memory({ "/e/repaired-issues.json": '{"keys":[1]}' }))).toEqual({ ok: false });
    expect(
      loadRepairedKeys("/e", {
        exists: () => true,
        read: () => {
          throw new Error("EIO");
        },
        write: () => undefined,
        mkdir: () => undefined,
      }),
    ).toEqual({ ok: false });
  });
});
