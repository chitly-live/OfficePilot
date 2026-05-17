/**
 * Role-Based Access Control (RBAC) helpers for OfficePilot.
 *
 * Pure module — no DB, no I/O, no Prisma calls. Safe to unit-test with
 * property-based tests (see SPEC.md §16.1 Property 7).
 *
 * Authoritative rules (see SPEC.md §2.1 and design.md "Components and Interfaces"):
 *   • ADMIN    → full access to every resource and action.
 *   • EMPLOYEE → read all modules; write only records they own or created;
 *                cannot delete, cannot manage users, cannot see AI cost/usage.
 *
 * Resources cover the 6 modules + Settings:
 *   user, lead, campaign, socialPost, devTask, aiInsight, setting.
 */

import type { Role } from '@prisma/client';

// ---------------------------------------------------------------------------
// Canonical vocabulary
// ---------------------------------------------------------------------------

/**
 * The four action verbs the permission system recognises.
 *
 *  - `read`   → list / view a resource (GET handlers, page reads).
 *  - `write`  → create or update a resource (POST / PATCH / PUT handlers).
 *  - `delete` → destroy or deactivate a resource (DELETE handlers).
 *  - `admin`  → admin-only views or operations on a resource
 *               (e.g. AI cost / usage page, user management, encrypted keys).
 */
export type Action = 'read' | 'write' | 'delete' | 'admin';

/**
 * Every resource the app gates. Mirrors the 6 modules (Employees, Leads,
 * Marketing, Social, Dev, AI) plus the Settings store.
 */
export type Resource =
  | 'user'
  | 'lead'
  | 'campaign'
  | 'socialPost'
  | 'devTask'
  | 'aiInsight'
  | 'setting';

export const ACTIONS: readonly Action[] = ['read', 'write', 'delete', 'admin'] as const;

export const RESOURCES: readonly Resource[] = [
  'user',
  'lead',
  'campaign',
  'socialPost',
  'devTask',
  'aiInsight',
  'setting',
] as const;

export type ResourceActionPair = { resource: Resource; action: Action };

/** Cartesian product of {@link RESOURCES} × {@link ACTIONS}. Useful for tests
 *  that want to enumerate every gate the app supports. */
export const RESOURCE_ACTIONS: readonly ResourceActionPair[] = RESOURCES.flatMap(
  (resource) => ACTIONS.map((action): ResourceActionPair => ({ resource, action })),
);

// ---------------------------------------------------------------------------
// Session and record shapes
// ---------------------------------------------------------------------------

/**
 * Minimal session shape the permission system needs. The full NextAuth v5
 * session (added in task 16) will satisfy this contract because we augment
 * it with `userId` and `role` (see design.md "Roles, Auth, and Permissions").
 *
 * `null`/`undefined` is treated as "unauthenticated" and always denied.
 */
export type PermissionSession =
  | {
      userId: string;
      role: Role;
    }
  | null
  | undefined;

/**
 * Ownership shape for record-scoped checks.
 *
 *  - `ownerId`     → the assignee / owner (e.g. `Lead.ownerId`,
 *                    `Campaign.ownerId`, `DevTask.assigneeId`); for the
 *                    `user` resource, callers pass the record's own `id`
 *                    so an employee can edit their own profile.
 *  - `createdById` → the creator (e.g. `Lead.createdById`,
 *                    `DevTask.reporterId`).
 *
 * Pass an empty object (or omit `record`) when the operation is
 * "create new" — see {@link can} for semantics.
 */
export type OwnedRecord = {
  ownerId?: string | null;
  createdById?: string | null;
};

// ---------------------------------------------------------------------------
// PermissionError
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link assertCan}. API route handlers catch this and return a
 * `403 { error: 'forbidden' }` response (see design.md "Error Handling").
 */
export class PermissionError extends Error {
  readonly code = 'forbidden' as const;
  readonly action: Action;
  readonly resource: Resource;

  constructor(action: Action, resource: Resource, message?: string) {
    super(message ?? `Forbidden: cannot ${action} ${resource}`);
    this.name = 'PermissionError';
    this.action = action;
    this.resource = resource;
    // Restore prototype chain for `instanceof` after `extends Error`.
    Object.setPrototypeOf(this, PermissionError.prototype);
  }
}

// ---------------------------------------------------------------------------
// can()
// ---------------------------------------------------------------------------

/**
 * Pure RBAC predicate. Returns `true` iff the session is allowed to perform
 * `action` on `resource`. Per-record ownership is honoured for EMPLOYEE
 * writes when `record` is supplied.
 *
 * Determinism: identical inputs always produce the same boolean. No side
 * effects, no I/O, no time-dependent behaviour.
 *
 * Semantics:
 *   • Unauthenticated session → `false` for everything.
 *   • ADMIN                   → `true` for everything (Property 7).
 *   • EMPLOYEE
 *       - `read`   → always `true` (read all modules per SPEC.md §2.1).
 *       - `delete` → always `false` (delete is admin-only across modules,
 *                    per tasks 26 and 32).
 *       - `admin`  → always `false` (admin-only routes such as
 *                    `GET /api/ai/usage` and `/settings/users`).
 *       - `write`  → resource-specific:
 *           * `user`        → only when `record.ownerId === session.userId`
 *                              (self-edit). Employees cannot create users.
 *           * `aiInsight`   → `false` (only admins generate insights, per
 *                              task 69).
 *           * `setting`     → `false` (only admins update settings).
 *           * `lead`, `campaign`, `socialPost`, `devTask`
 *                            → `true` when `record` is omitted (create-new)
 *                              OR when the employee owns/created the record.
 */
export function can(
  session: PermissionSession,
  action: Action,
  resource: Resource,
  record?: OwnedRecord,
): boolean {
  if (!session || !session.userId || !session.role) {
    return false;
  }

  if (session.role === 'ADMIN') {
    return true;
  }

  if (session.role !== 'EMPLOYEE') {
    // Defensive: any future role we don't recognise is denied.
    return false;
  }

  switch (action) {
    case 'read':
      return true;

    case 'delete':
      return false;

    case 'admin':
      return false;

    case 'write':
      return canEmployeeWrite(session.userId, resource, record);

    default: {
      // Exhaustiveness guard.
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function canEmployeeWrite(
  userId: string,
  resource: Resource,
  record: OwnedRecord | undefined,
): boolean {
  switch (resource) {
    case 'user':
      // Self-edit only. No `createdById` fallback — users aren't "created" by
      // themselves in the schema, so the only employee path is self-edit.
      return !!record && record.ownerId === userId;

    case 'aiInsight':
    case 'setting':
      // Admin-only writes (AI generate is admin-only per task 69; settings
      // store encrypted keys per SPEC.md §12.2).
      return false;

    case 'lead':
    case 'campaign':
    case 'socialPost':
    case 'devTask': {
      if (!record) {
        // Create-new: the employee is implicitly owner/creator.
        return true;
      }
      const ownsOrCreated =
        (record.ownerId != null && record.ownerId === userId) ||
        (record.createdById != null && record.createdById === userId);
      return ownsOrCreated;
    }

    default: {
      // Exhaustiveness guard.
      const _exhaustive: never = resource;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// assertCan()
// ---------------------------------------------------------------------------

/**
 * Throws {@link PermissionError} when {@link can} would return `false`.
 *
 * API handlers use this so that a single try/catch at the route boundary
 * can map permission errors to HTTP 403.
 */
export function assertCan(
  session: PermissionSession,
  action: Action,
  resource: Resource,
  record?: OwnedRecord,
): void {
  if (!can(session, action, resource, record)) {
    throw new PermissionError(action, resource);
  }
}

// ---------------------------------------------------------------------------
// Per-module access gating (moduleAccess whitelist)
// ---------------------------------------------------------------------------

/**
 * Canonical list of employee-visible modules. Single source of truth for:
 *
 *   • the admin "Permissions" picker in the employee form,
 *   • `src/middleware.ts` URL prefix gating, and
 *   • the sidebar nav filter.
 *
 * `ai` and `settings/users` are intentionally absent — they are admin-only
 * and gated by `ADMIN_ONLY_PATH_PREFIXES` in middleware. `settings` (the
 * personal-profile page, hashtag prefs, etc.) is always visible to every
 * authenticated user regardless of `moduleAccess`.
 */
export const ALL_EMPLOYEE_MODULES = [
  'dashboard',
  'employees',
  'leads',
  'marketing',
  'social',
  'dev',
] as const;

export type ModuleId = (typeof ALL_EMPLOYEE_MODULES)[number];

/**
 * URL → moduleId mapping for page routes. Order matters only insofar as
 * each prefix matches the path it owns; there is no overlap between
 * `/employees` and `/employees/123`, etc. The middleware iterates this
 * array and short-circuits on the first prefix hit.
 */
export const MODULE_PREFIXES: Array<readonly [ModuleId, string]> = [
  ['dashboard', '/dashboard'],
  ['employees', '/employees'],
  ['leads', '/leads'],
  ['marketing', '/marketing'],
  ['social', '/social'],
  ['dev', '/dev'],
];

/**
 * API prefix mapping, parallel to {@link MODULE_PREFIXES}. Dashboard has
 * no module-specific API surface so it does not appear here. Marketing
 * lives under `/api/campaigns` (matching the underlying resource name)
 * rather than `/api/marketing`.
 */
export const MODULE_API_PREFIXES: Array<readonly [ModuleId, string]> = [
  ['employees', '/api/users'],
  ['leads', '/api/leads'],
  ['marketing', '/api/campaigns'],
  ['social', '/api/social'],
  ['dev', '/api/dev'],
];

/**
 * Returns `true` iff `user` is allowed to access `moduleId` based on the
 * per-module whitelist stamped on their `User.moduleAccess` column.
 *
 * Semantics (kept in sync with the JSDoc on `User.moduleAccess` in the
 * Prisma schema):
 *
 *   • `user` is `null`/`undefined` → `false`. Unauthenticated callers
 *     never reach a gated module.
 *   • `user.role === 'ADMIN'` → `true` for every module. Admins bypass
 *     the whitelist entirely, mirroring the global ADMIN bypass in
 *     {@link can}. Property 7 (admin monotonicity) extends to this gate.
 *   • `user.role === 'EMPLOYEE'`:
 *       - `moduleAccess` is empty (or null/undefined) → `true` for every
 *         module. This is the LEGACY semantics — pre-migration employees
 *         have no whitelist on file, and we treat "no preference set" as
 *         "full access" so the feature is backward-compatible.
 *       - `moduleAccess` contains AT LEAST ONE entry → that array is the
 *         exhaustive whitelist. The first time an admin saves a value
 *         (even a single module), the list flips from "legacy / full
 *         access" to "explicit whitelist". To grant full access after
 *         that, the admin must check all 6 module boxes again.
 *
 * Pure function — no I/O, no time-dependent behaviour. Safe to call from
 * server components, middleware (after `auth()` resolves), and unit tests.
 */
export function canAccessModule(
  user:
    | { role: 'ADMIN' | 'EMPLOYEE'; moduleAccess?: string[] | null }
    | null
    | undefined,
  moduleId: ModuleId,
): boolean {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  // Backward compat: legacy employees with empty moduleAccess see all
  // modules. Once an admin sets ANY value (even a single module), the
  // list becomes the exhaustive whitelist.
  const list = user.moduleAccess ?? [];
  if (list.length === 0) return true;
  return list.includes(moduleId);
}
