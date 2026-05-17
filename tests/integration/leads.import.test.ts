/**
 * Integration tests for `POST /api/leads/import` (task 36).
 *
 * Validates: Requirements 5.4, 5.8, 5.9, 13.1, 13.2, 15.2, 15.3, 15.4
 * Spec references: SPEC.md §6.2.3, §6.4, §16.2.
 *
 * Coverage matrix per SPEC §16.2 + task 36 brief:
 *
 *   Endpoint                       Happy   401     400 (zod)
 *   POST /api/leads/import          ✓       ✓       ✓ (empty / over cap)
 *
 * Plus the per-endpoint specifics from the task brief:
 *   - 200 + summary on partial-success: mix of valid + invalid +
 *     dup-in-batch + dup-in-db rows.
 *   - importedRows count matches the count of new Lead rows in the DB.
 *   - LEAD_IMPORTED activity log row with `{ rowsTotal, rowsImported,
 *     rowsSkipped }` metadata.
 *   - createdById and ownerId on every imported row equal the calling
 *     session's userId.
 *
 *   Property 5 — **CSV import deduplication is idempotent**: importing
 *   the same set of rows a second time leaves the lead count unchanged
 *   (every row matches an existing record and is sent to `duplicates[]`).
 *
 * Tests construct a `Request` directly and invoke the route handler
 * function — no spinning up a Next server. Per-test DB cleanup happens
 * in `tests/integration/setup.ts`'s `beforeEach(truncateAll)`.
 */

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { POST } from '@/app/api/leads/import/route';
import { prisma } from '@/lib/db';
import { MAX_CSV_ROWS } from '@/lib/schemas/leads';

import {
  buildJsonRequest,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Shape of the import endpoint's success response (informally documented
 *  in the route file; pinned here so the test assertions are explicit). */
interface ImportSummary {
  totalRows: number;
  importedRows: number;
  skippedRows: number;
  duplicates: Array<{
    rowIndex: number;
    name: string;
    email?: string;
    phone?: string;
    reason: 'duplicate_in_upload' | 'duplicate_in_database';
  }>;
  errors: Array<{ rowIndex: number; error: string; issues?: unknown[] }>;
}

/**
 * Build a syntactically-valid CSV row payload for the import endpoint.
 * Defaults satisfy the `phone || email` refine so the row passes
 * validation without further fields.
 */
function csvRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'CSV Customer',
    email: 'csv@example.com',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Auth + body validation
// ---------------------------------------------------------------------------

describe('POST /api/leads/import — auth', () => {
  it('returns 401 when no session is present', async () => {
    await setSession(null);

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads/import', {
        rows: [csvRow()],
      }),
    );
    expect(res.status).toBe(401);
    expect(await prisma.lead.count()).toBe(0);
  });
});

describe('POST /api/leads/import — body validation', () => {
  it('returns 400 when rows is empty', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads/import', {
        rows: [],
      }),
    );
    expect(res.status).toBe(400);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('bad_request');
    expect(await prisma.lead.count()).toBe(0);
  });

  it(`returns 400 when rows exceeds MAX_CSV_ROWS (${MAX_CSV_ROWS})`, async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    // 1001 rows — one over the cap. Each row gets a unique email so
    // any path past the cap check would otherwise commit ~1k rows.
    const rows = Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) =>
      csvRow({ email: `over-cap-${i}@example.com`, name: `Row ${i}` }),
    );

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads/import', { rows }),
    );
    expect(res.status).toBe(400);
    const body = await getJson<{ error: string; issues: unknown[] }>(res);
    expect(body!.error).toBe('bad_request');
    expect(Array.isArray(body!.issues)).toBe(true);
    expect(await prisma.lead.count()).toBe(0);
  });

  it('returns 400 when the body is not JSON', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const req = new Request('http://test/api/leads/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json-at-all',
    }) as unknown as Parameters<typeof POST>[0];

    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Happy path + partial success
// ---------------------------------------------------------------------------

describe('POST /api/leads/import — happy path + partial success', () => {
  it('returns 200 + summary, with imported rows stamped to session.userId for both ownerId and createdById', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads/import', {
        rows: [
          csvRow({ name: 'Alpha', email: 'alpha@example.com' }),
          csvRow({ name: 'Beta', phone: '+1 555 0001' }),
          csvRow({ name: 'Gamma', email: 'gamma@example.com' }),
        ],
      }),
    );

    expect(res.status).toBe(200);
    const body = await getJson<ImportSummary>(res);
    expect(body!.totalRows).toBe(3);
    expect(body!.importedRows).toBe(3);
    expect(body!.skippedRows).toBe(0);
    expect(body!.duplicates).toEqual([]);
    expect(body!.errors).toEqual([]);

    // DB count matches the response's `importedRows`.
    const dbCount = await prisma.lead.count();
    expect(dbCount).toBe(body!.importedRows);

    // ownerId and createdById are both `session.userId` on every row.
    const all = await prisma.lead.findMany({
      select: { ownerId: true, createdById: true },
    });
    for (const row of all) {
      expect(row.ownerId).toBe(admin.id);
      expect(row.createdById).toBe(admin.id);
    }
  });

  it('reports per-row errors, in-batch duplicates, and DB duplicates without aborting the batch', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    // Pre-seed an existing lead so one of the upload rows hits the
    // "duplicate_in_database" branch.
    await prisma.lead.create({
      data: {
        name: 'Existing Co',
        email: 'existing@example.com',
        ownerId: admin.id,
        createdById: admin.id,
      },
    });

    const rows = [
      // Row 0 — valid, will commit.
      csvRow({ name: 'Fresh One', email: 'fresh-one@example.com' }),
      // Row 1 — invalid (no name AND no phone+email).
      { name: '', email: '' },
      // Row 2 — invalid (missing name).
      { email: 'noname@example.com' },
      // Row 3 — duplicate_in_upload (matches row 0's email
      // case-insensitively).
      csvRow({ name: 'Fresh One Dup', email: 'FRESH-ONE@example.com' }),
      // Row 4 — duplicate_in_database (matches the seeded lead).
      csvRow({ name: 'Already Existing', email: 'existing@example.com' }),
      // Row 5 — valid, will commit.
      csvRow({ name: 'Another Fresh', phone: '+1 555 0202' }),
    ];

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads/import', { rows }),
    );

    expect(res.status).toBe(200);
    const body = await getJson<ImportSummary>(res);

    // Total / imported / skipped match the row breakdown.
    expect(body!.totalRows).toBe(6);
    expect(body!.importedRows).toBe(2); // rows 0 and 5
    expect(body!.skippedRows).toBe(4);  // 2 errors + 2 duplicates

    // Errors: rows 1 and 2.
    expect(body!.errors.map((e) => e.rowIndex).sort()).toEqual([1, 2]);

    // Duplicates: row 3 in upload, row 4 in DB.
    const inUpload = body!.duplicates.filter(
      (d) => d.reason === 'duplicate_in_upload',
    );
    const inDb = body!.duplicates.filter(
      (d) => d.reason === 'duplicate_in_database',
    );
    expect(inUpload.map((d) => d.rowIndex)).toEqual([3]);
    expect(inDb.map((d) => d.rowIndex)).toEqual([4]);

    // DB now has 3 rows: the pre-seeded one + the 2 new imports.
    expect(await prisma.lead.count()).toBe(3);
  });

  it('writes a `lead.imported` activity log row with rowsTotal/rowsImported/rowsSkipped', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads/import', {
        rows: [
          csvRow({ name: 'Alpha', email: 'alpha-log@example.com' }),
          csvRow({ name: 'Beta', email: 'beta-log@example.com' }),
        ],
      }),
    );
    expect(res.status).toBe(200);

    const log = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'lead.imported',
        entityType: 'lead',
      },
    });
    expect(log).not.toBeNull();
    expect(log!.metadata).toMatchObject({
      rowsTotal: 2,
      rowsImported: 2,
      rowsSkipped: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// v0.1.4 — Chitly spreadsheet column recognition
// ---------------------------------------------------------------------------

describe('POST /api/leads/import — v0.1.4 Chitly spreadsheet headers', () => {
  it('imports a row keyed by the user-facing CSV headers (Date, Name, WhatsApp/Telegram Contact, Address, Age, Active Since, Language, Extra Details, Phone Type)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    // Mirrors the exact column headers in the Chitly team's existing
    // Excel sheet. The route's canonicalizeRow step normalizes header
    // casing/whitespace/punctuation so each cell lands on the right
    // Prisma column.
    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads/import', {
        rows: [
          {
            Date: '31-Jan-2026',
            Name: 'Test User',
            'WhatsApp/Telegram Contact': '9876543210',
            Address: 'Pune, Maharashtra',
            Age: '29',
            'Active Since': '10 Days',
            Language: 'Hindi, English',
            'Extra Details': 'IT Job - Unmarried',
            'Phone Type': 'iPhone',
          },
        ],
      }),
    );

    expect(res.status).toBe(200);
    const body = await getJson<ImportSummary>(res);
    expect(body!.totalRows).toBe(1);
    expect(body!.importedRows).toBe(1);
    expect(body!.skippedRows).toBe(0);
    expect(body!.errors).toEqual([]);
    expect(body!.duplicates).toEqual([]);

    const stored = await prisma.lead.findFirst({
      where: { name: 'Test User' },
    });
    expect(stored).not.toBeNull();
    expect(stored!.name).toBe('Test User');
    expect(stored!.phone).toBe('9876543210');
    expect(stored!.address).toBe('Pune, Maharashtra');
    expect(stored!.age).toBe(29);
    expect(stored!.activeSince).toBe('10 Days');
    expect(stored!.languages).toEqual(['Hindi', 'English']);
    expect(stored!.extraDetails).toBe('IT Job - Unmarried');
    expect(stored!.phoneType).toBe('iPhone');
    // notOnWhatsapp defaults to false when omitted.
    expect(stored!.notOnWhatsapp).toBe(false);
    // The "Date" column propagates to createdAt — preserving the
    // operator's original timeline.
    expect(stored!.createdAt.toISOString().slice(0, 10)).toBe('2026-01-31');
  });

  it('recognizes the "Not on WhatsApp" header and coerces truthy/falsy cells', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads/import', {
        rows: [
          {
            Name: 'No WA Lead',
            Phone: '+91 99 1111 2222',
            'Not on WhatsApp': 'Yes',
          },
          {
            Name: 'Has WA Lead',
            Phone: '+91 99 3333 4444',
            'Not on WhatsApp': 'no',
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await getJson<ImportSummary>(res);
    expect(body!.importedRows).toBe(2);

    const rows = await prisma.lead.findMany({
      orderBy: { name: 'asc' },
      select: { name: true, notOnWhatsapp: true },
    });
    expect(rows).toEqual([
      { name: 'Has WA Lead', notOnWhatsapp: false },
      { name: 'No WA Lead', notOnWhatsapp: true },
    ]);
  });

  it('coerces an unknown "Phone Type" cell to "Other" rather than rejecting the row', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads/import', {
        rows: [
          {
            Name: 'Old Phone',
            Phone: '+91 99 5555 6666',
            'Phone Type': 'BlackBerry',
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await getJson<ImportSummary>(res);
    expect(body!.importedRows).toBe(1);
    expect(body!.errors).toEqual([]);

    const stored = await prisma.lead.findFirst({ where: { name: 'Old Phone' } });
    expect(stored!.phoneType).toBe('Other');
  });
});

// ---------------------------------------------------------------------------
// Property 5 — CSV import deduplication is idempotent
// ---------------------------------------------------------------------------

describe('POST /api/leads/import — Property 5: dedupe idempotency', () => {
  /**
   * **Validates: Requirements 5.8, 5.9**
   *
   * Importing the same batch of rows twice yields:
   *   - The first call inserts N (≤ rows.length) leads.
   *   - The second call inserts ZERO new leads — every row matches an
   *     existing record and is reported under `duplicates[]` with
   *     reason `'duplicate_in_database'`.
   *
   * The total `Lead` row count after the second call equals the count
   * after the first call.
   *
   * Inputs:
   *   - 1–10 rows per batch (small enough to run quickly under the
   *     single-fork integration suite).
   *   - Each row carries a unique-within-batch lowercase email AND a
   *     unique digit-only phone, so neither in-batch dedupe stage
   *     swallows rows. The test focuses on cross-DB dedupe behavior.
   *
   * fast-check shrinks toward small batches so a counter-example is
   * easy to inspect.
   */
  it('importing the same batch twice yields the same Lead count', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const rowArb = fc
      .array(
        fc.tuple(
          fc.stringMatching(/^[a-z0-9]{4,8}$/),
          fc.stringMatching(/^[a-z0-9]{4,8}$/),
          fc.integer({ min: 1_000_000, max: 9_999_999 }),
        ),
        { minLength: 1, maxLength: 10 },
      )
      // Map each tuple to a row keyed off a unique index so every
      // batch-internal email + phone pair is unique. The combination
      // of `i` + the random digits guarantees no two rows in the same
      // batch collide on either dedupe key.
      .map((tuples) =>
        tuples.map(([prefix, suffix, phoneSeed], i) => ({
          name: `${prefix} ${suffix}`,
          email: `${prefix}${suffix}${i}@example.com`,
          phone: `${phoneSeed}${i.toString().padStart(2, '0')}`,
        })),
      );

    await fc.assert(
      fc.asyncProperty(rowArb, async (rows) => {
        // Reset DB state at the start of each property iteration so
        // batches don't leak into each other. This mirrors what the
        // suite-level `beforeEach` would do, but property tests run
        // multiple iterations within a single `it`, so we reset
        // explicitly here.
        await prisma.activityLog.deleteMany({});
        await prisma.lead.deleteMany({});

        const first = await POST(
          buildJsonRequest('POST', 'http://test/api/leads/import', { rows }),
        );
        expect(first.status).toBe(200);
        const firstBody = await getJson<ImportSummary>(first);
        expect(firstBody!.errors).toEqual([]);

        const countAfterFirst = await prisma.lead.count();
        expect(countAfterFirst).toBe(firstBody!.importedRows);

        const second = await POST(
          buildJsonRequest('POST', 'http://test/api/leads/import', { rows }),
        );
        expect(second.status).toBe(200);
        const secondBody = await getJson<ImportSummary>(second);

        // Idempotency: the second call must not insert anything new.
        expect(secondBody!.importedRows).toBe(0);
        expect(secondBody!.errors).toEqual([]);
        // Every row of the second call should land in duplicates with
        // reason 'duplicate_in_database'.
        expect(secondBody!.duplicates).toHaveLength(rows.length);
        for (const dup of secondBody!.duplicates) {
          expect(dup.reason).toBe('duplicate_in_database');
        }

        // The DB count is unchanged after the second import.
        const countAfterSecond = await prisma.lead.count();
        expect(countAfterSecond).toBe(countAfterFirst);
      }),
      // Integration suite is single-fork against a real DB; keep the
      // run count modest so the property finishes well under the
      // 30-second per-test timeout.
      { numRuns: 12 },
    );
  });
});
