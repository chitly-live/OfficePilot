# OfficePilot — Manual Smoke Test Checklist

> Post-deploy human verification flow. Run this after the build is green and automated tests (unit, integration, Playwright) have passed. Mirrors SPEC.md §16.4. Reviewer: Lal Singh.

---

## Setup

Before starting, have the following ready:

- Seeded admin credentials (from `prisma/seed.ts`).
- A test browser (Chrome) at desktop width — at least **1280px**.
- A phone, or Chrome DevTools device emulation, set to **375px** width for mobile checks.
- An Anthropic API key configured (via `ANTHROPIC_API_KEY` env var or in-app **Settings**) for the AI flow.
- The app running against a clean-ish dev/staging DB (a few rows is fine; full empties will show zeros, which is OK).

---

## Checklist

Tick each item once verified. If any item fails, stop and file a bug before continuing.

- [ ] **Admin login** — Navigate to `/login`, enter the seeded admin credentials, click **Sign in**. Verify redirect to `/dashboard`.
- [ ] **Dashboard renders** — On `/dashboard`, all 4 rows are visible: Today's Pulse, Latest AI Insights, Release + Campaign Timeline, and Quick Actions + Reminders. Numbers are populated (zeros are acceptable on an empty DB).
- [ ] **Admin creates employee** — Go to `/employees/new`, fill out the form, submit. Verify the new user appears in the `/employees` list.
- [ ] **New employee can log in** — Log out, log back in using the new employee's credentials. Verify landing on `/dashboard`.
- [ ] **Employee cannot access `/employees/new`** — Still logged in as the employee, try navigating to `/employees/new`. Expect a redirect or 403/forbidden response.
- [ ] **Lead assignment scoping** — As admin, add 5 leads, assign 2 to the test employee. Log back in as the employee, set the list filter to **"mine"**. Verify they see only those 2 leads.
- [ ] **CSV import** — At `/leads/import`, upload a CSV with 20 rows including 2 duplicates. Verify the import summary reports **18 imported, 2 flagged as duplicates**.
- [ ] **Kanban drag (desktop)** — On `/leads`, switch to Kanban view. Drag a lead from **NEW** → **INTERESTED**. Open the lead's detail page, go to the Activity tab, and verify a new ActivityLog entry was created for the status change.
- [ ] **Kanban drag (mobile / touch)** — Same flow as above, performed on a phone or with Chrome DevTools touch simulation enabled. Verify the drag works and the ActivityLog entry is created.
- [ ] **Calendar view** — On `/social`, switch to calendar view. Verify scheduled posts appear on the correct dates.
- [ ] **UTM generator** — At `/marketing/utm`, fill in the source, medium, campaign, and URL fields. Copy the generated URL, open it in a new tab, and verify the page loads (UTM params present in the address bar).
- [ ] **AI generate** — Go to `/ai`, click **Generate now**, choose a scope (e.g., `overall`), and submit. Within ~10 seconds, a new insight card appears with a valid trend value and summary text.
- [ ] **Mobile (375px)** — Open the app at 375px width and verify:
  - [ ] Sidebar collapses into a hamburger menu.
  - [ ] Dashboard rows stack vertically.
  - [ ] Tables scroll horizontally instead of overflowing.
  - [ ] Forms remain usable; no inputs or buttons clip off-screen.
- [ ] **Logout** — Click the user menu → **Sign out**. Verify the session is cleared: refreshing any protected route redirects to `/login`.

---

## Acceptance

All checks passed: ___ / ___ on YYYY-MM-DD by ____.
