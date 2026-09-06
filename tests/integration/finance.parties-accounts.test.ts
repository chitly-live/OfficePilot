/**
 * Integration tests for Finance parties, accounts and the summary:
 *
 *   GET/POST      /api/finance/parties
 *   GET/PATCH/DEL /api/finance/parties/[id]
 *   GET/POST      /api/finance/accounts
 *   GET/PATCH/DEL /api/finance/accounts/[id]
 *   GET           /api/finance/summary
 *
 * The important behaviour here is the outstanding balance: a
 * financer is owed loans minus repayments; a card owner is owed the
 * spend routed through their card minus what we settled with them.
 */

import { describe, expect, it } from 'vitest';

import {
  GET as listAccounts,
  POST as createAccount,
} from '@/app/api/finance/accounts/route';
import {
  DELETE as deleteAccount,
  PATCH as patchAccount,
} from '@/app/api/finance/accounts/[id]/route';
import {
  GET as listParties,
  POST as createParty,
} from '@/app/api/finance/parties/route';
import {
  DELETE as deleteParty,
  GET as getParty,
  PATCH as patchParty,
} from '@/app/api/finance/parties/[id]/route';
import { GET as getSummary } from '@/app/api/finance/summary/route';
import { prisma } from '@/lib/db';

import {
  buildJsonRequest,
  buildRouteContext,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

const PARTIES = 'http://test/api/finance/parties';
const ACCOUNTS = 'http://test/api/finance/accounts';
const SUMMARY = 'http://test/api/finance/summary';

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
  },
) {
  return prisma.financeTransaction.create({
    data: {
      date: new Date(`${data.date}T00:00:00.000Z`),
      direction: data.direction,
      category: data.category as never,
      amount: data.amount,
      partyId: data.partyId,
      accountId: data.accountId,
      createdById,
    },
  });
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

describe('/api/finance/parties', () => {
  it('gates on admin', async () => {
    await setSession(null);
    expect((await listParties(buildJsonRequest('GET', PARTIES))).status).toBe(401);

    const { user } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: user.id, role: 'EMPLOYEE' });
    expect((await listParties(buildJsonRequest('GET', PARTIES))).status).toBe(403);
    expect(
      (await createParty(buildJsonRequest('POST', PARTIES, { name: 'X' }))).status,
    ).toBe(403);
  });

  it('creates a party (defaults + normalisation) and audits it', async () => {
    const admin = await asAdmin();
    const res = await createParty(
      buildJsonRequest('POST', PARTIES, {
        name: '  Rahul Financer ',
        type: 'FINANCER',
        email: 'Rahul@Example.COM',
        phone: '+91 98765 43210',
      }),
    );
    expect(res.status).toBe(201);
    const body = await getJson<{
      id: string;
      name: string;
      type: string;
      email: string;
      isActive: boolean;
    }>(res);
    expect(body).toMatchObject({
      name: 'Rahul Financer',
      type: 'FINANCER',
      email: 'rahul@example.com',
      isActive: true,
    });

    const log = await prisma.activityLog.findFirst({
      where: { action: 'finance.party_created', entityId: body!.id },
    });
    expect(log?.userId).toBe(admin.id);
  });

  it('rejects an empty name and a bad email', async () => {
    await asAdmin();
    expect(
      (await createParty(buildJsonRequest('POST', PARTIES, { name: '   ' }))).status,
    ).toBe(400);
    expect(
      (
        await createParty(
          buildJsonRequest('POST', PARTIES, { name: 'A', email: 'not-an-email' }),
        )
      ).status,
    ).toBe(400);
  });

  it('lists with balances: financer owed = loan − repaid; card owner owed = card spend − settled', async () => {
    const admin = await asAdmin();
    const financer = await prisma.financeParty.create({
      data: { name: 'Financer', type: 'FINANCER', createdById: admin.id },
    });
    const cardOwner = await prisma.financeParty.create({
      data: { name: 'Card Owner', type: 'CARD_OWNER', createdById: admin.id },
    });
    const card = await prisma.financeAccount.create({
      data: { name: "Owner's card", type: 'CREDIT_CARD', ownerPartyId: cardOwner.id },
    });

    await seedTxn(admin.id, { date: '2026-08-01', direction: 'IN', category: 'LOAN_RECEIVED', amount: 50000, partyId: financer.id });
    await seedTxn(admin.id, { date: '2026-08-20', direction: 'OUT', category: 'LOAN_REPAYMENT', amount: 10000, partyId: financer.id });
    await seedTxn(admin.id, { date: '2026-08-07', direction: 'OUT', category: 'ADS', amount: 6000, accountId: card.id });
    await seedTxn(admin.id, { date: '2026-08-13', direction: 'OUT', category: 'ADS', amount: 12000, accountId: card.id });
    await seedTxn(admin.id, { date: '2026-08-25', direction: 'OUT', category: 'CARD_REPAYMENT', amount: 5000, partyId: cardOwner.id });

    const res = await listParties(buildJsonRequest('GET', PARTIES));
    expect(res.status).toBe(200);
    const body = await getJson<{
      items: Array<{ id: string; balance: { owed: number; loanOutstanding: number; cardOutstanding: number } }>;
      total: number;
    }>(res);
    expect(body!.total).toBe(2);
    const byId = new Map(body!.items.map((p) => [p.id, p.balance]));
    expect(byId.get(financer.id)).toMatchObject({ owed: 40000, loanOutstanding: 40000, cardOutstanding: 0 });
    expect(byId.get(cardOwner.id)).toMatchObject({ owed: 13000, loanOutstanding: 0, cardOutstanding: 13000 });

    // Detail endpoint returns the same balance.
    const detail = await getParty(
      buildJsonRequest('GET', `${PARTIES}/${cardOwner.id}`),
      buildRouteContext(cardOwner.id),
    );
    expect(detail.status).toBe(200);
    expect((await getJson<{ balance: { owed: number } }>(detail))!.balance.owed).toBe(13000);

    // Filters.
    const onlyFinancers = await getJson<{ total: number }>(
      await listParties(buildJsonRequest('GET', `${PARTIES}?type=FINANCER`)),
    );
    expect(onlyFinancers!.total).toBe(1);
    const search = await getJson<{ total: number }>(
      await listParties(buildJsonRequest('GET', `${PARTIES}?search=card`)),
    );
    expect(search!.total).toBe(1);
  });

  it('PATCH updates and can clear phone; DELETE is 409 while referenced, 200/204 after', async () => {
    const admin = await asAdmin();
    const party = await prisma.financeParty.create({
      data: { name: 'Host', type: 'WORKER', phone: '123', createdById: admin.id },
    });

    const patched = await patchParty(
      buildJsonRequest('PATCH', `${PARTIES}/${party.id}`, { phone: null, isActive: false }),
      buildRouteContext(party.id),
    );
    expect(patched.status).toBe(200);
    expect(await getJson(patched)).toMatchObject({ phone: null, isActive: false });

    const txn = await seedTxn(admin.id, { date: '2026-08-07', direction: 'OUT', category: 'PAYOUT', amount: 701, partyId: party.id });

    const blocked = await deleteParty(
      buildJsonRequest('DELETE', `${PARTIES}/${party.id}`),
      buildRouteContext(party.id),
    );
    expect(blocked.status).toBe(409);
    expect(await getJson(blocked)).toMatchObject({ error: 'conflict', transactions: 1 });

    await prisma.financeTransaction.delete({ where: { id: txn.id } });
    const ok = await deleteParty(
      buildJsonRequest('DELETE', `${PARTIES}/${party.id}`),
      buildRouteContext(party.id),
    );
    expect([200, 204]).toContain(ok.status);
    expect(await prisma.financeParty.findUnique({ where: { id: party.id } })).toBeNull();

    const missing = await getParty(
      buildJsonRequest('GET', `${PARTIES}/${party.id}`),
      buildRouteContext(party.id),
    );
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

describe('/api/finance/accounts', () => {
  it('creates an account owned by a party, rejects an unknown owner', async () => {
    const admin = await asAdmin();
    const owner = await prisma.financeParty.create({
      data: { name: 'Card Owner', type: 'CARD_OWNER', createdById: admin.id },
    });

    const res = await createAccount(
      buildJsonRequest('POST', ACCOUNTS, {
        name: 'ICICI card',
        type: 'CREDIT_CARD',
        ownerPartyId: owner.id,
      }),
    );
    expect(res.status).toBe(201);
    const body = await getJson<{ id: string; ownerParty: { id: string; name: string } | null; openingBalance: number }>(res);
    expect(body!.ownerParty?.name).toBe('Card Owner');
    expect(body!.openingBalance).toBe(0);

    const bad = await createAccount(
      buildJsonRequest('POST', ACCOUNTS, { name: 'X', ownerPartyId: 'nope' }),
    );
    expect(bad.status).toBe(400);
  });

  it('lists with balance = opening + in − out', async () => {
    const admin = await asAdmin();
    const bank = await prisma.financeAccount.create({
      data: { name: 'HDFC', type: 'BANK', openingBalance: 10000 },
    });
    await seedTxn(admin.id, { date: '2026-08-01', direction: 'IN', category: 'SALES', amount: 40000, accountId: bank.id });
    await seedTxn(admin.id, { date: '2026-08-02', direction: 'OUT', category: 'ADS', amount: 6000, accountId: bank.id });

    const res = await listAccounts(buildJsonRequest('GET', ACCOUNTS));
    expect(res.status).toBe(200);
    const body = await getJson<{ items: Array<{ id: string; balance: number }> }>(res);
    expect(body!.items.find((a) => a.id === bank.id)?.balance).toBe(44000);
  });

  it('PATCH edits; DELETE is 409 while transactions use it', async () => {
    const admin = await asAdmin();
    const acct = await prisma.financeAccount.create({ data: { name: 'Cash', type: 'CASH' } });

    const patched = await patchAccount(
      buildJsonRequest('PATCH', `${ACCOUNTS}/${acct.id}`, { name: 'Cash box', openingBalance: 500 }),
      buildRouteContext(acct.id),
    );
    expect(patched.status).toBe(200);
    expect(await getJson(patched)).toMatchObject({ name: 'Cash box', openingBalance: 500 });

    const txn = await seedTxn(admin.id, { date: '2026-08-07', direction: 'OUT', category: 'OFFICE', amount: 100, accountId: acct.id });
    const blocked = await deleteAccount(
      buildJsonRequest('DELETE', `${ACCOUNTS}/${acct.id}`),
      buildRouteContext(acct.id),
    );
    expect(blocked.status).toBe(409);

    await prisma.financeTransaction.delete({ where: { id: txn.id } });
    const ok = await deleteAccount(
      buildJsonRequest('DELETE', `${ACCOUNTS}/${acct.id}`),
      buildRouteContext(acct.id),
    );
    expect([200, 204]).toContain(ok.status);
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

describe('GET /api/finance/summary', () => {
  it('returns month totals, category breakdown, outstanding and monthly trend', async () => {
    const admin = await asAdmin();
    const financer = await prisma.financeParty.create({
      data: { name: 'Financer', type: 'FINANCER', createdById: admin.id },
    });
    await seedTxn(admin.id, { date: '2026-08-01', direction: 'OUT', category: 'ADS', amount: 70000 });
    await seedTxn(admin.id, { date: '2026-08-12', direction: 'OUT', category: 'SOFTWARE', amount: 29722 });
    await seedTxn(admin.id, { date: '2026-08-16', direction: 'IN', category: 'SALES', amount: 120000 });
    await seedTxn(admin.id, { date: '2026-08-02', direction: 'IN', category: 'LOAN_RECEIVED', amount: 50000, partyId: financer.id });
    // Previous month — only in the trend, not in the window totals.
    await seedTxn(admin.id, { date: '2026-07-15', direction: 'OUT', category: 'ADS', amount: 1000 });

    const res = await getSummary(buildJsonRequest('GET', `${SUMMARY}?month=2026-08`));
    expect(res.status).toBe(200);
    const body = await getJson<{
      totals: { income: number; expense: number; net: number; cashIn: number; cashOut: number };
      expenseByCategory: Array<{ category: string; amount: number }>;
      outstanding: Array<{ partyId: string; owed: number }>;
      monthly: Array<{ month: string; expense: number; income: number }>;
      transactionCount: number;
    }>(res);

    expect(body!.totals).toEqual({
      cashIn: 170000,
      cashOut: 99722,
      income: 120000,
      expense: 99722,
      net: 20278,
    });
    expect(body!.expenseByCategory[0]).toMatchObject({ category: 'ADS', amount: 70000 });
    expect(body!.outstanding).toEqual([
      expect.objectContaining({ partyId: financer.id, owed: 50000 }),
    ]);
    expect(body!.transactionCount).toBe(4);

    const july = body!.monthly.find((m) => m.month === '2026-07');
    const august = body!.monthly.find((m) => m.month === '2026-08');
    expect(july).toMatchObject({ expense: 1000, income: 0 });
    expect(august).toMatchObject({ expense: 99722, income: 120000 });
  });

  it('rejects a malformed month and gates on admin', async () => {
    await asAdmin();
    expect((await getSummary(buildJsonRequest('GET', `${SUMMARY}?month=2026-8`))).status).toBe(400);

    await setSession(null);
    expect((await getSummary(buildJsonRequest('GET', SUMMARY))).status).toBe(401);
  });
});
