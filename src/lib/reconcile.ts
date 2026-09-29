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
 * record it — from the bank's own charge narrations, or from the payee named
 * in the narration matched against our parties and their past entries.
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
  /** Intermediary the bank actually paid (bank → Ritu → Shubham). */
  viaPartyId?: string | null;
}

export interface PartyRef {
  id: string;
  name: string;
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
  viaPartyId: string | null;
  description: string;
  /**
   * Where the guess came from: a bank charge rule, the payee's past entries,
   * the payee alone (category still to pick), or nothing.
   */
  basis: 'rule' | 'history' | 'party' | 'none';
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
const cents = (n: number) => Math.round(round2(n) * 100);
const days = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / DAY_MS);

export function reconcile(
  lines: readonly StatementLine[],
  rows: readonly LedgerLine[],
  history: readonly LedgerLine[] = rows,
  parties: readonly PartyRef[] = [],
): ReconcileResult {
  // Rows bucketed by direction + amount: a line only ever looks at rows it
  // could possibly match, so a big statement stays fast.
  const buckets = new Map<string, Set<number>>();
  rows.forEach((r, i) => {
    const key = `${r.direction}|${cents(r.amount)}`;
    const set = buckets.get(key) ?? new Set<number>();
    set.add(i);
    buckets.set(key, set);
  });

  const freeLines = new Set(lines.map((_, i) => i));
  const matched: MatchedPair[] = [];

  function pass(kind: MatchKind, fits: (l: StatementLine, r: LedgerLine) => boolean) {
    for (const li of Array.from(freeLines)) {
      const line = lines[li]!;
      const bucket = buckets.get(`${line.direction}|${cents(line.amount)}`);
      if (!bucket || bucket.size === 0) continue;
      // Nearest date first, so two equal amounts pair with the right day.
      let best: number | undefined;
      let bestGap = Infinity;
      for (const ri of bucket) {
        const row = rows[ri]!;
        if (!fits(line, row)) continue;
        const gap = Math.abs(days(row.date, line.date));
        if (gap < bestGap) {
          best = ri;
          bestGap = gap;
        }
      }
      if (best === undefined) continue;
      freeLines.delete(li);
      bucket.delete(best);
      matched.push({ line, row: rows[best]!, kind, dayShift: days(rows[best]!.date, line.date) });
    }
  }

  pass('reference', (l, r) => cleanRef(l.reference) !== '' && cleanRef(l.reference) === cleanRef(r.reference));
  pass('date', (l, r) => days(r.date, l.date) === 0);
  pass('near_date', (l, r) => Math.abs(days(r.date, l.date)) <= 3);

  const used = new Set(matched.map((m) => m.row.id));
  const missingLines = Array.from(freeLines).map((i) => lines[i]!);
  const ctx = suggestionContext(missingLines, history);
  const missing = missingLines.map((line) => ({
    line,
    suggestion: suggestFor(line, missingLines, history, parties, ctx),
  }));
  const extra = rows
    .filter((r) => !used.has(r.id))
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
// Bank charge narrations (YES BANK wording, anchored so vendor payments that
// merely mention a "charge" never match)
// ---------------------------------------------------------------------------

const IMPS_CHARGE = /^IMPS\s+PAYMENT\s+CHRGS?\b/i;
const AMB_CHARGE = /^AMB\s+CHRGS?\b/i;
/** Other bank fee lines: a short upper-case label ending in CHRGS, no payee segments. */
const OTHER_BANK_CHARGE = /^[A-Z][A-Z .&]{0,40}\bCHRGS?\b/;

function impsChargeDescription(raw: string): string {
  const m = /for\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i.exec(raw);
  return m ? `IMPS charges for ${m[1]}` : 'IMPS charges';
}

function ambChargeDescription(raw: string): string {
  const m = /for\s+([A-Za-z]{3,9}\s+\d{4})/i.exec(raw);
  return m ? `Average monthly balance (AMB) charges, ${m[1]}` : 'Average monthly balance (AMB) charges';
}

/** How the ledger describes a charge line; null when the line is not one. */
export function chargeDescription(raw: string): string | null {
  const text = raw.trim();
  if (IMPS_CHARGE.test(text)) return impsChargeDescription(text);
  if (AMB_CHARGE.test(text)) return ambChargeDescription(text);
  if (!text.includes('/') && OTHER_BANK_CHARGE.test(text)) return text;
  return null;
}

// ---------------------------------------------------------------------------
// Payee in the narration
// ---------------------------------------------------------------------------

/**
 * The counterparty the bank names, and the sender's remark.
 *
 *   IMPS/NA/XXXX8575/RRN:…/PC…/BANK OF MAHARAS/Tinkal Wankar/HOST PAYMENT
 *   NEFT Cr-UTIB0001920-CASHFREE PAYMENTS INDIA P-PRAXXEL TECHNOLOGIES PRIV-AXISCN…
 *   YIB-NEFT-YESME…-SHUBHAM KUMAR-HDFC…-META ADS-HDFC BANK
 */
export function counterpartyOf(narration: string): { name: string; remark: string } | null {
  const text = narration.trim();
  if (/^IMPS\//i.test(text)) {
    const parts = text.split('/');
    if (parts.length >= 7) return { name: parts[6]!.trim(), remark: (parts[7] ?? '').trim() };
    return null;
  }
  if (/^NEFT\s*Cr-/i.test(text)) {
    const parts = text.split('-');
    return parts.length >= 3 ? { name: parts[2]!.trim(), remark: '' } : null;
  }
  if (/^YIB-NEFT-/i.test(text)) {
    const parts = text.split('-');
    return parts.length >= 4 ? { name: parts[3]!.trim(), remark: (parts[5] ?? '').trim() } : null;
  }
  if (/^UPI\//i.test(text)) {
    const parts = text.split('/');
    return parts.length >= 4 ? { name: parts[3]!.trim(), remark: (parts[4] ?? '').trim() } : null;
  }
  return null;
}

/** Words that say nothing about who the payee is. */
const NAME_STOP = new Set([
  'the', 'and', 'for', 'pvt', 'ltd', 'limited', 'private', 'india', 'payments', 'payment', 'bank', 'services',
  'technologies', 'technology', 'enterprises', 'solutions', 'mr', 'mrs', 'ms', 'shri', 'smt',
]);

function nameTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 3 && !NAME_STOP.has(w)),
  );
}

/** The one party whose name best matches the payee; null on no match or a tie. */
export function matchParty(payee: string, parties: readonly PartyRef[]): PartyRef | null {
  const want = nameTokens(payee);
  if (want.size === 0) return null;
  let best: PartyRef | null = null;
  let bestScore = 0;
  let tie = false;
  for (const p of parties) {
    const have = nameTokens(p.name);
    let score = 0;
    for (const w of have) if (want.has(w)) score++;
    // One shared word is enough only when a name has just one word
    // ("CASHFREE"); otherwise two must agree, so "Amit Kumar" never
    // lands on "SHUBHAM KUMAR".
    if (score === 0 || score < Math.min(2, have.size, want.size)) continue;
    if (score > bestScore) {
      best = p;
      bestScore = score;
      tie = false;
    } else if (score === bestScore) {
      tie = true;
    }
  }
  return tie ? null : best;
}

/** A past description is reused only if it carries no dates or amounts of its own. */
function reusableDescription(desc: string | null): string | null {
  if (!desc) return null;
  if (!/\d/.test(desc)) return desc;
  const head = desc.split(/\s[·—]\s|\s-\s/)[0]!.trim();
  return head && !/\d/.test(head) ? head : null;
}

function sentenceCase(s: string): string {
  const t = s.trim().toLowerCase();
  return t ? t[0]!.toUpperCase() + t.slice(1) : '';
}

/**
 * Look-ups built once per reconciliation so each missing line costs a map
 * read, not a scan of every other line — a statement of thousands of lines
 * must not stall the server.
 */
export interface SuggestionContext {
  /** First non-GST debit per reference: the charge a bare GST line belongs to. */
  chargeByRef: Map<string, StatementLine>;
  /** Latest past entry per `${direction}|${partyId}`, as party or as via. */
  latestByParty: Map<string, LedgerLine>;
  /** Payee name → matched party (null = none), per reconciliation. */
  partyByPayee: Map<string, PartyRef | null>;
}

export function suggestionContext(
  missing: readonly StatementLine[],
  history: readonly LedgerLine[],
): SuggestionContext {
  const chargeByRef = new Map<string, StatementLine>();
  for (const l of missing) {
    const ref = cleanRef(l.reference);
    if (!ref || l.direction !== 'OUT' || /^gst$/i.test(l.description.trim())) continue;
    if (!chargeByRef.has(ref)) chargeByRef.set(ref, l);
  }
  const latestByParty = new Map<string, LedgerLine>();
  for (const r of history) {
    for (const pid of [r.partyId, r.viaPartyId]) {
      if (!pid) continue;
      const key = `${r.direction}|${pid}`;
      const prev = latestByParty.get(key);
      if (!prev || r.date > prev.date) latestByParty.set(key, r);
    }
  }
  return { chargeByRef, latestByParty, partyByPayee: new Map() };
}

const NONE: Omit<Suggestion, 'description'> = {
  category: null,
  partyId: null,
  partyName: null,
  viaPartyId: null,
  basis: 'none',
};

export function suggestFor(
  line: StatementLine,
  allMissing: readonly StatementLine[],
  history: readonly LedgerLine[],
  parties: readonly PartyRef[] = [],
  context?: SuggestionContext,
): Suggestion {
  const ctx = context ?? suggestionContext(allMissing, history);
  const text = line.description.trim();

  // A bare "GST" debit is the tax on the charge printed next to it (same
  // reference). A GST credit is a reversal — no guess.
  if (/^gst$/i.test(text)) {
    if (line.direction !== 'OUT') return { ...NONE, description: text };
    const ref = cleanRef(line.reference);
    const charge = ref ? ctx.chargeByRef.get(ref) : undefined;
    const base = charge ? (chargeDescription(charge.description) ?? 'bank charges') : 'bank charges';
    return { ...NONE, category: 'BANK_CHARGES', description: `GST on ${base}`, basis: 'rule' };
  }

  if (line.direction === 'OUT') {
    const charge = chargeDescription(text);
    if (charge) return { ...NONE, category: 'BANK_CHARGES', description: charge, basis: 'rule' };
  }

  // The payee the bank names, matched to one of our parties.
  const cp = counterpartyOf(text);
  let party: PartyRef | null = null;
  if (cp) {
    const key = cp.name.toLowerCase();
    if (!ctx.partyByPayee.has(key)) ctx.partyByPayee.set(key, matchParty(cp.name, parties));
    party = ctx.partyByPayee.get(key) ?? null;
  }
  if (!cp || !party) return { ...NONE, description: text };

  const remark = sentenceCase(cp.remark);
  // Their latest entry in this direction — as the party, or as the person the
  // bank paid on the way to someone else.
  const past = ctx.latestByParty.get(`${line.direction}|${party.id}`);
  if (past) {
    return {
      category: past.category,
      partyId: past.partyId,
      partyName: past.partyId === party.id ? party.name : past.partyName,
      viaPartyId: past.viaPartyId ?? null,
      description: reusableDescription(past.description) ?? (remark || text),
      basis: 'history',
    };
  }
  return {
    ...NONE,
    partyId: party.id,
    partyName: party.name,
    description: remark || text,
    basis: 'party',
  };
}
