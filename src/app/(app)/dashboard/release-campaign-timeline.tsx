'use client';

/**
 * ReleaseCampaignTimeline — full-width Row 3 widget on the unified
 * dashboard (SPEC.md §11.1 row 3 — "Release + Campaign Timeline").
 *
 * Per SPEC.md §18.8 this is "the killer view the experts called out —
 * build it well", so it gets extra polish:
 *
 *   - Custom SVG layout (NOT Recharts). Recharts struggles with
 *     date-range bars on a continuous axis; an SVG with a fixed
 *     pixel-per-day ratio gives us precise placement for both
 *     campaign bars and release markers without fighting the chart
 *     library.
 *   - Hover tooltip showing campaign name, channel, date range,
 *     signups, and spent — appears on `mouseenter`/`focus` so the
 *     widget is keyboard-accessible (`tabIndex=0` per bar).
 *   - Releases drawn as full-height vertical lines with a tiny
 *     rotated label below — the SPEC describes these as the
 *     "vertical markers" punctuating the campaign rows.
 *   - Horizontally scrollable on narrow viewports (`overflow-x-auto`
 *     wrapper) so the 30-day window stays legible on mobile.
 *
 * Window: last 30 days, supplied by `loadTimeline()` in
 * `./loaders.ts`. Channel colors are inlined on the SVG `<rect>` —
 * Tailwind's JIT can't see dynamic class names, and we want exact
 * brand colors for ad channels anyway.
 */

import * as React from 'react';
import type { CampaignChannel } from '@prisma/client';
import { format } from 'date-fns';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { TimelineData } from './loaders';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Pixels of horizontal space per calendar day. 30 days × 24px = 720px
 *  wide, which fits comfortably on desktop and scrolls on mobile. */
const PX_PER_DAY = 24;

/** Vertical height of one campaign row, including its top/bottom
 *  padding. Matches the brief ("Each campaign row is ~24px tall"). */
const ROW_HEIGHT = 24;

/** Vertical padding between the bar's top and the row's top. */
const BAR_VPAD = 4;

/** Reserved space above the rows for date axis ticks + labels. */
const AXIS_HEIGHT = 32;

/** Reserved space below the rows for rotated release labels. */
const RELEASE_LABEL_HEIGHT = 56;

/** Left gutter inside the SVG for campaign-name labels. */
const LEFT_GUTTER = 160;

/** Right gutter inside the SVG so the rightmost bar isn't flush. */
const RIGHT_GUTTER = 8;

/** Tick spacing on the X axis, in days. Weekly ticks read cleanly on
 *  a 30-day window without crowding the labels. */
const TICK_EVERY_DAYS = 7;

/** Minimum visual width of a campaign bar (px) — prevents a 1-day
 *  campaign from collapsing to a hairline. */
const MIN_BAR_WIDTH = 6;

/** Minimum height of an empty-state container so the card doesn't
 *  shrink to nothing when there are no campaigns/releases. */
const EMPTY_STATE_MIN_HEIGHT = 160;

// ---------------------------------------------------------------------------
// Channel color palette (per task brief)
// ---------------------------------------------------------------------------

const CHANNEL_COLORS: Record<CampaignChannel, string> = {
  META_ADS: '#1877f2',
  GOOGLE_ADS: '#4285f4',
  INSTAGRAM_ORGANIC: '#e1306c',
  YOUTUBE: '#ff0000',
  INFLUENCER: '#a855f7',
  EMAIL: '#10b981',
  OTHER: '#6b7280',
};

const CHANNEL_LABELS: Record<CampaignChannel, string> = {
  META_ADS: 'Meta Ads',
  GOOGLE_ADS: 'Google Ads',
  INSTAGRAM_ORGANIC: 'Instagram',
  YOUTUBE: 'YouTube',
  INFLUENCER: 'Influencer',
  EMAIL: 'Email',
  OTHER: 'Other',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReleaseCampaignTimelineProps {
  data: TimelineData;
}

interface HoveredCampaign {
  /** Campaign id — also used as the React key. */
  id: string;
  name: string;
  channel: CampaignChannel;
  startDate: Date;
  endDate: Date | null;
  signups: number;
  spent: number;
  /** Anchor position (px) for the tooltip relative to the SVG container. */
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Geometry helpers (pure)
// ---------------------------------------------------------------------------

/** Number of whole days between `from` and `to` (can be fractional). */
function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return ms / (1000 * 60 * 60 * 24);
}

/** Clamp `value` to `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Convert a `Date` to its X pixel inside the SVG. */
function dateToX(date: Date, windowStart: Date): number {
  return LEFT_GUTTER + daysBetween(windowStart, date) * PX_PER_DAY;
}

/** Format the campaign date range for the tooltip. Open-ended
 *  campaigns show "ongoing" rather than a missing end. */
function formatDateRange(startDate: Date, endDate: Date | null): string {
  const start = format(startDate, 'MMM d');
  if (endDate === null) return `${start} – ongoing`;
  return `${start} – ${format(endDate, 'MMM d')}`;
}

/** Format INR currency for the tooltip — Indian numbering, no decimals. */
function formatInr(value: number): string {
  return `₹${new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value)}`;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/**
 * Renders the Release + Campaign timeline (SPEC §11.1 row 3).
 * Client component — needs hover/focus tooltip state.
 */
export function ReleaseCampaignTimeline({
  data,
}: ReleaseCampaignTimelineProps) {
  const { windowStart, windowEnd, campaigns, releases } = data;

  const [hovered, setHovered] = React.useState<HoveredCampaign | null>(null);

  const isEmpty = campaigns.length === 0 && releases.length === 0;

  // Total span in days, rounded up so we always paint to the right
  // edge of `windowEnd`.
  const totalDays = Math.max(1, Math.ceil(daysBetween(windowStart, windowEnd)));

  // SVG dimensions — width grows linearly with the day count; the
  // outer wrapper allows horizontal scroll on small viewports.
  const innerWidth = totalDays * PX_PER_DAY;
  const svgWidth = LEFT_GUTTER + innerWidth + RIGHT_GUTTER;
  const rowsHeight = Math.max(campaigns.length, 1) * ROW_HEIGHT;
  const svgHeight = AXIS_HEIGHT + rowsHeight + RELEASE_LABEL_HEIGHT;

  // Pre-compute X-axis ticks: every TICK_EVERY_DAYS, starting at day 0.
  const tickOffsets: number[] = [];
  for (let day = 0; day <= totalDays; day += TICK_EVERY_DAYS) {
    tickOffsets.push(day);
  }
  // Always include the right edge so the last label is anchored.
  if (tickOffsets[tickOffsets.length - 1] !== totalDays) {
    tickOffsets.push(totalDays);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Release + Campaign Timeline</CardTitle>
        <CardDescription>Last 30 days</CardDescription>
      </CardHeader>
      <CardContent>
        {isEmpty ? (
          <div
            className="flex items-center justify-center text-sm text-muted-foreground"
            style={{ minHeight: EMPTY_STATE_MIN_HEIGHT }}
          >
            No campaigns or releases in the last 30 days
          </div>
        ) : (
          <div className="relative overflow-x-auto">
            <svg
              role="img"
              aria-label={`Timeline of ${campaigns.length} campaigns and ${releases.length} releases over the last 30 days`}
              width={svgWidth}
              height={svgHeight}
              className="block"
              onMouseLeave={() => setHovered(null)}
            >
              {/* X-axis baseline + tick marks + date labels. */}
              <line
                x1={LEFT_GUTTER}
                x2={LEFT_GUTTER + innerWidth}
                y1={AXIS_HEIGHT}
                y2={AXIS_HEIGHT}
                stroke="hsl(var(--border))"
              />
              {tickOffsets.map((dayOffset) => {
                const tickDate = new Date(windowStart);
                tickDate.setDate(tickDate.getDate() + dayOffset);
                const x = LEFT_GUTTER + dayOffset * PX_PER_DAY;
                return (
                  <g key={`tick-${dayOffset}`}>
                    <line
                      x1={x}
                      x2={x}
                      y1={AXIS_HEIGHT - 4}
                      y2={AXIS_HEIGHT}
                      stroke="hsl(var(--border))"
                    />
                    <text
                      x={x}
                      y={AXIS_HEIGHT - 8}
                      textAnchor="middle"
                      className="fill-muted-foreground"
                      fontSize={10}
                    >
                      {format(tickDate, 'MMM d')}
                    </text>
                  </g>
                );
              })}

              {/* Campaign rows: name label + colored bar. */}
              {campaigns.map((campaign, rowIdx) => {
                const barStart = clamp(
                  campaign.startDate.getTime(),
                  windowStart.getTime(),
                  windowEnd.getTime(),
                );
                const barEndSource = campaign.endDate ?? windowEnd;
                const barEnd = clamp(
                  barEndSource.getTime(),
                  windowStart.getTime(),
                  windowEnd.getTime(),
                );
                const x1 = dateToX(new Date(barStart), windowStart);
                const x2 = dateToX(new Date(barEnd), windowStart);
                const width = Math.max(MIN_BAR_WIDTH, x2 - x1);
                const y = AXIS_HEIGHT + rowIdx * ROW_HEIGHT + BAR_VPAD;
                const barHeight = ROW_HEIGHT - BAR_VPAD * 2;
                const fill = CHANNEL_COLORS[campaign.channel];

                const onHoverShow = (
                  e: React.MouseEvent<SVGRectElement> | React.FocusEvent<SVGRectElement>,
                ) => {
                  setHovered({
                    id: campaign.id,
                    name: campaign.name,
                    channel: campaign.channel,
                    startDate: campaign.startDate,
                    endDate: campaign.endDate,
                    signups: campaign.signups,
                    spent: campaign.spent,
                    x: x1 + width / 2,
                    y: y,
                  });
                  // Avoid unused-event lint if React swaps the type;
                  // the variable is read for its side effect only.
                  void e;
                };
                const onHoverHide = () => setHovered(null);

                return (
                  <g key={campaign.id}>
                    {/* Row name label, truncated visually by the gutter
                        width (we don't measure text — long names get
                        clipped which is acceptable polish). */}
                    <text
                      x={LEFT_GUTTER - 8}
                      y={y + barHeight / 2 + 4}
                      textAnchor="end"
                      className="fill-foreground"
                      fontSize={12}
                    >
                      {campaign.name}
                    </text>
                    <rect
                      x={x1}
                      y={y}
                      width={width}
                      height={barHeight}
                      rx={4}
                      ry={4}
                      fill={fill}
                      tabIndex={0}
                      role="button"
                      aria-label={`${campaign.name}, ${CHANNEL_LABELS[campaign.channel]}, ${formatDateRange(campaign.startDate, campaign.endDate)}, ${campaign.signups} signups, ${formatInr(campaign.spent)} spent`}
                      onMouseEnter={onHoverShow}
                      onFocus={onHoverShow}
                      onMouseLeave={onHoverHide}
                      onBlur={onHoverHide}
                      style={{ cursor: 'pointer', outline: 'none' }}
                    />
                  </g>
                );
              })}

              {/* Release markers: full-height vertical line + rotated
                  label below the rows. */}
              {releases.map((release) => {
                const x = dateToX(release.releasedAt, windowStart);
                const labelText = [release.platform, release.releaseVersion]
                  .filter((s): s is string => Boolean(s))
                  .join(' ');
                return (
                  <g key={release.id}>
                    <line
                      x1={x}
                      x2={x}
                      y1={AXIS_HEIGHT}
                      y2={AXIS_HEIGHT + rowsHeight}
                      stroke="#0f172a"
                      strokeOpacity={0.6}
                      strokeDasharray="3 3"
                      strokeWidth={1.5}
                    />
                    <circle
                      cx={x}
                      cy={AXIS_HEIGHT}
                      r={3}
                      fill="#0f172a"
                    />
                    <text
                      x={x}
                      y={AXIS_HEIGHT + rowsHeight + 12}
                      textAnchor="start"
                      transform={`rotate(45 ${x} ${AXIS_HEIGHT + rowsHeight + 12})`}
                      className="fill-foreground"
                      fontSize={10}
                    >
                      {labelText || 'Release'}
                    </text>
                  </g>
                );
              })}
            </svg>

            {/* Tooltip. Positioned absolutely inside the scroll
                container so it tracks the bar even when the user
                scrolls. We offset the Y so it sits just above the
                hovered row without occluding it. */}
            {hovered !== null ? (
              <div
                role="tooltip"
                className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
                style={{ left: hovered.x, top: hovered.y - 4 }}
              >
                <div className="mb-1 text-sm font-semibold">{hovered.name}</div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                  <dt className="text-muted-foreground">Channel</dt>
                  <dd className="text-right font-medium">
                    {CHANNEL_LABELS[hovered.channel]}
                  </dd>
                  <dt className="text-muted-foreground">Dates</dt>
                  <dd className="text-right font-medium">
                    {formatDateRange(hovered.startDate, hovered.endDate)}
                  </dd>
                  <dt className="text-muted-foreground">Signups</dt>
                  <dd className="text-right font-medium tabular-nums">
                    {hovered.signups.toLocaleString('en-IN')}
                  </dd>
                  <dt className="text-muted-foreground">Spent</dt>
                  <dd className="text-right font-medium tabular-nums">
                    {formatInr(hovered.spent)}
                  </dd>
                </dl>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
