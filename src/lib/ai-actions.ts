/**
 * AI Actions generation pipeline (v0.1.3 Theme 5; SPEC.md §10 extension).
 *
 * Given the latest `AIInsight` rows across the requested scopes, asks
 * Claude to produce a prioritized to-do list (HIGH / MEDIUM / LOW) for
 * the admin to action. Each item is persisted as an `AIAction` row
 * (status `'OPEN'`) and returned so the calling route can echo them
 * back to the client.
 *
 * Two surfaces share this module:
 *
 *   1. `POST /api/ai/actions` — admin-triggered "Generate now" button
 *      on the `/ai/actions` page.
 *   2. (future) The daily-digest cron may opt to call this after the
 *      four scope insights land — keep the signature stable.
 *
 * Design notes
 * ============
 *
 * **Why a new prompt rather than reusing `generateInsight`?** Insights
 * are per-scope narratives with strict shape (trend/summary/suggestion);
 * actions are a *flat list* across scopes with priority labels. The
 * inputs and outputs are different enough that sharing the prompt would
 * be more confusing than helpful. We do reuse `getClaudeClient()` so
 * SDK construction, API-key resolution, and cache_control plumbing
 * stay in one place.
 *
 * **MOCK_ANTHROPIC.** Mirrors the pattern in `src/lib/claude.ts` — the
 * route handler short-circuits to a canned 3-item list when the env
 * flag is set so Playwright / dev exercises the persistence path
 * without an SDK key. The mock lives in the route (not here) because
 * `generateAIActions` should remain a pure function of (latest
 * insights → Claude → rows); the env-flag shortcut belongs at the
 * HTTP boundary.
 *
 * **Defensive JSON parsing.** Claude is asked for a raw JSON array,
 * but the model has been seen to wrap in markdown fences and
 * occasionally prepend a sentence. `parseActionsArray` strips fences
 * and validates with Zod before persisting; on failure it throws a
 * clear `Error` so the route returns a 500 (rather than persisting
 * bogus rows).
 */

import type { AIAction, AIInsight, PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { getClaudeClient } from '@/lib/claude';
import { prisma as defaultPrisma } from '@/lib/db';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Scopes the action generator reasons about. Mirrors the `scope`
 * column on `AIAction` (a free-form `String` per the schema), but the
 * client-facing API restricts callers to these six values so we don't
 * accidentally persist typos.
 *
 * The four core scopes (`ads` / `social` / `leads` / `overall`)
 * overlap with `aiScopeEnum` from `src/lib/schemas/ai.ts`. The two
 * extras (`predictions`, `anomalies`) ship in v0.1.3 alongside the
 * new aggregations agent A is building — we accept them here so the
 * UI's filter chips line up with the eventual scope coverage even
 * before agent A's aggregators land.
 */
export const aiActionScopeEnum = z.enum([
  'ads',
  'social',
  'leads',
  'overall',
  'predictions',
  'anomalies',
]);

/** TS alias for the six scope literals. */
export type AIActionScope = z.infer<typeof aiActionScopeEnum>;

/** Priority labels. Ordered HIGH > MEDIUM > LOW for sort comparators. */
export const aiActionPriorityEnum = z.enum(['HIGH', 'MEDIUM', 'LOW']);
export type AIActionPriority = z.infer<typeof aiActionPriorityEnum>;

/**
 * Arguments to {@link generateAIActions}.
 *
 *   • `userId` — acting admin's id. Reserved for audit logging at the
 *     route layer; not consumed inside this module today, but kept on
 *     the interface so future enhancements (e.g. per-user prompt
 *     personalisation) don't have to break the call site.
 *   • `scopes` — optional whitelist of scopes whose latest insights
 *     should feed the prompt. Defaults to all six. When the database
 *     has zero matching insights, we return an empty array WITHOUT
 *     calling Claude (no point spending tokens on nothing).
 *   • `prisma` — DI for tests / transactional callers. Defaults to
 *     the production singleton.
 */
export interface GenerateAIActionsOptions {
  userId: string;
  scopes?: readonly AIActionScope[];
  prisma?: PrismaClient | Prisma.TransactionClient;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Verbatim system prompt sent to Claude (see also SPEC.md §10.4 for
 * the parent insight prompt). Marked with `cache_control: ephemeral`
 * downstream so back-to-back "Generate now" clicks pay the input-token
 * cost only once.
 */
const SYSTEM_PROMPT = `You are a chief-of-staff for Chitly, a consumer social-networking app.
Given the latest AI insights below, produce a prioritized action list.

Rules:
- Output a JSON array, no preamble. Max 8 items.
- Each item: { priority, scope, title, rationale }.
- priority: "HIGH" (do today; revenue, security, or live-fire issue),
            "MEDIUM" (this week; optimization, technical debt),
            "LOW" (when time; experiments, hardening).
- title: imperative, specific, ≤120 chars. E.g. "Pause campaign 'Friends Reels Mumbai' — CAC ₹420 (3.2× channel avg)".
- rationale: 1-3 sentences explaining the data behind the action, ≤400 chars.
- Don't manufacture actions if there's nothing to do — output fewer items rather than fluff.
- Reference specific numbers from the insights.
- English with natural Hindi/English mix is fine.`;

/** Default model. Mirrors `src/lib/claude.ts`. */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Generation cap — 8 items × ~80 tokens each + slack. */
const MAX_TOKENS = 2048;

/** Low temperature keeps prioritisation stable across runs. */
const TEMPERATURE = 0.3;

/** Hard upper bound on items (matches the prompt). */
const MAX_ITEMS = 8;

/** Hard upper bound on title length (matches the prompt). */
const MAX_TITLE = 120;

/** Hard upper bound on rationale length (matches the prompt). */
const MAX_RATIONALE = 400;

/** All six scopes in canonical order — used when caller omits `scopes`. */
const ALL_SCOPES: readonly AIActionScope[] = [
  'ads',
  'social',
  'leads',
  'overall',
  'predictions',
  'anomalies',
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Per-item shape Claude is asked to emit. Mirrors the JSDoc in the
 * function-level contract: priority + scope + title + rationale, with
 * length caps enforced so a runaway model can't blow up the
 * `AIAction.title` column on insert.
 *
 * Trim happens before length validation so trailing whitespace doesn't
 * push a borderline item over the limit.
 */
const actionItemSchema = z.object({
  priority: aiActionPriorityEnum,
  scope: aiActionScopeEnum,
  title: z
    .string()
    .trim()
    .min(1, 'title is required')
    .max(MAX_TITLE, `title must be ${MAX_TITLE} characters or fewer`),
  rationale: z
    .string()
    .trim()
    .min(1, 'rationale is required')
    .max(MAX_RATIONALE, `rationale must be ${MAX_RATIONALE} characters or fewer`),
});

/** Top-level array, capped at {@link MAX_ITEMS}. */
const actionsArraySchema = z.array(actionItemSchema).max(MAX_ITEMS);

/** Inferred payload type — what a successful parse yields. */
export type AIActionItem = z.infer<typeof actionItemSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the model name for Action List generation (v0.1.3 mixed-model
 * strategy). Lookup order:
 *
 *   1. `claude_model_actions` — admin-configured override for the action
 *      generator. Default in /settings is `claude-opus-4-7` (premium
 *      reasoning) because the action list collapses multiple insights
 *      into a prioritized to-do and benefits from depth.
 *   2. `claude_model` — repo-wide default fallback.
 *   3. {@link DEFAULT_MODEL} — last-resort hardcoded fallback.
 */
async function resolveModel(
  prisma: PrismaClient | Prisma.TransactionClient,
): Promise<string> {
  const perScope = await prisma.setting.findUnique({
    where: { key: 'claude_model_actions' },
  });
  if (perScope != null && perScope.value.length > 0) {
    return perScope.value;
  }
  const row = await prisma.setting.findUnique({
    where: { key: 'claude_model' },
  });
  if (row != null && row.value.length > 0) {
    return row.value;
  }
  return DEFAULT_MODEL;
}

/**
 * Strip a leading ```json (or ```) fence and trailing ``` if present.
 * Same idea as `parseInsightJson` in `claude.ts`, factored to a local
 * helper so we don't bend the insight parser's shape (which validates
 * an *object*, not an array).
 */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return fenceMatch != null ? fenceMatch[1].trim() : trimmed;
}

/**
 * Parse + validate Claude's response body. Throws a clear, user-safe
 * `Error` on any failure after logging the raw text for triage.
 */
function parseActionsArray(raw: string): AIActionItem[] {
  const body = stripCodeFence(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // eslint-disable-next-line no-console
    console.error('[ai-actions] non-JSON response from Claude:', raw);
    throw new Error('Claude returned non-JSON response for actions');
  }

  const validated = actionsArraySchema.safeParse(parsed);
  if (!validated.success) {
    // eslint-disable-next-line no-console
    console.error(
      '[ai-actions] response failed schema validation:',
      validated.error.issues,
      'raw:',
      raw,
    );
    throw new Error('Claude returned invalid actions array');
  }

  return validated.data;
}

/**
 * Pull the latest `AIInsight` row per scope so the prompt sees one
 * snapshot of "what the data says right now". Deduplication is done
 * in JS rather than via a clever DISTINCT-on query because Prisma's
 * SQL surface for `distinct` + `orderBy` differs across drivers and
 * the row counts here are tiny (≤ 6).
 */
async function readLatestInsightsByScope(
  prisma: PrismaClient | Prisma.TransactionClient,
  scopes: readonly AIActionScope[],
): Promise<AIInsight[]> {
  const rows = await prisma.aIInsight.findMany({
    where: { scope: { in: scopes as string[] } },
    orderBy: [{ generatedAt: 'desc' }, { id: 'asc' }],
  });

  const seen = new Set<string>();
  const out: AIInsight[] = [];
  for (const row of rows) {
    if (seen.has(row.scope)) continue;
    seen.add(row.scope);
    out.push(row);
  }
  return out;
}

/**
 * Compose the user-message payload that goes into the Claude request.
 * Kept small + structured (no kitchen-sink dump of `rawData`) so the
 * model focuses on the narrative + suggestion text that was *already*
 * curated by the per-scope insight generator.
 */
function buildUserPrompt(insights: AIInsight[]): string {
  const lines = insights.map((insight) => {
    const trendPct =
      insight.trendPct === null || insight.trendPct === undefined
        ? 'n/a'
        : `${insight.trendPct.toFixed(2)}%`;
    return [
      `Scope: ${insight.scope}`,
      `Trend: ${insight.trend} (${trendPct})`,
      `Window: ${insight.periodStart.toISOString()} → ${insight.periodEnd.toISOString()}`,
      `Summary: ${insight.summary}`,
      `Suggestion: ${insight.suggestion}`,
    ].join('\n');
  });

  return `Latest AI insights (one per scope, newest first):

${lines.join('\n\n---\n\n')}

Produce the action list now. Output a JSON array only.`;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Generate a prioritized action list and persist each item as an
 * `AIAction` row with `status='OPEN'`. Returns the freshly inserted
 * rows in the order Claude produced them.
 *
 * Behaviour:
 *
 *   1. Read the latest `AIInsight` per requested scope (default: all
 *      six). When zero insights exist, return `[]` immediately
 *      without calling Claude — there's nothing useful to ask about.
 *   2. Build a `system` (cached) + `user` prompt pair, hit Claude,
 *      defensively parse the JSON array.
 *   3. Insert each item into `AIAction` linking the corresponding
 *      `sourceInsightId` when one matches the item's scope.
 *   4. Return the newly created rows.
 *
 * Throws when Claude returns malformed JSON or when an insert fails;
 * callers should map these to a 500 via `errorResponse(...)`.
 */
export async function generateAIActions(
  opts: GenerateAIActionsOptions,
): Promise<AIAction[]> {
  const prisma = opts.prisma ?? defaultPrisma;
  const scopes = opts.scopes ?? ALL_SCOPES;

  // 1. Latest insight per requested scope.
  const insights = await readLatestInsightsByScope(prisma, scopes);
  if (insights.length === 0) {
    return [];
  }

  // 2. Claude call.
  const client = await getClaudeClient();
  const model = await resolveModel(prisma);
  const userPrompt = buildUserPrompt(insights);

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        // Same 5-minute ephemeral cache as the insight generator so
        // back-to-back "Generate now" clicks share one billed read.
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userPrompt }],
  });

  // Concatenate text blocks (Claude almost always returns a single
  // block, but the API contract allows multiple).
  const rawText = response.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> =>
      block.type === 'text',
    )
    .map((block) => block.text)
    .join('');

  if (rawText.length === 0) {
    // eslint-disable-next-line no-console
    console.error('[ai-actions] empty response content:', response);
    throw new Error('Claude returned empty response for actions');
  }

  const items = parseActionsArray(rawText);
  if (items.length === 0) {
    // Claude legitimately decided there's nothing to do; persist
    // nothing and let the caller report the empty list.
    return [];
  }

  // 3. Build a scope → insight-id map for sourceInsightId linkage.
  const insightByScope = new Map<string, string>();
  for (const insight of insights) {
    insightByScope.set(insight.scope, insight.id);
  }

  // 4. Insert each row. We persist sequentially (rather than a single
  //    createMany) so we get the created rows back including their
  //    server-generated `id` + `generatedAt`. The list is tiny (≤ 8).
  const inserted: AIAction[] = [];
  for (const item of items) {
    const created = await prisma.aIAction.create({
      data: {
        priority: item.priority,
        scope: item.scope,
        title: item.title,
        rationale: item.rationale,
        status: 'OPEN',
        sourceInsightId: insightByScope.get(item.scope) ?? null,
      },
    });
    inserted.push(created);
  }

  return inserted;
}
