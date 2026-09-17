/**
 * Integration tests for monthly GST returns (`/api/finance/gst`).
 *
 *   • ACCOUNTANT can create + edit a month (their only write); ADMIN too
 *   • Saving writes the two TAX ledger rows (cash on the chosen account,
 *     ITC with no account) under the Government (GST) party
 *   • Editing keeps the rows in sync; zeroing a part removes its row
 *   • One return per month (409 on duplicate); DELETE is admin-only and
 *     removes both rows
 */

import { describe, expect, it } from 'vitest';

import { GET as listReturns, POST as createReturn } from '@/app/api/finance/gst/route';
import { DELETE as deleteReturn, PATCH as patchReturn } from '@/app/api/finance/gst/[id]/route';
import { prisma } from '@/lib/db';
import { GST_PARTY_NAME, defaultGstPaymentDate } from '@/lib/gst';

import {
  buildJsonRequest,
  buildRouteContext,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

const BASE = 'http://test/api/finance/gst';

async function asRole(role: 'ADMIN' | 'ACCOUNTANT' | 'EMPLOYEE') {
  const { user } = await createTestUser({ role });
  await setSession({ userId: user.id, role });
  return user;
}

async function seedCard() {
  return prisma.financeAccount.create({
    data: { name: 'SHUBHAM-ICICI-BANK-CREDIT-CARD', type: 'CREDIT_CARD' },
  });
}

async function taxRows() {
  return prisma.financeTransaction.findMany({
    where: { category: 'TAX' },
    orderBy: [{ amount: 'asc' }],
    select: { id: true, amount: true, accountId: true, date: true, party: { select: { name: true } }, reference: true },
  });
}

describe('POST /api/finance/gst', () => {
  it('accountant records a month; two TAX rows appear under Government (GST)', async () => {
    const card = await seedCard();
    await asRole('ACCOUNTANT');

    const res = await createReturn(
      buildJsonRequest('POST', BASE, {
        month: '2026-08',
        itcUsed: 18012,
        cashPaid: 4279,
        paidOn: '2026-09-17',
        cashAccountId: card.id,
        reference: 'CHALLAN-123',
      }),
    );
    expect(res.status).toBe(201);
    const body = await getJson<{ id: string; cashTransactionId: string; itcTransactionId: string }>(res);
    expect(body!.cashTransactionId).toBeTruthy();
    expect(body!.itcTransactionId).toBeTruthy();

    const rows = await taxRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.amount, r.accountId, r.party?.name, r.reference])).toEqual([
      [4279, card.id, GST_PARTY_NAME, 'CHALLAN-123'],
      [18012, null, GST_PARTY_NAME, 'CHALLAN-123'],
    ]);
    expect(rows[0].date.toISOString()).toBe('2026-09-17T00:00:00.000Z');

    const list = await getJson<{ items: Array<{ month: string }>; totals: { itcUsed: number; cashPaid: number } }>(
      await listReturns(),
    );
    expect(list!.items.map((i) => i.month)).toEqual(['2026-08']);
    expect(list!.totals).toEqual({ itcUsed: 18012, cashPaid: 4279 });
  });

  it('ITC-only return: one row, dated the 20th of the next month; duplicate month is 409', async () => {
    await asRole('ADMIN');
    const res = await createReturn(buildJsonRequest('POST', BASE, { month: '2026-07', itcUsed: 9000 }));
    expect(res.status).toBe(201);

    const rows = await taxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(9000);
    expect(rows[0].accountId).toBeNull();
    expect(rows[0].date.toISOString()).toBe(defaultGstPaymentDate('2026-07').toISOString());
    expect(rows[0].date.toISOString()).toBe('2026-08-20T00:00:00.000Z');

    expect(
      (await createReturn(buildJsonRequest('POST', BASE, { month: '2026-07', cashPaid: 1 }))).status,
    ).toBe(409);
  });

  it('rejects an empty return, a bad month, an unknown account; employees get 403', async () => {
    await asRole('ADMIN');
    expect((await createReturn(buildJsonRequest('POST', BASE, { month: '2026-08' }))).status).toBe(400);
    expect((await createReturn(buildJsonRequest('POST', BASE, { month: '2026-13', cashPaid: 1 }))).status).toBe(400);
    expect(
      (await createReturn(buildJsonRequest('POST', BASE, { month: '2026-08', cashPaid: 1, cashAccountId: 'nope' }))).status,
    ).toBe(400);

    await asRole('EMPLOYEE');
    expect((await createReturn(buildJsonRequest('POST', BASE, { month: '2026-08', cashPaid: 1 }))).status).toBe(403);
    expect((await listReturns()).status).toBe(403);
  });
});

describe('PATCH / DELETE /api/finance/gst/[id]', () => {
  it('editing re-syncs the ledger rows; zeroing cash removes that row', async () => {
    const card = await seedCard();
    await asRole('ACCOUNTANT');
    const created = await getJson<{ id: string; cashTransactionId: string }>(
      await createReturn(
        buildJsonRequest('POST', BASE, { month: '2026-08', itcUsed: 18012, cashPaid: 4279, cashAccountId: card.id }),
      ),
    );

    // Change the figures.
    const patched = await patchReturn(
      buildJsonRequest('PATCH', `${BASE}/${created!.id}`, { itcUsed: 20000, cashPaid: 2291 }),
      buildRouteContext(created!.id),
    );
    expect(patched.status).toBe(200);
    let rows = await taxRows();
    expect(rows.map((r) => [r.amount, r.accountId])).toEqual([
      [2291, card.id],
      [20000, null],
    ]);
    // Same row ids were updated, not recreated.
    expect(rows.find((r) => r.amount === 2291)!.id).toBe(created!.cashTransactionId);

    // Zero the cash part → its row disappears; the return still exists.
    const zeroed = await patchReturn(
      buildJsonRequest('PATCH', `${BASE}/${created!.id}`, { cashPaid: 0 }),
      buildRouteContext(created!.id),
    );
    expect(zeroed.status).toBe(200);
    expect((await getJson<{ cashTransactionId: string | null }>(zeroed))!.cashTransactionId).toBeNull();
    rows = await taxRows();
    expect(rows.map((r) => r.amount)).toEqual([20000]);

    // Cannot zero both.
    expect(
      (
        await patchReturn(
          buildJsonRequest('PATCH', `${BASE}/${created!.id}`, { itcUsed: 0 }),
          buildRouteContext(created!.id),
        )
      ).status,
    ).toBe(400);
  });

  it('delete is admin-only and removes both ledger rows', async () => {
    const card = await seedCard();
    await asRole('ADMIN');
    const created = await getJson<{ id: string }>(
      await createReturn(
        buildJsonRequest('POST', BASE, { month: '2026-08', itcUsed: 100, cashPaid: 50, cashAccountId: card.id }),
      ),
    );
    expect(await prisma.financeTransaction.count({ where: { category: 'TAX' } })).toBe(2);

    await asRole('ACCOUNTANT');
    expect(
      (await deleteReturn(buildJsonRequest('DELETE', `${BASE}/${created!.id}`), buildRouteContext(created!.id))).status,
    ).toBe(403);

    await asRole('ADMIN');
    expect(
      (await deleteReturn(buildJsonRequest('DELETE', `${BASE}/${created!.id}`), buildRouteContext(created!.id))).status,
    ).toBe(204);
    expect(await prisma.gstReturn.count()).toBe(0);
    expect(await prisma.financeTransaction.count({ where: { category: 'TAX' } })).toBe(0);
    expect(
      (await deleteReturn(buildJsonRequest('DELETE', `${BASE}/${created!.id}`), buildRouteContext(created!.id))).status,
    ).toBe(404);
  });
});
