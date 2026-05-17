/**
 * Leads-scope metrics aggregation for AI insights (SPEC.md §10.3 — "Leads scope").
 *
 * `aggregateLeads` snapshots pipeline health over a 7-day window vs. the
 * prior 7 days:
 *
 *   - `summary`            — new leads, conversions, and conversion rate
 *                            for the current and previous period.
 *   - `bySource`           — leads created in the period, grouped by
 *                            `LeadSource`.
 *   - `statusDistribution` — count of leads per `LeadStatus`, restricted
 *                            to leads created in the period (so the
 *                            distribution describes the cohort Claude is
 *                            analysing, not the all-time pipeline).
 *   - `ownerWorkload`      — per-owner totals + open count. Includes a
 *                            synthetic "Unassigned" row for `ownerId IS NULL`.
 *   - `lostReasons`        — counts of the keywords `'expensive'`,
 *                            `'not interested'`, `'competitor'` (plus
 *                            `'other'` for the remainder) found in the
 *                            `notes` column of LOST leads and in any
 *                            `Note` row attached to those leads.
 *
 * The keyword scan is deliberately simple (case-insensitive substring
 * match) — exactly what SPEC.md §10.3 calls out for the "simple version"
 * of lost-reason detection. Each LOST lead contributes to **one** bucket:
 * the first matching keyword wins, otherwise it falls into `'other'`.
 *
 * The function is dependency-injected: pass a `PrismaClient` or
 * `Prisma.TransactionClient`. The return value is plain JSON (no `Date`,
 * no `BigInt`) so it can be persisted in `AIInsight.rawData` and shipped
 * to Claude without further serialisation.
 */

import type { LeadStatus, Prisma, PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LeadsDbClient = PrismaClient | Prisma.TransactionClient;

export type LostReasonKeyword =
  | 'expensive'
  | 'not interested'
  | 'competitor'
  | 'other';

export interface LeadsBySource {
  source: string;
  count: number;
}

export interface LeadsOwnerWorkload {
  /** `null` for the synthetic "Unassigned" bucket. */
  ownerId: string | null;
  /** `'Unassigned'` when `ownerId` is null. */
  ownerName: string;
  totalLeads: number;
  openLeads: number;
}

export interface LeadsLostReason {
  keyword: LostReasonKeyword;
  count: number;
}

export interface LeadsAggregate {
  summary: {
    newLeads: number;
    newLeadsPrev: number;
    conversions: number;
    conversionsPrev: number;
    /** `conversions / newLeads`; `null` when newLeads is 0. */
    conversionRate: number | null;
    conversionRatePrev: number | null;
  };
  bySource: LeadsBySource[];
  statusDistribution: Record<LeadStatus, number>;
  ownerWorkload: LeadsOwnerWorkload[];
  lostReasons: LeadsLostReason[];
}

/** A lead is "open" when it is neither converted nor lost. */
const OPEN_STATUSES: readonly LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'INTERESTED',
  'FOLLOW_UP',
];

const ALL_STATUSES: readonly LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'INTERESTED',
  'FOLLOW_UP',
  'CONVERTED',
  'LOST',
];

const KEYWORD_ORDER: readonly Exclude<LostReasonKeyword, 'other'>[] = [
  'expensive',
  'not interested',
  'competitor',
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Snapshot lead-pipeline metrics for a 7-day window vs. the prior 7 days.
 *
 * @param prisma       any client satisfying {@link LeadsDbClient} (DI).
 * @param periodStart  inclusive lower bound for the current window.
 * @param periodEnd    inclusive upper bound for the current window.
 * @param prevStart    inclusive lower bound for the previous window.
 * @param prevEnd      inclusive upper bound for the previous window.
 * @returns a JSON-serialisable {@link LeadsAggregate} ready for Claude.
 */
export async function aggregateLeads(
  prisma: LeadsDbClient,
  periodStart: Date,
  periodEnd: Date,
  prevStart: Date,
  prevEnd: Date,
): Promise<LeadsAggregate> {
  const createdInCurrent: Prisma.LeadWhereInput = {
    createdAt: { gte: periodStart, lte: periodEnd },
  };
  const createdInPrevious: Prisma.LeadWhereInput = {
    createdAt: { gte: prevStart, lte: prevEnd },
  };
  const convertedInCurrent: Prisma.LeadWhereInput = {
    convertedAt: { gte: periodStart, lte: periodEnd },
  };
  const convertedInPrevious: Prisma.LeadWhereInput = {
    convertedAt: { gte: prevStart, lte: prevEnd },
  };

  const [
    newLeads,
    newLeadsPrev,
    conversions,
    conversionsPrev,
    bySourceRaw,
    statusRaw,
    ownerRaw,
    lostLeads,
  ] = await Promise.all([
    prisma.lead.count({ where: createdInCurrent }),
    prisma.lead.count({ where: createdInPrevious }),
    prisma.lead.count({ where: convertedInCurrent }),
    prisma.lead.count({ where: convertedInPrevious }),
    prisma.lead.groupBy({
      by: ['source'],
      where: createdInCurrent,
      _count: { _all: true },
    }),
    prisma.lead.groupBy({
      by: ['status'],
      where: createdInCurrent,
      _count: { _all: true },
    }),
    // Workload is a snapshot of *current* assignment, not of leads created
    // in the window — we want to tell Claude how loaded each owner is now.
    prisma.lead.groupBy({
      by: ['ownerId', 'status'],
      _count: { _all: true },
    }),
    prisma.lead.findMany({
      where: { status: 'LOST' },
      select: { id: true, notes: true },
    }),
  ]);

  // Owner names are looked up after the workload groupBy so we can join
  // them in a single follow-up query (rather than per-row).
  const ownerIds = uniqueDefined(ownerRaw.map((r) => r.ownerId));
  const [owners, lostNotes] = await Promise.all([
    ownerIds.length > 0
      ? prisma.user.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([] as { id: string; name: string }[]),
    lostLeads.length > 0
      ? prisma.note.findMany({
          where: {
            entityType: 'lead',
            entityId: { in: lostLeads.map((l) => l.id) },
          },
          select: { entityId: true, body: true },
        })
      : Promise.resolve([] as { entityId: string; body: string }[]),
  ]);

  // bySource — sort biggest first for prompt readability.
  const bySource: LeadsBySource[] = bySourceRaw
    .map((r) => ({ source: r.source, count: r._count._all }))
    .sort((a, b) => b.count - a.count);

  // statusDistribution — fill every status so consumers can rely on the
  // shape (`Record<LeadStatus, number>`).
  const statusDistribution: Record<LeadStatus, number> = Object.fromEntries(
    ALL_STATUSES.map((s) => [s, 0]),
  ) as Record<LeadStatus, number>;
  for (const r of statusRaw) {
    statusDistribution[r.status] = r._count._all;
  }

  // ownerWorkload — fold (ownerId, status) groups into per-owner totals.
  const ownerWorkload = buildOwnerWorkload(ownerRaw, owners);

  // lostReasons — keyword scan over LOST leads' notes + their Note rows.
  const lostReasons = scanLostReasons(lostLeads, lostNotes);

  return {
    summary: {
      newLeads,
      newLeadsPrev,
      conversions,
      conversionsPrev,
      conversionRate: rate(conversions, newLeads),
      conversionRatePrev: rate(conversionsPrev, newLeadsPrev),
    },
    bySource,
    statusDistribution,
    ownerWorkload,
    lostReasons,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers (pure)
// ---------------------------------------------------------------------------

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

function uniqueDefined(values: readonly (string | null)[]): string[] {
  const seen = new Set<string>();
  for (const v of values) {
    if (v !== null) seen.add(v);
  }
  return [...seen];
}

function buildOwnerWorkload(
  groups: readonly {
    ownerId: string | null;
    status: LeadStatus;
    _count: { _all: number };
  }[],
  owners: readonly { id: string; name: string }[],
): LeadsOwnerWorkload[] {
  const nameById = new Map(owners.map((o) => [o.id, o.name]));
  const acc = new Map<
    string, // ownerId or '__unassigned'
    { ownerId: string | null; ownerName: string; totalLeads: number; openLeads: number }
  >();

  for (const g of groups) {
    const key = g.ownerId ?? '__unassigned';
    const existing = acc.get(key) ?? {
      ownerId: g.ownerId,
      ownerName:
        g.ownerId === null
          ? 'Unassigned'
          : nameById.get(g.ownerId) ?? `User ${g.ownerId}`,
      totalLeads: 0,
      openLeads: 0,
    };
    existing.totalLeads += g._count._all;
    if (OPEN_STATUSES.includes(g.status)) {
      existing.openLeads += g._count._all;
    }
    acc.set(key, existing);
  }

  return [...acc.values()]
    // Stable ordering — most loaded owners first; Unassigned ranks by
    // its own total like any other bucket.
    .sort((a, b) => b.totalLeads - a.totalLeads || b.openLeads - a.openLeads);
}

function scanLostReasons(
  lostLeads: readonly { id: string; notes: string | null }[],
  lostNotes: readonly { entityId: string; body: string }[],
): LeadsLostReason[] {
  // Build "all relevant text per lead" so each lost lead contributes to
  // exactly one bucket — first keyword to match wins.
  const textByLead = new Map<string, string>();
  for (const lead of lostLeads) {
    textByLead.set(lead.id, (lead.notes ?? '').toLowerCase());
  }
  for (const note of lostNotes) {
    const prev = textByLead.get(note.entityId) ?? '';
    textByLead.set(note.entityId, `${prev} ${note.body.toLowerCase()}`);
  }

  const counts: Record<LostReasonKeyword, number> = {
    expensive: 0,
    'not interested': 0,
    competitor: 0,
    other: 0,
  };

  for (const [, text] of textByLead) {
    const matched = KEYWORD_ORDER.find((kw) => text.includes(kw));
    counts[matched ?? 'other'] += 1;
  }

  return (
    [
      'expensive',
      'not interested',
      'competitor',
      'other',
    ] as const
  ).map((keyword) => ({ keyword, count: counts[keyword] }));
}
