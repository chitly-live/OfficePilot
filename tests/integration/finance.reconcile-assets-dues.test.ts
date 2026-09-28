/**
 * Integration tests for:
 *
 *   POST /api/finance/reconcile        — statement vs ledger, balances, suggestions
 *   /api/finance/assets (+ [id], assign) — register, hand-overs, trail, status
 *   loadDues / loadPosition            — card bills already generated, GST, net position
 */

import { describe, expect, it } from 'vitest';

import { POST as assign } from '@/app/api/finance/assets/[id]/assign/route';
import { GET as getAsset, PATCH as patchAsset } from '@/app/api/finance/assets/[id]/route';
import { GET as listAssets, POST as createAsset } from '@/app/api/finance/assets/route';
import { POST as reconcile } from '@/app/api/finance/reconcile/route';
import { POST as createTransaction } from '@/app/api/finance/transactions/route';
import { prisma } from '@/lib/db';
import { loadDues, loadPosition } from '@/lib/dues';

import { buildJsonRequest, buildRouteContext, createTestUser, getJson, setSession } from './helpers';

const TXN = 'http://test/api/finance/transactions';
const ASSETS = 'http://test/api/finance/assets';

async function setup() {
  const { user } = await createTestUser({ role: 'ADMIN', name: 'Admin' });
  await setSession({ userId: user.id, role: 'ADMIN' });
  const bank = await prisma.financeAccount.create({
    data: { name: 'YES BANK', type: 'BANK', openingBalance: 5096.82 },
  });
  const cashfree = await prisma.financeParty.create({
    data: { name: 'CASHFREE', type: 'CLIENT', createdById: user.id },
  });
  return { user, bank, cashfree };
}

async function post(body: Record<string, unknown>) {
  const res = await createTransaction(buildJsonRequest('POST', TXN, { ...body, confirmDuplicate: true }));
  expect(res.status).toBe(201);
  return (await getJson<{ id: string }>(res))!;
}

const STATEMENT = [
  '000261900007090 ,PRAXXEL TECHNOLOGIES PRIVATE LIMITED',
  '',
  'Statement Period,2026-08-01,To,2026-08-31,',
  'Opening Balance,INR 5096.82',
  'Closing Balance,INR 5320.10',
  'Transaction Date,Value Date,Description,Reference Number,Withdrawals,Deposits,Running Balance',
  '2026-08-31,2026-08-31,IMPS PAYMENT CHRGS for 29-Aug-2026,ORMB957221750355   ,7.00,,INR 5320.10',
  '2026-08-31,2026-08-31,GST,ORMB957221750355   ,1.26,,INR 5327.10',
  '2026-08-01,2026-08-01,NEFT-HDFCH01163858230-CASHFREE PAYMENTS,HDFCH01163858230,,231.54,INR 5328.36',
].join('\r\n');

describe('POST /api/finance/reconcile', () => {
  it('matches what is recorded, lists what is missing with a suggestion, and checks the balances', async () => {
    const { bank, cashfree } = await setup();
    await post({
      date: '2026-08-01',
      direction: 'IN',
      category: 'SALES',
      amount: 231.54,
      accountId: bank.id,
      partyId: cashfree.id,
      reference: 'HDFCH01163858230',
      description: 'Cashfree settlement · sales 30 Jul 2026',
    });

    const res = await reconcile(
      buildJsonRequest('POST', 'http://test/api/finance/reconcile', { accountId: bank.id, csv: STATEMENT }),
    );
    expect(res.status).toBe(200);
    const view = (await getJson<Record<string, any>>(res))!;
    expect(view).toMatchObject({
      statementLines: 3,
      ledgerRows: 1,
      clean: false,
      month: '2026-08',
      opening: { statement: 5096.82, ledger: 5096.82 },
      closing: { statement: 5320.1, ledger: 5328.36 },
    });
    expect(view.matched).toHaveLength(1);
    expect(view.matched[0].kind).toBe('reference');
    expect(view.missing.map((m: any) => m.suggestion.description).sort()).toEqual([
      'GST on IMPS charges for 29-Aug-2026',
      'IMPS charges for 29-Aug-2026',
    ]);
    expect(view.dayMismatches[0]).toMatchObject({ date: '2026-08-31', difference: 8.26 });

    // Add the two charges the way the page does, then it is clean.
    for (const m of view.missing) {
      await post({
        date: m.line.date.slice(0, 10),
        direction: m.line.direction,
        category: m.suggestion.category,
        amount: m.line.amount,
        accountId: bank.id,
        description: m.suggestion.description,
        reference: m.line.reference,
      });
    }
    const again = (await getJson<Record<string, any>>(
      await reconcile(buildJsonRequest('POST', 'http://test/api/finance/reconcile', { accountId: bank.id, csv: STATEMENT })),
    ))!;
    expect(again).toMatchObject({ clean: true, missing: [], extra: [], dayMismatches: [] });
  });

  it('reports a row the bank never saw', async () => {
    const { bank } = await setup();
    await post({ date: '2026-08-15', direction: 'OUT', category: 'ADS', amount: 999, accountId: bank.id });
    const view = (await getJson<Record<string, any>>(
      await reconcile(buildJsonRequest('POST', 'http://test/api/finance/reconcile', { accountId: bank.id, csv: STATEMENT })),
    ))!;
    expect(view.extra.map((r: any) => r.amount)).toEqual([999]);
  });

  it('says clearly when the file is not a statement', async () => {
    const { bank } = await setup();
    const res = await reconcile(
      buildJsonRequest('POST', 'http://test/api/finance/reconcile', { accountId: bank.id, csv: 'hello,world' }),
    );
    expect(res.status).toBe(400);
  });
});

describe('assets', () => {
  it('records a purchase, hands it over, keeps the trail, and closes it when sold', async () => {
    const { user } = await setup();
    const { user: anchal } = await createTestUser({ role: 'EMPLOYEE', name: 'Anchal' });
    const tinkal = await prisma.financeParty.create({
      data: { name: 'Tinkal', type: 'WORKER', createdById: user.id },
    });
    const card = await prisma.financeAccount.create({ data: { name: 'AXIS card', type: 'CREDIT_CARD' } });
    const payment = await post({
      date: '2026-09-19',
      direction: 'OUT',
      category: 'ASSET_PURCHASE',
      amount: 349,
      accountId: card.id,
      description: 'New Jio SIM — Anchal 86687 70573',
    });

    const created = await createAsset(
      buildJsonRequest('POST', ASSETS, {
        name: 'Jio SIM',
        category: 'SIM',
        identifier: '86687 70573',
        purchaseDate: '2026-09-19',
        cost: 349,
        transactionId: payment.id,
        holder: { toUserId: anchal.id, location: 'Her phone' },
      }),
    );
    expect(created.status).toBe(201);
    const asset = (await getJson<Record<string, any>>(created))!;
    expect(asset).toMatchObject({ status: 'IN_USE', holder: { kind: 'user', name: 'Anchal', location: 'Her phone' } });

    // One payment buys one asset.
    const twice = await createAsset(
      buildJsonRequest('POST', ASSETS, { name: 'Another', transactionId: payment.id }),
    );
    expect(twice.status).toBe(400);

    // Handover dated before she got it is refused; a real one closes her row.
    const early = await assign(
      buildJsonRequest('POST', `${ASSETS}/${asset.id}/assign`, { toPartyId: tinkal.id, date: '2026-09-01' }),
      buildRouteContext(asset.id),
    );
    expect(early.status).toBe(400);
    const moved = await assign(
      buildJsonRequest('POST', `${ASSETS}/${asset.id}/assign`, { toPartyId: tinkal.id, date: '2026-09-25' }),
      buildRouteContext(asset.id),
    );
    expect(moved.status).toBe(200);
    const back = await assign(
      buildJsonRequest('POST', `${ASSETS}/${asset.id}/assign`, { date: '2026-09-28', location: 'Office drawer' }),
      buildRouteContext(asset.id),
    );
    expect(await getJson(back)).toMatchObject({ status: 'IN_STOCK', holder: { kind: 'company', location: 'Office drawer' } });

    const detail = (await getJson<Record<string, any>>(await getAsset(buildJsonRequest('GET', `${ASSETS}/${asset.id}`), buildRouteContext(asset.id))))!;
    expect(detail.assignments.map((a: any) => [a.toUser?.name ?? a.toParty?.name ?? 'company', a.toDate !== null])).toEqual([
      ['company', false],
      ['Tinkal', true],
      ['Anchal', true],
    ]);

    // Filter by holder.
    const withAnchal = await listAssets(buildJsonRequest('GET', `${ASSETS}?holder=user:${anchal.id}`));
    expect((await getJson<{ items: unknown[] }>(withAnchal))!.items).toHaveLength(0);

    // Sold: nobody holds it any more.
    const sold = await patchAsset(
      buildJsonRequest('PATCH', `${ASSETS}/${asset.id}`, { status: 'SOLD' }),
      buildRouteContext(asset.id),
    );
    expect(await getJson(sold)).toMatchObject({ status: 'SOLD', holder: { kind: 'company' } });
    expect(await prisma.assetAssignment.count({ where: { assetId: asset.id, toDate: null } })).toBe(0);

    // The money never moved.
    expect(await prisma.financeTransaction.count()).toBe(1);
  });

  it('the accountant can read the register but not change it', async () => {
    await setup();
    const { user } = await createTestUser({ role: 'ACCOUNTANT', email: 'ca@example.com' });
    await setSession({ userId: user.id, role: 'ACCOUNTANT' });
    expect((await listAssets(buildJsonRequest('GET', ASSETS))).status).toBe(200);
    expect((await createAsset(buildJsonRequest('POST', ASSETS, { name: 'Laptop' }))).status).toBe(403);
  });
});

describe('dues and position', () => {
  it('shows the card bill already generated, not the one still running', async () => {
    const { user, bank } = await setup();
    const shubham = await prisma.financeParty.create({
      data: { name: 'Shubham', type: 'CARD_OWNER', createdById: user.id },
    });
    const axis = await prisma.financeAccount.create({
      data: {
        name: 'SHUBHAM-AXIS-BANK-CREDIT-CARD',
        type: 'CREDIT_CARD',
        ownerPartyId: shubham.id,
        creditLimit: 60000,
        billingDay: 15,
        dueDay: 2,
      },
    });
    // Before the 15 Sep statement: billed. After it: next cycle.
    await post({ date: '2026-09-06', direction: 'OUT', category: 'UTILITIES', amount: 727, accountId: axis.id });
    await post({ date: '2026-09-18', direction: 'OUT', category: 'ADS', amount: 10000, accountId: axis.id });

    const today = new Date('2026-09-29T12:00:00Z');
    const dues = await loadDues(prisma, today);
    const bill = dues.find((d) => d.kind === 'CARD_BILL')!;
    expect(bill).toMatchObject({ amount: 727, status: 'DUE_SOON' });
    expect(bill.dueDate!.toISOString().slice(0, 10)).toBe('2026-10-02');

    // Paying it after the statement clears that bill.
    await post({
      date: '2026-09-30',
      direction: 'OUT',
      category: 'CARD_REPAYMENT',
      amount: 727,
      partyId: shubham.id,
      accountId: bank.id,
      settlesAccountId: axis.id,
    });
    const after = await loadDues(prisma, new Date('2026-10-01T12:00:00Z'));
    expect(after.find((d) => d.kind === 'CARD_BILL')).toMatchObject({ status: 'DONE', amount: 0 });

    // After that ₹727 left the bank for the card: cash and debt both drop, net stays.
    const position = await loadPosition(prisma, today);
    expect(position.cash).toBe(4369.82);
    expect(position.owed).toBe(10000);
    expect(position.net).toBe(-5630.18);
  });

  it('flags a GST return filed without the ITC claimed', async () => {
    const { user, bank } = await setup();
    await post({ date: '2026-08-10', direction: 'IN', category: 'SALES', amount: 1000, accountId: bank.id });
    await prisma.gstReturn.create({
      data: { month: '2026-08', itcUsed: 18012, cashPaid: 4279, createdById: user.id },
    });
    const dues = await loadDues(prisma, new Date('2026-09-29T12:00:00Z'));
    const aug = dues.find((d) => d.key === 'gst-2026-08')!;
    expect(aug.status).toBe('DUE_SOON');
    expect(aug.detail).toMatch(/ITC claimed is not entered/);
    expect(dues.find((d) => d.key === 'gst-2026-09')).toMatchObject({ status: 'UPCOMING', amount: null });
  });
});
