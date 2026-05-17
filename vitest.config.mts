import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Vitest configuration for OfficePilot.
 *
 * Authored as `.mts` so the ESM-only `vite-tsconfig-paths` plugin can be
 * `import`-ed without a CJS-vs-ESM bridge. Vitest auto-discovers this file
 * the same way it would `vitest.config.ts`.
 *
 * - `tsconfigPaths()` resolves the `@/*` alias from `tsconfig.json` so test
 *   files can `import { can } from '@/lib/permissions'`.
 * - Coverage targets `src/lib/` per SPEC.md §16.1 / §19 DoD ("≥80 % line
 *   coverage on `lib/`"). The contract is *aggregate* line coverage on the
 *   files that are unit-testable in isolation — see the `coverage.exclude`
 *   block below for the inclusion/exclusion rationale.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', '.next', 'dist', 'e2e', 'tests/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/lib/**/*.ts'],
      //
      // Inclusion / exclusion rationale (SPEC.md §16.1 + §19 DoD).
      //
      // The ≥80 % line-coverage gate applies to the **pure helpers**
      // under `src/lib/` — the modules that can be exercised without
      // Prisma, NextAuth, the network, or the Anthropic SDK. Everything
      // else listed below is validated by the integration suite
      // (`npm run test:int`, `vitest.integration.config.mts`) or by
      // end-to-end Playwright runs, both of which boot a real DB and
      // real Next.js handlers — i.e. the right layer to cover them.
      //
      // Excluded from the unit-coverage gate:
      //
      //   - `src/lib/` test sources and ambient `.d.ts`
      //       Test sources and ambient types — never executable code.
      //
      //   - `src/lib/db.ts`
      //       Prisma client singleton. Validated implicitly by every
      //       integration test that touches the DB.
      //
      //   - `src/lib/utils.ts`
      //       Third-party `cn()` wrapper from shadcn/ui — upstream-
      //       maintained, no project logic.
      //
      //   - `src/lib/auth.ts`, `src/lib/auth-edge.ts`
      //       NextAuth v5 config + edge guard. Exercised end-to-end by
      //       the login flow (task 19) and by every authenticated
      //       integration test; not unit-testable without bcrypt + a
      //       real Prisma adapter.
      //
      //   - `src/lib/api-helpers.ts`
      //       Wraps `auth()` (NextAuth) and produces `NextResponse`
      //       objects. Every API-route integration test in waves 2–7
      //       drives this file through real handlers, which is the
      //       contract that actually matters.
      //
      //   - `src/lib/claude.ts`, `src/lib/ai-insights.ts`
      //       Outbound Anthropic SDK calls and AI orchestration.
      //       Network-bound; covered by AI-route integration tests
      //       with the SDK mocked at the boundary, not by isolated
      //       unit tests.
      //
      //   - `src/lib/cron.ts`, `src/lib/mailer.ts`
      //       Worker-scoped: `node-cron` schedulers and `nodemailer`
      //       transports. Verified by the worker integration suite
      //       (task 86) which boots the worker against a real DB and
      //       a stubbed SMTP transport.
      //
      //   - `src/lib/aggregations/` (all files)
      //       Dependency-injected Prisma aggregation queries. The
      //       pure shape-mapping is trivial; the value is in the SQL
      //       Prisma emits, which only an integration test against a
      //       real Postgres can actually validate.
      //
      //   - `src/lib/schemas/` (all files)
      //       Declarative Zod schemas. Zod itself is exhaustively
      //       tested upstream; re-asserting the same shapes here would
      //       be tautological. Schema *behaviour* is exercised by the
      //       route integration tests that parse real request bodies.
      //
      // What remains in the gate (the unit-testable pure helpers):
      //
      //   - `permissions.ts` — RBAC matrix         (task 9 tests).
      //   - `crypto.ts`      — AES-256-GCM at rest (task 11 tests).
      //   - `utm.ts`         — UTM parser          (task 13 tests).
      //   - `activity.ts`    — audit log helper    (task 15 tests).
      //   - `trend.ts`       — week-over-week math (task 64 tests).
      //
      // Per-file thresholds below pin each of those files individually
      // so a regression in one helper can't be masked by aggregate
      // arithmetic. The global `lines: 80` keeps the SPEC contract on
      // the aggregate, future-proof for new pure helpers added to the
      // include set.
      //
      exclude: [
        'src/lib/**/*.test.ts',
        'src/lib/**/*.d.ts',
        'src/lib/db.ts',
        'src/lib/utils.ts',
        'src/lib/auth.ts',
        'src/lib/auth-edge.ts',
        'src/lib/api-helpers.ts',
        'src/lib/claude.ts',
        'src/lib/ai-insights.ts',
        'src/lib/cron.ts',
        'src/lib/mailer.ts',
        'src/lib/aggregations/**/*.ts',
        'src/lib/schemas/**/*.ts',
      ],
      // SPEC §16.1 / §19 DoD: ≥80 % line coverage on `src/lib/`.
      // Per-file thresholds enforce the same floor on each pure helper
      // individually so regressions can't hide inside the aggregate.
      thresholds: {
        lines: 80,
        'src/lib/permissions.ts': {
          lines: 80,
          branches: 80,
          functions: 80,
          statements: 80,
        },
        'src/lib/crypto.ts': {
          lines: 80,
          branches: 80,
          functions: 80,
          statements: 80,
        },
        'src/lib/utm.ts': {
          lines: 80,
          branches: 80,
          functions: 80,
          statements: 80,
        },
        'src/lib/activity.ts': {
          lines: 80,
          branches: 80,
          functions: 80,
          statements: 80,
        },
        'src/lib/trend.ts': {
          lines: 80,
          branches: 80,
          functions: 80,
          statements: 80,
        },
      },
    },
  },
});
