/**
 * Zod schemas + DTO types for the Employees / Users module
 * (SPEC.md §5, Prisma `User` and `Attendance` models in §3).
 *
 * These schemas are the single source of truth for validating request
 * payloads and query strings on:
 *
 *   • POST   /api/users                    → `userCreateSchema`
 *   • PATCH  /api/users/[id]               → `userUpdateSchema`
 *   • GET    /api/users                    → `userListQuerySchema`
 *   • POST   /api/users/[id]/attendance    → `attendanceSchema`
 *
 * They are also intended to be reused by the corresponding `react-hook-form`
 * forms via `@hookform/resolvers/zod` so that client and server share one
 * validation contract (SPEC.md §13.5 — never trust client-only validation).
 *
 * `userPublicProjection` is a Prisma `select` mask that explicitly omits
 * `passwordHash`. Every read endpoint that returns user data MUST go
 * through this mask so a hash never leaves the server.
 *
 * Implements task 24 of `.kiro/specs/officepilot/tasks.md`. The actual API
 * route handlers come in tasks 25–27.
 */

import { z } from 'zod';
import { Role } from '@prisma/client';

import { ALL_EMPLOYEE_MODULES } from '@/lib/permissions';

// ---------------------------------------------------------------------------
// Field-level constants
// ---------------------------------------------------------------------------

/** Bcrypt is happy with anything ≤72 bytes; 8 chars is the SPEC.md §2 floor. */
const MIN_PASSWORD_LENGTH = 8;
/** Generous upper bound so accidental paste-bombs hit Zod, not the DB. */
const MAX_PASSWORD_LENGTH = 200;
const MAX_NAME_LENGTH = 100;
const MAX_DESIGNATION_LENGTH = 100;
const MAX_PHONE_LENGTH = 32;
const MIN_PHONE_DIGITS = 7;
const MAX_NOTES_LENGTH = 500;
const MAX_SEARCH_LENGTH = 100;

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * Permissive phone shape — we don't try to be libphonenumber here. We just
 * reject obvious garbage (letters, control chars) and require at least 7
 * digits so a stray "abc" or "+++" doesn't sail through. Country-specific
 * formatting is the form-layer's problem.
 */
const phoneRegex = /^[+\d][\d\s\-()]{6,}$/;

/**
 * Statuses for the Attendance row. Stored as a plain string column in
 * Postgres (see `Attendance.status` in schema.prisma) — Zod is what
 * enforces the closed set.
 */
export const ATTENDANCE_STATUSES = ['present', 'leave', 'wfh', 'absent'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Reusable field schemas
// ---------------------------------------------------------------------------

/** Lower-cased, trimmed email. The DB column is unique on the lowercase
 *  form so callers MUST go through this schema before any lookup/insert. */
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email('Invalid email address');

export const passwordField = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH, `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer`);

const nameField = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(MAX_NAME_LENGTH, `Name must be ${MAX_NAME_LENGTH} characters or fewer`);

const phoneField = z
  .string()
  .trim()
  .max(MAX_PHONE_LENGTH, `Phone must be ${MAX_PHONE_LENGTH} characters or fewer`)
  .regex(phoneRegex, 'Invalid phone number')
  .refine(
    (val) => (val.match(/\d/g)?.length ?? 0) >= MIN_PHONE_DIGITS,
    `Phone must contain at least ${MIN_PHONE_DIGITS} digits`,
  );

const designationField = z
  .string()
  .trim()
  .min(1, 'Designation cannot be empty')
  .max(MAX_DESIGNATION_LENGTH, `Designation must be ${MAX_DESIGNATION_LENGTH} characters or fewer`);

/** Agreed monthly pay (salary / stipend) in INR. `null` clears it. */
const monthlySalaryField = z.coerce
  .number()
  .min(0, 'Salary cannot be negative')
  .max(100_000_000, 'Salary is unrealistically large');

/** Short label shown next to the amount, e.g. "Intern stipend". */
const salaryLabelField = z
  .string()
  .trim()
  .min(1, 'Salary label cannot be empty')
  .max(60, 'Salary label must be 60 characters or fewer');

const avatarUrlField = z
  .string()
  .trim()
  .url('Invalid URL')
  .max(2048, 'URL is too long');

const roleField = z.nativeEnum(Role);

/**
 * Per-module access list (FEATURE-A / v0.1.3).
 *
 * The enum mirrors {@link ALL_EMPLOYEE_MODULES} in `@/lib/permissions` —
 * the six employee-accessible modules. `'ai'` and `'settings/users'` are
 * admin-only and intentionally NOT in this set.
 *
 * Semantics (kept in sync with the JSDoc on `User.moduleAccess` in the
 * Prisma schema and `canAccessModule()`):
 *
 *   • Empty array `[]` means "ALL modules" — the legacy/backward-compat
 *     default. Every pre-feature user has an empty array on disk, so the
 *     gate has to treat that as "no restriction" or we'd lock everyone
 *     out the moment we shipped.
 *   • A non-empty subset is the exhaustive whitelist for the EMPLOYEE.
 *     E.g. `['leads', 'marketing']` means the user only sees Leads and
 *     Marketing in the sidebar / can only reach those URLs.
 *   • For ADMIN users the field is a no-op: admins always see every
 *     module regardless of the column value, so the route handlers
 *     normalise admin updates back to `[]` to keep the DB clean.
 *
 * `z.enum([...ALL_EMPLOYEE_MODULES])` keeps the source of truth in
 * `permissions.ts` and surfaces a TS error here if anyone tampers with
 * the list. The `as [string, ...string[]]` is the standard Zod-enum
 * idiom for narrowing a readonly tuple.
 */
const moduleAccessField = z
  .array(z.enum(ALL_EMPLOYEE_MODULES as unknown as [string, ...string[]]))
  .optional()
  .default([]);

/**
 * Accepts an ISO-8601 datetime string (e.g. `"2026-05-16T03:00:00Z"`) or
 * a `Date` object and yields a `Date`. `z.coerce.date()` covers both
 * cases — `new Date(string)` for strings, identity for Date inputs —
 * while still rejecting nonsense like `"not a date"` (which yields an
 * Invalid Date that Zod catches).
 */
const isoDateTimeField = z.coerce.date();

// ---------------------------------------------------------------------------
// 1. POST /api/users — admin only
// ---------------------------------------------------------------------------

/**
 * Body schema for `POST /api/users` (SPEC.md §5.3).
 *
 * The route handler (task 25) is responsible for:
 *   1. Auth guard → reject if `session.role !== 'ADMIN'`.
 *   2. Hashing `password` with bcrypt (cost 12) before persisting; the
 *      DB column is `passwordHash`, NOT `password`.
 *   3. Calling `logActivity(..., 'user.created', ...)`.
 */
export const userCreateSchema = z.object({
  email: emailField,
  password: passwordField,
  name: nameField,
  /** Defaults to EMPLOYEE per SPEC.md §2.1 — admin must explicitly
   *  promote a user. */
  role: roleField.default(Role.EMPLOYEE),
  phone: phoneField.optional(),
  designation: designationField.optional(),
  /** Defaults to "now" so the form doesn't have to send anything for the
   *  common case of "this person started today". */
  joinedAt: isoDateTimeField.optional().default(() => new Date()),
  avatarUrl: avatarUrlField.optional(),
  /**
   * Per-module access whitelist for EMPLOYEE users. `[]` (default) means
   * "all modules" — see {@link moduleAccessField} for the full semantics.
   * For ADMIN users this is ignored and the route handler normalises it
   * back to `[]` on persist.
   */
  moduleAccess: moduleAccessField,
});

export type UserCreateInput = z.infer<typeof userCreateSchema>;

// ---------------------------------------------------------------------------
// 2. PATCH /api/users/[id]
// ---------------------------------------------------------------------------

/**
 * Body schema for `PATCH /api/users/[id]` (SPEC.md §5.3).
 *
 *   • `id` lives on the URL, not in the body.
 *   • Every field is optional — the route handler should treat the
 *     payload as a partial update (Prisma `update({ data })` semantics).
 *   • `password`, when present, will be re-hashed by the route handler.
 *     For v1, the spec allows admin-driven password resets through this
 *     same endpoint (SPEC.md §2.2 "Forgot password: admin resets manually").
 *   • `email` updates re-run the lower-case + trim normalization.
 *   • `isActive: false` is the soft-delete (a.k.a. deactivation) path —
 *     admin-only, logged as `user.deactivated`.
 *
 * The route handler (task 26) is responsible for the
 * "admin-anything OR self-limited-fields" authorization split — Zod
 * cannot express "field X requires role Y" cleanly, and trying to bake
 * it in here would just duplicate `permissions.can(...)`.
 */
export const userUpdateSchema = z
  .object({
    email: emailField.optional(),
    password: passwordField.optional(),
    name: nameField.optional(),
    role: roleField.optional(),
    phone: phoneField.optional(),
    designation: designationField.optional(),
    joinedAt: isoDateTimeField.optional(),
    avatarUrl: avatarUrlField.optional(),
    /** Soft-delete toggle. Admin-only; the route handler must enforce. */
    isActive: z.boolean().optional(),
    /** Monthly salary / stipend. Admin-only; `null` clears. */
    monthlySalary: monthlySalaryField.nullable().optional(),
    /** Label for the pay, e.g. "Intern stipend". Admin-only; `null` clears. */
    salaryLabel: salaryLabelField.nullable().optional(),
    /**
     * Per-module access whitelist update. Admin-only in practice; an
     * EMPLOYEE-self PATCH that includes this key is rejected by the route
     * handler's `EMPLOYEE_SELF_EDITABLE_FIELDS` gate. `[]` means "all
     * modules" (legacy/backward-compat). When `role` is being promoted to
     * `ADMIN` in the same PATCH (or the user is already an admin), the
     * route handler normalises this back to `[]` since admins always see
     * every module regardless.
     */
    moduleAccess: z
      .array(
        z.enum(ALL_EMPLOYEE_MODULES as unknown as [string, ...string[]]),
      )
      .optional(),
  })
  // Reject empty PATCH bodies — they're almost always a client bug, and
  // an "update with no changes" round-trips a row through Prisma for no
  // reason.
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

export type UserUpdateInput = z.infer<typeof userUpdateSchema>;

// ---------------------------------------------------------------------------
// 3. GET /api/users — list with filters + pagination
// ---------------------------------------------------------------------------

/**
 * Query-string schema for `GET /api/users` (SPEC.md §5.3).
 *
 * Conventions:
 *   • Query params arrive as strings (or `undefined`). `z.coerce` turns
 *     `"42"` into `42` and a missing param into the `default()`.
 *   • Booleans-from-strings need explicit handling — `Boolean("false")`
 *     is `true` in JavaScript, which is not what anyone wants. The
 *     `boolFromQuery` helper below handles `"true"`/`"false"` literally.
 *   • `search` is trimmed and length-capped so a 10-MB query string
 *     doesn't sneak through middleware.
 */
const boolFromQuery = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((val) => (typeof val === 'boolean' ? val : val === 'true'));

export const userListQuerySchema = z.object({
  role: roleField.optional(),
  isActive: boolFromQuery.optional(),
  search: z
    .string()
    .trim()
    .min(1, 'Search query cannot be empty')
    .max(MAX_SEARCH_LENGTH, `Search query must be ${MAX_SEARCH_LENGTH} characters or fewer`)
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
});

export type UserListQuery = z.infer<typeof userListQuerySchema>;

// ---------------------------------------------------------------------------
// 4. POST /api/users/[id]/attendance
// ---------------------------------------------------------------------------

/**
 * Body schema for `POST /api/users/[id]/attendance` (SPEC.md §5.3, §5.4).
 *
 *   • `(userId, date)` is unique in the DB; the route handler must
 *     translate Prisma's P2002 unique-violation into a 409 (task 27).
 *   • Employees can mark their own; admin can override anyone — the
 *     route handler enforces this via `permissions.can(...)`.
 *   • The `Attendance.date` column is `@db.Date` (date-only), so callers
 *     should send a YYYY-MM-DD string. We accept a full ISO datetime too
 *     (via `z.coerce.date()`) and let the handler `.toISOString()` it
 *     back to a date-only value when writing.
 */
export const attendanceSchema = z.object({
  date: isoDateTimeField,
  status: z.enum(ATTENDANCE_STATUSES),
  notes: z
    .string()
    .trim()
    .max(MAX_NOTES_LENGTH, `Notes must be ${MAX_NOTES_LENGTH} characters or fewer`)
    .optional(),
});

export type AttendanceInput = z.infer<typeof attendanceSchema>;

// ---------------------------------------------------------------------------
// 5. Public projection — what we expose to API consumers
// ---------------------------------------------------------------------------

/**
 * Prisma `select` mask for safely returning user rows over the wire.
 *
 * `passwordHash` is intentionally excluded — it must never leave the
 * server (SPEC.md §2.2). Every read endpoint that returns user data
 * (`GET /api/users`, `GET /api/users/[id]`, embedded `owner` lookups,
 * etc.) MUST funnel through this mask.
 *
 * Marked `as const` and `satisfies Prisma.UserSelect`-style at the
 * call site so changes to the Prisma model surface as TypeScript errors
 * here first.
 */
export const userPublicProjection = {
  id: true,
  email: true,
  name: true,
  role: true,
  phone: true,
  designation: true,
  joinedAt: true,
  isActive: true,
  avatarUrl: true,
  // moduleAccess is exposed so the admin Employees list / detail UI can
  // display the per-user whitelist. Empty array means "all modules"
  // (legacy/backward-compat); admin rows always have `[]` regardless.
  moduleAccess: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * The shape of a user record after running through `userPublicProjection`.
 * Kept as a structural type rather than `Pick<User, ...>` so consumers
 * don't have to import the Prisma `User` type just to type a response.
 */
export type UserPublic = {
  id: string;
  email: string;
  name: string;
  role: Role;
  phone: string | null;
  designation: string | null;
  joinedAt: Date;
  isActive: boolean;
  avatarUrl: string | null;
  /** Per-module access whitelist. `[]` means "all modules" (legacy/default
   *  for EMPLOYEE; always-empty for ADMIN). See `User.moduleAccess` in
   *  `prisma/schema.prisma` for the canonical semantics. */
  moduleAccess: string[];
  createdAt: Date;
  updatedAt: Date;
};
