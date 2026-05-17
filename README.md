# OfficePilot

> An internal office cockpit built for a small startup team — single source of truth for **people, leads, marketing, social, dev tracking**, and **AI-driven growth insights**. Originally built for [Chitly](https://www.chitly.live) (a consumer social-networking app), open-sourced for anyone running a small team that wants more than spreadsheets and less than a $200/seat SaaS stack.

[![Tech: Next.js 14](https://img.shields.io/badge/Next.js-14-black?logo=next.js)](https://nextjs.org)
[![DB: PostgreSQL](https://img.shields.io/badge/PostgreSQL-15+-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![ORM: Prisma](https://img.shields.io/badge/Prisma-5-2D3748?logo=prisma)](https://www.prisma.io)
[![AI: Claude](https://img.shields.io/badge/Claude-Opus%2FSonnet%2FHaiku-d97757)](https://www.anthropic.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](#license)

---

## ✨ What is OfficePilot?

A self-hosted, single-tenant, role-based internal tool that replaces the typical "Notion + HubSpot free + Buffer + Linear + manual ROI math" stack a small startup leans on. Eight modules behind one login, one DB, one VPS.

**Designed for teams of ~5-15 people** running a digital product. The AI Analysis module (driven by Claude) is the unique value — it does week-over-week trend analysis, 7-day forecasting, anomaly detection, cross-module correlation, and generates a prioritized HIGH/MEDIUM/LOW action list every morning at 9 AM IST.

---

## 🎯 Features

### 8 modules under one roof

| Module | What it does |
|---|---|
| 📊 **Dashboard** | 4-row unified pulse: today's metrics, latest AI insights, release+campaign timeline, follow-up reminders |
| 👥 **Employees** | Roster, role-based access (admin/employee), **per-module visibility permissions**, attendance, performance snapshots |
| 📥 **Leads** | Full CRM: capture (manual + CSV + webhook), 6-stage pipeline kanban, owner assignment, follow-up reminders, activity timeline, UTM auto-attribution |
| 📢 **Marketing** | Campaigns with budget/spend/signups tracking, auto-CAC calculation, UTM generator, channel comparison charts |
| 📱 **Social** | Post composer with scheduled calendar view, performance log, winners gallery, hashtag library |
| 💻 **Dev Tracking** | Linear-style kanban for the app team, bug inbox, release log, 8-week roadmap |
| 🤖 **AI Analysis** ⭐ | **The USP** — 6 scopes (ads, social, leads, overall, predictions, anomalies) + prioritized action list. Mixed-model strategy: Haiku for cheap routine, Sonnet for analytical, Opus for strategic action prioritization. |
| ⚙️ **Settings** | Admin-only: API keys (encrypted AES-256-GCM), SMTP, Meta Ads, Google Ads, Instagram, per-scope Claude model selection, hashtag library, user management |

### Highlights

- **Zero external dependencies for core ops** — runs entirely on your VPS with Postgres + Node
- **Encrypted secret storage** — API keys + webhook secrets stored encrypted in the DB
- **HMAC-secured webhook** for inbound leads (timing-safe comparison)
- **Per-module permissions** — admins can give each employee surgical access (e.g., marketing person sees only Marketing + Leads)
- **Boot-time env validation** — fails fast on misconfigured `.env.production` instead of crashing mid-traffic
- **JWT re-check cadence** — deactivated users lose access within ~5 min, not at JWT expiry
- **Property-based testing** (`fast-check`) for HMAC robustness and activity log invariants

---

## 🛠️ Tech Stack

- **Next.js 14** (App Router) + **TypeScript 5** + **Tailwind CSS** + **shadcn/ui**
- **Prisma 5** + **PostgreSQL 15+**
- **NextAuth.js v5** (credentials provider, JWT sessions with 5-min re-validation)
- **Anthropic SDK** (Claude — Opus 4.7 / Sonnet 4.6 / Haiku 4.5) for AI Analysis
- **Recharts** for dashboards
- **react-hook-form** + **zod** for forms
- **Vitest** + **Playwright** for testing (236 unit + 265 integration + 16 E2E)
- **node-cron** worker (PM2-managed in prod) for scheduled jobs
- **AES-256-GCM** for at-rest secret encryption
- **nodemailer** for SMTP (Gmail / SES / any standard provider)

---

## 🚀 Quick Start (Local Dev)

### Prerequisites
- **Node.js 20+**
- **PostgreSQL 15+** (running locally or reachable via `DATABASE_URL`)
- Optional: **Anthropic API key** for AI features (the app works without it; AI scopes will return a clear error)

### 5-step setup

```bash
# 1. Clone
git clone https://github.com/chitly-live/OfficePilot.git
cd OfficePilot
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — generate secrets with:
#   openssl rand -base64 32  (NEXTAUTH_SECRET)
#   openssl rand -hex 32     (ENCRYPTION_KEY, CRON_SECRET, WEBHOOK_HMAC_SECRET)

# 3. Create the database
createdb officepilot
# or via psql: psql -c "CREATE DATABASE officepilot;"

# 4. Run migrations + seed admin user
npx prisma migrate deploy
npx prisma db seed

# 5. Start the dev server
npm run dev
```

Open **http://localhost:3000** and log in with `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` from your `.env`.

> 🔐 **Security:** Rotate `ADMIN_SEED_PASSWORD` via Settings → Profile right after first login. The seed password is the only way in until you do.

---

## 🌐 Production Deployment (Ubuntu VPS)

Full step-by-step runbook in [**DEPLOY.md**](./DEPLOY.md) — 22 sections covering:

1. Node 20 + PostgreSQL 15 + Nginx + Certbot + PM2 installation
2. Postgres database/user setup with least-privilege grants
3. `.env.production` configuration with secret rotation guidance
4. Migrations + seed + Next.js build + cron worker build
5. PM2 ecosystem (web cluster + cron worker), startup, monitoring
6. Nginx reverse proxy + Let's Encrypt SSL
7. UFW firewall + daily `pg_dump` backups with rotation
8. Meta Ads & Google Ads integration setup (OAuth Playground walkthrough)

**Estimated time:** ~30-45 min from fresh Ubuntu 22.04 to live HTTPS deployment.

---

## 📁 Project Structure

```
officepilot/
├── src/
│   ├── app/                # Next.js App Router (pages + API routes)
│   │   ├── (app)/          # Authenticated app shell — dashboard, modules
│   │   ├── (auth)/         # Login page
│   │   └── api/            # 35+ REST endpoints
│   ├── lib/                # Domain libs — auth, prisma, crypto, claude, permissions
│   │   ├── aggregations/   # 6 AI scope data builders (ads, social, leads, overall, predictions, anomalies)
│   │   ├── integrations/   # External APIs (Meta, Google Ads)
│   │   └── schemas/        # Zod validation schemas
│   ├── components/         # Shared UI (shadcn-style + app-specific)
│   ├── middleware.ts       # Auth gate + per-module permission gate
│   └── types/              # NextAuth type augmentations
├── prisma/
│   ├── schema.prisma       # 12 models (User, Lead, Campaign, SocialPost, DevTask, AIInsight, AIAction, …)
│   ├── migrations/         # Versioned SQL migrations
│   └── seed.ts             # Idempotent admin seed
├── worker/                 # Standalone cron worker (node-cron + PM2)
├── tests/
│   ├── integration/        # 18 files, 265 tests (real Postgres)
│   └── e2e/                # 8 Playwright specs across chromium + mobile-chrome projects
├── docs/
│   ├── HANDOFF.md          # Per-release proof + change log
│   ├── REVIEW-REPORT.md    # Independent panel audit findings
│   ├── SMOKE-CHECKLIST.md  # Manual QA gate (SPEC §16.4)
│   └── TEST-CHECKPOINT.md  # Latest test/build/lint snapshot
├── SPEC.md                 # 21-section product spec (the canonical source)
├── DEPLOY.md               # 22-section VPS deployment runbook
└── .env.example            # All env vars with generation instructions
```

---

## 🧪 Testing

| Suite | Command | Count | What it covers |
|---|---|---|---|
| Unit | `npm run test` | 236 tests, 6 files | `src/lib/` helpers — permissions, activity, utm, crypto, trend, env |
| Integration | `npm run test:int` | 265 tests, 18 files | Every API route against real Postgres — auth gates, validation, persistence, audit log |
| E2E | `npm run test:e2e` | 16 tests, 8 files | Critical user flows via Playwright (chromium + Pixel 5 mobile) |

Quality signals:
- **Property-based testing** (`fast-check`) for HMAC bit-flip robustness (60 runs/check)
- **`crypto.timingSafeEqual`** for HMAC + cron bearer token comparisons
- **Anthropic SDK mocked at module level** for integration; `MOCK_ANTHROPIC=1` env shim lets E2E hit the real route end-to-end without a key
- **Zero `console.log` in production code** (verified via grep gate)
- **Zero hardcoded secrets** in source

---

## 🤖 AI Analysis Deep-Dive

The standout feature. Configurable in **Settings → AI tab** with a mixed-model strategy:

| Scope | What it does | Recommended Model |
|---|---|---|
| **Ads** | Week-over-week spend/CAC, best & worst campaigns, channel ROI ranking, wasted-spend report | Sonnet 4.6 |
| **Social** | Engagement trends, top/bottom posts, posting time patterns | Sonnet 4.6 |
| **Leads** | Funnel conversion, lost-lead reasons, owner workload | Sonnet 4.6 |
| **Overall** | Cross-module correlations: social→leads, campaign→conversion, release→retention, top performer detection | Sonnet 4.6 |
| **Predictions** ⭐ | 28-day rolling history + 7-day linear regression forecast for spend/signups/CAC | Sonnet 4.6 |
| **Anomalies** ⭐ | Z-score detection vs 7-day baseline — signup spikes, ad cost jumps, conversion drops, bug spikes | Sonnet 4.6 |
| **Actions** ⭐ | Prioritized HIGH/MEDIUM/LOW to-do list from latest insights, click-to-mark-done | **Opus 4.7** |
| Default fallback | Cheap routine for everything else | Haiku 4.5 |

**Why mixed models?** Strategic reasoning (action prioritization) benefits from Opus depth. Routine narration (daily digest) is fine on Haiku at 1/5 the cost. Configure each scope individually under Settings → AI → "Per-scope model overrides".

**Estimated AI cost** for a 10-person team running the daily digest + occasional on-demand: **~₹600-900/month** (~$7-11).

---

## 🔑 Environment Variables

`.env.example` is the canonical list. Critical ones:

| Variable | Required? | Purpose |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres connection string |
| `NEXTAUTH_SECRET` | ✅ | 32+ chars, signs JWTs |
| `ENCRYPTION_KEY` | ✅ | 64 hex chars (AES-256-GCM key) |
| `WEBHOOK_HMAC_SECRET` | ✅ | Inbound webhook signature |
| `CRON_SECRET` | ✅ | Bearer for `/api/cron/*` |
| `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` | ✅ on first install | Initial admin |
| `ANTHROPIC_API_KEY` | Optional | Required only for live AI scopes |
| `SMTP_HOST/PORT/USER/PASS/FROM` | Optional | For email digests + follow-up reminders |

Boot-time validation (`src/lib/env.ts` + `instrumentation.ts`) fails fast on missing/invalid critical secrets, so misconfigured environments never reach traffic.

---

## 📊 Roadmap

- ✅ **v0.1.0** — Foundation: 6 modules + dashboard + settings + tests
- ✅ **v0.1.1** — Test infra: kanban drag E2E, mobile viewport project, AI E2E with mocked Claude
- ✅ **v0.1.2** — Security & reliability: JWT isActive re-check, boot env validation, RSC bug fix
- ✅ **v0.1.3** — AI expansion: predictions + anomalies scopes, cross-module correlations, action list, SMTP + Meta/Google Ads/Instagram settings, per-module employee permissions, mixed-model strategy
- 🔜 **v0.1.4** — Auto-sync actual ad data from Meta Marketing API + Google Ads API into Campaign rows
- 🔜 **v0.1.5** — Cron worker missed-digest catch-up + PM2 log rotation + monitoring/alerting + race-condition transactions
- 🔜 **v0.2.0** — Multi-currency (currently INR), more pricing intelligence, Slack/WhatsApp notification channels

---

## 📚 Documentation

| Doc | What's in it |
|---|---|
| [SPEC.md](./SPEC.md) | 21-section product specification — DB schema, API contracts, every module's features, testing requirements, build order |
| [DEPLOY.md](./DEPLOY.md) | 22-section Ubuntu 22.04 VPS deployment runbook with copy-pasteable commands |
| [docs/HANDOFF.md](./docs/HANDOFF.md) | Per-release proof: test counts, build output, definition-of-done verification |
| [docs/REVIEW-REPORT.md](./docs/REVIEW-REPORT.md) | Independent 4-agent audit findings (security, reliability, data integrity, regression) |
| [docs/SMOKE-CHECKLIST.md](./docs/SMOKE-CHECKLIST.md) | Manual QA gate before each deploy |
| [docs/TEST-CHECKPOINT.md](./docs/TEST-CHECKPOINT.md) | Latest test/build/lint snapshot |

---

## 🤝 Contributing

This was built as an internal tool but the repo is open for inspection, forks, and contributions. If you find bugs or want to add features:

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/your-idea`)
3. Ensure `npx tsc --noEmit && npx next lint && npm run test && npm run test:int` all pass
4. Open a PR with a clear description

For larger changes, open an issue first to discuss the approach.

**Code style:**
- TypeScript strict mode
- Tailwind for styling (no separate CSS files)
- shadcn/ui patterns for new components
- Zod for all API input validation
- Property-based testing where invariants matter

---

## ⚠️ Important Notes

- **Single-tenant.** This is NOT a multi-tenant SaaS. One DB = one organization. If you want multi-tenancy, that's a sizable rewrite (out of scope for v0.x).
- **Internal tool.** No public marketing pages, no signup flow. Admin creates employee accounts.
- **Indian-context defaults.** Currency is INR by default (configurable), cron uses `Asia/Kolkata`, AI prompts allow natural Hindi/English mixing. Easily changed via env / settings.
- **Anthropic dependency for AI.** AI Analysis sends aggregated business metrics (no PII names, but campaign IDs and aggregate counts) to Anthropic's API. Review their data policy before connecting a real key in production.

---

## 📄 License

MIT — see [LICENSE](./LICENSE). Use it, fork it, modify it. If you ship something interesting built on top of OfficePilot, I'd love to hear about it.

---

## 🙏 Credits

Built for the [Chitly](https://www.chitly.live) team. Spec-driven workflow with multi-agent AI assistance — see [SPEC.md](./SPEC.md) §0 for the build philosophy.

Issues and pull requests welcome at **https://github.com/chitly-live/OfficePilot**.
