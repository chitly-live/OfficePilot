/**
 * Integration tests for routed payments (`viaPartyId`): the bank pays an
 * intermediary who passes the money on to the real party.
 *
 *   bank → Ritu → Shubham   ⇒ party = Shubham (gets the credit),
 *                              viaParty = Ritu (route only, no balance effect)
 *
 * Covers create / update validation, list filtering & search by the
 * intermediary, and that balances land on the real party only.
 */

import { describe, expect, it } from 'vitest';

import { GET as getParty } from '@/app/api/finance/parties/[id]/route';
import { GET as listParties } from '@/app/api/finance/parties/route';
import {
  GET as listTransactions,
  POST as createTransaction,
} from '@/app/api/finance/transactions/route';
import { PATCH as patchTransaction } from '@/app/api/finance/transactions/[id]/route';
import { prisma } from '@/lib/db';

import {
  buildJsonRequest,
  buildRouteContext,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

const TXN = 'http://test/api/finance/transactions';
const PARTIES = 'http://test/api/finance/parties';

async function setup() {
  const { user } = await createTestUser({ role: 'ADMIN' });
  await setSession({ userId: user.id, role: 'ADMIN' });
  const shubham = await prisma.financeParty.create({
    data: { name: 'Shubham Kumar', type: 'CARD_OWNER', createdById: user.id },
  });
  const ritu = await prisma.financeParty.create({
    data: { name: 'Ritu Kumari', type: 'INTERMEDIARY', createdById: user.id },
  });
  const bank = await prisma.financeAccount.create({
    data: { name: 'YES BANK', type: 'BANK' },
  });
  return { user, shubham, ritu, bank };
}

describe('routed payments — create', () => {
  it('records the real party and the intermediary separately', async () => {
    const { shubham, ritu, bank } = await setup();
    const res = await createTransaction(
      buildJsonRequest('POST', TXN, {
        date: '2026-08-26',
        direction: 'OUT',
        category: 'CARD_REPAYMENT',
        amount: 20000,
        partyId: shubham.id,
        viaPartyId: ritu.id,
        accountId: bank.id,
        description: 'Card bill via Ritu',
      }),
    );
    expect(res.status).toBe(201);
    const body = await getJson<{
      party: { name: string };
      viaParty: { id: string; name: string; type: string };
      viaPartyId: string;
    }>(res);
    expect(body!.party.name).toBe('Shubham Kumar');
    expect(body!.viaParty).toMatchObject({ id: ritu.id, name: 'Ritu Kumari', type: 'INTERMEDIARY' });
    expect(body!.viaPartyId).toBe(ritu.id);

    const log = await prisma.activityLog.findFirst({ where: { action: 'finance.transaction_created' } });
    expect((log!.metadata as { viaPartyName?: string }).viaPartyName).toBe('Ritu Kumari');
  });

  it('rejects an intermediary equal to the party, and an unknown intermediary', async () => {
    const { shubham } = await setup();
    const same = await createTransaction(
      buildJsonRequest('POST', TXN, {
        date: '2026-08-26',
        direction: 'OUT',
        category: 'CARD_REPAYMENT',
        amount: 100,
        partyId: shubham.id,
        viaPartyId: shubham.id,
      }),
    );
    expect(same.status).toBe(400);

    const unknown = await createTransaction(
      buildJsonRequest('POST', TXN, {
        date: '2026-08-26',
        direction: 'OUT',
        category: 'CARD_REPAYMENT',
        amount: 100,
        partyId: shubham.id,
        viaPartyId: 'nope',
      }),
    );
    expect(unknown.status).toBe(400);
    expect((await getJson<{ message: string }>(unknown))!.message).toMatch(/routed-via party not found/i);
  });
});

describe('routed payments — balances, filters, search', () => {
  it('credits only the real party; the intermediary shows nothing paid or owed', async () => {
    const { shubham, ritu, bank } = await setup();
    // Spend on Shubham's card, then repay him through Ritu.
    const card = await prisma.financeAccount.create({
      data: { name: 'Shubham card', type: 'CREDIT_CARD', ownerPartyId: shubham.id },
    });
    const mk = (data: object) =>
      createTransaction(buildJsonRequest('POST', TXN, data)).then((r) => expect(r.status).toBe(201));
    await mk({ date: '2026-08-13', direction: 'OUT', category: 'ADS', amount: 30000, accountId: card.id });
    await mk({ date: '2026-08-26', direction: 'OUT', category: 'CARD_REPAYMENT', amount: 20000, partyId: shubham.id, viaPartyId: ritu.id, accountId: bank.id });
    await mk({ date: '2026-08-29', direction: 'OUT', category: 'CARD_REPAYMENT', amount: 5000, partyId: shubham.id, accountId: bank.id });

    const shubhamRes = await getParty(buildJsonRequest('GET', `${PARTIES}/${shubham.id}`), buildRouteContext(shubham.id));
    const shubhamBody = await getJson<{ balance: { cardSpend: number; cardRepaid: number; owed: number; paidTo: number } }>(shubhamRes);
    expect(shubhamBody!.balance).toMatchObject({ cardSpend: 30000, cardRepaid: 25000, owed: 5000, paidTo: 25000 });

    const rituRes = await getParty(buildJsonRequest('GET', `${PARTIES}/${ritu.id}`), buildRouteContext(ritu.id));
    const rituBody = await getJson<{ balance: { paidTo: number; owed: number } }>(rituRes);
    expect(rituBody!.balance).toMatchObject({ paidTo: 0, owed: 0 });

    // Filtering by the intermediary still surfaces the routed row…
    const viaList = await getJson<{ total: number; items: Array<{ viaParty: { name: string } | null }> }>(
      await listTransactions(buildJsonRequest('GET', `${TXN}?month=2026-08&partyId=${ritu.id}`)),
    );
    expect(viaList!.total).toBe(1);
    expect(viaList!.items[0].viaParty?.name).toBe('Ritu Kumari');

    // …and by the real party surfaces both repayments.
    const partyList = await getJson<{ total: number }>(
      await listTransactions(buildJsonRequest('GET', `${TXN}?month=2026-08&partyId=${shubham.id}`)),
    );
    expect(partyList!.total).toBe(2);

    // Search by the intermediary's name.
    const search = await getJson<{ total: number }>(
      await listTransactions(buildJsonRequest('GET', `${TXN}?month=2026-08&search=ritu`)),
    );
    expect(search!.total).toBe(1);

    // Parties list balance stays clean for the intermediary.
    const parties = await getJson<{ items: Array<{ id: string; balance: { paidTo: number } }> }>(
      await listParties(buildJsonRequest('GET', PARTIES)),
    );
    expect(parties!.items.find((p) => p.id === ritu.id)?.balance.paidTo).toBe(0);
  });
});

describe('routed payments — update', () => {
  it('can set and clear the intermediary, but never equal to the party', async () => {
    const { shubham, ritu, bank } = await setup();
    const created = await getJson<{ id: string }>(
      await createTransaction(
        buildJsonRequest('POST', TXN, {
          date: '2026-08-26',
          direction: 'OUT',
          category: 'CARD_REPAYMENT',
          amount: 20000,
          partyId: shubham.id,
          accountId: bank.id,
        }),
      ),
    );
    const id = created!.id;

    const set = await patchTransaction(
      buildJsonRequest('PATCH', `${TXN}/${id}`, { viaPartyId: ritu.id }),
      buildRouteContext(id),
    );
    expect(set.status).toBe(200);
    expect((await getJson<{ viaParty: { name: string } }>(set))!.viaParty.name).toBe('Ritu Kumari');

    const same = await patchTransaction(
      buildJsonRequest('PATCH', `${TXN}/${id}`, { viaPartyId: shubham.id }),
      buildRouteContext(id),
    );
    expect(same.status).toBe(400);

    // Changing the party to the current intermediary is also refused.
    const swap = await patchTransaction(
      buildJsonRequest('PATCH', `${TXN}/${id}`, { partyId: ritu.id }),
      buildRouteContext(id),
    );
    expect(swap.status).toBe(400);

    const clear = await patchTransaction(
      buildJsonRequest('PATCH', `${TXN}/${id}`, { viaPartyId: null }),
      buildRouteContext(id),
    );
    expect(clear.status).toBe(200);
    expect((await getJson<{ viaParty: unknown }>(clear))!.viaParty).toBeNull();
  });
});
