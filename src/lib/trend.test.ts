/**
 * Property-based + example tests for `src/lib/trend.ts`.
 *
 * Validates: Requirements 15.1
 *
 * Spec references:
 *   - SPEC.md §10.2.3 / §10.4 — trend semantics (5 % flat band, sign
 *     correctness, two-decimal rounding, zero-baseline handling).
 *   - SPEC.md §16.1 — Vitest unit tests, ≥80 % line coverage on `lib/`.
 *   - design.md §"Correctness Properties" — Property 6 ("Trend
 *     percentage is sign-correct" and returns `null` for `prev === 0`).
 *
 * No I/O, no Prisma, no mocks — these are pure tests against the
 * exported functions in `./trend`.
 */

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import {
  FLAT_THRESHOLD_PCT,
  compareSeries,
  computeTrend,
} from './trend';

// ---------------------------------------------------------------------------
// computeTrend — example-based
// ---------------------------------------------------------------------------

describe('computeTrend', () => {
  it('returns flat / 0 when current === previous (positive)', () => {
    expect(computeTrend(100, 100)).toEqual({ trend: 'flat', trendPct: 0 });
  });

  it('returns up / +20 when current grew 20 %', () => {
    expect(computeTrend(120, 100)).toEqual({ trend: 'up', trendPct: 20 });
  });

  it('returns down / -20 when current shrank 20 %', () => {
    expect(computeTrend(80, 100)).toEqual({ trend: 'down', trendPct: -20 });
  });

  it('treats exactly +5 % as up (band is strictly less-than)', () => {
    expect(computeTrend(105, 100)).toEqual({ trend: 'up', trendPct: 5 });
  });

  it('treats +4.99 % as flat (just inside the band)', () => {
    expect(computeTrend(104.99, 100)).toEqual({
      trend: 'flat',
      trendPct: 4.99,
    });
  });

  it('treats exactly -5 % as down (band is strictly less-than)', () => {
    expect(computeTrend(95, 100)).toEqual({ trend: 'down', trendPct: -5 });
  });

  it('returns flat / null when both sides are zero', () => {
    expect(computeTrend(0, 0)).toEqual({ trend: 'flat', trendPct: null });
  });

  it('infers up from positive current when previous is zero', () => {
    expect(computeTrend(10, 0)).toEqual({ trend: 'up', trendPct: null });
  });

  it('infers down from negative current when previous is zero', () => {
    expect(computeTrend(-10, 0)).toEqual({ trend: 'down', trendPct: null });
  });

  it('returns flat / null when current is NaN', () => {
    expect(computeTrend(Number.NaN, 100)).toEqual({
      trend: 'flat',
      trendPct: null,
    });
  });

  it('returns flat / null when current is +Infinity', () => {
    expect(computeTrend(Number.POSITIVE_INFINITY, 100)).toEqual({
      trend: 'flat',
      trendPct: null,
    });
  });

  it('handles negative baselines correctly (loss shrinking is up)', () => {
    // current=-50 vs previous=-100 → (−50 − −100) / |−100| × 100 = +50.
    expect(computeTrend(-50, -100)).toEqual({ trend: 'up', trendPct: 50 });
  });

  it('rounds to 2 decimal places (0.001 % collapses to 0)', () => {
    expect(computeTrend(100.001, 100)).toEqual({
      trend: 'flat',
      trendPct: 0,
    });
  });

  it('exposes FLAT_THRESHOLD_PCT === 5 (single source of truth)', () => {
    expect(FLAT_THRESHOLD_PCT).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// computeTrend — property-based
// ---------------------------------------------------------------------------

describe('computeTrend (properties)', () => {
  // -------------------------------------------------------------------------
  // 1. trend === 'flat'  ⟺  |trendPct| < 5  (when trendPct !== null)
  // -------------------------------------------------------------------------
  it("trend is 'flat' iff |trendPct| < 5 (when trendPct is non-null)", () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: true, min: -1e6, max: 1e6 }),
        fc.float({ noNaN: true, min: -1e6, max: 1e6 }).filter((x) => x !== 0),
        (current, previous) => {
          const r = computeTrend(current, previous);
          if (r.trendPct === null) return true;
          if (r.trend === 'flat') return Math.abs(r.trendPct) < FLAT_THRESHOLD_PCT;
          return Math.abs(r.trendPct) >= FLAT_THRESHOLD_PCT;
        },
      ),
      { numRuns: 500 },
    );
  });

  // -------------------------------------------------------------------------
  // 2. Sign correctness — Property 6 in design.md §16.1.
  //    sign(trendPct) === sign(current − previous), or both are zero
  //    (after rounding to 2 decimals a tiny non-zero delta can collapse).
  // -------------------------------------------------------------------------
  it('sign(trendPct) === sign(current − previous) when previous !== 0 and trendPct is non-null', () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: true, min: -1e6, max: 1e6 }),
        fc.float({ noNaN: true, min: -1e6, max: 1e6 }).filter((x) => x !== 0),
        (current, previous) => {
          const r = computeTrend(current, previous);
          if (r.trendPct === null) return true;
          const deltaSign = Math.sign(current - previous);
          const pctSign = Math.sign(r.trendPct);
          // Allow a rounded 0 when the raw delta was non-zero but tiny.
          if (pctSign === 0) return true;
          return pctSign === deltaSign;
        },
      ),
      { numRuns: 500 },
    );
  });

  // -------------------------------------------------------------------------
  // 3. Monotonicity in `current` for fixed positive `previous`.
  // -------------------------------------------------------------------------
  it('trendPct is non-decreasing in `current` for fixed positive `previous`', () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: true, min: -1e6, max: 1e6 }),
        fc.float({ noNaN: true, min: -1e6, max: 1e6 }),
        fc.float({ noNaN: true, min: Math.fround(0.001), max: 1e6 }),
        (a, b, p) => {
          const c1 = Math.min(a, b);
          const c2 = Math.max(a, b);
          const r1 = computeTrend(c1, p);
          const r2 = computeTrend(c2, p);
          if (r1.trendPct === null || r2.trendPct === null) return true;
          return r1.trendPct <= r2.trendPct;
        },
      ),
      { numRuns: 300 },
    );
  });

  // -------------------------------------------------------------------------
  // 4. Identity at zero delta — for any non-zero finite previous,
  //    computeTrend(p, p) === { trend: 'flat', trendPct: 0 }.
  // -------------------------------------------------------------------------
  it('computeTrend(p, p) === { trend: flat, trendPct: 0 } for any non-zero finite p', () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: true, min: -1e6, max: 1e6 }).filter((x) => x !== 0),
        (p) => {
          const r = computeTrend(p, p);
          return r.trend === 'flat' && r.trendPct === 0;
        },
      ),
      { numRuns: 300 },
    );
  });

  // -------------------------------------------------------------------------
  // 5. Non-finite inputs always produce { trend: 'flat', trendPct: null }.
  // -------------------------------------------------------------------------
  it('non-finite current always yields flat / null', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          Number.NaN,
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
        ),
        fc.float({ noNaN: true }),
        (current, previous) => {
          const r = computeTrend(current, previous);
          return r.trend === 'flat' && r.trendPct === null;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('non-finite previous always yields flat / null', () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: true }),
        fc.constantFrom(
          Number.NaN,
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
        ),
        (current, previous) => {
          const r = computeTrend(current, previous);
          return r.trend === 'flat' && r.trendPct === null;
        },
      ),
      { numRuns: 200 },
    );
  });

  // -------------------------------------------------------------------------
  // 6. Symmetry — reflecting `current` across `previous` flips the sign.
  //    Skip the assertion when either side rounds to 0 (rounding can hide a
  //    sub-0.005 % delta) by only comparing absolute values in that case.
  // -------------------------------------------------------------------------
  it('computeTrend(a, b) and computeTrend(2b − a, b) have opposite-sign trendPct (modulo rounding)', () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: true, min: -1e5, max: 1e5 }),
        fc.float({ noNaN: true, min: -1e5, max: 1e5 }).filter((x) => x !== 0),
        (a, b) => {
          const left = computeTrend(a, b);
          const right = computeTrend(2 * b - a, b);
          if (left.trendPct === null || right.trendPct === null) return true;

          // If either side rounded to 0 the sign is not meaningfully
          // comparable — a sub-0.005 % delta on one side may flip
          // direction under floating-point rounding. Skip in that case.
          if (left.trendPct === 0 || right.trendPct === 0) return true;

          return Math.sign(left.trendPct) === -Math.sign(right.trendPct);
        },
      ),
      { numRuns: 300 },
    );
  });

  // -------------------------------------------------------------------------
  // 7. compareSeries is a literal alias of computeTrend.
  // -------------------------------------------------------------------------
  it('compareSeries === computeTrend (same function reference)', () => {
    expect(compareSeries).toBe(computeTrend);
  });

  it('compareSeries returns deeply-equal results to computeTrend on arbitrary inputs', () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: true, min: -1e6, max: 1e6 }),
        fc.float({ noNaN: true, min: -1e6, max: 1e6 }),
        (current, previous) => {
          expect(compareSeries(current, previous)).toEqual(
            computeTrend(current, previous),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
