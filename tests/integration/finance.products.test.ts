/**
 * Integration tests for products (business lines under the company):
 *
 *   GET/POST        /api/products
 *   PATCH/DELETE    /api/products/[id]
 *   productId on    /api/finance/transactions (create / patch / list filter)
 *   ?product= on    /api/finance/summary and /api/finance/export
 *
 * Real Postgres (see `tests/integration/setup.ts`).
 */

import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';

import { GET as listProducts, POST as createProduct } from '@/app/api/products/route';
import { DELETE as deleteProduct, PATCH as patchProduct } from '@/app/api/products/[id]/route';
import {
  GET as listTransactions,
  POST as createTransaction,
} from '@/app/api/finance/transactions/route';
import { PATCH as patchTransaction } from '@/app/api/finance/transactions/[id]/route';
import { GET as getSummary } from '@/app/api/finance/summary/route';
import { GET as exportReport } from '@/app/api/finance/export/route';
import { prisma } from '@/lib/db';

import {
  buildJsonRequest,
  buildRouteContext,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

const BASE = 'http://test/api/products';
const TXN = 'http://test/api/finance/transactions';

async function asAdmin() {
  const { user } = await createTestUser({ role: 'ADMIN' });
  await setSession({ userId: user.id, role: 'ADMIN' });
  return user;
}

async function seedProducts() {
  const chitly = await prisma.product.create({
    data: { name: 'Chitly', slug: 'chitly', color: '#6366f1', sortOrder: 1 },
  });
  const arrows = await prisma.product.create({
    data: { name: 'Arrows Go', slug: 'arrows-go', color: '#f59e0b', sortOrder: 2 },
  });
  return { chitly, arrows };
}

async function seedLedger(adminId: string, chitlyId: string, arrowsId: string) {
  const mk = (
    date: string,
    direction: 'IN' | 'OUT',
    category: string,
    amount: number,
    productId: string | null,
    description?: string,
  ) =>
    prisma.financeTransaction.create({
      data: {
        date: new Date(`${date}T00:00:00.000Z`),
        direction,
        category: category as never,
        amount,
        productId,
        description,
        createdById: adminId,
      },
    });
  await mk('2026-09-01', 'IN', 'SALES', 30000, chitlyId, 'Cashfree settlement');
  await mk('2026-09-03', 'OUT', 'ADS', 4000, chitlyId, 'Facebook ads');
  await mk('2026-09-02', 'OUT', 'ADS', 3000, arrowsId, 'Arrows Go ads');
  await mk('2026-09-06', 'OUT', 'ADS', 3000, arrowsId, 'Arrows Go ads');
  await mk('2026-09-05', 'OUT', 'SALARY', 5000, null, 'Intern stipend');
}

// ---------------------------------------------------------------------------
// /api/products
// ---------------------------------------------------------------------------

describe('/api/products — auth', () => {
  it('GET needs a session; POST/PATCH/DELETE need admin', async () => {
    await setSession(null);
    expect((await listProducts()).status).toBe(401);

    const { user } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: user.id, role: 'EMPLOYEE' });
    expect((await listProducts()).status).toBe(200);
    expect(
      (await createProduct(buildJsonRequest('POST', BASE, { name: 'Nope' }))).status,
    ).toBe(403);
    expect(
      (
        await patchProduct(
          buildJsonRequest('PATCH', `${BASE}/x`, { name: 'Nope' }),
          buildRouteContext('x'),
        )
      ).status,
    ).toBe(403);
    expect(
      (await deleteProduct(buildJsonRequest('DELETE', `${BASE}/x`), buildRouteContext('x'))).status,
    ).toBe(403);
  });
});

describe('POST /api/products', () => {
  it('creates a product with a derived slug and audits it', async () => {
    const admin = await asAdmin();
    const res = await createProduct(
      buildJsonRequest('POST', BASE, { name: 'Arrows Go', color: '#f59e0b' }),
    );
    expect(res.status).toBe(201);
    const body = await getJson<{ id: string; slug: string; name: string; isActive: boolean }>(res);
    expect(body).toMatchObject({ name: 'Arrows Go', slug: 'arrows-go', isActive: true });

    const log = await prisma.activityLog.findFirst({
      where: { action: 'product.created', entityId: body!.id },
    });
    expect(log?.userId).toBe(admin.id);
  });

  it('rejects duplicate slugs (409), reserved slugs and bad colours (400)', async () => {
    await asAdmin();
    expect((await createProduct(buildJsonRequest('POST', BASE, { name: 'Chitly' }))).status).toBe(201);
    expect((await createProduct(buildJsonRequest('POST', BASE, { name: 'chitly!' }))).status).toBe(409);
    expect((await createProduct(buildJsonRequest('POST', BASE, { name: 'All' }))).status).toBe(400);
    expect(
      (await createProduct(buildJsonRequest('POST', BASE, { name: 'X', color: 'red' }))).status,
    ).toBe(400);
  });
});

describe('/api/products/[id]', () => {
  it('PATCH renames / deactivates; GET list is ordered by sortOrder', async () => {
    await asAdmin();
    const { chitly, arrows } = await seedProducts();

    const res = await patchProduct(
      buildJsonRequest('PATCH', `${BASE}/${arrows.id}`, { name: 'Arrows Go!', isActive: false }),
      buildRouteContext(arrows.id),
    );
    expect(res.status).toBe(200);
    expect(await getJson(res)).toMatchObject({ name: 'Arrows Go!', isActive: false, slug: 'arrows-go' });

    const list = await getJson<{ items: Array<{ id: string }> }>(await listProducts());
    expect(list!.items.map((p) => p.id)).toEqual([chitly.id, arrows.id]);

    expect(
      (
        await patchProduct(
          buildJsonRequest('PATCH', `${BASE}/${arrows.id}`, {}),
          buildRouteContext(arrows.id),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await patchProduct(
          buildJsonRequest('PATCH', `${BASE}/missing`, { name: 'x' }),
          buildRouteContext('missing'),
        )
      ).status,
    ).toBe(404);
  });

  it('DELETE removes an unused product but refuses one with ledger rows', async () => {
    const admin = await asAdmin();
    const { chitly, arrows } = await seedProducts();
    await seedLedger(admin.id, chitly.id, arrows.id);

    const blocked = await deleteProduct(
      buildJsonRequest('DELETE', `${BASE}/${chitly.id}`),
      buildRouteContext(chitly.id),
    );
    expect(blocked.status).toBe(409);
    expect(await prisma.product.findUnique({ where: { id: chitly.id } })).not.toBeNull();

    const unused = await prisma.product.create({ data: { name: 'Sandbox', slug: 'sandbox' } });
    const ok = await deleteProduct(
      buildJsonRequest('DELETE', `${BASE}/${unused.id}`),
      buildRouteContext(unused.id),
    );
    expect(ok.status).toBe(204);
    expect(await prisma.product.findUnique({ where: { id: unused.id } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Product on transactions
// ---------------------------------------------------------------------------

describe('productId on /api/finance/transactions', () => {
  it('creates a row tagged with a product, clears it with null, rejects unknown ids', async () => {
    await asAdmin();
    const { arrows } = await seedProducts();

    const res = await createTransaction(
      buildJsonRequest('POST', TXN, {
        date: '2026-09-02',
        direction: 'OUT',
        category: 'ADS',
        amount: 3000,
        productId: arrows.id,
        description: 'Arrows Go ads',
      }),
    );
    expect(res.status).toBe(201);
    const created = await getJson<{ id: string; productId: string | null; product: { slug: string } | null }>(res);
    expect(created!.productId).toBe(arrows.id);
    expect(created!.product?.slug).toBe('arrows-go');

    const cleared = await patchTransaction(
      buildJsonRequest('PATCH', `${TXN}/${created!.id}`, { productId: null }),
      buildRouteContext(created!.id),
    );
    expect(cleared.status).toBe(200);
    expect((await getJson<{ productId: string | null }>(cleared))!.productId).toBeNull();

    const bad = await createTransaction(
      buildJsonRequest('POST', TXN, {
        date: '2026-09-02',
        direction: 'OUT',
        category: 'ADS',
        amount: 10,
        productId: 'nope',
      }),
    );
    expect(bad.status).toBe(400);
  });

  it('GET filters by productId / companyOnly and totals follow the filter', async () => {
    const admin = await asAdmin();
    const { chitly, arrows } = await seedProducts();
    await seedLedger(admin.id, chitly.id, arrows.id);

    const all = await getJson<{ total: number; totals: { expense: number } }>(
      await listTransactions(buildJsonRequest('GET', `${TXN}?month=2026-09`)),
    );
    expect(all!.total).toBe(5);
    expect(all!.totals.expense).toBe(15000);

    const arrowsOnly = await getJson<{ total: number; totals: { expense: number; income: number } }>(
      await listTransactions(buildJsonRequest('GET', `${TXN}?month=2026-09&productId=${arrows.id}`)),
    );
    expect(arrowsOnly!.total).toBe(2);
    expect(arrowsOnly!.totals).toMatchObject({ expense: 6000, income: 0 });

    const company = await getJson<{ total: number; totals: { expense: number } }>(
      await listTransactions(buildJsonRequest('GET', `${TXN}?month=2026-09&companyOnly=1`)),
    );
    expect(company!.total).toBe(1);
    expect(company!.totals.expense).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Summary + export by product
// ---------------------------------------------------------------------------

describe('?product= on summary and export', () => {
  it('summary: unscoped shows the by-product split; scoped totals match', async () => {
    const admin = await asAdmin();
    const { chitly, arrows } = await seedProducts();
    await seedLedger(admin.id, chitly.id, arrows.id);

    const whole = await getJson<{
      totals: { income: number; expense: number };
      byProduct: Array<{ productId: string | null; name: string; income: number; expense: number; count: number }>;
      scope: string;
    }>(await getSummary(buildJsonRequest('GET', 'http://test/api/finance/summary?month=2026-09')));
    expect(whole!.scope).toBe('all');
    expect(whole!.totals).toMatchObject({ income: 30000, expense: 15000 });
    expect(whole!.byProduct.map((b) => [b.name, b.income, b.expense, b.count])).toEqual([
      ['Chitly', 30000, 4000, 2],
      ['Arrows Go', 0, 6000, 2],
      ['OfficePilot (company-level)', 0, 5000, 1],
    ]);

    const scoped = await getJson<{ totals: { income: number; expense: number }; byProduct: unknown[]; product: string }>(
      await getSummary(
        buildJsonRequest('GET', 'http://test/api/finance/summary?month=2026-09&product=arrows-go'),
      ),
    );
    expect(scoped!.product).toBe('arrows-go');
    expect(scoped!.totals).toMatchObject({ income: 0, expense: 6000 });
    expect(scoped!.byProduct).toEqual([]);

    const companyOnly = await getJson<{ totals: { expense: number } }>(
      await getSummary(
        buildJsonRequest('GET', 'http://test/api/finance/summary?month=2026-09&product=company'),
      ),
    );
    expect(companyOnly!.totals.expense).toBe(5000);

    expect(
      (
        await getSummary(
          buildJsonRequest('GET', 'http://test/api/finance/summary?month=2026-09&product=nope'),
        )
      ).status,
    ).toBe(400);
  });

  it('export: Excel carries the Product column and a scoped report only has that product', async () => {
    const admin = await asAdmin();
    const { chitly, arrows } = await seedProducts();
    await seedLedger(admin.id, chitly.id, arrows.id);

    const res = await exportReport(
      buildJsonRequest('GET', 'http://test/api/finance/export?format=xlsx&month=2026-09&product=arrows-go'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('arrows-go');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const ws = wb.getWorksheet('Transactions')!;
    const headerRow = ws.getRow(6).values as unknown[];
    expect(headerRow).toContain('Product');
    const productCells: string[] = [];
    ws.eachRow((row) => {
      const v = row.getCell(4).value;
      if (v === 'Arrows Go' || v === 'Chitly') productCells.push(String(v));
    });
    expect(productCells).toEqual(['Arrows Go', 'Arrows Go']);

    const bad = await exportReport(
      buildJsonRequest('GET', 'http://test/api/finance/export?format=xlsx&month=2026-09&product=nope'),
    );
    expect(bad.status).toBe(400);
  });
});
