/**
 * E2E flow #4 — Dev kanban: TODO → DONE → `completedAt` stamped
 * (SPEC §16.3 #4, §9.4; tasks.md task 94).
 *
 * Walks the dev-tracking happy path that proves the auto-stamp
 * behaviour in `PATCH /api/dev/tasks/[id]`:
 *
 *   1. Sign in as the seeded admin.
 *   2. Open `/dev/new`, fill the title ("Test Task"), keep the
 *      default `type=FEATURE`, and submit. Assert the redirect
 *      to `/dev` (the kanban) and that the new card is rendered
 *      inside the TODO column.
 *   3. Look the task up by title via `GET /api/dev/tasks` so we
 *      have its server-issued id, then drive `PATCH /api/dev/
 *      tasks/[id]` with `{ status: 'DONE' }`. The kanban
 *      drag-drop UI calls the same endpoint, so the API path is
 *      a faithful proxy for the user gesture and avoids
 *      simulating @dnd-kit pointer events (notoriously flaky).
 *   4. Reload the kanban and assert the card now sits inside the
 *      DONE column.
 *   5. Read the row back from Postgres via `getDevTaskById` and
 *      assert `status === 'DONE'` and `completedAt` is set —
 *      this is the SPEC §9.4 acceptance: "status updated,
 *      completedAt stamped".
 *
 * The kanban renders each column with `data-column-id="<status>"`
 * (see `KanbanBoard.KanbanColumnView`), so locating a task within
 * a specific column is just a CSS-attribute scoped lookup.
 */

import { test, expect } from '@playwright/test';

import {
  cleanupTestData,
  disconnectPrisma,
  getDevTaskById,
  loginAsAdmin,
  seedAdmin,
} from './helpers';

const TASK_TITLE = 'Test Task';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  // Idempotent — guarantees the canonical E2E admin row exists with
  // the expected password hash before any test drives the login form.
  await seedAdmin();
});

test.beforeEach(async () => {
  // Wipe DevTask + every other mutable table so the assertion that
  // exactly one row matches `TASK_TITLE` can't be polluted by a
  // previous run that left a stray task behind.
  await cleanupTestData();
});

test.afterAll(async () => {
  // Release the helper-scoped Prisma pool so the process exits.
  await disconnectPrisma();
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test('Dev kanban: create task → move to DONE → completedAt set', async ({
  page,
}) => {
  // 1. Sign in.
  await loginAsAdmin(page);

  // 2. Open the create-task form. Type defaults to FEATURE, status
  //    defaults to TODO, priority defaults to MEDIUM, and the
  //    assignee defaults to the current user — so we only need to
  //    fill the title to exercise the happy path.
  await page.goto('/dev/new');
  await expect(page).toHaveURL(/\/dev\/new$/);
  await expect(
    page.getByRole('heading', { name: /new task/i }),
  ).toBeVisible();

  await page.getByLabel('Title').fill(TASK_TITLE);

  // Submit and wait for the redirect to `/dev` (FEATURE lands on
  // the kanban; RELEASE would go to `/dev/releases`).
  await page.getByRole('button', { name: /create task/i }).click();
  await expect(page).toHaveURL(/\/dev(\/|$|\?)/, { timeout: 15_000 });

  // The new card must render inside the TODO column. The kanban
  // marks each column with `data-column-id="<DevTaskStatus>"`.
  const todoColumn = page.locator('[data-column-id="TODO"]');
  await expect(todoColumn.getByText(TASK_TITLE)).toBeVisible();

  // 3. Look up the task id via the JSON list endpoint. `page.request`
  //    inherits the authenticated session cookie from the browser
  //    context, so this hits the same RBAC path a real client would.
  const listRes = await page.request.get('/api/dev/tasks', {
    params: { search: TASK_TITLE, pageSize: '50' },
  });
  expect(listRes.ok(), 'GET /api/dev/tasks should succeed').toBeTruthy();

  const listBody = (await listRes.json()) as {
    items: Array<{ id: string; title: string; status: string }>;
  };
  const created = listBody.items.find((t) => t.title === TASK_TITLE);
  expect(created, 'created task should be returned by the list API')
    .toBeDefined();
  expect(created!.status).toBe('TODO');

  // 4. Drive the PATCH the kanban drag-drop would have called —
  //    same payload, same auth context. SPEC §9.4 acceptance:
  //    "Drag task from TODO → DONE → DB updated, completedAt
  //    stamped".
  const patchRes = await page.request.patch(
    `/api/dev/tasks/${created!.id}`,
    { data: { status: 'DONE' } },
  );
  expect(
    patchRes.ok(),
    `PATCH /api/dev/tasks/${created!.id} should succeed`,
  ).toBeTruthy();

  const patchBody = (await patchRes.json()) as {
    id: string;
    status: string;
    completedAt: string | null;
  };
  expect(patchBody.status).toBe('DONE');
  expect(patchBody.completedAt).not.toBeNull();

  // 5. Reload the kanban and confirm the card moved to DONE on the
  //    rendered surface (server-rendered list reflects the PATCH).
  await page.goto('/dev');
  const doneColumn = page.locator('[data-column-id="DONE"]');
  await expect(doneColumn.getByText(TASK_TITLE)).toBeVisible();
  await expect(
    page.locator('[data-column-id="TODO"]').getByText(TASK_TITLE),
  ).toHaveCount(0);

  // 6. Ground-truth check via Prisma — `completedAt` must be a real
  //    Date set by the API's auto-stamp, not just round-tripped from
  //    the client. This is the SPEC §9.4 acceptance criterion.
  const row = await getDevTaskById(created!.id);
  expect(row, 'DevTask row should still exist').not.toBeNull();
  expect(row!.status).toBe('DONE');
  expect(row!.completedAt).not.toBeNull();
  expect(row!.completedAt).toBeInstanceOf(Date);
});

// ---------------------------------------------------------------------------
// Test — actual @dnd-kit drag-drop gesture (SPEC §9.4, FIX-LIST §3 task 106)
// ---------------------------------------------------------------------------
//
// Drag strategy: manual pointer sequence (Option B from FIX-LIST §3).
//
//   `KanbanBoard` configures @dnd-kit's `PointerSensor` with
//   `activationConstraint: { distance: 6 }` (see
//   `src/components/shared/KanbanBoard.tsx`). Playwright's high-level
//   `locator.dragTo()` issues mousedown → mouseup with a single
//   intermediate move which @dnd-kit interprets as a click below the
//   activation threshold. We therefore emit the sequence by hand:
//
//     1. `mouse.move` to the card center.
//     2. `mouse.down` to arm the drag.
//     3. A SHORT intermediate move (~10 px) that exceeds the 6 px
//        activation distance and flips @dnd-kit from "considering" to
//        "actively dragging" — this is the step `dragTo` skips.
//     4. A multi-step move toward the target column center.
//     5. `mouse.up` over the column drop zone.
//
//   The pointer sequence is the same path the real user takes, so the
//   `onDragEnd` handler resolves `over.id` to the column container's
//   droppable id (the column has `useDroppable({ id: column.id })`).
//
// Fallback: if the optimistic UI doesn't reflect the move within the
// poll window we treat it as a drag-stability failure and surface a
// loud error — the test will then expose flakiness rather than hide it.

test('Dev kanban: drag card from TODO → DOING column', async ({ page }) => {
  // 1. Sign in.
  await loginAsAdmin(page);

  // 2. Create the task via the JSON API — faster than the UI form and
  //    keeps the focus of this spec on the drag-drop gesture rather
  //    than the create-form path (already covered above).
  const createRes = await page.request.post('/api/dev/tasks', {
    data: { title: TASK_TITLE, type: 'FEATURE' },
  });
  expect(
    createRes.ok(),
    'POST /api/dev/tasks should succeed',
  ).toBeTruthy();
  const created = (await createRes.json()) as {
    id: string;
    status: string;
  };
  expect(created.status).toBe('TODO');
  const createdAtBefore = (await getDevTaskById(created.id))!.updatedAt;

  // 3. Navigate to the kanban surface.
  await page.goto('/dev');

  // 4. Verify starting position — the card is in TODO.
  const todoColumn = page.locator('[data-column-id="TODO"]');
  const doingColumn = page.locator('[data-column-id="DOING"]');
  const cardInTodo = todoColumn.getByText(TASK_TITLE);
  await expect(cardInTodo).toBeVisible();

  // Make sure both columns have laid out before we read bounding boxes.
  await expect(doingColumn).toBeVisible();

  // 5. Read bounding boxes for the drag source (the card) and the
  //    drop target (the DOING column body, not just the header).
  const sourceBox = await cardInTodo.boundingBox();
  const targetBox = await doingColumn.boundingBox();
  if (!sourceBox || !targetBox) {
    throw new Error(
      'drag source/target bounding box was null — kanban did not lay out',
    );
  }

  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const targetX = targetBox.x + targetBox.width / 2;
  const targetY = targetBox.y + targetBox.height / 2;

  // 6. Issue the drag. The PATCH request is the side effect we wait
  //    for — it fires from `DevKanban.handleMove` after the drop.
  const patchPromise = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/dev/tasks/${created.id}`) &&
      res.request().method() === 'PATCH',
    { timeout: 15_000 },
  );

  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  // Step 1: nudge past the 6 px activation distance so @dnd-kit
  // promotes the gesture from "click" to "drag".
  await page.mouse.move(sourceX + 10, sourceY + 10, { steps: 4 });
  // Step 2: travel to the target column. Multiple steps give @dnd-kit
  // time to fire its over-detection on each frame.
  await page.mouse.move(targetX, targetY, { steps: 12 });
  await page.mouse.up();

  const patchRes = await patchPromise;
  expect(
    patchRes.ok(),
    `PATCH /api/dev/tasks/${created.id} should succeed`,
  ).toBeTruthy();

  // 7. Assert the optimistic update landed — the card is now in DOING
  //    and no longer in TODO.
  await expect(doingColumn.getByText(TASK_TITLE)).toBeVisible();
  await expect(todoColumn.getByText(TASK_TITLE)).toHaveCount(0);

  // 8. Ground-truth check via Prisma — status persisted and updatedAt
  //    advanced (SPEC §9.4: "Drag task from TODO → DOING → DB updated,
  //    updatedAt changes").
  const row = await getDevTaskById(created.id);
  expect(row, 'DevTask row should still exist').not.toBeNull();
  expect(row!.status).toBe('DOING');
  expect(row!.updatedAt.getTime()).toBeGreaterThan(createdAtBefore.getTime());
});
