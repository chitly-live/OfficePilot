/**
 * `GET /api/finance/export?format=xlsx|pdf&month=YYYY-MM`
 * `GET /api/finance/export?format=pdf&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD`
 * `GET /api/finance/export?format=xlsx&all=1`
 *
 * Downloads the Finance report for the accountant. Admin-only (the module
 * is gated in `src/middleware.ts` and re-checked here). The response is the
 * file itself with a `Content-Disposition: attachment` header, so a plain
 * link in the UI triggers the download.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  BadRequestError,
  errorResponse,
  parseSearchParams,
  requireAdminSession,
} from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { prisma } from '@/lib/db';
import {
  buildFinanceReport,
  reportFileStem,
  resolveReportWindow,
} from '@/lib/finance-report';
import { buildFinanceReportPdf } from '@/lib/finance-report-pdf';
import { buildFinanceReportXlsx } from '@/lib/finance-report-xlsx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const exportQuerySchema = z.object({
  format: z.enum(['xlsx', 'pdf']).default('xlsx'),
  month: z.string().trim().regex(/^\d{4}-\d{2}$/, 'Month must look like YYYY-MM').optional(),
  dateFrom: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
  dateTo: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
  all: z.enum(['1', 'true']).optional(),
});

const CONTENT_TYPES = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
} as const;

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const query = parseSearchParams(req.nextUrl.searchParams, exportQuerySchema);

    const window = resolveReportWindow({
      month: query.month,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      all: query.all !== undefined,
    });
    if (!window) {
      throw new BadRequestError('Pick a month (month=YYYY-MM), a date range, or all=1');
    }

    const report = await buildFinanceReport(prisma, window);
    const body =
      query.format === 'pdf'
        ? await buildFinanceReportPdf(report)
        : await buildFinanceReportXlsx(report);

    const filename = `${reportFileStem(report)}.${query.format}`;

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.FINANCE_REPORT_EXPORTED,
        entityType: 'finance_report',
        entityId: window.fileTag,
        metadata: {
          period: window.label,
          format: query.format,
          transactions: report.transactionCount,
          entityName: `${window.label} (${query.format.toUpperCase()})`,
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[finance/export] failed to log export', logErr);
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        'content-type': CONTENT_TYPES[query.format],
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': String(body.byteLength),
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
