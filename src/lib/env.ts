/**
 * Boot-time environment variable validation for OfficePilot.
 *
 * Pre-deploy fix B5 from the panel audit. Historically every secret in
 * the app (`DATABASE_URL`, `NEXTAUTH_SECRET`, `ENCRYPTION_KEY`,
 * `WEBHOOK_HMAC_SECRET`, `CRON_SECRET`, ...) was read **lazily** at first
 * use. That meant a misconfigured `.env.production` would let the server
 * boot "green" and then explode under traffic with a confusing
 * `getKey()`/`auth()` stack trace several hours into a deploy.
 *
 * This module fails the process **at boot** with a single aggregated
 * error message that names every missing or malformed variable. Wired
 * into Next.js via `instrumentation.ts` at the workspace root — Next 14
 * calls `register()` exactly once when the Node.js server starts, well
 * before any request hits a route handler.
 *
 * ## What gets validated
 *
 *   - **Required for all envs** (boot fails without these):
 *     `DATABASE_URL`, `NEXTAUTH_SECRET`, `ENCRYPTION_KEY`,
 *     `WEBHOOK_HMAC_SECRET`, `CRON_SECRET`.
 *
 *   - **Optional but warned** (the app still boots, but the relevant
 *     feature is degraded):
 *     `ANTHROPIC_API_KEY` (AI module disabled), `SMTP_*` (mailer
 *     disabled per `src/lib/mailer.ts` semantics — all five must be
 *     present *together* to enable outbound mail; partial config logs
 *     a warning).
 *
 *   - **Seed-only** (validated by {@link validateSeedEnv}, called from
 *     `prisma/seed.ts` rather than here):
 *     `ADMIN_SEED_EMAIL`, `ADMIN_SEED_PASSWORD`.
 *
 * ## How the lazy `env` accessor works
 *
 * The exported {@link env} object is a `Proxy` over the validated record.
 * The first time any property is read, {@link validateEnv} runs (if it
 * hasn't already), and subsequent property reads return cached values.
 * This means modules that import `env` don't pay the validation cost
 * twice and don't crash at import time if `validateEnv()` is also being
 * called from `instrumentation.ts` in parallel — the work is idempotent.
 *
 * ## NODE_ENV === 'test' relaxation
 *
 * The integration test harness (`tests/integration/setup.ts`) stamps a
 * fixed set of secrets onto `process.env` before any module under test
 * imports it. Unit tests don't even spin up a server, so they have no
 * baseline secrets at all. When `NODE_ENV === 'test'` we therefore
 * relax the **presence** requirement to "if set, must be valid" — a
 * missing `CRON_SECRET` is fine in tests, but a 10-char `ENCRYPTION_KEY`
 * is not, because that would mask real bugs in tests that exercise the
 * crypto layer.
 *
 * ## next build skip
 *
 * `next build` invokes `instrumentation.register()` once during the
 * `phase-production-build` step (so that any per-route prerendering
 * touches the same module graph as runtime). Build machines typically
 * don't have production secrets set, and the build itself doesn't
 * actually need them — it's just compiling. We detect
 * `process.env.NEXT_PHASE === 'phase-production-build'` and skip in
 * that case. The runtime `next start` invocation still validates.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Hex string of exactly 64 characters (32 bytes — the AES-256 key size).
 * Reused for `ENCRYPTION_KEY`; the same constraint lives in
 * `src/lib/crypto.ts`, but duplicating it here means a bad value fails
 * at boot instead of on the first encrypted setting read.
 */
const hex64 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be exactly 64 hex characters (32 bytes)');

/**
 * Schema for vars required in **every** environment (dev, staging,
 * production). Missing or empty → boot fails.
 */
const requiredSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'must not be empty')
    .startsWith('postgresql://', 'must start with "postgresql://"'),
  NEXTAUTH_SECRET: z
    .string()
    .min(32, 'must be at least 32 characters (use `openssl rand -base64 32`)'),
  ENCRYPTION_KEY: hex64,
  WEBHOOK_HMAC_SECRET: z
    .string()
    .min(32, 'must be at least 32 characters (use `openssl rand -hex 32`)'),
  CRON_SECRET: z
    .string()
    .min(32, 'must be at least 32 characters (use `openssl rand -hex 32`)'),
});

/**
 * Same shape as {@link requiredSchema}, but every field is optional and
 * empty strings are coerced to `undefined`. Used in `NODE_ENV === 'test'`
 * mode: a missing var is OK, but if the var IS set, its format is still
 * validated so tests can't accidentally pass with a malformed key.
 */
const requiredSchemaRelaxed = z.object({
  DATABASE_URL: z
    .string()
    .startsWith('postgresql://', 'must start with "postgresql://"')
    .optional(),
  NEXTAUTH_SECRET: z.string().min(32).optional(),
  ENCRYPTION_KEY: hex64.optional(),
  WEBHOOK_HMAC_SECRET: z.string().min(32).optional(),
  CRON_SECRET: z.string().min(32).optional(),
});

/**
 * Schema for vars consulted only by `prisma/seed.ts`. Validated by
 * {@link validateSeedEnv} on demand — `validateEnv()` does not require
 * these because they're not needed at server boot.
 */
const seedSchema = z.object({
  ADMIN_SEED_EMAIL: z.string().email('must be a valid email address'),
  ADMIN_SEED_PASSWORD: z.string().min(12, 'must be at least 12 characters'),
});

/**
 * Lowercased placeholder passwords that are known to be weak / left
 * over from the `.env.example` template. We don't fail the seed for
 * these (the user may genuinely be running their first dev seed and
 * intend to rotate later), but we shout loudly so the warning makes it
 * into the deploy log.
 */
const WEAK_SEED_PASSWORDS = new Set([
  'changeme!now',
  'password',
  'admin',
  'letmein',
]);

// ---------------------------------------------------------------------------
// Validated-env type
// ---------------------------------------------------------------------------

/**
 * Subset of `process.env` that {@link env} surfaces with strong types.
 * Only includes the vars listed here so that unrelated reads (e.g.
 * `process.env.PATH`) still go through `process.env` directly.
 */
export interface ValidatedEnv {
  // Required (or relaxed-optional in tests)
  DATABASE_URL: string;
  NEXTAUTH_SECRET: string;
  ENCRYPTION_KEY: string;
  WEBHOOK_HMAC_SECRET: string;
  CRON_SECRET: string;

  // Optional — present iff configured
  ANTHROPIC_API_KEY?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM?: string;

  // Test-only flag (Playwright). Intentionally omitted from .env.example.
  MOCK_ANTHROPIC?: string;

  // Standard Node env
  NODE_ENV: 'development' | 'production' | 'test';
}

// ---------------------------------------------------------------------------
// Internal cache + Proxy
// ---------------------------------------------------------------------------

/**
 * Result cache for {@link validateEnv}. `null` until the first run;
 * the validated object after that. Re-validation is a no-op — the
 * exported `env` accessor relies on this caching.
 *
 * Tests that need to re-run validation against a mutated `process.env`
 * call {@link _resetEnvForTests} to drop this cache.
 */
let cached: ValidatedEnv | null = null;

/**
 * Trim a string env var. Empty strings collapse to `undefined` so
 * `FOO=` in `.env` doesn't read as present-but-empty (a common
 * source of confusing "key is set but empty" runtime errors).
 */
function readOptional(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Coerce `NODE_ENV` to the three values we recognise. Anything outside
 * that union (e.g. `'staging'`) falls back to `'production'` — the
 * stricter mode — so a typo can't accidentally enable test relaxation
 * in a real deploy.
 */
function readNodeEnv(): 'development' | 'production' | 'test' {
  const raw = process.env.NODE_ENV;
  if (raw === 'development' || raw === 'test') return raw;
  return 'production';
}

/**
 * Validate `process.env` against the schema and cache the result.
 *
 * Idempotent: subsequent calls return the cached value without
 * re-reading `process.env`. Throws a single aggregated `Error` listing
 * every missing/invalid variable on failure.
 *
 * Called from:
 *   - `instrumentation.ts` at boot (the primary entry point).
 *   - The lazy {@link env} accessor on first property read.
 *   - The first invocation of {@link validateSeedEnv} so seed scripts
 *     get the same baseline guarantees.
 */
export function validateEnv(): ValidatedEnv {
  if (cached !== null) return cached;

  const nodeEnv = readNodeEnv();
  const isTest = nodeEnv === 'test';

  // Build a record of just the required keys with empty-string → undefined
  // coercion. Zod sees a clean shape and complains uniformly.
  const requiredInput: Record<string, string | undefined> = {
    DATABASE_URL: readOptional('DATABASE_URL'),
    NEXTAUTH_SECRET: readOptional('NEXTAUTH_SECRET'),
    ENCRYPTION_KEY: readOptional('ENCRYPTION_KEY'),
    WEBHOOK_HMAC_SECRET: readOptional('WEBHOOK_HMAC_SECRET'),
    CRON_SECRET: readOptional('CRON_SECRET'),
  };

  const result = isTest
    ? requiredSchemaRelaxed.safeParse(requiredInput)
    : requiredSchema.safeParse(requiredInput);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const key = issue.path.join('.') || '(root)';
        return `  - ${key}: ${issue.message}`;
      })
      .join('\n');

    throw new Error(
      'Environment variable validation failed.\n' +
        'The following required variables are missing or invalid:\n' +
        issues +
        '\n\nSee `.env.example` for the full list and generation commands ' +
        '(e.g. `openssl rand -hex 32` for 64-char hex keys, ' +
        '`openssl rand -base64 32` for NEXTAUTH_SECRET).',
    );
  }

  // Optional vars — warn but don't fail. Logged via console.warn so the
  // message lands in the deploy log without aborting boot.
  const anthropicKey = readOptional('ANTHROPIC_API_KEY');
  if (!isTest && anthropicKey === undefined) {
    console.warn(
      '[env] ANTHROPIC_API_KEY is not set. The AI Analysis module will be ' +
        'disabled until the key is configured (env var or Settings).',
    );
  }

  const smtp = {
    host: readOptional('SMTP_HOST'),
    port: readOptional('SMTP_PORT'),
    user: readOptional('SMTP_USER'),
    pass: readOptional('SMTP_PASS'),
    from: readOptional('SMTP_FROM'),
  };
  const smtpSet = Object.values(smtp).filter((v) => v !== undefined).length;
  if (!isTest && smtpSet > 0 && smtpSet < 5) {
    console.warn(
      '[env] SMTP configuration is incomplete (' +
        `${smtpSet}/5 vars set). Outbound mail (follow-up reminders) will be ` +
        'disabled until SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and ' +
        'SMTP_FROM are all set.',
    );
  }

  // SMTP_PORT format check — if set, must be a positive integer.
  // Mirrors the parser in src/lib/mailer.ts so a typo surfaces at boot.
  if (smtp.port !== undefined && !/^\d+$/.test(smtp.port)) {
    throw new Error(
      `Environment variable validation failed.\n  - SMTP_PORT: must be a ` +
        `positive integer (got "${smtp.port}"). See .env.example.`,
    );
  }

  cached = {
    // The schema already validated these; in production mode every key is
    // a non-empty string. In test mode they may be undefined, in which
    // case we fall back to an empty string so consumers reading
    // `env.DATABASE_URL` don't crash on `undefined`. Tests that need a
    // real DB URL set it via `tests/integration/setup.ts`.
    DATABASE_URL: result.data.DATABASE_URL ?? '',
    NEXTAUTH_SECRET: result.data.NEXTAUTH_SECRET ?? '',
    ENCRYPTION_KEY: result.data.ENCRYPTION_KEY ?? '',
    WEBHOOK_HMAC_SECRET: result.data.WEBHOOK_HMAC_SECRET ?? '',
    CRON_SECRET: result.data.CRON_SECRET ?? '',

    ...(anthropicKey !== undefined && { ANTHROPIC_API_KEY: anthropicKey }),
    ...(smtp.host !== undefined && { SMTP_HOST: smtp.host }),
    ...(smtp.port !== undefined && { SMTP_PORT: smtp.port }),
    ...(smtp.user !== undefined && { SMTP_USER: smtp.user }),
    ...(smtp.pass !== undefined && { SMTP_PASS: smtp.pass }),
    ...(smtp.from !== undefined && { SMTP_FROM: smtp.from }),

    ...(readOptional('MOCK_ANTHROPIC') !== undefined && {
      MOCK_ANTHROPIC: readOptional('MOCK_ANTHROPIC'),
    }),

    NODE_ENV: nodeEnv,
  };

  return cached;
}

/**
 * Validate the seed-only env vars and return them. Called by
 * `prisma/seed.ts` (and any future admin-bootstrap script). NOT called
 * by {@link validateEnv} because regular server boots never seed.
 *
 * Throws an aggregated `Error` if either var is missing/invalid. Emits
 * a `console.warn` (but does NOT throw) when the password matches one
 * of {@link WEAK_SEED_PASSWORDS} — the user may legitimately be running
 * their very first dev seed with a placeholder they intend to rotate.
 */
export function validateSeedEnv(): { email: string; password: string } {
  const input = {
    ADMIN_SEED_EMAIL: readOptional('ADMIN_SEED_EMAIL'),
    ADMIN_SEED_PASSWORD: readOptional('ADMIN_SEED_PASSWORD'),
  };
  const result = seedSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const key = issue.path.join('.') || '(root)';
        return `  - ${key}: ${issue.message}`;
      })
      .join('\n');
    throw new Error(
      'Seed environment variable validation failed.\n' +
        issues +
        '\n\nSet ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD in your `.env` ' +
        'before running `npx prisma db seed`. See .env.example.',
    );
  }

  const { ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD } = result.data;
  if (WEAK_SEED_PASSWORDS.has(ADMIN_SEED_PASSWORD.toLowerCase())) {
    console.warn(
      `[env] ADMIN_SEED_PASSWORD matches a known weak placeholder ` +
        `("${ADMIN_SEED_PASSWORD}"). Rotate it from Settings immediately ` +
        `after the first admin login.`,
    );
  }

  return { email: ADMIN_SEED_EMAIL, password: ADMIN_SEED_PASSWORD };
}

// ---------------------------------------------------------------------------
// Lazy accessor
// ---------------------------------------------------------------------------

/**
 * Strongly-typed, lazily-validated accessor for the env vars listed in
 * {@link ValidatedEnv}. The first property read triggers
 * {@link validateEnv} (if it hasn't run yet); subsequent reads are
 * straight property lookups on the cached record.
 *
 * Prefer `env.DATABASE_URL` over `process.env.DATABASE_URL!` in new
 * code — the former is typed and guaranteed non-empty in production
 * by the boot-time validation; the latter is `string | undefined` and
 * relies on the non-null assertion.
 */
export const env: ValidatedEnv = new Proxy({} as ValidatedEnv, {
  get(_target, prop) {
    const validated = validateEnv();
    return validated[prop as keyof ValidatedEnv];
  },
}) as ValidatedEnv;

/**
 * Test-only hook: drop the cached validation result so the next call
 * re-reads `process.env`. The underscore prefix and the `@internal`
 * doc-comment here are the contract — production code never calls this.
 *
 * @internal
 */
export function _resetEnvForTests(): void {
  cached = null;
}
