'use client';

/**
 * Six-month income vs expense bar chart for the Finance overview.
 * Recharts is already a dependency (Marketing channel chart), so this
 * reuses the same token colours for consistency.
 */

import * as React from 'react';
import { BarChart3 } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { EmptyState } from '@/components/shared/EmptyState';
import { formatInr } from '@/lib/finance';

export interface TrendPoint {
  month: string;
  label: string;
  income: number;
  expense: number;
  net: number;
}

interface TooltipPayloadShape {
  label: string;
  income: number;
  expense: number;
  net: number;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: TooltipPayloadShape }>;
}

function abbreviateInr(value: number): string {
  if (!Number.isFinite(value)) return '₹0';
  const abs = Math.abs(value);
  if (abs >= 1_00_00_000) return `₹${(value / 1_00_00_000).toFixed(1)}Cr`;
  if (abs >= 1_00_000) return `₹${(value / 1_00_000).toFixed(1)}L`;
  if (abs >= 1_000) return `₹${(value / 1_000).toFixed(0)}k`;
  return `₹${value.toFixed(0)}`;
}

function ChartTooltip(props: ChartTooltipProps) {
  if (!props.active || !props.payload || props.payload.length === 0) {
    return null;
  }
  const data = props.payload[0]?.payload;
  if (!data) return null;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="mb-1 text-sm font-semibold">{data.label}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-muted-foreground">Income</dt>
        <dd className="text-right font-medium tabular-nums text-status-green">
          {formatInr(data.income)}
        </dd>
        <dt className="text-muted-foreground">Expense</dt>
        <dd className="text-right font-medium tabular-nums text-status-red">
          {formatInr(data.expense)}
        </dd>
        <dt className="text-muted-foreground">Net</dt>
        <dd className="text-right font-medium tabular-nums">
          {formatInr(data.net)}
        </dd>
      </dl>
    </div>
  );
}

export interface FinanceTrendChartProps {
  points: TrendPoint[];
}

export function FinanceTrendChart({ points }: FinanceTrendChartProps) {
  const hasData = points.some((p) => p.income > 0 || p.expense > 0);
  if (!hasData) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No trend yet"
        description="Record a few months of income and expenses and the trend will show up here."
        className="py-8"
      />
    );
  }

  const data = points.map((p) => ({
    ...p,
    // Short axis label: "Aug 26"
    axis: p.label.replace(/^(\w{3})\w* (\d{2})(\d{2})$/, '$1 $3'),
  }));

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
          barGap={4}
          barCategoryGap="25%"
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="hsl(var(--border))"
            vertical={false}
          />
          <XAxis
            dataKey="axis"
            stroke="hsl(var(--muted-foreground))"
            fontSize={12}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => abbreviateInr(v)}
          />
          <Tooltip
            content={<ChartTooltip />}
            cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
          />
          <Legend wrapperStyle={{ fontSize: '12px' }} iconType="circle" />
          <Bar
            dataKey="income"
            name="Income"
            fill="#16a34a"
            radius={[4, 4, 0, 0]}
          />
          <Bar
            dataKey="expense"
            name="Expense"
            fill="#dc2626"
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
