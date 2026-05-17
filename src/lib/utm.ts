/**
 * UTM URL helpers — pure functions used by the Marketing module.
 *
 * Two surfaces consume this file:
 *   1. The standalone UTM generator at `/marketing/utm` (SPEC.md §7.2.5)
 *      builds a copyable URL from a base + UTM params via {@link buildUtmUrl}.
 *   2. The lead webhook (`POST /api/webhooks/leads`) and the lead create
 *      form auto-fill `utmSource/utmMedium/utmCampaign` from referrer URLs
 *      via {@link parseUtmFromUrl} (SPEC.md §6.2.7).
 *
 * Pure: no I/O, no Prisma, no environment reads. Deterministic for
 * deterministic inputs (Property 3 — UTM build/parse round-trip,
 * design.md §16.1).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Input for {@link buildUtmUrl}. `url` is the destination (e.g.
 * `https://chitly.live/landing`); the rest are the five UTM dimensions
 * defined by Google Analytics. `content` and `term` are optional.
 */
export interface BuildUtmUrlInput {
  url: string;
  source: string;
  medium: string;
  campaign: string;
  content?: string;
  term?: string;
}

/**
 * Result of {@link parseUtmFromUrl}. Keys are present only when the
 * corresponding `utm_*` query parameter exists in the URL with a
 * non-empty value. The naming mirrors the columns on `Lead` and
 * `Campaign` in `prisma/schema.prisma`.
 */
export interface ParsedUtm {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Ordered list of `(utm_* param name, BuildUtmUrlInput field)` pairs.
 * The order matters for {@link buildUtmUrl}: the produced URL writes
 * params in this order, which keeps the output stable across runs and
 * matches the conventional GA ordering (source → medium → campaign →
 * content → term).
 */
const UTM_FIELDS = [
  ['utm_source', 'source'],
  ['utm_medium', 'medium'],
  ['utm_campaign', 'campaign'],
  ['utm_content', 'content'],
  ['utm_term', 'term'],
] as const satisfies ReadonlyArray<readonly [string, keyof BuildUtmUrlInput]>;

/**
 * Mapping from `utm_*` query param name to the corresponding key on
 * {@link ParsedUtm}. Used by {@link parseUtmFromUrl}.
 */
const UTM_PARAM_TO_PARSED_KEY = {
  utm_source: 'utmSource',
  utm_medium: 'utmMedium',
  utm_campaign: 'utmCampaign',
  utm_content: 'utmContent',
  utm_term: 'utmTerm',
} as const satisfies Record<string, keyof ParsedUtm>;

/**
 * Regex matching a single character that is safe to leave unencoded in
 * a UTM value. Mirrors RFC 3986 unreserved characters
 * (`A-Z a-z 0-9 - . _ ~`). Used by {@link isValidUtmValue}.
 */
const SAFE_UTM_VALUE = /^[A-Za-z0-9._~-]+$/;

// ---------------------------------------------------------------------------
// buildUtmUrl
// ---------------------------------------------------------------------------

/**
 * Append `utm_*` query parameters to the given URL.
 *
 * Existing query parameters are preserved; existing `utm_*` parameters
 * are overwritten (last-write-wins). The URL fragment (`#...`) is
 * preserved and remains after the query. Values are URL-encoded by
 * `URLSearchParams`, so spaces, `&`, `=`, etc. are handled correctly.
 *
 * Optional fields (`content`, `term`) that are `undefined`, `null`, or
 * empty strings are skipped (no `utm_content=` etc. is emitted).
 *
 * @param input destination URL plus UTM parameters.
 * @returns the URL with UTM parameters appended.
 * @throws {TypeError} when `input.url` is not a parseable URL.
 */
export function buildUtmUrl(input: BuildUtmUrlInput): string {
  // `URL` requires an absolute URL; relative URLs throw. That's intentional
  // — the UTM generator surface only accepts full destination URLs.
  const parsed = new URL(input.url);

  for (const [paramName, field] of UTM_FIELDS) {
    const raw = input[field];
    if (raw === undefined || raw === null) continue;
    if (raw === '') continue;
    parsed.searchParams.set(paramName, raw);
  }

  return parsed.toString();
}

// ---------------------------------------------------------------------------
// parseUtmFromUrl
// ---------------------------------------------------------------------------

/**
 * Extract UTM parameters from a URL string.
 *
 * Returns an object with only the keys that are present in the URL with
 * non-empty values; other keys are omitted (yielding `undefined` on
 * access). Unknown query parameters are ignored.
 *
 * Defensive: if `url` is not a parseable absolute URL, returns an empty
 * object rather than throwing. Callers that need strict parsing should
 * validate the URL themselves first.
 *
 * @param url the URL string to inspect.
 * @returns object with `utmSource`, `utmMedium`, `utmCampaign`,
 *          `utmContent`, `utmTerm` (each optional).
 */
export function parseUtmFromUrl(url: string): ParsedUtm {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }

  const out: ParsedUtm = {};
  for (const [paramName, parsedKey] of Object.entries(
    UTM_PARAM_TO_PARSED_KEY,
  ) as ReadonlyArray<[keyof typeof UTM_PARAM_TO_PARSED_KEY, keyof ParsedUtm]>) {
    const value = parsed.searchParams.get(paramName);
    if (value !== null && value !== '') {
      out[parsedKey] = value;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// slugifyCampaign
// ---------------------------------------------------------------------------

/**
 * Convert a campaign name to a URL-safe slug suitable for use as
 * `utm_campaign` (and as the unique key on `Campaign.utmCampaign`).
 *
 * Rules:
 *   • Lowercased.
 *   • Unicode-normalised (NFKD) with combining diacritics stripped, so
 *     "Café" → "cafe".
 *   • Any run of non-alphanumeric characters becomes a single dash.
 *   • Leading and trailing dashes are trimmed.
 *
 * Examples:
 *   slugifyCampaign("Meta Reels July")     === "meta-reels-july"
 *   slugifyCampaign("  Spring Sale 2026 ") === "spring-sale-2026"
 *   slugifyCampaign("FB / IG — Q1!")       === "fb-ig-q1"
 *   slugifyCampaign("")                    === ""
 *
 * @param name human-readable campaign name.
 * @returns URL-safe slug (may be empty if `name` has no alphanumerics).
 */
export function slugifyCampaign(name: string): string {
  return name
    .normalize('NFKD')
    // Strip combining diacritics (Unicode category Mn).
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    // Collapse any run of non-alphanumerics into a single dash.
    .replace(/[^a-z0-9]+/g, '-')
    // Trim leading/trailing dashes.
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// isValidUtmValue
// ---------------------------------------------------------------------------

/**
 * Return `true` iff `s` is a non-empty string consisting only of
 * RFC 3986 unreserved characters (`A-Z a-z 0-9 - . _ ~`).
 *
 * Such values pass through `URLSearchParams` without percent-encoding
 * and round-trip cleanly through {@link buildUtmUrl} →
 * {@link parseUtmFromUrl}. Useful as a form-validation predicate before
 * accepting UTM input from users.
 *
 * Note: this is stricter than "valid UTM value" — characters like space
 * or `&` are *encodable* and {@link buildUtmUrl} will handle them, but
 * pasting an encoded URL into ad platforms is fragile, so the marketing
 * UI should reject them up front.
 *
 * @param s the candidate UTM value.
 * @returns `true` if `s` requires no percent-encoding.
 */
export function isValidUtmValue(s: string): boolean {
  return SAFE_UTM_VALUE.test(s);
}
