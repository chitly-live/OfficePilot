/**
 * Unit tests for `src/lib/products.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  productWhere,
  resolveProductScope,
  scopeLabel,
  scopeValue,
  shortCompanyName,
  slugify,
  type ProductOption,
} from './products';

const chitly: ProductOption = { id: 'p1', name: 'Chitly', slug: 'chitly', color: '#6366f1', isActive: true };
const old: ProductOption = { id: 'p2', name: 'Old app', slug: 'old-app', color: null, isActive: false };
const products = [chitly, old];

describe('resolveProductScope', () => {
  it('defaults to all for empty / unknown / reserved values', () => {
    expect(resolveProductScope(undefined, products)).toEqual({ kind: 'all' });
    expect(resolveProductScope('', products)).toEqual({ kind: 'all' });
    expect(resolveProductScope('all', products)).toEqual({ kind: 'all' });
    expect(resolveProductScope('nope', products)).toEqual({ kind: 'all' });
  });

  it('resolves company and active product slugs, but not inactive ones', () => {
    expect(resolveProductScope('company', products)).toEqual({ kind: 'company' });
    expect(resolveProductScope('chitly', products)).toEqual({ kind: 'product', product: chitly });
    expect(resolveProductScope('old-app', products)).toEqual({ kind: 'all' });
  });
});

describe('scopeValue / scopeLabel / productWhere', () => {
  it('round-trips and builds the right where fragment', () => {
    const p = resolveProductScope('chitly', products);
    expect(scopeValue(p)).toBe('chitly');
    expect(scopeValue({ kind: 'all' })).toBe('all');
    expect(scopeValue({ kind: 'company' })).toBe('company');
    expect(productWhere({ kind: 'all' })).toEqual({});
    expect(productWhere({ kind: 'company' })).toEqual({ productId: null });
    expect(productWhere(p)).toEqual({ productId: 'p1' });
    expect(scopeLabel(p, 'Praxxel')).toBe('Chitly');
    expect(scopeLabel({ kind: 'all' }, 'Praxxel')).toBe('Praxxel · all products');
    expect(scopeLabel({ kind: 'company' }, 'Praxxel')).toBe('Praxxel · company-level only');
  });
});

describe('slugify / shortCompanyName', () => {
  it('slugifies names', () => {
    expect(slugify('Arrows Go')).toBe('arrows-go');
    expect(slugify('  Chitly!!  ')).toBe('chitly');
    expect(slugify('Ünïcode App 2')).toBe('unicode-app-2');
  });

  it('shortens the legal name to its first word', () => {
    expect(shortCompanyName('PRAXXEL TECHNOLOGIES PRIVATE LIMITED')).toBe('Praxxel');
    expect(shortCompanyName('OfficePilot')).toBe('OfficePilot');
    expect(shortCompanyName('')).toBe('Company');
    expect(shortCompanyName(null)).toBe('Company');
  });
});
