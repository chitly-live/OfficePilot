/**
 * Integration tests for the ACCOUNTANT role — read-only Finance.
 *
 *   • Every finance GET (lists, detail, summary, export) → 200
 *   • Every finance write (POST / PATCH / DELETE)        → 403
 *   • Admin-only surfaces (users list, products)         → 403
 *   • Creating a user with role ACCOUNTANT stores an empty moduleAccess
 *
 * Confinement of accountants to `/finance*` for *other* modules' pages
 * and APIs is enforced in `src/middleware.ts`, which these handler-level
 * tests bypass by design.
 */

import { describe, expect, it } from 'vitest';

import { GET as listAccounts, POST as createAccount } from '@/app/api/finance/accounts/route';
import { PATCH as patchAccount } from '@/app/api/finance/accounts/[id]/route';
import { GET as exportReport } from '@/app/api/finance/export/route';
import { GET as listParties, POST as createParty } from '@/app/api/finance/parties/route';
import { DELETE as deleteParty, GET as getParty } from '@/app/api/finance/parties/[id]/route';
import { GET as getSummary } from '@/app/api/finance/summary/route';
import {
  GET as listTransactions,
  POST as createTransaction,
} from '@/app/api/finance/transactions/route';
import {
  DELETE as deleteTransaction,
  GET as getTransaction,
  PATCH as patchTransaction,
} from '@/app/api/finance/transactions/[id]/route';
import { GET as listProducts, POST as createProduct } from '@/app/api/products/route';
import { GET as listUsers, POST as createUser } from '@/app/api/users/route';
import { prisma } from '@/lib/db';

import {
  buildJsonRequest,
  buildRouteContext,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

const FIN = 'http://test/api/finance';

async function seed() {
  const { user: admin } = await createTestUser({ role: 'ADMIN' });
  const party = await prisma.financeParty.create({
    data: { name: 'FACEBOOK ADS', type: 'VENDOR', createdById: admin.id },
  });
  const account = await prisma.financeAccount.create({
    data: { name: 'YES BANK', type: 'BANK', openingBalance: 1000 },
  });
  const txn = await prisma.financeTransaction.create({
    data: {
      date: new Date('2026-09-10T00:00:00.000Z'),
      direction: 'OUT',
      category: 'ADS',
      amount: 5000,
      partyId: party.id,
      accountId: account.id,
      createdById: admin.id,
    },
  });
  return { admin, party, account, txn };
}

async function asAccountant() {
  const { user } = await createTestUser({ role: 'ACCOUNTANT' });
  await setSession({ userId: user.id, role: 'ACCOUNTANT' });
  return user;
}

describe('ACCOUNTANT — can read everything in Finance', () => {
  it('lists, detail, summary and export all return 200', async () => {
    const { party, account, txn } = await seed();
    await asAccountant();

    expect((await listTransactions(buildJsonRequest('GET', `${FIN}/transactions?month=2026-09`))).status).toBe(200);
    expect(
      (await getTransaction(buildJsonRequest('GET', `${FIN}/transactions/${txn.id}`), buildRouteContext(txn.id))).status,
    ).toBe(200);
    expect((await listParties(buildJsonRequest('GET', `${FIN}/parties`))).status).toBe(200);
    expect(
      (await getParty(buildJsonRequest('GET', `${FIN}/parties/${party.id}`), buildRouteContext(party.id))).status,
    ).toBe(200);
    expect((await listAccounts(buildJsonRequest('GET', `${FIN}/accounts`))).status).toBe(200);
    expect((await getSummary(buildJsonRequest('GET', `${FIN}/summary?month=2026-09`))).status).toBe(200);

    const report = await exportReport(buildJsonRequest('GET', `${FIN}/export?format=xlsx&month=2026-09`));
    expect(report.status).toBe(200);
    expect(report.headers.get('content-disposition')).toContain('attachment');
    expect((await report.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    // The row actually shows up in what they read.
    const body = await getJson<{ items: Array<{ id: string }> }>(
      await listTransactions(buildJsonRequest('GET', `${FIN}/transactions?month=2026-09&accountId=${account.id}`)),
    );
    expect(body!.items.map((i) => i.id)).toContain(txn.id);
  });
});

describe('ACCOUNTANT — party contacts are masked', () => {
  it('phone shows the last two digits, email the first three characters; admin sees all', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const party = await prisma.financeParty.create({
      data: {
        name: 'TINKAL ANANDRAO WANKAR',
        type: 'WORKER',
        phone: '+919673072005',
        email: 'twinklwnkr@gmail.com',
        createdById: admin.id,
      },
    });

    await asAccountant();
    const list = await getJson<{ items: Array<{ id: string; phone: string; email: string }> }>(
      await listParties(buildJsonRequest('GET', `${FIN}/parties`)),
    );
    const row = list!.items.find((i) => i.id === party.id)!;
    expect(row.phone).toBe('+XXXXXXXXXX05');
    expect(row.email).toBe('twi***@***.com');

    const detail = await getJson<{ phone: string; email: string }>(
      await getParty(buildJsonRequest('GET', `${FIN}/parties/${party.id}`), buildRouteContext(party.id)),
    );
    expect(detail!.phone).toBe('+XXXXXXXXXX05');
    expect(detail!.email).toBe('twi***@***.com');

    // Searching by digits / email must not find anything for an accountant…
    const probe = await getJson<{ items: unknown[] }>(
      await listParties(buildJsonRequest('GET', `${FIN}/parties?search=9673`)),
    );
    expect(probe!.items).toHaveLength(0);
    // …but by name still works.
    const byName = await getJson<{ items: unknown[] }>(
      await listParties(buildJsonRequest('GET', `${FIN}/parties?search=tinkal`)),
    );
    expect(byName!.items).toHaveLength(1);

    await setSession({ userId: admin.id, role: 'ADMIN' });
    const full = await getJson<{ phone: string; email: string }>(
      await getParty(buildJsonRequest('GET', `${FIN}/parties/${party.id}`), buildRouteContext(party.id)),
    );
    expect(full!.phone).toBe('+919673072005');
    expect(full!.email).toBe('twinklwnkr@gmail.com');
  });
});

describe('ACCOUNTANT — cannot change anything', () => {
  it('finance writes are 403 and leave the ledger untouched', async () => {
    const { party, account, txn } = await seed();
    await asAccountant();

    const before = await prisma.financeTransaction.count();

    expect(
      (
        await createTransaction(
          buildJsonRequest('POST', `${FIN}/transactions`, {
            date: '2026-09-11',
            direction: 'OUT',
            category: 'ADS',
            amount: 10,
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await patchTransaction(
          buildJsonRequest('PATCH', `${FIN}/transactions/${txn.id}`, { amount: 1 }),
          buildRouteContext(txn.id),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await deleteTransaction(buildJsonRequest('DELETE', `${FIN}/transactions/${txn.id}`), buildRouteContext(txn.id))
      ).status,
    ).toBe(403);
    expect(
      (await createParty(buildJsonRequest('POST', `${FIN}/parties`, { name: 'X', type: 'VENDOR' }))).status,
    ).toBe(403);
    expect(
      (await deleteParty(buildJsonRequest('DELETE', `${FIN}/parties/${party.id}`), buildRouteContext(party.id))).status,
    ).toBe(403);
    expect(
      (await createAccount(buildJsonRequest('POST', `${FIN}/accounts`, { name: 'X', type: 'CASH' }))).status,
    ).toBe(403);
    expect(
      (
        await patchAccount(
          buildJsonRequest('PATCH', `${FIN}/accounts/${account.id}`, { name: 'Y' }),
          buildRouteContext(account.id),
        )
      ).status,
    ).toBe(403);

    expect(await prisma.financeTransaction.count()).toBe(before);
    expect((await prisma.financeTransaction.findUnique({ where: { id: txn.id } }))!.amount).toBe(5000);
  });

  it('admin-only surfaces stay closed: users list, product management', async () => {
    await asAccountant();
    expect((await listUsers(buildJsonRequest('GET', 'http://test/api/users'))).status).toBe(403);
    expect(
      (await createProduct(buildJsonRequest('POST', 'http://test/api/products', { name: 'Nope' }))).status,
    ).toBe(403);
    // Reading the product list only needs a session (the header switcher).
    expect((await listProducts()).status).toBe(200);
  });
});

describe('Creating an accountant', () => {
  it('admin can create one; moduleAccess is stored empty', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await createUser(
      buildJsonRequest('POST', 'http://test/api/users', {
        name: 'CA Office',
        email: `ca-${Date.now()}@test.local`,
        password: 'StrongPass123!',
        role: 'ACCOUNTANT',
        moduleAccess: ['leads'],
      }),
    );
    expect(res.status).toBe(201);
    const body = await getJson<{ id: string; role: string; moduleAccess: string[] }>(res);
    expect(body!.role).toBe('ACCOUNTANT');
    expect(body!.moduleAccess).toEqual([]);
  });
});
