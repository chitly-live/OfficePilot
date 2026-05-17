/**
 * Smoke spec — verifies the Playwright harness itself (task 90).
 *
 * Runs first (filename `00-…`) so a broken dev server / config blows
 * up here instead of inside one of the six critical-flow specs from
 * tasks 91–96. Intentionally tiny: just walks the unauthenticated
 * `/` → `/login` redirect that `src/app/page.tsx` performs.
 */

import { test, expect } from '@playwright/test';

test('smoke: home redirects to login', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});
