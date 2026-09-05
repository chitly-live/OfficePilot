'use client';

/**
 * "Export" button + dialog for the Finance report. Picks a period (month,
 * custom range, or all time) and a format (Excel / PDF), then navigates to
 * `/api/finance/export?…` which answers with a file download.
 */

import * as React from 'react';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

import { ALL_MONTHS, currentLocalMonthKey } from './finance-ui';

type Period = 'month' | 'range' | 'all';
type Format = 'xlsx' | 'pdf';

export interface ExportDialogProps {
  /** `'YYYY-MM'` to preselect, or `'all'`. */
  defaultMonth?: string;
}

function isMonthKey(v: string | undefined): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}$/.test(v);
}

export function ExportDialog({ defaultMonth }: ExportDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [period, setPeriod] = React.useState<Period>(
    defaultMonth === ALL_MONTHS ? 'all' : 'month',
  );
  const [month, setMonth] = React.useState(
    isMonthKey(defaultMonth) ? defaultMonth : currentLocalMonthKey(),
  );
  const [dateFrom, setDateFrom] = React.useState('');
  const [dateTo, setDateTo] = React.useState('');
  const [format, setFormat] = React.useState<Format>('xlsx');

  const params = new URLSearchParams({ format });
  if (period === 'month') params.set('month', month);
  else if (period === 'all') params.set('all', '1');
  else {
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
  }
  const href = `/api/finance/export?${params.toString()}`;

  const rangeInvalid =
    period === 'range' &&
    ((dateFrom === '' && dateTo === '') || (dateFrom !== '' && dateTo !== '' && dateFrom > dateTo));
  const monthInvalid = period === 'month' && !isMonthKey(month);
  const disabled = rangeInvalid || monthInvalid;

  function handleDownload() {
    if (disabled) return;
    toast.success(
      `Preparing ${format === 'pdf' ? 'PDF' : 'Excel'} report…`,
      { description: 'The download starts in a moment.' },
    );
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Download className="h-4 w-4" aria-hidden="true" />
          <span>Export</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Export finance report</DialogTitle>
          <DialogDescription>
            Summary, category totals, accounts, outstanding balances and every
            transaction for the period. Ready to send to the accountant.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Period */}
          <div className="space-y-2">
            <Label className="text-xs">Period</Label>
            <div role="radiogroup" aria-label="Period" className="grid grid-cols-3 gap-2">
              {(
                [
                  ['month', 'Month'],
                  ['range', 'Date range'],
                  ['all', 'All time'],
                ] as Array<[Period, string]>
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={period === value}
                  onClick={() => setPeriod(value)}
                  className={cn(
                    'rounded-md border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    period === value
                      ? 'border-brand-600 bg-brand-600/10 text-brand-600'
                      : 'bg-background text-muted-foreground hover:bg-accent',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {period === 'month' ? (
              <div className="space-y-1">
                <Label htmlFor="export-month" className="text-xs">
                  Month
                </Label>
                <Input
                  id="export-month"
                  type="month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                />
              </div>
            ) : null}

            {period === 'range' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="export-from" className="text-xs">
                    From
                  </Label>
                  <Input
                    id="export-from"
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="export-to" className="text-xs">
                    To
                  </Label>
                  <Input
                    id="export-to"
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                  />
                </div>
                {rangeInvalid ? (
                  <p className="text-xs text-destructive sm:col-span-2">
                    Pick at least one date, and make sure From is not after To.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Format */}
          <div className="space-y-2">
            <Label className="text-xs">Format</Label>
            <div role="radiogroup" aria-label="Format" className="grid grid-cols-2 gap-2">
              <button
                type="button"
                role="radio"
                aria-checked={format === 'xlsx'}
                onClick={() => setFormat('xlsx')}
                className={cn(
                  'flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  format === 'xlsx'
                    ? 'border-status-green bg-status-green/10 text-status-green'
                    : 'bg-background text-muted-foreground hover:bg-accent',
                )}
              >
                <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
                Excel (.xlsx)
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={format === 'pdf'}
                onClick={() => setFormat('pdf')}
                className={cn(
                  'flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  format === 'pdf'
                    ? 'border-status-red bg-status-red/10 text-status-red'
                    : 'bg-background text-muted-foreground hover:bg-accent',
                )}
              >
                <FileText className="h-4 w-4" aria-hidden="true" />
                PDF
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Excel has three sheets (Summary, Transactions, Parties). PDF is print-ready
              with page numbers. Company name and address come from Settings → App.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button asChild disabled={disabled}>
            <a
              href={disabled ? undefined : href}
              download
              onClick={handleDownload}
              aria-disabled={disabled}
              className={cn(disabled && 'pointer-events-none opacity-50')}
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              <span>Download {format === 'pdf' ? 'PDF' : 'Excel'}</span>
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
