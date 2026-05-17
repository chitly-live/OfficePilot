/**
 * Zod schemas + DTO types for the Dev Tracking module
 * (SPEC.md §9, Prisma `DevTask` model in §3).
 *
 * Single source of truth for validating request payloads and query
 * strings on:
 *
 *   • POST   /api/dev/tasks                 → `devTaskCreateSchema`
 *   • PATCH  /api/dev/tasks/[id]            → `devTaskUpdateSchema`
 *   • GET    /api/dev/tasks                 → `devTaskListQuerySchema`
 *   • GET    /api/dev/releases              → `devReleasesQuerySchema`
 *   • GET    /api/dev/roadmap               → `devRoadmapQuerySchema`
 *
 * Reused by the corresponding `react-hook-form` forms via
 * `@hookform/resolvers/zod` so client and server share one validation
 * contract (SPEC.md §13.5 — never trust client-only validation).
 *
 * `devTaskPublicProjection` is a Prisma `select` mask used by every
 * read endpoint that returns a task so that embedded `assignee` and
 * `reporter` relations are included consistently (and `passwordHash`
 * is implicitly excluded since each embedded user only exposes the
 * safe public columns).
 *
 * Implements task 54 of `.kiro/specs/officepilot/tasks.md`.
 */

import { z } from 'zod';
import {
  DevTaskStatus,
  DevTaskType,
  Priority,
} from '@prisma/client';

// ---------------------------------------------------------------------------
// Field-level constants
// ---------------------------------------------------------------------------

/** SPEC.md §9.1.5: the new-task form has a single-line `title`. */
const MAX_TITLE_LENGTH = 200;
/** Free-form description / steps — generous ceiling so paste-bombs hit
 *  Zod, not Postgres TOAST. */
const MAX_DESCRIPTION_LENGTH = 5000;
/** Release versions are typically `vX.Y.Z` style; cap loosely. */
const MAX_VERSION_LENGTH = 100;
/** Platform is a free-form string (SPEC.md §3 stores it as `String?`),
 *  but in practice it's "iOS" / "Android" / "Web". 50 chars is plenty. */
const MAX_PLATFORM_LENGTH = 50;
const MAX_SEARCH_LENGTH = 200;

const DEFAULT_PAGE = 1;
/** SPEC.md §6.3 baseline (50/page) reused for the dev list. */
const DEFAULT_PAGE_SIZE = 50;
/** SPEC.md §6.3 ceiling, reused so paginated UIs share one universe of
 *  page sizes. The kanban view (SPEC.md §9.1.1) bypasses pagination
 *  altogether at the page layer. */
const MAX_PAGE_SIZE = 200;

/** SPEC.md §9.3: roadmap default horizon is 8 weeks. We allow 1–52 so
 *  callers can request a custom range without an API change. */
const DEFAULT_ROADMAP_WEEKS = 8;
const MIN_ROADMAP_WEEKS = 1;
const MAX_ROADMAP_WEEKS = 52;

// ---------------------------------------------------------------------------
// Reusable field schemas
// ---------------------------------------------------------------------------

const titleField = z
  .string()
  .trim()
  .min(1, 'Title is required')
  .max(MAX_TITLE_LENGTH, `Title must be ${MAX_TITLE_LENGTH} characters or fewer`);

const descriptionField = z
  .string()
  .max(
    MAX_DESCRIPTION_LENGTH,
    `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
  );

const versionField = z
  .string()
  .trim()
  .min(1, 'Version cannot be empty')
  .max(MAX_VERSION_LENGTH, `Version must be ${MAX_VERSION_LENGTH} characters or fewer`);

const platformField = z
  .string()
  .trim()
  .min(1, 'Platform cannot be empty')
  .max(MAX_PLATFORM_LENGTH, `Platform must be ${MAX_PLATFORM_LENGTH} characters or fewer`);

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

const typeField = z.nativeEnum(DevTaskType);
const statusField = z.nativeEnum(DevTaskStatus);
const priorityField = z.nativeEnum(Priority);

// ---------------------------------------------------------------------------
// 1. POST /api/dev/tasks
// ---------------------------------------------------------------------------

/**
 * Body schema for `POST /api/dev/tasks` (SPEC.md §9.3).
 *
 * The route handler (task 55) is responsible for:
 *   1. Auth guard — unauthenticated → 401 (middleware).
 *   2. Resolving `reporterId`:
 *        • Defaults to `session.userId`.
 *        • An admin may override (e.g. logging a bug on behalf of QA).
 *   3. `assigneeId` is optional — unassigned tasks are valid (drag from
 *      backlog onto a person on the kanban later).
 *   4. Calling `logActivity(..., 'devtask.created', ...)`.
 *
 * Type-specific validation:
 *   • `type === RELEASE` requires both `releaseVersion` and `platform`
 *     (SPEC.md §9.4 acceptance: "Create release v2.5.0 with
 *     platform=iOS → appears on releases page top"). `releasedAt` is
 *     optional — admins may log a release before it ships.
 *   • `type === BUG` doesn't structurally require `affectsVersion` or
 *     `stepsToReproduce` (a quick bug capture is fine), but the form
 *     surfaces them when type is BUG.
 */
export const devTaskCreateSchema = z
  .object({
    title: titleField,
    description: descriptionField.optional(),
    type: typeField.default(DevTaskType.FEATURE),
    status: statusField.default(DevTaskStatus.TODO),
    priority: priorityField.default(Priority.MEDIUM),
    affectsVersion: versionField.optional(),
    stepsToReproduce: descriptionField.optional(),
    releaseVersion: versionField.optional(),
    releasedAt: isoDateTimeField.optional(),
    platform: platformField.optional(),
    targetWeek: isoDateTimeField.optional(),
    assigneeId: idField.optional(),
    reporterId: idField.optional(),
  })
  .refine(
    (val) =>
      val.type !== DevTaskType.RELEASE ||
      (val.releaseVersion !== undefined && val.platform !== undefined),
    {
      message: 'releaseVersion and platform are required for RELEASE tasks',
      path: ['releaseVersion'],
    },
  );

export type DevTaskCreateInput = z.infer<typeof devTaskCreateSchema>;

// ---------------------------------------------------------------------------
// 2. PATCH /api/dev/tasks/[id]
// ---------------------------------------------------------------------------

/**
 * Body schema for `PATCH /api/dev/tasks/[id]` (SPEC.md §9.3, §9.4).
 *
 *   • `id` lives on the URL, not in the body.
 *   • Every field is optional — the route handler should treat the
 *     payload as a partial update (Prisma `update({ data })` semantics).
 *   • The drag-drop kanban (SPEC.md §9.2.1) calls this endpoint with
 *     `{ status }`. The route handler is responsible for:
 *       - Auto-stamping `completedAt = now()` on first transition into
 *         DONE (SPEC.md §9.4 "Move task to DONE → completedAt set
 *         automatically"). The schema does NOT accept `completedAt`
 *         from clients — fabrication isn't possible.
 *       - Clearing `completedAt` on transitions away from DONE (so
 *         re-opening a task resets the completion clock).
 *       - Logging `devtask.moved` on any status change and
 *         `devtask.completed` on first DONE transition.
 *   • `reporterId` is intentionally NOT patchable — the original
 *     reporter is part of the audit trail (parallels how `createdById`
 *     is immutable on leads).
 *
 * Reject empty PATCH bodies — they're almost always a client bug, and
 * an "update with no changes" round-trips a row through Prisma for
 * nothing.
 */
export const devTaskUpdateSchema = z
  .object({
    title: titleField.optional(),
    description: descriptionField.nullable().optional(),
    type: typeField.optional(),
    status: statusField.optional(),
    priority: priorityField.optional(),
    affectsVersion: versionField.nullable().optional(),
    stepsToReproduce: descriptionField.nullable().optional(),
    releaseVersion: versionField.nullable().optional(),
    releasedAt: isoDateTimeField.nullable().optional(),
    platform: platformField.nullable().optional(),
    targetWeek: isoDateTimeField.nullable().optional(),
    assigneeId: idField.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

export type DevTaskUpdateInput = z.infer<typeof devTaskUpdateSchema>;

// ---------------------------------------------------------------------------
// 3. GET /api/dev/tasks — list with filters + pagination
// ---------------------------------------------------------------------------

/**
 * Comma-separated multi-value parser for query params.
 * `?status=TODO,DOING` yields `['TODO', 'DOING']`; `?status=TODO`
 * yields `['TODO']`. Empty/missing yields `undefined`. Each value is
 * trimmed; empty pieces are dropped so trailing commas don't pollute
 * the result.
 *
 * Mirrors the helper used in `src/lib/schemas/leads.ts` and
 * `src/lib/schemas/social.ts` so the modules behave identically on
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

const typeValues = Object.values(DevTaskType) as [DevTaskType, ...DevTaskType[]];
const statusValues = Object.values(DevTaskStatus) as [
  DevTaskStatus,
  ...DevTaskStatus[],
];
const priorityValues = Object.values(Priority) as [Priority, ...Priority[]];

/** Allowed `sortBy` keys — friendly aliases that the route handler maps
 *  to actual Prisma columns. */
export const DEV_TASK_SORT_KEYS = [
  'created',
  'updated',
  'priority',
  'targetWeek',
] as const;
export type DevTaskSortKey = (typeof DEV_TASK_SORT_KEYS)[number];

const devTaskSortKeyField = z.enum(DEV_TASK_SORT_KEYS);
const sortDirField = z.enum(['asc', 'desc']);

/**
 * Query-string schema for `GET /api/dev/tasks` (SPEC.md §9.1, §9.3).
 *
 * Conventions:
 *   • Query params arrive as strings (or `undefined`). `z.coerce`
 *     turns `"42"` into `42` and a missing param into the `default()`.
 *   • Multi-value filters accept either repeated params or a single
 *     comma-separated value (`?status=TODO,DOING`). The shared
 *     `parseSearchParams` helper takes only the first repeat, so
 *     callers should prefer the comma-separated form.
 *   • `targetWeekFrom`/`targetWeekTo` filter on `DevTask.targetWeek`
 *     (used by the roadmap surface — SPEC.md §9.1.4). The route
 *     handler translates them into a `gte`/`lte` Prisma where clause.
 *   • `search` is matched against title + description by the route
 *     handler (case-insensitive substring).
 */
export const devTaskListQuerySchema = z
  .object({
    type: multiEnum(typeValues).optional(),
    status: multiEnum(statusValues).optional(),
    priority: multiEnum(priorityValues).optional(),
    assigneeId: idField.optional(),
    reporterId: idField.optional(),
    search: z
      .string()
      .trim()
      .min(1, 'Search query cannot be empty')
      .max(MAX_SEARCH_LENGTH, `Search query must be ${MAX_SEARCH_LENGTH} characters or fewer`)
      .optional(),
    targetWeekFrom: isoDateTimeField.optional(),
    targetWeekTo: isoDateTimeField.optional(),
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
    sortBy: devTaskSortKeyField.default('created'),
    sortDir: sortDirField.default('desc'),
  })
  .refine(
    (val) =>
      !val.targetWeekFrom ||
      !val.targetWeekTo ||
      val.targetWeekFrom <= val.targetWeekTo,
    {
      message: 'targetWeekFrom must be on or before targetWeekTo',
      path: ['targetWeekFrom'],
    },
  );

export type DevTaskListQuery = z.infer<typeof devTaskListQuerySchema>;

// ---------------------------------------------------------------------------
// 4. GET /api/dev/releases
// ---------------------------------------------------------------------------

/**
 * Query-string schema for `GET /api/dev/releases` (SPEC.md §9.3).
 *
 * Returns rows where `type=RELEASE`, ordered by `releasedAt` desc with
 * NULL last (unshipped releases bubble to the bottom). Optional
 * platform filter narrows to "iOS" / "Android" / "Web".
 */
export const devReleasesQuerySchema = z.object({
  platform: platformField.optional(),
});

export type DevReleasesQuery = z.infer<typeof devReleasesQuerySchema>;

// ---------------------------------------------------------------------------
// 5. GET /api/dev/roadmap
// ---------------------------------------------------------------------------

/**
 * Query-string schema for `GET /api/dev/roadmap` (SPEC.md §9.3, §9.4).
 *
 *   • `weeks` controls the horizon (default 8, max 52).
 *   • The route handler computes Monday-aligned week buckets starting
 *     from the current week and groups tasks by `targetWeek`. Tasks
 *     without a `targetWeek` are excluded.
 */
export const devRoadmapQuerySchema = z.object({
  weeks: z.coerce
    .number()
    .int('weeks must be an integer')
    .min(MIN_ROADMAP_WEEKS, `weeks must be at least ${MIN_ROADMAP_WEEKS}`)
    .max(MAX_ROADMAP_WEEKS, `weeks must be at most ${MAX_ROADMAP_WEEKS}`)
    .default(DEFAULT_ROADMAP_WEEKS),
});

export type DevRoadmapQuery = z.infer<typeof devRoadmapQuerySchema>;

// ---------------------------------------------------------------------------
// 6. Public projection — what we expose to API consumers
// ---------------------------------------------------------------------------

/**
 * Prisma `select` mask for safely returning task rows over the wire.
 * Used by every read endpoint that returns task data so the embedded
 * `assignee` and `reporter` relations are consistent and
 * `passwordHash` is implicitly excluded (SPEC.md §2.2).
 *
 * Marked `as const` so changes to the Prisma model surface as
 * TypeScript errors at the call site first.
 */
export const devTaskPublicProjection = {
  id: true,
  title: true,
  description: true,
  type: true,
  status: true,
  priority: true,
  affectsVersion: true,
  stepsToReproduce: true,
  releaseVersion: true,
  releasedAt: true,
  platform: true,
  targetWeek: true,
  assigneeId: true,
  reporterId: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
  assignee: {
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      avatarUrl: true,
    },
  },
  reporter: {
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
 * Embedded user shape exposed inside a `DevTaskPublic`. Mirrors the
 * columns picked by `devTaskPublicProjection.assignee.select` (the
 * same set is used for `reporter`).
 */
export type DevTaskUserEmbed = {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'EMPLOYEE';
  avatarUrl: string | null;
};

/**
 * The shape of a task record after running through
 * `devTaskPublicProjection`. Kept as a structural type rather than a
 * Prisma `Pick` so consumers don't have to import the Prisma `DevTask`
 * type just to type a response.
 *
 * `assignee` may be `null` (unassigned tasks are valid). `reporter` is
 * always present — the schema's `reporterId` column is non-nullable.
 */
export type DevTaskPublic = {
  id: string;
  title: string;
  description: string | null;
  type: DevTaskType;
  status: DevTaskStatus;
  priority: Priority;
  affectsVersion: string | null;
  stepsToReproduce: string | null;
  releaseVersion: string | null;
  releasedAt: Date | null;
  platform: string | null;
  targetWeek: Date | null;
  assigneeId: string | null;
  reporterId: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  assignee: DevTaskUserEmbed | null;
  reporter: DevTaskUserEmbed;
};
