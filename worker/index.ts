/**
 * OfficePilot cron worker — long-running PM2 entry.
 *
 * SPEC.md §10.6 (Cron jobs) and §17.3 (PM2 ecosystem). PM2 spawns
 * this process as a second app alongside the Next.js cluster:
 *
 *     // ecosystem.config.js (task 101 — wave 11)
 *     module.exports = {
 *       apps: [
 *         { name: 'officepilot-web',  script: 'npm', args: 'start', ... },
 *         { name: 'officepilot-cron', script: 'dist/worker/index.js',
 *           exec_mode: 'fork', instances: 1,
 *           env: { NODE_ENV: 'production', CRON_SECRET: '...',
 *                  CRON_BASE_URL: 'http://localhost:3000',
 *                  CRON_TIMEZONE: 'Asia/Kolkata' } },
 *       ],
 *     };
 *
 * Build pipeline:
 *
 *     npm run worker:build      # tsc -p tsconfig.worker.json
 *     npm run worker:start      # node dist/worker/index.js
 *     npm run worker:dev        # tsx worker/index.ts (no compile)
 *
 * **What this worker does.** It registers two `node-cron` tasks at
 * the resolved schedule (per `Setting('daily_digest_hour')` etc.),
 * each anchored to the configured timezone. When a task fires it
 * POSTs to the matching `/api/cron/*` endpoint with the bearer
 * `CRON_SECRET`. The endpoints do all the actual work
 * (`generateScopeInsight`, `sendMail`, etc.); this worker is purely
 * the scheduling shell.
 *
 * **Why a separate process.** SPEC §10.6 names two viable layouts:
 * a node-cron worker, or a system crontab + curl. We pick the worker
 * so the schedule lives in one place (TypeScript, in-repo) and so
 * PM2 controls its lifecycle and log aggregation alongside the web
 * app.
 *
 * **Lifecycle.** `node-cron` keeps the event loop alive while it has
 * any registered tasks, so this entry doesn't need an explicit "stay
 * alive" loop. SIGINT / SIGTERM stop the registered tasks cleanly
 * before exiting so PM2's restart cycles never leave a lingering
 * `setInterval` to double-fire after relaunch.
 */

// Load environment variables from `.env` before reading any of them.
// Next.js does this implicitly for the web app, but a standalone
// worker has no such conduit. Explicit `dotenv/config` keeps PM2
// behaviour and `npm run worker:dev` behaviour identical without
// requiring a wrapper script.
import 'dotenv/config';

import * as cron from 'node-cron';

// Relative imports (not the `@/lib/...` alias) so the compiled
// `dist/worker/worker/index.js` resolves them via Node's standard
// module resolution at runtime — no `tsconfig-paths/register`
// shim required for `npm run worker:start`.
import {
  callCronEndpoint,
  getCronTimezone,
  getDailyDigestSchedule,
  getFollowupReminderSchedule,
  type CronCallResult,
} from '../src/lib/cron';
import { prisma } from '../src/lib/db';

// ---------------------------------------------------------------------------
// Endpoint paths
// ---------------------------------------------------------------------------

/** Daily AI digest endpoint — task 71, SPEC §10.6. */
const DAILY_DIGEST_PATH = '/api/cron/daily-digest';

/** Follow-up reminder endpoint — task 72, SPEC §6.2.5. */
const FOLLOWUP_REMINDERS_PATH = '/api/cron/followup-reminders';

// ---------------------------------------------------------------------------
// Env resolution
// ---------------------------------------------------------------------------

/**
 * Resolve required `CRON_SECRET`. Logs and exits the process when it's
 * missing — there's no safe default, and starting the worker without
 * it would leave us silently 401-ing every fire.
 */
function resolveCronSecret(): string {
  const secret = process.env.CRON_SECRET;
  if (secret === undefined || secret.trim().length === 0) {
    // eslint-disable-next-line no-console
    console.error(
      '[worker] CRON_SECRET is not set. Refusing to start the cron worker.',
    );
    process.exit(1);
  }
  return secret;
}

/**
 * Resolve the base URL the worker should target. Defaults to
 * `http://localhost:3000` since PM2 colocates web + worker on the
 * same VPS (SPEC §17.3). Operators can override via `CRON_BASE_URL`
 * for staging or split-host setups.
 */
function resolveBaseUrl(): string {
  const fromEnv = process.env.CRON_BASE_URL;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return fromEnv.trim().replace(/\/+$/, '');
  }
  return 'http://localhost:3000';
}

// ---------------------------------------------------------------------------
// Task body
// ---------------------------------------------------------------------------

/**
 * Wrap a `callCronEndpoint` invocation with structured logging so
 * PM2's stdout has timestamped entries for every fire — the operator
 * can scan `pm2 logs officepilot-cron` to see whether the schedule
 * is actually triggering.
 */
async function fireEndpoint(
  label: string,
  path: string,
  secret: string,
  baseUrl: string,
): Promise<CronCallResult> {
  const firedAt = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.info(`[worker] ${firedAt} firing ${label} (${path})`);
  return callCronEndpoint(path, secret, baseUrl);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Boot the worker:
 *
 *   1. Validate `CRON_SECRET`; exit on missing.
 *   2. Resolve schedules from `Setting` (with defaults from
 *      `src/lib/cron.ts`).
 *   3. Register the two `node-cron` tasks with `timezone` set.
 *   4. Wire SIGINT / SIGTERM to a graceful shutdown that stops every
 *      task and disconnects Prisma before exiting. This matters for
 *      `pm2 reload` cycles — without it the new process would race
 *      the old one's in-flight HTTP call.
 *
 * Errors during scheduling crash the worker on purpose: PM2 will
 * restart, and a syntactically invalid cron expression (or bad TZ
 * string) is unrecoverable until a human fixes the env / setting.
 */
async function main(): Promise<void> {
  const secret = resolveCronSecret();
  const baseUrl = resolveBaseUrl();
  const timezone = getCronTimezone();

  const dailyDigestExpr = await getDailyDigestSchedule();
  const followupExpr = await getFollowupReminderSchedule();

  // eslint-disable-next-line no-console
  console.info(
    `[worker] OfficePilot cron worker started ` +
      `(timezone=${timezone}, baseUrl=${baseUrl})`,
  );
  // eslint-disable-next-line no-console
  console.info(
    `[worker]   daily-digest:        '${dailyDigestExpr}'`,
  );
  // eslint-disable-next-line no-console
  console.info(
    `[worker]   followup-reminders:  '${followupExpr}'`,
  );

  const dailyDigestTask = cron.schedule(
    dailyDigestExpr,
    () => {
      // node-cron fires the callback synchronously; we explicitly
      // discard the returned promise (and `void` it) so a rejection
      // turns into the catch block's logged error rather than an
      // unhandled rejection.
      void fireEndpoint(
        'daily-digest',
        DAILY_DIGEST_PATH,
        secret,
        baseUrl,
      ).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[worker] daily-digest task crashed:', err);
      });
    },
    { timezone, name: 'officepilot:daily-digest' },
  );

  const followupTask = cron.schedule(
    followupExpr,
    () => {
      void fireEndpoint(
        'followup-reminders',
        FOLLOWUP_REMINDERS_PATH,
        secret,
        baseUrl,
      ).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[worker] followup-reminders task crashed:', err);
      });
    },
    { timezone, name: 'officepilot:followup-reminders' },
  );

  // -- Graceful shutdown --------------------------------------------------
  //
  // PM2 sends SIGINT on `pm2 stop` / `pm2 restart` and SIGTERM on
  // `pm2 delete`. We stop scheduled tasks (so no new fire is queued
  // while we're exiting) and disconnect Prisma before letting the
  // process die. The `shuttingDown` guard prevents a double-fire if
  // the operator hits Ctrl-C twice.
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.info(`[worker] received ${signal}; stopping scheduled tasks`);
    try {
      dailyDigestTask.stop();
      followupTask.stop();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[worker] error while stopping tasks:', err);
    }
    try {
      await prisma.$disconnect();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[worker] error while disconnecting Prisma:', err);
    }
    // eslint-disable-next-line no-console
    console.info('[worker] shutdown complete; exiting');
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[worker] fatal error during startup:', err);
  process.exit(1);
});
