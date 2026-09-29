/**
 * Integration tests for role and module access inside the route handlers —
 * the layer that still holds if a request ever reaches a route without the
 * middleware in front of it:
 *
 *   • module APIs refuse an employee without the module, and the accountant
 *   • AI insights are admin-only
 *   • a campaign's linked leads hide contact details without the Leads module
 *   • changing a user's role or modules revokes their current sessions
 */

import { describe, expect, it } from 'vitest';

import { GET as getInsights } from '@/app/api/ai/insights/route';
import { GET as getCampaignLeads } from '@/app/api/campaigns/[id]/leads/route';
import { GET as listDevTasks } from '@/app/api/dev/tasks/route';
import { GET as listLeads } from '@/app/api/leads/route';
import { PATCH as patchUser } from '@/app/api/users/[id]/route';
import { prisma } from '@/lib/db';

import { buildJsonRequest, buildRouteContext, createTestUser, getJson, setSession } from './helpers';

describe('module APIs check the module themselves', () => {
  it('an employee without Leads gets 403 module_access_denied; with it, 200', async () => {
    const { user } = await createTestUser({ role: 'EMPLOYEE' });

    await setSession({ userId: user.id, role: 'EMPLOYEE', moduleAccess: ['dashboard', 'dev'] });
    const denied = await listLeads(buildJsonRequest('GET', 'http://test/api/leads'));
    expect(denied.status).toBe(403);
    expect(await getJson(denied)).toMatchObject({ error: 'module_access_denied', module: 'leads' });
    expect((await listDevTasks(buildJsonRequest('GET', 'http://test/api/dev/tasks'))).status).toBe(200);

    await setSession({ userId: user.id, role: 'EMPLOYEE', moduleAccess: ['leads'] });
    expect((await listLeads(buildJsonRequest('GET', 'http://test/api/leads'))).status).toBe(200);

    // Legacy employee (empty whitelist) keeps everything.
    await setSession({ userId: user.id, role: 'EMPLOYEE', moduleAccess: [] });
    expect((await listLeads(buildJsonRequest('GET', 'http://test/api/leads'))).status).toBe(200);
  });

  it('the accountant is refused every work module', async () => {
    const { user } = await createTestUser({ role: 'ACCOUNTANT' });
    await setSession({ userId: user.id, role: 'ACCOUNTANT' });
    expect((await listLeads(buildJsonRequest('GET', 'http://test/api/leads'))).status).toBe(403);
    expect((await listDevTasks(buildJsonRequest('GET', 'http://test/api/dev/tasks'))).status).toBe(403);
  });
});

describe('AI insights', () => {
  it('are for the admin only', async () => {
    const { user } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: user.id, role: 'EMPLOYEE', moduleAccess: [] });
    expect((await getInsights(buildJsonRequest('GET', 'http://test/api/ai/insights'))).status).toBe(403);

    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });
    expect((await getInsights(buildJsonRequest('GET', 'http://test/api/ai/insights'))).status).toBe(200);
  });
});

describe("a campaign's linked leads", () => {
  it('hide contact details from an employee without the Leads module', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const campaign = await prisma.campaign.create({
      data: {
        name: 'Diwali push',
        channel: 'META_ADS',
        startDate: new Date('2026-09-01T00:00:00Z'),
        budget: 10000,
        ownerId: admin.id,
        utmCampaign: 'diwali',
      },
    });
    await prisma.lead.create({
      data: {
        name: 'Priya',
        phone: '+91 98765 43210',
        email: 'priya@example.com',
        utmCampaign: 'diwali',
        createdById: admin.id,
      },
    });
    const url = `http://test/api/campaigns/${campaign.id}/leads`;

    const { user: marketer } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: marketer.id, role: 'EMPLOYEE', moduleAccess: ['marketing'] });
    const masked = (await getJson<{ items: Record<string, unknown>[] }>(
      await getCampaignLeads(buildJsonRequest('GET', url), buildRouteContext(campaign.id)),
    ))!;
    expect(masked.items[0]).toMatchObject({ name: 'Priya', phone: null, email: null });

    await setSession({ userId: marketer.id, role: 'EMPLOYEE', moduleAccess: ['marketing', 'leads'] });
    const full = (await getJson<{ items: Record<string, unknown>[] }>(
      await getCampaignLeads(buildJsonRequest('GET', url), buildRouteContext(campaign.id)),
    ))!;
    expect(full.items[0]).toMatchObject({ phone: '+91 98765 43210', email: 'priya@example.com' });
  });
});

describe('changing permissions ends the current sessions', () => {
  it('stamps sessionsRevokedAt on a role or module change, not on a name change', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: emp } = await createTestUser({ role: 'EMPLOYEE' });
    await prisma.user.update({ where: { id: emp.id }, data: { moduleAccess: ['dashboard', 'leads'] } });
    await setSession({ userId: admin.id, role: 'ADMIN' });
    const patch = (body: Record<string, unknown>) =>
      patchUser(buildJsonRequest('PATCH', `http://test/api/users/${emp.id}`, body), buildRouteContext(emp.id));
    const revokedAt = async () =>
      (await prisma.user.findUniqueOrThrow({ where: { id: emp.id }, select: { sessionsRevokedAt: true } }))
        .sessionsRevokedAt;

    expect((await patch({ name: 'Renamed' })).status).toBe(200);
    expect(await revokedAt()).toBeNull();

    // Same modules in another order: no change, no revocation.
    expect((await patch({ moduleAccess: ['leads', 'dashboard'] })).status).toBe(200);
    expect(await revokedAt()).toBeNull();

    expect((await patch({ moduleAccess: ['dashboard'] })).status).toBe(200);
    const first = await revokedAt();
    expect(first).toBeInstanceOf(Date);

    expect((await patch({ role: 'ACCOUNTANT' })).status).toBe(200);
    expect((await revokedAt())!.getTime()).toBeGreaterThanOrEqual(first!.getTime());
  });
});
