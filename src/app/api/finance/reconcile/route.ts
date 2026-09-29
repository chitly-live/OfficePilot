/**
 * `POST /api/finance/reconcile` — compare a bank statement CSV with the
 * ledger rows of one account. Body: `{ accountId, csv }`.
 *
 * Read-only: nothing is stored, so the accountant may run it too (the
 * middleware lets this one POST through for them). Adding a missing line
 * goes through `POST /api/finance/transactions` like any other entry.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  BadRequestError,
  errorResponse,
  parseJsonBody,
  requireFinanceReadSession,
} from '@/lib/api-helpers';
import { StatementParseError, parseBankStatement } from '@/lib/bank-statement';
import { prisma } from '@/lib/db';
import { loadReconciliation } from '@/lib/finance-reconcile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A few hundred KB covers a year of statements; leave room for JSON escaping. */
const MAX_BODY_BYTES = 2_500_000;

const bodySchema = z.object({
  accountId: z.string().trim().min(1, 'Pick an account'),
  csv: z
    .string()
    .min(1, 'Paste the statement or choose the file')
    .max(2_000_000, 'The statement is too large (2 MB at most)'),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireFinanceReadSession();
    // Refuse an oversized body before it is read into memory.
    const length = Number(req.headers.get('content-length') ?? '0');
    if (length > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: 'too_large', message: 'The statement is too large (2 MB at most).' },
        { status: 413 },
      );
    }
    const input = await parseJsonBody(req, bodySchema);

    let parsed;
    try {
      parsed = parseBankStatement(input.csv);
    } catch (err) {
      if (err instanceof StatementParseError) throw new BadRequestError(err.message);
      throw err;
    }

    const view = await loadReconciliation(prisma, input.accountId, parsed);
    if (!view) throw new BadRequestError('Account not found');
    return NextResponse.json(view);
  } catch (err) {
    return errorResponse(err);
  }
}
