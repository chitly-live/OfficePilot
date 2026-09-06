/**
 * Products (business lines under the company) — pure helpers.
 *
 * The header switcher stores the chosen scope in a cookie; server pages
 * resolve it to a {@link ProductScope} and filter Finance rows with
 * {@link productWhere}. Three scopes exist:
 *
 *   • `all`     — the whole company (every row)
 *   • `company` — company-level rows only (`productId = null`: salary,
 *                 bank charges, CA, card repayments…)
 *   • `product` — one product's rows
 */

import type { Prisma } from '@prisma/client';

export const PRODUCT_COOKIE = 'op_product';
export const SCOPE_ALL = 'all';
export const SCOPE_COMPANY = 'company';

export interface ProductOption {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  isActive: boolean;
}

export type ProductScope =
  | { kind: 'all' }
  | { kind: 'company' }
  | { kind: 'product'; product: ProductOption };

/** Cookie / query value → scope. Unknown or inactive slugs fall back to `all`. */
export function resolveProductScope(
  raw: string | null | undefined,
  products: readonly ProductOption[],
): ProductScope {
  const value = (raw ?? '').trim();
  if (value === '' || value === SCOPE_ALL) return { kind: 'all' };
  if (value === SCOPE_COMPANY) return { kind: 'company' };
  const product = products.find((p) => p.slug === value && p.isActive);
  return product ? { kind: 'product', product } : { kind: 'all' };
}

/** Value to store in the cookie / query for a scope. */
export function scopeValue(scope: ProductScope): string {
  if (scope.kind === 'all') return SCOPE_ALL;
  if (scope.kind === 'company') return SCOPE_COMPANY;
  return scope.product.slug;
}

/** Human label, e.g. "All products", "Praxxel (company-level)", "Chitly". */
export function scopeLabel(scope: ProductScope, companyName: string): string {
  if (scope.kind === 'all') return `${companyName} · all products`;
  if (scope.kind === 'company') return `${companyName} · company-level only`;
  return scope.product.name;
}

/** Prisma where fragment for `FinanceTransaction`. */
export function productWhere(scope: ProductScope): Prisma.FinanceTransactionWhereInput {
  if (scope.kind === 'all') return {};
  if (scope.kind === 'company') return { productId: null };
  return { productId: scope.product.id };
}

/** `"Arrows Go"` → `"arrows-go"`. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Short company name for the switcher: first word of the legal name.
 * "PRAXXEL TECHNOLOGIES PRIVATE LIMITED" → "Praxxel"; mixed-case words
 * ("OfficePilot") are kept as written.
 */
export function shortCompanyName(fullName: string | null | undefined): string {
  const first = (fullName ?? '').trim().split(/\s+/)[0];
  if (!first) return 'Company';
  if (first === first.toUpperCase()) {
    return first.charAt(0) + first.slice(1).toLowerCase();
  }
  return first;
}
