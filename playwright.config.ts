/**
 * Playwright configuration for OfficePilot end-to-end tests
 * (SPEC §16.3, task 90).
 *
 * Scope:
 *   • Drives the six critical-flow specs that live under `tests/e2e/`
 *     (login → dashboard, leads pipeline, campaign CAC, dev-task
 *     drag-and-drop, AI insight generation, etc.). The integration
 *     suite under `tests/integration/` is explicitly excluded so
 *     `npm run test:e2e` never tries to load Vitest-shaped specs.
 *
 *   • Boots the Next.js dev server on port 3000 via the `webServer`
 *     hook so a single command (`npx playwright test`) handles
 *     start-up + tear-down. In local dev we reuse an already-running
 *     `npm run dev` instance to keep iteration fast; CI always spawns
 *     a fresh one so tests run against a known-good build.
 *
 *   • Single Chromium project — the full Chrome/Firefox/Webkit matrix
 *     is overkill for our internal tooling and would triple our CI
 *     spend. Headless by default; pass `--headed` for debugging.
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',

  // Per-test timeout. 30s comfortably covers a Next.js page load +
  // a couple of network round-trips against the local Postgres test
  // DB. Anything slower than this is a real bug, not flake.
  timeout: 30_000,

  // Retry once in CI to absorb transient network blips against the
  // local dev server (e.g. a slow first compile). Locally we never
  // retry so flaky tests fail loudly.
  retries: process.env.CI ? 1 : 0,

  // Single worker by default — Playwright tests share a Postgres
  // schema and a single Next.js dev server, so parallelism would
  // race on row state. Individual tests use `cleanupTestData()` to
  // reset between runs.
  workers: 1,

  // Skip the Vitest integration suite that lives under the same
  // top-level `tests/` directory. Without this filter Playwright would
  // try to evaluate `.test.ts` files written for Vitest and crash on
  // unknown imports like `vitest`'s `vi`.
  testIgnore: ['**/tests/integration/**'],

  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    // Full traces on first retry are gold for debugging CI failures
    // without bloating happy-path runs.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // Exclude mobile-only specs from the desktop run — their viewport-
      // size assertions (e.g. "kanban renders one column at a time") only
      // hold at the Pixel 5 viewport in the mobile-chrome project below.
      testIgnore: ['**/mobile-*.spec.ts'],
    },
    {
      // Mobile project — covers SPEC §13.2 mobile responsiveness. We
      // emulate a Pixel 5 (393×851), which sits just above the 375px
      // breakpoint our layout targets and is good enough proxy for the
      // "small phone" form factor. Scoped to smoke / login / `mobile-*`
      // specs only so the desktop matrix stays the default surface for
      // the full critical-flow suite.
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
      testMatch: [
        '**/00-smoke.spec.ts',
        '**/01-login-dashboard.spec.ts',
        '**/mobile-*.spec.ts',
      ],
    },
  ],

  // Boot the Next.js dev server before running tests. We do NOT use
  // `next start` here because the test DB schema isn't necessarily
  // compatible with a production build, and the dev server gives us
  // server-component HMR for in-test debugging.
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    // Re-use a dev server you already have running locally — saves
    // ~10s on every `npm run test:e2e` invocation. CI never has a
    // pre-existing server, so this branch is dev-only.
    reuseExistingServer: !process.env.CI,
    // First-cold-start of `next dev` (compile + Prisma client init)
    // can take a while on a fresh checkout, so 120s is the sane upper
    // bound. Anything longer than that is a real environmental issue.
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    // Activates the deterministic Anthropic mock in `src/lib/claude.ts` so
    // the AI E2E spec can hit `POST /api/ai/generate` end-to-end without a
    // network call. See FIX-LIST.md §2.
    env: {
      MOCK_ANTHROPIC: '1',
    },
  },
});
