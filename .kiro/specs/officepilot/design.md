# Design Document: OfficePilot

> **Authoritative source:** `c:\Users\avina\Music\officepilot\SPEC.md` (referred to as `SPEC.md` throughout). This document condenses and references SPEC.md; in any conflict, SPEC.md wins. Section numbers below in parentheses (e.g. §3) point to SPEC.md.
>
> **Hard constraints from SPEC.md §0 and §20:** No feature additions beyond what SPEC.md lists. No library substitutions. No multi-tenancy, no public marketing site, no real-time, no native mobile, no platform-publishing automation, no lead scoring AI, no drip/A-B/landing/popup builders, no affiliate/coupon, no B2B "Negotiation/Won/Lost" pipeline.

## Overview

OfficePilot is an internal-only office cockpit for the Chitly team built as a Next.js 14 App Router app with Postgres, Prisma, NextAuth v5, and shadcn/ui. It contains 6 modules (Employees, Leads, Marketing, Social, Dev Tracking, AI Analysis) plus a Unified Dashboard and a Settings page. The differentiator is the AI Analysis module (§10) that uses Anthropic Claude with prompt caching to produce daily growth-analyst digests over week-over-week metrics.

The app targets a 5–15 person team, runs on a single Ubuntu 22.04 VPS behind Nginx with PM2 cluster mode, and uses node-cron (via PM2 worker) or Linux crontab for scheduled jobs.

## Tech Stack (locked — see SPEC.md §1)

| Layer | Choice | Version |
|---|---|---|
| Framework | Next.js (App Router) | 14.x |
| Language | TypeScript | 5.x |
| Styling | Tailwind CSS | 3.x |
| UI components | shadcn/ui + lucide-react | latest |
| ORM | Prisma | 5.x |
| Database | PostgreSQL | 15+ |
| Auth | NextAuth.js (Auth.js v5) | beta |
| AI | Anthropic SDK (`@anthropic-ai/sdk`) | latest |
| Charts | Recharts | latest |
| Forms | react-hook-form + zod | latest |
| Date | date-fns | latest |
| Tables | @tanstack/react-table | latest |
| Email | nodemailer (SMTP) | latest |
| Cron | node-cron (PM2 worker) or system crontab | — |
| Tests | Vitest (unit + integration) + Playwright (E2E) | latest |
| Deployment | Ubuntu 22.04 + PM2 + Nginx + Certbot | — |

**Models (runtime-configurable via `Setting.key = 'claude_model'`):** default `claude-sonnet-4-6` for daily digests; `claude-haiku-4-5-20251001` available for lightweight per-row classification. Code MUST read the model name from the `Setting` table — never hardcode.

## Architecture

```mermaid
graph TD
  Browser[Team Member Browser] -->|HTTPS| Nginx
  Nginx -->|reverse proxy :3000| NextApp[Next.js App Router cluster - PM2]
  NextApp --> Prisma[Prisma Client]
  Prisma --> PG[(PostgreSQL 15)]
  NextApp -->|@anthropic-ai/sdk| Claude[Anthropic Claude API]
  NextApp -->|nodemailer SMTP| SMTP[SMTP relay]
  Cron[System crontab / PM2 cron worker] -->|Bearer CRON_SECRET| NextApp
  Webhook[External lead source] -->|HMAC-signed POST| NextApp
```

### Layered structure

- **`src/app/(auth)`** — public login page only (§4).
- **`src/app/(app)`** — every page here is gated by `src/middleware.ts` checking the NextAuth session. Layout renders Sidebar + Topbar shell.
- **`src/app/api`** — REST handlers grouped per module. Every state-changing handler must call `logActivity(...)` (§14).
- **`src/lib`** — `db.ts`, `auth.ts`, `permissions.ts`, `activity.ts`, `crypto.ts`, `utm.ts`, `claude.ts`, `cron.ts`. These are the unit-testable surfaces (§16.1).
- **`prisma/`** — schema, migrations, seed.

Full folder layout MUST match SPEC.md §4 exactly.

## Roles, Auth, and Permissions

Per SPEC.md §2:

- Two roles: `ADMIN`, `EMPLOYEE`.
- Email + bcrypt(cost 12) credentials via NextAuth v5 JWT strategy. Session 7 days, sliding renewal.
- No public signup, no public password reset, no 2FA in v1.
- Seed admin from `ADMIN_SEED_EMAIL` + `ADMIN_SEED_PASSWORD` env vars (never hardcoded).
- `EMPLOYEE` role rules: read all modules; write only to records they own or created; cannot manage users; cannot see AI cost/usage settings.
- Deactivated users (`isActive = false`) MUST be rejected by the credentials provider.

`src/middleware.ts` enforces session presence on every `(app)/*` and `/api/*` route except `/api/auth/*`, `/api/webhooks/leads`, and `/api/cron/*` (which use their own bearer/HMAC checks).

## Database Schema

The Prisma schema in SPEC.md §3 is **copied verbatim** into `prisma/schema.prisma`. Do not edit fields, indexes, enums, or relations. Summary of models:

- `User` — auth + profile + role.
- `Lead` — leads with status, priority, owner, UTM attribution, follow-up date.
- `Campaign` — channels with budget/spend/metrics + UTM (unique `utmCampaign`).
- `SocialPost` — posts with platform, status, performance, `isWinner` flag.
- `DevTask` — features/bugs/chores/releases on a Kanban + roadmap.
- `Note`, `ActivityLog`, `Attendance`, `AIInsight`, `Setting`.

`Setting` table (kv) stores: `claude_model`, `daily_digest_hour`, `currency = INR`, encrypted `anthropic_api_key`, encrypted `webhook_hmac_secret`, `daily_digest_enabled` flag.

Seed script creates exactly 1 admin + default settings rows. Zero leads/campaigns/posts/tasks (real data only) per §3.1.

## Components and Interfaces

### `lib/db.ts`
Prisma client singleton (avoid hot-reload connection storms in dev).

### `lib/auth.ts`
NextAuth v5 config with Credentials provider. Includes `auth()`, `signIn`, `signOut` helpers. Augments session type with `role` and `userId` (declared in `src/types/next-auth.d.ts`).

### `lib/permissions.ts`
```ts
type Action = 'read' | 'write' | 'delete' | 'admin';
type Resource = 'user' | 'lead' | 'campaign' | 'socialPost' | 'devTask' | 'aiInsight' | 'setting';
function can(session, action: Action, resource: Resource, record?: { ownerId?: string; createdById?: string }): boolean;
```
Pure function. Unit-tested.

### `lib/activity.ts`
```ts
function logActivity(userId: string, action: string, entityType: string, entityId: string, metadata?: Record<string, unknown>): Promise<void>;
```
Always called from API handlers, never from UI.

### `lib/crypto.ts`
AES-256-GCM helpers using `ENCRYPTION_KEY` (32 bytes) per §12.2:
```ts
function encrypt(plaintext: string): string; // returns base64(iv | tag | ciphertext)
function decrypt(token: string): string;
```

### `lib/utm.ts`
```ts
function buildUtmUrl(base: string, params: { source: string; medium: string; campaign: string; content?: string; term?: string }): string;
function parseUtm(url: string): Partial<UtmParams>;
```
Pure functions. The marketing module's UTM generator (§7.2.5) and lead UTM auto-fill (§6.2.7) both use these.

### `lib/claude.ts`
Wraps `@anthropic-ai/sdk` with:
- Singleton client constructed lazily from decrypted `Setting('anthropic_api_key')` (fallback to `ANTHROPIC_API_KEY` env var).
- `generateInsight(scope, metrics) → AIInsight` using the SYSTEM_PROMPT in §10.4 with `cache_control: { type: 'ephemeral' }` on the system block.
- Reads model name from `Setting('claude_model')` (default `claude-sonnet-4-6`).
- Captures `usage.input_tokens`, `usage.cache_read_input_tokens`, `usage.output_tokens` and writes to `AIInsight.tokenUsage`.
- Graceful failure: if API key missing or call fails, return a structured error (caller surfaces friendly toast — never crash).

### `lib/cron.ts` + `app/api/cron/*`
Two endpoints:
- `POST /api/cron/daily-digest` — generates 4 insights (ads/social/leads/overall) sequentially with shared cached system prompt.
- `POST /api/cron/followup-reminders` — finds leads where `nextFollowUpAt::date = today` and writes dashboard alerts (and emails owners via nodemailer).

Both require `Authorization: Bearer ${CRON_SECRET}` (§10.6, §17.2.11). On error, write to `ActivityLog` and retry once after 1h (digest only).

### Cross-cutting UI components
- `components/layout/{Sidebar,Topbar,PageHeader}.tsx`
- `components/shared/{DataTable,EmptyState,ConfirmDialog,KanbanBoard}.tsx`
- Per-module folders mirror §4.

### Module API surface (full list in §5.3, §6.3, §7.3, §8.3, §9.3, §10.5)

```text
Employees:    GET/POST /api/users, GET/PATCH/DELETE /api/users/[id],
              POST /api/users/[id]/attendance, GET /api/users/[id]/stats
Leads:        GET/POST /api/leads, GET/PATCH/DELETE /api/leads/[id],
              POST /api/leads/import, POST /api/leads/[id]/notes,
              POST /api/webhooks/leads (HMAC)
Marketing:    GET/POST /api/campaigns, GET/PATCH/DELETE /api/campaigns/[id],
              GET /api/campaigns/[id]/leads, GET /api/campaigns/comparison
Social:       GET/POST /api/social/posts, GET/PATCH/DELETE /api/social/posts/[id],
              GET /api/social/winners, GET /api/social/stats
Dev:          GET/POST /api/dev/tasks, GET/PATCH/DELETE /api/dev/tasks/[id],
              GET /api/dev/releases, GET /api/dev/roadmap
AI:           GET /api/ai/insights, GET /api/ai/insights/[id],
              POST /api/ai/generate, POST /api/ai/insights/[id]/action,
              GET /api/ai/usage
Cron:         POST /api/cron/daily-digest, POST /api/cron/followup-reminders
Auth:         /api/auth/[...nextauth]
```

All handlers: validate body with zod, check session via `auth()`, gate via `can(...)`, log activity on writes.

## Data Models

The Prisma schema in SPEC.md §3 is the canonical source. Key invariants enforced at the application layer:

- **Lead validation:** Either `phone` or `email` MUST be provided on create (`lead.phone || lead.email`).
- **Lead status transitions:** Any → any allowed; every transition writes an `ActivityLog` row with `action = 'lead.status_changed'` and metadata `{ from, to }`.
- **CSV import:** Max 1000 rows per upload; dedup key is `(phone, email)` against existing rows; per-row errors reported before commit.
- **Campaign UTM:** `utmCampaign` is unique (DB constraint). Auto-link query: `Lead.utmCampaign = Campaign.utmCampaign`.
- **DevTask `completedAt`:** Set automatically when `status` transitions to `DONE`; cleared if moved back.
- **Attendance:** `(userId, date)` is unique (DB constraint).
- **AIInsight:** `tokenUsage` is sum of `input + cache_read + output` token counts per Claude response.

## Module Reference (per SPEC.md §5–§12)

Each module's pages, features, API, validation, and acceptance criteria are defined verbatim in SPEC.md. The build MUST implement exactly the listed features per module — no more, no fewer (§0).

| # | Module | SPEC.md section | Features count |
|---|---|---|---|
| 1 | Employees | §5 | 6 features |
| 2 | Leads | §6 | 8 features (incl. webhook) |
| 3 | Marketing | §7 | 6 features |
| 4 | Social | §8 | 6 features |
| 5 | Dev Tracking | §9 | 6 features |
| 6 | AI Analysis | §10 | 6 features |
| — | Unified Dashboard | §11 | 4 widget rows |
| — | Settings | §12 | 5 sections |

### AI Analysis specifics (§10)
- Metrics aggregation runs in code (Postgres window functions / `date_trunc` / JSONB) for both 7-day windows.
- Claude system prompt is cached (`cache_control: ephemeral`) so the daily digest's 4 sequential calls share the cache.
- Insight scopes: `ads`, `social`, `leads`, `overall`.
- The "Mark as actioned" button writes `ActivityLog` with `action = 'ai.insight_actioned'`.
- Empty data scope returns `summary = "Insufficient data"` (§10.7), not fabricated numbers.

### Unified Dashboard (§11)
Row 3 — **Release + Campaign Timeline** — is a horizontal 30-day timeline:
- Releases as vertical markers (filtered from `DevTask` where `type = RELEASE`).
- Active campaigns as horizontal bars colored by channel.
- Hover shows signups delta within that period (computed from `Lead.createdAt` within campaign date range).
- This is called out in §18 as needing extra polish.

## UI / UX Standards (per SPEC.md §13)

- Dense layout, indigo accent (`#6366f1`).
- Sidebar collapses to hamburger <768 px; Kanban renders one column at a time on mobile with swipe.
- Every list view has a designed `EmptyState` (icon + message + primary action).
- Skeleton loaders on data fetches >200 ms.
- Optimistic updates on Kanban drag-drop and toggles (winner, attendance, etc.).
- API errors surface as toasts; form errors inline; no raw stack traces to end users.
- Hindi/English mixed labels acceptable per §0.

## Activity Logging (per SPEC.md §14)

Every state-changing endpoint calls `logActivity(...)`. Action strings include (non-exhaustive):
`lead.created`, `lead.status_changed`, `lead.assigned`, `lead.deleted`, `campaign.metrics_updated`, `campaign.created`, `devtask.moved`, `devtask.completed`, `ai.insight_generated`, `ai.insight_actioned`, `user.created`, `user.deactivated`.

## Environment Variables (per SPEC.md §15)

`.env.example` MUST include exactly the keys listed in §15:
`DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `ADMIN_SEED_EMAIL`, `ADMIN_SEED_PASSWORD`, `ANTHROPIC_API_KEY`, `ENCRYPTION_KEY`, `CRON_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `WEBHOOK_HMAC_SECRET`.

## Error Handling

| Scenario | Response | Recovery |
|---|---|---|
| Missing/invalid session | 401 with `{ error: 'unauthenticated' }` | Redirect to `/login` from middleware |
| Permission denied | 403 with `{ error: 'forbidden' }` | Toast + return to previous page |
| Zod validation failure | 400 with `{ error, issues }` | Inline field errors |
| Anthropic API key missing | 200 with `summary = 'Insufficient data'` and structured note in metadata | Admin sets key in Settings |
| Anthropic call failure (non-key) | Log to `ActivityLog`, retry once after 1 h (cron only) | Manual retry via "Generate now" |
| Webhook HMAC mismatch | 401 with `{ error: 'invalid_signature' }` | Caller fixes secret |
| CSV import row error | Aggregate row-level errors, return preview before commit | Fix file, re-upload |
| Internal 500 | Log to `ActivityLog` + console; return generic toast string | Admin reviews logs |

## Testing Strategy

### Unit (Vitest, ≥80 % line coverage on `src/lib/`)
Targets: `permissions.ts`, `utm.ts`, `crypto.ts`, `activity.ts`.

### Integration (Vitest exercising route handlers directly with a test Postgres)
- `POST/PATCH /api/leads`, `POST /api/leads/import`
- `POST/PATCH /api/campaigns`
- `POST/PATCH /api/dev/tasks`
- `POST /api/ai/generate` (Anthropic mocked)
- `POST /api/webhooks/leads` (valid + invalid HMAC)

For each: happy path, 401 unauthenticated, 403 employee-vs-admin, 400 invalid body.

### E2E (Playwright — six flows from §16.3)
1. Login → land on dashboard.
2. Add lead → move through pipeline → verify activity log.
3. Create campaign → verify CAC math.
4. Drag dev task TODO → DONE → `completedAt` set.
5. Compose social post → schedule → see on calendar.
6. Trigger AI generate (mocked) → insight appears.

### Manual smoke checklist (§16.4)
12 items run by Kiro / reviewer on a populated dev DB.

### Performance budgets (§16.5)
- Initial JS <250 kB gz.
- Dashboard FCP <1.5 s local / <3 s VPS.
- API p95 <500 ms on list endpoints with 1 000 rows.

## Performance Considerations

- All Prisma list endpoints paginate (default 50, max 200 per page).
- Indexes per schema (`status`, `ownerId`, `source`, `nextFollowUpAt` on `Lead`; `status`, `channel`, `startDate` on `Campaign`; etc.) are sufficient for v1 volume.
- Dashboard widgets fetch in parallel (Promise.all) inside one server component.
- Use `select` projections to avoid hauling unused columns.
- Claude prompt caching reduces input-token cost on the 9 AM digest by ~75 % across the 4 scopes.

## Security Considerations

- Bcrypt cost 12, JWT session 7 days sliding.
- Anthropic API key + webhook HMAC secret stored AES-256-GCM-encrypted in `Setting` (§12.2). Never logged.
- HMAC verification on `POST /api/webhooks/leads` (timing-safe compare).
- Cron endpoints require `Authorization: Bearer $CRON_SECRET`.
- `ufw` rules: 22, 80, 443 open; 3000 blocked from public (§17.2.12).
- No raw stack traces returned to clients.
- No `console.log` in production code (§19 DoD).

## Deployment (per SPEC.md §17)

Ubuntu 22.04 LTS + Node 20 + Postgres 15 + Nginx + Certbot + PM2. Steps documented in `DEPLOY.md`:

1. Clone to `/var/www/officepilot`.
2. `npm ci --production=false`.
3. Postgres DB + role.
4. `.env.production` populated.
5. `npx prisma migrate deploy`.
6. `npx prisma db seed`.
7. `npm run build`.
8. `pm2 start ecosystem.config.js` (cluster mode + cron worker).
9. Nginx vhost → `localhost:3000`.
10. Certbot SSL.
11. Crontab entry: `0 9 * * * curl http://localhost:3000/api/cron/daily-digest -H "Authorization: Bearer $CRON_SECRET"`.
12. `ufw` config.
13. Daily `pg_dump` to `/var/backups/officepilot/`.

`ecosystem.config.js` per §17.3 (cluster of 2 instances, `npm start`, prod env).

## Dependencies

Locked per §1 — no substitutions. Runtime: `next@14`, `react@18`, `typescript@5`, `tailwindcss@3`, `prisma@5`, `@prisma/client@5`, `next-auth@5-beta`, `@anthropic-ai/sdk`, `recharts`, `react-hook-form`, `zod`, `date-fns`, `@tanstack/react-table`, `nodemailer`, `node-cron`, `bcryptjs`, `lucide-react`. Dev: `vitest`, `@playwright/test`, `eslint`, shadcn CLI.

## Correctness Properties

> *Property-based tests target the small set of pure helper functions in `src/lib/` where universal "for all inputs" claims hold. Most acceptance criteria in SPEC.md are CRUD/UI/integration concerns and are validated by integration + E2E tests instead (per the PBT decision guide).* 

### Property 1: Crypto round-trip preserves plaintext

For all UTF-8 strings `s` of length 0–4 096 bytes and any 32-byte key, `decrypt(encrypt(s))` returns a value equal to `s`.

**Validates: Requirements 12.1, 12.2**

### Property 2: Crypto encrypt is non-deterministic (fresh IV per call)

For all non-empty plaintexts `s` and any fixed key, two successive calls to `encrypt(s)` return two different ciphertexts (random 96-bit IV per call), yet both decrypt back to `s`.

**Validates: Requirements 12.1, 12.2**

### Property 3: UTM build/parse round-trip

For all parameter records `{ source, medium, campaign, content?, term? }` consisting of URL-safe ASCII tokens, parsing the URL produced by `buildUtmUrl(base, params)` yields a record equal to the original `params`.

**Validates: Requirements 7.1, 7.5**

### Property 4: HMAC verification is signature-correct

For all payload buffers `p` and any secret `k`, `verifyHmac(p, sign(p, k), k)` returns `true`; for any tampered payload `p' ≠ p` (single-bit flip), `verifyHmac(p', sign(p, k), k)` returns `false`.

**Validates: Requirements 6.4**

### Property 5: CSV import deduplication is idempotent

For any CSV row set `R` whose dedup keys are `(phone, email)`, importing `R` then importing `R` again creates the same set of `Lead` rows as importing `R` once (no duplicates introduced on re-import).

**Validates: Requirements 6.2, 6.3**

### Property 6: Trend percentage is sign-correct

For all non-negative numeric pairs `(prev, curr)` with `prev > 0`, the helper that computes `trendPct = (curr - prev) / prev * 100` satisfies: `curr > prev ⇒ trendPct > 0`, `curr < prev ⇒ trendPct < 0`, `curr == prev ⇒ trendPct == 0`. When `prev == 0`, the helper returns the sentinel `null` rather than `Infinity` or `NaN`.

**Validates: Requirements 10.2**

### Property 7: Permission monotonicity for admins

For all sessions where `session.user.role == 'ADMIN'`, all actions, all resources, and all record ownership shapes, `can(session, action, resource, record) == true`.

**Validates: Requirements 2.1, 5.1**

### Property 8: DevTask completion flag invariant

For all `DevTask` updates that transition `status` to `DONE`, the resulting record has `completedAt != null`; for all transitions away from `DONE`, the resulting record has `completedAt == null`.

**Validates: Requirements 9.4**
