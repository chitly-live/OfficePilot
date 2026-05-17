'use client';

/**
 * ChannelComparisonChart — Recharts bar chart of spend vs leads per
 * channel for the last 30 days (SPEC §7.2.6, task 47).
 *
 * Receives the already-rolled-up channel rows from the parent server
 * page (which fetched directly via Prisma using the same shape as
 * `GET /api/campaigns/comparison`). We render a grouped bar chart
 * with two series:
 *
 *   • Spend (₹)   — left Y axis, currency-formatted ticks.
 *   • Leads       — right Y axis, integer-count ticks.
 *
 * Two axes because spend is in INR (often ₹10k+) and leads is a small
 * count — sharing a single axis would compress the leads bars to
 * invisibility. The tooltip surfaces both raw values along with CAC
 * (₹/conversion) when available.
 *
 * Empty state: when no channels ran in the window, render a designed
 * empty state instead of a flat chart so users get a clear "nothing
 * to compare yet" message.
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
import type { CampaignChannel } from '@prisma/client';

import { EmptyState } from '@/components/shared/EmptyState';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-channel row shape — matches the response of
 * `GET /api/campaigns/comparison`. We re-declare it here (rather than
 * importing from the route module) because route handlers shouldn't
 * be imported into the client bundle.
 */
export interface ChannelComparisonRow {
  channel: CampaignChannel;
  campaignCount: number;
  totalSpent: number;
  totalLeads: number;
  totalConversions: number;
  /** null when totalConversions === 0. */
  cac: number | null;
  /** null when totalLeads === 0. */
  cpl: number | null;
  /** null when totalLeads === 0. */
  conversionRate: number | null;
}

export interface ChannelComparisonChartProps {
  rows: ChannelComparisonRow[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Friendly display label for `CampaignChannel`. */
const CHANNEL_LABELS: Record<CampaignChannel, string> = {
  META_ADS: 'Meta',
  GOOGLE_ADS: 'Google',
  INSTAGRAM_ORGANIC: 'IG Organic',
  YOUTUBE: 'YouTube',
  INFLUENCER: 'Influencer',
  EMAIL: 'Email',
  OTHER: 'Other',
};

/**
 * Format an INR value with the Indian numbering convention. We
 * abbreviate large numbers on the axis ticks to keep the chart
 * readable (₹1.2L for 1,20,000).
 */
function formatInr(value: number, options?: { abbreviate?: boolean }): string {
  if (!Number.isFinite(value)) return '₹0';
  if (options?.abbreviate) {
    if (value >= 1_00_00_000) {
      return `₹${(value / 1_00_00_000).toFixed(1)}Cr`;
    }
    if (value >= 1_00_000) {
      return `₹${(value / 1_00_000).toFixed(1)}L`;
    }
    if (value >= 1_000) {
      return `₹${(value / 1_000).toFixed(1)}k`;
    }
    return `₹${value.toFixed(0)}`;
  }
  return `₹${new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value)}`;
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

interface TooltipPayloadShape {
  channel: string;
  channelKey: CampaignChannel;
  spend: number;
  leads: number;
  conversions: number;
  cac: number | null;
  cpl: number | null;
  conversionRate: number | null;
  campaigns: number;
}

/**
 * Custom tooltip body. Recharts' `content` prop passes a payload of
 * the rendered series; we read the underlying data row off the
 * first entry's `payload` (every series points back to the same
 * `data[i]`).
 */
interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: TooltipPayloadShape }>;
}

function ChartTooltip(props: ChartTooltipProps) {
  if (!props.active || !props.payload || props.payload.length === 0) {
    return null;
  }
  const data = props.payload[0]?.payload;
  if (!data) return null;

  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="mb-1 text-sm font-semibold">{data.channel}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-muted-foreground">Spend</dt>
        <dd className="text-right font-medium tabular-nums">
          {formatInr(data.spend)}
        </dd>
        <dt className="text-muted-foreground">Leads</dt>
        <dd className="text-right font-medium tabular-nums">
          {data.leads.toLocaleString('en-IN')}
        </dd>
        <dt className="text-muted-foreground">Conversions</dt>
        <dd className="text-right font-medium tabular-nums">
          {data.conversions.toLocaleString('en-IN')}
        </dd>
        <dt className="text-muted-foreground">CAC</dt>
        <dd className="text-right font-medium tabular-nums">
          {data.cac === null ? '—' : formatInr(data.cac)}
        </dd>
        <dt className="text-muted-foreground">CPL</dt>
        <dd className="text-right font-medium tabular-nums">
          {data.cpl === null ? '—' : formatInr(data.cpl)}
        </dd>
        <dt className="text-muted-foreground">Campaigns</dt>
        <dd className="text-right font-medium tabular-nums">
          {data.campaigns}
        </dd>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function ChannelComparisonChart({
  rows,
}: ChannelComparisonChartProps) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No channel data yet"
        description="Once campaigns start running and tagged leads come in, channel performance will show up here."
      />
    );
  }

  const data: TooltipPayloadShape[] = rows.map((row) => ({
    channel: CHANNEL_LABELS[row.channel],
    channelKey: row.channel,
    spend: row.totalSpent,
    leads: row.totalLeads,
    conversions: row.totalConversions,
    cac: row.cac,
    cpl: row.cpl,
    conversionRate: row.conversionRate,
    campaigns: row.campaignCount,
  }));

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
          barGap={4}
          barCategoryGap="20%"
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="hsl(var(--border))"
            vertical={false}
          />
          <XAxis
            dataKey="channel"
            stroke="hsl(var(--muted-foreground))"
            fontSize={12}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            yAxisId="spend"
            orientation="left"
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => formatInr(v, { abbreviate: true })}
          />
          <YAxis
            yAxisId="leads"
            orientation="right"
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <Tooltip
            content={<ChartTooltip />}
            cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
          />
          <Legend
            wrapperStyle={{ fontSize: '12px' }}
            iconType="circle"
          />
          {/* Brand indigo (#4f46e5) for spend, status green (#16a34a) for
              leads — both sourced from `tailwind.config.ts` token map. */}
          <Bar
            yAxisId="spend"
            dataKey="spend"
            name="Spend (₹)"
            fill="#4f46e5"
            radius={[4, 4, 0, 0]}
          />
          <Bar
            yAxisId="leads"
            dataKey="leads"
            name="Leads"
            fill="#16a34a"
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
