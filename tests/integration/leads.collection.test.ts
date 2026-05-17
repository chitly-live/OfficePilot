/**
 * Integration tests for `GET /api/leads` and `POST /api/leads` (task 36).
 *
 * Validates: Requirements 5.3, 5.4, 5.5, 13.1, 13.2, 15.2, 15.3
 * Spec references: SPEC.md §6.3, §6.4, §16.2.
 *
 * Coverage matrix per SPEC §16.2 + task 36 brief:
 *
 *   Endpoint            Happy   401     403         400 (zod)
 *   GET  /api/leads      ✓       ✓       —            ✓ (bad page)
 *   POST /api/leads      ✓       ✓       ✓ (cross-   ✓ (missing
 *                                            assign)     name / no
 *                                                       phone+email)
 *
 * Plus the per-endpoint specifics from the task brief:
 *   - GET filters: status (multi), source (multi), priority (multi),
 *     ownerId, search, tag, dateFrom/dateTo.
 *   - GET pagination: page + pageSize round-tripped through response.
 *   - GET sort: sortBy=created sortDir=asc reorders the list.
 *   - POST: createdById and ownerId set correctly (default = caller).
 *   - POST: employee may NOT cross-assign on creation (403).
 *   - POST: admin may assign to anyone.
 *   - POST: writes a `lead.created` activity log row.
 *
 * Tests construct a `Request` directly and invoke the route handler
 * function — no spinning up a Next server. Per-test DB cleanup happens
 * in `tests/integration/setup.ts`'s `beforeEach(truncateAll)`.
 */

import { describe, expect, it } from 'vitest';
import { LeadSource, LeadStatus, Priority } from '@prisma/client';

import { GET, POST } from '@/app/api/leads/route';
import { prisma } from '@/lib/db';

import {
  buildJsonRequest,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

// ---------------------------------------------------------------------------
// Helpers — local to this file
// ---------------------------------------------------------------------------

/**
 * Insert a Lead row directly via Prisma, bypassing the route handler.
 * Used by GET tests to seed scenarios where the *list* shape is what
 * matters; the create flow is exercised by the POST tests below.
 *
 * Required FK: `createdById` — Lead has no application default. The
 * caller passes a User id; tests typically use the seeded admin's id.
 */
async function seedLead(
  createdById: string,
  overrides: Partial<{
    name: string;
    email: string;
    phone: string;
    company: string;
    source: LeadSource;
    status: LeadStatus;
    priority: Priority;
    ownerId: string | null;
    tags: string[];
    createdAt: Date;
  }> = {},
): Promise<{ id: string }> {
  const lead = await prisma.lead.create({
    data: {
      name: overrides.name ?? 'Seed Lead',
      ...(overrides.email !== undefined ? { email: overrides.email } : {}),
      ...(overrides.phone !== undefined ? { phone: overrides.phone } : {}),
      ...(overrides.company !== undefined ? { company: overrides.company } : {}),
      source: overrides.source ?? LeadSource.MANUAL,
      status: overrides.status ?? LeadStatus.NEW,
      priority: overrides.priority ?? Priority.MEDIUM,
      ownerId: overrides.ownerId ?? createdById,
      createdById,
      tags: overrides.tags ?? [],
      ...(overrides.createdAt !== undefined
        ? { createdAt: overrides.createdAt }
        : {}),
    },
    select: { id: true },
  });
  return lead;
}

// ---------------------------------------------------------------------------
// GET /api/leads
// ---------------------------------------------------------------------------

describe('GET /api/leads — auth', () => {
  it('returns 401 when no session is present', async () => {
    await setSession(null);
    const res = await GET(buildJsonRequest('GET', 'http://test/api/leads'));
    expect(res.status).toBe(401);
    expect(await getJson(res)).toEqual({ error: 'unauthorized' });
  });
});

describe('GET /api/leads — happy path', () => {
  it('returns the paginated list with total/page/pageSize when called by ADMIN', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await seedLead(admin.id, { name: 'Acme Corp' });
    await seedLead(admin.id, { name: 'Beta Inc' });
    await seedLead(admin.id, { name: 'Gamma LLC' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(buildJsonRequest('GET', 'http://test/api/leads'));

    expect(res.status).toBe(200);
    const body = await getJson<{
      items: Array<{ id: string; name: string }>;
      total: number;
      page: number;
      pageSize: number;
    }>(res);
    expect(body).not.toBeNull();
    expect(body!.total).toBe(3);
    expect(body!.page).toBe(1);
    expect(body!.pageSize).toBe(50);
    expect(body!.items).toHaveLength(3);
  });

  it('an EMPLOYEE sees the same global pipeline (leads are shared)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await seedLead(admin.id);
    await seedLead(admin.id);
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await GET(buildJsonRequest('GET', 'http://test/api/leads'));
    expect(res.status).toBe(200);
    const body = await getJson<{ total: number }>(res);
    expect(body!.total).toBe(2);
  });
});

describe('GET /api/leads — filters', () => {
  it('honours multi-value status filter (comma separated)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await seedLead(admin.id, { status: LeadStatus.NEW });
    await seedLead(admin.id, { status: LeadStatus.CONTACTED });
    await seedLead(admin.id, { status: LeadStatus.LOST });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', 'http://test/api/leads?status=NEW,CONTACTED'),
    );
    const body = await getJson<{
      items: Array<{ status: LeadStatus }>;
      total: number;
    }>(res);
    expect(body!.total).toBe(2);
    expect(body!.items.every((l) => l.status !== LeadStatus.LOST)).toBe(true);
  });

  it('honours multi-value source filter', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await seedLead(admin.id, { source: LeadSource.WEBSITE });
    await seedLead(admin.id, { source: LeadSource.FACEBOOK_AD });
    await seedLead(admin.id, { source: LeadSource.MANUAL });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest(
        'GET',
        'http://test/api/leads?source=WEBSITE,FACEBOOK_AD',
      ),
    );
    const body = await getJson<{
      items: Array<{ source: LeadSource }>;
      total: number;
    }>(res);
    expect(body!.total).toBe(2);
    expect(body!.items.every((l) => l.source !== LeadSource.MANUAL)).toBe(true);
  });

  it('honours multi-value priority filter', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await seedLead(admin.id, { priority: Priority.LOW });
    await seedLead(admin.id, { priority: Priority.HIGH });
    await seedLead(admin.id, { priority: Priority.URGENT });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', 'http://test/api/leads?priority=HIGH,URGENT'),
    );
    const body = await getJson<{
      items: Array<{ priority: Priority }>;
      total: number;
    }>(res);
    expect(body!.total).toBe(2);
    expect(body!.items.every((l) => l.priority !== Priority.LOW)).toBe(true);
  });

  it('honours the ownerId filter', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: alice } = await createTestUser({ role: 'EMPLOYEE' });
    const { user: bob } = await createTestUser({ role: 'EMPLOYEE' });
    await seedLead(admin.id, { ownerId: alice.id });
    await seedLead(admin.id, { ownerId: bob.id });
    await seedLead(admin.id, { ownerId: bob.id });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', `http://test/api/leads?ownerId=${bob.id}`),
    );
    const body = await getJson<{
      items: Array<{ ownerId: string }>;
      total: number;
    }>(res);
    expect(body!.total).toBe(2);
    expect(body!.items.every((l) => l.ownerId === bob.id)).toBe(true);
  });

  it('honours the case-insensitive search filter on name/email/phone/company', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await seedLead(admin.id, { name: 'Acme Corp', email: 'jane@acme.com' });
    await seedLead(admin.id, { name: 'Beta Inc', company: 'Acme Holdings' });
    await seedLead(admin.id, { name: 'Gamma LLC' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', 'http://test/api/leads?search=acme'),
    );
    const body = await getJson<{ total: number }>(res);
    expect(body!.total).toBe(2);
  });

  it('honours the tag filter (Lead.tags `has`)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await seedLead(admin.id, { tags: ['hot', 'enterprise'] });
    await seedLead(admin.id, { tags: ['cold'] });
    await seedLead(admin.id, { tags: [] });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', 'http://test/api/leads?tag=hot'),
    );
    const body = await getJson<{ total: number }>(res);
    expect(body!.total).toBe(1);
  });

  it('honours dateFrom + dateTo on createdAt', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await seedLead(admin.id, {
      name: 'Old',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await seedLead(admin.id, {
      name: 'Mid',
      createdAt: new Date('2026-02-15T00:00:00Z'),
    });
    await seedLead(admin.id, {
      name: 'New',
      createdAt: new Date('2026-03-30T00:00:00Z'),
    });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest(
        'GET',
        'http://test/api/leads?dateFrom=2026-02-01T00:00:00Z&dateTo=2026-03-01T00:00:00Z',
      ),
    );
    const body = await getJson<{
      items: Array<{ name: string }>;
      total: number;
    }>(res);
    expect(body!.total).toBe(1);
    expect(body!.items[0]!.name).toBe('Mid');
  });
});

describe('GET /api/leads — pagination + sort', () => {
  it('respects page + pageSize', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    for (let i = 0; i < 5; i += 1) {
      await seedLead(admin.id, { name: `Lead ${i}` });
    }
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', 'http://test/api/leads?page=2&pageSize=2'),
    );
    const body = await getJson<{
      items: unknown[];
      total: number;
      page: number;
      pageSize: number;
    }>(res);
    expect(body!.total).toBe(5);
    expect(body!.page).toBe(2);
    expect(body!.pageSize).toBe(2);
    expect(body!.items).toHaveLength(2);
  });

  it('honours sortBy=created with sortDir=asc (oldest first)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await seedLead(admin.id, {
      name: 'Old',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await seedLead(admin.id, {
      name: 'Mid',
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    await seedLead(admin.id, {
      name: 'New',
      createdAt: new Date('2026-03-01T00:00:00Z'),
    });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest(
        'GET',
        'http://test/api/leads?sortBy=created&sortDir=asc',
      ),
    );
    const body = await getJson<{ items: Array<{ name: string }> }>(res);
    expect(body!.items.map((l) => l.name)).toEqual(['Old', 'Mid', 'New']);
  });

  it('returns 400 when query params are invalid (page=0)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', 'http://test/api/leads?page=0'),
    );
    expect(res.status).toBe(400);
    const body = await getJson<{ error: string; issues: unknown[] }>(res);
    expect(body!.error).toBe('bad_request');
    expect(Array.isArray(body!.issues)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/leads
// ---------------------------------------------------------------------------

describe('POST /api/leads — auth', () => {
  it('returns 401 when no session is present', async () => {
    await setSession(null);
    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads', {
        name: 'Anon Customer',
        email: 'anon@example.com',
      }),
    );
    expect(res.status).toBe(401);
    expect(await prisma.lead.count()).toBe(0);
  });
});

describe('POST /api/leads — happy path', () => {
  it('creates a lead with createdById and ownerId defaulted to the caller', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads', {
        name: 'New Lead',
        email: 'new-lead@example.com',
        phone: '+1 555 0100',
      }),
    );

    expect(res.status).toBe(201);
    const body = await getJson<{
      id: string;
      name: string;
      ownerId: string;
      createdById: string;
      owner: { id: string } | null;
    }>(res);
    expect(body).not.toBeNull();
    expect(body!.name).toBe('New Lead');
    expect(body!.createdById).toBe(admin.id);
    expect(body!.ownerId).toBe(admin.id);
    expect(body!.owner).not.toBeNull();
    expect(body!.owner!.id).toBe(admin.id);

    // DB row matches the response.
    const stored = await prisma.lead.findUnique({ where: { id: body!.id } });
    expect(stored).not.toBeNull();
    expect(stored!.createdById).toBe(admin.id);
    expect(stored!.ownerId).toBe(admin.id);
  });

  it('writes a `lead.created` activity log row tied to the calling user', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads', {
        name: 'Audited Lead',
        email: 'audited@example.com',
      }),
    );
    expect(res.status).toBe(201);
    const body = await getJson<{ id: string }>(res);

    const log = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'lead.created',
        entityType: 'lead',
        entityId: body!.id,
      },
    });
    expect(log).not.toBeNull();
    expect(log!.leadId).toBe(body!.id);
    expect(log!.metadata).toMatchObject({ entityName: 'Audited Lead' });
  });

  it('admin can assign a new lead to any user', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: alice } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads', {
        name: "Alice's Lead",
        email: 'alice-lead@example.com',
        ownerId: alice.id,
      }),
    );

    expect(res.status).toBe(201);
    const body = await getJson<{
      ownerId: string;
      createdById: string;
    }>(res);
    expect(body!.ownerId).toBe(alice.id);
    // createdById is still the calling admin, not the new owner.
    expect(body!.createdById).toBe(admin.id);
  });

  it('employee can self-assign on creation (ownerId === their own id)', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads', {
        name: 'Self Assigned',
        email: 'self@example.com',
        ownerId: employee.id,
      }),
    );

    expect(res.status).toBe(201);
    const body = await getJson<{ ownerId: string; createdById: string }>(res);
    expect(body!.ownerId).toBe(employee.id);
    expect(body!.createdById).toBe(employee.id);
  });
});

describe('POST /api/leads — RBAC on cross-assignment', () => {
  it('returns 403 when an EMPLOYEE attempts to assign a new lead to someone else', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    const { user: other } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads', {
        name: 'Cross Assigned',
        email: 'cross@example.com',
        ownerId: other.id,
      }),
    );

    expect(res.status).toBe(403);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('forbidden');

    // Defensive: no row written.
    expect(await prisma.lead.count()).toBe(0);
  });
});

describe('POST /api/leads — v0.1.4 Chitly spreadsheet fields', () => {
  it('persists all 7 new fields (age, activeSince, languages, extraDetails, phoneType, notOnWhatsapp, address)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads', {
        name: 'Chitly Lead',
        phone: '9876543210',
        age: 29,
        activeSince: '10 Days',
        languages: ['Hindi', 'Marathi', 'English'],
        extraDetails: 'IT Job — Unmarried',
        phoneType: 'iPhone',
        notOnWhatsapp: false,
        address: 'Pune, Maharashtra',
      }),
    );

    expect(res.status).toBe(201);
    const body = await getJson<{
      id: string;
      age: number | null;
      activeSince: string | null;
      languages: string[];
      extraDetails: string | null;
      phoneType: string | null;
      notOnWhatsapp: boolean;
      address: string | null;
    }>(res);

    // Response surfaces every new column.
    expect(body!.age).toBe(29);
    expect(body!.activeSince).toBe('10 Days');
    expect(body!.languages).toEqual(['Hindi', 'Marathi', 'English']);
    expect(body!.extraDetails).toBe('IT Job — Unmarried');
    expect(body!.phoneType).toBe('iPhone');
    expect(body!.notOnWhatsapp).toBe(false);
    expect(body!.address).toBe('Pune, Maharashtra');

    // DB round-trip.
    const stored = await prisma.lead.findUnique({ where: { id: body!.id } });
    expect(stored).not.toBeNull();
    expect(stored!.age).toBe(29);
    expect(stored!.activeSince).toBe('10 Days');
    expect(stored!.languages).toEqual(['Hindi', 'Marathi', 'English']);
    expect(stored!.extraDetails).toBe('IT Job — Unmarried');
    expect(stored!.phoneType).toBe('iPhone');
    expect(stored!.notOnWhatsapp).toBe(false);
    expect(stored!.address).toBe('Pune, Maharashtra');
  });

  it('applies sensible defaults when new fields are omitted (languages=[], notOnWhatsapp=false, others null)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads', {
        name: 'Minimal Lead',
        email: 'minimal@example.com',
      }),
    );
    expect(res.status).toBe(201);
    const body = await getJson<{
      id: string;
      age: number | null;
      activeSince: string | null;
      languages: string[];
      extraDetails: string | null;
      phoneType: string | null;
      notOnWhatsapp: boolean;
      address: string | null;
    }>(res);

    expect(body!.age).toBeNull();
    expect(body!.activeSince).toBeNull();
    expect(body!.languages).toEqual([]);
    expect(body!.extraDetails).toBeNull();
    expect(body!.phoneType).toBeNull();
    expect(body!.notOnWhatsapp).toBe(false);
    expect(body!.address).toBeNull();
  });

  it('accepts the marker `notOnWhatsapp: true` to flag leads missing WhatsApp', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads', {
        name: 'No WhatsApp Lead',
        phone: '+91 99 1234 5678',
        notOnWhatsapp: true,
      }),
    );
    expect(res.status).toBe(201);
    const body = await getJson<{ id: string; notOnWhatsapp: boolean }>(res);
    expect(body!.notOnWhatsapp).toBe(true);

    const stored = await prisma.lead.findUnique({ where: { id: body!.id } });
    expect(stored!.notOnWhatsapp).toBe(true);
  });

  it('returns 400 for an invalid phoneType ("BlackBerry")', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads', {
        name: 'Bad Phone Type',
        email: 'badphone@example.com',
        phoneType: 'BlackBerry',
      }),
    );
    expect(res.status).toBe(400);
    const body = await getJson<{ error: string; issues: unknown[] }>(res);
    expect(body!.error).toBe('bad_request');
    expect(Array.isArray(body!.issues)).toBe(true);
    expect(await prisma.lead.count()).toBe(0);
  });

  it('returns 400 when `languages` exceeds the 16-item cap', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    // 17 distinct language strings — one over the cap.
    const tooMany = Array.from({ length: 17 }, (_, i) => `Lang${i}`);

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads', {
        name: 'Polyglot Lead',
        email: 'polyglot@example.com',
        languages: tooMany,
      }),
    );
    expect(res.status).toBe(400);
    const body = await getJson<{ error: string; issues: unknown[] }>(res);
    expect(body!.error).toBe('bad_request');
    expect(await prisma.lead.count()).toBe(0);
  });
});

describe('POST /api/leads — validation', () => {
  it('returns 400 when the body is missing the required name field', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads', {
        email: 'noname@example.com',
        phone: '+1 555 0101',
      }),
    );

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string; issues: unknown[] }>(res);
    expect(body!.error).toBe('bad_request');
    expect(Array.isArray(body!.issues)).toBe(true);
    expect(await prisma.lead.count()).toBe(0);
  });

  it('returns 400 when neither phone nor email is provided (refine)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads', {
        name: 'Phoneless and Emailless',
      }),
    );

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string; issues: unknown[] }>(res);
    expect(body!.error).toBe('bad_request');
    expect(await prisma.lead.count()).toBe(0);
  });

  it('returns 400 when the body is not JSON', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const req = new Request('http://test/api/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json-at-all',
    }) as unknown as Parameters<typeof POST>[0];

    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
