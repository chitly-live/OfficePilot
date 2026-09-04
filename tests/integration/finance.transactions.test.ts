/**
 * Integration tests for the Finance ledger API:
 *
 *   GET/POST      /api/finance/transactions
 *   GET/PATCH/DEL /api/finance/transactions/[id]
 *
 * Runs against the real test Postgres (see `tests/integration/setup.ts`).
 *
 * Coverage matrix:
 *
 *   Verb / Endpoint                      Happy  401  403  400  404  Audit
 *   GET  /api/finance/transactions        ✓     ✓    ✓    –    –    –
 *   POST /api/finance/transactions        ✓     –    ✓    ✓    –    ✓
 *   GET  /api/finance/transactions/[id]   ✓     –    –    –    ✓    –
 *   PATCH /api/finance/transactions/[id]  ✓     –    –    ✓    ✓    ✓
 *   DELETE /api/finance/transactions/[id] ✓     –    –    –    ✓    ✓
 */

import { describe, expect, it } from 'vitest';

import {
  GET as listTransactions,
  POST as createTransaction,
} from '@/app/api/finance/transactions/route';
import {
  DELETE as deleteTransaction,
  GET as getTransaction,
  PATCH as patchTransaction,
} from '@/app/api/finance/transactions/[id]/route';
import { prisma } from '@/lib/db';

import {
  buildJsonRequest,
  buildRouteContext,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

const BASE = 'http://test/api/finance/transactions';

async function asAdmin() {
  const { user } = await createTestUser({ role: 'ADMIN' });
  await setSession({ userId: user.id, role: 'ADMIN' });
  return user;
}

async function seedTxn(
  createdById: string,
  data: {
    date: string;
    direction: 'IN' | 'OUT';
    category: string;
    amount: number;
    partyId?: string;
    accountId?: string;
    description?: string;
  },
) {
  return prisma.financeTransaction.create({
    data: {
      date: new Date(`${data.date}T00:00:00.000Z`),
      direction: data.direction,
      // The seed bypasses zod so we cast; the enum is validated by Postgres.
      category: data.category as never,
      amount: data.amount,
      partyId: data.partyId,
      accountId: data.accountId,
      description: data.description,
      createdById,
    },
  });
}

// ---------------------------------------------------------------------------
// Auth gates
// ---------------------------------------------------------------------------

describe('/api/finance/transactions — auth', () => {
  it('GET returns 401 without a session', async () => {
    await setSession(null);
    const res = await listTransactions(buildJsonRequest('GET', BASE));
    expect(res.status).toBe(401);
    expect(await getJson(res)).toEqual({ error: 'unauthorized' });
  });

  it('GET returns 403 for an employee (module is admin-only)', async () => {
    const { user } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: user.id, role: 'EMPLOYEE' });
    const res = await listTransactions(buildJsonRequest('GET', BASE));
    expect(res.status).toBe(403);
  });

  it('POST returns 403 for an employee', async () => {
    const { user } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: user.id, role: 'EMPLOYEE' });
    const res = await createTransaction(
      buildJsonRequest('POST', BASE, {
        date: '2026-08-07',
        direction: 'OUT',
        category: 'ADS',
        amount: 6000,
      }),
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST — create
// ---------------------------------------------------------------------------

describe('POST /api/finance/transactions', () => {
  it('records an expense with a party + account and audits it', async () => {
    const admin = await asAdmin();
    const host = await prisma.financeParty.create({
      data: { name: 'Gadeshiya Rahulbhai', type: 'WORKER', createdById: admin.id },
    });
    const bank = await prisma.financeAccount.create({
      data: { name: 'HDFC', type: 'BANK' },
    });

    const res = await createTransaction(
      buildJsonRequest('POST', BASE, {
        date: '2026-08-07',
        direction: 'OUT',
        category: 'PAYOUT',
        amount: 701,
        partyId: host.id,
        accountId: bank.id,
        description: 'HOST payment',
        reference: 'UTR123',
      }),
    );
    expect(res.status).toBe(201);
    const body = await getJson<{
      id: string;
      date: string;
      amount: number;
      party: { id: string; name: string } | null;
      account: { id: string } | null;
      createdBy: { id: string };
    }>(res);
    expect(body).not.toBeNull();
    expect(body!.date).toBe('2026-08-07T00:00:00.000Z');
    expect(body!.amount).toBe(701);
    expect(body!.party?.name).toBe('Gadeshiya Rahulbhai');
    expect(body!.account?.id).toBe(bank.id);
    expect(body!.createdBy.id).toBe(admin.id);

    const log = await prisma.activityLog.findFirst({
      where: { action: 'finance.transaction_created' },
    });
    expect(log).not.toBeNull();
    expect(log!.entityId).toBe(body!.id);
    expect(log!.userId).toBe(admin.id);
  });

  it('stores foreign-currency originals alongside the INR amount', async () => {
    await asAdmin();
    const res = await createTransaction(
      buildJsonRequest('POST', BASE, {
        date: '2026-08-12',
        direction: 'OUT',
        category: 'SOFTWARE',
        amount: 29722,
        originalAmount: 299,
        originalCurrency: 'usd',
        description: 'ZeroCloud',
      }),
    );
    expect(res.status).toBe(201);
    const body = await getJson<{ originalAmount: number; originalCurrency: string }>(res);
    expect(body).toMatchObject({ originalAmount: 299, originalCurrency: 'USD' });
  });

  it('rejects a category that does not match the direction', async () => {
    await asAdmin();
    const res = await createTransaction(
      buildJsonRequest('POST', BASE, {
        date: '2026-08-07',
        direction: 'IN',
        category: 'ADS',
        amount: 100,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects zero / negative amounts and bad dates', async () => {
    await asAdmin();
    for (const bad of [
      { date: '2026-08-07', direction: 'OUT', category: 'ADS', amount: 0 },
      { date: '2026-08-07', direction: 'OUT', category: 'ADS', amount: -5 },
      { date: '07/08/2026', direction: 'OUT', category: 'ADS', amount: 5 },
      { date: '2026-08-07', direction: 'OUT', category: 'ADS', amount: 5, originalAmount: 1 },
    ]) {
      const res = await createTransaction(buildJsonRequest('POST', BASE, bad));
      expect(res.status).toBe(400);
    }
  });

  it('rejects an unknown party or account with 400', async () => {
    await asAdmin();
    const res = await createTransaction(
      buildJsonRequest('POST', BASE, {
        date: '2026-08-07',
        direction: 'OUT',
        category: 'ADS',
        amount: 5,
        partyId: 'does-not-exist',
      }),
    );
    expect(res.status).toBe(400);
    const body = await getJson<{ message: string }>(res);
    expect(body?.message).toMatch(/party not found/i);
  });
});

// ---------------------------------------------------------------------------
// GET — list, filters, totals
// ---------------------------------------------------------------------------

describe('GET /api/finance/transactions', () => {
  it('filters by month and returns totals for the whole filtered set', async () => {
    const admin = await asAdmin();
    await seedTxn(admin.id, { date: '2026-08-01', direction: 'OUT', category: 'ADS', amount: 6000 });
    await seedTxn(admin.id, { date: '2026-08-31', direction: 'OUT', category: 'ADS', amount: 8000 });
    await seedTxn(admin.id, { date: '2026-08-15', direction: 'IN', category: 'SALES', amount: 40000 });
    await seedTxn(admin.id, { date: '2026-08-20', direction: 'IN', category: 'LOAN_RECEIVED', amount: 50000 });
    // Outside the month — must not count.
    await seedTxn(admin.id, { date: '2026-09-01', direction: 'OUT', category: 'ADS', amount: 999 });

    const res = await listTransactions(
      buildJsonRequest('GET', `${BASE}?month=2026-08&pageSize=2`),
    );
    expect(res.status).toBe(200);
    const body = await getJson<{
      items: Array<{ date: string }>;
      total: number;
      totals: { cashIn: number; cashOut: number; income: number; expense: number; net: number };
    }>(res);
    expect(body!.total).toBe(4);
    expect(body!.items).toHaveLength(2);
    // Newest first by default.
    expect(body!.items[0].date).toBe('2026-08-31T00:00:00.000Z');
    expect(body!.totals).toEqual({
      cashIn: 90000,
      cashOut: 14000,
      income: 40000,
      expense: 14000,
      net: 26000,
    });
  });

  it('filters by direction, category, party and free-text search', async () => {
    const admin = await asAdmin();
    const host = await prisma.financeParty.create({
      data: { name: 'Tinkal Wankar', type: 'WORKER', createdById: admin.id },
    });
    await seedTxn(admin.id, { date: '2026-08-16', direction: 'OUT', category: 'PAYOUT', amount: 1012, partyId: host.id });
    await seedTxn(admin.id, { date: '2026-08-11', direction: 'OUT', category: 'PROFESSIONAL_FEES', amount: 5900, description: 'TAXSLICK ADVISORY CA' });
    await seedTxn(admin.id, { date: '2026-08-16', direction: 'IN', category: 'SALES', amount: 100 });

    const byDirection = await getJson<{ total: number }>(
      await listTransactions(buildJsonRequest('GET', `${BASE}?month=2026-08&direction=OUT`)),
    );
    expect(byDirection!.total).toBe(2);

    const byCategory = await getJson<{ total: number }>(
      await listTransactions(buildJsonRequest('GET', `${BASE}?month=2026-08&category=PAYOUT`)),
    );
    expect(byCategory!.total).toBe(1);

    const byParty = await getJson<{ total: number; items: Array<{ party: { name: string } }> }>(
      await listTransactions(buildJsonRequest('GET', `${BASE}?month=2026-08&partyId=${host.id}`)),
    );
    expect(byParty!.total).toBe(1);
    expect(byParty!.items[0].party.name).toBe('Tinkal Wankar');

    const bySearch = await getJson<{ total: number }>(
      await listTransactions(buildJsonRequest('GET', `${BASE}?month=2026-08&search=taxslick`)),
    );
    expect(bySearch!.total).toBe(1);

    // Search also matches the party name.
    const byPartySearch = await getJson<{ total: number }>(
      await listTransactions(buildJsonRequest('GET', `${BASE}?month=2026-08&search=tinkal`)),
    );
    expect(byPartySearch!.total).toBe(1);
  });

  it('returns 400 for a malformed month', async () => {
    await asAdmin();
    const res = await listTransactions(buildJsonRequest('GET', `${BASE}?month=Aug-2026`));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// [id] — GET / PATCH / DELETE
// ---------------------------------------------------------------------------

describe('/api/finance/transactions/[id]', () => {
  it('GET returns the row, 404 when missing', async () => {
    const admin = await asAdmin();
    const t = await seedTxn(admin.id, { date: '2026-08-07', direction: 'OUT', category: 'ADS', amount: 6000 });

    const ok = await getTransaction(
      buildJsonRequest('GET', `${BASE}/${t.id}`),
      buildRouteContext(t.id),
    );
    expect(ok.status).toBe(200);
    expect((await getJson<{ id: string }>(ok))!.id).toBe(t.id);

    const missing = await getTransaction(
      buildJsonRequest('GET', `${BASE}/nope`),
      buildRouteContext('nope'),
    );
    expect(missing.status).toBe(404);
  });

  it('PATCH updates amount / description and clears optional fields with null', async () => {
    const admin = await asAdmin();
    const bank = await prisma.financeAccount.create({ data: { name: 'Cash', type: 'CASH' } });
    const t = await seedTxn(admin.id, {
      date: '2026-08-07',
      direction: 'OUT',
      category: 'ADS',
      amount: 6000,
      accountId: bank.id,
      description: 'fb',
    });

    const res = await patchTransaction(
      buildJsonRequest('PATCH', `${BASE}/${t.id}`, {
        amount: 6500,
        description: 'Facebook ads',
        accountId: null,
        reference: '',
      }),
      buildRouteContext(t.id),
    );
    expect(res.status).toBe(200);
    const body = await getJson<{
      amount: number;
      description: string | null;
      account: unknown;
      reference: string | null;
    }>(res);
    expect(body).toMatchObject({
      amount: 6500,
      description: 'Facebook ads',
      account: null,
      reference: null,
    });

    const log = await prisma.activityLog.findFirst({
      where: { action: 'finance.transaction_updated', entityId: t.id },
    });
    expect(log).not.toBeNull();
  });

  it('PATCH rejects a direction/category mismatch even when only one side changes', async () => {
    const admin = await asAdmin();
    const t = await seedTxn(admin.id, { date: '2026-08-07', direction: 'OUT', category: 'ADS', amount: 6000 });

    const flipDirectionOnly = await patchTransaction(
      buildJsonRequest('PATCH', `${BASE}/${t.id}`, { direction: 'IN' }),
      buildRouteContext(t.id),
    );
    expect(flipDirectionOnly.status).toBe(400);

    const flipBoth = await patchTransaction(
      buildJsonRequest('PATCH', `${BASE}/${t.id}`, { direction: 'IN', category: 'SALES' }),
      buildRouteContext(t.id),
    );
    expect(flipBoth.status).toBe(200);
  });

  it('PATCH with an empty body is a 400; unknown id is a 404', async () => {
    const admin = await asAdmin();
    const t = await seedTxn(admin.id, { date: '2026-08-07', direction: 'OUT', category: 'ADS', amount: 6000 });

    const empty = await patchTransaction(
      buildJsonRequest('PATCH', `${BASE}/${t.id}`, {}),
      buildRouteContext(t.id),
    );
    expect(empty.status).toBe(400);

    const missing = await patchTransaction(
      buildJsonRequest('PATCH', `${BASE}/nope`, { amount: 1 }),
      buildRouteContext('nope'),
    );
    expect(missing.status).toBe(404);
  });

  it('DELETE removes the row and audits; second delete is 404', async () => {
    const admin = await asAdmin();
    const t = await seedTxn(admin.id, { date: '2026-08-07', direction: 'OUT', category: 'ADS', amount: 6000 });

    const res = await deleteTransaction(
      buildJsonRequest('DELETE', `${BASE}/${t.id}`),
      buildRouteContext(t.id),
    );
    expect([200, 204]).toContain(res.status);
    expect(await prisma.financeTransaction.findUnique({ where: { id: t.id } })).toBeNull();

    const log = await prisma.activityLog.findFirst({
      where: { action: 'finance.transaction_deleted', entityId: t.id },
    });
    expect(log).not.toBeNull();

    const again = await deleteTransaction(
      buildJsonRequest('DELETE', `${BASE}/${t.id}`),
      buildRouteContext(t.id),
    );
    expect(again.status).toBe(404);
  });
});
