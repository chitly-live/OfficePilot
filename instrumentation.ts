/**
 * Next.js instrumentation hook — runs once when the server boots.
 *
 * Pre-deploy fix B5 from the panel audit. Next.js 14 looks for an
 * `instrumentation.ts` (or `.js`) at the workspace root (same level as
 * `next.config.mjs`) and calls its exported `register()` exactly once
 * per server start, before the first request is served. That's the
 * perfect hook for fail-fast validation of secrets like `DATABASE_URL`,
 * `ENCRYPTION_KEY`, `NEXTAUTH_SECRET`, etc.
 *
 * Two guards keep this safe outside of production runtime:
 *
 *   1. `NEXT_RUNTIME === 'nodejs'` — skip the edge runtime (used by
 *      middleware). Some required vars only exist on the Node side, and
 *      `node:crypto` (transitively imported by `src/lib/env.ts` via
 *      `src/lib/crypto.ts`) is not available on the edge anyway. The
 *      edge will fail fast at first use if a var is missing — that's a
 *      different problem.
 *
 *   2. `NEXT_PHASE === 'phase-production-build'` — skip during
 *      `next build`. The build process runs `register()` so that any
 *      prerendering passes through the same module graph as runtime,
 *      but build machines typically don't have production secrets set
 *      (the prod `.env` lives on the VPS, not in CI), and the build
 *      itself doesn't actually need them — it's just compiling. Runtime
 *      `next start` skips this guard and validates normally.
 *
 * See `src/lib/env.ts` for the full schema + validation logic.
 */

export async function register(): Promise<void> {
  // Skip edge runtime — middleware can't import node:crypto and many
  // env vars aren't exposed there anyway.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Skip during `next build`. The build invocation runs `register()`
  // for module-graph parity with runtime, but build machines don't have
  // prod secrets and the build itself doesn't need them.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  // Dynamic import so that the env module is only loaded in the
  // Node.js runtime path — keeps the edge bundle clean.
  const { validateEnv } = await import('./src/lib/env');
  validateEnv();
}
