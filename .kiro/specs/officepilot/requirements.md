# Requirements Document

> **Feature:** OfficePilot
>
> **Authoritative source:** `c:\Users\avina\Music\officepilot\SPEC.md`. This document derives requirements from the acceptance criteria embedded in SPEC.md §5.4, §6.5, §7.4, §8.4, §9.4, §10.7, §11.2, plus the testing requirements in §16, the deployment runbook in §17, and the Definition of Done in §19. SPEC.md remains the source of truth — anything not stated here but stated in SPEC.md is still required.

## Introduction

OfficePilot is an internal-only office management cockpit for the Chitly team (5–15 users). It must deliver six modules (Employees, Leads, Marketing, Social, Dev Tracking, AI Analysis), one Unified Dashboard, and a Settings page, with role-based access for `ADMIN` and `EMPLOYEE`. The system MUST be feature-complete per SPEC.md §0 ("limited features only — no half-built features"), respect the locked tech stack (§1), and pass the Definition of Done in §19 before handoff.

## Glossary

- **OfficePilot** — the entire Next.js 14 application defined by SPEC.md.
- **Auth_System** — the NextAuth v5 credentials-provider subsystem in `src/lib/auth.ts` plus `src/middleware.ts`.
- **Permission_System** — the role/ownership rule engine in `src/lib/permissions.ts`.
- **Activity_Logger** — the helper `logActivity(...)` in `src/lib/activity.ts` writing to the `ActivityLog` Prisma model.
- **Crypto_Helper** — the AES-256-GCM helpers in `src/lib/crypto.ts`.
- **UTM_Helper** — the build/parse helpers in `src/lib/utm.ts`.
- **Lead_Webhook** — the public endpoint `POST /api/webhooks/leads` with HMAC verification.
- **Lead_API** — REST handlers under `/api/leads/*`.
- **Lead_Importer** — the CSV import handler `POST /api/leads/import`.
- **Lead_Kanban** — the drag-drop board on `/leads`.
- **Campaign_API** — REST handlers under `/api/campaigns/*`.
- **CAC_Calculator** — the helper that computes `spent / signups` per campaign.
- **UTM_Generator** — the page `/marketing/utm` and supporting form.
- **Social_API** — REST handlers under `/api/social/*`.
- **Social_Calendar** — the month-grid view on `/social`.
- **Dev_API** — REST handlers under `/api/dev/*`.
- **Dev_Kanban** — the drag-drop board on `/dev`.
- **Roadmap_View** — the 8-week horizon view on `/dev/roadmap`.
- **AI_Analysis** — the module under `/ai` and `/api/ai/*`.
- **AI_Generator** — the on-demand handler `POST /api/ai/generate`.
- **Daily_Digest_Cron** — the scheduled handler `POST /api/cron/daily-digest`.
- **Followup_Cron** — the scheduled handler `POST /api/cron/followup-reminders`.
- **Dashboard** — the page `/dashboard` with four widget rows.
- **Release_Campaign_Timeline** — Row 3 of the Dashboard (§11.1).
- **Settings_Page** — the page `/settings` with five sections.
- **Setting** — the kv `Setting` Prisma model.
- **claude_model_setting** — `Setting` row with `key = 'claude_model'`.
- **Build_System** — the `npm run build` and `npm run lint` toolchain.
- **Test_Suite** — Vitest unit + integration tests and Playwright E2E tests.
- **Deployment_Pack** — `README.md`, `DEPLOY.md`, `ecosystem.config.js`, `.env.example`.

## Requirements

### Requirement 1: Foundation, Tech Stack, and Project Structure

**User Story:** As a maintainer, I want OfficePilot built on the exact locked stack with the exact folder structure, so that the system is reproducible and matches SPEC.md.

#### Acceptance Criteria

1. THE OfficePilot SHALL use Next.js 14 App Router, TypeScript 5, Tailwind 3, shadcn/ui, Prisma 5, PostgreSQL 15+, NextAuth.js v5 (beta), `@anthropic-ai/sdk`, Recharts, react-hook-form, zod, date-fns, `@tanstack/react-table`, nodemailer, node-cron, Vitest, and Playwright (per SPEC.md §1).
2. THE OfficePilot SHALL match the file/folder layout defined in SPEC.md §4 exactly.
3. WHEN `npm run build` is executed on a clean checkout with valid env vars, THE Build_System SHALL succeed with zero TypeScript errors.
4. WHEN `npm run lint` is executed, THE Build_System SHALL pass with no errors.
5. THE OfficePilot SHALL NOT introduce libraries or features outside SPEC.md §0–§20 (no Drizzle, no Mantine, no real-time, no multi-tenancy, no public marketing site, no native mobile, no platform publishing, no lead scoring AI, no drip/A-B/landing/popup builders, no affiliate/coupon, no B2B "Negotiation/Won/Lost" pipeline).

### Requirement 2: Roles, Authentication, and Authorization

**User Story:** As an admin, I want only authenticated users with the right role to access the right pages and APIs, so that internal data stays internal.

#### Acceptance Criteria

1. THE Auth_System SHALL support exactly two roles: `ADMIN` and `EMPLOYEE` (SPEC.md §2.1).
2. WHEN a user submits valid credentials, THE Auth_System SHALL issue a JWT session valid for 7 days with sliding renewal.
3. IF a user submits invalid credentials or is deactivated (`isActive = false`), THEN THE Auth_System SHALL reject the login.
4. THE OfficePilot SHALL NOT expose a public signup, public password reset, or 2FA flow in v1.
5. WHEN a user without a session requests any `(app)/*` page or any `/api/*` endpoint other than `/api/auth/*`, `/api/webhooks/leads`, or `/api/cron/*`, THE Auth_System SHALL respond with HTTP 401 or redirect to `/login`.
6. WHILE a user has role `EMPLOYEE`, THE Permission_System SHALL allow read access to all modules and write access only to records where `ownerId` or `createdById` matches the user's id.
7. IF an `EMPLOYEE` requests an admin-only endpoint or page (e.g., `/employees/new`, `DELETE /api/leads/[id]`, AI cost/usage settings), THEN THE Permission_System SHALL respond with HTTP 403.
8. THE OfficePilot SHALL hash passwords using bcrypt with cost factor 12.
9. WHEN the seed script runs on a fresh database, THE OfficePilot SHALL create exactly one admin user using `ADMIN_SEED_EMAIL` and `ADMIN_SEED_PASSWORD` env vars (SPEC.md §2.3).

### Requirement 3: Database Schema and Migrations

**User Story:** As a developer, I want the Prisma schema and migrations to match SPEC.md §3 verbatim, so that the data model is unambiguous.

#### Acceptance Criteria

1. THE OfficePilot SHALL include `prisma/schema.prisma` whose models, enums, fields, defaults, relations, and indexes are byte-equivalent to the schema in SPEC.md §3.
2. WHEN `npx prisma migrate deploy` runs on a fresh PostgreSQL 15+ database, THE OfficePilot SHALL apply all migrations cleanly.
3. WHEN `npx prisma db seed` runs against the seeded migrations, THE OfficePilot SHALL create exactly one admin user, zero leads, zero campaigns, zero posts, zero tasks, and the default `Setting` rows `claude_model`, `daily_digest_hour`, and `currency = 'INR'` (SPEC.md §3.1).
4. THE Attendance model SHALL enforce uniqueness on `(userId, date)` at the DB layer.
5. THE Campaign model SHALL enforce uniqueness on `utmCampaign` at the DB layer.

### Requirement 4: Employees Module (SPEC.md §5)

**User Story:** As an admin, I want to manage employee accounts, attendance, and see per-employee performance, so that I can run the team.

#### Acceptance Criteria

1. THE OfficePilot SHALL implement the pages `/employees`, `/employees/new`, and `/employees/[id]` per SPEC.md §5.1.
2. THE OfficePilot SHALL implement exactly the six employee features in SPEC.md §5.2 (list & search, add, edit/deactivate, attendance log, activity timeline, performance snapshot).
3. WHEN an admin submits the new-employee form with valid input, THE OfficePilot SHALL create the user and display the credentials exactly once.
4. WHEN the newly created employee logs in with those credentials, THE Auth_System SHALL grant access.
5. IF a non-admin requests `/employees/new` or `POST /api/users`, THEN THE Permission_System SHALL respond with HTTP 403.
6. IF a deactivated employee attempts to log in, THEN THE Auth_System SHALL reject the login.
7. WHEN attendance is marked for the same `(userId, date)` twice, THE OfficePilot SHALL reject the second insert via the DB unique constraint.
8. THE OfficePilot SHALL implement the API endpoints listed in SPEC.md §5.3 with admin-vs-self permission rules.
9. WHEN `GET /api/users/[id]/stats` is called, THE OfficePilot SHALL return live counts of leads owned, leads converted in last 30 days, campaigns owned, and tasks completed in last 30 days.

### Requirement 5: Leads Module (SPEC.md §6)

**User Story:** As a sales user, I want to capture, track, and act on leads with a Kanban pipeline, follow-ups, CSV import, and webhook intake, so that no lead is lost.

#### Acceptance Criteria

1. THE OfficePilot SHALL implement the pages `/leads`, `/leads/new`, `/leads/[id]`, and `/leads/import` per SPEC.md §6.1.
2. THE OfficePilot SHALL implement exactly the eight lead features in SPEC.md §6.2 (create/edit, Kanban with 6 stages, CSV import with dedup, assign owner, follow-up reminders, notes timeline + activity, UTM source attribution, HMAC-signed webhook).
3. THE OfficePilot SHALL implement the API endpoints listed in SPEC.md §6.3.
4. IF a lead create request is missing both `phone` and `email`, THEN THE Lead_API SHALL reject the request with HTTP 400 and a zod validation error.
5. WHEN a lead is created with one or more of the inputs in SPEC.md §6.2.1, THE Lead_API SHALL persist the lead and the `/leads` list SHALL display it with the correct owner and status.
6. WHEN a lead is dragged from `NEW` to `INTERESTED` on the Lead_Kanban, THE Lead_API SHALL update `status` and THE Activity_Logger SHALL create an `ActivityLog` row with `action = 'lead.status_changed'` and metadata `{ from, to }`.
7. WHEN `nextFollowUpAt` for a lead is set to tomorrow, THE Followup_Cron SHALL surface a dashboard alert at 9 AM IST the next day.
8. WHEN a CSV with 50 rows of which 5 duplicate existing `(phone, email)` keys is imported, THE Lead_Importer SHALL import exactly 45 rows and report 5 duplicates row-by-row before commit.
9. THE Lead_Importer SHALL reject uploads with more than 1 000 rows.
10. WHEN `POST /api/webhooks/leads` is called with a payload signed by `WEBHOOK_HMAC_SECRET`, THE Lead_Webhook SHALL create a lead with source attribution from the payload (UTM fields populated where present).
11. IF `POST /api/webhooks/leads` is called with an invalid HMAC, THEN THE Lead_Webhook SHALL respond with HTTP 401 and SHALL NOT create a lead.
12. THE Lead_API SHALL allow any-to-any status transitions and SHALL log every transition.

### Requirement 6: Marketing Module (SPEC.md §7)

**User Story:** As a growth user, I want to manage campaigns, see CAC and channel comparisons, and generate UTM links, so that I can attribute spend to signups.

#### Acceptance Criteria

1. THE OfficePilot SHALL implement the pages `/marketing`, `/marketing/new`, `/marketing/[id]`, and `/marketing/utm` per SPEC.md §7.1.
2. THE OfficePilot SHALL implement exactly the six marketing features in SPEC.md §7.2.
3. THE OfficePilot SHALL implement the API endpoints listed in SPEC.md §7.3.
4. WHEN a campaign is created with `utmCampaign = 'meta_reels_july'`, THE Campaign_API SHALL surface all leads whose `utmCampaign` equals `'meta_reels_july'` under `GET /api/campaigns/[id]/leads`.
5. WHEN a campaign has `spent = 10000` and `signups = 50`, THE CAC_Calculator SHALL display CAC = ₹200 on both the list and detail pages.
6. WHEN the UTM_Generator form is submitted with valid inputs, THE UTM_Generator SHALL produce a copyable URL of shape `https://chitly.live/?utm_source=...&utm_medium=...&utm_campaign=...` (and `utm_content`, `utm_term` when provided).
7. WHEN `GET /api/campaigns/comparison` is called, THE Campaign_API SHALL return spend, signups, and CAC aggregated by channel for the last 30 days, ready for the comparison bar chart.

### Requirement 7: Social Media Module (SPEC.md §8)

**User Story:** As a social user, I want to plan, log, and learn from social posts in a calendar with a winners gallery, so that I can repeat what works.

#### Acceptance Criteria

1. THE OfficePilot SHALL implement the pages `/social`, `/social/new`, `/social/[id]`, and `/social/winners` per SPEC.md §8.1.
2. THE OfficePilot SHALL implement exactly the six social features in SPEC.md §8.2.
3. THE OfficePilot SHALL implement the API endpoints listed in SPEC.md §8.3.
4. THE OfficePilot SHALL NOT publish to any social platform automatically; status changes and `externalUrl` are recorded manually.
5. WHEN a post is scheduled for tomorrow, THE Social_Calendar SHALL render it on tomorrow's grid cell.
6. WHEN a post is updated to `status = PUBLISHED` with `likes = 500` and `isWinner = true`, THE OfficePilot SHALL display it on `/social/winners`.
7. WHEN the Social_Calendar is loaded with 100 posts, THE Social_Calendar SHALL render in under 1 second on local Postgres.
8. WHEN `GET /api/social/stats?period=7d` is called, THE Social_API SHALL return per-platform published count, total reach, and the top-performing post.

### Requirement 8: Dev Tracking Module (SPEC.md §9)

**User Story:** As a dev lead, I want a Kanban, bug inbox, release log, and 8-week roadmap, so that engineering work is visible and traceable.

#### Acceptance Criteria

1. THE OfficePilot SHALL implement the pages `/dev`, `/dev/bugs`, `/dev/releases`, `/dev/roadmap`, and `/dev/new` per SPEC.md §9.1.
2. THE OfficePilot SHALL implement exactly the six dev features in SPEC.md §9.2.
3. THE OfficePilot SHALL implement the API endpoints listed in SPEC.md §9.3.
4. WHEN a task is dragged from `TODO` to `DOING` on the Dev_Kanban, THE Dev_API SHALL persist `status = 'DOING'` and `updatedAt` SHALL change.
5. WHEN a task transitions to `status = 'DONE'`, THE Dev_API SHALL set `completedAt` to the current timestamp.
6. WHEN a release task is created with `type = 'RELEASE'`, `releaseVersion = 'v2.5.0'`, and `platform = 'iOS'`, THE OfficePilot SHALL display it at the top of `/dev/releases`.
7. WHEN the Roadmap_View is loaded with `weeks = 8`, THE Dev_API SHALL group tasks by `targetWeek` and render 8 columns horizontally.
8. WHEN a release has been live for 7 days, THE OfficePilot SHALL show a stats card with the count of bugs reported in the 7 days following its `releasedAt` (SPEC.md §9.2.6).

### Requirement 9: AI Analysis Module (SPEC.md §10)

**User Story:** As an admin, I want a daily growth-analyst digest and on-demand insights with token-usage tracking, so that I can act on weekly trends.

#### Acceptance Criteria

1. THE OfficePilot SHALL implement the pages `/ai` and `/ai/[id]` per SPEC.md §10.1.
2. THE OfficePilot SHALL implement exactly the six AI features in SPEC.md §10.2.
3. THE OfficePilot SHALL implement the API endpoints listed in SPEC.md §10.5.
4. THE AI_Analysis SHALL read the model name from claude_model_setting at runtime and SHALL NOT hardcode it; the default value SHALL be `claude-sonnet-4-6`, with `claude-haiku-4-5-20251001` available for lightweight classification.
5. WHEN an admin clicks "Generate now" with `scope = 'ads'`, THE AI_Generator SHALL return a new insight card with valid `trend`, `trendPct`, `summary`, and `suggestion` within 10 seconds (mocked Anthropic in tests).
6. WHEN the Daily_Digest_Cron runs at 09:00 IST, THE OfficePilot SHALL create exactly four `AIInsight` rows (scopes `ads`, `social`, `leads`, `overall`) and SHALL apply Anthropic prompt caching to the system prompt across the four sequential calls.
7. IF the Anthropic API key is missing or the call fails, THEN THE AI_Generator SHALL return a graceful error response and SHALL NOT crash the route.
8. IF a scope has no underlying data (e.g., zero campaigns for `ads`), THEN THE AI_Generator SHALL produce an insight with `summary = "Insufficient data"` and SHALL NOT fabricate numbers.
9. WHEN an insight is generated, THE OfficePilot SHALL persist `tokenUsage` (sum of input + cache_read + output tokens) on the `AIInsight` row.
10. WHEN an admin opens the AI usage settings page, THE OfficePilot SHALL display the current month's estimated Claude spend computed from `AIInsight.tokenUsage`.
11. WHEN an insight's "Mark as actioned" button is clicked, THE Activity_Logger SHALL write an `ActivityLog` row with `action = 'ai.insight_actioned'`.

### Requirement 10: Unified Dashboard (SPEC.md §11)

**User Story:** As any user, I want a single dashboard that shows today's pulse, AI insights, the release+campaign timeline, and follow-ups, so that I have full context at a glance.

#### Acceptance Criteria

1. THE Dashboard SHALL render four rows: Today's pulse (4 cards), latest AI insight per scope (4 cards), Release_Campaign_Timeline (full width), and Quick actions + reminders (SPEC.md §11.1).
2. THE Today's-pulse cards SHALL display new leads today + delta vs yesterday, ad spend today + delta, posts published today by platform, and open task count with in-progress subcount.
3. THE Release_Campaign_Timeline SHALL render the last 30 days with releases as vertical markers and active campaigns as horizontal bars, and SHALL show signups delta on hover for the hovered period.
4. THE Quick-actions row SHALL include "Today's follow-ups" and "Overdue follow-ups" lists plus buttons New Lead, New Task, New Post, Compose Campaign.
5. WHEN the Dashboard is loaded against a Postgres seeded with 1 000 leads, 100 campaigns, and 500 posts, THE Dashboard SHALL fully render in under 2 seconds locally.
6. WHEN viewport width is below 768 px, THE Dashboard SHALL collapse Row 1 to a 2×2 grid and stack the remaining rows vertically.

### Requirement 11: Settings Page and Encryption (SPEC.md §12)

**User Story:** As an admin, I want to manage profile, users, API keys, AI config, and hashtag library with encrypted secrets, so that sensitive credentials never leak.

#### Acceptance Criteria

1. THE Settings_Page SHALL implement five sections: Profile, Users (admin), API keys (admin), AI config (admin), Hashtag library (any user) — per SPEC.md §12.1.
2. WHEN an admin saves the Anthropic API key or webhook HMAC secret, THE Crypto_Helper SHALL encrypt the value with AES-256-GCM using `ENCRYPTION_KEY` before writing the `Setting` row.
3. WHEN any code path reads the Anthropic API key or webhook HMAC secret from the `Setting` table, THE Crypto_Helper SHALL decrypt it before use.
4. THE OfficePilot SHALL NOT log the plaintext API key, plaintext HMAC secret, or any user password.
5. THE Settings_Page SHALL hide AI cost/usage information from `EMPLOYEE` users.

### Requirement 12: UI/UX Standards (SPEC.md §13)

**User Story:** As any user, I want a consistent, dense, mobile-friendly UI with empty/loading/error states everywhere, so that the tool feels reliable.

#### Acceptance Criteria

1. THE OfficePilot SHALL use shadcn/ui Card, Table, Dialog, Form, Badge, Toast, Tabs primitives consistently.
2. THE OfficePilot SHALL apply the indigo accent `#6366f1` and standard status colors (green/red/amber/blue).
3. WHILE viewport width is below 768 px, THE OfficePilot SHALL collapse the sidebar to a hamburger and SHALL render Kanban boards one column at a time with swipe.
4. THE OfficePilot SHALL render a designed `EmptyState` (icon + message + primary action) on every list view; no blank screens.
5. WHEN any data fetch exceeds 200 ms, THE OfficePilot SHALL display a skeleton loader.
6. WHEN a user performs a Kanban drag-drop or a winner toggle, THE OfficePilot SHALL apply an optimistic UI update.
7. WHEN an API returns an error, THE OfficePilot SHALL display a toast with a friendly message and SHALL NOT show raw stack traces.
8. WHEN a form has validation errors, THE OfficePilot SHALL display them inline below the affected fields.

### Requirement 13: Activity Logging (SPEC.md §14)

**User Story:** As an admin, I want every state-changing action recorded, so that I can audit and explain anything that happened.

#### Acceptance Criteria

1. WHEN any state-changing API endpoint completes successfully, THE Activity_Logger SHALL persist an `ActivityLog` row with `userId`, `action`, `entityType`, `entityId`, and `metadata`.
2. THE Activity_Logger SHALL support at least the action strings listed in SPEC.md §14 (`lead.created`, `lead.status_changed`, `lead.assigned`, `lead.deleted`, `campaign.metrics_updated`, `campaign.created`, `devtask.moved`, `devtask.completed`, `ai.insight_generated`, `ai.insight_actioned`, `user.created`, `user.deactivated`).
3. THE Employees Module's `/employees/[id]` page SHALL display the last 30 actions across the system for that user.

### Requirement 14: Environment Variables and Secrets (SPEC.md §15)

**User Story:** As a deployer, I want a complete `.env.example` with every required key documented, so that fresh deployments are reproducible.

#### Acceptance Criteria

1. THE OfficePilot SHALL ship `.env.example` containing every key listed in SPEC.md §15: `DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `ADMIN_SEED_EMAIL`, `ADMIN_SEED_PASSWORD`, `ANTHROPIC_API_KEY`, `ENCRYPTION_KEY`, `CRON_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `WEBHOOK_HMAC_SECRET`.
2. THE OfficePilot SHALL NOT contain hardcoded secrets in source code.
3. THE OfficePilot SHALL NOT contain `console.log` calls in production code (per SPEC.md §19).

### Requirement 15: Testing (SPEC.md §16)

**User Story:** As a reviewer, I want comprehensive unit, integration, and E2E coverage of critical paths, so that I can sign off the build with confidence.

#### Acceptance Criteria

1. THE Test_Suite SHALL include Vitest unit tests for `permissions.ts`, `utm.ts`, `crypto.ts`, and `activity.ts` achieving at least 80 % line coverage on `src/lib/`.
2. THE Test_Suite SHALL include Vitest integration tests covering `POST /api/leads`, `PATCH /api/leads/[id]`, `POST /api/leads/import`, `POST /api/campaigns`, `PATCH /api/campaigns/[id]`, `POST /api/dev/tasks`, `PATCH /api/dev/tasks/[id]`, `POST /api/ai/generate` (with mocked Anthropic), and `POST /api/webhooks/leads` (valid + invalid HMAC).
3. FOR every endpoint covered in (2), THE Test_Suite SHALL include happy path, 401 unauthenticated, 403 permission-denied, and 400 validation-error cases.
4. THE Test_Suite SHALL include Playwright E2E coverage for the six flows in SPEC.md §16.3: login → dashboard; lead pipeline + activity log; campaign + CAC; dev task drag TODO→DONE + `completedAt`; social compose + calendar; AI generate (mocked) → insight appears.
5. THE Test_Suite SHALL be runnable via `npm run test` (Vitest) and `npm run test:e2e` (Playwright headless) and SHALL pass on a clean checkout.
6. THE OfficePilot SHALL meet the performance budgets in SPEC.md §16.5: initial JS <250 kB gz; dashboard FCP <1.5 s local; API p95 <500 ms on list endpoints with 1 000 rows.
7. THE OfficePilot SHALL pass every item in the manual smoke checklist in SPEC.md §16.4.

### Requirement 16: Cron Jobs (SPEC.md §10.6, §6.2.5)

**User Story:** As an admin, I want daily digests and follow-up reminders to run automatically, so that the team always opens to fresh insights and reminders.

#### Acceptance Criteria

1. THE Daily_Digest_Cron SHALL run at 09:00 IST and SHALL generate insights for scopes `ads`, `social`, `leads`, and `overall` sequentially, sharing a cached system prompt.
2. THE Followup_Cron SHALL run daily and SHALL surface dashboard alerts (and optionally email via nodemailer) for leads whose `nextFollowUpAt` falls on the current date.
3. WHEN a cron endpoint is called without `Authorization: Bearer ${CRON_SECRET}`, THE OfficePilot SHALL respond with HTTP 401 and SHALL NOT execute the job.
4. IF the Daily_Digest_Cron fails, THEN THE OfficePilot SHALL log to `ActivityLog` and SHALL retry once after 1 hour.

### Requirement 17: Deployment Pack (SPEC.md §17)

**User Story:** As a deployer, I want a runnable VPS deployment runbook, ecosystem config, and complete `.env.example`, so that I can deploy on Ubuntu 22.04 in under an hour.

#### Acceptance Criteria

1. THE Deployment_Pack SHALL include a `README.md` covering project intro, local dev setup, and npm scripts.
2. THE Deployment_Pack SHALL include a `DEPLOY.md` covering all 13 steps in SPEC.md §17.2.
3. THE Deployment_Pack SHALL include `ecosystem.config.js` matching the structure in SPEC.md §17.3 (cluster mode, 2 instances, `npm start`, prod env, port 3000).
4. THE Deployment_Pack SHALL include `.env.example` per Requirement 14.

### Requirement 18: Definition of Done (SPEC.md §19)

**User Story:** As the reviewer, I want a single checklist that gates handoff, so that I can declare the build done unambiguously.

#### Acceptance Criteria

1. THE OfficePilot SHALL satisfy all checkboxes in SPEC.md §19 before handoff.
2. WHEN every item in SPEC.md §19 is verified, THE OfficePilot SHALL be tagged `v0.1.0` and handed to the reviewer.
3. THE OfficePilot SHALL include at least one full AI insight generated successfully against a real Anthropic API key on a populated dev database (admin verifies).
