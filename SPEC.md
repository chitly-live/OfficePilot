# OfficePilot — Chitly Internal Office Management Tool

**Owner:** Chitly (chitly.live — social networking app, "Make Friends Online")
**Purpose:** Internal-only office cockpit for the Chitly team (admin + employees).
**Builder:** Kiro IDE will implement this spec end-to-end, including testing.
**Reviewer:** Human reviewer (Lal Singh) will verify after Kiro completes.

---

## 0. Read this first — Build philosophy

This is **NOT** a clone of HubSpot/Jira/Buffer. It is a focused internal tool with **6 modules + 1 unified dashboard**, built for a small team (5–15 users).

**Hard rules:**
- Limited features only. If a module's spec lists 6 features, build exactly those 6 — do not add a 7th.
- No half-built features. If something is in spec, it must be functional end-to-end (UI + API + DB + tests).
- No mock/dummy data in production code. Use seed scripts for dev/test, real flows for everything else.
- Mobile-responsive UI (team will check on phones).
- Hindi/English mixed UI labels are acceptable where natural (this is an Indian small office).

**Out of scope (do NOT build):**
- AI lead scoring, viral prediction, heatmaps, session recording
- Drip campaigns, A/B test platform, email/SMS bulk marketing
- Landing page builder, popup builder
- Affiliate/referral/coupon systems
- Lead pipeline B2B stages ("Negotiation/Won/Lost")
- Multi-tenant / SaaS features — this is single-org internal tool

---

## 1. Tech Stack (locked, do not substitute)

| Layer | Choice | Version |
|---|---|---|
| Framework | Next.js (App Router) | 14.x |
| Language | TypeScript | 5.x |
| Styling | Tailwind CSS | 3.x |
| UI components | shadcn/ui | latest |
| Icons | lucide-react | latest |
| ORM | Prisma | 5.x |
| Database | PostgreSQL | 15+ |
| Auth | NextAuth.js (Auth.js v5) | beta |
| AI | Anthropic SDK (`@anthropic-ai/sdk`) | latest |
| Charts | Recharts | latest |
| Forms | react-hook-form + zod | latest |
| Date | date-fns | latest |
| Tables | @tanstack/react-table | latest |
| Email (transactional) | nodemailer (SMTP) | latest |
| Background jobs | node-cron (inside Next.js custom server) OR BullMQ if Redis available | — |
| Deployment | Ubuntu 22.04 VPS + PM2 + Nginx + Certbot | — |

**Why Postgres:** AI Analysis module needs window functions, date_trunc, JSONB queries. MySQL is acceptable fallback only if Postgres unavailable.

**Claude model for AI Analysis:** `claude-sonnet-4-6` (good balance of cost & quality for daily digests). Use `claude-haiku-4-5-20251001` for lightweight per-row classifications.

---

## 2. User Roles & Auth

### 2.1 Roles
| Role | Permissions |
|---|---|
| **ADMIN** | Full access: all modules, all CRUD, can add/remove users, can view AI insights, can configure API keys |
| **EMPLOYEE** | Read all modules; write only to records assigned to them or that they created; cannot manage users; cannot see AI cost/usage settings |

### 2.2 Auth flow
- **Login only.** No public signup. Admin creates employee accounts.
- Email + password (bcrypt hashed, cost factor 12).
- Session-based via NextAuth.js with JWT strategy (no Redis dependency).
- Session expiry: 7 days, sliding renewal.
- Forgot password: self-service email link (`/forgot-password` → `/reset-password?token=…`). Token is 32 random bytes, stored as SHA-256, single use, 30-minute expiry, max 3 requests per account per hour; the response never reveals whether the email exists. A completed reset stamps `User.passwordChangedAt`, which signs out every other session on its next re-check. Admins can still set a password from Employees. (v1 shipped with admin-only resets; self-service added Sept 2026.)
- 2FA: out of scope for v1.

### 2.3 Seed data
On first deploy, create one admin:
```
email: admin@chitly.live
password: (must be set via env var ADMIN_SEED_PASSWORD; do NOT hardcode)
```

---

## 3. Database Schema (Prisma)

Complete schema. All tables use `id` as `cuid()`, all have `createdAt`/`updatedAt`.

```prisma
// schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  ADMIN
  EMPLOYEE
}

enum LeadStatus {
  NEW
  CONTACTED
  INTERESTED
  FOLLOW_UP
  CONVERTED
  LOST
}

enum LeadSource {
  WEBSITE
  WHATSAPP
  FACEBOOK_AD
  GOOGLE_AD
  INSTAGRAM
  REFERRAL
  MANUAL
  OTHER
}

enum CampaignChannel {
  META_ADS
  GOOGLE_ADS
  INSTAGRAM_ORGANIC
  YOUTUBE
  INFLUENCER
  EMAIL
  OTHER
}

enum CampaignStatus {
  DRAFT
  ACTIVE
  PAUSED
  ENDED
}

enum SocialPlatform {
  INSTAGRAM
  FACEBOOK
  TWITTER
  LINKEDIN
  YOUTUBE
  THREADS
}

enum PostStatus {
  DRAFT
  SCHEDULED
  PUBLISHED
  FAILED
}

enum DevTaskStatus {
  TODO
  DOING
  DONE
}

enum DevTaskType {
  FEATURE
  BUG
  CHORE
  RELEASE
}

enum Priority {
  LOW
  MEDIUM
  HIGH
  URGENT
}

model User {
  id           String   @id @default(cuid())
  email        String   @unique
  passwordHash String
  name         String
  role         Role     @default(EMPLOYEE)
  phone        String?
  designation  String?
  joinedAt     DateTime @default(now())
  isActive     Boolean  @default(true)
  avatarUrl    String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  ownedLeads    Lead[]         @relation("LeadOwner")
  createdLeads  Lead[]         @relation("LeadCreator")
  campaigns     Campaign[]
  socialPosts   SocialPost[]
  devTasks      DevTask[]      @relation("TaskAssignee")
  reportedBugs  DevTask[]      @relation("TaskReporter")
  notes         Note[]
  activities    ActivityLog[]
  attendance    Attendance[]
}

model Lead {
  id          String     @id @default(cuid())
  name        String
  phone       String?
  email       String?
  company     String?
  city        String?
  source      LeadSource @default(MANUAL)
  status      LeadStatus @default(NEW)
  priority    Priority   @default(MEDIUM)
  value       Float?     // estimated value in INR
  notes       String?    @db.Text
  tags        String[]   @default([])

  ownerId     String?
  owner       User?      @relation("LeadOwner", fields: [ownerId], references: [id])
  createdById String
  createdBy   User       @relation("LeadCreator", fields: [createdById], references: [id])

  utmSource   String?
  utmMedium   String?
  utmCampaign String?

  nextFollowUpAt DateTime?
  convertedAt    DateTime?

  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt

  activities  ActivityLog[]

  @@index([status])
  @@index([ownerId])
  @@index([source])
  @@index([nextFollowUpAt])
}

model Campaign {
  id          String          @id @default(cuid())
  name        String
  channel     CampaignChannel
  status      CampaignStatus  @default(DRAFT)
  startDate   DateTime
  endDate     DateTime?
  budget      Float           // INR
  spent       Float           @default(0)
  impressions Int             @default(0)
  clicks      Int             @default(0)
  signups     Int             @default(0)
  conversions Int             @default(0)
  notes       String?         @db.Text

  utmSource   String?
  utmMedium   String?
  utmCampaign String?         @unique

  ownerId     String
  owner       User            @relation(fields: [ownerId], references: [id])

  createdAt   DateTime        @default(now())
  updatedAt   DateTime        @updatedAt

  @@index([status])
  @@index([channel])
  @@index([startDate])
}

model SocialPost {
  id          String         @id @default(cuid())
  platform    SocialPlatform
  status      PostStatus     @default(DRAFT)
  caption     String         @db.Text
  mediaUrls   String[]       @default([])
  hashtags    String[]       @default([])
  scheduledAt DateTime?
  publishedAt DateTime?
  externalId  String?        // platform post id
  externalUrl String?

  // performance (manually entered or pulled by job)
  likes       Int            @default(0)
  comments    Int            @default(0)
  shares      Int            @default(0)
  reach       Int            @default(0)
  impressions Int            @default(0)

  isWinner    Boolean        @default(false) // marked as top performer

  ownerId     String
  owner       User           @relation(fields: [ownerId], references: [id])

  createdAt   DateTime       @default(now())
  updatedAt   DateTime       @updatedAt

  @@index([platform])
  @@index([status])
  @@index([scheduledAt])
}

model DevTask {
  id          String         @id @default(cuid())
  title       String
  description String?        @db.Text
  type        DevTaskType    @default(FEATURE)
  status      DevTaskStatus  @default(TODO)
  priority    Priority       @default(MEDIUM)

  // for bugs
  affectsVersion String?
  stepsToReproduce String?   @db.Text

  // for releases
  releaseVersion String?
  releasedAt     DateTime?
  platform       String?    // "iOS" | "Android" | "Web"

  // roadmap horizon (target week)
  targetWeek   DateTime?

  assigneeId   String?
  assignee     User?         @relation("TaskAssignee", fields: [assigneeId], references: [id])
  reporterId   String
  reporter     User          @relation("TaskReporter", fields: [reporterId], references: [id])

  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt
  completedAt  DateTime?

  @@index([status])
  @@index([type])
  @@index([assigneeId])
  @@index([targetWeek])
}

model Note {
  id        String   @id @default(cuid())
  body      String   @db.Text
  authorId  String
  author    User     @relation(fields: [authorId], references: [id])
  entityType String  // "lead" | "campaign" | "devtask"
  entityId   String
  createdAt DateTime @default(now())

  @@index([entityType, entityId])
}

model ActivityLog {
  id         String   @id @default(cuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id])
  action     String   // "lead.created", "lead.status_changed", "campaign.spent_updated", etc.
  entityType String
  entityId   String
  metadata   Json?

  leadId     String?
  lead       Lead?    @relation(fields: [leadId], references: [id])

  createdAt  DateTime @default(now())

  @@index([userId])
  @@index([entityType, entityId])
  @@index([createdAt])
}

model Attendance {
  id      String   @id @default(cuid())
  userId  String
  user    User     @relation(fields: [userId], references: [id])
  date    DateTime @db.Date
  status  String   // "present" | "leave" | "wfh" | "absent"
  notes   String?

  @@unique([userId, date])
  @@index([date])
}

model AIInsight {
  id         String   @id @default(cuid())
  generatedAt DateTime @default(now())
  periodStart DateTime
  periodEnd   DateTime
  scope      String   // "ads" | "social" | "leads" | "overall"
  trend      String   // "up" | "down" | "flat"
  trendPct   Float?
  summary    String   @db.Text
  suggestion String   @db.Text
  rawData    Json     // snapshot of metrics used
  tokenUsage Int?

  @@index([scope])
  @@index([generatedAt])
}

model Setting {
  key   String @id
  value String @db.Text
}
```

### 3.1 Seed script (`prisma/seed.ts`)
- 1 admin user (email from env, password from env, hashed)
- 0 leads / campaigns / posts / tasks (real data only)
- Default settings rows: `claude_model`, `daily_digest_hour`, `currency` = `INR`

---

## 4. File / Folder Structure

```
officepilot/
├── prisma/
│   ├── schema.prisma
│   ├── seed.ts
│   └── migrations/
├── public/
│   └── logo.svg
├── src/
│   ├── app/
│   │   ├── (auth)/
│   │   │   └── login/
│   │   │       └── page.tsx
│   │   ├── (app)/
│   │   │   ├── layout.tsx          // sidebar + topbar shell
│   │   │   ├── dashboard/
│   │   │   │   └── page.tsx
│   │   │   ├── employees/
│   │   │   │   ├── page.tsx
│   │   │   │   ├── new/page.tsx
│   │   │   │   └── [id]/page.tsx
│   │   │   ├── leads/
│   │   │   │   ├── page.tsx
│   │   │   │   ├── new/page.tsx
│   │   │   │   ├── [id]/page.tsx
│   │   │   │   └── import/page.tsx
│   │   │   ├── marketing/
│   │   │   │   ├── page.tsx        // campaign list
│   │   │   │   ├── new/page.tsx
│   │   │   │   ├── [id]/page.tsx
│   │   │   │   └── utm/page.tsx    // UTM generator
│   │   │   ├── social/
│   │   │   │   ├── page.tsx        // calendar view
│   │   │   │   ├── new/page.tsx
│   │   │   │   ├── [id]/page.tsx
│   │   │   │   └── winners/page.tsx
│   │   │   ├── dev/
│   │   │   │   ├── page.tsx        // kanban
│   │   │   │   ├── bugs/page.tsx
│   │   │   │   ├── releases/page.tsx
│   │   │   │   ├── roadmap/page.tsx
│   │   │   │   └── new/page.tsx
│   │   │   ├── ai/
│   │   │   │   ├── page.tsx        // AI insights feed
│   │   │   │   └── [id]/page.tsx
│   │   │   └── settings/
│   │   │       ├── page.tsx
│   │   │       └── users/page.tsx
│   │   ├── api/
│   │   │   ├── auth/[...nextauth]/route.ts
│   │   │   ├── leads/...
│   │   │   ├── campaigns/...
│   │   │   ├── social/...
│   │   │   ├── dev/...
│   │   │   ├── ai/
│   │   │   │   ├── generate/route.ts
│   │   │   │   └── insights/route.ts
│   │   │   └── cron/
│   │   │       ├── daily-digest/route.ts
│   │   │       └── followup-reminders/route.ts
│   │   ├── layout.tsx
│   │   ├── page.tsx                // redirects to /login or /dashboard
│   │   └── globals.css
│   ├── components/
│   │   ├── ui/                     // shadcn components
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx
│   │   │   ├── Topbar.tsx
│   │   │   └── PageHeader.tsx
│   │   ├── leads/
│   │   ├── campaigns/
│   │   ├── social/
│   │   ├── dev/
│   │   ├── ai/
│   │   └── shared/
│   │       ├── DataTable.tsx
│   │       ├── EmptyState.tsx
│   │       ├── ConfirmDialog.tsx
│   │       └── KanbanBoard.tsx
│   ├── lib/
│   │   ├── db.ts                   // prisma client singleton
│   │   ├── auth.ts                 // NextAuth config
│   │   ├── claude.ts               // Anthropic client
│   │   ├── utm.ts
│   │   ├── permissions.ts
│   │   ├── activity.ts             // log helper
│   │   └── cron.ts
│   ├── types/
│   │   └── next-auth.d.ts
│   └── middleware.ts               // protect /(app) routes
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/                        // playwright
├── .env.example
├── .gitignore
├── next.config.mjs
├── tailwind.config.ts
├── tsconfig.json
├── package.json
├── README.md
├── DEPLOY.md                       // VPS deployment runbook
└── SPEC.md                         // this file
```

---

## 5. Module 1 — Employees

### 5.1 Pages
- `/employees` — list view (table: avatar, name, email, role, designation, status, last active)
- `/employees/new` — add form (admin only)
- `/employees/[id]` — profile (basic info + recent activity + attendance)

### 5.2 Features (exactly these, no more)
1. **List & search** employees by name/email/role
2. **Add employee** (admin only): name, email, password (auto-generate option), role, designation, phone
3. **Edit/deactivate** employee (admin only)
4. **Basic attendance log** — daily mark: present / leave / wfh / absent (employees mark their own; admin can override)
5. **Activity timeline** per employee (last 30 actions across system — from `ActivityLog`)
6. **Performance snapshot** card: leads owned, leads converted (30d), campaigns owned, tasks completed (30d) — pulled live from DB

### 5.3 API endpoints
```
GET    /api/users               -> list (admin sees all; employee sees self + minimal team list)
POST   /api/users               -> create (admin only)
GET    /api/users/[id]          -> details
PATCH  /api/users/[id]          -> update (admin OR self for limited fields)
DELETE /api/users/[id]          -> soft delete via isActive=false (admin only)
POST   /api/users/[id]/attendance -> mark attendance
GET    /api/users/[id]/stats    -> performance snapshot
```

### 5.4 Acceptance criteria
- Admin can add a new employee; new employee can log in with the credentials shown once on creation
- Non-admin cannot access `/employees/new`
- Deactivated employee cannot log in (auth rejects)
- Attendance for a date is unique per user (DB constraint)

---

## 6. Module 2 — Leads

### 6.1 Pages
- `/leads` — table with filters (status, source, owner, date range, priority) + bulk actions
- `/leads/new` — add lead form
- `/leads/[id]` — full lead detail: profile, notes timeline, status changes, activity
- `/leads/import` — CSV upload with column mapping preview

### 6.2 Features (exactly these)
1. **Create/edit lead** with all profile fields (see schema)
2. **Pipeline view (Kanban)** with 6 stages (NEW → CONTACTED → INTERESTED → FOLLOW_UP → CONVERTED / LOST)
3. **CSV import** with deduplication on phone+email
4. **Assign owner** (admin can assign to any user; employee can reassign own leads)
5. **Follow-up reminders**: set `nextFollowUpAt`; cron job creates dashboard alerts + optional email
6. **Notes timeline** + activity log per lead
7. **Source attribution** auto-fill from UTM params (when lead comes via webhook)
8. **Webhook endpoint** `POST /api/webhooks/leads` (HMAC-signed) for external form integrations

### 6.3 API endpoints
```
GET    /api/leads               -> filtered list (paginated, default 50/page)
POST   /api/leads               -> create
GET    /api/leads/[id]
PATCH  /api/leads/[id]          -> update (status changes logged to ActivityLog)
DELETE /api/leads/[id]          -> hard delete (admin only)
POST   /api/leads/import        -> CSV upload
POST   /api/leads/[id]/notes    -> add note
POST   /api/webhooks/leads      -> public webhook (HMAC verified)
```

### 6.4 Validation
- Either phone OR email required
- Status transitions: any → any allowed (don't enforce strict order); log every change
- CSV import: max 1000 rows per upload; show row-by-row errors before commit

### 6.5 Acceptance criteria
- Add 10 leads → table shows them with correct owner & status
- Drag lead from NEW → INTERESTED in Kanban → ActivityLog entry created
- Set follow-up for tomorrow → cron at 9 AM next day shows alert on dashboard
- CSV with 50 rows, 5 duplicates → only 45 imported, 5 reported as duplicates
- Webhook POST with valid HMAC → lead created with source from payload

---

## 7. Module 3 — Marketing (Campaigns)

### 7.1 Pages
- `/marketing` — campaign list table + summary cards (total spend MTD, total signups MTD, blended CAC)
- `/marketing/new` — campaign form
- `/marketing/[id]` — detail with metrics chart (spend vs signups over time), linked leads, ROI calc
- `/marketing/utm` — UTM builder tool (form → copyable URL)

### 7.2 Features (exactly these)
1. **Create campaign** (name, channel, dates, budget, UTM params auto-suggested from name)
2. **Update metrics** (spend, impressions, clicks, signups) — manual entry; one form per campaign
3. **Auto-link leads** via UTM: leads with matching `utmCampaign` show under campaign
4. **CAC calculation**: `spent / signups`; show on detail page + list
5. **UTM generator** standalone tool (full URL with all UTM params, copyable)
6. **Channel comparison** chart: bar chart of spend vs signups vs CAC by channel (last 30d)

### 7.3 API endpoints
```
GET    /api/campaigns
POST   /api/campaigns
GET    /api/campaigns/[id]
PATCH  /api/campaigns/[id]
DELETE /api/campaigns/[id]
GET    /api/campaigns/[id]/leads        -> auto-linked via UTM
GET    /api/campaigns/comparison        -> data for channel comparison chart
```

### 7.4 Acceptance criteria
- Create "Meta Reels July" campaign with utmCampaign=`meta_reels_july` → leads with that utm show in detail page
- Update spend to ₹10,000 with 50 signups → CAC shows ₹200
- UTM generator outputs `https://chitly.live/?utm_source=meta&utm_medium=cpc&utm_campaign=...`

---

## 8. Module 4 — Social Media

### 8.1 Pages
- `/social` — calendar view (month grid) with posts colored by platform; switch to list view
- `/social/new` — compose post form (platform, caption, media URLs, hashtags, schedule time)
- `/social/[id]` — detail with caption preview, performance, mark-as-winner toggle
- `/social/winners` — grid of all `isWinner=true` posts (for inspiration/repeating)

### 8.2 Features (exactly these)
1. **Calendar + list view** of all posts (filter by platform, status)
2. **Compose post** (no actual platform publishing in v1 — manual status update; field for `externalUrl` after publishing)
3. **Performance entry**: manually update likes/comments/shares/reach after posting
4. **Mark as winner** (toggle) → appears on `/social/winners`
5. **Hashtag library**: simple settings page to save reusable hashtag sets, paste into composer
6. **Weekly content stats** card: posts published this week per platform, total reach, top-performing post

### 8.3 API endpoints
```
GET    /api/social/posts
POST   /api/social/posts
GET    /api/social/posts/[id]
PATCH  /api/social/posts/[id]
DELETE /api/social/posts/[id]
GET    /api/social/winners
GET    /api/social/stats?period=7d|30d
```

### 8.4 Acceptance criteria
- Schedule a post for tomorrow → appears on calendar at correct date
- Mark a post as PUBLISHED + add likes=500 → shows on winners page if marked winner
- Calendar view loads in <1s for 100 posts

---

## 9. Module 5 — Dev Tracking

### 9.1 Pages
- `/dev` — Kanban board (TODO / DOING / DONE) for current week (filter: feature/bug/all)
- `/dev/bugs` — bug list with severity, version affected
- `/dev/releases` — release log (version, date, platform, changelog) — newest first
- `/dev/roadmap` — 8-week horizon Gantt-style timeline
- `/dev/new` — task form (type, title, description, assignee, priority, target week)

### 9.2 Features (exactly these)
1. **Kanban board** with drag-drop between columns; task type badges (feature/bug/chore)
2. **Bug inbox** separate view: severity/priority sort, "affects version" filter
3. **Release log** — releases (`type=RELEASE`) shown as timeline cards with changelog
4. **8-week roadmap** — group tasks by `targetWeek`; visual horizontal scroll
5. **Quick add** from any page (modal): assign to me / select assignee
6. **Stats card** for each release: bugs reported in 7 days after release date

### 9.3 API endpoints
```
GET    /api/dev/tasks?status=&type=&assignee=
POST   /api/dev/tasks
GET    /api/dev/tasks/[id]
PATCH  /api/dev/tasks/[id]      -> drag-drop calls this
DELETE /api/dev/tasks/[id]
GET    /api/dev/releases
GET    /api/dev/roadmap?weeks=8
```

### 9.4 Acceptance criteria
- Drag task from TODO → DOING → DB updated, `updatedAt` changes
- Move task to DONE → `completedAt` set automatically
- Create release v2.5.0 with platform=iOS → appears on releases page top
- Roadmap shows tasks grouped by week, 8 columns visible

---

## 10. Module 6 — AI Analysis ⭐

This is the **USP** of OfficePilot. No off-the-shelf tool does this.

### 10.1 Pages
- `/ai` — feed of AI insights (newest first), filter by scope (ads/social/leads/overall)
- `/ai/[id]` — full insight detail with raw data snapshot + chart

### 10.2 Features (exactly these)
1. **Daily digest** (cron 9 AM IST): generates 4 insights — ads, social, leads, overall — pushed to dashboard
2. **On-demand generation**: admin clicks "Generate now" → live Claude call
3. **Trend detection**: numeric trend (% up/down vs previous 7d) computed in code; Claude generates the *narrative* and *suggestion*
4. **Insight card UI**: emoji indicator (🔴/🟢/🟡), scope, 1-line summary, expandable suggestion, "view data" link
5. **Suggestion follow-up**: button "Mark as actioned" on each insight (logged to ActivityLog)
6. **Token usage tracking**: per insight; admin settings page shows monthly Claude spend estimate

### 10.3 Data inputs (computed in code, then passed to Claude)
For each scope, gather **last 7 days vs previous 7 days**:

**Ads scope:**
- Total spend, by channel
- Total signups attributed (via UTM)
- CAC per channel
- ROAS if conversion value known (optional)
- Worst-performing campaign (highest CAC)
- Best-performing campaign (lowest CAC, min 10 signups)

**Social scope:**
- Posts published per platform
- Total reach + engagement rate
- Top-3 posts by reach
- Bottom-3 posts by reach
- Day-of-week + time pattern

**Leads scope:**
- New leads count by source
- Status conversion: NEW → CONTACTED, CONTACTED → INTERESTED, etc.
- Avg time-in-stage
- Lost-lead reasons (from notes — keyword analysis simple version: count notes containing "expensive", "not interested", "competitor", etc.)
- Owner workload (leads per employee)

**Overall scope:**
- Combined metrics summary
- Cross-scope correlations (e.g., "social engagement up, but lead conversion down — check signup form?")

### 10.4 Claude prompt template (use system + user pattern, cache the system prompt)

```typescript
const SYSTEM_PROMPT = `You are a growth analyst for Chitly, a consumer social-networking app.
Your job is to analyze week-over-week metrics and give SHORT, ACTIONABLE suggestions.

Rules:
- Output JSON with keys: trend ("up"|"down"|"flat"), trendPct (number), summary (max 200 chars), suggestion (max 400 chars, actionable, specific).
- Be direct. No fluff like "consider exploring".
- Reference specific numbers from the data.
- If trend is flat (<5% change), say so clearly; don't manufacture insights.
- Hindi+English mix is fine if natural ("Reels engagement 18% up hai, but reply rate down"). Default English.`;

const userPrompt = `Scope: ${scope}
Period: ${periodStart} to ${periodEnd}
Comparison: previous 7 days

Data:
${JSON.stringify(metrics, null, 2)}

Analyze and respond with JSON only.`;
```

Use **prompt caching** on the system prompt (TTL 5min — but daily digest runs together, so cache helps across the 4 scopes).

### 10.5 API endpoints
```
GET    /api/ai/insights              -> list (paginated)
GET    /api/ai/insights/[id]
POST   /api/ai/generate              -> body: {scope}; returns generated insight
POST   /api/ai/insights/[id]/action  -> mark as actioned
GET    /api/ai/usage                 -> admin: monthly token usage estimate
```

### 10.6 Cron job — `daily-digest`
- Runs at 9:00 AM IST (use `node-cron` inside a long-running Next.js custom server, OR use Vercel cron, OR use system cron + curl to `/api/cron/daily-digest` with bearer secret)
- For deployment on VPS: use `pm2 start` with a separate worker process running `node-cron`, OR use Linux `crontab` calling `curl http://localhost:3000/api/cron/daily-digest -H "Authorization: Bearer $CRON_SECRET"`
- Generates 4 insights (ads, social, leads, overall) sequentially with prompt caching
- On error: log to ActivityLog, retry once after 1h

### 10.7 Acceptance criteria
- Click "Generate now" on /ai with scope=ads → within 10s a new insight card appears with valid trend + suggestion
- Daily cron creates 4 insights at 9 AM (verify by querying `AIInsight` table)
- Token usage in admin settings shows non-zero estimate after generation
- If Claude API key missing → graceful error message, no crash
- If no data for scope (e.g., zero campaigns) → returns insight with summary "Insufficient data" instead of fake numbers

---

## 11. Unified Dashboard (Home)

The `/dashboard` page is the **first thing** users see after login. It must be useful at a glance — no marketing landing-page feel.

### 11.1 Layout
4 rows of widgets:

**Row 1 — Today's pulse (4 cards)**
- New leads today (count + delta vs yesterday)
- Ad spend today (₹ + delta)
- Posts published today (count by platform mini-icons)
- Open tasks (count, with "in progress" subcount)

**Row 2 — AI Insights (latest 4 cards)**
- One per scope: ads / social / leads / overall
- Color-coded emoji indicator
- Click → full insight page

**Row 3 — Release + Campaign Timeline (full width)**
- Horizontal timeline last 30 days
- Releases as vertical markers
- Active campaigns as horizontal bars
- Hover shows signups delta in that period
- *(This is the killer view the experts called out — build it well)*

**Row 4 — Quick actions + Reminders**
- "Today's follow-ups" list (leads where `nextFollowUpAt` is today)
- "Overdue follow-ups" list (past `nextFollowUpAt`)
- Buttons: New Lead / New Task / New Post / Compose Campaign

### 11.2 Acceptance criteria
- Dashboard loads in <2s on local Postgres with 1000 leads + 100 campaigns + 500 posts
- All numbers update on page refresh
- Mobile layout collapses Row 1 to 2x2 grid, others stack vertically

---

## 12. Settings Page

`/settings` (admin only for sensitive fields)

### 12.1 Sections
1. **Profile** (any user) — name, phone, avatar, password change
2. **Users** (admin) — list, add, deactivate
3. **API keys** (admin) — Anthropic API key (encrypted at rest in `Setting` table), HMAC webhook secret
4. **AI config** (admin) — Claude model selection, daily digest enabled/disabled, digest time
5. **Hashtag library** (any user) — manage reusable hashtag sets

### 12.2 Encryption
API keys stored in `Setting` table must be encrypted with AES-256-GCM using `ENCRYPTION_KEY` env var (32 bytes). Helper in `src/lib/crypto.ts`.

---

## 13. UI / UX Standards

### 13.1 Design language
- Clean, **dense** layout (this is internal — no marketing whitespace)
- Sidebar nav: collapsible, icons + labels
- Topbar: search (cmd+k), notifications, user menu
- Use shadcn/ui Card, Table, Dialog, Form, Badge, Toast, Tabs
- Color palette: neutral base + accent (#6366f1 indigo). Status colors: green/red/amber/blue per convention.

### 13.2 Responsiveness
- Sidebar collapses to hamburger on <768px
- All tables horizontally scrollable on mobile
- Kanban boards: 1 column at a time with swipe on mobile

### 13.3 Empty states
Every list must have a designed empty state with: icon, message, primary action button. No blank screens.

### 13.4 Loading states
- Skeleton loaders on all data fetches >200ms
- Optimistic updates on drag-drop & toggle actions

### 13.5 Error handling
- API errors → toast with friendly message
- Form errors → inline below field
- 500 errors → log to console + activity log, show "Something went wrong" toast
- Never show raw stack traces to end users

---

## 14. Activity Logging (cross-cutting)

Every state-changing API endpoint must call `logActivity(userId, action, entityType, entityId, metadata)`. Examples:
- `lead.created`, `lead.status_changed`, `lead.assigned`, `lead.deleted`
- `campaign.metrics_updated`, `campaign.created`
- `devtask.moved`, `devtask.completed`
- `ai.insight_generated`, `ai.insight_actioned`
- `user.created`, `user.deactivated`

Stored in `ActivityLog` table. Used by employee profile + dashboard "recent activity" sidebar.

---

## 15. Environment Variables

`.env.example` must include:
```
DATABASE_URL=postgresql://user:pass@localhost:5432/officepilot
NEXTAUTH_SECRET=generate_with_openssl_rand_base64_32
NEXTAUTH_URL=http://localhost:3000
ADMIN_SEED_EMAIL=admin@chitly.live
ADMIN_SEED_PASSWORD=change_me_on_first_login
ANTHROPIC_API_KEY=sk-ant-...
ENCRYPTION_KEY=generate_with_openssl_rand_hex_32
CRON_SECRET=generate_with_openssl_rand_hex_32
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM="OfficePilot <noreply@chitly.live>"
WEBHOOK_HMAC_SECRET=generate_with_openssl_rand_hex_32
```

---

## 16. Testing Requirements

### 16.1 Unit tests (Vitest)
For each `lib/` helper: `permissions.ts`, `utm.ts`, `crypto.ts`, `activity.ts`. Minimum 80% line coverage on lib/.

### 16.2 Integration tests (Vitest + supertest pattern on Next.js handlers)
For each API route, test:
- Happy path (correct request → 200 + expected DB state)
- Auth required (no session → 401)
- Permission denied (employee accessing admin-only → 403)
- Validation error (invalid body → 400 with zod errors)

Minimum endpoints to cover:
- `POST /api/leads`, `PATCH /api/leads/[id]`, `POST /api/leads/import`
- `POST /api/campaigns`, `PATCH /api/campaigns/[id]`
- `POST /api/dev/tasks`, `PATCH /api/dev/tasks/[id]`
- `POST /api/ai/generate` (mock Anthropic client)
- `POST /api/webhooks/leads` (HMAC valid + invalid cases)

### 16.3 E2E tests (Playwright)
Critical flows:
1. **Login flow**: seed admin → login → land on dashboard
2. **Add lead → move through pipeline → see in activity log**
3. **Create campaign → CAC calculation correct**
4. **Drag dev task TODO → DONE → completedAt set**
5. **Compose social post → schedule → see on calendar**
6. **Trigger AI generate (mocked) → insight appears**

Run with `npm run test:e2e`. Headed mode for debugging, headless for CI.

### 16.4 Manual smoke test checklist (Kiro to run after build)
- [ ] Seed admin can log in
- [ ] Admin creates employee → employee can log in
- [ ] Employee cannot access /employees/new
- [ ] Add 5 leads, assign 2 to employee → employee sees only their 2 on their list (when filter set to "mine")
- [ ] CSV import 20 rows → 18 imported, 2 duplicates flagged
- [ ] Kanban drag works on desktop + touch
- [ ] Calendar view shows posts at correct dates
- [ ] UTM generator output URL works (opens in browser)
- [ ] AI generate with mock data returns valid JSON
- [ ] Dashboard loads with all 4 rows populated
- [ ] Mobile view: sidebar collapses, tables scroll, forms usable
- [ ] Logout works; session cleared

### 16.5 Performance budgets
- Initial JS bundle: <250kb gzipped
- Dashboard FCP: <1.5s on local; <3s on VPS
- API p95 latency: <500ms for list endpoints with 1000 rows

---

## 17. Deployment to VPS (Ubuntu 22.04)

### 17.1 Server prerequisites
- Ubuntu 22.04 LTS
- Node.js 20.x LTS (via nodesource)
- PostgreSQL 15+
- Nginx
- Certbot (Let's Encrypt)
- PM2 (`npm i -g pm2`)
- A domain or subdomain (e.g., `office.chitly.live`) pointed to VPS IP

### 17.2 Deployment steps (document in `DEPLOY.md`)
1. **Clone repo** to `/var/www/officepilot`
2. **Install deps**: `npm ci --production=false`
3. **Setup Postgres**:
   ```
   sudo -u postgres psql
   CREATE DATABASE officepilot;
   CREATE USER officepilot_user WITH PASSWORD 'strong-pass';
   GRANT ALL ON DATABASE officepilot TO officepilot_user;
   ```
4. **Configure `.env.production`** (copy from .env.example, fill values)
5. **Run migrations**: `npx prisma migrate deploy`
6. **Seed admin**: `npx prisma db seed`
7. **Build**: `npm run build`
8. **Start with PM2**: `pm2 start ecosystem.config.js` (provides cluster mode + cron worker)
9. **Nginx reverse proxy** config for `office.chitly.live` → `localhost:3000`
10. **SSL**: `certbot --nginx -d office.chitly.live`
11. **Cron**: add system crontab `0 9 * * * curl http://localhost:3000/api/cron/daily-digest -H "Authorization: Bearer $CRON_SECRET"`
12. **Firewall**: `ufw allow 22, 80, 443; ufw deny 3000` (Nginx-only access)
13. **Backups**: `pg_dump` daily to `/var/backups/officepilot/` + rotate weekly

### 17.3 `ecosystem.config.js` (PM2)
```js
module.exports = {
  apps: [
    {
      name: 'officepilot-web',
      script: 'npm',
      args: 'start',
      instances: 2,
      exec_mode: 'cluster',
      env: { NODE_ENV: 'production', PORT: 3000 }
    }
  ]
};
```

---

## 18. Build Order (Kiro should follow this sequence)

Build in this order to maximize working software at each step:

1. **Foundation (Day 1-2)**
   - Init Next.js + TS + Tailwind + shadcn + Prisma
   - Setup Postgres locally + schema migration
   - Setup NextAuth with credentials + role middleware
   - Seed admin user
   - Build login page + protected `/dashboard` shell
   - Sidebar + Topbar layout shell

2. **Employees module (Day 3)** — simplest CRUD, learn the pattern

3. **Leads module (Day 4-6)** — most complex; build full
   - Then CSV import + webhook
   - Then Kanban view

4. **Marketing module (Day 7-8)**
   - Campaigns CRUD + metrics + CAC
   - UTM generator
   - Auto-link leads via UTM

5. **Social Media module (Day 9-10)**
   - Calendar + list view
   - Compose + performance entry
   - Winners page

6. **Dev Tracking module (Day 11-12)**
   - Kanban
   - Bugs / Releases / Roadmap tabs

7. **AI Analysis module (Day 13-15)** — most novel
   - Metrics aggregation queries
   - Claude integration with prompt caching
   - Insight feed UI
   - Daily digest cron

8. **Unified Dashboard (Day 16-17)**
   - All 4 rows
   - **Release + Campaign Timeline** (give this extra polish)

9. **Settings + polish (Day 18-19)**
   - Settings page
   - Encryption for API keys
   - Empty states / loading states sweep
   - Mobile responsive QA

10. **Testing (Day 20-22)**
    - Unit tests for lib/
    - Integration tests for critical APIs
    - Playwright E2E for 6 flows in §16.3
    - Manual smoke test checklist (§16.4)

11. **Deployment prep (Day 23)**
    - Write `DEPLOY.md`
    - `ecosystem.config.js`
    - Tag v0.1.0
    - Hand off to reviewer

---

## 19. Definition of Done (for Kiro)

Before declaring "done", verify:

- [ ] All 6 modules + dashboard + settings implemented per spec
- [ ] Database migrations run cleanly on a fresh Postgres
- [ ] Seed script creates admin successfully
- [ ] `npm run build` succeeds with zero TypeScript errors
- [ ] `npm run lint` passes
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] All 6 Playwright E2E flows pass
- [ ] Manual smoke test checklist all green
- [ ] Mobile (Chrome DevTools 375px width) usable on every page
- [ ] No `console.log` left in production code
- [ ] No hardcoded secrets in code (all via env vars)
- [ ] `.env.example` complete
- [ ] `README.md` written: project intro, local dev setup, scripts
- [ ] `DEPLOY.md` written: VPS deployment runbook (§17.2)
- [ ] At least one full AI insight generated successfully with real Claude API call (admin verifies)

---

## 20. What Kiro should NOT do

- Do NOT add features not listed in this spec, even if "they seem useful"
- Do NOT swap libraries (e.g., Drizzle instead of Prisma, Mantine instead of shadcn) without explicit approval
- Do NOT implement multi-tenancy / org switching
- Do NOT build a public marketing site / landing page (this is internal only)
- Do NOT build mobile native apps
- Do NOT integrate platform-publishing for social posts (manual posting in v1)
- Do NOT add real-time features (Pusher/Socket.io) — not needed for internal tool
- Do NOT skip tests because "module is simple"
- Do NOT leave half-built features in main branch — feature-flag or finish

---

## 21. Handoff to Reviewer

When done, Kiro provides:
1. Running local instance (instructions in README)
2. Test results summary (counts of unit/integration/E2E passed)
3. Screenshot of dashboard, leads page, AI insights page
4. List of any spec deviations with justification
5. Open issues / known limitations list

Reviewer (Lal Singh) will:
- Run through §16.4 manual checklist
- Verify §19 Definition of Done items
- Test AI Analysis with a real Anthropic key on a populated dev DB
- Approve for VPS deployment OR send back with fix list

---

**End of SPEC.md** — Version 1.0 — Build target: ~3 weeks of focused work.
