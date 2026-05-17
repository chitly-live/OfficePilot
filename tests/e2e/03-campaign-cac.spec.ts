/**
 * 03-campaign-cac — "Create campaign → CAC calculation correct"
 * (SPEC §16.3 #3, §7.4; tasks.md task 93).
 *
 * Walks the marketing-module happy path end-to-end:
 *
 *   1. Sign in as the seeded admin.
 *   2. Open `/marketing/new` and submit the create form for
 *      "Meta Reels July" on Meta Ads with a ₹10,000 budget.
 *   3. Verify the redirect to `/marketing/[id]` (the new detail
 *      page) and that the campaign heading rendered.
 *   4. On the detail page, fill the metrics form with
 *      `spent = 10000` and `signups = 50`, then save.
 *   5. Reload the detail page and assert that ₹200 appears —
 *      `CAC = spent / signups = 10000 / 50 = 200` per SPEC §7.4
 *      acceptance criteria.
 *
 * The channel select defaults to META_ADS and the start-date
 * input defaults to today, so the spec only fills the fields it
 * needs to override or that are required.
 */

import { test, expect } from '@playwright/test';

import {
  cleanupTestData,
  disconnectPrisma,
  loginAsAdmin,
  seedAdmin,
} from './helpers';

test.beforeAll(async () => {
  // Make sure the canonical E2E admin row exists before any test
  // tries to log in. `seedAdmin` is idempotent, so re-running it
  // across spec files is safe.
  await seedAdmin();
});

test.beforeEach(async () => {
  // Reset every mutable table the campaigns flow can touch so the
  // CAC assertion isn't polluted by a prior test's row state. The
  // seeded admin survives because `cleanupTestData` only purges
  // non-admin users.
  await cleanupTestData();
});

test.afterAll(async () => {
  await disconnectPrisma();
});

test('Campaign CAC: create campaign → update spend + signups → CAC shows correct value', async ({
  page,
}) => {
  // 1. Sign in.
  await loginAsAdmin(page);

  // 2. Navigate to the create-campaign form.
  await page.goto('/marketing/new');
  await expect(page).toHaveURL(/\/marketing\/new$/);
  await expect(
    page.getByRole('heading', { name: /new campaign/i }),
  ).toBeVisible();

  // 3. Fill the create form.
  //    — Channel defaults to META_ADS (matches the task spec).
  //    — Start date defaults to today (`todayLocalIso` in the
  //      create form).
  //    — Status defaults to DRAFT, owner defaults to the current
  //      user; both are valid for our assertion.
  await page.getByLabel('Campaign name').fill('Meta Reels July');
  await page.getByLabel('Budget (₹)').fill('10000');

  // 4. Submit and wait for the redirect to `/marketing/[id]`.
  await page.getByRole('button', { name: /create campaign/i }).click();

  // CUIDs are 25 characters: `c` + 24 lowercase alphanumerics.
  // Match that pattern explicitly so we don't accidentally pass
  // when the URL is still `/marketing/new` or `/marketing/utm`.
  await expect(page).toHaveURL(/\/marketing\/c[a-z0-9]{20,}$/, {
    timeout: 15_000,
  });
  await expect(
    page.getByRole('heading', { name: /Meta Reels July/i }),
  ).toBeVisible();

  // 5. Update spent + signups via the metrics form on the detail
  //    page. The edit form initialises both inputs to "0" — fill()
  //    replaces the value so we don't end up appending text.
  await page.getByLabel('Spent (₹)').fill('10000');
  await page.getByLabel('Signups').fill('50');

  await page.getByRole('button', { name: /save changes/i }).click();

  // Wait for the success toast so we know the PATCH committed
  // before we trigger a reload — otherwise a fast reload can race
  // the in-flight request and read the pre-update row.
  await expect(page.getByText(/campaign updated/i)).toBeVisible({
    timeout: 10_000,
  });

  // 6. Reload and assert CAC = ₹200 is rendered somewhere on the
  //    page. Per SPEC §7.4: spend ₹10,000 with 50 signups → CAC
  //    shows ₹200. The detail page formats currency as
  //    `₹<en-IN>` — e.g. `₹200`, `₹200.00` — so we accept either
  //    form. The negative lookahead `(?!\d)` prevents matching
  //    `₹2000` or similar.
  await page.reload();
  await expect(
    page.getByText(/₹\s*200(?:\.00)?(?!\d)/).first(),
  ).toBeVisible({ timeout: 10_000 });
});
