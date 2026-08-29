/**
 * `geoqa.config.json` — the schema, and the defaults it falls back to.
 *
 * This exists because the documented config was inert (docs/gaps.md B-1): every
 * key in the example was actually decided by a hardcoded constant or a CLI flag,
 * so anyone who copied the example and edited it got **silently no effect**.
 * Three rules follow from that failure, and each one is here to stop it
 * recurring in a new place:
 *
 *  1. A key that appears in the example must be honoured, and a key the design
 *     will not honour must not appear at all. Half a config surface is worse
 *     than either whole one.
 *  2. Every default is IMPORTED from the constant the code already uses. A
 *     hand-copied default is a second source of truth whose drift is invisible —
 *     the config would keep serving the old number after the constant moved.
 *  3. An unknown key is REJECTED, not ignored. A silently-dropped
 *     `verifyEndoint` typo is the same class of failure as B-1 itself: the user
 *     believes the setting took and nothing ever contradicts them.
 *
 * Credentials are refused outright, by shape, before the schema even runs.
 * Proxy credentials come from `GEOQA_PROXY_*` env vars only (R-26); a config
 * file is committed, backed up, and diffed by people who never intended to
 * handle a password.
 */
import { z } from "zod";
import { EVIDENCE_SEGMENTS } from "../repo.js";
import { RETENTION, type ArtifactKind, type RetentionTier } from "../evidence/manifest.js";
import { isSensitiveKey } from "../evidence/redact.js";
import { formatIssues, type ParseResult } from "../geo/profile.js";
import { DEFAULT_VERIFY_ENDPOINT } from "../geo/observe.js";
import { DEFAULT_COOLDOWN_MS, type ProviderName } from "../network/provider.js";

/**
 * Force a type to be `never` at compile time.
 *
 * Used below to prove that the runtime lists zod needs have not fallen behind
 * the type-only unions they mirror. `satisfies` catches a value that does not
 * exist; this catches one that was forgotten — and a forgotten member is the
 * dangerous direction, because it makes a legal setting look like an invalid
 * value to the person typing it.
 */
type AssertNever<T extends never> = T;

const ARTIFACT_KINDS = [
  "metadata",
  "screenshot",
  "snapshot",
  "console",
  "network",
  "har",
  "trace",
  "vitals",
  "a11y",
] as const satisfies readonly ArtifactKind[];
type _EveryArtifactKindIsListed = AssertNever<Exclude<ArtifactKind, (typeof ARTIFACT_KINDS)[number]>>;

const RETENTION_TIERS = ["pass", "warning", "fail", "investigation"] as const satisfies readonly RetentionTier[];
type _EveryRetentionTierIsListed = AssertNever<Exclude<RetentionTier, (typeof RETENTION_TIERS)[number]>>;

/**
 * A new egress provider must make this list a compile error rather than a
 * runtime rejection — otherwise the provider ships, `selectProvider` knows it,
 * and the config file is the one place that calls its name invalid.
 */
const PROVIDER_NAMES = ["direct", "http-proxy"] as const satisfies readonly ProviderName[];
type _EveryProviderIsListed = AssertNever<Exclude<ProviderName, (typeof PROVIDER_NAMES)[number]>>;

/** The provider used when neither the config nor `--provider` names one. */
export const DEFAULT_PROVIDER: ProviderName = "direct";

/** Where evidence is written, relative to the repo root, when nothing overrides it. */
export const DEFAULT_EVIDENCE_DIRNAME = EVIDENCE_SEGMENTS.join("/");

/**
 * `$comment` is allowed on every object so the file can explain itself in place.
 * It is the only key the loader accepts without honouring, which is why it is
 * marked by a sigil rather than being an ordinary-looking word: a reader can see
 * at a glance that it is prose, and a typo like `comments` is still rejected.
 * An array is accepted because a paragraph of rationale in one JSON string is
 * unreadable, and rationale nobody reads is rationale nobody keeps current.
 */
const CommentSchema = z.union([z.string(), z.array(z.string())]).optional();

/**
 * A retention tier must keep at least one artifact kind. An empty tier divides
 * by zero in `completenessOf` and reports `NaN` completeness — an evidence
 * package that cannot say how complete it is, which is precisely the thing the
 * manifest exists to prevent.
 */
const ArtifactKindListSchema = z
  .array(z.enum(ARTIFACT_KINDS))
  .min(1, "a retention tier must keep at least one artifact kind");

const RetentionSchema = z
  .object({
    $comment: CommentSchema,
    pass: ArtifactKindListSchema.optional(),
    warning: ArtifactKindListSchema.optional(),
    fail: ArtifactKindListSchema.optional(),
    investigation: ArtifactKindListSchema.optional(),
  })
  .strict();

export const DEFAULT_DIRECT_FALLBACK = false;

export const ConfigFileSchema = z
  .object({
    $comment: CommentSchema,
    network: z
      .object({
        $comment: CommentSchema,
        provider: z.enum(PROVIDER_NAMES).optional(),
        // Must be fetchable by the page itself: `observeNetwork` reads egress
        // identity through an in-page fetch, on purpose, because Node's own
        // socket is not the client whose geography we are claiming. A
        // non-HTTP scheme cannot be fetched, so it would not fail loudly — it
        // would make the network axis `unverified`, i.e. turn a
        // misconfiguration into "we could not measure it".
        verifyEndpoint: z
          .string()
          .url()
          .refine((u) => /^https?:\/\//i.test(u), {
            message: "must be an http(s) URL — the page fetches it from inside the browser",
          })
          .optional(),
        // Zero is rejected: it writes a cooldown that has already expired,
        // which is indistinguishable in the store from a provider that never
        // failed. "Do not pause after a failure" is a different design, not a
        // number.
        cooldownMs: z.number().int().positive().optional(),
        /**
         * When the configured provider is http-proxy and it is out of credit or
         * otherwise unusable, run from this host's direct egress instead of
         * refusing. Geographic claims are unproven — never silent (invariant 6).
         */
        directFallback: z.boolean().optional(),
      })
      .strict()
      .optional(),
    browser: z
      .object({
        $comment: CommentSchema,
        // `exec.ts` treats 0 as "no cap", so the schema refuses it: a run with
        // no wall-clock cap does not fail, it hangs — and a hung run reports
        // nothing at all, which is the worst outcome available.
        commandTimeoutMs: z.number().int().positive().optional(),
        idleTimeoutMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    evidence: z
      .object({
        $comment: CommentSchema,
        root: z.string().min(1).optional(),
        retention: RetentionSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof ConfigFileSchema>;
type RetentionOverride = z.infer<typeof RetentionSchema>;

/** The resolved configuration: every question answered, nothing left implicit. */
export interface GeoQaConfig {
  network: {
    provider: ProviderName;
    verifyEndpoint: string;
    cooldownMs: number;
    directFallback: boolean;
  };
  /**
   * Absent keys mean "let `browser/exec.ts` apply its own default".
   *
   * Deliberately NOT defaulted here. `DEFAULT_TIMEOUT_MS` and `DEFAULT_IDLE_MS`
   * are module-private to `exec.ts`, and writing the numbers out here would be
   * the second source of truth this module exists to avoid. Callers must spread
   * these conditionally — `exactOptionalPropertyTypes` will not let `undefined`
   * through, which is what stops "unset" from being passed on as "0".
   */
  browser: {
    commandTimeoutMs?: number;
    idleTimeoutMs?: number;
  };
  evidence: {
    /**
     * Verbatim from the file — relative paths are NOT resolved here, because
     * this module does not know the repo root and guessing one would silently
     * write evidence somewhere nobody looks. The caller resolves it, exactly as
     * it already resolves `--evidence-root`.
     */
    root: string;
    retention: Record<RetentionTier, ArtifactKind[]>;
  };
}

/**
 * Copy the retention table.
 *
 * `RETENTION` is a module-level mutable object that every run in the process
 * reads. Handing a caller a reference to it means one caller narrowing a tier
 * silently narrows what every later run collects — and the evidence would look
 * complete, because `completeness` is computed against the same mutated table.
 */
function cloneRetention(source: Record<RetentionTier, ArtifactKind[]>): Record<RetentionTier, ArtifactKind[]> {
  return {
    pass: [...source.pass],
    warning: [...source.warning],
    fail: [...source.fail],
    investigation: [...source.investigation],
  };
}

/** The configuration of a machine with no `geoqa.config.json` at all. */
export function defaultConfig(): GeoQaConfig {
  return {
    network: {
      provider: DEFAULT_PROVIDER,
      verifyEndpoint: DEFAULT_VERIFY_ENDPOINT,
      cooldownMs: DEFAULT_COOLDOWN_MS,
      directFallback: DEFAULT_DIRECT_FALLBACK,
    },
    browser: {},
    evidence: { root: DEFAULT_EVIDENCE_DIRNAME, retention: cloneRetention(RETENTION) },
  };
}

/**
 * A named tier REPLACES the default list rather than adding to it.
 *
 * Widening a tier and narrowing one are both legitimate — "stop writing a HAR
 * for every failure, we are out of disk" is as real a need as "always keep the
 * trace" — and a union could only ever express the first.
 */
function resolveRetention(
  defaults: Record<RetentionTier, ArtifactKind[]>,
  override: RetentionOverride | undefined,
): Record<RetentionTier, ArtifactKind[]> {
  const merged = cloneRetention(defaults);
  for (const tier of RETENTION_TIERS) {
    const kinds = override?.[tier];
    if (kinds) merged[tier] = [...kinds];
  }
  return merged;
}

function resolveConfig(file: ConfigFile): GeoQaConfig {
  const defaults = defaultConfig();
  return {
    network: {
      provider: file.network?.provider ?? defaults.network.provider,
      verifyEndpoint: file.network?.verifyEndpoint ?? defaults.network.verifyEndpoint,
      cooldownMs: file.network?.cooldownMs ?? defaults.network.cooldownMs,
      directFallback: file.network?.directFallback ?? defaults.network.directFallback,
    },
    browser: {
      ...(file.browser?.commandTimeoutMs !== undefined ? { commandTimeoutMs: file.browser.commandTimeoutMs } : {}),
      ...(file.browser?.idleTimeoutMs !== undefined ? { idleTimeoutMs: file.browser.idleTimeoutMs } : {}),
    },
    evidence: {
      root: file.evidence?.root ?? defaults.evidence.root,
      retention: resolveRetention(defaults.evidence.retention, file.evidence?.retention),
    },
  };
}

/**
 * Key fragments that make a key credential-shaped.
 *
 * Substring matching, on purpose: `proxyPassword`, `proxy_url` and `proxyURL`
 * are the same mistake and enumerating spellings would miss the next one. Bare
 * `pass` and `user` are deliberately absent — `evidence.retention.pass` is a
 * legitimate key, and a guard that rejects legitimate config would get deleted
 * within a week, taking the real protection with it.
 */
const CREDENTIAL_FRAGMENTS = [
  "proxy",
  "credential",
  "password",
  "passwd",
  "username",
  "secret",
  "token",
  "apikey",
  "auth",
  "login",
  "cookie",
  "bearer",
];

/** Lowercase and drop separators, so `api_key`, `api-key` and `apiKey` all collapse. */
const normalizeKey = (key: string): string => key.toLowerCase().replace(/[_-]/g, "");

function isCredentialShaped(key: string): boolean {
  const normalized = normalizeKey(key);
  // `isSensitiveKey` is reused rather than copied so this guard inherits the
  // redactor's list (ssn, card, session…) and cannot drift away from it.
  return CREDENTIAL_FRAGMENTS.some((fragment) => normalized.includes(fragment)) || isSensitiveKey(normalized);
}

/**
 * Refuse credential-shaped keys with a message that says where they belong.
 *
 * Strict-mode zod would already reject `network.proxyUrl` as an unrecognized
 * key, but "unrecognized key" invites the reader to conclude the feature does
 * not exist yet and try harder. This says the value has a home and it is not
 * this file. Whole-document walk, because the wrong place to put a password is
 * every place.
 */
export function findCredentialKeys(raw: unknown, at: string[] = []): string[] {
  if (Array.isArray(raw)) return raw.flatMap((item, i) => findCredentialKeys(item, [...at, String(i)]));
  if (typeof raw !== "object" || raw === null) return [];
  const errors: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const path = [...at, key].join(".");
    if (isCredentialShaped(key)) {
      errors.push(
        `${path}: credentials never live in geoqa.config.json — proxy credentials are read from GEOQA_PROXY_<MARKET> in the environment only (R-26)`,
      );
      // No recursion into a rejected subtree: one clear "this does not belong
      // here" beats a list of its children.
      continue;
    }
    errors.push(...findCredentialKeys(value, [...at, key]));
  }
  return errors;
}

/**
 * Validate a parsed config document and fill in every default.
 *
 * The credential walk runs FIRST so a password gets the message about env vars
 * rather than a generic schema complaint about an unknown key.
 */
export function parseConfig(raw: unknown): ParseResult<GeoQaConfig> {
  const credentials = findCredentialKeys(raw);
  if (credentials.length > 0) return { ok: false, errors: credentials };
  const parsed = ConfigFileSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: resolveConfig(parsed.data) }
    : { ok: false, errors: formatIssues(parsed.error) };
}
