/**
 * Integration tests for employee salary support:
 *
 *   PATCH /api/users/[id]            — monthlySalary / salaryLabel (admin-only)
 *   POST  /api/users/[id]/finance-party — find-or-create the EMPLOYEE party
 *
 * Plus the salary loaders that the employee page and Finance overview use.
 */

import { describe, expect, it } from 'vitest';

import { POST as ensureParty } from '@/app/api/users/[id]/finance-party/route';
import { PATCH as patchUser } from '@/app/api/users/[id]/route';
import { prisma } from '@/lib/db';
import { loadEmployeeSalary, loadSalaryBoard } from '@/lib/finance-employee';

import {
  buildJsonRequest,
  buildRouteContext,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

const USERS = 'http://test/api/users';

describe('salary fields on PATCH /api/users/[id]', () => {
  it('admin can set and clear monthlySalary / salaryLabel', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: intern } = await createTestUser({ role: 'EMPLOYEE', name: 'Anchal' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const set = await patchUser(
      buildJsonRequest('PATCH', `${USERS}/${intern.id}`, { monthlySalary: 5000, salaryLabel: 'Intern stipend' }),
      buildRouteContext(intern.id),
    );
    expect(set.status).toBe(200);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: intern.id } });
    expect(stored.monthlySalary).toBe(5000);
    expect(stored.salaryLabel).toBe('Intern stipend');

    const clear = await patchUser(
      buildJsonRequest('PATCH', `${USERS}/${intern.id}`, { monthlySalary: null, salaryLabel: null }),
      buildRouteContext(intern.id),
    );
    expect(clear.status).toBe(200);
    const cleared = await prisma.user.findUniqueOrThrow({ where: { id: intern.id } });
    expect(cleared.monthlySalary).toBeNull();
    expect(cleared.salaryLabel).toBeNull();
  });

  it('an employee cannot set their own salary; negative values are rejected', async () => {
    const { user: intern } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: intern.id, role: 'EMPLOYEE' });
    const self = await patchUser(
      buildJsonRequest('PATCH', `${USERS}/${intern.id}`, { monthlySalary: 99999 }),
      buildRouteContext(intern.id),
    );
    expect(self.status).toBe(403);

    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });
    const negative = await patchUser(
      buildJsonRequest('PATCH', `${USERS}/${intern.id}`, { monthlySalary: -1 }),
      buildRouteContext(intern.id),
    );
    expect(negative.status).toBe(400);
  });
});

describe('POST /api/users/[id]/finance-party', () => {
  it('creates an EMPLOYEE party linked to the user once, then returns it', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: intern } = await createTestUser({ role: 'EMPLOYEE', name: 'Anchal', email: 'anchal@test.local' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const first = await ensureParty(buildJsonRequest('POST', `${USERS}/${intern.id}/finance-party`), buildRouteContext(intern.id));
    expect(first.status).toBe(201);
    const created = await getJson<{ id: string; name: string; created: boolean }>(first);
    expect(created).toMatchObject({ name: 'Anchal', created: true });

    const party = await prisma.financeParty.findUniqueOrThrow({ where: { id: created!.id } });
    expect(party.type).toBe('EMPLOYEE');
    expect(party.userId).toBe(intern.id);
    expect(party.email).toBe('anchal@test.local');

    const second = await ensureParty(buildJsonRequest('POST', `${USERS}/${intern.id}/finance-party`), buildRouteContext(intern.id));
    expect(second.status).toBe(200);
    expect((await getJson<{ id: string; created: boolean }>(second))).toMatchObject({ id: created!.id, created: false });
    expect(await prisma.financeParty.count({ where: { userId: intern.id } })).toBe(1);
  });

  it('is admin-only and 404s for unknown users', async () => {
    const { user: intern } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: intern.id, role: 'EMPLOYEE' });
    expect((await ensureParty(buildJsonRequest('POST', `${USERS}/${intern.id}/finance-party`), buildRouteContext(intern.id))).status).toBe(403);

    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });
    expect((await ensureParty(buildJsonRequest('POST', `${USERS}/nope/finance-party`), buildRouteContext('nope'))).status).toBe(404);
  });
});

describe('salary loaders', () => {
  it('report per-month status from SALARY payouts against the linked party', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: intern } = await createTestUser({ role: 'EMPLOYEE', name: 'Anchal' });
    await prisma.user.update({
      where: { id: intern.id },
      data: { monthlySalary: 5000, salaryLabel: 'Intern stipend', joinedAt: new Date('2026-07-15T00:00:00.000Z') },
    });
    const party = await prisma.financeParty.create({
      data: { name: 'Anchal', type: 'EMPLOYEE', userId: intern.id, createdById: admin.id },
    });
    const bank = await prisma.financeAccount.create({ data: { name: 'YES BANK', type: 'BANK' } });
    await prisma.financeTransaction.create({
      data: {
        date: new Date('2026-09-02T00:00:00.000Z'),
        direction: 'OUT',
        category: 'SALARY',
        amount: 5000,
        partyId: party.id,
        accountId: bank.id,
        description: 'Intern stipend — August 2026',
        createdById: admin.id,
      },
    });

    const now = new Date('2026-09-06T00:00:00.000Z');
    const salary = await loadEmployeeSalary(prisma, intern.id, now);
    expect(salary).not.toBeNull();
    expect(salary!.partyId).toBe(party.id);
    expect(salary!.totalPaid).toBe(5000);
    expect(salary!.currentMonth).toBe('2026-09');
    expect(salary!.currentStatus).toBe('PAID');
    expect(salary!.timeline.map((l) => `${l.month}:${l.status}`)).toEqual([
      '2026-09:PAID',
      '2026-08:PENDING',
      '2026-07:PENDING',
    ]);

    const board = await loadSalaryBoard(prisma, '2026-09');
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]).toMatchObject({ userId: intern.id, partyId: party.id, monthlySalary: 5000, paid: 5000, status: 'PAID' });
    expect(board.expectedTotal).toBe(5000);

    const august = await loadSalaryBoard(prisma, '2026-08');
    expect(august.rows[0]).toMatchObject({ paid: 0, status: 'PENDING' });
  });
});
