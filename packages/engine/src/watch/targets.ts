/**
 * Target URLs: what an operator types into the console, turned into an origin
 * the allowlist can reason about.
 *
 * Bare hosts are the common case (`app.digilist.no`) and become https. A path
 * is kept, because a watch aimed at `/priser` is a different measurement from
 * one aimed at the homepage. Credentials in the URL are refused — the same
 * rule as the config loader, for the same reason: a secret that travelled in
 * a watch file is a secret that will be committed, logged, or both.
 */
import type { ParseResult } from "./spec.js";

export interface ParsedTarget {
  /** What a run will open. Origin only when the operator typed a host. */
  href: string;
  /** Scheme + host + port. What `tenantOwnsTarget` compares. */
  origin: string;
}

const fail = (message: string): ParseResult<ParsedTarget> => ({ ok: false, errors: [message] });

export function parseTargetUrl(raw: string): ParseResult<ParsedTarget> {
  const trimmed = raw.trim();
  if (trimmed === "") return fail("a target cannot be empty");
  const withScheme = /^[a-zA-Z][a-zA-Z+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return fail(`"${trimmed}" is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail("a target must be http or https");
  }
  if (url.username !== "" || url.password !== "") {
    return fail("credentials do not belong in a target URL — they belong in GEOQA_PROXY_*");
  }
  // An empty host throws in Node's URL parser (covered above). A host of "." is
  // syntactically valid and rare enough that refusing it here would be theatre.
  const href = url.pathname === "/" && url.search === "" ? url.origin : `${url.origin}${url.pathname}${url.search}`;
  return { ok: true, value: { href, origin: url.origin } };
}

export function addTarget(existing: string[], raw: string): ParseResult<string[]> {
  const parsed = parseTargetUrl(raw);
  if (!parsed.ok) return parsed;
  if (existing.some((entry) => sameHref(entry, parsed.value.href))) {
    return { ok: false, errors: [`${parsed.value.href} is already on the list`] };
  }
  return { ok: true, value: [...existing, parsed.value.href] };
}

export function removeTarget(existing: string[], raw: string): ParseResult<string[]> {
  const parsed = parseTargetUrl(raw);
  if (!parsed.ok) return parsed;
  const next = existing.filter((entry) => !sameHref(entry, parsed.value.href));
  if (next.length === existing.length) {
    return { ok: false, errors: [`${parsed.value.href} is not on the list`] };
  }
  return { ok: true, value: next };
}

const sameHref = (entry: string, href: string): boolean => {
  const parsed = parseTargetUrl(entry);
  return parsed.ok && parsed.value.href === href;
};
