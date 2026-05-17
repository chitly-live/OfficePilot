/**
 * Zod schemas + DTO types for the Marketing / Campaigns module
 * (SPEC.md §7, Prisma `Campaign` model in §3).
 *
 * Single source of truth for validating request payloads and query
 * strings on:
 *
 *   • POST   /api/campaigns                 → `campaignCreateSchema`
 *   • PATCH  /api/campaigns/[id]            → `campaignUpdateSchema`
 *   • GET    /api/campaigns                 → `campaignListQuerySchema`
 *   • GET    /api/campaigns/comparison      → `campaignComparisonQuerySchema`
 *   • GET    /api/campaigns/[id]/leads      → `campaignLeadsQuerySchema`
 *
 * Reused by the corresponding `react-hook-form` forms via
 * `@hookform/resolvers/zod` so client and server share one validation
 * contract (SPEC.md §13.5 — never trust client-only validation).
 *
 * `campaignPublicProjection` is a Prisma `select` mask used by every
 * read endpoint that returns a campaign so that the embedded owner is
 * included consistently (and `passwordHash` is implicitly excluded
 * since the embedded owner only exposes the safe `userPublicProjection`
 * columns).
 *
 * Implements task 40 of `.kiro/specs/officepilot/tasks.md`.
 */

import { z } from 'zod';
import { CampaignChannel, CampaignStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// Field-level constants
// ---------------------------------------------------------------------------

const MAX_NAME_LENGTH = 200;
const MAX_NOTES_LENGTH = 5000;
const MAX_UTM_FIELD_LENGTH = 200;
const MAX_SEARCH_LENGTH = 200;

/** SPEC.md §3 stores campaign budget/spend as Float (INR). ₹100 cr is
 *  almost certainly a typo above this ceiling. */
const MAX_MONEY = 1_000_000_000;
/** Counter columns are Int — guard against accidental overflow / typos
 *  by capping at ~2 billion (Postgres `INTEGER` is 32-bit). */
const MAX_COUNTER = 2_000_000_000;

const DEFAULT_PAGE = 1;
/** SPEC.md §6.3 baseline (50/page) reused for /api/campaigns. The
 *  prompt for task 41 caps pageSize at 100 — campaigns volume is
 *  smaller than leads. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Reusable field schemas
// ---------------------------------------------------------------------------

const nameField = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(MAX_NAME_LENGTH, `Name must be ${MAX_NAME_LENGTH} characters or fewer`);

/**
 * UTM values are passed through verbatim to the URL (see
 * `src/lib/utm.ts`). We trim and cap length but otherwise keep the
 * field permissive — the UTM generator in `/marketing/utm` is what
 * normalises casing and spaces.
 */
const utmField = z
  .string()
  .trim()
  .min(1, 'UTM value cannot be empty')
  .max(MAX_UTM_FIELD_LENGTH, `UTM value must be ${MAX_UTM_FIELD_LENGTH} characters or fewer`);

const notesField = z
  .string()
  .max(MAX_NOTES_LENGTH, `Notes must be ${MAX_NOTES_LENGTH} characters or fewer`);

/** Strictly-positive INR budget (SPEC.md §7.4 — every campaign needs a
 *  budget to compute CAC against). */
const budgetField = z
  .number()
  .finite('Budget must be a finite number')
  .positive('Budget must be greater than zero')
  .max(MAX_MONEY, `Budget must be ${MAX_MONEY} or less`);

/** Spend can be zero (a brand-new campaign hasn't burnt anything yet)
 *  but never negative. */
const spentField = z
  .number()
  .finite('Spent must be a finite number')
  .min(0, 'Spent must be non-negative')
  .max(MAX_MONEY, `Spent must be ${MAX_MONEY} or less`);

/** Non-negative integer counters for impressions/clicks/signups/conversions. */
const counterField = z
  .number()
  .int('Must be an integer')
  .min(0, 'Must be non-negative')
  .max(MAX_COUNTER, `Must be ${MAX_COUNTER} or less`);

/** Prisma `cuid()` IDs are 25 chars starting with `c`. We keep the regex
 *  loose so legacy IDs / future format changes don't break — we just
 *  guarantee non-empty + reasonable length. */
const idField = z.string().trim().min(1, 'ID is required').max(64);

/**
 * Accepts an ISO-8601 datetime string (e.g. `"2026-05-16T03:00:00Z"`)
 * or a `Date` object and yields a `Date`. `z.coerce.date()` covers both
 * cases — `new Date(string)` for strings, identity for Date inputs —
 * while still rejecting nonsense like `"not a date"` (which yields an
 * Invalid Date that Zod catches).
 */
const isoDateTimeField = z.coerce.date();

const channelField = z.nativeEnum(CampaignChannel);
const statusField = z.nativeEnum(CampaignStatus);

// ---------------------------------------------------------------------------
// 1. POST /api/campaigns
// ---------------------------------------------------------------------------

/**
 * Body schema for `POST /api/campaigns` (SPEC.md §7.3, §7.4).
 *
 * The route handler (task 41) is responsible for:
 *   1. Auth guard — unauthenticated → 401 (middleware), unauthorized → 403.
 *   2. Resolving `ownerId`:
 *        • If body.ownerId is set, use it (subject to RBAC check below).
 *        • Otherwise default to `session.userId`.
 *   3. RBAC: EMPLOYEE may only create campaigns owned by themselves;
 *      ADMIN may assign to anyone (SPEC.md §2.1).
 *   4. Calling `logActivity(..., 'campaign.created', ...)`.
 *   5. Translating Prisma P2002 (unique violation on `utmCampaign`)
 *      into a 409 conflict.
 *
 * `endDate >= startDate` is enforced here so both POST and PATCH can
 * reject inverted ranges before they ever hit Prisma.
 */
export const campaignCreateSchema = z
  .object({
    name: nameField,
    channel: channelField,
    status: statusField.default(CampaignStatus.DRAFT),
    startDate: isoDateTimeField,
    endDate: isoDateTimeField.optional(),
    budget: budgetField,
    spent: spentField.default(0),
    impressions: counterField.default(0),
    clicks: counterField.default(0),
    signups: counterField.default(0),
    conversions: counterField.default(0),
    notes: notesField.optional(),
    utmSource: utmField.optional(),
    utmMedium: utmField.optional(),
    /** Stored unique on `Campaign.utmCampaign` (SPEC.md §3) — the route
     *  handler maps Prisma P2002 → 409. */
    utmCampaign: utmField.optional(),
    ownerId: idField.optional(),
  })
  .refine(
    (value) =>
      value.endDate === undefined || value.endDate >= value.startDate,
    { message: 'endDate must be on or after startDate', path: ['endDate'] },
  );

export type CampaignCreateInput = z.infer<typeof campaignCreateSchema>;

// ---------------------------------------------------------------------------
// 2. PATCH /api/campaigns/[id]
// ---------------------------------------------------------------------------

/**
 * Body schema for `PATCH /api/campaigns/[id]` (SPEC.md §7.3).
 *
 *   • `id` lives on the URL, not in the body.
 *   • Every field is optional — the route handler should treat the
 *     payload as a partial update (Prisma `update({ data })` semantics).
 *   • The route handler emits different activity log entries depending
 *     on what changed:
 *       - `spent` change            → CAMPAIGN_SPENT_UPDATED `{delta}`.
 *       - any of `impressions`,
 *         `clicks`, `signups`,
 *         `conversions` change      → CAMPAIGN_METRICS_UPDATED `{fields}`.
 *       - everything else           → CAMPAIGN_UPDATED.
 *   • `endDate >= startDate` is re-checked when both are present so the
 *     PATCH path can't introduce an inverted range either.
 *   • `ownerId` reassignment is gated by RBAC in the route handler
 *     (admin-only, parallels the leads behaviour in SPEC.md §6.4).
 *
 * Reject empty PATCH bodies — they're almost always a client bug, and
 * an "update with no changes" round-trips a row through Prisma for
 * nothing.
 */
export const campaignUpdateSchema = z
  .object({
    name: nameField.optional(),
    channel: channelField.optional(),
    status: statusField.optional(),
    startDate: isoDateTimeField.optional(),
    endDate: isoDateTimeField.nullable().optional(),
    budget: budgetField.optional(),
    spent: spentField.optional(),
    impressions: counterField.optional(),
    clicks: counterField.optional(),
    signups: counterField.optional(),
    conversions: counterField.optional(),
    notes: notesField.nullable().optional(),
    utmSource: utmField.nullable().optional(),
    utmMedium: utmField.nullable().optional(),
    utmCampaign: utmField.nullable().optional(),
    ownerId: idField.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  })
  .refine(
    (value) =>
      value.startDate === undefined ||
      value.endDate === undefined ||
      value.endDate === null ||
      value.endDate >= value.startDate,
    { message: 'endDate must be on or after startDate', path: ['endDate'] },
  );

export type CampaignUpdateInput = z.infer<typeof campaignUpdateSchema>;

// ---------------------------------------------------------------------------
// 3. GET /api/campaigns — list with filters + pagination
// ---------------------------------------------------------------------------

/**
 * Comma-separated multi-value parser for query params.
 * `?status=DRAFT,ACTIVE` yields `['DRAFT', 'ACTIVE']`; `?status=DRAFT`
 * yields `['DRAFT']`. Empty/missing yields `undefined`. Each value is
 * trimmed; empty pieces are dropped so trailing commas don't pollute
 * the result.
 *
 * Mirrors the helper used in `src/lib/schemas/leads.ts` so the two
 * modules behave identically on multi-value query strings.
 */
function multiEnum<T extends [string, ...string[]]>(values: T) {
  const single = z.enum(values);
  const multi = z.array(single).min(1);
  return z
    .union([single, multi, z.string()])
    .transform((val, ctx): z.infer<typeof single>[] => {
      if (Array.isArray(val)) return val;
      const parts = String(val)
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const out: z.infer<typeof single>[] = [];
      for (const part of parts) {
        const parsed = single.safeParse(part);
        if (!parsed.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid value: ${part}`,
          });
          return z.NEVER;
        }
        out.push(parsed.data);
      }
      if (out.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'At least one value is required',
        });
        return z.NEVER;
      }
      return out;
    });
}

const campaignStatusValues = Object.values(CampaignStatus) as [
  CampaignStatus,
  ...CampaignStatus[],
];
const campaignChannelValues = Object.values(CampaignChannel) as [
  CampaignChannel,
  ...CampaignChannel[],
];

/** Allowed `sortBy` keys — friendly aliases that the route handler maps
 *  to actual Prisma columns. */
export const CAMPAIGN_SORT_KEYS = [
  'created',
  'updated',
  'startDate',
  'budget',
  'spent',
  'conversions',
] as const;
export type CampaignSortKey = (typeof CAMPAIGN_SORT_KEYS)[number];

const campaignSortKeyField = z.enum(CAMPAIGN_SORT_KEYS);
const sortDirField = z.enum(['asc', 'desc']);

/**
 * Query-string schema for `GET /api/campaigns` (SPEC.md §7.1, §7.3).
 *
 * Conventions:
 *   • Query params arrive as strings (or `undefined`). `z.coerce` turns
 *     `"42"` into `42` and a missing param into the `default()`.
 *   • Multi-value filters accept either repeated params (Next.js parses
 *     `?status=DRAFT&status=ACTIVE` into `['DRAFT', 'ACTIVE']`) or a
 *     single comma-separated value (`?status=DRAFT,ACTIVE`). The
 *     shared `parseSearchParams` helper takes only the first repeat,
 *     so callers should prefer the comma-separated form.
 *   • `dateFrom`/`dateTo` filter on `Campaign.startDate` (SPEC.md §3
 *     indexes that column) — the route handler translates them into a
 *     `gte`/`lte` Prisma where clause.
 *   • `search` is matched against `Campaign.name` (case-insensitive
 *     substring) by the route handler.
 */
export const campaignListQuerySchema = z
  .object({
    status: multiEnum(campaignStatusValues).optional(),
    channel: multiEnum(campaignChannelValues).optional(),
    ownerId: idField.optional(),
    search: z
      .string()
      .trim()
      .min(1, 'Search query cannot be empty')
      .max(MAX_SEARCH_LENGTH, `Search query must be ${MAX_SEARCH_LENGTH} characters or fewer`)
      .optional(),
    dateFrom: isoDateTimeField.optional(),
    dateTo: isoDateTimeField.optional(),
    page: z.coerce
      .number()
      .int('Page must be an integer')
      .positive('Page must be positive')
      .default(DEFAULT_PAGE),
    pageSize: z.coerce
      .number()
      .int('Page size must be an integer')
      .positive('Page size must be positive')
      .max(MAX_PAGE_SIZE, `Page size cannot exceed ${MAX_PAGE_SIZE}`)
      .default(DEFAULT_PAGE_SIZE),
    sortBy: campaignSortKeyField.default('created'),
    sortDir: sortDirField.default('desc'),
  })
  .refine(
    (val) => !val.dateFrom || !val.dateTo || val.dateFrom <= val.dateTo,
    { message: 'dateFrom must be on or before dateTo', path: ['dateFrom'] },
  );

export type CampaignListQuery = z.infer<typeof campaignListQuerySchema>;

// ---------------------------------------------------------------------------
// 4. GET /api/campaigns/[id]/leads — pagination only
// ---------------------------------------------------------------------------

/**
 * Query-string schema for `GET /api/campaigns/[id]/leads` (SPEC.md
 * §7.2.3 — auto-link leads via UTM). The route handler joins on
 * `Lead.utmCampaign === Campaign.utmCampaign`; the result set is
 * paginated through these params.
 *
 * If the campaign has no `utmCampaign` value, the route returns an
 * empty page rather than every lead (which would be the SQL behaviour
 * if we let `null = null` through).
 */
export const campaignLeadsQuerySchema = z.object({
  page: z.coerce
    .number()
    .int('Page must be an integer')
    .positive('Page must be positive')
    .default(DEFAULT_PAGE),
  pageSize: z.coerce
    .number()
    .int('Page size must be an integer')
    .positive('Page size must be positive')
    .max(MAX_PAGE_SIZE, `Page size cannot exceed ${MAX_PAGE_SIZE}`)
    .default(DEFAULT_PAGE_SIZE),
});

export type CampaignLeadsQuery = z.infer<typeof campaignLeadsQuerySchema>;

// ---------------------------------------------------------------------------
// 5. GET /api/campaigns/comparison — channel rollup
// ---------------------------------------------------------------------------

/**
 * Query-string schema for `GET /api/campaigns/comparison` (SPEC.md
 * §7.2.6).
 *
 *   • `dateFrom` and `dateTo` are required — the comparison aggregates
 *     spend / leads / conversions inside a fixed window. The default
 *     UI range is "last 30 days", but we want callers to be explicit
 *     so the route stays cache-friendly.
 *   • Optional `channel` filter narrows the aggregation to a single
 *     channel; useful for drilldown UIs that re-use the same endpoint.
 */
export const campaignComparisonQuerySchema = z
  .object({
    dateFrom: isoDateTimeField,
    dateTo: isoDateTimeField,
    channel: channelField.optional(),
  })
  .refine((val) => val.dateFrom <= val.dateTo, {
    message: 'dateFrom must be on or before dateTo',
    path: ['dateFrom'],
  });

export type CampaignComparisonQuery = z.infer<typeof campaignComparisonQuerySchema>;

// ---------------------------------------------------------------------------
// 6. Public projection — what we expose to API consumers
// ---------------------------------------------------------------------------

/**
 * Prisma `select` mask for safely returning campaign rows over the wire.
 * Used by every read endpoint that returns campaign data so the
 * embedded `owner` relation is consistent and `passwordHash` is
 * implicitly excluded (SPEC.md §2.2).
 *
 * Marked `as const` so changes to the Prisma model surface as
 * TypeScript errors at the call site first.
 */
export const campaignPublicProjection = {
  id: true,
  name: true,
  channel: true,
  status: true,
  startDate: true,
  endDate: true,
  budget: true,
  spent: true,
  impressions: true,
  clicks: true,
  signups: true,
  conversions: true,
  notes: true,
  utmSource: true,
  utmMedium: true,
  utmCampaign: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
  owner: {
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      avatarUrl: true,
    },
  },
} as const;

/**
 * Embedded owner shape exposed inside `CampaignPublic`. Mirrors the
 * columns picked by `campaignPublicProjection.owner.select`.
 */
export type CampaignOwnerEmbed = {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'EMPLOYEE';
  avatarUrl: string | null;
};

/**
 * The shape of a campaign record after running through
 * `campaignPublicProjection`. Kept as a structural type rather than a
 * Prisma `Pick` so consumers don't have to import the Prisma `Campaign`
 * type just to type a response.
 */
export type CampaignPublic = {
  id: string;
  name: string;
  channel: CampaignChannel;
  status: CampaignStatus;
  startDate: Date;
  endDate: Date | null;
  budget: number;
  spent: number;
  impressions: number;
  clicks: number;
  signups: number;
  conversions: number;
  notes: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  owner: CampaignOwnerEmbed;
};
