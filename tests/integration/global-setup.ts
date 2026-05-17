/**
 * Vitest global setup for OfficePilot integration tests (task 29).
 *
 * Runs ONCE per `vitest run --config vitest.integration.config.mts`
 * invocation, in a separate Node process spawned by Vitest before any
 * test files are loaded. Its job is to make the integration test
 * Postgres database structurally ready:
 *
 *   1. Resolve the test database URL — `DATABASE_URL_TEST` if set,
 *      otherwise the local-dev fallback. Hard-fails if the URL points
 *      at a database whose name doesn't end in `_test` to avoid
 *      accidentally truncating a developer's primary `officepilot` DB
 *      from a misconfigured environment.
 *   2. Apply Prisma migrations via `prisma migrate deploy` so the test
 *      schema matches the latest migration (`prisma/migrations/`).
 *
 * Per-test row cleanup happens in `tests/integration/setup.ts`
 * (`beforeEach` → `resetDb`). This file is *only* concerned with the
 * one-time schema bootstrap.
 *
 * Returns a no-op teardown so Vitest's `globalSetup` contract is happy.
 */

import { execSync } from 'node:child_process';
import { URL } from 'node:url';

import { resolveTestDatabaseUrl } from './test-database-url';

export default async function globalSetup(): Promise<() => Promise<void>> {
  const dbUrl = resolveTestDatabaseUrl();

  // Defensive guard — refuse to run migrations against anything that
  // doesn't look like a test database. The `_test` suffix convention
  // matches the bootstrapping in this file's docstring and prevents a
  // typo'd `DATABASE_URL_TEST` from nuking a real database.
  const dbName = new URL(dbUrl).pathname.replace(/^\//, '').split('?')[0]!;
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `[integration] Refusing to run integration tests against database "${dbName}" — ` +
        `the database name must end in "_test". Set DATABASE_URL_TEST to a dedicated test DB.`,
    );
  }

  // `prisma migrate deploy` is idempotent — already-applied migrations
  // are skipped. We pass DATABASE_URL via the spawned env so the local
  // `.env` value (which points at the dev DB) doesn't shadow ours.
  // eslint-disable-next-line no-console
  console.log(`[integration] Applying migrations to ${dbName}…`);
  execSync('npx --no-install prisma migrate deploy', {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
    },
  });

  // Vitest expects globalSetup to (optionally) return a teardown fn.
  // We have nothing to clean up — the DB persists between runs by design
  // so engineers can inspect failed-test state.
  return async () => {
    /* no-op */
  };
}
