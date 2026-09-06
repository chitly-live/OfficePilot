/**
 * Integration tests for credit-card limits, billing cycles and settlements:
 *
 *   PATCH /api/finance/accounts/[id]    — creditLimit / billingDay / dueDay
 *   POST  /api/finance/transactions     — settlesAccountId validation
 *   loadCardOverview                    — outstanding, available, cycle, due
 */

import { describe, expect, it } from 'vitest';

import { PATCH as patchAccount } from '@/app/api/finance/accounts/[id]/route';
import { POST as createTransaction } from '@/app/api/finance/transactions/route';
import { prisma } from '@/lib/db';
import { loadCardOverview } from '@/lib/finance-cards';

import {
  buildJsonRequest,
  buildRouteContext,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

const ACCOUNTS = 'http://test/api/finance/accounts';
const TXN = 'http://test/api/finance/transactions';

async function setup() {
  const { user } = await createTestUser({ role: 'ADMIN' });
  await setSession({ userId: user.id, role: 'ADMIN' });
  const shubham = await prisma.financeParty.create({
    data: { name: 'Shubham Kumar', type: 'CARD_OWNER', createdById: user.id },
  });
  const rbl = await prisma.financeAccount.create({
    data: { name: 'RBL card', type: 'CREDIT_CARD', ownerPartyId: shubham.id },
  });
  const bank = await prisma.financeAccount.create({ data: { name: 'YES BANK', type: 'BANK' } });
  return { user, shubham, rbl, bank };
}

describe('card fields on accounts', () => {
  it('admin sets limit, statement day and due day; invalid days are rejected', async () => {
    const { rbl } = await setup();
    const ok = await patchAccount(
      buildJsonRequest('PATCH', `${ACCOUNTS}/${rbl.id}`, { creditLimit: 60000, billingDay: 13, dueDay: 1 }),
      buildRouteContext(rbl.id),
    );
    expect(ok.status).toBe(200);
    expect(await getJson(ok)).toMatchObject({ creditLimit: 60000, billingDay: 13, dueDay: 1 });

    const bad = await patchAccount(
      buildJsonRequest('PATCH', `${ACCOUNTS}/${rbl.id}`, { billingDay: 32 }),
      buildRouteContext(rbl.id),
    );
    expect(bad.status).toBe(400);

    const cleared = await patchAccount(
      buildJsonRequest('PATCH', `${ACCOUNTS}/${rbl.id}`, { creditLimit: null }),
      buildRouteContext(rbl.id),
    );
    expect(cleared.status).toBe(200);
    expect(await getJson(cleared)).toMatchObject({ creditLimit: null, billingDay: 13 });
  });
});

describe('settlesAccountId on repayments', () => {
  it('accepts a credit card, rejects a bank account or an unknown id', async () => {
    const { shubham, rbl, bank } = await setup();
    const base = {
      date: '2026-08-26',
      direction: 'OUT',
      category: 'CARD_REPAYMENT',
      amount: 20000,
      partyId: shubham.id,
      accountId: bank.id,
    };
    const ok = await createTransaction(buildJsonRequest('POST', TXN, { ...base, settlesAccountId: rbl.id }));
    expect(ok.status).toBe(201);
    expect((await getJson<{ settlesAccount: { name: string } }>(ok))!.settlesAccount.name).toBe('RBL card');

    const notCard = await createTransaction(buildJsonRequest('POST', TXN, { ...base, settlesAccountId: bank.id }));
    expect(notCard.status).toBe(400);
    expect((await getJson<{ message: string }>(notCard))!.message).toMatch(/credit card/i);

    const unknown = await createTransaction(buildJsonRequest('POST', TXN, { ...base, settlesAccountId: 'nope' }));
    expect(unknown.status).toBe(400);
  });
});

describe('loadCardOverview', () => {
  it('computes outstanding, available, current cycle and due date per card', async () => {
    const { user, shubham, rbl, bank } = await setup();
    await prisma.financeAccount.update({
      where: { id: rbl.id },
      data: { creditLimit: 60000, billingDay: 13, dueDay: 1 },
    });
    const mk = (date: string, category: string, amount: number, extra: object) =>
      prisma.financeTransaction.create({
        data: {
          date: new Date(`${date}T00:00:00.000Z`),
          direction: 'OUT',
          category: category as never,
          amount,
          createdById: user.id,
          ...extra,
        },
      });
    await mk('2026-08-07', 'ADS', 12000, { accountId: rbl.id });          // previous cycle
    await mk('2026-08-20', 'ADS', 30000, { accountId: rbl.id });          // current cycle (14 Aug – 13 Sep)
    await mk('2026-08-26', 'CARD_REPAYMENT', 20000, { accountId: bank.id, partyId: shubham.id, settlesAccountId: rbl.id });
    await mk('2026-09-01', 'CARD_REPAYMENT', 5000, { accountId: bank.id, partyId: shubham.id }); // not attributed to a card

    const [card] = await loadCardOverview(prisma, new Date('2026-09-06T00:00:00.000Z'));
    expect(card.name).toBe('RBL card');
    expect(card.ownerName).toBe('Shubham Kumar');
    expect(card.position).toMatchObject({ spend: 42000, repaid: 20000, outstanding: 22000, available: 38000, cycleSpend: 30000, cycleRepaid: 20000 });
    expect(card.health).toBe('OK');
    expect(card.cycle!.from.toISOString().slice(0, 10)).toBe('2026-08-14');
    expect(card.cycle!.statementDate.toISOString().slice(0, 10)).toBe('2026-09-13');
    expect(card.cycle!.dueDate!.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(card.daysToDue).toBe(25);
  });
});
