/**
 * Server-side product helpers: load the product list and resolve the
 * header scope from the request cookie. Server components / route
 * handlers only (uses `next/headers`).
 */

import { cookies } from 'next/headers';
import type { PrismaClient } from '@prisma/client';

import {
  PRODUCT_COOKIE,
  resolveProductScope,
  shortCompanyName,
  type ProductOption,
  type ProductScope,
} from '@/lib/products';

export const productOptionSelect = {
  id: true,
  name: true,
  slug: true,
  color: true,
  isActive: true,
} as const;

export async function loadProducts(
  db: PrismaClient,
  opts: { includeInactive?: boolean } = {},
): Promise<ProductOption[]> {
  return db.product.findMany({
    where: opts.includeInactive ? {} : { isActive: true },
    select: productOptionSelect,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

export interface ProductContext {
  products: ProductOption[];
  scope: ProductScope;
  /** Legal company name from Settings (fallback "OfficePilot"). */
  companyName: string;
  /** "Praxxel" — for the switcher and labels. */
  companyShort: string;
}

/** Products + the scope chosen in the header (cookie) + company name. */
export async function getProductContext(db: PrismaClient): Promise<ProductContext> {
  const [products, setting] = await Promise.all([
    loadProducts(db),
    db.setting.findUnique({ where: { key: 'company_name' }, select: { value: true } }),
  ]);
  let raw: string | undefined;
  try {
    raw = cookies().get(PRODUCT_COOKIE)?.value;
  } catch {
    // Outside a request scope (unit/integration tests, scripts): no cookie.
    raw = undefined;
  }
  const companyName = setting?.value.trim() || 'OfficePilot';
  return {
    products,
    scope: resolveProductScope(raw, products),
    companyName,
    companyShort: shortCompanyName(companyName),
  };
}
