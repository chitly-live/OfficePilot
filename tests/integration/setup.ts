/**
 * Per-file Vitest setup for integration tests (task 29).
 *
 * Loaded by `vitest.integration.config.mts` via `setupFiles`. Runs in
 * the same worker process as each integration test file.
 *
 * Responsibilities:
 *   1. Stamp the test DATABASE_URL onto `process.env` *before* any
 *      module under test imports `@/lib/db`. Prisma reads the env var
 *      at `new PrismaClient()` time, so this MUST happen before route
 *      handlers (or anything else transitively importing the singleton)
 *      get loaded.
 *   2. Wire a global `beforeEach` that truncates every table the route
 *      handlers can touch. This gives each test a clean slate without
 *      the slowness of running migrations between tests.
 *   3. Mock `next-auth`'s `auth()` function so individual tests can
 *      inject a fake session via the `setSession()` helper exported
 *      from `tests/integration/helpers.ts`.
 */

import { afterAll, beforeEach, vi } from 'vitest';

import { resolveTestDatabaseUrl } from './test-database-url';

// ---------------------------------------------------------------------------
// 1. Database URL plumbing — must run before any `@/lib/db` import
// ---------------------------------------------------------------------------

// Stamp the env var so Prisma's singleton picks it up. Vitest sets up
// `process.env` per worker, so this assignment is scoped to the test
// worker and won't leak into other tooling.
process.env.DATABASE_URL = resolveTestDatabaseUrl();

// `next-auth` reads `NEXTAUTH_SECRET` at config time. Provide a stable
// fake so the auth module doesn't error on import.
process.env.NEXTAUTH_SECRET ??= 'test-secret-do-not-use-in-prod';

// Default HMAC secret for the public webhook route (`/api/webhooks/leads`).
// Tests that exercise the "secret missing" path delete this within their
// own `beforeEach` and restore it in `afterEach` (see
// `leads.webhooks.test.ts`).
process.env.WEBHOOK_HMAC_SECRET ??= 'test-webhook-hmac-secret-do-not-use-in-prod';

// AES-256-GCM key used by `@/lib/crypto` to encrypt sensitive
// `Setting` values (anthropic_api_key, webhook_hmac_secret) before
// they hit Postgres. Required by `PATCH /api/settings` whenever a
// sensitive value is written. Stamped here so individual test files
// don't have to re-arm it; mirrors the WEBHOOK_HMAC_SECRET pattern
// above. The value is a deterministic 64-char hex string suitable
// only for tests — never use this in production.
process.env.ENCRYPTION_KEY ??=
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// ---------------------------------------------------------------------------
// 2. Mock `@/lib/auth` so tests can control `auth()`'s return value
// ---------------------------------------------------------------------------
//
// We mock the whole module rather than just `auth` so that importing
// `@/lib/auth` doesn't drag in NextAuth's heavy initialisation path
// (which would in turn try to bind to env / crypto we don't supply).
//
// Tests interact with the mock via `setSession()` / `clearSession()`
// in `tests/integration/helpers.ts`, which simply re-assigns the
// resolved value on this `vi.fn()`.

vi.mock('@/lib/auth', () => {
  // Return the same shape `next-auth` exports from its v5 quartet so
  // anything calling `import { auth, signIn, signOut, handlers } from
  // '@/lib/auth'` resolves cleanly.
  const authMock = vi.fn().mockResolvedValue(null);
  return {
    auth: authMock,
    signIn: vi.fn(),
    signOut: vi.fn(),
    handlers: { GET: vi.fn(), POST: vi.fn() },
  };
});

// ---------------------------------------------------------------------------
// 3. Per-test cleanup — TRUNCATE all known tables, RESTART IDENTITY CASCADE
// ---------------------------------------------------------------------------

// Imported AFTER the env var is stamped above so the singleton ends up
// pointing at the test DB.
//
// We also call this once at module load so the very first test in a
// file runs against an empty DB even if a previous test run was killed
// mid-flight and left rows behind.
const dbModulePromise = import('@/lib/db');

/** Tables we touch from any route handler the integration suite tests. */
const TABLES_TO_TRUNCATE = [
  'PasswordResetToken',
  'FinanceTransaction',
  'Product',
  'FinanceAccount',
  'FinanceParty',
  'ActivityLog',
  'Note',
  'Attendance',
  'AIInsight',
  'Lead',
  'Campaign',
  'SocialPost',
  'DevTask',
  'User',
  'Setting',
] as const;

async function truncateAll(): Promise<void> {
  const { prisma } = await dbModulePromise;
  // One TRUNCATE call so cascades resolve transactionally and we don't
  // get tripped up by FK ordering. Quoting is required because Prisma
  // generates camel/PascalCase identifiers.
  const tableList = TABLES_TO_TRUNCATE.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`,
  );
}

beforeEach(async () => {
  await truncateAll();
  // Reset every Vitest mock so a `setSession()` from the previous test
  // doesn't leak forward. Individual tests will re-arm the mock as
  // needed via the helpers.
  vi.clearAllMocks();
  const authModule = await import('@/lib/auth');
  // Default to "no session" so any test that forgets to call
  // `setSession(...)` gets a clean 401 instead of an inherited admin.
  (authModule.auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    null,
  );
});

afterAll(async () => {
  const { prisma } = await dbModulePromise;
  await prisma.$disconnect();
});
