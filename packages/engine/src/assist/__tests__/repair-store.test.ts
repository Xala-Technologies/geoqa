import { describe, expect, it } from "vitest";
import type { FiledStore } from "../../findings/github.js";
import { loadRepairedItems, loadRepairedKeys, saveRepairedItems, saveRepairedKeys } from "../repair-store.js";

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
  it("starts empty, round-trips a PR URL, and still reads the old keys-only file", () => {
    const store = memory();
    expect(loadRepairedItems("/e", store)).toEqual({ ok: true, items: [] });
    saveRepairedItems("/e", [{ key: "site:xala.no", status: "opened", at: "t", prUrl: "https://github.com/x/y/pull/3" }], store);
    const loaded = loadRepairedItems("/e", store);
    expect(loaded).toEqual({
      ok: true,
      items: [{ key: "site:xala.no", status: "opened", at: "t", prUrl: "https://github.com/x/y/pull/3" }],
    });
    expect(loadRepairedKeys("/e", store)).toEqual({ ok: true, keys: ["site:xala.no"] });

    const legacy = memory({ "/e/repaired-issues.json": JSON.stringify({ keys: ["old"] }) });
    expect(loadRepairedItems("/e", legacy)).toEqual({ ok: true, items: [{ key: "old", status: "opened", at: "legacy" }] });

    saveRepairedKeys("/e", ["a"], store);
    expect(loadRepairedKeys("/e", store)).toEqual({ ok: true, keys: ["a"] });

    expect(loadRepairedItems("/e", memory({ "/e/repaired-issues.json": "{" }))).toEqual({ ok: false });
    expect(loadRepairedItems("/e", memory({ "/e/repaired-issues.json": '{"keys":[1]}' }))).toEqual({ ok: false });
    expect(
      loadRepairedItems("/e", {
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
