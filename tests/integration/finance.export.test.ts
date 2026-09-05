/**
 * Integration tests for `GET /api/finance/export` — the Excel / PDF report
 * download. Real Postgres; the files are rendered for real and checked by
 * magic bytes, sheet names and embedded text.
 */

import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';

import { GET as exportReport } from '@/app/api/finance/export/route';
import { prisma } from '@/lib/db';

import { buildJsonRequest, createTestUser, setSession } from './helpers';

const BASE = 'http://test/api/finance/export';

async function asAdmin() {
  const { user } = await createTestUser({ role: 'ADMIN' });
  await setSession({ userId: user.id, role: 'ADMIN' });
  return user;
}

async function seedAugust(adminId: string) {
  await prisma.setting.upsert({
    where: { key: 'company_name' },
    update: { value: 'Praxxel Technologies Private Limited' },
    create: { key: 'company_name', value: 'Praxxel Technologies Private Limited' },
  });
  const shubham = await prisma.financeParty.create({
    data: { name: 'Shubham Kumar', type: 'CARD_OWNER', createdById: adminId },
  });
  const card = await prisma.financeAccount.create({
    data: { name: 'Shubham RBL card', type: 'CREDIT_CARD', ownerPartyId: shubham.id },
  });
  const bank = await prisma.financeAccount.create({
    data: { name: 'YES BANK', type: 'BANK', openingBalance: 5096.82 },
  });
  const mk = (date: string, direction: 'IN' | 'OUT', category: string, amount: number, extra: object = {}) =>
    prisma.financeTransaction.create({
      data: {
        date: new Date(`${date}T00:00:00.000Z`),
        direction,
        category: category as never,
        amount,
        createdById: adminId,
        ...extra,
      },
    });
  await mk('2026-08-01', 'IN', 'SALES', 231.54, { accountId: bank.id, reference: 'HDFCH01163858230', description: 'Cashfree settlement' });
  await mk('2026-08-13', 'OUT', 'ADS', 12000, { accountId: card.id, description: 'Facebook ads' });
  await mk('2026-08-26', 'OUT', 'CARD_REPAYMENT', 20000, { accountId: bank.id, partyId: shubham.id });
  await mk('2026-07-15', 'OUT', 'ADS', 500, { accountId: card.id }); // outside the month
}

describe('GET /api/finance/export — auth', () => {
  it('401 without a session, 403 for an employee', async () => {
    await setSession(null);
    expect((await exportReport(buildJsonRequest('GET', `${BASE}?month=2026-08`))).status).toBe(401);

    const { user } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: user.id, role: 'EMPLOYEE' });
    expect((await exportReport(buildJsonRequest('GET', `${BASE}?month=2026-08`))).status).toBe(403);
  });
});

describe('GET /api/finance/export — validation', () => {
  it('400 when no period is given or the month is malformed', async () => {
    await asAdmin();
    expect((await exportReport(buildJsonRequest('GET', BASE))).status).toBe(400);
    expect((await exportReport(buildJsonRequest('GET', `${BASE}?month=Aug-2026`))).status).toBe(400);
    expect((await exportReport(buildJsonRequest('GET', `${BASE}?format=csv&month=2026-08`))).status).toBe(400);
  });
});

describe('GET /api/finance/export — Excel', () => {
  it('returns a styled 3-sheet workbook for the month with the company header and audits the download', async () => {
    const admin = await asAdmin();
    await seedAugust(admin.id);

    const res = await exportReport(buildJsonRequest('GET', `${BASE}?format=xlsx&month=2026-08`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="praxxel-technologies-private-limited-finance-2026-08.xlsx"',
    );

    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK'); // zip magic

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Transactions', 'Parties']);

    const summary = wb.getWorksheet('Summary')!;
    expect(summary.getCell('A1').value).toBe('Praxxel Technologies Private Limited');
    expect(String(summary.getCell('A3').value)).toContain('August 2026');

    const txns = wb.getWorksheet('Transactions')!;
    // Header row 6, then 3 August rows (July row excluded), then a totals row.
    expect(txns.getRow(6).getCell(1).value).toBe('Date');
    const descriptions: string[] = [];
    txns.eachRow((row, n) => {
      if (n > 6) descriptions.push(String(row.getCell(4).value ?? ''));
    });
    expect(descriptions).toContain('Facebook ads');
    expect(descriptions).toContain('Cashfree settlement');
    expect(descriptions.some((d) => d.includes('3 transactions'))).toBe(true);

    const log = await prisma.activityLog.findFirst({ where: { action: 'finance.report_exported' } });
    expect(log).not.toBeNull();
    expect(log!.entityId).toBe('2026-08');
  });
});

describe('GET /api/finance/export — PDF', () => {
  it('renders a PDF for a date range and for all time', async () => {
    const admin = await asAdmin();
    await seedAugust(admin.id);

    const range = await exportReport(
      buildJsonRequest('GET', `${BASE}?format=pdf&dateFrom=2026-08-01&dateTo=2026-08-31`),
    );
    expect(range.status).toBe(200);
    expect(range.headers.get('content-type')).toBe('application/pdf');
    expect(range.headers.get('content-disposition')).toContain('finance-2026-08-01_2026-08-31.pdf');
    const rangeBytes = Buffer.from(await range.arrayBuffer());
    expect(rangeBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(rangeBytes.byteLength).toBeGreaterThan(5000);

    const all = await exportReport(buildJsonRequest('GET', `${BASE}?format=pdf&all=1`));
    expect(all.status).toBe(200);
    expect(all.headers.get('content-disposition')).toContain('finance-all-time.pdf');
  });
});
