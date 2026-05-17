import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Vitest configuration for OfficePilot **integration** tests (task 29).
 *
 * Distinct from the main `vitest.config.mts`, which targets pure-helper
 * unit tests under `src/lib/`. Integration tests live in
 * `tests/integration/(...)/(name).test.ts` and exercise route handlers
 * against a real Postgres test database.
 *
 * Key differences from the unit-test config:
 *
 *   - `globalSetup` runs migrations once per `vitest run` invocation
 *     (`tests/integration/global-setup.ts`).
 *   - `setupFiles` runs per-test setup that truncates the DB and
 *     re-arms the `auth()` mock (`tests/integration/setup.ts`).
 *   - `singleThread: true` forces all integration tests onto a single
 *     worker so concurrent `TRUNCATE` + INSERT loads don't collide on
 *     the shared test DB. Speed isn't a concern at this volume.
 *   - No coverage thresholds (the unit-test config owns those).
 *
 * Tests are run via `npm run test:int`; the standard `npm test` only
 * picks up unit tests.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    // Mirror the `@/*` path alias from `tsconfig.json`. The
    // `vite-tsconfig-paths` plugin reads aliases from `tsconfig.json`,
    // but its `include`/`exclude` only covers `src/**`; integration
    // test files live outside that tree, so we add the alias
    // explicitly here so they can `import` from `@/lib/db` and
    // `@/app/api/users/route`.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['node_modules', '.next', 'dist', 'e2e'],
    globalSetup: ['tests/integration/global-setup.ts'],
    setupFiles: ['tests/integration/setup.ts'],
    // Postgres + Prisma migrations + bcrypt = a chunky one-off bootstrap.
    // 60s gives `prisma migrate deploy` plenty of headroom on CI.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Force single-threaded execution so the shared test DB doesn't see
    // concurrent TRUNCATEs from parallel workers. The integration suite
    // is small enough that the serial cost is fine.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
