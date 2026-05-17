/**
 * Shared helpers for OfficePilot E2E specs (SPEC §16.3, task 90).
 *
 * These helpers are intentionally narrow — just enough to support the
 * six critical-flow specs in tasks 91–96 without duplicating Prisma
 * boilerplate in every file.
 *
 * Surface area:
 *
 *   • `seedAdmin()`         — idempotently insert/refresh the canonical
 *                             E2E admin row (`E2E_ADMIN_EMAIL` /
 *                             `E2E_ADMIN_PASSWORD`).
 *   • `loginAsAdmin(page)`  — drive the `/login` form and wait for the
 *                             `/dashboard` redirect.
 *   • `cleanupTestData()`   — truncate the mutable tables between tests
 *                             so each spec starts on a clean slate while
 *                             leaving the seeded admin (and any user
 *                             rows) intact via `RESTART IDENTITY`.
 *
 * All helpers talk to the SAME Postgres database the dev server uses
 * (whatever `DATABASE_URL` resolves to when Playwright spawns
 * `npm run dev`). For CI we expect an isolated dev DB; locally devs
 * point Playwright at the test DB by exporting `DATABASE_URL` before
 * `npm run test:e2e`.
 */

import { hash } from 'bcryptjs';
import { Page, expect } from '@playwright/test';
import { DevTask, PrismaClient, Role } from '@prisma/client';

// ---------------------------------------------------------------------------
// Shared Prisma client
// ---------------------------------------------------------------------------
//
// We instantiate our OWN `PrismaClient` here rather than re-using
// `@/lib/db`'s singleton. Reasons:
//   1. Importing `@/lib/db` from a Playwright test would drag in the
//      Next.js path-alias plumbing, which Playwright's TS loader does
//      not configure by default.
//   2. The dev server has its own Prisma instance — keeping these
//      separate means we never accidentally close the server's pool
//      from a test teardown.

let prismaSingleton: PrismaClient | undefined;

function getPrisma(): PrismaClient {
  if (!prismaSingleton) {
    prismaSingleton = new PrismaClient();
  }
  return prismaSingleton;
}

// ---------------------------------------------------------------------------
// Constants — kept in one place so specs and CI scripts agree
// ---------------------------------------------------------------------------

/** Email of the seeded admin used by every E2E spec. */
export const E2E_ADMIN_EMAIL =
  process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@chitly.live';

/**
 * Password for the seeded admin. Plaintext in source is intentional —
 * this is only ever used against a local/test DB and ships disabled in
 * production via the `E2E_ADMIN_*` env vars never being set there.
 */
export const E2E_ADMIN_PASSWORD =
  process.env.E2E_ADMIN_PASSWORD ?? 'e2e-pass-123';

const BCRYPT_COST = 4; // tests can afford the lower cost; faster setup.

// Tables that any of the six E2E flows can touch. Wiped between tests
// via `cleanupTestData()`. The User table is deliberately NOT in this
// list — it's pruned with a targeted delete that preserves the seeded
// admin so we don't have to re-bcrypt on every test boundary.
const TABLES_TO_TRUNCATE = [
  'ActivityLog',
  'Note',
  'Attendance',
  'AIInsight',
  'Lead',
  'Campaign',
  'SocialPost',
  'DevTask',
] as const;

// ---------------------------------------------------------------------------
// seedAdmin — idempotent
// ---------------------------------------------------------------------------

/**
 * Ensure the canonical E2E admin row exists with a known
 * email + password + ADMIN role. Safe to call from any number of
 * `test.beforeAll` hooks; the upsert refreshes the password hash so a
 * test never gets locked out by a stale row.
 */
export async function seedAdmin(): Promise<{ id: string; email: string }> {
  const prisma = getPrisma();
  const passwordHash = await hash(E2E_ADMIN_PASSWORD, BCRYPT_COST);

  const admin = await prisma.user.upsert({
    where: { email: E2E_ADMIN_EMAIL },
    // On every run we rewrite the hash + ensure ADMIN/active so a
    // half-broken state from a previous test cannot persist.
    update: {
      passwordHash,
      role: Role.ADMIN,
      isActive: true,
    },
    create: {
      email: E2E_ADMIN_EMAIL,
      passwordHash,
      name: 'E2E Admin',
      role: Role.ADMIN,
      isActive: true,
    },
    select: { id: true, email: true },
  });

  return admin;
}

// ---------------------------------------------------------------------------
// loginAsAdmin — UI-driven sign-in
// ---------------------------------------------------------------------------

/**
 * Drive the credentials sign-in form on `/login` as the seeded admin
 * and resolve once we've landed on `/dashboard`. Throws via Playwright's
 * matcher if the redirect doesn't happen within the test timeout.
 *
 * Selectors deliberately match the labels rendered by `LoginForm` in
 * `src/app/(auth)/login/login-form.tsx` so a future rename of an `id`
 * or class doesn't silently break the suite.
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/login');

  // The form uses shadcn's `<Label>` → `<Input>` association via
  // `<FormField>`, so `getByLabel` is the most resilient selector.
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();

  // Auth.js's client-side `signIn({ redirect: false })` followed by
  // `router.replace('/dashboard')` — give it room for the round-trip.
  await expect(page).toHaveURL(/\/dashboard(\/|$|\?)/, { timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// cleanupTestData — between-test reset
// ---------------------------------------------------------------------------

/**
 * Truncate every mutable table the E2E flows can touch and prune any
 * non-admin user rows. Identity sequences are restarted so generated
 * IDs stay deterministic across runs.
 *
 * Safe to call from `beforeEach` — a single `TRUNCATE … CASCADE`
 * statement keeps FK ordering correct without per-table delete loops.
 */
export async function cleanupTestData(): Promise<void> {
  const prisma = getPrisma();

  // One TRUNCATE call so cascades resolve atomically. Quoting is
  // required because Prisma generates PascalCase identifiers.
  const tableList = TABLES_TO_TRUNCATE.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`,
  );

  // Targeted user purge — keep the seeded E2E admin, drop everyone
  // else a previous test might have created (e.g. employee fixtures).
  await prisma.user.deleteMany({
    where: { email: { not: E2E_ADMIN_EMAIL } },
  });
}

// ---------------------------------------------------------------------------
// Module teardown
// ---------------------------------------------------------------------------

/**
 * Disconnect the helper-scoped Prisma client. Specs can call this from
 * `test.afterAll` if they want to be explicit; Playwright will also
 * happily exit with the connection pool open since it's a one-shot
 * process.
 */
export async function disconnectPrisma(): Promise<void> {
  if (prismaSingleton) {
    await prismaSingleton.$disconnect();
    prismaSingleton = undefined;
  }
}

// ---------------------------------------------------------------------------
// Dev module helpers
// ---------------------------------------------------------------------------

/**
 * Read one `DevTask` row by id straight from Postgres so a spec can
 * make ground-truth assertions about server-side side effects (e.g.
 * `completedAt` being stamped on the first transition into DONE — see
 * SPEC §9.4 and the dev-kanban E2E spec). Returns `null` when the row
 * is missing rather than throwing, mirroring Prisma's `findUnique`
 * contract so callers can `expect(...).not.toBeNull()` cleanly.
 */
export async function getDevTaskById(id: string): Promise<DevTask | null> {
  const prisma = getPrisma();
  return prisma.devTask.findUnique({ where: { id } });
}
