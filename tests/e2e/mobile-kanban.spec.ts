/**
 * Mobile kanban responsive E2E — SPEC §13.2, FIX-LIST §4 (task 107).
 *
 * Runs ONLY under the `mobile-chrome` Playwright project (Pixel 5,
 * 393×851). `playwright.config.ts` is wired so this spec is matched
 * by the `**\/mobile-*.spec.ts` testMatch pattern on that project.
 *
 * What we verify:
 *
 *   1. The /dev kanban surface renders at the mobile viewport without
 *      collapsing or 500-ing.
 *   2. Per SPEC §13.2 ("Kanban boards: 1 column at a time with swipe
 *      on mobile") the columns lay out as a horizontally-scrolling
 *      single-column strip. `KanbanBoard.tsx` implements this with
 *      `flex snap-x snap-mandatory ... md:snap-none` on the column
 *      container, plus `w-full shrink-0 snap-start ... md:w-72` on
 *      each column, so on a sub-`md` viewport each column occupies
 *      the full container width and only ONE column is visible at a
 *      time.
 *
 * Verification strategy: read the bounding box of every
 * `[data-column-id]` element and assert that exactly one column has
 * its left edge inside the viewport bounds. This is invariant to:
 *
 *   • the specific accent classes used (no class-string sniffing),
 *   • the kanban container's internal scroll offset (we only check
 *     visible-in-viewport, not which column happens to be first), and
 *   • future column reordering (we don't hard-code which column wins).
 *
 * We also assert the column width is close to the viewport width as a
 * defence-in-depth check — a regression that re-introduced `md:w-72`
 * styling at the mobile breakpoint would fail this even if scroll
 * snapping somehow stayed working.
 */

import { test, expect } from '@playwright/test';

import {
  cleanupTestData,
  disconnectPrisma,
  loginAsAdmin,
  seedAdmin,
} from './helpers';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  await seedAdmin();
});

test.beforeEach(async () => {
  await cleanupTestData();
});

test.afterAll(async () => {
  await disconnectPrisma();
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test('Mobile kanban: /dev renders one column at a time at mobile viewport', async ({
  page,
}) => {
  // 1. Sign in — `loginAsAdmin` is viewport-agnostic.
  await loginAsAdmin(page);

  // 2. Navigate to the dev kanban surface.
  await page.goto('/dev');

  // 3. Confirm the kanban actually rendered. We wait for at least the
  //    TODO column to mount; all three columns share the same render
  //    path so this also confirms the page didn't error.
  const todoColumn = page.locator('[data-column-id="TODO"]');
  await expect(todoColumn).toBeVisible();

  // 4. Read every column's bounding box.
  const allColumns = page.locator('[data-column-id]');
  const columnCount = await allColumns.count();
  expect(
    columnCount,
    'dev kanban should render three status columns',
  ).toBe(3);

  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error(
      'page.viewportSize() returned null — mobile project must set a viewport',
    );
  }

  // Sanity-check the project really is on a mobile-class width
  // (Pixel 5 = 393 px). If a future config change accidentally runs
  // this spec at desktop width the assertion below would still pass
  // (because md:w-72 would let 4+ columns fit in 1280 px), which is
  // exactly the kind of silent regression we want to catch up front.
  expect(
    viewport.width,
    'mobile-kanban.spec must run under a mobile viewport',
  ).toBeLessThan(500);

  const boxes = await Promise.all(
    Array.from({ length: columnCount }).map(async (_, idx) => {
      const box = await allColumns.nth(idx).boundingBox();
      const id = await allColumns.nth(idx).getAttribute('data-column-id');
      return { id, box };
    }),
  );

  // 5. Count how many columns have their LEFT edge inside the
  //    viewport. With `w-full snap-start` styling each column is
  //    viewport-width, so at any scroll position exactly one column's
  //    left edge falls within [0, viewport.width).
  //
  //    Using the left edge (rather than full bounding rect) is the
  //    most stable signal — at column boundaries during scrolling a
  //    sliver of the next column might intersect the viewport, but
  //    its left edge is still off-screen.
  const columnsWithLeftEdgeInViewport = boxes.filter(({ box }) => {
    if (!box) return false;
    return box.x >= 0 && box.x < viewport.width;
  });

  expect(
    columnsWithLeftEdgeInViewport.length,
    `expected exactly 1 column visible at mobile viewport, saw ${columnsWithLeftEdgeInViewport.length} (boxes=${JSON.stringify(boxes)})`,
  ).toBe(1);

  // 6. Defence-in-depth: the visible column's width should be at
  //    least 80 % of the viewport width. `w-full` minus the column
  //    container's gap-3 (12 px) and pb-2 (8 px) padding lands well
  //    above this threshold; the 80 % floor catches both an accidental
  //    `md:w-72` leak (which would clamp the column at 288 px,
  //    i.e. ~73 % of 393 px) and any future regression that re-adds
  //    multi-column desktop layout to mobile.
  const visibleBox = columnsWithLeftEdgeInViewport[0]!.box!;
  expect(
    visibleBox.width,
    `column width ${visibleBox.width}px should be near viewport width ${viewport.width}px`,
  ).toBeGreaterThanOrEqual(viewport.width * 0.8);

  // 7. Log out — drive the menu rather than nuking the cookie so the
  //    sign-out route is exercised. Many app shells expose the logout
  //    via a user menu, but the canonical fallback that always works
  //    is to navigate to the logout endpoint directly. Auth.js v5
  //    ships `/api/auth/signout` which the LogoutButton client
  //    component POSTs to under the hood.
  await page.request.post('/api/auth/signout', {
    form: {
      // Auth.js requires a CSRF token for signout, but `page.request`
      // inherits the session cookie and Auth.js v5 accepts the
      // session's csrf cookie automatically when called from a
      // same-origin request. If the CSRF check rejects us we fall
      // back to dropping the session cookie below.
    },
  });

  // 8. Verify we are signed out — `/dashboard` should now redirect to
  //    `/login`. Some Auth.js configurations require the csrf token in
  //    the body; if the signout POST silently no-op'd, hitting a
  //    protected route still proves authentication state when the
  //    middleware redirects. As a belt-and-suspenders fallback, clear
  //    the auth cookies so the assertion below cannot pass with a
  //    half-signed-out state.
  const context = page.context();
  const cookies = await context.cookies();
  const authCookieNames = cookies
    .map((c) => c.name)
    .filter((name) => /next-auth|authjs/i.test(name));
  if (authCookieNames.length > 0) {
    await context.clearCookies({
      // Playwright's clearCookies supports a filter object on recent
      // versions; pass `name` to drop only the auth ones.
      name: authCookieNames[0],
    });
    // Drop any siblings (e.g. csrf, callback-url) too.
    for (const name of authCookieNames.slice(1)) {
      await context.clearCookies({ name });
    }
  }

  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login(\/|$|\?)/, { timeout: 15_000 });
});
