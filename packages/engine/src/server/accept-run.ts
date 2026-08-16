/**
 * Whether a `POST /api/run` body may start a browser.
 *
 * Parse, ownership, profile, writes — the same refusals `geoqa run` applies
 * before launch. The server calls this, then `controlRun`. Two copies of
 * those checks would drift; this is the HTTP half, `controlRun` is the
 * identity/flag half.
 */
import { tenantOwnsTarget } from "../tenant/registry.js";
import type { Tenant } from "../tenant/types.js";
import { parseRunRequest, type ParsedRunRequest } from "./run-request.js";

export interface AcceptRunDeps {
  body: unknown;
  tenant: Tenant;
  extraTargets: string[];
  resolveProfile: (selection: {
    geo?: string;
    country?: string;
    city?: string;
    device?: string;
  }) => { ok: true; id: string } | { ok: false; errors: string[] };
  loadJourney: (id: string) => { ok: true; writes: boolean } | { ok: false; errors: string[] };
}

export type AcceptedRun = {
  ok: true;
  request: ParsedRunRequest;
  profileId: string;
  market: string;
  device: string;
};

export function acceptRun(deps: AcceptRunDeps): AcceptedRun | { ok: false; error: string } {
  const parsed = parseRunRequest(deps.body);
  if (!parsed.ok) return { ok: false, error: parsed.errors.join("; ") };
  const request = parsed.value;
  if (!tenantOwnsTarget(deps.tenant, request.url, deps.extraTargets)) {
    return {
      ok: false,
      error: `tenant "${deps.tenant.id}" does not own ${request.url} — add it on Watch, or to tenants/${deps.tenant.id}.yaml`,
    };
  }
  const profile = deps.resolveProfile({
    ...(request.geo ? { geo: request.geo } : {}),
    ...(request.country ? { country: request.country } : {}),
    ...(request.city ? { city: request.city } : {}),
    ...(request.device ? { device: request.device } : {}),
  });
  if (!profile.ok) return { ok: false, error: profile.errors.join("; ") };
  const market = profile.id.replace(/-(mobile|desktop)(?:-returning)?$/, "");
  if (!deps.tenant.markets.includes(market)) {
    return { ok: false, error: `tenant "${deps.tenant.id}" has not asked for market "${market}"` };
  }
  const journey = deps.loadJourney(request.journey);
  if (!journey.ok) return { ok: false, error: journey.errors.join("; ") };
  if (journey.writes && request.allowWrites !== true) {
    return {
      ok: false,
      error: `journey "${request.journey}" declares writes:true — set allowWrites, or pick a read-only journey`,
    };
  }
  const device = /-(mobile)(?:-|$)/.test(profile.id) ? "mobile" : "desktop";
  return { ok: true, request, profileId: profile.id, market, device };
}
