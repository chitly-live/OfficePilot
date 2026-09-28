/**
 * Bank reconciliation — line up a bank statement with the ledger rows of one
 * account and say, to the paisa, what does not agree.
 *
 * Matching runs in passes, strictest first, and every line / row is used at
 * most once:
 *
 *   1. same reference (UTR / RRN) + same amount + same direction
 *   2. same date + same amount + same direction
 *   3. within 3 days + same amount + same direction (bank value-date lag)
 *
 * What is left over is the answer: statement lines missing from the panel,
 * and panel rows the bank never saw. For a missing line we suggest how to
 * record it (category, party, description), learning from the rows already
 * in the ledger before falling back to keyword rules.
 *
 * Pure — the loader in `finance-reconcile.ts` supplies the rows.
 */

import type { FinanceCategory } from '@prisma/client';

import type { StatementLine } from '@/lib/bank-statement';
import { round2 } from '@/lib/finance';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LedgerLine {
  id: string;
  date: Date;
  direction: 'IN' | 'OUT';
  amount: number;
  category: FinanceCategory;
  description: string | null;
  reference: string | null;
  partyId: string | null;
  partyName: string | null;
}

export type MatchKind = 'reference' | 'date' | 'near_date';

export interface MatchedPair {
  line: StatementLine;
  row: LedgerLine;
  kind: MatchKind;
  /** Days between the statement date and the ledger date (row − line). */
  dayShift: number;
}

export interface Suggestion {
  category: FinanceCategory | null;
  partyId: string | null;
  partyName: string | null;
  description: string;
  /** Where the guess came from, shown next to it. */
  basis: 'history' | 'rule' | 'none';
}

export interface MissingLine {
  line: StatementLine;
  suggestion: Suggestion;
}

export interface ReconcileResult {
  matched: MatchedPair[];
  /** On the statement, not in the panel. */
  missing: MissingLine[];
  /** In the panel, not on the statement. */
  extra: LedgerLine[];
  totals: {
    statementIn: number;
    statementOut: number;
    ledgerIn: number;
    ledgerOut: number;
  };
}

const cleanRef = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const sameMoney = (a: number, b: number) => Math.abs(round2(a) - round2(b)) < 0.005;
const days = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / DAY_MS);

export function reconcile(
  lines: readonly StatementLine[],
  rows: readonly LedgerLine[],
  history: readonly LedgerLine[] = rows,
): ReconcileResult {
  const freeLines = new Set(lines.map((_, i) => i));
  const freeRows = new Set(rows.map((_, i) => i));
  const matched: MatchedPair[] = [];

  function pass(kind: MatchKind, fits: (l: StatementLine, r: LedgerLine) => boolean) {
    for (const li of Array.from(freeLines)) {
      const line = lines[li]!;
      // Nearest date first, so two equal amounts pair with the right day.
      const candidates = Array.from(freeRows)
        .filter((ri) => {
          const row = rows[ri]!;
          return row.direction === line.direction && sameMoney(row.amount, line.amount) && fits(line, row);
        })
        .sort(
          (a, b) =>
            Math.abs(days(rows[a]!.date, line.date)) - Math.abs(days(rows[b]!.date, line.date)),
        );
      const ri = candidates[0];
      if (ri === undefined) continue;
      freeLines.delete(li);
      freeRows.delete(ri);
      matched.push({ line, row: rows[ri]!, kind, dayShift: days(rows[ri]!.date, line.date) });
    }
  }

  pass('reference', (l, r) => cleanRef(l.reference) !== '' && cleanRef(l.reference) === cleanRef(r.reference));
  pass('date', (l, r) => days(r.date, l.date) === 0);
  pass('near_date', (l, r) => Math.abs(days(r.date, l.date)) <= 3);

  const missingLines = Array.from(freeLines).map((i) => lines[i]!);
  const missing = missingLines.map((line) => ({
    line,
    suggestion: suggestFor(line, missingLines, history),
  }));
  const extra = Array.from(freeRows)
    .map((i) => rows[i]!)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const sum = (xs: { amount: number }[]) => round2(xs.reduce((s, x) => s + x.amount, 0));
  return {
    matched: matched.sort((a, b) => a.line.date.getTime() - b.line.date.getTime() || a.line.line - b.line.line),
    missing: missing.sort((a, b) => a.line.date.getTime() - b.line.date.getTime() || b.line.line - a.line.line),
    extra,
    totals: {
      statementIn: sum(lines.filter((l) => l.direction === 'IN')),
      statementOut: sum(lines.filter((l) => l.direction === 'OUT')),
      ledgerIn: sum(rows.filter((r) => r.direction === 'IN')),
      ledgerOut: sum(rows.filter((r) => r.direction === 'OUT')),
    },
  };
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/** Tokens that identify a counterparty in a narration: words of 4+ letters. */
function tokens(text: string): Set<string> {
  const stop = new Set(['imps', 'neft', 'rtgs', 'payment', 'transfer', 'from', 'with', 'bank', 'india', 'private', 'limited', 'pvt', 'ltd', 'chrgs', 'charges']);
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 4 && !stop.has(w)),
  );
}

const IMPS_CHARGE = /imps.*(chrg|charge)|(chrg|charge).*imps/i;
const AMB_CHARGE = /\b(amb|avg\.?\s*bal|average\s+(monthly\s+)?balance|min(imum)?\s*bal)/i;
const BANK_FEE = /\b(chrg|chrgs|charges?|fee|sms\s*alert|annual\s*fee|debit\s*card)\b/i;

function titleDate(raw: string): string {
  const m = /for\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i.exec(raw);
  return m ? m[1]! : '';
}

export function suggestFor(
  line: StatementLine,
  allMissing: readonly StatementLine[],
  history: readonly LedgerLine[],
): Suggestion {
  const text = line.description;

  // A bare "GST" line is the tax on the charge printed just before it
  // (same reference) — describe it the way the ledger already does.
  if (/^gst$/i.test(text.trim())) {
    const charge = allMissing.find(
      (o) => o !== line && cleanRef(o.reference) !== '' && cleanRef(o.reference) === cleanRef(line.reference) && !/^gst$/i.test(o.description.trim()),
    );
    const base = charge ? describeCharge(charge.description) : 'bank charges';
    return { category: 'BANK_CHARGES', partyId: null, partyName: null, description: `GST on ${base}`, basis: 'rule' };
  }
  if (line.direction === 'OUT' && (IMPS_CHARGE.test(text) || AMB_CHARGE.test(text) || BANK_FEE.test(text))) {
    return { category: 'BANK_CHARGES', partyId: null, partyName: null, description: describeCharge(text), basis: 'rule' };
  }

  // Learn from the ledger: the past row, same direction, whose description /
  // reference shares the most narration words with this line.
  const want = tokens(`${text} ${line.reference}`);
  let best: { row: LedgerLine; score: number } | null = null;
  if (want.size > 0) {
    for (const row of history) {
      if (row.direction !== line.direction) continue;
      const have = tokens(`${row.description ?? ''} ${row.partyName ?? ''}`);
      let score = 0;
      for (const w of want) if (have.has(w)) score++;
      if (score > 0 && (!best || score > best.score || (score === best.score && row.date > best.row.date))) {
        best = { row, score };
      }
    }
  }
  if (best) {
    return {
      category: best.row.category,
      partyId: best.row.partyId,
      partyName: best.row.partyName,
      description: best.row.description ?? text,
      basis: 'history',
    };
  }

  return { category: null, partyId: null, partyName: null, description: text, basis: 'none' };
}

/** "IMPS PAYMENT CHRGS for 29-Aug-2026" → "IMPS charges for 29-Aug-2026". */
function describeCharge(raw: string): string {
  if (IMPS_CHARGE.test(raw)) {
    const d = titleDate(raw);
    return d ? `IMPS charges for ${d}` : 'IMPS charges';
  }
  if (AMB_CHARGE.test(raw)) return 'Average monthly balance (AMB) charges';
  return raw.trim() || 'Bank charges';
}
