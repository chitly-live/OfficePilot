# Implementation Plan: OfficePilot

## Overview

Convert the OfficePilot feature design into a series of prompts for a code-generation LLM that will implement each step with incremental progress. Make sure that each prompt builds on the previous prompts, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step. Focus ONLY on tasks that involve writing, modifying, or testing code.This plan mirrors SPEC.md §18 (Day 1 → Day 23). Tasks are sized for one `spec-task-execution` invocation (single concern, 1–3 related files). Each task lists explicit dependencies on prior task IDs so the orchestrator can wave-batch independent tasks (e.g., once Wave 1 foundation is done, all Wave-3+ module API routes are independent of each other).

**Hard constraints carried from SPEC.md:**

- Build target directory: `c:\Users\avina\Music\officepilot\` (the Next.js app lives at the workspace root, alongside `SPEC.md`).
- Tech stack is locked (SPEC.md §1) — no substitutions.
- Out-of-scope features (SPEC.md §0, §20) MUST NOT appear in any task.
- The Claude model name MUST be read at runtime from `Setting('claude_model')` (default `claude-sonnet-4-6`); `claude-haiku-4-5-20251001` is available for lightweight classification. Never hardcode the model name.
- Tasks marked with `*` are optional test sub-tasks; non-`*` sub-tasks must be implemented.

**Conventions used below:**

- _Requirements:_ refers to clauses in `requirements.md`.
- _SPEC:_ refers to sections in `SPEC.md`.
- _Depends on:_ lists prior task IDs that MUST complete first. Tasks within the same wave (no shared dependency chain) can run in parallel.

## Task Dependency Graph

Tasks are organized into 11 waves that mirror SPEC.md §18 days. Within a wave, tasks with no shared dependency chain can be dispatched in parallel by the DAG scheduler. Cross-wave dependencies are listed explicitly via `_Depends on:_` lines on each task.

```json
{
  "waves": [
    { "wave": 1, "name": "Foundation", "specDays": "1-2", "tasks": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23], "dependsOn": [] },
    { "wave": 2, "name": "Employees", "specDays": "3", "tasks": [24, 25, 26, 27, 28, 29], "dependsOn": [1] },
    { "wave": 3, "name": "Leads", "specDays": "4-6", "tasks": [30, 31, 32, 33, 34, 35, 36, 37, 38, 39], "dependsOn": [1] },
    { "wave": 4, "name": "Marketing", "specDays": "7-8", "tasks": [40, 41, 42, 43, 44, 45, 46, 47], "dependsOn": [1] },
    { "wave": 5, "name": "Social", "specDays": "9-10", "tasks": [48, 49, 50, 51, 52, 53], "dependsOn": [1] },
    { "wave": 6, "name": "Dev", "specDays": "11-12", "tasks": [54, 55, 56, 57, 58, 59, 60, 61], "dependsOn": [1] },
    { "wave": 7, "name": "AI", "specDays": "13-15", "tasks": [62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73], "dependsOn": [1] },
    { "wave": 8, "name": "Dashboard", "specDays": "16-17", "tasks": [74, 75, 76, 77, 78, 79], "dependsOn": [3, 4, 5, 6, 7] },
    { "wave": 9, "name": "Settings", "specDays": "18-19", "tasks": [80, 81, 82, 83, 84, 85, 86], "dependsOn": [2, 3, 4, 5, 6, 7, 8] },
    { "wave": 10, "name": "Testing", "specDays": "20-22", "tasks": [87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98], "dependsOn": [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    { "wave": 11, "name": "Deployment", "specDays": "23", "tasks": [99, 100, 101, 102, 103], "dependsOn": [9, 10] }
  ],
  "notes": "Waves 2 through 7 are mutually independent of each other once Wave 1 is complete and can run in parallel. Per-task `_Depends on:_` lines are the authoritative fine-grained dependency edges."
}
```

Waves 2 through 7 are mutually independent of each other once Wave 1 is complete and can run in parallel.

## Tasks

- [x] 1. Initialize Next.js 14 + TypeScript 5 project at workspace root
  - Create `package.json`, `tsconfig.json`, `next.config.mjs`, `next-env.d.ts`, `.gitignore`, `.npmrc` at `c:\Users\avina\Music\officepilot\`.
  - Pin exact versions per SPEC.md §1: `next@14`, `react@18`, `react-dom@18`, `typescript@5`, `@types/node`, `@types/react`, `@types/react-dom`.
  - Add npm scripts: `dev`, `build`, `start`, `lint`, `test`, `test:e2e`, `db:migrate`, `db:seed`, `db:reset`.
  - Do NOT install module-specific deps yet; they come in their own tasks.
  - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - _SPEC: §1, §4_
  - _Depends on:_ none

- [x] 2. Configure Tailwind CSS 3 + base globals
  - Install `tailwindcss@3`, `postcss`, `autoprefixer`.
  - Create `tailwind.config.ts` with content globs covering `src/app/**`, `src/components/**`. Set indigo accent `#6366f1` and standard status colors per SPEC.md §13.1.
  - Create `postcss.config.mjs`.
  - Create `src/app/globals.css` with Tailwind directives.
  - _Requirements: 12.1, 12.2_
  - _SPEC: §13.1_
  - _Depends on: 1_

- [x] 3. Install and initialize shadcn/ui + lucide-react
  - Install `lucide-react` and the shadcn CLI (one-time use); run `npx shadcn@latest init` and commit `components.json`.
  - Generate the primitive set used across the app: Card, Table, Dialog, Form, Badge, Toast (sonner), Tabs, Input, Button, Label, Select, Textarea, Checkbox, Skeleton, Avatar, DropdownMenu, Sheet, Calendar, Popover.
  - All components land under `src/components/ui/`.
  - _Requirements: 12.1_
  - _SPEC: §13.1_
  - _Depends on: 2_

- [x] 4. Set up Prisma 5 + Postgres connection
  - Install `prisma@5`, `@prisma/client@5`, `tsx`.
  - Run `npx prisma init` and replace the generated schema with the verbatim schema from SPEC.md §3 (all enums, models, relations, indexes byte-equivalent).
  - Add `prisma/.gitignore` to ignore generated artifacts.
  - Create `src/lib/db.ts` exporting a Prisma client singleton (guards against hot-reload connection storms).
  - _Requirements: 3.1, 3.4, 3.5_
  - _SPEC: §3, §4_
  - _Depends on: 1_

- [x] 5. Create initial Prisma migration
  - Run `npx prisma migrate dev --name init` against a local Postgres 15+ instance and commit the generated SQL under `prisma/migrations/`.
  - Verify `npx prisma migrate deploy` applies cleanly on a fresh DB.
  - _Requirements: 3.2_
  - _SPEC: §3, §17.2.5_
  - _Depends on: 4_

- [x] 6. Implement seed script (`prisma/seed.ts`)
  - Write `prisma/seed.ts` (run via `tsx`) that creates exactly one admin user using `ADMIN_SEED_EMAIL` + `ADMIN_SEED_PASSWORD` (bcrypt cost 12), zero leads/campaigns/posts/tasks, and default `Setting` rows: `claude_model = 'claude-sonnet-4-6'`, `daily_digest_hour = '9'`, `currency = 'INR'`, `daily_digest_enabled = 'true'`.
  - Wire `prisma.seed` in `package.json` to `tsx prisma/seed.ts`.
  - _Requirements: 2.9, 3.3_
  - _SPEC: §2.3, §3.1_
  - _Depends on: 5_

- [x] 7. Author `.env.example`
  - Create `.env.example` at the project root containing every key from SPEC.md §15 with safe placeholder values and helper comments (`generate_with_openssl_rand_*`).
  - _Requirements: 14.1_
  - _SPEC: §15_
  - _Depends on: 1_

- [x] 8. Implement `src/lib/permissions.ts` (pure)
  - Export `can(session, action, resource, record?)` per design.md ("Components and Interfaces"). Encode the rules: ADMIN passes everything; EMPLOYEE reads anything; EMPLOYEE writes only when `record.ownerId === session.userId` or `record.createdById === session.userId`; EMPLOYEE never sees AI cost/usage.
  - _Requirements: 2.6, 2.7, 4.5, 11.5_
  - _SPEC: §2.1_
  - _Depends on: 1_

- [x] 9.* Vitest unit tests for `permissions.ts`
  - Install `vitest`, `@vitest/coverage-v8`. Add `vitest.config.ts` with `src/lib` coverage threshold ≥80%.
  - Cover: ADMIN-allowed-everything, EMPLOYEE-read-everything, EMPLOYEE-write-self, EMPLOYEE-write-other-denied, EMPLOYEE-AI-usage-denied.
  - Property test (`fast-check` if added; otherwise example-based): **Property 7 — Permission monotonicity for admins** → for any `(action, resource, record)`, `can(adminSession, action, resource, record) === true`.
  - _Requirements: 15.1_
  - _SPEC: §16.1_
  - _Depends on: 8_

- [x] 10. Implement `src/lib/crypto.ts` (AES-256-GCM)
  - Implement `encrypt(plaintext): string` (base64 of `iv | authTag | ciphertext`, 96-bit random IV per call) and `decrypt(token): string` using `ENCRYPTION_KEY` (32 bytes hex).
  - _Requirements: 11.2, 11.3, 11.4_
  - _SPEC: §12.2_
  - _Depends on: 1_

- [x] 11.* Vitest unit tests for `crypto.ts`
  - Property tests using `fast-check`: **Property 1 — round-trip preserves plaintext** for arbitrary UTF-8 strings (0–4096 bytes); **Property 2 — non-deterministic encrypt** (two encrypts yield different ciphertexts but both decrypt to the original).
  - _Requirements: 15.1_
  - _SPEC: §16.1_
  - _Depends on: 9, 10_

- [x] 12. Implement `src/lib/utm.ts` (pure)
  - Export `buildUtmUrl(base, params)` and `parseUtm(url)` matching design.md.
  - _Requirements: 6.6, 6.7_
  - _SPEC: §7.2.5_
  - _Depends on: 1_

- [x] 13.* Vitest unit tests for `utm.ts`
  - Property test: **Property 3 — UTM build/parse round-trip** for arbitrary URL-safe ASCII tokens.
  - _Requirements: 15.1_
  - _SPEC: §16.1_
  - _Depends on: 11, 12_

- [x] 14. Implement `src/lib/activity.ts`
  - Export `logActivity(userId, action, entityType, entityId, metadata?)` that writes to `ActivityLog`. Never throw — best-effort + console.error on failure.
  - _Requirements: 13.1, 13.2_
  - _SPEC: §14_
  - _Depends on: 4_

- [x] 15.* Vitest unit tests for `activity.ts`
  - Mock the Prisma client. Cover happy path, missing-metadata path, and Prisma-failure-doesn't-throw path.
  - _Requirements: 15.1_
  - _SPEC: §16.1_
  - _Depends on: 13, 14_

- [x] 16. Implement NextAuth v5 credentials provider in `src/lib/auth.ts`
  - Install `next-auth@5-beta.x`, `bcryptjs`, `zod`.
  - Configure Credentials provider: lookup user by email, bcrypt compare, reject if `isActive === false`.
  - JWT strategy, 7-day session, sliding renewal.
  - Augment session with `userId` and `role`. Create `src/types/next-auth.d.ts`.
  - Export `auth`, `signIn`, `signOut`, and `handlers` per Auth.js v5 conventions.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.8_
  - _SPEC: §2.2_
  - _Depends on: 4, 8_

- [x] 17. Wire NextAuth route handler
  - Create `src/app/api/auth/[...nextauth]/route.ts` re-exporting the handlers from `src/lib/auth.ts`.
  - _Requirements: 2.5_
  - _SPEC: §4_
  - _Depends on: 16_

- [x] 18. Implement role-based middleware
  - Create `src/middleware.ts` that matches `/(app)/*` and all `/api/*` except `/api/auth/*`, `/api/webhooks/leads`, and `/api/cron/*`. Reject unauthenticated requests with 401 (API) or redirect to `/login` (pages).
  - _Requirements: 2.5, 2.7_
  - _SPEC: §2.2, §4_
  - _Depends on: 16_

- [x] 19. Build login page `(auth)/login/page.tsx`
  - Form with email + password using `react-hook-form` + `zod`. POSTs through `signIn('credentials', ...)`. On success: redirect to `/dashboard`. On failure: inline error.
  - _Requirements: 2.2, 2.3, 12.1, 12.8_
  - _SPEC: §2, §13_
  - _Depends on: 16, 17, 3_

- [x] 20. Build app layout shell — Sidebar + Topbar
  - Create `src/app/(app)/layout.tsx` rendering Sidebar + Topbar + page slot.
  - Implement `src/components/layout/Sidebar.tsx` (collapsible, icons + labels, hamburger <768 px), `src/components/layout/Topbar.tsx` (search placeholder, user menu, logout), and `src/components/layout/PageHeader.tsx`.
  - Apply indigo accent `#6366f1`.
  - _Requirements: 12.1, 12.2, 12.3_
  - _SPEC: §13.1, §13.2, §4_
  - _Depends on: 18, 3_

- [x] 21. Build shared UI primitives
  - `src/components/shared/EmptyState.tsx` (icon + message + primary action).
  - `src/components/shared/DataTable.tsx` thin wrapper around `@tanstack/react-table` (install it now).
  - `src/components/shared/ConfirmDialog.tsx` (shadcn Dialog).
  - `src/components/shared/KanbanBoard.tsx` generic drag-drop board (HTML5 DnD; mobile single-column swipe).
  - _Requirements: 12.1, 12.3, 12.4, 12.5_
  - _SPEC: §13.1–§13.4_
  - _Depends on: 3_

- [x] 22. Build root `app/layout.tsx`, `app/page.tsx`, and `/dashboard` placeholder shell
  - `app/layout.tsx` imports globals + Toaster.
  - `app/page.tsx` redirects to `/dashboard` if authed, else `/login`.
  - `app/(app)/dashboard/page.tsx` placeholder ("Dashboard coming in Wave 9") — wired into the Sidebar nav.
  - _Requirements: 1.2, 12.1_
  - _SPEC: §4_
  - _Depends on: 19, 20_

- [x] 23. Foundation checkpoint
  - Run `npm run build` and `npm run lint` — must pass with zero errors. Run `npx prisma migrate deploy && npx prisma db seed` on a fresh local DB — must succeed. Confirm login → dashboard placeholder works end-to-end.
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 1.3, 1.4, 2.9, 3.2, 3.3_
  - _SPEC: §19_
  - _Depends on: 6, 7, 9, 11, 13, 15, 21, 22_

---

## Wave 2 — Employees Module (SPEC.md §18 Day 3)

- [x] 24. Zod schemas + DTOs for users
  - Create `src/lib/validators/user.ts` with `createUserSchema`, `updateUserSchema`, `attendanceSchema`. Used by both API routes and forms.
  - _Requirements: 4.2, 4.7, 4.8_
  - _SPEC: §5_
  - _Depends on: 23_

- [x] 25. API: `GET/POST /api/users`
  - `src/app/api/users/route.ts`. GET returns scoped list (admin sees all; employee sees self + minimal team list). POST is admin-only, hashes password (bcrypt 12), logs `user.created`.
  - _Requirements: 4.2, 4.3, 4.5, 4.8, 13.1, 13.2_
  - _SPEC: §5.3_
  - _Depends on: 24, 16_

- [x] 26. API: `GET/PATCH/DELETE /api/users/[id]`
  - `src/app/api/users/[id]/route.ts`. PATCH allows admin-anything OR self-limited fields. DELETE = soft delete `isActive=false` (admin only), logs `user.deactivated`.
  - _Requirements: 4.5, 4.6, 4.8, 13.1, 13.2_
  - _SPEC: §5.3_
  - _Depends on: 24, 16_

- [x] 27. API: `POST /api/users/[id]/attendance` + `GET /api/users/[id]/stats`
  - `src/app/api/users/[id]/attendance/route.ts` enforces `(userId, date)` uniqueness via Prisma try/catch on P2002.
  - `src/app/api/users/[id]/stats/route.ts` returns leads owned, leads converted (30 d), campaigns owned, tasks completed (30 d).
  - _Requirements: 4.7, 4.9_
  - _SPEC: §5.3_
  - _Depends on: 24, 16_

- [x] 28. Pages: `/employees`, `/employees/new`, `/employees/[id]`
  - List with search (`@tanstack/react-table`), avatar, name, email, role, designation, status, last active.
  - New form (admin only) with auto-generate password option.
  - Detail page: profile + recent activity + attendance + performance snapshot card.
  - _Requirements: 4.1, 4.2, 4.3_
  - _SPEC: §5.1, §5.2_
  - _Depends on: 21, 25, 26, 27_

- [x] 29.* Vitest integration tests for users endpoints
  - Cover happy path, 401, 403 (employee creating user), 400 (bad zod). Use a test Postgres or fresh transaction-per-test pattern.
  - _Requirements: 15.2, 15.3_
  - _SPEC: §16.2_
  - _Depends on: 25, 26, 27_

---

## Wave 3 — Leads Module (SPEC.md §18 Day 4–6)

> Wave 3 tasks 30–34 are independent of Wave 4–7 module work and can run in parallel with their analogous module tasks once Wave 1 (foundation) is done.

- [x] 30. Zod schemas for leads
  - `src/lib/validators/lead.ts` with `createLeadSchema` (asserts `phone || email`), `updateLeadSchema`, `csvRowSchema`.
  - _Requirements: 5.4_
  - _SPEC: §6.4_
  - _Depends on: 23_

- [x] 31. API: `GET/POST /api/leads`
  - List paginated (default 50, max 200), filterable by `status, source, owner, dateRange, priority`. POST creates a lead, logs `lead.created`. UTM auto-fill from request body when present.
  - _Requirements: 5.3, 5.5, 13.1, 13.2_
  - _SPEC: §6.3_
  - _Depends on: 30, 14_

- [x] 32. API: `GET/PATCH/DELETE /api/leads/[id]` + notes
  - PATCH logs every status change with `{from, to}` metadata. DELETE is admin-only (hard delete).
  - `POST /api/leads/[id]/notes` writes a `Note` row + activity log.
  - _Requirements: 5.6, 5.12, 13.1, 13.2_
  - _SPEC: §6.3_
  - _Depends on: 30, 14_

- [x] 33. API: `POST /api/leads/import` (CSV)
  - Stream-parse CSV, max 1 000 rows, dedupe on `(phone, email)` against existing rows, return per-row errors before commit.
  - _Requirements: 5.8, 5.9_
  - _SPEC: §6.2.3, §6.4_
  - _Depends on: 30_

- [x] 34. API: `POST /api/webhooks/leads` (HMAC)
  - Public route (excluded from middleware). Verify HMAC-SHA256 against `WEBHOOK_HMAC_SECRET` (stored encrypted in `Setting`; decrypt via `crypto.ts`) using `crypto.timingSafeEqual`. On valid → create lead with UTM source attribution. On invalid → 401.
  - _Requirements: 5.10, 5.11_
  - _SPEC: §6.2.8, §6.3_
  - _Depends on: 30, 10_

- [~] 35.* Vitest integration tests for `POST /api/webhooks/leads`
  - Property test: **Property 4 — HMAC verification is signature-correct** (any single-bit flip rejects). Plus example tests for valid + invalid headers and missing body.
  - _Requirements: 15.2, 15.3, 15.4_
  - _SPEC: §16.2_
  - _Depends on: 34_

- [~] 36.* Vitest integration tests for leads endpoints
  - Cover `POST /api/leads`, `PATCH /api/leads/[id]`, `POST /api/leads/import` with happy/401/403/400.
  - Property test: **Property 5 — CSV import deduplication is idempotent** (importing the same set twice yields the same row count).
  - _Requirements: 15.2, 15.3_
  - _SPEC: §16.2_
  - _Depends on: 31, 32, 33_

- [~] 37. Pages: `/leads` (table + filters), `/leads/new`, `/leads/[id]`
  - Table with filters (status, source, owner, date range, priority); bulk actions (assign owner, change status).
  - New form using `react-hook-form` + zod.
  - Detail page: profile, notes timeline, status changes, activity log.
  - _Requirements: 5.1, 5.2, 5.5_
  - _SPEC: §6.1, §6.2.1, §6.2.6_
  - _Depends on: 21, 31, 32_

- [~] 38. Lead Kanban view (toggle on `/leads`)
  - Use `KanbanBoard.tsx` with the 6 stages (`NEW → CONTACTED → INTERESTED → FOLLOW_UP → CONVERTED → LOST`). Drag-drop calls `PATCH /api/leads/[id]`. Optimistic update.
  - _Requirements: 5.2, 5.6, 12.6_
  - _SPEC: §6.2.2_
  - _Depends on: 21, 32, 37_

- [~] 39. Page: `/leads/import` (CSV with column mapping preview)
  - Upload → parse → render mapping UI → preview duplicates → commit.
  - _Requirements: 5.2, 5.8_
  - _SPEC: §6.1, §6.2.3_
  - _Depends on: 33, 21_

---

## Wave 4 — Marketing Module (SPEC.md §18 Day 7–8)

- [~] 40. Zod schemas for campaigns
  - `src/lib/validators/campaign.ts`. UTM fields auto-suggested from `name`.
  - _Requirements: 6.2, 6.3_
  - _SPEC: §7.4_
  - _Depends on: 23_

- [~] 41. API: `GET/POST /api/campaigns`
  - List + create. Logs `campaign.created`.
  - _Requirements: 6.3, 13.1, 13.2_
  - _SPEC: §7.3_
  - _Depends on: 40, 14_

- [~] 42. API: `GET/PATCH/DELETE /api/campaigns/[id]` + `GET /api/campaigns/[id]/leads`
  - PATCH allows updating spend/impressions/clicks/signups/conversions; logs `campaign.metrics_updated`.
  - `GET /api/campaigns/[id]/leads` joins on `Lead.utmCampaign === Campaign.utmCampaign`.
  - _Requirements: 6.4, 13.1, 13.2_
  - _SPEC: §7.3_
  - _Depends on: 40, 14_

- [~] 43. API: `GET /api/campaigns/comparison`
  - Aggregates spend, signups, CAC by channel for last 30 days. Single Postgres query using `date_trunc` + GROUP BY.
  - _Requirements: 6.7_
  - _SPEC: §7.3, §7.2.6_
  - _Depends on: 40_

- [~] 44.* Vitest integration tests for campaigns endpoints
  - Cover `POST /api/campaigns`, `PATCH /api/campaigns/[id]` with happy/401/403/400.
  - _Requirements: 15.2, 15.3_
  - _SPEC: §16.2_
  - _Depends on: 41, 42_

- [~] 45. Pages: `/marketing` (list + summary cards), `/marketing/new`, `/marketing/[id]`
  - List with summary cards (total spend MTD, total signups MTD, blended CAC).
  - Detail page with Recharts line chart (spend vs signups over time), linked leads, ROI calc.
  - CAC = `spent / signups`.
  - _Requirements: 6.1, 6.2, 6.5_
  - _SPEC: §7.1, §7.2.1–§7.2.4_
  - _Depends on: 21, 41, 42_

- [~] 46. Page: `/marketing/utm` (UTM generator)
  - Form (base URL, source, medium, campaign, content, term) → uses `lib/utm.ts` `buildUtmUrl` → renders copyable URL with shadcn Toast on copy.
  - _Requirements: 6.6_
  - _SPEC: §7.1, §7.2.5_
  - _Depends on: 12, 21_

- [~] 47. Channel comparison chart on `/marketing`
  - Recharts bar chart consuming `GET /api/campaigns/comparison`.
  - _Requirements: 6.7_
  - _SPEC: §7.2.6_
  - _Depends on: 43, 45_

---

## Wave 5 — Social Media Module (SPEC.md §18 Day 9–10)

- [~] 48. Zod schemas for social posts
  - `src/lib/validators/social.ts`.
  - _Requirements: 7.2_
  - _SPEC: §8_
  - _Depends on: 23_

- [~] 49. API: `GET/POST /api/social/posts`
  - List filterable by platform/status; POST creates draft/scheduled post.
  - _Requirements: 7.3, 7.4_
  - _SPEC: §8.3_
  - _Depends on: 48, 14_

- [~] 50. API: `GET/PATCH/DELETE /api/social/posts/[id]`
  - PATCH allows updating status, performance numbers, `isWinner` toggle, `externalUrl`.
  - _Requirements: 7.3, 7.6_
  - _SPEC: §8.3_
  - _Depends on: 48, 14_

- [~] 51. API: `GET /api/social/winners` + `GET /api/social/stats`
  - Winners = posts where `isWinner = true`. Stats: per-platform published count, total reach, top-performing post for `period=7d|30d`.
  - _Requirements: 7.6, 7.8_
  - _SPEC: §8.3, §8.2.6_
  - _Depends on: 48_

- [~] 52. Pages: `/social` (calendar + list toggle), `/social/new`, `/social/[id]`
  - Calendar = month grid colored by platform; list = `DataTable` filterable by platform/status.
  - Compose form: platform, caption, media URLs, hashtags (multi-select from hashtag library), schedule time. No platform-publishing.
  - Detail page: caption preview, performance entry form, mark-as-winner toggle.
  - _Requirements: 7.1, 7.2, 7.4, 7.5, 7.7_
  - _SPEC: §8.1, §8.2_
  - _Depends on: 21, 49, 50_

- [~] 53. Page: `/social/winners`
  - Grid of `isWinner=true` posts.
  - _Requirements: 7.6_
  - _SPEC: §8.1, §8.2.4_
  - _Depends on: 51, 21_

---

## Wave 6 — Dev Tracking Module (SPEC.md §18 Day 11–12)

- [~] 54. Zod schemas for dev tasks
  - `src/lib/validators/devTask.ts`. Distinguishes feature/bug/chore/release.
  - _Requirements: 8.2_
  - _SPEC: §9_
  - _Depends on: 23_

- [~] 55. API: `GET/POST /api/dev/tasks`
  - List filterable by status/type/assignee. POST creates a task; if `type=RELEASE`, requires `releaseVersion`, `platform`.
  - _Requirements: 8.3, 8.6_
  - _SPEC: §9.3_
  - _Depends on: 54, 14_

- [~] 56. API: `GET/PATCH/DELETE /api/dev/tasks/[id]`
  - PATCH = drag-drop target. On transition to `DONE`, set `completedAt = now`. On transition away from `DONE`, clear `completedAt`. Log `devtask.moved` and `devtask.completed`.
  - _Requirements: 8.4, 8.5, 13.1, 13.2_
  - _SPEC: §9.3, §9.4_
  - _Depends on: 54, 14_

- [~] 57. API: `GET /api/dev/releases` + `GET /api/dev/roadmap`
  - Releases = `type=RELEASE` newest first.
  - Roadmap groups tasks by `targetWeek` for `weeks=8`.
  - _Requirements: 8.6, 8.7_
  - _SPEC: §9.3, §9.2.4_
  - _Depends on: 54_

- [~] 58.* Vitest integration tests for dev endpoints
  - Cover `POST /api/dev/tasks` and `PATCH /api/dev/tasks/[id]` with happy/401/403/400.
  - Property test: **Property 8 — DevTask completion flag invariant** (transitions to/from DONE correctly toggle `completedAt`).
  - _Requirements: 15.2, 15.3, 15.4_
  - _SPEC: §16.2_
  - _Depends on: 55, 56_

- [~] 59. Pages: `/dev` (Kanban) + `/dev/new`
  - Kanban with TODO/DOING/DONE columns; type badges (feature/bug/chore). Drag-drop calls `PATCH /api/dev/tasks/[id]`.
  - _Requirements: 8.1, 8.2, 8.4, 8.5_
  - _SPEC: §9.1, §9.2.1_
  - _Depends on: 21, 55, 56_

- [~] 60. Pages: `/dev/bugs`, `/dev/releases`, `/dev/roadmap`
  - Bugs: filterable by severity + affects-version. Releases: timeline cards newest first; per-release card shows bugs reported in 7 days after `releasedAt`. Roadmap: 8-column horizontal scroll grouped by `targetWeek`.
  - _Requirements: 8.1, 8.6, 8.7, 8.8_
  - _SPEC: §9.1, §9.2.2–§9.2.6_
  - _Depends on: 21, 57_

- [~] 61. Quick-add modal (cross-page)
  - A topbar quick-add button opens a modal that creates a `DevTask` from anywhere. "Assign to me" default.
  - _Requirements: 8.2_
  - _SPEC: §9.2.5_
  - _Depends on: 55, 20_

---

## Wave 7 — AI Analysis Module (SPEC.md §18 Day 13–15)

- [~] 62. Implement `src/lib/claude.ts`
  - Install `@anthropic-ai/sdk`.
  - Lazy singleton: read API key from `Setting('anthropic_api_key')` (decrypt via `crypto.ts`); fallback to `ANTHROPIC_API_KEY` env var.
  - `generateInsight(scope, metrics)`: read model name from `Setting('claude_model')` (default `claude-sonnet-4-6`; `claude-haiku-4-5-20251001` may be specified for lightweight classification). Use the SYSTEM_PROMPT from SPEC.md §10.4 with `cache_control: { type: 'ephemeral' }` on the system content block. Capture `usage.input_tokens + usage.cache_read_input_tokens + usage.output_tokens` into `tokenUsage`. On missing key or API error, return a structured error result; never throw past the route handler.
  - _Requirements: 9.4, 9.7, 9.9_
  - _SPEC: §1, §10.4, §10.6_
  - _Depends on: 10, 14_

- [~] 63. Trend computation helper `src/lib/trend.ts`
  - `computeTrendPct(prev, curr)` returns `null` if `prev === 0`, else `(curr-prev)/prev*100`.
  - Threshold helper `classifyTrend(pct)` returns `'flat'` if `|pct| < 5`, else `'up'`/`'down'`.
  - _Requirements: 9.5_
  - _SPEC: §10.2.3, §10.4_
  - _Depends on: 1_

- [~] 64.* Vitest unit tests for `trend.ts`
  - Property test: **Property 6 — Trend percentage is sign-correct** (and returns `null` for `prev === 0`).
  - _Requirements: 15.1_
  - _SPEC: §16.1_
  - _Depends on: 63_

- [~] 65. Metrics aggregation per scope (`src/lib/aggregations/*`)
  - Four files: `ads.ts`, `social.ts`, `leads.ts`, `overall.ts`. Each exports `gatherMetrics(periodStart, periodEnd, prevStart, prevEnd)` returning the data shape from SPEC.md §10.3.
  - Use Postgres window functions / `date_trunc` / JSONB queries via Prisma `$queryRaw` where needed.
  - _Requirements: 9.2, 9.5, 9.8_
  - _SPEC: §10.3_
  - _Depends on: 4_

- [~] 66. API: `POST /api/ai/generate`
  - Body `{scope}`. Resolve 7d/prev-7d windows, call `gatherMetrics`, then `generateInsight`. Persist `AIInsight` with `tokenUsage`. Log `ai.insight_generated`. If scope has empty data, write insight with `summary = 'Insufficient data'` (do NOT call Claude). If Anthropic key missing or fails, return a friendly error response.
  - _Requirements: 9.5, 9.7, 9.8, 9.9_
  - _SPEC: §10.5, §10.7_
  - _Depends on: 62, 63, 65, 14_

- [~] 67. API: `GET /api/ai/insights` + `GET /api/ai/insights/[id]` + `POST /api/ai/insights/[id]/action`
  - List paginated, filter by `scope`. Action endpoint logs `ai.insight_actioned`.
  - _Requirements: 9.3, 9.11_
  - _SPEC: §10.5_
  - _Depends on: 14_

- [~] 68. API: `GET /api/ai/usage` (admin only)
  - Returns current-month estimated Claude spend computed from `AIInsight.tokenUsage`. EMPLOYEE → 403.
  - _Requirements: 9.10, 11.5_
  - _SPEC: §10.5_
  - _Depends on: 8_

- [~] 69.* Vitest integration tests for `POST /api/ai/generate`
  - Mock `@anthropic-ai/sdk`. Cover happy path, missing-key path returns insight error, empty-data scope returns "Insufficient data", 401, 403 (employee blocked from generate).
  - _Requirements: 15.2, 15.3, 15.4_
  - _SPEC: §16.2_
  - _Depends on: 66_

- [~] 70. Pages: `/ai` (insight feed) and `/ai/[id]` (detail)
  - Feed newest-first, scope filter, color-coded emoji indicator (🔴/🟢/🟡 from `trend`), expandable suggestion, "Mark as actioned" button, "view data" link.
  - Detail page renders raw data snapshot + a small Recharts chart of the metric driving the trend.
  - _Requirements: 9.1, 9.2_
  - _SPEC: §10.1, §10.2.4, §10.2.5_
  - _Depends on: 21, 66, 67_

- [~] 71. Cron endpoint `POST /api/cron/daily-digest`
  - `src/app/api/cron/daily-digest/route.ts`. Bearer `CRON_SECRET` check.
  - Sequentially generate 4 insights (`ads`, `social`, `leads`, `overall`) sharing the cached system prompt. On any sub-call failure, log `ActivityLog` and schedule one retry after 1 h (use a simple persisted `Setting('digest_retry_at')` flag — node-cron checks it on next tick).
  - _Requirements: 9.6, 16.1, 16.3, 16.4_
  - _SPEC: §10.6_
  - _Depends on: 66_

- [~] 72. Cron endpoint `POST /api/cron/followup-reminders`
  - Bearer `CRON_SECRET` check. Find `Lead.nextFollowUpAt::date = today`, write a dashboard alert (use a lightweight `Setting('alerts.json')` or `ActivityLog` rows), optionally email the owner via nodemailer.
  - _Requirements: 5.7, 16.2, 16.3_
  - _SPEC: §6.2.5, §10.6_
  - _Depends on: 14_

- [~] 73. node-cron worker (`src/lib/cron.ts` + PM2 worker entry)
  - Create a thin Node worker (`scripts/cron-worker.ts`) that uses `node-cron` to call the two cron endpoints with the bearer header. Documented for PM2 in Wave 11.
  - _Requirements: 16.1, 16.2_
  - _SPEC: §10.6, §17.2.11_
  - _Depends on: 71, 72_

---

## Wave 8 — Unified Dashboard (SPEC.md §18 Day 16–17)

- [~] 74. Dashboard data API `src/app/(app)/dashboard/loaders.ts`
  - Server-side data functions (no separate REST endpoint needed):
    - `getTodayPulse()` (new leads today + delta, ad spend today + delta, posts published today by platform, open task count + in-progress).
    - `getLatestInsightsByScope()` (latest one per scope).
    - `getReleaseCampaignTimeline(days=30)` (releases as markers, active campaigns as bars, signup deltas from `Lead.createdAt` within campaign date range).
    - `getFollowupBuckets()` (today + overdue).
  - _Requirements: 10.1–10.4_
  - _SPEC: §11.1_
  - _Depends on: 4_

- [~] 75. Row 1 widget: Today's pulse (4 cards)
  - `src/components/dashboard/TodayPulse.tsx` consuming `getTodayPulse()`.
  - _Requirements: 10.1, 10.2_
  - _SPEC: §11.1_
  - _Depends on: 74, 21_

- [~] 76. Row 2 widget: Latest AI insights (4 cards)
  - `src/components/dashboard/LatestInsights.tsx` showing one card per scope linking to `/ai/[id]`.
  - _Requirements: 10.1_
  - _SPEC: §11.1_
  - _Depends on: 74, 70_

- [~] 77. Row 3 widget: Release + Campaign Timeline (full width, polish)
  - `src/components/dashboard/ReleaseCampaignTimeline.tsx`. Custom Recharts/SVG composition: 30-day axis, releases as vertical markers, campaigns as horizontal bars colored by channel, hover tooltip showing signups delta within the hovered period.
  - This widget gets extra polish per SPEC.md §18.
  - _Requirements: 10.3_
  - _SPEC: §11.1, §18.8_
  - _Depends on: 74_

- [~] 78. Row 4 widget: Quick actions + reminders
  - `src/components/dashboard/QuickActions.tsx`: today's follow-ups, overdue follow-ups, buttons (New Lead, New Task, New Post, Compose Campaign).
  - _Requirements: 10.4_
  - _SPEC: §11.1_
  - _Depends on: 74_

- [~] 79. Wire `/dashboard/page.tsx` and verify mobile collapse
  - Compose the four widgets into the page. Verify Row 1 collapses to 2×2 on <768 px, others stack vertically.
  - _Requirements: 10.5, 10.6, 12.3_
  - _SPEC: §11.1, §11.2_
  - _Depends on: 75, 76, 77, 78_

---

## Wave 9 — Settings + Polish (SPEC.md §18 Day 18–19)

- [~] 80. API: settings read/write
  - `src/app/api/settings/route.ts` with sectioned GET (admin sees all; employee sees profile + hashtag library only). PATCH writes to `Setting`. API keys + HMAC secret stored encrypted via `crypto.ts`.
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_
  - _SPEC: §12.1, §12.2_
  - _Depends on: 10, 14_

- [~] 81. Page: `/settings`
  - Sections: Profile (any user), Users (admin), API keys (admin), AI config (admin — model selector, daily digest enabled toggle, digest hour), Hashtag library (any user). Use shadcn Tabs.
  - _Requirements: 11.1, 11.5_
  - _SPEC: §12.1_
  - _Depends on: 21, 80_

- [~] 82. Page: `/settings/users`
  - Admin-only mirror of Users tab (list, add, deactivate). Reuses Wave 2 forms.
  - _Requirements: 4.2, 4.3, 4.5, 11.1_
  - _SPEC: §12.1_
  - _Depends on: 28_

- [~] 83. Hashtag library wired into social composer
  - Settings tab manages reusable hashtag sets (stored as a JSON `Setting`). Composer at `/social/new` and `/social/[id]` reads sets and lets the user paste them in.
  - _Requirements: 7.2, 11.1_
  - _SPEC: §8.2.5, §12.1_
  - _Depends on: 81, 52_

- [~] 84. Empty-states + skeletons sweep
  - Audit every list page (`/employees`, `/leads`, `/marketing`, `/social`, `/dev`, `/dev/bugs`, `/dev/releases`, `/dev/roadmap`, `/ai`) and ensure a designed `EmptyState` + skeleton loader is present. Replace any blank screens.
  - _Requirements: 12.4, 12.5_
  - _SPEC: §13.3, §13.4_
  - _Depends on: 28, 37, 45, 52, 59, 70_

- [~] 85. Mobile responsive QA pass
  - DevTools at 375 px width: verify sidebar collapses to hamburger; tables scroll horizontally; Kanban renders one column at a time with swipe; forms remain usable.
  - _Requirements: 12.3, 10.6_
  - _SPEC: §13.2, §11.2_
  - _Depends on: 79, 84_

- [~] 86. Error-handling sweep + remove `console.log`
  - Confirm every API handler returns friendly toasts on error, no raw stack traces leak. Remove all `console.log` calls from production code paths (`src/app`, `src/lib`, `src/components`).
  - _Requirements: 12.7, 14.3_
  - _SPEC: §13.5, §19_
  - _Depends on: 84_

---

## Wave 10 — Testing (SPEC.md §18 Day 20–22)

- [~] 87.* Vitest coverage gate for `src/lib/`
  - Ensure `vitest.config.ts` enforces ≥80% line coverage on `src/lib/`. Run `npm run test -- --coverage` and confirm green.
  - _Requirements: 15.1_
  - _SPEC: §16.1_
  - _Depends on: 9, 11, 13, 15, 64_

- [~] 88.* Integration test harness
  - Add a test-db helper that runs migrations on a throwaway Postgres schema/connection per test file and seeds an admin + an employee user for permission tests.
  - _Requirements: 15.2, 15.3_
  - _SPEC: §16.2_
  - _Depends on: 6_

- [~] 89.* Round out integration test coverage
  - Make sure the endpoints listed in SPEC.md §16.2 are covered: `POST /api/leads`, `PATCH /api/leads/[id]`, `POST /api/leads/import`, `POST /api/campaigns`, `PATCH /api/campaigns/[id]`, `POST /api/dev/tasks`, `PATCH /api/dev/tasks/[id]`, `POST /api/ai/generate` (mock), `POST /api/webhooks/leads` (HMAC valid + invalid). Each: happy / 401 / 403 / 400.
  - _Requirements: 15.2, 15.3_
  - _SPEC: §16.2_
  - _Depends on: 88, 29, 35, 36, 44, 58, 69_

- [~] 90.* Playwright setup
  - Install `@playwright/test`; `npx playwright install chromium`.
  - Create `playwright.config.ts` with baseURL `http://localhost:3000`, web-server start hook (`npm run dev`), headless default.
  - Add `tests/e2e/fixtures.ts` for an authenticated admin context that logs in once and reuses storageState.
  - _Requirements: 15.4, 15.5_
  - _SPEC: §16.3_
  - _Depends on: 23_

- [~] 91.* E2E test: Login → dashboard
  - `tests/e2e/01-login.spec.ts`: seed admin, log in, land on `/dashboard`, see all four rows.
  - _Requirements: 15.4_
  - _SPEC: §16.3 #1_
  - _Depends on: 90, 79_

- [~] 92.* E2E test: Add lead → move through pipeline → see in activity log
  - `tests/e2e/02-leads-pipeline.spec.ts`: create lead, drag through Kanban, open detail, verify activity log entries.
  - _Requirements: 15.4, 5.6_
  - _SPEC: §16.3 #2_
  - _Depends on: 90, 38_

- [~] 93.* E2E test: Create campaign → CAC calculation correct
  - `tests/e2e/03-campaign-cac.spec.ts`: create campaign with `spent=10000` `signups=50`, verify `₹200` displayed.
  - _Requirements: 15.4, 6.5_
  - _SPEC: §16.3 #3_
  - _Depends on: 90, 45_

- [~] 94.* E2E test: Drag dev task TODO → DONE → `completedAt` set
  - `tests/e2e/04-devtask-done.spec.ts`: drag task, verify `completedAt` via API or UI badge.
  - _Requirements: 15.4, 8.5_
  - _SPEC: §16.3 #4_
  - _Depends on: 90, 59_

- [~] 95.* E2E test: Compose social post → schedule → see on calendar
  - `tests/e2e/05-social-schedule.spec.ts`: compose, schedule for tomorrow, verify on calendar grid cell.
  - _Requirements: 15.4, 7.5_
  - _SPEC: §16.3 #5_
  - _Depends on: 90, 52_

- [~] 96.* E2E test: Trigger AI generate (mocked) → insight appears
  - `tests/e2e/06-ai-generate.spec.ts`: stub the Anthropic call (route mock or a test-mode flag), click "Generate now" with `scope=ads`, see new card on `/ai`.
  - _Requirements: 15.4, 9.5_
  - _SPEC: §16.3 #6_
  - _Depends on: 90, 70_

- [~] 97. Manual smoke checklist runner doc
  - Add `tests/manual-smoke.md` mirroring SPEC.md §16.4 — used by the reviewer (Lal Singh). This is documentation, no code.
  - _Requirements: 15.7_
  - _SPEC: §16.4_
  - _Depends on: 23_

- [~] 98. Test checkpoint
  - Run `npm run test` and `npm run test:e2e` headless on a fresh checkout. All green.
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 15.5_
  - _SPEC: §19_
  - _Depends on: 87, 89, 91, 92, 93, 94, 95, 96_

---

## Wave 11 — Deployment Prep (SPEC.md §18 Day 23)

- [~] 99. Author `README.md`
  - Project intro, local dev setup (Postgres + env), npm scripts, link to `DEPLOY.md` and `SPEC.md`.
  - _Requirements: 17.1_
  - _SPEC: §17_
  - _Depends on: 7_

- [~] 100. Author `DEPLOY.md`
  - All 13 steps from SPEC.md §17.2 verbatim (with command snippets): clone, deps, Postgres provisioning, env, migrate, seed, build, PM2, Nginx, Certbot, crontab entry, ufw, pg_dump backups.
  - _Requirements: 17.2_
  - _SPEC: §17.2_
  - _Depends on: 7_

- [~] 101. Author `ecosystem.config.js`
  - PM2 config matching SPEC.md §17.3: `officepilot-web` cluster, 2 instances, `npm start`, `NODE_ENV=production`, `PORT=3000`. Add a second app entry `officepilot-cron` running `tsx scripts/cron-worker.ts` in fork mode (single instance) so cron + web are managed together.
  - _Requirements: 17.3, 16.1, 16.2_
  - _SPEC: §17.3, §10.6_
  - _Depends on: 73_

- [~] 102. Final `.env.example` audit
  - Re-confirm every key from SPEC.md §15 is present, with comments documenting how to generate each (`openssl rand -base64 32`, `openssl rand -hex 32`, etc.).
  - _Requirements: 14.1, 17.4_
  - _SPEC: §15_
  - _Depends on: 7_

- [~] 103. Definition-of-Done verification + tag v0.1.0
  - Walk through every checkbox in SPEC.md §19. Confirm:
    - all 6 modules + dashboard + settings implemented;
    - migrations run on a fresh Postgres;
    - seed creates admin successfully;
    - `npm run build` zero TS errors;
    - `npm run lint` clean;
    - all unit, integration, and Playwright tests pass;
    - manual smoke checklist green;
    - mobile QA at 375 px green;
    - no `console.log` in production code;
    - no hardcoded secrets;
    - `.env.example`, `README.md`, `DEPLOY.md` complete;
    - one real Anthropic-key insight generated successfully on a populated dev DB.
  - Then create git tag `v0.1.0`.
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 18.1, 18.2, 18.3_
  - _SPEC: §19, §21_
  - _Depends on: 86, 98, 99, 100, 101, 102_

---

## Notes

- Tasks marked with `*` are optional test sub-tasks per the Kiro convention; they should still be implemented for the build to satisfy SPEC.md §16 and §19.
- Wave numbers map to SPEC.md §18 days. Within a wave, tasks with no shared dependency chain can run in parallel; the orchestrator's DAG scheduler should batch them.
- The Anthropic model name is read at runtime from `Setting('claude_model')`; default `claude-sonnet-4-6`, with `claude-haiku-4-5-20251001` available for lightweight per-row classification (SPEC.md §1). Implementers must NOT hardcode either constant.
- Out-of-scope features per SPEC.md §0 and §20 (lead scoring AI, viral prediction, heatmaps, drip campaigns, A/B testing, landing/popup builders, affiliate/coupon, multi-tenancy, real-time/WebSockets, native mobile, social platform publishing, public marketing site, B2B pipeline) MUST NOT appear in any task — none of the tasks above introduce them.
- Each task references both `requirements.md` clauses and SPEC.md sections so the spec-task-execution subagent has direct traceability when implementing.
