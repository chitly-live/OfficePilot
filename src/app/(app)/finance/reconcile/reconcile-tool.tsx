'use client';

/**
 * Paste or upload a bank statement, compare it with the ledger, and add the
 * lines the panel is missing — one at a time or all the ones the panel
 * already knows how to record (IMPS charges, Cashfree settlements…).
 *
 * Adding goes through the normal transactions API, so the duplicate check
 * and the month lock apply exactly as they do on the entry form.
 */

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CheckCircle2, FileUp, Loader2, Plus, Scale, TriangleAlert } from 'lucide-react';
import type { FinanceCategory } from '@prisma/client';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  FINANCE_CATEGORY_META,
  categoriesForDirection,
  formatDateUtc,
  formatInr,
  monthLabel,
} from '@/lib/finance';
import { cn } from '@/lib/utils';

import { NONE_VALUE, requestJson } from '../finance-ui';

// ---------------------------------------------------------------------------
// Wire types (dates arrive as ISO strings)
// ---------------------------------------------------------------------------

interface WireLine {
  line: number;
  date: string;
  direction: 'IN' | 'OUT';
  amount: number;
  description: string;
  reference: string;
  balance: number | null;
}

interface WireRow {
  id: string;
  date: string;
  direction: 'IN' | 'OUT';
  amount: number;
  category: FinanceCategory;
  description: string | null;
  reference: string | null;
  partyName: string | null;
}

interface WireView {
  account: { id: string; name: string };
  periodFrom: string;
  periodTo: string;
  statementLines: number;
  ledgerRows: number;
  opening: { statement: number | null; ledger: number };
  closing: { statement: number | null; ledger: number };
  matched: { line: WireLine; row: WireRow; kind: 'reference' | 'date' | 'near_date'; dayShift: number }[];
  missing: {
    line: WireLine;
    suggestion: {
      category: FinanceCategory | null;
      partyId: string | null;
      partyName: string | null;
      viaPartyId: string | null;
      description: string;
      basis: 'history' | 'rule' | 'party' | 'none';
    };
  }[];
  extra: WireRow[];
  dayMismatches: { date: string; statement: number; ledger: number; difference: number }[];
  skipped: { line: number; reason: string }[];
  totals: { statementIn: number; statementOut: number; ledgerIn: number; ledgerOut: number };
  clean: boolean;
  month: string | null;
  lockedThrough: string | null;
}

interface Draft {
  category: string;
  partyId: string;
  /** Intermediary the bank paid (from the payee's past entries). */
  viaPartyId: string | null;
  /** Card repayments: which card it settles — '' until chosen, NONE_VALUE for "not per card". */
  settlesAccountId: string;
  description: string;
}

/** Ready to add: a category, and for a card repayment an explicit card choice. */
function isReady(d: Draft | undefined): boolean {
  if (!d || d.category === NONE_VALUE) return false;
  return d.category !== 'CARD_REPAYMENT' || d.settlesAccountId !== '';
}

export interface ReconcileToolProps {
  accounts: { id: string; name: string }[];
  /** Credit cards a repayment line can settle. */
  cards: { id: string; name: string }[];
  parties: { id: string; name: string }[];
  /** Tag new rows with the panel's product, like every other row. */
  productId: string | null;
  canEdit: boolean;
  lockedThrough: string | null;
}

const lineKey = (l: WireLine) => `${l.line}`;

export function ReconcileTool({
  accounts,
  cards,
  parties,
  productId,
  canEdit,
  lockedThrough,
}: ReconcileToolProps) {
  const router = useRouter();
  const [accountId, setAccountId] = React.useState(accounts[0]?.id ?? '');
  const [csv, setCsv] = React.useState('');
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [view, setView] = React.useState<WireView | null>(null);
  const [comparing, setComparing] = React.useState(false);
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>({});
  const [adding, setAdding] = React.useState<string | null>(null);
  const [closing, setClosing] = React.useState(false);

  const compare = React.useCallback(
    async (text = csv) => {
      if (!accountId || !text.trim()) return;
      setComparing(true);
      const result = await requestJson<WireView>('/api/finance/reconcile', {
        method: 'POST',
        json: { accountId, csv: text },
      });
      setComparing(false);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setView(result.data);
      setDrafts(
        Object.fromEntries(
          result.data.missing.map((m) => [
            lineKey(m.line),
            {
              category: m.suggestion.category ?? NONE_VALUE,
              partyId: m.suggestion.partyId ?? NONE_VALUE,
              viaPartyId: m.suggestion.viaPartyId,
              settlesAccountId: '',
              description: m.suggestion.description,
            },
          ]),
        ),
      );
    },
    [accountId, csv],
  );

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    void compare(text);
  }

  /** Post one missing line. Returns false (and says why) when it did not go in. */
  async function addLine(m: WireView['missing'][number], confirmDuplicate = false): Promise<boolean> {
    const d = drafts[lineKey(m.line)];
    if (!view) return false;
    if (!d || d.category === NONE_VALUE) {
      toast.error(`Pick a category for the ${formatInr(m.line.amount)} line on ${formatDateUtc(m.line.date)}.`);
      return false;
    }
    if (d.category === 'CARD_REPAYMENT' && d.settlesAccountId === '') {
      toast.error(`Pick the card the ${formatInr(m.line.amount)} repayment settles.`);
      return false;
    }
    const result = await requestJson('/api/finance/transactions', {
      method: 'POST',
      json: {
        date: m.line.date.slice(0, 10),
        direction: m.line.direction,
        category: d.category,
        amount: m.line.amount,
        // Always the account this statement was compared against.
        accountId: view.account.id,
        ...(d.description.trim() ? { description: d.description.trim() } : {}),
        ...(m.line.reference ? { reference: m.line.reference } : {}),
        ...(d.partyId !== NONE_VALUE ? { partyId: d.partyId } : {}),
        ...(d.viaPartyId && d.partyId !== NONE_VALUE && d.viaPartyId !== d.partyId
          ? { viaPartyId: d.viaPartyId }
          : {}),
        ...(d.category === 'CARD_REPAYMENT' && d.settlesAccountId !== NONE_VALUE
          ? { settlesAccountId: d.settlesAccountId }
          : {}),
        ...(productId ? { productId } : {}),
        ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
      },
    });
    if (result.ok) return true;
    if (result.status === 409 && /already made/.test(result.message)) {
      toast.warning(result.message, {
        duration: 15000,
        action: {
          label: 'Add anyway',
          onClick: () => {
            void addLine(m, true).then(async (ok) => {
              if (ok) await compare();
            });
          },
        },
      });
      return false;
    }
    toast.error(result.message);
    return false;
  }

  async function addOne(m: WireView['missing'][number]) {
    setAdding(lineKey(m.line));
    const ok = await addLine(m);
    setAdding(null);
    if (ok) {
      toast.success('Added to the ledger.');
      await compare();
      router.refresh();
    }
  }

  async function addAllSuggested() {
    if (!view) return;
    const ready = view.missing.filter((m) => isReady(drafts[lineKey(m.line)]));
    setAdding('all');
    let added = 0;
    for (const m of ready) {
      // Stop at the first line that needs a human (duplicate warning, lock…).
      if (!(await addLine(m))) break;
      added++;
    }
    setAdding(null);
    if (added > 0) toast.success(`${added} line${added === 1 ? '' : 's'} added to the ledger.`);
    await compare();
    router.refresh();
  }

  async function closeMonth(month: string) {
    setClosing(true);
    const result = await requestJson<{ closed: string[] }>('/api/finance/close', {
      method: 'POST',
      json: { month, note: `Matched with ${view?.account.name} statement, closing ${formatInr(view?.closing.ledger ?? 0)}` },
    });
    setClosing(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(`Closed ${result.data.closed.map(monthLabel).join(', ')}.`);
    router.refresh();
    await compare();
  }

  const setDraft = (key: string, patch: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [key]: { ...prev[key]!, ...patch } }));

  const readyCount = view ? view.missing.filter((m) => isReady(drafts[lineKey(m.line)])).length : 0;
  const monthClosed = Boolean(view?.month && (view.lockedThrough ?? lockedThrough) && view.month <= (view.lockedThrough ?? lockedThrough)!);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bank statement</CardTitle>
          <CardDescription>
            Download the statement as CSV from net banking and drop it here, or paste its text. Nothing is saved until you
            add a line.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="rec-account" className="text-xs">
                Account
              </Label>
              <Select
                value={accountId}
                onValueChange={(v) => {
                  setAccountId(v);
                  setView(null);
                  setDrafts({});
                }}
              >
                <SelectTrigger id="rec-account" className="w-full sm:w-56">
                  <SelectValue placeholder="Pick an account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rec-file" className="text-xs">
                CSV file
              </Label>
              <label
                htmlFor="rec-file"
                className="flex h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm hover:bg-muted/50"
              >
                <FileUp className="h-4 w-4" aria-hidden="true" />
                <span className="max-w-[14rem] truncate">{fileName ?? 'Choose file…'}</span>
              </label>
              <input id="rec-file" type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={onFile} />
            </div>
            <Button type="button" onClick={() => compare()} disabled={comparing || !csv.trim() || !accountId}>
              {comparing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Scale className="h-4 w-4" aria-hidden="true" />}
              <span>Compare</span>
            </Button>
          </div>
          <Textarea
            rows={4}
            placeholder={'Transaction Date,Value Date,Description,Reference Number,Withdrawals,Deposits,Running Balance\n2026-09-28,2026-09-28,NEFT-AXISCN…-CASHFREE,AXISCN1481398175,,12096.16,INR 44284.99'}
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              setFileName(null);
            }}
            className="font-mono text-xs"
            aria-label="Statement text"
          />
        </CardContent>
      </Card>

      {view ? (
        <>
          <Card className={cn(view.clean ? 'border-status-green/50' : 'border-status-amber/50')}>
            <CardContent className="space-y-4 pt-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p
                    className={cn(
                      'flex items-center gap-2 text-base font-semibold',
                      view.clean ? 'text-status-green' : 'text-status-amber',
                    )}
                  >
                    {view.clean ? (
                      <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                    ) : (
                      <TriangleAlert className="h-5 w-5" aria-hidden="true" />
                    )}
                    {view.clean
                      ? 'Everything matches to the paisa'
                      : `${view.missing.length} missing · ${view.extra.length} extra${view.dayMismatches.length > 0 ? ` · balance differs from ${formatDateUtc(view.dayMismatches[0]!.date)}` : ''}`}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {view.account.name} · {formatDateUtc(view.periodFrom)} – {formatDateUtc(view.periodTo)} ·{' '}
                    {view.statementLines} statement lines, {view.ledgerRows} ledger rows, {view.matched.length} matched
                  </p>
                </div>
                {view.clean && view.month && canEdit ? (
                  monthClosed ? (
                    <span className="text-sm text-muted-foreground">{monthLabel(view.month)} is already closed.</span>
                  ) : (
                    <Button type="button" onClick={() => closeMonth(view.month!)} disabled={closing}>
                      {closing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                      <span>Close {monthLabel(view.month)}</span>
                    </Button>
                  )
                ) : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Figure label="Opening" statement={view.opening.statement} ledger={view.opening.ledger} />
                <Figure label="Closing" statement={view.closing.statement} ledger={view.closing.ledger} />
                <Figure label="Money in" statement={view.totals.statementIn} ledger={view.totals.ledgerIn} />
                <Figure label="Money out" statement={view.totals.statementOut} ledger={view.totals.ledgerOut} />
              </div>
            </CardContent>
          </Card>

          {view.missing.length > 0 ? (
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
                <div>
                  <CardTitle className="text-base">On the statement, not in the panel ({view.missing.length})</CardTitle>
                  <CardDescription>
                    The category and description are filled in from past entries where the panel recognises the line.
                    Check them, then add.
                  </CardDescription>
                </div>
                {canEdit && readyCount > 0 ? (
                  <Button type="button" size="sm" onClick={addAllSuggested} disabled={adding !== null}>
                    {adding === 'all' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
                    <span>Add {readyCount} ready</span>
                  </Button>
                ) : null}
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Date</th>
                      <th className="py-2 pr-3 font-medium">Bank narration</th>
                      <th className="py-2 pr-3 text-right font-medium">Amount</th>
                      {canEdit ? <th className="py-2 pr-3 font-medium">Record as</th> : null}
                      {canEdit ? <th className="py-2 font-medium" /> : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {view.missing.map((m) => {
                      const key = lineKey(m.line);
                      const d = drafts[key];
                      return (
                        <tr key={key} className="align-top">
                          <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{formatDateUtc(m.line.date)}</td>
                          <td className="py-2 pr-3">
                            <span className="block max-w-xs break-words">{m.line.description || '—'}</span>
                            {m.line.reference ? (
                              <span className="block font-mono text-[11px] text-muted-foreground">{m.line.reference}</span>
                            ) : null}
                          </td>
                          <td
                            className={cn(
                              'py-2 pr-3 text-right tabular-nums whitespace-nowrap',
                              m.line.direction === 'IN' ? 'text-status-green' : 'text-status-red',
                            )}
                          >
                            {m.line.direction === 'IN' ? '+' : '−'}
                            {formatInr(m.line.amount)}
                          </td>
                          {canEdit && d ? (
                            <td className="py-2 pr-3">
                              <div className="flex min-w-[18rem] flex-col gap-1.5">
                                <div className="flex gap-1.5">
                                  <Select value={d.category} onValueChange={(v) => setDraft(key, { category: v })}>
                                    <SelectTrigger className="h-8 text-xs">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value={NONE_VALUE}>Pick category…</SelectItem>
                                      {categoriesForDirection(m.line.direction).map((c) => (
                                        <SelectItem key={c} value={c}>
                                          {FINANCE_CATEGORY_META[c].label}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  <Select
                                    value={d.partyId}
                                    onValueChange={(v) =>
                                      setDraft(key, {
                                        partyId: v,
                                        // The routed-via person belongs to the suggested party only.
                                        viaPartyId: v === m.suggestion.partyId ? m.suggestion.viaPartyId : null,
                                      })
                                    }
                                  >
                                    <SelectTrigger className="h-8 text-xs">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent className="max-h-72">
                                      <SelectItem value={NONE_VALUE}>No party</SelectItem>
                                      {parties.map((p) => (
                                        <SelectItem key={p.id} value={p.id}>
                                          {p.name}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                {d.category === 'CARD_REPAYMENT' ? (
                                  <Select
                                    value={d.settlesAccountId || undefined}
                                    onValueChange={(v) => setDraft(key, { settlesAccountId: v })}
                                  >
                                    <SelectTrigger className="h-8 text-xs" aria-label="Card it settles">
                                      <SelectValue placeholder="Which card does it settle?" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value={NONE_VALUE}>Not tracked per card</SelectItem>
                                      {cards.map((c) => (
                                        <SelectItem key={c.id} value={c.id}>
                                          {c.name}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                ) : null}
                                <Input
                                  className="h-8 text-xs"
                                  value={d.description}
                                  onChange={(e) => setDraft(key, { description: e.target.value })}
                                  maxLength={500}
                                  aria-label="Description"
                                />
                                {m.suggestion.basis === 'history' ? (
                                  <span className="text-[11px] text-muted-foreground">
                                    Filled from {m.suggestion.partyName ?? 'this payee'}&apos;s past entries
                                  </span>
                                ) : m.suggestion.basis === 'party' ? (
                                  <span className="text-[11px] text-muted-foreground">
                                    Payee matched to {m.suggestion.partyName} — pick a category
                                  </span>
                                ) : null}
                              </div>
                            </td>
                          ) : null}
                          {canEdit ? (
                            <td className="py-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => addOne(m)}
                                disabled={adding !== null}
                              >
                                {adding === key ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                                <span>Add</span>
                              </Button>
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ) : null}

          {view.extra.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">In the panel, not on the statement ({view.extra.length})</CardTitle>
                <CardDescription>
                  Entered twice, entered on the wrong account, or dated outside the statement? Open the row to fix it.
                  {view.extra.some((r) => r.date.slice(0, 10) === view.periodTo)
                    ? ' Rows dated on the statement’s last day may simply not have been posted yet when the file was downloaded — download it again after the day ends.'
                    : ''}
                </CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody className="divide-y">
                    {view.extra.map((r) => (
                      <tr key={r.id}>
                        <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{formatDateUtc(r.date)}</td>
                        <td className="py-2 pr-3">
                          {r.description ?? FINANCE_CATEGORY_META[r.category].label}
                          {r.partyName ? <span className="text-muted-foreground"> · {r.partyName}</span> : null}
                          {r.date.slice(0, 10) === view.periodTo ? (
                            <span className="block text-[11px] text-muted-foreground">
                              Last day of the statement — may not be posted yet
                            </span>
                          ) : null}
                        </td>
                        <td
                          className={cn(
                            'py-2 pr-3 text-right tabular-nums',
                            r.direction === 'IN' ? 'text-status-green' : 'text-status-red',
                          )}
                        >
                          {r.direction === 'IN' ? '+' : '−'}
                          {formatInr(r.amount)}
                        </td>
                        <td className="py-2 text-right">
                          {canEdit ? (
                            <Link
                              href={`/finance/transactions/${r.id}`}
                              className="text-xs font-medium text-primary hover:underline"
                            >
                              Open
                            </Link>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ) : null}

          {view.dayMismatches.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Days where the balance differs</CardTitle>
                <CardDescription>
                  The first day listed is where to look — every later day carries the same gap until it is fixed.
                </CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Day</th>
                      <th className="py-2 pr-3 text-right font-medium">Bank</th>
                      <th className="py-2 pr-3 text-right font-medium">Panel</th>
                      <th className="py-2 text-right font-medium">Gap</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {view.dayMismatches.slice(0, 10).map((d) => (
                      <tr key={d.date}>
                        <td className="py-2 pr-3">{formatDateUtc(d.date)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{formatInr(d.statement)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{formatInr(d.ledger)}</td>
                        <td className="py-2 text-right font-medium tabular-nums text-status-red">{formatInr(d.difference)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ) : null}

          {view.skipped.length > 0 ? (
            <p className="text-xs text-status-amber">
              {view.skipped.length} line{view.skipped.length === 1 ? '' : 's'} could not be read:{' '}
              {view.skipped.map((s) => `line ${s.line} (${s.reason})`).join('; ')}.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Figure({ label, statement, ledger }: { label: string; statement: number | null; ledger: number }) {
  const same = statement === null || Math.abs(statement - ledger) < 0.01;
  return (
    <div className={cn('rounded-md border p-3', !same && 'border-status-red/50 bg-status-red/5')}>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm">
        <span className="text-muted-foreground">Bank </span>
        <span className="font-semibold tabular-nums">{statement === null ? '—' : formatInr(statement)}</span>
      </p>
      <p className="text-sm">
        <span className="text-muted-foreground">Panel </span>
        <span className={cn('font-semibold tabular-nums', !same && 'text-status-red')}>{formatInr(ledger)}</span>
      </p>
    </div>
  );
}
