/**
 * What the settings page is allowed to know.
 *
 * **No credential value ever leaves this file, because none ever enters it.** A tenant stores
 * the NAME of an environment variable, never a secret (R-26), and this reports whether that
 * variable is set — a boolean, derived from `name in env`, with the value never read. Even a
 * masked value would be wrong here: masking is a display decision applied to something that
 * already travelled, and the safest thing to send a browser is a fact about presence.
 *
 * That is not a limitation to apologise for. "Is `GEOQA_PROXY_OSLO` configured on this host?" is
 * the question an operator actually has, and it is answerable without the secret. "What is it?"
 * is answerable on the host, by the person who set it, which is where it should be.
 *
 * Everything here is derived from files the engine already reads, so the settings page cannot
 * drift from what a run would actually use — a settings screen showing a different truth from
 * the runtime is worse than no settings screen.
 */
import type { GeoQaConfig } from "../config/schema.js";
import type { Tenant } from "../tenant/types.js";

/** One environment variable, and whether this host has it. Never its value. */
export interface CredentialStatus {
  /** The variable's NAME, which is public — it is written in a checked-in tenant file. */
  name: string;
  /** Whether it is set on this host. The value is never read. */
  present: boolean;
  /** What it is for, so an operator setting it knows what they are setting. */
  purpose: string;
}

export interface TenantSettings {
  id: string;
  name: string;
  markets: string[];
  /** The domains this tenant owns. An allowlist, and a security control rather than a list. */
  targets: string[];
  quota: { trafficMb: number; runsPerDay: number };
  retentionDays: number;
  credentials: CredentialStatus[];
  /**
   * Whether this tenant's traffic can be attributed to it at all.
   *
   * False when it shares the default proxy account: the vendor reports one figure for every
   * tenant on that account, so attributing it to one would be a fabrication. The tenant is
   * UNMEASURABLE rather than unlimited, and the settings page must say which.
   */
  meterable: boolean;
}

export interface SettingsView {
  tenants: TenantSettings[];
  /** Markets with a profile on disk — what a run may actually ask for. */
  markets: string[];
  journeys: { id: string; title: string; writes: boolean; requiredVars: string[] }[];
  config: {
    source: string;
    provider: string;
    verifyEndpoint: string;
    evidenceRoot: string;
    cooldownMs: number;
    retention: Record<string, string[]>;
  };
  /** Shared credentials, not tenant-scoped. Same rule: names and presence only. */
  credentials: CredentialStatus[];
  server: { authenticated: true; sessionHours: number };
}

/** The shared proxy variables an operator is likely to need, by market. */
export const sharedCredentialNames = (markets: string[]): string[] => markets.map((m) => `GEOQA_PROXY_${m.toUpperCase()}`);

export interface SettingsInput {
  tenants: Tenant[];
  markets: string[];
  journeys: { id: string; title: string; writes: boolean; requiredVars: string[] }[];
  config: GeoQaConfig;
  configSource: string;
  evidenceRoot: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Build the settings view.
 *
 * `present` is computed with `!== undefined` rather than by truthiness: an empty string is a
 * variable somebody set to nothing, which is a different problem from one they never set, and
 * reporting both as absent sends an operator to fix the wrong thing.
 */
export function buildSettings(input: SettingsInput): SettingsView {
  const has = (name: string): boolean => input.env[name] !== undefined;

  return {
    tenants: input.tenants.map((tenant) => {
      const credentials: CredentialStatus[] = [];
      if (tenant.proxyCredentials !== null) {
        credentials.push({
          name: tenant.proxyCredentials,
          present: has(tenant.proxyCredentials),
          purpose: "this tenant's own proxy credentials",
        });
      }
      if (tenant.proxySubUser !== null) {
        credentials.push({
          name: tenant.proxySubUser,
          present: has(tenant.proxySubUser),
          purpose: "proxy sub-account username, for attributing traffic to this tenant",
        });
      }
      return {
        id: tenant.id,
        name: tenant.name,
        markets: tenant.markets,
        targets: tenant.targets,
        quota: tenant.quota,
        retentionDays: tenant.retentionDays,
        credentials,
        // Metering needs a sub-account name AND that variable actually being set. Either missing
        // means the vendor's figure describes the shared account, not this tenant.
        meterable: tenant.proxySubUser !== null && has(tenant.proxySubUser),
      };
    }),
    markets: input.markets,
    journeys: input.journeys,
    config: {
      source: input.configSource,
      provider: input.config.network.provider,
      verifyEndpoint: input.config.network.verifyEndpoint,
      evidenceRoot: input.evidenceRoot,
      cooldownMs: input.config.network.cooldownMs,
      retention: input.config.evidence.retention,
    },
    credentials: sharedCredentialNames(input.markets).map((name) => ({
      name,
      present: has(name),
      purpose: "shared proxy credentials for this market",
    })),
    server: { authenticated: true, sessionHours: 8 },
  };
}
