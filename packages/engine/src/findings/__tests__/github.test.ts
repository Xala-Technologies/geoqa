import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fileTickets,
  githubAddLabels,
  githubCreate,
  parseGithubRepo,
  type FiledStore,
  type GitHubAddLabels,
  type GitHubCreate,
} from "../github.js";
import type { TicketDraft } from "../tickets.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

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

describe("parseGithubRepo", () => {
  it("accepts owner/name and refuses everything else", () => {
    expect(parseGithubRepo("Xala-Technologies/geoqa")).toEqual({ owner: "Xala-Technologies", name: "geoqa" });
    expect(parseGithubRepo("nope")).toBeNull();
    expect(parseGithubRepo("a/b/c")).toBeNull();
    expect(parseGithubRepo("")).toBeNull();
  });
});

describe("fileTickets", () => {
  it("does nothing when the token or repo is missing — a sweep must not fail because GitHub is off", async () => {
    const create: GitHubCreate = async () => {
      throw new Error("should not be called");
    };
    const none = await fileTickets({
      drafts: [draft()],
      evidenceRoot: "/e",
      env: {},
      nowMs: 1,
      create,
      store: memory(),
    });
    expect(none.skipped).toBe("unconfigured");
    expect(none.filed).toEqual([]);
  });

  it("a dry run reports what would be filed and writes nothing", async () => {
    let called = 0;
    const result = await fileTickets({
      drafts: [draft()],
      evidenceRoot: "/e",
      env: { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "Xala-Technologies/geoqa" },
      nowMs: 1,
      dryRun: true,
      create: async () => {
        called += 1;
        return { number: 1, html_url: "https://example.com/1" };
      },
      store: memory(),
    });
    expect(called).toBe(0);
    expect(result.skipped).toBe("dry-run");
    expect(result.wouldFile.map((d) => d.key)).toEqual([draft().key]);
  });

  it("files a new draft, skips one already on disk, and never throws when GitHub refuses", async () => {
    const store = memory();
    const created: string[] = [];
    const create: GitHubCreate = async (input) => {
      created.push(input.title);
      if (input.title.includes("boom")) throw new Error("403");
      return { number: 41, html_url: "https://github.com/Xala-Technologies/geoqa/issues/41" };
    };
    const env = { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "Xala-Technologies/geoqa" };
    const silent: GitHubAddLabels = async () => undefined;
    const first = await fileTickets({
      drafts: [draft()],
      evidenceRoot: "/e",
      env,
      nowMs: 1,
      create,
      addLabels: silent,
      store,
    });
    expect(first.filed).toEqual([
      { key: draft().key, number: 41, url: "https://github.com/Xala-Technologies/geoqa/issues/41" },
    ]);
    const second = await fileTickets({
      drafts: [draft(), draft({ key: "urgent:run:open target", title: "URGENT: boom", urgent: true, site: "geoqa", hosts: ["digilist.no"] })],
      evidenceRoot: "/e",
      env,
      nowMs: 2,
      create,
      addLabels: silent,
      store,
    });
    expect(second.filed).toEqual([]);
    expect(second.already).toEqual([draft().key]);
    expect(second.failed[0]?.key).toBe("urgent:run:open target");
    expect(second.failed[0]?.error).toContain("403");
    expect(created).toEqual(["has a search box on xala.no", "URGENT: boom"]);
  });

  it("retries without labels when GitHub says a label does not exist", async () => {
    const calls: string[][] = [];
    const create: GitHubCreate = async (input) => {
      calls.push(input.labels);
      if (input.labels.length > 0) {
        throw Object.assign(new Error("Unprocessable"), { status: 422 });
      }
      return { number: 9, html_url: "https://github.com/x/y/issues/9" };
    };
    const result = await fileTickets({
      drafts: [draft()],
      evidenceRoot: "/e",
      env: { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "acme/geoqa" },
      nowMs: 1,
      create,
      store: memory(),
    });
    expect(calls).toEqual([["findings", "bug", "site:xala.no"], []]);
    expect(result.filed[0]?.number).toBe(9);
  });

  it("an unreadable store is a skip, not a licence to re-file everything", async () => {
    const file = "/e/filed-issues.json";
    const store: FiledStore = {
      exists: (p) => p === file,
      read: () => "{",
      write: () => undefined,
      mkdir: () => undefined,
    };
    const result = await fileTickets({
      drafts: [draft()],
      evidenceRoot: "/e",
      env: { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "acme/geoqa" },
      nowMs: 1,
      create: async () => ({ number: 1, html_url: "https://x/1" }),
      store,
    });
    expect(result.skipped).toBe("store-unreadable");
    const unread = await fileTickets({
      drafts: [draft()],
      evidenceRoot: "/e",
      env: { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "acme/geoqa" },
      nowMs: 1,
      create: async () => ({ number: 1, html_url: "https://x/1" }),
      store: {
        exists: () => true,
        read: () => {
          throw new Error("EIO");
        },
        write: () => undefined,
        mkdir: () => undefined,
      },
    });
    expect(unread.skipped).toBe("store-unreadable");
  });

  it("round-trips through disk so a restart does not open the same issue again", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "geoqa-filed-"));
    temps.push(dir);
    const silent: GitHubAddLabels = async () => undefined;
    const first = await fileTickets({
      drafts: [draft()],
      evidenceRoot: dir,
      env: { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "acme/geoqa" },
      nowMs: 1,
      create: async () => ({ number: 7, html_url: "https://github.com/acme/geoqa/issues/7" }),
      addLabels: silent,
    });
    expect(first.filed[0]?.number).toBe(7);
    const second = await fileTickets({
      drafts: [draft()],
      evidenceRoot: dir,
      env: { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "acme/geoqa" },
      nowMs: 2,
      create: async () => {
        throw new Error("should not re-file");
      },
      addLabels: silent,
    });
    expect(second.already).toEqual([draft().key]);
  });
});

describe("githubCreate", () => {
  const req = { repo: "acme/geoqa", token: "t", title: "T", body: "B", labels: ["bug"] };

  it("posts the issue and reads number plus html_url", async () => {
    const out = await githubCreate(req, (async () =>
      new Response(JSON.stringify({ number: 3, html_url: "https://github.com/acme/geoqa/issues/3" }), {
        status: 201,
      })) as typeof fetch);
    expect(out).toEqual({ number: 3, html_url: "https://github.com/acme/geoqa/issues/3" });
  });

  it("uses the real adapter when none is injected, so a missing port is not a silent no-op", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ number: 12, html_url: "https://github.com/acme/geoqa/issues/12" }), {
        status: 201,
      })) as typeof fetch;
    try {
      const result = await fileTickets({
        drafts: [draft({ key: "site:default-adapter:x" })],
        evidenceRoot: "/e",
        env: { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "acme/geoqa" },
        nowMs: 1,
        store: memory(),
      });
      expect(result.filed[0]?.number).toBe(12);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("names a refused repo, an empty error body, and a success payload that is not an issue", async () => {
    await expect(githubCreate({ ...req, repo: "nope" }, (async () => new Response("")) as typeof fetch)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      githubCreate(req, (async () => new Response("", { status: 403 })) as typeof fetch),
    ).rejects.toMatchObject({ status: 403, message: "GitHub 403" });
    await expect(
      githubCreate(req, (async () => new Response("nope", { status: 401 })) as typeof fetch),
    ).rejects.toMatchObject({ status: 401, message: "nope" });
    await expect(
      githubCreate(req, (async () => new Response("{}", { status: 201 })) as typeof fetch),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe("fileTickets routes by host", () => {
  it("opens a site finding on that host's repo, and retags an already-filed issue", async () => {
    const created: string[] = [];
    const tagged: string[] = [];
    const store = memory();
    const env = { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "Xala-Technologies/geoqa" };
    const sites = [{ host: "xala.no", repo: "xalatechnologies/xala-web-cloner", base: "main" }];
    const first = await fileTickets({
      drafts: [draft()],
      evidenceRoot: "/e",
      env,
      nowMs: 1,
      sites,
      create: async (input) => {
        created.push(input.repo);
        return { number: 48, html_url: "https://github.com/xalatechnologies/xala-web-cloner/issues/48" };
      },
      addLabels: async () => undefined,
      store,
    });
    expect(created).toEqual(["xalatechnologies/xala-web-cloner"]);
    expect(first.filed[0]?.url).toContain("xala-web-cloner");
    const second = await fileTickets({
      drafts: [draft()],
      evidenceRoot: "/e",
      env,
      nowMs: 2,
      sites,
      create: async () => {
        throw new Error("should not re-file");
      },
      addLabels: async (input) => {
        tagged.push(`${input.repo}#${input.number}:${input.labels.join(",")}`);
      },
      store,
    });
    expect(second.already).toEqual([draft().key]);
    expect(tagged[0]).toContain("xalatechnologies/xala-web-cloner#48");
    expect(tagged[0]).toContain("site:xala.no");
  });

  it("a thrown addLabels on an already-filed key is not a failed file", async () => {
    const store = memory();
    const env = { GEOQA_GITHUB_TOKEN: "t", GEOQA_GITHUB_REPO: "acme/geoqa" };
    await fileTickets({
      drafts: [draft()],
      evidenceRoot: "/e",
      env,
      nowMs: 1,
      create: async () => ({ number: 1, html_url: "https://x/1" }),
      addLabels: async () => undefined,
      store,
    });
    const again = await fileTickets({
      drafts: [draft()],
      evidenceRoot: "/e",
      env,
      nowMs: 2,
      create: async () => {
        throw new Error("should not re-file");
      },
      addLabels: async () => {
        throw new Error("403");
      },
      store,
    });
    expect(again.already).toEqual([draft().key]);
    expect(again.failed).toEqual([]);
  });
});

describe("githubAddLabels", () => {
  it("posts the labels and refuses a bad repo", async () => {
    const urls: string[] = [];
    await githubAddLabels(
      { repo: "acme/geoqa", token: "t", number: 47, labels: ["site:digilist.no"] },
      (async (url) => {
        urls.push(String(url));
        return new Response("[]", { status: 200 });
      }) as typeof fetch,
    );
    expect(urls[0]).toContain("/repos/acme/geoqa/issues/47/labels");
    await githubAddLabels(
      { repo: "acme/geoqa", token: "t", number: 1, labels: [] },
      (async () => {
        throw new Error("should not post empty labels");
      }) as typeof fetch,
    );
    await expect(
      githubAddLabels({ repo: "nope", token: "t", number: 1, labels: ["bug"] }, (async () => new Response("")) as typeof fetch),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      githubAddLabels(
        { repo: "acme/geoqa", token: "t", number: 1, labels: ["bug"] },
        (async () => new Response("", { status: 403 })) as typeof fetch,
      ),
    ).rejects.toMatchObject({ status: 403, message: "GitHub 403" });
    await expect(
      githubAddLabels(
        { repo: "acme/geoqa", token: "t", number: 1, labels: ["bug"] },
        (async () => new Response("nope", { status: 401 })) as typeof fetch,
      ),
    ).rejects.toMatchObject({ status: 401, message: "nope" });
  });
});
