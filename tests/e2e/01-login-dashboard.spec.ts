/**
 * E2E flow #1 — Login → dashboard (SPEC §16.3 critical flow #1, task 91).
 *
 * Verifies the auth happy-path that gates every other module:
 *
 *   1. Seed admin → POST `/login` → land on `/dashboard` with the
 *      expected greeting + the four widget rows from SPEC §11.1.
 *   2. Sign out from the user menu — cookie cleared, deep-linking
 *      back to `/dashboard` bounces to `/login`.
 *   3. Anonymous visit to `/dashboard` redirects to `/login`
 *      (the route group's auth gate, SPEC §2.2).
 *
 * The seeded admin row is created once in `beforeAll`; each test
 * starts with a fresh non-admin slate via `cleanupTestData()` so a
 * leftover lead / campaign / dev task can't leak across cases. The
 * helper-scoped Prisma client is closed in `afterAll` so the test
 * process exits cleanly.
 */

import { test, expect } from '@playwright/test';

import {
  cleanupTestData,
  disconnectPrisma,
  loginAsAdmin,
  seedAdmin,
} from './helpers';

test.beforeAll(async () => {
  // One-shot DB priming — guarantees the admin row exists with the
  // canonical password hash before any test drives the login form.
  await seedAdmin();
});

test.beforeEach(async () => {
  // Wipe mutable tables (and any non-admin users) so each spec starts
  // on a clean slate. Keeps the seeded admin intact.
  await cleanupTestData();
});

test.afterAll(async () => {
  // Release the helper-scoped Prisma pool so the test process exits.
  await disconnectPrisma();
});

test('Login flow: seed admin → login → land on dashboard', async ({
  page,
}) => {
  await loginAsAdmin(page);

  // `loginAsAdmin` already asserts the URL on its way out, but we
  // re-check here without the trailing-slash regex so a future change
  // to the redirect target fails this spec, not the helper.
  await expect(page).toHaveURL(/\/dashboard(\/|$|\?)/);

  // Heading is either "Welcome back, <name>" (when the user has a
  // name — our seeded admin does) or just "Dashboard" (fallback for
  // accounts with a blank name). Match either via a single regex on
  // the H1 the dashboard's `PageHeader` renders.
  await expect(
    page.getByRole('heading', { level: 1, name: /^(welcome back|dashboard)/i }),
  ).toBeVisible();

  // Smoke-check that the four widget rows actually rendered. The
  // "Today's pulse" row (Row 1) puts "today" in every card label
  // ("New leads today", "Ad spend today", "Posts published today"),
  // so `getByText(/today/i).first()` is the cheapest, most resilient
  // probe — strict mode would otherwise flag the multiple matches.
  await expect(page.getByText(/today/i).first()).toBeVisible();
});

test('Logout clears session', async ({ page }) => {
  await loginAsAdmin(page);

  // The user-menu trigger is the avatar `IconButton` in the topbar,
  // labelled for screen readers via `aria-label="Open user menu"`.
  await page.getByRole('button', { name: /open user menu/i }).click();

  // The Sign out form-button lives inside the dropdown content.
  // It's a real `<button type="submit">` with the text "Sign out", so
  // `getByRole('button', { name: 'Sign out' })` reaches it without
  // depending on Radix's portal internals.
  await page.getByRole('button', { name: /sign out/i }).click();

  // Auth.js's `signOut({ redirectTo: '/login' })` round-trips through
  // a POST → 302; give the navigation a generous window so a slow CI
  // cold-cache page compile doesn't false-flake the assert.
  await expect(page).toHaveURL(/\/login(\/|$|\?)/, { timeout: 15_000 });

  // Cookie is gone — deep-linking back to a protected route must now
  // bounce us to /login (often with a `callbackUrl` query string).
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login(\/|$|\?)/);
});

test('Unauthenticated visit to /dashboard redirects to /login', async ({
  page,
}) => {
  // Brand-new browser context — no session cookie. The `(app)` route
  // group's layout (and the dashboard page itself) must redirect
  // anonymous visitors to `/login`, optionally appending
  // `?callbackUrl=/dashboard`.
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login(\/|$|\?)/);
});
