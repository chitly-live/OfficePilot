/**
 * Property-based + example tests for `src/lib/utm.ts`.
 *
 * Validates: Requirements 6.6, 6.7, 15.1
 *
 * Spec references:
 *   - SPEC.md §7.2.5 — UTM generator surface (buildUtmUrl).
 *   - SPEC.md §6.2.7 / §6.2.8 — webhook + auto-fill consume parseUtmFromUrl.
 *   - SPEC.md §16.1 — Vitest unit tests, ≥80 % line coverage on `lib/`.
 *   - design.md §"Correctness Properties" — Property 3 (UTM build/parse
 *     round-trip).
 *
 * No network, no Prisma, no mocks — these are pure tests against the
 * exported functions in `./utm`.
 */

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import {
  buildUtmUrl,
  isValidUtmValue,
  parseUtmFromUrl,
  slugifyCampaign,
} from './utm';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * RFC 3986 unreserved character set plus digits + letters. Values built
 * from this charset round-trip through `URLSearchParams` without any
 * percent-encoding, which is what Property 3 promises.
 */
const SAFE_UTM_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';

const safeCharArb = fc.constantFrom(...SAFE_UTM_CHARS.split(''));

/** Non-empty UTM token in the safe charset, length 1–64. */
const safeUtmValueArb = fc
  .array(safeCharArb, { minLength: 1, maxLength: 64 })
  .map((chars) => chars.join(''));

/** Optional UTM token: `undefined` or a non-empty safe token. */
const optionalSafeUtmValueArb = fc.option(safeUtmValueArb, {
  nil: undefined,
  freq: 3,
});

/**
 * Existing query-string key for the "preserve" property. Stays in the
 * URL-safe charset and is filtered to avoid colliding with the five
 * `utm_*` keys that buildUtmUrl will write.
 */
const nonUtmKeyArb = fc
  .array(safeCharArb, { minLength: 1, maxLength: 16 })
  .map((chars) => chars.join(''))
  .filter(
    (k) =>
      k !== 'utm_source' &&
      k !== 'utm_medium' &&
      k !== 'utm_campaign' &&
      k !== 'utm_content' &&
      k !== 'utm_term',
  );

// ---------------------------------------------------------------------------
// Property 3 — UTM build/parse round-trip (design.md §16.1)
// ---------------------------------------------------------------------------

describe('Property 3 — UTM build/parse round-trip', () => {
  it('parseUtmFromUrl(buildUtmUrl({...})) yields the original utm_* values for safe tokens', () => {
    fc.assert(
      fc.property(
        safeUtmValueArb,
        safeUtmValueArb,
        safeUtmValueArb,
        optionalSafeUtmValueArb,
        optionalSafeUtmValueArb,
        (source, medium, campaign, content, term) => {
          const url = buildUtmUrl({
            url: 'https://example.com/landing',
            source,
            medium,
            campaign,
            content,
            term,
          });
          const parsed = parseUtmFromUrl(url);

          expect(parsed.utmSource).toBe(source);
          expect(parsed.utmMedium).toBe(medium);
          expect(parsed.utmCampaign).toBe(campaign);

          if (content === undefined) {
            expect(parsed.utmContent).toBeUndefined();
          } else {
            expect(parsed.utmContent).toBe(content);
          }
          if (term === undefined) {
            expect(parsed.utmTerm).toBeUndefined();
          } else {
            expect(parsed.utmTerm).toBe(term);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('round-trips even when the destination URL already has a path + query + fragment', () => {
    fc.assert(
      fc.property(
        safeUtmValueArb,
        safeUtmValueArb,
        safeUtmValueArb,
        (source, medium, campaign) => {
          const url = buildUtmUrl({
            url: 'https://example.com/path/segment?keep=1#anchor',
            source,
            medium,
            campaign,
          });
          const parsed = parseUtmFromUrl(url);
          expect(parsed.utmSource).toBe(source);
          expect(parsed.utmMedium).toBe(medium);
          expect(parsed.utmCampaign).toBe(campaign);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property — existing query parameters are preserved
// ---------------------------------------------------------------------------

describe('Property — buildUtmUrl preserves pre-existing query params', () => {
  it('every non-utm_* query param on the input URL survives the build', () => {
    const existingDictArb = fc.dictionary(nonUtmKeyArb, safeUtmValueArb, {
      minKeys: 1,
      maxKeys: 5,
    });

    fc.assert(
      fc.property(
        existingDictArb,
        safeUtmValueArb,
        safeUtmValueArb,
        safeUtmValueArb,
        (existing, source, medium, campaign) => {
          const qs = new URLSearchParams(existing).toString();
          const baseUrl = `https://example.com/path?${qs}`;
          const out = buildUtmUrl({ url: baseUrl, source, medium, campaign });
          const parsedOut = new URL(out);

          for (const [key, value] of Object.entries(existing)) {
            expect(parsedOut.searchParams.get(key)).toBe(value);
          }
          // And the new utm_* values are also present.
          expect(parsedOut.searchParams.get('utm_source')).toBe(source);
          expect(parsedOut.searchParams.get('utm_medium')).toBe(medium);
          expect(parsedOut.searchParams.get('utm_campaign')).toBe(campaign);
        },
      ),
      { numRuns: 150 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property — slugifyCampaign idempotence
// ---------------------------------------------------------------------------

describe('Property — slugifyCampaign is idempotent', () => {
  it('slugifyCampaign(slugifyCampaign(s)) === slugifyCampaign(s) for any string', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = slugifyCampaign(s);
        const twice = slugifyCampaign(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 200 },
    );
  });

  it('idempotence also holds for full-unicode strings (NFKD path)', () => {
    fc.assert(
      fc.property(fc.fullUnicodeString({ maxLength: 64 }), (s) => {
        const once = slugifyCampaign(s);
        const twice = slugifyCampaign(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property — slugifyCampaign output validity
// ---------------------------------------------------------------------------

describe('Property — slugifyCampaign produces a valid slug', () => {
  it('output matches /^[a-z0-9-]*$/ and has no leading/trailing dashes', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const slug = slugifyCampaign(s);
        expect(slug).toMatch(/^[a-z0-9-]*$/);
        if (slug.length > 0) {
          expect(slug.startsWith('-')).toBe(false);
          expect(slug.endsWith('-')).toBe(false);
        }
        // Defensive: the implementation collapses runs of non-alphanumerics
        // into a single dash, so consecutive dashes should never appear.
        expect(slug.includes('--')).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('slug validity also holds for full-unicode inputs', () => {
    fc.assert(
      fc.property(fc.fullUnicodeString({ maxLength: 64 }), (s) => {
        const slug = slugifyCampaign(s);
        expect(slug).toMatch(/^[a-z0-9-]*$/);
        if (slug.length > 0) {
          expect(slug.startsWith('-')).toBe(false);
          expect(slug.endsWith('-')).toBe(false);
        }
        expect(slug.includes('--')).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// buildUtmUrl — example-based
// ---------------------------------------------------------------------------

describe('buildUtmUrl — examples', () => {
  it('appends utm_* params before the fragment when one is present', () => {
    const out = buildUtmUrl({
      url: 'https://x.com/?a=1#section',
      source: 'google',
      medium: 'cpc',
      campaign: 'spring',
    });
    const parsed = new URL(out);
    expect(parsed.hash).toBe('#section');
    expect(parsed.searchParams.get('a')).toBe('1');
    expect(parsed.searchParams.get('utm_source')).toBe('google');
    expect(parsed.searchParams.get('utm_medium')).toBe('cpc');
    expect(parsed.searchParams.get('utm_campaign')).toBe('spring');
    // The fragment text appears after the query string in the serialised URL.
    expect(out.indexOf('#section')).toBeGreaterThan(out.indexOf('?'));
  });

  it('overwrites existing utm_* params (last-write-wins)', () => {
    const out = buildUtmUrl({
      url: 'https://x.com/?utm_source=old&utm_medium=oldm&keep=yes',
      source: 'new',
      medium: 'newm',
      campaign: 'c',
    });
    const parsed = new URL(out);
    expect(parsed.searchParams.get('utm_source')).toBe('new');
    expect(parsed.searchParams.get('utm_medium')).toBe('newm');
    expect(parsed.searchParams.get('utm_campaign')).toBe('c');
    expect(parsed.searchParams.get('keep')).toBe('yes');
    // Only one value per key — overwrite, not append.
    expect(parsed.searchParams.getAll('utm_source')).toEqual(['new']);
    expect(parsed.searchParams.getAll('utm_medium')).toEqual(['newm']);
  });

  it('omits utm_content / utm_term when those inputs are undefined or empty', () => {
    const out = buildUtmUrl({
      url: 'https://x.com/',
      source: 's',
      medium: 'm',
      campaign: 'c',
      content: '',
      term: undefined,
    });
    const parsed = new URL(out);
    expect(parsed.searchParams.has('utm_content')).toBe(false);
    expect(parsed.searchParams.has('utm_term')).toBe(false);
    expect(parsed.searchParams.get('utm_source')).toBe('s');
  });

  it('writes utm_* params in the canonical order: source, medium, campaign, content, term', () => {
    const out = buildUtmUrl({
      url: 'https://x.com/',
      source: 's',
      medium: 'm',
      campaign: 'c',
      content: 'co',
      term: 't',
    });
    // For a fresh URL with no prior query, URLSearchParams preserves insertion order.
    const queryStart = out.indexOf('?');
    expect(queryStart).toBeGreaterThan(-1);
    const queryPart = out.slice(queryStart + 1);
    const order = queryPart.split('&').map((kv) => kv.split('=')[0]);
    expect(order).toEqual([
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_content',
      'utm_term',
    ]);
  });

  it('throws TypeError on a relative URL', () => {
    expect(() =>
      buildUtmUrl({
        url: 'relative/path',
        source: 's',
        medium: 'm',
        campaign: 'c',
      }),
    ).toThrow(TypeError);
  });

  it('throws TypeError on a syntactically invalid URL', () => {
    expect(() =>
      buildUtmUrl({
        url: 'not a url at all',
        source: 's',
        medium: 'm',
        campaign: 'c',
      }),
    ).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// parseUtmFromUrl — example-based
// ---------------------------------------------------------------------------

describe('parseUtmFromUrl — examples', () => {
  it('returns {} on an unparseable URL', () => {
    expect(parseUtmFromUrl('not a url')).toEqual({});
    expect(parseUtmFromUrl('')).toEqual({});
    expect(parseUtmFromUrl('relative/only')).toEqual({});
  });

  it('returns {} when the URL has no utm_* params', () => {
    expect(parseUtmFromUrl('https://example.com/')).toEqual({});
    expect(
      parseUtmFromUrl('https://example.com/?foo=bar&baz=qux#hash'),
    ).toEqual({});
  });

  it('ignores unrelated query params and returns only utm_* keys', () => {
    const parsed = parseUtmFromUrl(
      'https://example.com/?foo=bar&utm_source=google&utm_medium=cpc&unrelated=1',
    );
    expect(parsed).toEqual({
      utmSource: 'google',
      utmMedium: 'cpc',
    });
  });

  it('omits keys whose value is the empty string', () => {
    const parsed = parseUtmFromUrl(
      'https://example.com/?utm_source=&utm_medium=cpc&utm_campaign=',
    );
    expect(parsed).toEqual({ utmMedium: 'cpc' });
  });

  it('returns all five utm_* keys when present', () => {
    const parsed = parseUtmFromUrl(
      'https://example.com/?utm_source=s&utm_medium=m&utm_campaign=c&utm_content=co&utm_term=t',
    );
    expect(parsed).toEqual({
      utmSource: 's',
      utmMedium: 'm',
      utmCampaign: 'c',
      utmContent: 'co',
      utmTerm: 't',
    });
  });
});

// ---------------------------------------------------------------------------
// slugifyCampaign — example-based
// ---------------------------------------------------------------------------

describe('slugifyCampaign — examples', () => {
  it.each<[string, string]>([
    ['Café & Tea', 'cafe-tea'],
    ['', ''],
    ['   spaces   ', 'spaces'],
    ['FB / IG — Q1!', 'fb-ig-q1'],
    ['Meta Reels July', 'meta-reels-july'],
    ['  Spring Sale 2026 ', 'spring-sale-2026'],
    ['---only-dashes---', 'only-dashes'],
    ['ALREADY-LOWER-friendly', 'already-lower-friendly'],
    ['multiple    spaces', 'multiple-spaces'],
    // "ü" decomposes (NFKD) to "u" + diaeresis (stripped); "ß" has no NFKD
    // decomposition, so it becomes a dash via the non-alphanumeric collapse.
    ['ümlaut Größe', 'umlaut-gro-e'],
    ['naïve résumé', 'naive-resume'],
  ])('slugifyCampaign(%j) === %j', (input, expected) => {
    expect(slugifyCampaign(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// isValidUtmValue — example-based
// ---------------------------------------------------------------------------

describe('isValidUtmValue — examples', () => {
  it('accepts non-empty strings of unreserved RFC 3986 characters', () => {
    expect(isValidUtmValue('google')).toBe(true);
    expect(isValidUtmValue('cpc')).toBe(true);
    expect(isValidUtmValue('spring-2026')).toBe(true);
    expect(isValidUtmValue('a.b_c~d-e')).toBe(true);
    expect(isValidUtmValue('A1B2C3')).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isValidUtmValue('')).toBe(false);
  });

  it('rejects strings containing reserved or unsafe characters', () => {
    expect(isValidUtmValue('has space')).toBe(false);
    expect(isValidUtmValue('has&ampersand')).toBe(false);
    expect(isValidUtmValue('has=equals')).toBe(false);
    expect(isValidUtmValue('has?question')).toBe(false);
    expect(isValidUtmValue('has#hash')).toBe(false);
    expect(isValidUtmValue('has/slash')).toBe(false);
    expect(isValidUtmValue('café')).toBe(false);
  });
});
