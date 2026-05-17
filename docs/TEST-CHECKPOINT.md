# Test Checkpoint — OfficePilot

> SPEC.md §19 Definition of Done verification, run pre-deploy.
>
> Tasks reference: `.kiro/specs/officepilot/tasks.md` task **98. Test checkpoint**.
>
> Run host: Windows 11, Node 20, PowerShell. Local Postgres `officepilot_test` for integration.
> Run timestamp: 2026-05-23 ~21:46 IST (single fresh run, sequential).

---

## Summary

| Gate                       | Result | Notes                                                |
| -------------------------- | ------ | ---------------------------------------------------- |
| Unit tests (`npm run test`)              | ✅ PASS | 5 files, 200 tests, 704 ms                |
| Integration (`npm run test:int`)         | ✅ PASS | 18 files, 242 tests, 19.62 s              |
| Coverage (`npm run test:coverage`)       | ✅ PASS | 97.71 % lines aggregate on `src/lib/`     |
| E2E spec list (`npx playwright test --list`) | ✅ LISTED | 7 spec files, 9 tests (smoke + 6 flows) — not run |
| Build (`npx next build`)                 | ✅ PASS | Exit 0, 25 static pages generated, 56 routes |
| Lint (`npx next lint`)                   | ✅ PASS | Exit 0, no warnings or errors             |
| TypeScript (`npx tsc --noEmit`)          | ✅ PASS | Exit 0, zero type errors                  |

All §19 DoD test gates that can be exercised offline are green.

---

## 1. Unit tests — `npm run test`

- **Runner:** vitest 2.1.9, config `vitest.config.mts`.
- **Files:** 5
- **Tests:** 200 passed / 0 failed / 0 skipped
- **Duration:** 704 ms (transform 175 ms, collect 976 ms, tests 399 ms)
- **Exit code:** 0

| Test file                       | Tests | Duration |
| ------------------------------- | ----- | -------- |
| `src/lib/trend.test.ts`         | 23    | 32 ms    |
| `src/lib/crypto.test.ts`        | 19    | 65 ms    |
| `src/lib/permissions.test.ts`   | 61    | 96 ms    |
| `src/lib/utm.test.ts`           | 32    | 105 ms   |
| `src/lib/activity.test.ts`      | 65    | 101 ms   |

These are the pure-helper unit tests under `src/lib/` (RBAC matrix, AES-GCM at-rest crypto, UTM parser, activity log helper, week-over-week trend math). Includes property-based tests authored with `fast-check@3.23.2`; all property tests passed without counter-examples on this run.

---

## 2. Integration tests — `npm run test:int`

- **Runner:** vitest 2.1.9, config `vitest.integration.config.mts`, single-fork pool.
- **DB:** real local Postgres database `officepilot_test` (Prisma migrations applied via `tests/integration/global-setup.ts`).
- **Pre-step:** `Remove-Item Env:DATABASE_URL` so the integration global-setup can resolve `TEST_DATABASE_URL` cleanly.
- **Files:** 18
- **Tests:** 242 passed / 0 failed / 0 skipped
- **Duration:** 19.62 s (tests 16.53 s, transform 387 ms, collect 1.60 s)
- **Exit code:** 0

| Test file                                          | Tests | Duration |
| -------------------------------------------------- | ----- | -------- |
| `tests/integration/dev.tasks.test.ts`              | 22    | 1280 ms  |
| `tests/integration/leads.webhooks.test.ts`         | 16    | 860 ms   |
| `tests/integration/campaigns.detail.test.ts`       | 20    | 1069 ms  |
| `tests/integration/leads.collection.test.ts`       | 22    | 1167 ms  |
| `tests/integration/ai.generate.test.ts`            | 10    | 1140 ms  |
| `tests/integration/campaigns.collection.test.ts`   | 16    | 1045 ms  |
| `tests/integration/users.detail.test.ts`           | 24    | 1946 ms  |
| `tests/integration/leads.detail.test.ts`           | 16    | 1082 ms  |
| `tests/integration/social.posts.test.ts`           | 14    | 991 ms   |
| `tests/integration/leads.import.test.ts`           | 8     | 573 ms   |
| `tests/integration/users.collection.test.ts`       | 17    | 2097 ms  |
| `tests/integration/campaigns.comparison.test.ts`   | 7     | 403 ms   |
| `tests/integration/dev.releases.test.ts`           | 5     | 286 ms   |
| `tests/integration/settings.test.ts`               | 12    | 582 ms   |
| `tests/integration/leads.notes.test.ts`            | 10    | 614 ms   |
| `tests/integration/dev.roadmap.test.ts`            | 6     | 445 ms   |
| `tests/integration/users.stats.test.ts`            | 8     | 490 ms   |
| `tests/integration/users.attendance.test.ts`       | 9     | 460 ms   |

All API route handlers in waves 2–7 are exercised against real Prisma + Postgres.

---

## 3. Coverage — `npm run test:coverage`

- **Provider:** v8.
- **Include:** `src/lib/**/*.ts`. **Excludes:** test sources, ambient `.d.ts`, `db.ts`, `utils.ts`, `auth.ts`, `auth-edge.ts`, `api-helpers.ts`, `claude.ts`, `ai-insights.ts`, `cron.ts`, `mailer.ts`, `aggregations/**`, `schemas/**` (rationale documented in `vitest.config.mts`).
- **Threshold:** ≥ 80 % lines aggregate, plus per-file ≥ 80 % on each pure helper. **All thresholds met.**

### Aggregate

| Metric     | Total | Covered | Pct        |
| ---------- | ----- | ------- | ---------- |
| Lines      | 482   | 471     | **97.71 %** |
| Statements | 482   | 471     | 97.71 %    |
| Functions  | 22    | 22      | 100 %      |
| Branches   | 188   | 182     | 96.80 %    |

### Per-file

| File                           | Lines | Stmts | Funcs | Branches | Uncovered lines  |
| ------------------------------ | ----- | ----- | ----- | -------- | ---------------- |
| `src/lib/activity.ts`          | 99.58 | 99.58 | 100   | 97.11    | 557              |
| `src/lib/crypto.ts`            | 94.28 | 94.28 | 100   | 93.75    | 108–111          |
| `src/lib/permissions.ts`       | 93.61 | 93.61 | 100   | 94.44    | 191–193, 230–232 |
| `src/lib/trend.ts`             | 100   | 100   | 100   | 100      | —                |
| `src/lib/utm.ts`               | 100   | 100   | 100   | 100      | —                |

All five helpers comfortably clear the 80 % per-file floor mandated by SPEC §16.1 / §19. The handful of uncovered lines are defensive throw-branches (e.g., `crypto.ts` 108–111 unreachable-by-zod-validation guards, `permissions.ts` 191–193 / 230–232 admin-bypass safety nets).

---

## 4. E2E specs — `npx playwright test --list`

E2E suites are **listed only**, not executed (per task brief: needs live DB + dev server).

- **Total:** 9 tests across 7 spec files (chromium project).
- **Critical-flow coverage** (SPEC §16.3): 6 critical flows + 1 smoke spec = **all 7 expected files present**.

| # | File                                        | Tests | Critical flow                                                |
| - | ------------------------------------------- | ----- | ------------------------------------------------------------ |
| 1 | `tests/e2e/00-smoke.spec.ts`                | 1     | Smoke — home redirects to login                              |
| 2 | `tests/e2e/01-login-dashboard.spec.ts`      | 3     | Flow 1 — Login → Dashboard (+ logout, unauth redirect)       |
| 3 | `tests/e2e/02-lead-pipeline.spec.ts`        | 1     | Flow 2 — Lead pipeline create → drag NEW→INTERESTED          |
| 4 | `tests/e2e/03-campaign-cac.spec.ts`         | 1     | Flow 3 — Campaign CAC create → update spend/signups          |
| 5 | `tests/e2e/04-dev-kanban.spec.ts`           | 1     | Flow 4 — Dev kanban create → move to DONE → completedAt      |
| 6 | `tests/e2e/05-social-compose.spec.ts`       | 1     | Flow 5 — Social compose → schedule → calendar                |
| 7 | `tests/e2e/06-ai-insight.spec.ts`           | 1     | Flow 6 — AI insight pre-created → appears in `/ai` feed      |

`tests/e2e/helpers.ts` is a shared helper module (not a spec) and `tests/e2e/.gitkeep` is a directory marker.

Run instructions for the reviewer:

```powershell
# In a separate shell, with .env pointing at a seeded dev DB:
npm run dev
# Then in another shell:
npx playwright test
```

---

## 5. Build — `npx next build`

- **Tool:** Next.js 14.2.18.
- **Result:** ✅ Compiled successfully, 25 static pages generated.
- **Exit code:** 0.

### Route table summary

- **Total routes:** 56 (24 page routes including `/`, `/_not-found`, plus 32 API routes).
- **Middleware bundle:** 79.1 kB (NextAuth edge guard).
- **Shared first-load JS:** 87.4 kB (chunks 31.8 kB + 53.6 kB + 1.97 kB other).

| Route group        | Count | Notes                                                                 |
| ------------------ | ----- | --------------------------------------------------------------------- |
| App pages          | 24    | All dynamic (`ƒ`) except `_not-found` (static).                       |
| API handlers       | 32    | All dynamic (server-only).                                            |
| Static prerenders  | 25    | Per build report ("Generating static pages (25/25)").                 |

Largest pages by client bundle (informational):

| Route             | Size   | First Load JS |
| ----------------- | ------ | ------------- |
| `/marketing`      | 113 kB | 303 kB        |
| `/leads/[id]`     | 7.64 kB | 217 kB       |
| `/marketing/[id]` | 5.57 kB | 212 kB       |
| `/social/[id]`    | 6.46 kB | 212 kB       |
| `/leads`          | 6.86 kB | 208 kB       |
| `/employees/[id]` | 9.12 kB | 205 kB       |
| `/social`         | 8.45 kB | 205 kB       |

Recharts is the dominant first-load contributor on `/marketing` (campaign comparison view). No regressions vs. prior builds.

---

## 6. Lint — `npx next lint`

- **Result:** ✅ "No ESLint warnings or errors"
- **Exit code:** 0.
- **Config:** `.eslintrc.json` (`eslint-config-next` 14.2.18, eslint 8.57.1).

---

## 7. TypeScript — `npx tsc --noEmit`

- **Result:** ✅ Clean (no diagnostics emitted).
- **Exit code:** 0.
- **Compiler:** TypeScript 5.6.3, strict mode, `tsconfig.json`.

---

## 8. Known issues / deviations

### Skipped / `.skip` tests
**None.** A repo-wide grep for `it.skip`, `test.skip`, `describe.skip`, `xit`, `xtest` returns no matches. Every test in unit and integration suites is active.

### Flaky tests
**None observed on this run.** Both unit and integration suites passed deterministically on a single sequential pass. The integration config forces `pool: 'forks'` with `singleFork: true`, eliminating parallel-DB-access flake by construction.

### Stderr lines during integration tests (expected — not failures)
Two tests intentionally provoke error-path logging while still asserting the correct HTTP response:

- `tests/integration/leads.webhooks.test.ts > server configuration > returns 500 when WEBHOOK_HMAC_SECRET is unset` — logs `[api/webhooks/leads] WEBHOOK_HMAC_SECRET is not configured`. Expected behavior.
- `tests/integration/leads.webhooks.test.ts > server configuration > returns 500 when no ADMIN user exists` — logs `[api/webhooks/leads] no ADMIN user found to attribute webhook lead`. Expected behavior.
- `tests/integration/users.collection.test.ts` and `users.detail.test.ts` — Prisma logs `Unique constraint failed on the fields: (\`email\`)` while exercising the 409-conflict path. Expected behavior; the tests then assert the route returns a 409 with `target=email`.

These are part of the contract being verified, not bugs.

### Coverage gaps below 100 %
Documented in §3. All gaps are inside `src/lib/` and remain comfortably above the 80 % SPEC threshold:

- `crypto.ts` lines 108–111 — defensive guard for malformed ciphertext input shapes that Zod validation already rejects.
- `permissions.ts` lines 191–193 / 230–232 — admin-bypass safety nets that would only fire if the role enum drifted from the matrix at runtime.
- `activity.ts` line 557 — defensive `default` branch in the action-formatter `switch` (every `ActionType` is handled explicitly above; the default exists for future enum additions).

### Files outside the unit-coverage gate
Per the rationale block in `vitest.config.mts`, the following are validated by integration / E2E rather than unit coverage and are intentionally excluded from the threshold:

- `src/lib/db.ts`, `src/lib/utils.ts`
- `src/lib/auth.ts`, `src/lib/auth-edge.ts`, `src/lib/api-helpers.ts`
- `src/lib/claude.ts`, `src/lib/ai-insights.ts`
- `src/lib/cron.ts`, `src/lib/mailer.ts`
- `src/lib/aggregations/**`, `src/lib/schemas/**`

### E2E suites not executed in this checkpoint
Listed only, by design (task brief excludes running them — they require a seeded DB and a live dev server). Reviewer (Lal Singh) will run them per SPEC §17 / `tests/manual-smoke.md` during the deployment dress-rehearsal.

### Outstanding §19 DoD items not covered by this checkpoint
The §19 checklist also covers items this script can't verify offline:

- Manual smoke checklist (SPEC §16.4) — handled by reviewer; checklist authored at `tests/manual-smoke.md`.
- Mobile responsiveness (Chrome DevTools 375 px) — reviewer task.
- Real Anthropic API call producing a real insight — reviewer task with live API key.
- VPS deployment (PM2, Nginx, Certbot, cron, ufw, pg_dump) — covered by `DEPLOY.md` and tasks 99–103.

---

## Reproduction

```powershell
# From the workspace root c:\Users\avina\Music\officepilot
npm run test
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue; npm run test:int
npm run test:coverage
npx playwright test --list
npx next build
npx next lint
npx tsc --noEmit
```

All seven commands must exit with code 0 (or, for the Playwright list, print the 7-file roster) for this checkpoint to remain green.
