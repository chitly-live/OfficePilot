/**
 * Resolve the Postgres URL the integration test suite should target.
 *
 * Resolution order:
 *   1. `DATABASE_URL_TEST` environment variable (preferred — set in CI
 *      or in a developer's shell).
 *   2. `process.env.DATABASE_URL` rewritten so the database name has a
 *      `_test` suffix. This is a convenience for local dev where there's
 *      a single `.env` with `officepilot` as the dev DB; the integration
 *      suite then targets `officepilot_test` automatically.
 *   3. Hard-coded local fallback matching the dev `.env` defaults
 *      (`postgresql://postgres:Avinash%40123@localhost:5432/officepilot_test`).
 *
 * The result is exposed as a string and also stamped onto
 * `process.env.DATABASE_URL` so `prisma/db.ts`'s `PrismaClient` (which
 * reads from env at construction time) automatically picks it up when
 * imported by route handlers under test.
 */

const LOCAL_DEV_FALLBACK =
  'postgresql://postgres:Avinash%40123@localhost:5432/officepilot_test?schema=public';

/**
 * Compute the test DB URL without mutating any process state. Pure so
 * test files and the global setup can both call it deterministically.
 */
export function resolveTestDatabaseUrl(): string {
  const explicit = process.env.DATABASE_URL_TEST;
  if (explicit && explicit.trim().length > 0) {
    return explicit;
  }

  const dev = process.env.DATABASE_URL;
  if (dev && dev.trim().length > 0) {
    try {
      const url = new URL(dev);
      const dbName = url.pathname.replace(/^\//, '');
      if (dbName.length > 0 && !dbName.endsWith('_test')) {
        url.pathname = `/${dbName}_test`;
        return url.toString();
      }
      // Already a `_test`-suffixed DB — use as-is.
      return dev;
    } catch {
      // Fall through to the hard-coded fallback if the URL is malformed.
    }
  }

  return LOCAL_DEV_FALLBACK;
}
