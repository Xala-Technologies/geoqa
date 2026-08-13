/**
 * A tenant: whose site this is, which markets they care about, what they may
 * spend, and where their evidence lives.
 *
 * The shape is deliberately small, and two of its fields are the ones that make
 * multi-tenancy a correctness problem rather than a billing feature.
 *
 * `proxyCredentials` is an **environment variable NAME, never a value.** R-26 says
 * credentials come from the environment only, and a tenant registry that held
 * secrets would be a file every operator has to remember not to commit — the
 * `.env` mistake, moved somewhere with worse odds. A name is safe to read, safe to
 * log, and safe to check into a repo.
 *
 * `quota` exists because of a measured incident rather than a business
 * requirement: one 430-page sweep consumed an entire proxy allowance, and every
 * subsequent run — of every profile, in every market — returned an opaque 407 that
 * looked exactly like a broken proxy. On a shared pool one tenant's crawl silently
 * breaks every other tenant's runs, so a quota that REFUSES before launching is a
 * correctness requirement. Vendor-side isolation (a proxy sub-account per tenant)
 * is the stronger half of the same answer; this is the half geoqa can enforce
 * before spending anything.
 */

/** What a tenant is allowed to spend. Enforced before a run launches, not after. */
export interface TenantQuota {
  /**
   * Proxy traffic ceiling, in megabytes.
   *
   * Megabytes rather than bytes because that is the unit the vendor's own dashboard
   * reports and the unit an operator sets a budget in; a number nobody can read
   * against the invoice is a number nobody maintains.
   */
  trafficMb: number;
  /**
   * Runs per day.
   *
   * A second, independent ceiling, because traffic and run count fail differently:
   * a thousand tiny runs can exhaust a rate limit while spending almost no traffic,
   * and one sweep can spend a gigabyte in forty runs.
   */
  runsPerDay: number;
}

export interface Tenant {
  /**
   * Slug, and it is security-relevant.
   *
   * The id becomes a DIRECTORY NAME under the evidence root, so a value containing
   * `..` or a separator would let one tenant's run write into another tenant's tree
   * — or outside the root entirely. `TenantIdSchema` constrains it to lowercase
   * alphanumerics and inner hyphens for that reason, and `tenantEvidenceRoot`
   * re-checks the resolved path rather than trusting the pattern alone.
   */
  id: string;
  /** Human-readable, for reports. Carries no constraints and no meaning to code. */
  name: string;
  /**
   * The markets this tenant is verified in — profile market ids, not free text.
   *
   * Present so a run can be REFUSED for a market a tenant never asked about, which
   * matters once quota is real: a typo that runs 16 markets instead of 3 is a bill.
   */
  markets: string[];
  /**
   * The sites this tenant owns.
   *
   * An allowlist, and that is the point. A QA runner pointed at a URL its tenant
   * does not own is either a mistake or an attack — the same engine that proves a
   * site works can be aimed at somebody else's, from residential IPs, on a
   * schedule. Ownership is asserted here so it can be checked once.
   */
  targets: string[];
  /**
   * The NAME of the environment variable holding this tenant's proxy credentials,
   * or null to use the shared default.
   *
   * Never the credential itself. See the file comment.
   */
  proxyCredentials: string | null;
  quota: TenantQuota;
  /**
   * How long this tenant's evidence is kept, in days.
   *
   * Per tenant because retention is a contractual term, not an engineering
   * preference, and because evidence can contain personal data captured from a
   * page — one tenant's obligations are not another's.
   */
  retentionDays: number;
}
