/**
 * File ticket drafts on GitHub, and remember which keys already went out.
 *
 * Appending must never be able to fail a sweep — same rule as the run index.
 * Missing token, missing repo, or a 403 are reported and the watch continues.
 *
 * Credentials come from GEOQA_GITHUB_TOKEN only. The repo is
 * GEOQA_GITHUB_REPO (owner/name). Neither belongs in geoqa.config.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { describeThrown } from "../errors.js";
import { routeTicket, type SiteRepo } from "./repos.js";
import type { TicketDraft } from "./tickets.js";

export const FILED_ISSUES_FILE = "filed-issues.json";

export interface GithubRepo {
  owner: string;
  name: string;
}

export interface FiledIssue {
  key: string;
  number: number;
  url: string;
  at: string;
  repo?: string;
}

export interface FiledStore {
  exists: (p: string) => boolean;
  read: (p: string) => string;
  write: (p: string, text: string) => void;
  mkdir: (p: string) => void;
}

export const nodeFiledStore: FiledStore = {
  exists: existsSync,
  read: (p) => readFileSync(p, "utf8"),
  write: (p, text) => writeFileSync(p, text, "utf8"),
  mkdir: (p) => mkdirSync(p, { recursive: true }),
};

export type GitHubCreate = (input: {
  repo: string;
  token: string;
  title: string;
  body: string;
  labels: string[];
}) => Promise<{ number: number; html_url: string }>;

export type GitHubAddLabels = (input: {
  repo: string;
  token: string;
  number: number;
  labels: string[];
}) => Promise<void>;

export interface FileTicketsInput {
  drafts: TicketDraft[];
  evidenceRoot: string;
  env: NodeJS.ProcessEnv;
  nowMs: number;
  dryRun?: boolean;
  create?: GitHubCreate;
  addLabels?: GitHubAddLabels;
  store?: FiledStore;
  sites?: SiteRepo[];
}

export interface FileTicketsResult {
  skipped: "none" | "unconfigured" | "dry-run" | "store-unreadable";
  filed: { key: string; number: number; url: string }[];
  already: string[];
  failed: { key: string; error: string }[];
  wouldFile: TicketDraft[];
}

const StoreSchema = z
  .object({
    issues: z.array(
      z
        .object({
          key: z.string().min(1),
          number: z.number().int().positive(),
          url: z.string().min(1),
          at: z.string().min(1),
          repo: z.string().min(1).optional(),
        })
        .strict(),
    ),
  })
  .strict();

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseGithubRepo(value: string | undefined): GithubRepo | null {
  if (value === undefined || !REPO.test(value)) return null;
  const [owner, name] = value.split("/");
  if (owner === undefined || name === undefined || value.split("/").length !== 2) return null;
  return { owner, name };
}

export const filedIssuesPath = (evidenceRoot: string): string => path.join(evidenceRoot, FILED_ISSUES_FILE);

export function loadFiledIssues(evidenceRoot: string, store: FiledStore): { ok: true; issues: FiledIssue[] } | { ok: false } {
  const file = filedIssuesPath(evidenceRoot);
  if (!store.exists(file)) return { ok: true, issues: [] };
  try {
    const parsed = StoreSchema.safeParse(JSON.parse(store.read(file)));
    if (!parsed.success) return { ok: false };
    return {
      ok: true,
      issues: parsed.data.issues.map((issue) => ({
        key: issue.key,
        number: issue.number,
        url: issue.url,
        at: issue.at,
        ...(issue.repo !== undefined ? { repo: issue.repo } : {}),
      })),
    };
  } catch {
    return { ok: false };
  }
}

function saveFiledIssues(evidenceRoot: string, issues: FiledIssue[], store: FiledStore): void {
  store.mkdir(evidenceRoot);
  store.write(filedIssuesPath(evidenceRoot), `${JSON.stringify({ issues }, null, 2)}\n`);
}

const hasStatus = (error: unknown, status: number): boolean =>
  typeof error === "object" && error !== null && "status" in error && (error as { status: unknown }).status === status;

export async function githubCreate(
  input: { repo: string; token: string; title: string; body: string; labels: string[] },
  fetchFn: typeof fetch = fetch,
): Promise<{ number: number; html_url: string }> {
  const parsed = parseGithubRepo(input.repo);
  if (parsed === null) {
    throw Object.assign(new Error("repo must be owner/name"), { status: 400 });
  }
  const response = await fetchFn(`https://api.github.com/repos/${parsed.owner}/${parsed.name}/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "geoqa/0.1",
    },
    body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(text === "" ? `GitHub ${response.status}` : text), { status: response.status });
  }
  return readCreated(JSON.parse(text));
}

function readCreated(body: unknown): { number: number; html_url: string } {
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { number?: unknown }).number !== "number" ||
    typeof (body as { html_url?: unknown }).html_url !== "string"
  ) {
    throw Object.assign(new Error("GitHub returned an issue without a number"), { status: 502 });
  }
  return { number: (body as { number: number }).number, html_url: (body as { html_url: string }).html_url };
}

export async function fileTickets(input: FileTicketsInput): Promise<FileTicketsResult> {
  const token = input.env.GEOQA_GITHUB_TOKEN ?? "";
  const repo = parseGithubRepo(input.env.GEOQA_GITHUB_REPO);
  const empty = { filed: [], already: [], failed: [], wouldFile: [] as TicketDraft[] };
  if (token === "" || repo === null) return { ...empty, skipped: "unconfigured" };

  const store = input.store ?? nodeFiledStore;
  const loaded = loadFiledIssues(input.evidenceRoot, store);
  if (!loaded.ok) return { ...empty, skipped: "store-unreadable" };
  const known = new Map(loaded.issues.map((issue) => [issue.key, issue]));
  const fallback = `${repo.owner}/${repo.name}`;
  const sites = input.sites ?? [];

  if (input.dryRun === true) {
    return {
      ...empty,
      skipped: "dry-run",
      wouldFile: input.drafts.filter((d) => !known.has(d.key)),
      already: input.drafts.filter((d) => known.has(d.key)).map((d) => d.key),
    };
  }

  const create = input.create ?? ((req) => githubCreate(req));
  const addLabels = input.addLabels ?? githubAddLabels;
  const issues = [...loaded.issues];
  const filed: FileTicketsResult["filed"] = [];
  const already: string[] = [];
  const failed: FileTicketsResult["failed"] = [];

  for (const draft of input.drafts) {
    const dest = routeTicket(draft, sites, fallback);
    const existing = known.get(draft.key);
    if (existing !== undefined) {
      already.push(draft.key);
      try {
        await addLabels({
          repo: existing.repo ?? fallback,
          token,
          number: existing.number,
          labels: draft.labels,
        });
      } catch {
        // Already filed. A missing site label is not a licence to open a twin.
      }
      continue;
    }
    try {
      const created = await createWithLabelRetry(create, {
        repo: dest.repo,
        token,
        title: draft.title,
        body: draft.body,
        labels: draft.labels,
      });
      const record: FiledIssue = {
        key: draft.key,
        number: created.number,
        url: created.html_url,
        at: new Date(input.nowMs).toISOString(),
        repo: dest.repo,
      };
      issues.push(record);
      known.set(draft.key, record);
      saveFiledIssues(input.evidenceRoot, issues, store);
      filed.push({ key: draft.key, number: created.number, url: created.html_url });
    } catch (error) {
      failed.push({ key: draft.key, error: describeThrown(error) });
    }
  }

  return { skipped: "none", filed, already, failed, wouldFile: [] };
}

export async function githubAddLabels(
  input: { repo: string; token: string; number: number; labels: string[] },
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const parsed = parseGithubRepo(input.repo);
  if (parsed === null) {
    throw Object.assign(new Error("repo must be owner/name"), { status: 400 });
  }
  if (input.labels.length === 0) return;
  const response = await fetchFn(
    `https://api.github.com/repos/${parsed.owner}/${parsed.name}/issues/${input.number}/labels`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "geoqa/0.1",
      },
      body: JSON.stringify({ labels: input.labels }),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw Object.assign(new Error(text === "" ? `GitHub ${response.status}` : text), { status: response.status });
  }
}

async function createWithLabelRetry(
  create: GitHubCreate,
  input: { repo: string; token: string; title: string; body: string; labels: string[] },
): Promise<{ number: number; html_url: string }> {
  try {
    return await create(input);
  } catch (error) {
    if (input.labels.length === 0 || !hasStatus(error, 422)) throw error;
    return await create({ ...input, labels: [] });
  }
}
