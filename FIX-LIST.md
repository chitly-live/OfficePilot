# OfficePilot — Post-Review Fix List (v0.1.0 → v0.1.1)

**Builder:** Kiro IDE
**Reviewer:** Lal Singh (via Claude review at `docs/REVIEW-REPORT.md`)
**Source spec:** `SPEC.md` (unchanged — this file ADDS work, does not modify scope)
**Tracker:** `.kiro/specs/officepilot/tasks.md` — add new tasks 104–110 below

---

## 0. Context (read before starting)

The independent review at `docs/REVIEW-REPORT.md` flagged **3 medium + 1 cosmetic** gap. These are NOT bugs in the existing code — they are completeness gaps in the test coverage. Fix them without touching production code paths (except the one mock-injection helper in §2 below).

**Hard rules:**
- Do NOT modify any production route handler, page, schema, or business logic.
- Do NOT add new features. This is a test/coverage completion pass only.
- Existing 442 tests must remain green after these fixes.
- All new tests must pass before declaring done.

---

## 1. [Task 104] Flip Task 34 checkbox in tasks.md

**Severity:** 🟢 Cosmetic
**Effort:** 30 seconds

`.kiro/specs/officepilot/tasks.md` has task 34 (leads webhook) marked `[ ]` even though the route, schema, HMAC verification, and 16 integration tests are all in the repo and green (per HANDOFF.md §6.1).

**Action:** Find task 34's line in `.kiro/specs/officepilot/tasks.md` and change `[ ]` → `[x]`. No other changes to that file.

**Acceptance:** Re-running task-count math gives `34 ✕ [x]` (not 33).

---

## 2. [Task 105] Add deterministic Anthropic mock for E2E

**Severity:** 🟡 Medium
**Effort:** ~1 hour
**Spec ref:** SPEC.md §16.3 #6 (AI generate flow)
**Background:** Currently `tests/e2e/06-ai-insight.spec.ts` skips the real `/api/ai/generate` route because Playwright can't intercept server-side fetch (HANDOFF.md §6.3). We will add a tiny test-only shim in `src/lib/claude.ts` that returns a canned response when `MOCK_ANTHROPIC=1`, then rewrite the E2E to call the real route.

### 2.1 Modify `src/lib/claude.ts`

Add a guard at the **top of `getClaudeClient()`** (or wherever the SDK instance is constructed):

```ts
if (process.env.MOCK_ANTHROPIC === '1') {
  return MOCK_CLAUDE_CLIENT;
}
```

Define `MOCK_CLAUDE_CLIENT` as an object that satisfies the **minimum** shape used by `generateInsight()` — i.e. a `messages.create()` method that returns a deterministic, schema-valid response:

```ts
const MOCK_CLAUDE_CLIENT = {
  messages: {
    create: async () => ({
      id: 'msg_mock_e2e',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6-mock',
      content: [{
        type: 'text',
        text: JSON.stringify({
          trend: 'up',                   // local trend will override this anyway
          trendPct: 0,                    // local trendPct will override
          summary: 'Mocked insight for E2E run. Spend up 25% vs last week.',
          suggestion: 'Mock suggestion — double down on top-performing creative; pause bottom-quartile ad sets.'
        })
      }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 }
    })
  }
};
```

**Important:** The mock MUST satisfy the same Zod schema (`insightSchema`) that `parseInsightJson()` validates against — summary ≤ 200 chars, suggestion ≤ 400 chars, trend ∈ {"up","down","flat"}, trendPct number.

**Do not** import Anthropic types here in a way that breaks tree-shaking in production — just satisfy the minimum duck-typed shape.

Add a JSDoc block above the mock explaining: "MOCK_ANTHROPIC=1 is set only by Playwright config; never leak into prod. See FIX-LIST §2."

### 2.2 Set the env var in Playwright

In `playwright.config.ts` `webServer.env`, add:
```ts
env: {
  ...process.env,
  MOCK_ANTHROPIC: '1',
  // Any other E2E-only vars (e.g. a test DATABASE_URL if you have one)
}
```

If the `env` field doesn't exist on `webServer`, add it. Document with an inline comment pointing back to FIX-LIST §2.

### 2.3 Rewrite `tests/e2e/06-ai-insight.spec.ts`

Replace the Prisma pre-seed approach with a real route call:

```
Flow:
  1. cleanupTestData() — remove any AIInsight rows from prior runs
  2. login as admin
  3. navigate to /ai
  4. click "Generate now" button (scope=overall, or use the first available scope)
  5. wait for the new insight card to appear (max 15s; mock is fast so usually <2s)
  6. assert: card shows the mock's summary text ("Mocked insight for E2E run...")
  7. click "View details" or navigate to /ai/[id]
  8. assert: detail page shows the mock's suggestion text
  9. assert: an ActivityLog row of action `ai.insight_generated` exists for the test admin
```

Remove the block-comment at top of the file that explains the pre-seed shortcut. Replace it with a 4-line comment explaining the new `MOCK_ANTHROPIC=1` flow.

### 2.4 Acceptance

- `MOCK_ANTHROPIC=1 npm run dev` — opening `/ai` and clicking "Generate now" creates an insight without a network call to Anthropic (verify by disconnecting network or using an invalid `ANTHROPIC_API_KEY`).
- `npx playwright test tests/e2e/06-ai-insight.spec.ts` — passes in ≤ 15 s.
- Without `MOCK_ANTHROPIC`, production behaviour unchanged (verify by `unset MOCK_ANTHROPIC && npm run test:int` — all 242 integration tests still green; they mock the SDK at module level, not env level).

---

## 3. [Task 106] Add Kanban drag-and-drop E2E

**Severity:** 🟡 Medium
**Effort:** ~45 min
**Spec ref:** SPEC.md §9.4 ("Drag task from TODO → DOING → DB updated, updatedAt changes")

Current `tests/e2e/04-dev-kanban.spec.ts` tests status transition via the detail-page select. Add ONE additional test (in the same file) that exercises actual `@dnd-kit` drag:

```
test('drag dev task across kanban columns (desktop)', async ({ page }) => {
  // 1. Login + create a task via API (faster than UI)
  // 2. Navigate to /dev (kanban view)
  // 3. Locate the card by its visible title text
  // 4. Locate the DOING column drop target
  // 5. Use page.dragAndDrop() OR a manual mouse.move/down/up sequence
  //    NOTE: @dnd-kit needs a small intermediate move to trigger the
  //    activationConstraint (5px / 250ms default). If a direct dragTo()
  //    fails, fall back to:
  //      await source.hover();
  //      await page.mouse.down();
  //      await target.hover({ position: { x: 10, y: 10 } });
  //      await page.mouse.move(targetX, targetY + 20, { steps: 5 });
  //      await page.mouse.up();
  // 6. Assert the card now visually sits in DOING column
  // 7. Assert DB row: task.status === 'DOING', updatedAt > createdAt
});
```

Add the SAME pattern in `tests/e2e/02-lead-pipeline.spec.ts` for the Leads kanban (NEW → CONTACTED). Keep each test under 30 s.

**If `@dnd-kit` drag is flaky in headless Chromium**, document the issue at the top of the file, switch to keyboard fallback (`@dnd-kit` supports `Tab` → focus card → `Space` → arrow keys → `Space` to drop), and use that. Either path is acceptable as long as it exercises the actual kanban DOM, not just the underlying PATCH.

**Acceptance:**
- New tests pass in `npx playwright test --grep "drag"`.
- Existing 9 tests still pass (now 11 total E2E).

---

## 4. [Task 107] Mobile viewport Playwright project (375 px)

**Severity:** 🟡 Medium
**Effort:** ~30 min
**Spec ref:** SPEC.md §13.2 mobile responsive

Add a second Playwright project to `playwright.config.ts`:

```ts
projects: [
  {
    name: 'chromium',
    use: { ...devices['Desktop Chrome'] },
  },
  {
    name: 'mobile-chrome',
    use: { ...devices['Pixel 5'] },   // 393×851 — close enough to the 375px breakpoint
    testMatch: ['**/00-smoke.spec.ts', '**/01-login-dashboard.spec.ts', '**/mobile-*.spec.ts'],
  },
],
```

This way the desktop run covers the full 9 specs; the mobile run only runs the smoke + login + any spec named `mobile-*`.

Add ONE new spec: `tests/e2e/mobile-kanban.spec.ts` that:
1. Logs in (admin)
2. Navigates to `/dev`
3. Asserts kanban renders **one column at a time** at the mobile viewport (the SPEC §12.3 acceptance — verify by counting visible column headers or testing horizontal scroll)
4. Logs out

Use `test.describe.configure({ mode: 'serial' })` if needed.

**Acceptance:**
- `npx playwright test --project=mobile-chrome` runs 3 tests, all pass.
- `npx playwright test --project=chromium` runs the full 11 tests (after §3), all pass.
- Combined `npx playwright test` runs both projects, total = 14 tests, all green.

---

## 5. [Task 108] Update HANDOFF.md to reflect v0.1.1 closures

After tasks 104–107 are done, update `docs/HANDOFF.md`:

1. **§5 deviations section** — Remove items 1 (Task 34 checkbox) and 3 (AI E2E shortcut). Update item 2 (mobile Kanban) to note the new mobile-chrome project. Keep item 4 (claude-haiku-4-5 unused — still applies).
2. **§3 test summary table** — Bump Playwright count from 9/7 to 14/8 (after adding kanban drag tests + mobile-kanban spec).
3. **§2 DoD table** — Update row 10 (mobile QA) proof: "now also exercised by `mobile-chrome` Playwright project, `mobile-kanban.spec.ts`".
4. **Add §10 "v0.1.1 changes"** at the end:
   ```
   ## 10. v0.1.1 — Post-review fix pass (2026-05-XX)
   - Task 104: tasks.md task 34 checkbox flipped.
   - Task 105: MOCK_ANTHROPIC env shim added to src/lib/claude.ts; AI E2E now invokes real /api/ai/generate route end-to-end.
   - Task 106: kanban drag-drop E2E added for dev tasks + leads pipeline.
   - Task 107: mobile-chrome Playwright project + mobile-kanban.spec.ts at 393×851.
   - All 14 Playwright tests pass on chromium + mobile-chrome projects.
   ```

---

## 6. [Task 109] Update REVIEW-REPORT.md status

Re-run the 6 reproduction commands in `docs/HANDOFF.md` §9 (`npx tsc`, `npx next lint`, `npm run test`, `npm run test:int`, `npx playwright test --list`, `npx next build`). Confirm all 6 still exit 0 with new test counts.

In `docs/REVIEW-REPORT.md` §3.1, §3.2, §3.3 — add a one-line "✅ Closed in v0.1.1 by Task 105 / 106 / 107" note. Do NOT remove the medium-severity entries; mark them resolved instead so the history is preserved.

---

## 7. [Task 110] Verification pass

Before declaring done, run:

```powershell
npx tsc --noEmit                          # must exit 0
npx next lint                             # must exit 0
npm run test                              # must report 200 unit / 0 failed (unchanged)
npm run test:int                          # must report 242 integration / 0 failed (unchanged)
npx playwright test --list                # must list ~14 tests across 8 files
npx playwright test --project=chromium    # must pass
npx playwright test --project=mobile-chrome  # must pass
npx next build                            # must exit 0
```

If any command fails, fix the underlying issue — do not skip or `--no-verify`. Do not modify scope: if a fix would require changes outside the FIX-LIST.md scope, STOP and surface the issue for the reviewer.

---

## 8. What this fix list does NOT touch

To stay safe:

- **No schema changes.** Prisma is locked.
- **No production route changes** except adding the `MOCK_ANTHROPIC` env guard at the top of `getClaudeClient()`.
- **No new UI features.** Buttons, forms, pages all stay as-is.
- **No SPEC.md edits.** This is an additive fix list, not a respec.
- **No package additions** unless absolutely required (and only `devDependencies`).

---

## 9. Definition of Done (for this fix list)

- [ ] Task 34 checkbox flipped in `.kiro/specs/officepilot/tasks.md`
- [ ] `MOCK_ANTHROPIC=1` short-circuit added to `src/lib/claude.ts`
- [ ] Playwright `webServer.env.MOCK_ANTHROPIC = '1'` set
- [ ] `tests/e2e/06-ai-insight.spec.ts` rewritten to call real `/api/ai/generate`
- [ ] Kanban drag-drop tests added in `02-lead-pipeline.spec.ts` and `04-dev-kanban.spec.ts`
- [ ] `mobile-chrome` Playwright project added with Pixel 5 emulation
- [ ] `tests/e2e/mobile-kanban.spec.ts` created
- [ ] `HANDOFF.md` updated (§5, §3, §2, new §10)
- [ ] `REVIEW-REPORT.md` updated (§3.1–§3.3 marked closed)
- [ ] All 8 verification commands (§7) exit 0 with updated counts
- [ ] No production code touched outside the single `MOCK_ANTHROPIC` guard

After all checkboxes green, this fix list is complete and v0.1.1 is ready for the same reviewer pass (operator must still run the manual smoke checklist + real Anthropic key test per REVIEW-REPORT §6.2/§6.4).

---

*End of FIX-LIST.md*
