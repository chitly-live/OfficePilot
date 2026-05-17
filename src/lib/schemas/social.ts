/**
 * Zod schemas + DTO types for the Social Media module
 * (SPEC.md §8, Prisma `SocialPost` model in §3).
 *
 * Single source of truth for validating request payloads and query
 * strings on:
 *
 *   • POST   /api/social/posts            → `socialPostCreateSchema`
 *   • PATCH  /api/social/posts/[id]       → `socialPostUpdateSchema`
 *   • GET    /api/social/posts            → `socialPostListQuerySchema`
 *   • GET    /api/social/winners          → `socialWinnersQuerySchema`
 *   • GET    /api/social/stats            → `socialStatsQuerySchema`
 *
 * Reused by the corresponding `react-hook-form` forms via
 * `@hookform/resolvers/zod` so client and server share one validation
 * contract (SPEC.md §13.5 — never trust client-only validation).
 *
 * `socialPostPublicProjection` is a Prisma `select` mask used by every
 * read endpoint that returns a post so that owner relations are
 * included consistently (and `passwordHash` is implicitly excluded
 * since the embedded owner only exposes the safe public columns).
 *
 * Implements task 48 of `.kiro/specs/officepilot/tasks.md`.
 */

import { z } from 'zod';
import { PostStatus, SocialPlatform } from '@prisma/client';

// ---------------------------------------------------------------------------
// Field-level constants
// ---------------------------------------------------------------------------

/** SPEC.md §8.2.2: caption is the post body. 5 000 chars covers every
 *  major platform (Twitter is shorter, but cross-posting drafts in
 *  Instagram/Facebook/LinkedIn are routinely >2 000 chars). */
const MAX_CAPTION_LENGTH = 5000;

/** A single hashtag — up to 50 chars. Each major platform caps the
 *  visible-tag length lower than this (Instagram is 30), but stored
 *  hashtags are user-supplied strings and we keep the schema generous
 *  so a #ChickenTikkaMasalaWeeklySpecial doesn't get rejected. */
const MAX_HASHTAG_LENGTH = 50;

/** SPEC.md §8.2.5 — the hashtag library is a "save reusable sets, paste
 *  into composer" feature. 30 hashtags per post is the Instagram cap
 *  and a sensible upper bound across platforms. */
const MAX_HASHTAGS_PER_POST = 30;

/** Each platform caps media at 10 (Instagram carousel). Beyond this the
 *  composer is almost certainly mis-pasted. */
const MAX_MEDIA_URLS = 10;

const MAX_URL_LENGTH = 2048;
const MAX_EXTERNAL_ID_LENGTH = 200;
const MAX_SEARCH_LENGTH = 200;

/** Counter columns are Int — guard against accidental overflow / typos
 *  by capping at ~2 billion (Postgres `INTEGER` is 32-bit). */
const MAX_COUNTER = 2_000_000_000;

const DEFAULT_PAGE = 1;
/** SPEC.md §6.3 baseline (50/page) reused for the social list. */
const DEFAULT_PAGE_SIZE = 50;
/** SPEC.md §6.3 (via task 31) ceiling, reused so paginated UIs share
 *  one universe of page sizes. */
const MAX_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Reusable field schemas
// ---------------------------------------------------------------------------

const captionField = z
  .string()
  .trim()
  .min(1, 'Caption is required')
  .max(
    MAX_CAPTION_LENGTH,
    `Caption must be ${MAX_CAPTION_LENGTH} characters or fewer`,
  );

const urlField = z
  .string()
  .trim()
  .url('Invalid URL')
  .max(MAX_URL_LENGTH, `URL must be ${MAX_URL_LENGTH} characters or fewer`);

/**
 * A single hashtag — stored without the leading `#` so consumers don't
 * have to keep stripping it. We accept either form on input (`hello`
 * or `#hello`) and normalise on the way in.
 *
 * Whitespace inside a tag would split it into multiple tags on every
 * social platform, so we reject it outright.
 */
const hashtagField = z
  .string()
  .trim()
  .min(1, 'Hashtag cannot be empty')
  .max(
    MAX_HASHTAG_LENGTH,
    `Hashtag must be ${MAX_HASHTAG_LENGTH} characters or fewer`,
  )
  .transform((val) => val.replace(/^#/, ''))
  .refine(
    (val) => val.length > 0,
    'Hashtag cannot be empty',
  )
  .refine(
    (val) => !/\s/.test(val),
    'Hashtag cannot contain spaces',
  );

const hashtagsField = z
  .array(hashtagField)
  .max(
    MAX_HASHTAGS_PER_POST,
    `A post may have at most ${MAX_HASHTAGS_PER_POST} hashtags`,
  );

const mediaUrlsField = z
  .array(urlField)
  .max(
    MAX_MEDIA_URLS,
    `A post may have at most ${MAX_MEDIA_URLS} media URLs`,
  );

const externalIdField = z
  .string()
  .trim()
  .min(1, 'External ID cannot be empty')
  .max(
    MAX_EXTERNAL_ID_LENGTH,
    `External ID must be ${MAX_EXTERNAL_ID_LENGTH} characters or fewer`,
  );

/** Non-negative integer counters for likes/comments/shares/reach/impressions. */
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
 * or a `Date` object and yields a `Date`. `z.coerce.date()` covers
 * both cases — `new Date(string)` for strings, identity for Date
 * inputs — while still rejecting nonsense like `"not a date"` (which
 * yields an Invalid Date that Zod catches).
 */
const isoDateTimeField = z.coerce.date();

const platformField = z.nativeEnum(SocialPlatform);
const statusField = z.nativeEnum(PostStatus);

// ---------------------------------------------------------------------------
// 1. POST /api/social/posts
// ---------------------------------------------------------------------------

/**
 * Body schema for `POST /api/social/posts` (SPEC.md §8.3, §8.2.2).
 *
 * The route handler (task 49) is responsible for:
 *   1. Auth guard — unauthenticated → 401 (middleware), unauthorized → 403.
 *   2. Resolving `ownerId`:
 *        • If body.ownerId is set, use it (subject to RBAC check below).
 *        • Otherwise default to `session.userId`.
 *   3. RBAC: EMPLOYEE may only create posts owned by themselves; ADMIN
 *      may assign to anyone. Mirrors campaigns/leads behaviour.
 *   4. Calling `logActivity(..., 'socialpost.created', ...)`.
 *
 * Validation rules:
 *   • `caption` is required (SPEC.md §8.2.2 — every post has a body).
 *   • `mediaUrls`, `hashtags`, `likes`/etc. all default to empty/0 so
 *     the create call doesn't have to be exhaustive.
 *   • `status === SCHEDULED` requires `scheduledAt` (a "scheduled"
 *     post without a schedule is undefined behaviour and would never
 *     surface on the calendar).
 */
export const socialPostCreateSchema = z
  .object({
    platform: platformField,
    status: statusField.default(PostStatus.DRAFT),
    caption: captionField,
    mediaUrls: mediaUrlsField.default([]),
    hashtags: hashtagsField.default([]),
    scheduledAt: isoDateTimeField.optional(),
    externalId: externalIdField.optional(),
    externalUrl: urlField.optional(),
    ownerId: idField.optional(),
  })
  .refine(
    (val) => val.status !== PostStatus.SCHEDULED || val.scheduledAt !== undefined,
    {
      message: 'scheduledAt is required when status is SCHEDULED',
      path: ['scheduledAt'],
    },
  );

export type SocialPostCreateInput = z.infer<typeof socialPostCreateSchema>;

// ---------------------------------------------------------------------------
// 2. PATCH /api/social/posts/[id]
// ---------------------------------------------------------------------------

/**
 * Body schema for `PATCH /api/social/posts/[id]` (SPEC.md §8.3,
 * §8.2.3, §8.2.4).
 *
 *   • `id` lives on the URL, not in the body.
 *   • Every field is optional — the route handler should treat the
 *     payload as a partial update (Prisma `update({ data })` semantics).
 *   • Performance counters (likes/comments/shares/reach/impressions)
 *     are manually entered (SPEC.md §8.2.3 — "manually update likes/
 *     comments/shares/reach after posting"). v1 has no platform pull.
 *   • `publishedAt` may be set explicitly by the client; the route
 *     handler also stamps it automatically when `status` first
 *     transitions to PUBLISHED if not provided (SPEC.md §8.2 — manual
 *     status updates with optional `externalUrl`).
 *   • `isWinner` toggles in/out of the winners gallery (SPEC.md §8.2.4).
 *
 * The schedule constraint from `socialPostCreateSchema` is intentionally
 * NOT mirrored here as a hard cross-field refine — a PATCH that
 * changes status to SCHEDULED without also setting scheduledAt could
 * be valid if the row already has a `scheduledAt` set. The route
 * handler enforces the constraint against the merged (existing +
 * patch) state instead.
 *
 * Reject empty PATCH bodies — they're almost always a client bug, and
 * an "update with no changes" round-trips a row through Prisma for
 * nothing.
 */
export const socialPostUpdateSchema = z
  .object({
    platform: platformField.optional(),
    status: statusField.optional(),
    caption: captionField.optional(),
    mediaUrls: mediaUrlsField.optional(),
    hashtags: hashtagsField.optional(),
    scheduledAt: isoDateTimeField.nullable().optional(),
    publishedAt: isoDateTimeField.nullable().optional(),
    externalId: externalIdField.nullable().optional(),
    externalUrl: urlField.nullable().optional(),
    likes: counterField.optional(),
    comments: counterField.optional(),
    shares: counterField.optional(),
    reach: counterField.optional(),
    impressions: counterField.optional(),
    isWinner: z.boolean().optional(),
    ownerId: idField.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

export type SocialPostUpdateInput = z.infer<typeof socialPostUpdateSchema>;

// ---------------------------------------------------------------------------
// 3. GET /api/social/posts — list with filters + pagination
// ---------------------------------------------------------------------------

/**
 * Comma-separated multi-value parser for query params.
 * `?status=DRAFT,SCHEDULED` yields `['DRAFT', 'SCHEDULED']`;
 * `?status=DRAFT` yields `['DRAFT']`. Empty/missing yields
 * `undefined`. Each value is trimmed; empty pieces are dropped so
 * trailing commas don't pollute the result.
 *
 * Mirrors the helper used in `src/lib/schemas/leads.ts` and
 * `src/lib/schemas/campaigns.ts` so the modules behave identically on
 * multi-value query strings.
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

const platformValues = Object.values(SocialPlatform) as [
  SocialPlatform,
  ...SocialPlatform[],
];
const statusValues = Object.values(PostStatus) as [PostStatus, ...PostStatus[]];

/** Allowed `sortBy` keys — friendly aliases that the route handler maps
 *  to actual Prisma columns. */
export const SOCIAL_SORT_KEYS = [
  'created',
  'updated',
  'scheduled',
  'published',
  'engagement',
] as const;
export type SocialSortKey = (typeof SOCIAL_SORT_KEYS)[number];

const socialSortKeyField = z.enum(SOCIAL_SORT_KEYS);
const sortDirField = z.enum(['asc', 'desc']);

/**
 * Query-string schema for `GET /api/social/posts` (SPEC.md §8.1, §8.3).
 *
 * Conventions:
 *   • Query params arrive as strings (or `undefined`). `z.coerce`
 *     turns `"42"` into `42` and a missing param into the `default()`.
 *   • Multi-value filters accept either repeated params or a single
 *     comma-separated value (`?status=DRAFT,SCHEDULED`). The shared
 *     `parseSearchParams` helper takes only the first repeat, so
 *     callers should prefer the comma-separated form.
 *   • `dateFrom`/`dateTo` filter on `SocialPost.scheduledAt` (the
 *     calendar surface uses scheduled time as its primary axis); the
 *     route handler translates them into a `gte`/`lte` Prisma where
 *     clause.
 *   • `search` is matched against `SocialPost.caption` (case-insensitive
 *     substring) by the route handler.
 *   • `isWinner` is a tri-state — omitted means "either", `true` means
 *     winners only, `false` means non-winners only.
 *   • `sortBy=engagement` orders by the sum of likes+comments+shares
 *     when the route handler runs the query (Prisma can't sum across
 *     columns in `orderBy` directly, so the handler may fall back to
 *     `likes` if the consumer needs a single column).
 */
export const socialPostListQuerySchema = z
  .object({
    platform: multiEnum(platformValues).optional(),
    status: multiEnum(statusValues).optional(),
    ownerId: idField.optional(),
    search: z
      .string()
      .trim()
      .min(1, 'Search query cannot be empty')
      .max(MAX_SEARCH_LENGTH, `Search query must be ${MAX_SEARCH_LENGTH} characters or fewer`)
      .optional(),
    dateFrom: isoDateTimeField.optional(),
    dateTo: isoDateTimeField.optional(),
    isWinner: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((val) => (typeof val === 'boolean' ? val : val === 'true'))
      .optional(),
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
    sortBy: socialSortKeyField.default('created'),
    sortDir: sortDirField.default('desc'),
  })
  .refine(
    (val) => !val.dateFrom || !val.dateTo || val.dateFrom <= val.dateTo,
    { message: 'dateFrom must be on or before dateTo', path: ['dateFrom'] },
  );

export type SocialPostListQuery = z.infer<typeof socialPostListQuerySchema>;

// ---------------------------------------------------------------------------
// 4. GET /api/social/winners — gallery filter
// ---------------------------------------------------------------------------

/**
 * Query-string schema for `GET /api/social/winners` (SPEC.md §8.3,
 * §8.2.4). Returns posts where `isWinner = true`, optionally filtered
 * by platform.
 */
export const socialWinnersQuerySchema = z.object({
  platform: multiEnum(platformValues).optional(),
});

export type SocialWinnersQuery = z.infer<typeof socialWinnersQuerySchema>;

// ---------------------------------------------------------------------------
// 5. GET /api/social/stats — weekly content rollup
// ---------------------------------------------------------------------------

/**
 * Recognised values for `?period=`. Mirrors SPEC.md §8.3:
 * `period=7d|30d`. The route handler resolves these into a fixed
 * window relative to `now`.
 */
export const SOCIAL_STATS_PERIODS = ['7d', '30d'] as const;
export type SocialStatsPeriod = (typeof SOCIAL_STATS_PERIODS)[number];

/**
 * Query-string schema for `GET /api/social/stats` (SPEC.md §8.3,
 * §8.2.6).
 *
 *   • `period` is the rollup window. Defaults to `7d` ("posts published
 *     this week per platform" — SPEC.md §8.2.6).
 *   • `dateFrom`/`dateTo` are optional precise overrides. When both
 *     are provided, they take precedence over `period` so callers
 *     (e.g. a future quarterly view) can request a custom window.
 */
export const socialStatsQuerySchema = z
  .object({
    period: z.enum(SOCIAL_STATS_PERIODS).default('7d'),
    dateFrom: isoDateTimeField.optional(),
    dateTo: isoDateTimeField.optional(),
  })
  .refine(
    (val) => !val.dateFrom || !val.dateTo || val.dateFrom <= val.dateTo,
    { message: 'dateFrom must be on or before dateTo', path: ['dateFrom'] },
  );

export type SocialStatsQuery = z.infer<typeof socialStatsQuerySchema>;

// ---------------------------------------------------------------------------
// 6. Public projection — what we expose to API consumers
// ---------------------------------------------------------------------------

/**
 * Prisma `select` mask for safely returning post rows over the wire.
 * Used by every read endpoint that returns post data so the embedded
 * `owner` relation is consistent and `passwordHash` is implicitly
 * excluded (SPEC.md §2.2).
 *
 * Marked `as const` so changes to the Prisma model surface as
 * TypeScript errors at the call site first.
 */
export const socialPostPublicProjection = {
  id: true,
  platform: true,
  status: true,
  caption: true,
  mediaUrls: true,
  hashtags: true,
  scheduledAt: true,
  publishedAt: true,
  externalId: true,
  externalUrl: true,
  likes: true,
  comments: true,
  shares: true,
  reach: true,
  impressions: true,
  isWinner: true,
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
 * Embedded owner shape exposed inside `SocialPostPublic`. Mirrors the
 * columns picked by `socialPostPublicProjection.owner.select`.
 */
export type SocialPostOwnerEmbed = {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'EMPLOYEE';
  avatarUrl: string | null;
};

/**
 * The shape of a post record after running through
 * `socialPostPublicProjection`. Kept as a structural type rather than
 * a Prisma `Pick` so consumers don't have to import the Prisma
 * `SocialPost` type just to type a response.
 */
export type SocialPostPublic = {
  id: string;
  platform: SocialPlatform;
  status: PostStatus;
  caption: string;
  mediaUrls: string[];
  hashtags: string[];
  scheduledAt: Date | null;
  publishedAt: Date | null;
  externalId: string | null;
  externalUrl: string | null;
  likes: number;
  comments: number;
  shares: number;
  reach: number;
  impressions: number;
  isWinner: boolean;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  owner: SocialPostOwnerEmbed;
};
