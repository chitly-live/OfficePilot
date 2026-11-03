/**
 * Integration tests for monthly GST returns (`/api/finance/gst`).
 *
 *   • ACCOUNTANT can create + edit a month (their only write); ADMIN too
 *   • Saving writes ONE TAX ledger row — the cash part, on the chosen
 *     account, under the Government (GST) party. The ITC set-off stays on
 *     the return (the GST inside purchases is already an expense).
 *   • Editing keeps the cash row in sync; zeroing cash removes it; a
 *     leftover ITC row from the older scheme is removed on the next save
 *   • One return per month (409 on duplicate); DELETE is admin-only and
 *     removes the row
 */

import { describe, expect, it } from 'vitest';

import { GET as listReturns, POST as createReturn } from '@/app/api/finance/gst/route';
import { DELETE as deleteReturn, PATCH as patchReturn } from '@/app/api/finance/gst/[id]/route';
import { prisma } from '@/lib/db';
import { GST_PARTY_NAME, defaultGstPaymentDate, itcByHead, itcRunningBalances } from '@/lib/gst';

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
  it('accountant records a month; only the cash part becomes a TAX row', async () => {
    const card = await seedCard();
    await asRole('ACCOUNTANT');

    const res = await createReturn(
      buildJsonRequest('POST', BASE, {
        month: '2026-08',
        itcClaimed: 21000,
        itcUsed: 18012,
        cashPaid: 4279,
        paidOn: '2026-09-17',
        cashAccountId: card.id,
        reference: 'CHALLAN-123',
      }),
    );
    expect(res.status).toBe(201);
    const body = await getJson<{ id: string; cashTransactionId: string; itcTransactionId: string | null }>(res);
    expect(body!.cashTransactionId).toBeTruthy();
    expect(body!.itcTransactionId).toBeNull();

    const rows = await taxRows();
    expect(rows.map((r) => [r.amount, r.accountId, r.party?.name, r.reference])).toEqual([
      [4279, card.id, GST_PARTY_NAME, 'CHALLAN-123'],
    ]);
    expect(rows[0].date.toISOString()).toBe('2026-09-17T00:00:00.000Z');

    const list = await getJson<{
      items: Array<{ month: string; itcClaimed: number; itcBalance: number }>;
      totals: { itcClaimed: number; itcUsed: number; cashPaid: number; itcBalance: number };
    }>(await listReturns());
    expect(list!.items.map((i) => [i.month, i.itcClaimed, i.itcBalance])).toEqual([['2026-08', 21000, 2988]]);
    expect(list!.totals).toEqual({ itcClaimed: 21000, itcUsed: 18012, cashPaid: 4279, itcBalance: 2988 });
    // Neither ITC claimed nor ITC used becomes a ledger row.
    expect(await prisma.financeTransaction.count()).toBe(1);
  });

  it('claim-only and ITC-only months write no ledger row but move the ITC balance', async () => {
    await asRole('ACCOUNTANT');
    expect((await createReturn(buildJsonRequest('POST', BASE, { month: '2026-06', itcClaimed: 5000 }))).status).toBe(201);
    expect((await createReturn(buildJsonRequest('POST', BASE, { month: '2026-07', itcClaimed: 4000, itcUsed: 6000 }))).status).toBe(201);
    expect(await prisma.financeTransaction.count()).toBe(0);
    const rows = await prisma.gstReturn.findMany({ select: { month: true, itcClaimed: true, itcUsed: true } });
    const bal = itcRunningBalances(rows);
    expect(bal.get('2026-06')).toBe(5000);
    expect(bal.get('2026-07')).toBe(3000);
  });

  it('cash with no date or account: one row, dated the 20th of the next month; duplicate month is 409', async () => {
    await asRole('ADMIN');
    const res = await createReturn(buildJsonRequest('POST', BASE, { month: '2026-07', itcUsed: 3000, cashPaid: 9000 }));
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

describe('Head-wise (IGST / CGST / SGST) figures', () => {
  it('totals are derived from the heads and the cash row follows them', async () => {
    const card = await seedCard();
    await asRole('ACCOUNTANT');

    const res = await createReturn(
      buildJsonRequest('POST', BASE, {
        month: '2026-08',
        itcClaimedIgst: 12000,
        itcClaimedCgst: 4500,
        itcClaimedSgst: 4500,
        itcUsedIgst: 10000,
        itcUsedCgst: 4006,
        itcUsedSgst: 4006,
        cashPaidIgst: 0,
        cashPaidCgst: 2139.5,
        cashPaidSgst: 2139.5,
        cashAccountId: card.id,
      }),
    );
    expect(res.status).toBe(201);
    const body = await getJson<{ id: string; itcClaimed: number; itcUsed: number; cashPaid: number }>(res);
    expect(body!.itcClaimed).toBe(21000);
    expect(body!.itcUsed).toBe(18012);
    expect(body!.cashPaid).toBe(4279);

    const rows = await taxRows();
    expect(rows.map((r) => r.amount)).toEqual([4279]);

    const list = await getJson<{
      byHead: { igst: { balance: number }; cgst: { balance: number }; sgst: { balance: number } };
    }>(await listReturns());
    expect(list!.byHead.igst.balance).toBe(2000);
    expect(list!.byHead.cgst.balance).toBe(494);
    expect(list!.byHead.sgst.balance).toBe(494);

    // Editing one head re-derives the totals.
    const patched = await patchReturn(
      buildJsonRequest('PATCH', `${BASE}/${body!.id}`, { cashPaidIgst: 1000 }),
      buildRouteContext(body!.id),
    );
    expect(patched.status).toBe(200);
    expect((await getJson<{ cashPaid: number }>(patched))!.cashPaid).toBe(5279);
    expect((await taxRows()).map((r) => r.amount)).toEqual([5279]);
  });

  it('itcByHead keeps the three heads separate', () => {
    const rows = [
      { itcClaimedIgst: 100, itcClaimedCgst: 50, itcClaimedSgst: 50, itcUsedIgst: 40, itcUsedCgst: 10, itcUsedSgst: 60 },
      { itcClaimedIgst: 0, itcClaimedCgst: 25, itcClaimedSgst: 25, itcUsedIgst: 0, itcUsedCgst: 0, itcUsedSgst: 0 },
    ];
    const out = itcByHead(rows);
    expect(out.igst).toEqual({ claimed: 100, used: 40, balance: 60 });
    expect(out.cgst).toEqual({ claimed: 75, used: 10, balance: 65 });
    expect(out.sgst).toEqual({ claimed: 75, used: 60, balance: 15 });
  });
});

describe('PATCH / DELETE /api/finance/gst/[id]', () => {
  it('editing re-syncs the cash row; zeroing cash removes it', async () => {
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
    expect(rows.map((r) => [r.amount, r.accountId])).toEqual([[2291, card.id]]);
    // Same row id was updated, not recreated.
    expect(rows[0].id).toBe(created!.cashTransactionId);

    // Zero the cash part → its row disappears; the return still exists.
    const zeroed = await patchReturn(
      buildJsonRequest('PATCH', `${BASE}/${created!.id}`, { cashPaid: 0 }),
      buildRouteContext(created!.id),
    );
    expect(zeroed.status).toBe(200);
    expect((await getJson<{ cashTransactionId: string | null }>(zeroed))!.cashTransactionId).toBeNull();
    rows = await taxRows();
    expect(rows).toEqual([]);

    // Cannot zero everything.
    expect(
      (
        await patchReturn(
          buildJsonRequest('PATCH', `${BASE}/${created!.id}`, { itcUsed: 0 }),
          buildRouteContext(created!.id),
        )
      ).status,
    ).toBe(400);
    // …unless a claim keeps the month meaningful.
    expect(
      (
        await patchReturn(
          buildJsonRequest('PATCH', `${BASE}/${created!.id}`, { itcUsed: 0, itcClaimed: 1500 }),
          buildRouteContext(created!.id),
        )
      ).status,
    ).toBe(200);
    expect(await prisma.financeTransaction.count({ where: { category: 'TAX' } })).toBe(0);
  });

  it('a leftover ITC row from the older scheme is removed on the next save', async () => {
    const card = await seedCard();
    await asRole('ADMIN');
    const created = await getJson<{ id: string; createdById: string }>(
      await createReturn(
        buildJsonRequest('POST', BASE, { month: '2026-08', itcUsed: 18012, cashPaid: 4279, cashAccountId: card.id }),
      ),
    );
    // What the two-row scheme left behind: an account-less TAX row for the ITC part.
    const legacy = await prisma.financeTransaction.create({
      data: {
        date: new Date('2026-09-17T00:00:00.000Z'),
        direction: 'OUT',
        category: 'TAX',
        amount: 18012,
        description: 'GST payment, Aug 2026 return — set off against input tax credit, no cash paid',
        createdById: created!.createdById,
      },
    });
    await prisma.gstReturn.update({ where: { id: created!.id }, data: { itcTransactionId: legacy.id } });

    // Changing only the notes still clears it.
    const patched = await patchReturn(
      buildJsonRequest('PATCH', `${BASE}/${created!.id}`, { notes: 'Checked against the portal' }),
      buildRouteContext(created!.id),
    );
    expect(patched.status).toBe(200);
    expect((await getJson<{ itcTransactionId: string | null }>(patched))!.itcTransactionId).toBeNull();
    expect((await taxRows()).map((r) => [r.amount, r.accountId])).toEqual([[4279, card.id]]);
    expect(await prisma.financeTransaction.findUnique({ where: { id: legacy.id } })).toBeNull();
  });

  it('delete is admin-only and removes the cash row', async () => {
    const card = await seedCard();
    await asRole('ADMIN');
    const created = await getJson<{ id: string }>(
      await createReturn(
        buildJsonRequest('POST', BASE, { month: '2026-08', itcUsed: 100, cashPaid: 50, cashAccountId: card.id }),
      ),
    );
    expect(await prisma.financeTransaction.count({ where: { category: 'TAX' } })).toBe(1);

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
