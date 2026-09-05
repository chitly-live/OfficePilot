/**
 * PM2 ecosystem manifest for OfficePilot.
 *
 * This file declares two processes managed by PM2:
 *
 *   1. `officepilot-web`  - The Next.js production server, running in
 *      cluster mode with 2 instances behind PM2's built-in load balancer.
 *      It is started via `npm start` (which runs `next start`). Next.js
 *      automatically loads environment variables from `.env.production`
 *      at boot, so secrets like CRON_SECRET, DATABASE_URL, AUTH_SECRET,
 *      etc. do not need to be re-declared here.
 *
 *   2. `officepilot-cron` - The scheduled-job worker, running in fork
 *      mode (single instance) from the compiled JS at
 *      `dist/worker/worker/index.js`. The worker uses `node-cron` to
 *      schedule HTTP calls to the Next.js app:
 *        - POST /api/cron/daily-digest         (08:00 server-local)
 *        - POST /api/cron/followup-reminders   (every 30 min)
 *      Both calls are authenticated with the CRON_SECRET bearer token.
 *      The worker explicitly loads `.env.production` via `dotenv/config`
 *      in its entry file, so env vars are available before scheduling.
 *
 * IMPORTANT: Build the worker before starting PM2:
 *   npm run worker:build
 *
 * Then launch the stack:
 *   pm2 start ecosystem.config.js
 *
 * See SPEC.md §17.3 for the full deployment runbook.
 */

module.exports = {
  apps: [
    {
      name: 'officepilot-web',
      // Run Next's own entry point, NOT `npm start`. PM2 cluster mode
      // shares the listening port between instances through Node's
      // `cluster` module, which only works when PM2 launches the Node
      // script itself. With `script: 'npm'` each instance spawned its own
      // `next start` child; the second one could never bind the port and
      // crash-looped until PM2 marked it "errored" (seen in prod on every
      // release: one instance online, one errored with 15 restarts).
      script: 'node_modules/next/dist/bin/next',
      args: 'start',
      instances: 2,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      max_memory_restart: '512M',
      error_file: './logs/web-error.log',
      out_file: './logs/web-out.log',
      time: true,
    },
    {
      name: 'officepilot-cron',
      script: 'dist/worker/worker/index.js',
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '256M',
      error_file: './logs/cron-error.log',
      out_file: './logs/cron-out.log',
      time: true,
      autorestart: true,
    },
  ],
};
