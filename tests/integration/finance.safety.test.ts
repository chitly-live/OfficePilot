/**
 * Integration tests for the checks that keep money from being recorded
 * wrong:
 *
 *   • duplicate warning on POST /api/finance/transactions
 *   • one payment split across cards (create, edit, amount guard)
 *   • month close: lock date, refused writes, reopen order, drift tripwire
 *   • GST-generated rows are owned by the GST page
 */

import { describe, expect, it } from 'vitest';

import { DELETE as reopen, GET as getCloses, POST as close } from '@/app/api/finance/close/route';
import { PATCH as patchAccount } from '@/app/api/finance/accounts/[id]/route';
import { POST as createGst } from '@/app/api/finance/gst/route';
import {
  DELETE as deleteTransaction,
  PATCH as patchTransaction,
} from '@/app/api/finance/transactions/[id]/route';
import { POST as createTransaction } from '@/app/api/finance/transactions/route';
import { prisma } from '@/lib/db';
import { loadCardOverview } from '@/lib/finance-cards';

import { buildJsonRequest, buildRouteContext, createTestUser, getJson, setSession } from './helpers';

const TXN = 'http://test/api/finance/transactions';
const CLOSE = 'http://test/api/finance/close';

async function setup() {
  const { user } = await createTestUser({ role: 'ADMIN' });
  await setSession({ userId: user.id, role: 'ADMIN' });
  const shubham = await prisma.financeParty.create({
    data: { name: 'Shubham Kumar', type: 'CARD_OWNER', createdById: user.id },
  });
  const rbl = await prisma.financeAccount.create({
    data: { name: 'RBL card', type: 'CREDIT_CARD', ownerPartyId: shubham.id, creditLimit: 60000 },
  });
  const icici = await prisma.financeAccount.create({
    data: { name: 'ICICI card', type: 'CREDIT_CARD', ownerPartyId: shubham.id, creditLimit: 60000 },
  });
  const bank = await prisma.financeAccount.create({
    data: { name: 'YES BANK', type: 'BANK', openingBalance: 5096.82 },
  });
  return { user, shubham, rbl, icici, bank };
}

async function post(body: Record<string, unknown>) {
  const res = await createTransaction(buildJsonRequest('POST', TXN, body));
  return { status: res.status, body: await getJson<Record<string, unknown>>(res) };
}

describe('duplicate warning', () => {
  it('warns on the same amount on the same account within a day, and saves when confirmed', async () => {
    const { rbl } = await setup();
    const row = { date: '2026-09-18', direction: 'OUT', category: 'ADS', amount: 10000, accountId: rbl.id };

    expect((await post(row)).status).toBe(201);

    const again = await post({ ...row, date: '2026-09-19' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: 'possible_duplicate' });
    expect((again.body!.duplicates as unknown[]).length).toBe(1);

    expect((await post({ ...row, date: '2026-09-19', confirmDuplicate: true })).status).toBe(201);
    expect(await prisma.financeTransaction.count()).toBe(2);
  });

  it('lets the same amount through on another card or two days later', async () => {
    const { rbl, icici } = await setup();
    const row = { date: '2026-09-18', direction: 'OUT', category: 'ADS', amount: 10000, accountId: rbl.id };
    expect((await post(row)).status).toBe(201);
    expect((await post({ ...row, accountId: icici.id })).status).toBe(201);
    expect((await post({ ...row, date: '2026-09-20' })).status).toBe(201);
  });

  it('catches a repeated UTR even with a different amount', async () => {
    const { bank } = await setup();
    const row = {
      date: '2026-09-28',
      direction: 'IN',
      category: 'SALES',
      amount: 12096.16,
      accountId: bank.id,
      reference: 'AXISCN1481398175',
    };
    expect((await post(row)).status).toBe(201);
    const again = await post({ ...row, amount: 1, reference: 'axiscn1481398175' });
    expect(again.status).toBe(409);
  });
});

describe('one payment, several cards', () => {
  it('stores ONE ledger row and splits it across the cards', async () => {
    const { shubham, rbl, icici, bank } = await setup();
    // Spend on both cards, then one NEFT that clears both.
    await post({ date: '2026-09-01', direction: 'OUT', category: 'ADS', amount: 40000, accountId: rbl.id });
    await post({ date: '2026-09-02', direction: 'OUT', category: 'ADS', amount: 35000, accountId: icici.id });

    const pay = await post({
      date: '2026-09-21',
      direction: 'OUT',
      category: 'CARD_REPAYMENT',
      amount: 70000,
      partyId: shubham.id,
      accountId: bank.id,
      cardSplit: [
        { accountId: rbl.id, amount: 37222 },
        { accountId: icici.id, amount: 32778 },
      ],
    });
    expect(pay.status).toBe(201);
    expect(pay.body).toMatchObject({ amount: 70000, settlesAccountId: null });
    expect((pay.body!.cardAllocations as unknown[]).length).toBe(2);
    expect(await prisma.financeTransaction.count({ where: { category: 'CARD_REPAYMENT' } })).toBe(1);

    const cards = await loadCardOverview(prisma, new Date('2026-09-29T00:00:00Z'));
    const out = Object.fromEntries(cards.map((c) => [c.name, c.position.outstanding]));
    expect(out).toEqual({ 'ICICI card': 2222, 'RBL card': 2778 });
  });

  it('refuses a split that does not add up, or a split with settlesAccountId', async () => {
    const { shubham, rbl, icici, bank } = await setup();
    const base = {
      date: '2026-09-21',
      direction: 'OUT',
      category: 'CARD_REPAYMENT',
      amount: 70000,
      partyId: shubham.id,
      accountId: bank.id,
    };
    const short = await post({
      ...base,
      cardSplit: [
        { accountId: rbl.id, amount: 37222 },
        { accountId: icici.id, amount: 32777 },
      ],
    });
    expect(short.status).toBe(400);
    expect(short.body!.message).toMatch(/to the paisa/);

    const both = await post({
      ...base,
      settlesAccountId: rbl.id,
      cardSplit: [
        { accountId: rbl.id, amount: 35000 },
        { accountId: icici.id, amount: 35000 },
      ],
    });
    expect(both.status).toBe(400);

    const notCard = await post({
      ...base,
      cardSplit: [
        { accountId: rbl.id, amount: 35000 },
        { accountId: bank.id, amount: 35000 },
      ],
    });
    expect(notCard.status).toBe(400);
    expect(await prisma.financeTransaction.count()).toBe(0);
  });

  it('edits keep the split; changing the amount alone is refused; switching to one card clears it', async () => {
    const { shubham, rbl, icici, bank } = await setup();
    const pay = await post({
      date: '2026-09-21',
      direction: 'OUT',
      category: 'CARD_REPAYMENT',
      amount: 70000,
      partyId: shubham.id,
      accountId: bank.id,
      cardSplit: [
        { accountId: rbl.id, amount: 37222 },
        { accountId: icici.id, amount: 32778 },
      ],
    });
    const id = pay.body!.id as string;
    const patch = (body: Record<string, unknown>) =>
      patchTransaction(buildJsonRequest('PATCH', `${TXN}/${id}`, body), buildRouteContext(id));

    // The edit form re-sends settlesAccountId: null with every save.
    const label = await patch({ description: 'Card bill repaid to Shubham', settlesAccountId: null });
    expect(label.status).toBe(200);
    expect(await prisma.cardRepaymentAllocation.count()).toBe(2);

    const amountOnly = await patch({ amount: 71000 });
    expect(amountOnly.status).toBe(400);

    const resplit = await patch({
      amount: 71000,
      cardSplit: [
        { accountId: rbl.id, amount: 38222 },
        { accountId: icici.id, amount: 32778 },
      ],
    });
    expect(resplit.status).toBe(200);

    const single = await patch({ settlesAccountId: rbl.id });
    expect(single.status).toBe(200);
    expect(await prisma.cardRepaymentAllocation.count()).toBe(0);
    expect((await prisma.financeTransaction.findUnique({ where: { id } }))!.settlesAccountId).toBe(rbl.id);
  });

  it('leaving CARD_REPAYMENT stops the row settling any card', async () => {
    const { shubham, rbl, bank } = await setup();
    const pay = await post({
      date: '2026-09-21',
      direction: 'OUT',
      category: 'CARD_REPAYMENT',
      amount: 5000,
      partyId: shubham.id,
      accountId: bank.id,
      settlesAccountId: rbl.id,
    });
    const id = pay.body!.id as string;
    const res = await patchTransaction(
      buildJsonRequest('PATCH', `${TXN}/${id}`, { category: 'PAYOUT' }),
      buildRouteContext(id),
    );
    expect(res.status).toBe(200);
    expect((await prisma.financeTransaction.findUnique({ where: { id } }))!.settlesAccountId).toBeNull();
  });
});

describe('month close', () => {
  it('locks the month and everything before it; refuses writes; reopens newest first', async () => {
    const { bank } = await setup();
    const aug = await post({ date: '2026-08-10', direction: 'IN', category: 'SALES', amount: 1000, accountId: bank.id });
    await post({ date: '2026-09-10', direction: 'OUT', category: 'ADS', amount: 400, accountId: bank.id });

    const closed = await close(buildJsonRequest('POST', CLOSE, { month: '2026-08' }));
    expect(closed.status).toBe(201);
    expect(await getJson(closed)).toMatchObject({ closed: ['2026-08'] });

    // Recorded balance: 5,096.82 + 1,000.
    const status = await getJson<{
      closes: { month: string; balances: { accountName: string; balance: number }[]; drift: unknown[] }[];
    }>(await getCloses());
    expect(status!.closes[0]).toMatchObject({ month: '2026-08', drift: [] });
    expect(status!.closes[0]!.balances.find((b) => b.accountName === 'YES BANK')!.balance).toBe(6096.82);

    // New row in August, edit, move out, delete: all refused.
    const late = await post({ date: '2026-08-31', direction: 'OUT', category: 'ADS', amount: 1, accountId: bank.id });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ error: 'month_closed' });
    const augId = aug.body!.id as string;
    const moved = await patchTransaction(
      buildJsonRequest('PATCH', `${TXN}/${augId}`, { date: '2026-09-01' }),
      buildRouteContext(augId),
    );
    expect(moved.status).toBe(409);
    const gone = await deleteTransaction(buildJsonRequest('DELETE', `${TXN}/${augId}`), buildRouteContext(augId));
    expect(gone.status).toBe(409);

    // Moving a September row INTO August is refused too.
    const sepRow = await prisma.financeTransaction.findFirstOrThrow({ where: { date: new Date('2026-09-10') } });
    const intoAug = await patchTransaction(
      buildJsonRequest('PATCH', `${TXN}/${sepRow.id}`, { date: '2026-08-30' }),
      buildRouteContext(sepRow.id),
    );
    expect(intoAug.status).toBe(409);

    // September is still open.
    expect((await post({ date: '2026-09-11', direction: 'OUT', category: 'ADS', amount: 2, accountId: bank.id })).status).toBe(201);

    // Changing the opening balance would move August — refused; re-saving the same value is fine.
    const opening = await patchAccount(
      buildJsonRequest('PATCH', `http://test/api/finance/accounts/${bank.id}`, { openingBalance: 5000 }),
      buildRouteContext(bank.id),
    );
    expect(opening.status).toBe(409);
    const same = await patchAccount(
      buildJsonRequest('PATCH', `http://test/api/finance/accounts/${bank.id}`, { openingBalance: 5096.82, name: 'YES BANK' }),
      buildRouteContext(bank.id),
    );
    expect(same.status).toBe(200);

    // Reopen, then the write goes through.
    const reopened = await reopen(buildJsonRequest('DELETE', `${CLOSE}?month=2026-08`));
    expect(reopened.status).toBe(200);
    expect((await post({ date: '2026-08-31', direction: 'OUT', category: 'ADS', amount: 1, accountId: bank.id })).status).toBe(201);
  });

  it('closing a later month records every open month before it; reopen must go newest first', async () => {
    const { bank } = await setup();
    await post({ date: '2026-07-05', direction: 'IN', category: 'SALES', amount: 100, accountId: bank.id });
    const res = await close(buildJsonRequest('POST', CLOSE, { month: '2026-08' }));
    expect(await getJson(res)).toMatchObject({ closed: ['2026-07', '2026-08'] });

    const wrongOrder = await reopen(buildJsonRequest('DELETE', `${CLOSE}?month=2026-07`));
    expect(wrongOrder.status).toBe(409);
    expect(await getJson(wrongOrder)).toMatchObject({ error: 'reopen_order' });

    const again = await close(buildJsonRequest('POST', CLOSE, { month: '2026-08' }));
    expect(again.status).toBe(409);
  });

  it('refuses to close a month that has not ended', async () => {
    await setup();
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const res = await close(buildJsonRequest('POST', CLOSE, { month }));
    expect(res.status).toBe(400);
  });

  it('flags a closed balance that changed behind the lock', async () => {
    const { bank } = await setup();
    const row = await post({ date: '2026-08-10', direction: 'IN', category: 'SALES', amount: 1000, accountId: bank.id });
    await close(buildJsonRequest('POST', CLOSE, { month: '2026-08' }));
    // A direct database fix — the kind of change the lock cannot stop.
    await prisma.financeTransaction.update({ where: { id: row.body!.id as string }, data: { amount: 900 } });
    const status = await getJson<{ closes: { drift: { difference: number }[] }[] }>(await getCloses());
    expect(status!.closes[0]!.drift).toEqual([expect.objectContaining({ difference: -100 })]);
  });

  it('only an admin can close', async () => {
    await setup();
    const { user } = await createTestUser({ role: 'ACCOUNTANT', email: 'ca@example.com' });
    await setSession({ userId: user.id, role: 'ACCOUNTANT' });
    const res = await close(buildJsonRequest('POST', CLOSE, { month: '2026-08' }));
    expect(res.status).toBe(403);
  });
});

describe('GST rows belong to the GST page', () => {
  it('refuses money edits and deletes of a GST-generated row, allows a label change', async () => {
    const { bank } = await setup();
    const gst = await createGst(
      buildJsonRequest('POST', 'http://test/api/finance/gst', {
        month: '2026-08',
        itcUsed: 18012,
        cashPaid: 4279,
        paidOn: '2026-09-17',
        cashAccountId: bank.id,
      }),
    );
    expect(gst.status).toBe(201);
    const cashRow = await prisma.financeTransaction.findFirstOrThrow({ where: { category: 'TAX', accountId: bank.id } });

    const money = await patchTransaction(
      buildJsonRequest('PATCH', `${TXN}/${cashRow.id}`, { amount: 4000 }),
      buildRouteContext(cashRow.id),
    );
    expect(money.status).toBe(400);
    const del = await deleteTransaction(buildJsonRequest('DELETE', `${TXN}/${cashRow.id}`), buildRouteContext(cashRow.id));
    expect(del.status).toBe(400);
    const label = await patchTransaction(
      buildJsonRequest('PATCH', `${TXN}/${cashRow.id}`, { reference: 'CPIN 123' }),
      buildRouteContext(cashRow.id),
    );
    expect(label.status).toBe(200);
  });

  it('a closed month blocks a GST return whose rows fall in it', async () => {
    const { bank } = await setup();
    await post({ date: '2026-08-10', direction: 'IN', category: 'SALES', amount: 1000, accountId: bank.id });
    await close(buildJsonRequest('POST', CLOSE, { month: '2026-08' }));
    const res = await createGst(
      buildJsonRequest('POST', 'http://test/api/finance/gst', {
        month: '2026-07',
        cashPaid: 100,
        paidOn: '2026-08-20',
        cashAccountId: bank.id,
      }),
    );
    expect(res.status).toBe(409);
  });
});
