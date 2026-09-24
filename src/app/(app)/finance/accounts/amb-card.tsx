/**
 * Average monthly balance tracker for bank accounts that have a
 * requirement set. Server component — all figures arrive computed.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { AMB_STATUS_LABELS, type AmbStatus } from '@/lib/amb';
import { formatInr, monthLabel } from '@/lib/finance';
import type { AccountAmb } from '@/lib/finance-amb';
import { cn } from '@/lib/utils';

const TONE: Record<AmbStatus, 'green' | 'amber' | 'red' | 'neutral'> = {
  ON_TRACK: 'green',
  DONE_OK: 'green',
  AT_RISK: 'amber',
  SHORT: 'red',
  DONE_SHORT: 'red',
  NOT_SET: 'neutral',
};

export function AmbCard({ items, month }: { items: AccountAmb[]; month: string }) {
  if (items.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Average monthly balance — {monthLabel(month)}
        </CardTitle>
        <CardDescription>
          The bank adds up the closing balance of every day in the month, weekends
          included, and divides by the number of days. Miss the target and it charges a
          non-maintenance fee plus GST.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {items.map((a) => (
            <li key={a.accountId} className="space-y-2 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-foreground">{a.accountName}</span>
                <StatusBadge status={a.status} tone={TONE[a.status]} label={AMB_STATUS_LABELS[a.status]} />
              </div>

              <div className="grid gap-3 text-sm sm:grid-cols-4">
                <Figure
                  label={`Average (${a.daysCounted} of ${a.daysInMonth} days)`}
                  value={formatInr(a.averageSoFar)}
                  tone={a.averageSoFar >= a.required ? 'green' : 'red'}
                />
                <Figure label="Required" value={formatInr(a.required)} />
                <Figure label="Balance today" value={formatInr(a.closingBalance)} />
                {a.daysRemaining > 0 ? (
                  <Figure
                    label={`Needed for the last ${a.daysRemaining} day${a.daysRemaining === 1 ? '' : 's'}`}
                    value={a.neededDailyBalance !== null ? formatInr(a.neededDailyBalance) : '—'}
                    tone={
                      a.neededDailyBalance !== null && a.neededDailyBalance > a.closingBalance
                        ? 'red'
                        : 'green'
                    }
                  />
                ) : (
                  <Figure
                    label="Month-end average"
                    value={formatInr(a.projectedAverage)}
                    tone={a.projectedAverage >= a.required ? 'green' : 'red'}
                  />
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                {a.daysRemaining === 0
                  ? a.status === 'DONE_OK'
                    ? 'Target met for the month.'
                    : `Short by ${formatInr(a.projectedShortfall)} on average — expect a non-maintenance charge.`
                  : a.neededDailyBalance !== null && a.neededDailyBalance > a.closingBalance
                    ? `Keep at least ${formatInr(a.neededDailyBalance)} in the account for the remaining ${a.daysRemaining} day${a.daysRemaining === 1 ? '' : 's'} — that is ${formatInr(a.neededDailyBalance - a.closingBalance)} more than today's balance.`
                    : `Holding today's balance keeps the month on target (projected ${formatInr(a.projectedAverage)}).`}
              </p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'green' | 'red';
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          'font-semibold tabular-nums',
          tone === 'green' && 'text-status-green',
          tone === 'red' && 'text-status-red',
        )}
      >
        {value}
      </div>
    </div>
  );
}
