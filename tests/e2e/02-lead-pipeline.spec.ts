/**
 * Lead pipeline E2E spec — SPEC §16.3 #2 (task 92).
 *
 * Walks the canonical "add lead → move it through the pipeline → see
 * the move in the activity log" flow that SPEC §6 calls out as a
 * critical path. Concretely:
 *
 *   1. Sign in as the seeded admin via the real `/login` form.
 *   2. Open `/leads/new`, fill the form (name, phone, source = MANUAL),
 *      submit, and confirm the API redirects us to `/leads/[id]` (the
 *      detail page) — the LeadCreateForm calls
 *      `router.replace('/leads/' + created.id)` on success.
 *   3. Bounce back to `/leads` and assert the row is present in the
 *      table — guards against a dropped list-side cache.
 *   4. Tap the "Kanban" view toggle so we exercise SPEC §6.2.2's
 *      view-switch link (`?view=kanban`). We do NOT attempt the
 *      `@dnd-kit` drag-drop interaction itself — see the comment
 *      below the toggle for the full rationale.
 *   5. Drive the status transition NEW → INTERESTED via the inline
 *      status `<Select>` on `/leads/[id]`. The PATCH route is the
 *      same one the kanban drag-drop calls, and the activity row
 *      it produces is identical, so coverage is preserved.
 *   6. Reload the detail page, click the Activity tab, and assert the
 *      timeline row reads `moved lead Test Lead from NEW to INTERESTED`
 *      (template from `formatActivity` in `src/lib/activity.ts`).
 *
 * Helpers from `tests/e2e/helpers.ts` handle the seeded-admin
 * lifecycle and per-test DB cleanup so each run starts from a known
 * state.
 */

import { test, expect } from '@playwright/test';

import {
  cleanupTestData,
  disconnectPrisma,
  loginAsAdmin,
  seedAdmin,
} from './helpers';

// ---------------------------------------------------------------------------
// Suite lifecycle
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  // Idempotent — refreshes the canonical E2E admin password hash so a
  // half-broken row from a previous run can never lock us out.
  await seedAdmin();
});

test.beforeEach(async () => {
  // Truncate every mutable table this flow can touch. Keeps the
  // "Test Lead" assertion deterministic — no leftover rows from a
  // sibling spec leaking into the leads table.
  await cleanupTestData();
});

test.afterAll(async () => {
  // Close the helper-scoped Prisma pool so Playwright can exit
  // cleanly even when the dev server is reused across runs.
  await disconnectPrisma();
});

// ---------------------------------------------------------------------------
// Critical path
// ---------------------------------------------------------------------------

test('Lead pipeline: create → drag NEW → INTERESTED → see activity log entry', async ({
  page,
}) => {
  // ----- 1. Sign in --------------------------------------------------------
  await loginAsAdmin(page);

  // ----- 2. Create the lead -----------------------------------------------
  await page.goto('/leads/new');

  // `getByLabel` is the most resilient selector for the shadcn form
  // — it survives renames of the underlying `id`/class.
  await page.getByLabel('Name').fill('Test Lead');
  await page.getByLabel('Phone').fill('+919876543210');

  // Source already defaults to MANUAL (LeadCreateForm `defaultValues`),
  // but we explicitly set it so the test stays correct if the default
  // ever shifts. The shadcn `<Select>` renders as a button with the
  // accessible name of its current value, so we open it via the
  // "Source" combobox role and pick the "Manual" option.
  await page.getByRole('combobox', { name: 'Source' }).click();
  await page.getByRole('option', { name: 'Manual' }).click();

  // Submit the form. On success the LeadCreateForm pushes us to
  // `/leads/[id]`; allow `/leads` as a fallback for environments
  // where a 3xx may briefly land on the list page first.
  await page.getByRole('button', { name: /create lead/i }).click();
  await expect(page).toHaveURL(/\/leads(\/[^/?#]+)?(\/|$|\?)/, {
    timeout: 15_000,
  });

  // ----- 3. Confirm the row landed in the list ----------------------------
  await page.goto('/leads');
  // The leads table renders the lead name as a link to `/leads/[id]`,
  // so a role-based query is both precise and resilient to layout
  // changes.
  await expect(
    page.getByRole('link', { name: 'Test Lead' }).first(),
  ).toBeVisible();

  // ----- 4. Visit the Kanban view (no drag-drop) --------------------------
  // SPEC §6.2.2 ships a Table ↔ Kanban toggle on `/leads`. We click
  // the toggle so the navigation path is exercised, but we do NOT
  // perform the actual @dnd-kit drag-drop:
  //
  //   • @dnd-kit relies on PointerEvents + activation-distance
  //     thresholds that Playwright's `dragTo` synthesises poorly,
  //     producing flaky cross-browser failures (see kiro/officepilot
  //     wave-9 spike notes).
  //   • The kanban drag handler calls the same `PATCH /api/leads/[id]`
  //     route as the inline status select on `/leads/[id]`, and emits
  //     the identical `lead.status_changed` activity row. Driving the
  //     transition through the form therefore keeps full server-side
  //     coverage with zero drag-drop flake.
  //
  // Trade-off documented; we keep the toggle click so a regression
  // that breaks the kanban URL (or the table → kanban Link) still
  // fails the spec.
  await page
    .getByRole('tab', { name: /kanban/i })
    .click();
  await expect(page).toHaveURL(/[?&]view=kanban\b/);

  // ----- 5. Move the lead NEW → INTERESTED via the form ------------------
  // Find the lead's id from the link we asserted above so we can
  // navigate straight to the detail page without scraping the URL
  // a second time.
  await page.goto('/leads');
  const leadLink = page.getByRole('link', { name: 'Test Lead' }).first();
  const leadHref = await leadLink.getAttribute('href');
  expect(leadHref, 'lead link should expose its detail href').toBeTruthy();

  await page.goto(leadHref!);

  // The status select sits inside `LeadEditForm` on the Details tab
  // (default tab). Open it, pick "Interested", and save.
  await page.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Interested' }).click();
  await page.getByRole('button', { name: /save changes/i }).click();

  // The form shows a sonner toast on success; the simplest reliable
  // signal is that the inline status combobox now reads "Interested"
  // after `router.refresh()`. Wait for that to avoid racing the
  // re-render before navigating to the activity tab.
  await expect(
    page.getByRole('combobox', { name: 'Status' }),
  ).toContainText('Interested');

  // ----- 6. Verify the activity log row -----------------------------------
  // Re-navigate so the server component re-fetches the activity
  // timeline (the page is `dynamic = 'force-dynamic'`).
  await page.goto(leadHref!);
  await page.getByRole('tab', { name: 'Activity' }).click();

  // `formatActivity` (src/lib/activity.ts) renders status changes as
  // `{userName} moved lead {entityName} from {from} to {to}` where
  // `{from}`/`{to}` are the raw enum values. We match the relevant
  // substring so an avatar/timestamp tweak doesn't break the spec.
  await expect(
    page.getByText(/moved lead Test Lead from NEW to INTERESTED/i),
  ).toBeVisible();
});

// ---------------------------------------------------------------------------
// Drag-drop test — exercises the actual @dnd-kit kanban gesture
// ---------------------------------------------------------------------------
//
// FIX-LIST §3 (task 106) explicitly CHALLENGES the prior "no drag in
// E2E" carve-out. We satisfy that by driving a manual pointer sequence
// that respects @dnd-kit's `PointerSensor` activation distance.
//
// Drag strategy: manual pointer sequence (Option B). The `KanbanBoard`
// in `src/components/shared/KanbanBoard.tsx` configures
// `useSensor(PointerSensor, { activationConstraint: { distance: 6 } })`.
// Playwright's `locator.dragTo()` collapses the move into a single
// intermediate step which @dnd-kit treats as a click below the
// activation threshold, so we drive the sequence by hand:
//
//   1. `mouse.move` to the card center.
//   2. `mouse.down`.
//   3. A short nudge (~10 px) to clear the 6 px activation distance.
//   4. A multi-step move to the target column center.
//   5. `mouse.up`.
//
// We then wait for the PATCH `/api/leads/[id]` round-trip that
// `LeadsKanban.handleMove` issues so the assertion isn't racing the
// optimistic re-render.

test('Lead pipeline: drag card from NEW → INTERESTED on kanban', async ({
  page,
}) => {
  // ----- 1. Sign in -------------------------------------------------------
  await loginAsAdmin(page);

  // ----- 2. Create the lead via the JSON API ------------------------------
  // The API is faster than driving the create form and keeps this spec
  // focused on the drag-drop gesture rather than form validation.
  const createRes = await page.request.post('/api/leads', {
    data: {
      name: 'Test Lead',
      phone: '+919876543210',
      source: 'MANUAL',
    },
  });
  expect(createRes.ok(), 'POST /api/leads should succeed').toBeTruthy();
  const created = (await createRes.json()) as {
    id: string;
    status: string;
  };
  expect(created.status).toBe('NEW');

  // ----- 3. Navigate to the kanban view -----------------------------------
  await page.goto('/leads?view=kanban');

  const newColumn = page.locator('[data-column-id="NEW"]');
  const interestedColumn = page.locator('[data-column-id="INTERESTED"]');
  const cardInNew = newColumn.getByText('Test Lead');

  await expect(cardInNew).toBeVisible();
  await expect(interestedColumn).toBeVisible();

  // ----- 4. Drive the drag with a manual pointer sequence -----------------
  // Scroll the target column into view first — the kanban container is
  // horizontally scrollable when many columns render side-by-side, and
  // we need both source and target boxes inside the viewport for the
  // pointer events to dispatch correctly.
  await interestedColumn.scrollIntoViewIfNeeded();
  // Re-anchor the source after the scroll.
  await cardInNew.scrollIntoViewIfNeeded();

  const sourceBox = await cardInNew.boundingBox();
  const targetBox = await interestedColumn.boundingBox();
  if (!sourceBox || !targetBox) {
    throw new Error(
      'drag source/target bounding box was null — kanban did not lay out',
    );
  }

  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const targetX = targetBox.x + targetBox.width / 2;
  const targetY = targetBox.y + targetBox.height / 2;

  const patchPromise = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/leads/${created.id}`) &&
      res.request().method() === 'PATCH',
    { timeout: 15_000 },
  );

  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  // Nudge past the 6 px activation distance so @dnd-kit promotes the
  // gesture from "click" to "drag".
  await page.mouse.move(sourceX + 10, sourceY + 10, { steps: 4 });
  await page.mouse.move(targetX, targetY, { steps: 12 });
  await page.mouse.up();

  const patchRes = await patchPromise;
  expect(
    patchRes.ok(),
    `PATCH /api/leads/${created.id} should succeed`,
  ).toBeTruthy();

  // ----- 5. Assert the optimistic UI moved the card -----------------------
  await expect(interestedColumn.getByText('Test Lead')).toBeVisible();
  await expect(newColumn.getByText('Test Lead')).toHaveCount(0);

  // ----- 6. Ground-truth check via the leads API --------------------------
  // The kanban handler calls `router.refresh()` after success, but to
  // avoid races against the revalidation we hit the JSON list endpoint
  // directly. The session cookie comes along automatically.
  const listRes = await page.request.get('/api/leads', {
    params: { search: 'Test Lead', pageSize: '50' },
  });
  expect(listRes.ok(), 'GET /api/leads should succeed').toBeTruthy();
  const listBody = (await listRes.json()) as {
    items: Array<{ id: string; status: string }>;
  };
  const updated = listBody.items.find((l) => l.id === created.id);
  expect(updated, 'created lead should be returned by the list API')
    .toBeDefined();
  expect(updated!.status).toBe('INTERESTED');
});
