/**
 * Anthropic Claude SDK wrapper for the AI Analysis module (SPEC.md §10).
 *
 * This file is the single point of contact between OfficePilot and the
 * `@anthropic-ai/sdk`. Route handlers (`/api/ai/generate`, `/api/cron/daily-digest`)
 * and any future AI features import {@link generateInsight} from here so that
 * SDK construction, API-key resolution, prompt templating, response parsing,
 * and token accounting are all kept in one well-tested place.
 *
 * ## Design notes
 *
 * ### 1. API-key precedence: env var first, encrypted Setting second
 *
 * Operators have two ways to configure the Claude API key:
 *
 *   1. `ANTHROPIC_API_KEY` environment variable (preferred for VPS / CI —
 *      see `.env.example`).
 *   2. `Setting('anthropic_api_key')` row in Postgres, encrypted at rest
 *      with AES-256-GCM (see {@link decrypt} from `@/lib/crypto` and
 *      SPEC.md §12.2). Configured by admins via `/settings`.
 *
 * The env var wins when both are present. This keeps deploys hermetic
 * (the key lives in the deploy environment, not the database) while still
 * allowing first-time setup or rotation without a restart through the UI.
 *
 * If neither is configured, {@link resolveApiKey} throws a single,
 * actionable `Error` so the caller can surface a clean message in the
 * route handler instead of leaking SDK internals to the client.
 *
 * ### 2. Lazy, cached SDK client
 *
 * {@link getClaudeClient} constructs an `Anthropic` instance the first time
 * it is called and caches it at module scope. Constructing the SDK is cheap
 * but the cache is still a meaningful win for the daily-digest cron, which
 * fires {@link generateInsight} four times back-to-back (one per scope).
 *
 * The cache is keyed on the *resolved* API key, so rotating the key in
 * Settings or env causes a new client to be built on the next call. Tests
 * mock the SDK with `vi.mock('@anthropic-ai/sdk')`; the lazy import +
 * `new Anthropic(...)` pattern plays nicely with that.
 *
 * ### 3. Prompt caching strategy
 *
 * Per SPEC.md §10.4, the daily digest generates four insights (ads, social,
 * leads, overall) in sequence. The system prompt is identical across all
 * four calls, so we mark the system content block with
 * `cache_control: { type: 'ephemeral' }` (Anthropic's 5-minute TTL cache)
 * to drop input-token cost on calls 2–4. The user prompt — which embeds
 * the per-scope metrics JSON — is *not* cached because it changes every
 * time and would never hit.
 *
 * ### 4. Defensive JSON parsing
 *
 * Claude is instructed (via the system prompt) to "Analyze and respond
 * with JSON only", but in practice the model occasionally wraps its reply
 * in a Markdown fence (```json ... ```). {@link parseInsightJson} strips
 * such fences before calling `JSON.parse`, then validates the result
 * against {@link insightSchema} (Zod) so downstream code can trust the
 * shape and length constraints (summary ≤ 200, suggestion ≤ 400).
 *
 * Any parse / validation failure is converted to a clear `Error` with the
 * raw text logged at `console.error` for incident triage. We do *not*
 * include the raw text in the thrown message because it can be quite long
 * and often contains user-supplied metric data.
 *
 * ### 5. Token tracking
 *
 * The wrapper exposes a single `tokenUsage` integer that is the sum of
 * `usage.input_tokens + usage.output_tokens`. Anthropic's `Usage` shape
 * marks `input_tokens` as nullable (it is `null` when the request is
 * billed entirely from cache), so we coalesce missing/null fields to 0.
 * Cache-read tokens are deliberately excluded — they are billed at a
 * fraction of the input rate and the goal here is a conservative
 * "what would this cost without caching?" estimate for the admin
 * settings page (SPEC.md §10.7). If a future change needs cache-aware
 * billing, expand this in one place.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { decrypt } from '@/lib/crypto';
import { prisma } from '@/lib/db';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The scopes the AI Analysis module reasons about. Mirrors the
 * `aiScopeEnum` in `@/lib/schemas/ai` and the values stored in
 * `AIInsight.scope` (see SPEC.md §10.1). `predictions` and `anomalies`
 * were added in v0.1.3 (Theme 5).
 */
export type InsightScope =
  | 'ads'
  | 'social'
  | 'leads'
  | 'overall'
  | 'predictions'
  | 'anomalies';

/** Direction of week-over-week change. Flat = |trendPct| < 5 (per SPEC.md §10.4). */
export type InsightTrend = 'up' | 'down' | 'flat';

/**
 * Inputs to {@link generateInsight}. The `metrics` payload is treated as
 * opaque JSON — it is `JSON.stringify`'d straight into the user prompt,
 * so callers (the metrics aggregator in `src/lib/metrics.ts`) own its shape.
 */
export interface GenerateInsightInput {
  scope: InsightScope;
  periodStart: Date;
  periodEnd: Date;
  metrics: unknown;
}

/**
 * Successful return shape. Matches the columns persisted to `AIInsight`
 * by the route handler (task 66). All length/range constraints are
 * enforced by {@link insightSchema}; callers can trust the bounds.
 */
export interface GenerateInsightResult {
  trend: InsightTrend;
  trendPct: number | null;
  summary: string;
  suggestion: string;
  tokenUsage: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default Claude model. Read at runtime from `Setting('claude_model')`; this
 * constant is only used when that row is missing (e.g. on a fresh install
 * before the seed runs). Per SPEC.md §1 / tasks.md.
 */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Claude generation cap for an insight. ≈ enough for a summary + suggestion. */
const MAX_TOKENS = 1024;

/** Lower temperature keeps the JSON output stable and avoids creative drift. */
const TEMPERATURE = 0.3;

/**
 * Verbatim from SPEC.md §10.4. Cached via `cache_control: ephemeral` so
 * the four daily-digest calls share a single billed read.
 */
const SYSTEM_PROMPT = `You are a growth analyst for Chitly, a consumer social-networking app.
Your job is to analyze week-over-week metrics and give SHORT, ACTIONABLE suggestions.

Rules:
- Output JSON with keys: trend ("up"|"down"|"flat"), trendPct (number), summary (max 200 chars), suggestion (max 400 chars, actionable, specific).
- Be direct. No fluff like "consider exploring".
- Reference specific numbers from the data.
- If trend is flat (<5% change), say so clearly; don't manufacture insights.
- Hindi+English mix is fine if natural ("Reels engagement 18% up hai, but reply rate down"). Default English.`;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Zod schema for the JSON object Claude is asked to return. Mirrors the
 * "Rules" in {@link SYSTEM_PROMPT}:
 *
 *   - `trend`        — one of three string literals
 *   - `trendPct`     — finite number OR null (e.g. when prev period had 0)
 *   - `summary`      — non-empty, ≤ 200 chars
 *   - `suggestion`   — non-empty, ≤ 400 chars
 *
 * `null` is accepted for `trendPct` because the upstream metrics layer
 * uses `null` to mean "previous period was zero, percentage undefined"
 * (see task 63 — `computeTrendPct`). We also accept stringified numbers
 * like `"12.5"` defensively, since Claude has been seen to occasionally
 * stringify numeric fields, and coerce them back to numbers.
 */
const insightSchema = z.object({
  trend: z.enum(['up', 'down', 'flat']),
  trendPct: z
    .union([z.number(), z.string(), z.null()])
    .transform((v) => {
      if (v === null || v === '') return null;
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }),
  summary: z.string().min(1).max(200),
  suggestion: z.string().min(1).max(400),
});

// ---------------------------------------------------------------------------
// API-key resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Claude API key by trying the environment first, then the
 * encrypted Setting row. Returns the plaintext key.
 *
 * @throws {Error} when neither source is configured. The message is
 *                 user-facing — it appears in the toast in /settings.
 */
async function resolveApiKey(): Promise<string> {
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey != null && envKey.length > 0) {
    return envKey;
  }

  const row = await prisma.setting.findUnique({
    where: { key: 'anthropic_api_key' },
  });
  if (row != null && row.value.length > 0) {
    return decrypt(row.value);
  }

  throw new Error(
    'ANTHROPIC_API_KEY missing — set env var or configure in /settings',
  );
}

/**
 * Resolve the model name with a 3-tier lookup (v0.1.3 mixed-model
 * strategy):
 *
 *   1. Per-scope override (`claude_model_<scope>`) — admin can pick a
 *      different model per scope (Opus for actions, Haiku for routine,
 *      Sonnet for analytical scopes).
 *   2. Default model (`claude_model`) — the fallback when no per-scope
 *      override is set.
 *   3. Hardcoded {@link DEFAULT_MODEL} — last-resort fallback when even
 *      `claude_model` is unset (e.g. on a fresh install before seed).
 *
 * `scope` is optional — callers outside the per-scope insight pipeline
 * (early init, tests) just get the default tier. Valid model IDs per
 * SPEC.md §1: `claude-sonnet-4-6` (default), `claude-haiku-4-5-20251001`
 * (cheap), `claude-opus-4-7` (premium reasoning).
 */
export async function resolveModel(scope?: string): Promise<string> {
  if (scope) {
    const perScopeKey = `claude_model_${scope}`;
    const perScope = await prisma.setting.findUnique({
      where: { key: perScopeKey },
    });
    if (perScope != null && perScope.value.length > 0) {
      return perScope.value;
    }
  }
  const row = await prisma.setting.findUnique({
    where: { key: 'claude_model' },
  });
  if (row != null && row.value.length > 0) {
    return row.value;
  }
  return DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// SDK client (lazy, cached)
// ---------------------------------------------------------------------------

let cachedClient: Anthropic | null = null;
let cachedClientKey: string | null = null;

/**
 * Test-only mock Anthropic client. Activated when `process.env.MOCK_ANTHROPIC === '1'`,
 * which Playwright sets via `webServer.env` so the AI E2E spec can hit the
 * real `POST /api/ai/generate` route without making a network call. The
 * response below must satisfy `insightSchema` (summary ≤ 200, suggestion ≤ 400,
 * trend ∈ {"up","down","flat"}, trendPct number-or-string-or-null).
 *
 * IMPORTANT: This flag is never set in production. See FIX-LIST.md §2 for
 * the rationale and the env-var contract.
 *
 * Local trend computation in `src/lib/ai-insights.ts` overrides the mock's
 * `trend` / `trendPct` numerically, so those fields are intentionally bland.
 */
const MOCK_CLAUDE_CLIENT = {
  messages: {
    create: async () => ({
      id: 'msg_mock_e2e',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6-mock',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            trend: 'up',
            trendPct: 0,
            summary: 'Mocked insight for E2E run.',
            suggestion:
              'Mock suggestion — double down on top-performing creative; pause bottom-quartile ad sets.',
          }),
        },
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
  },
} as unknown as Anthropic;

/**
 * Get a cached `Anthropic` SDK client, building one lazily on first call
 * and rebuilding when the resolved API key changes (key rotation).
 *
 * Tests mock the SDK with:
 * ```ts
 * vi.mock('@anthropic-ai/sdk', () => ({
 *   default: vi.fn(() => ({ messages: { create: vi.fn() } })),
 * }));
 * ```
 * which intercepts the `new Anthropic(...)` call below.
 *
 * For the Playwright E2E suite we instead short-circuit at the top via
 * `MOCK_ANTHROPIC=1` so the real `/api/ai/generate` route can run end-to-end
 * without a live SDK key. See {@link MOCK_CLAUDE_CLIENT} and FIX-LIST.md §2.
 */
export async function getClaudeClient(): Promise<Anthropic> {
  if (process.env.MOCK_ANTHROPIC === '1') {
    return MOCK_CLAUDE_CLIENT;
  }
  const apiKey = await resolveApiKey();
  if (cachedClient !== null && cachedClientKey === apiKey) {
    return cachedClient;
  }
  cachedClient = new Anthropic({ apiKey });
  cachedClientKey = apiKey;
  return cachedClient;
}

/**
 * Test helper: clear the cached SDK client so a subsequent call to
 * {@link getClaudeClient} rebuilds it. Useful when a test mutates
 * `process.env.ANTHROPIC_API_KEY` between cases. Not exported in any
 * production code path.
 *
 * @internal
 */
export function __resetClaudeClientForTests(): void {
  cachedClient = null;
  cachedClientKey = null;
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

/**
 * Strip ```` ```json ... ``` ```` (or plain ```` ``` ... ``` ````) fences
 * and surrounding whitespace, then `JSON.parse` and validate against
 * {@link insightSchema}. Throws a clear, user-safe `Error` on any failure
 * after logging the raw text for triage.
 */
function parseInsightJson(raw: string): z.infer<typeof insightSchema> {
  const trimmed = raw.trim();

  // Strip a leading ```json (or ```) and trailing ``` if present.
  let body = trimmed;
  const fenceMatch = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  if (fenceMatch != null) {
    body = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // eslint-disable-next-line no-console
    console.error('[claude] non-JSON response from Claude:', raw);
    throw new Error('Claude returned non-JSON response');
  }

  const validated = insightSchema.safeParse(parsed);
  if (!validated.success) {
    // eslint-disable-next-line no-console
    console.error(
      '[claude] response failed schema validation:',
      validated.error.issues,
      'raw:',
      raw,
    );
    throw new Error('Claude returned non-JSON response');
  }

  return validated.data;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Generate an insight for one scope by calling Claude with the SPEC.md §10.4
 * system + user prompt pair, parsing the JSON response, and tallying the
 * tokens used.
 *
 * Behaviour summary:
 *
 *   - System prompt is sent with `cache_control: ephemeral` for cross-call
 *     reuse during the daily digest.
 *   - User prompt embeds the metrics JSON pretty-printed for easier
 *     inspection in API logs.
 *   - Response is expected to be a single text block; we concatenate any
 *     additional text blocks defensively.
 *   - Token usage is `input_tokens + output_tokens`, with each missing
 *     field treated as 0.
 *
 * @throws {Error} when the API key is missing, when the SDK call fails
 *                 (the error bubbles up unchanged so the caller can
 *                 inspect the Anthropic error class), or when the
 *                 response is not valid JSON matching {@link insightSchema}.
 */
export async function generateInsight(
  input: GenerateInsightInput,
): Promise<GenerateInsightResult> {
  const { scope, periodStart, periodEnd, metrics } = input;

  const client = await getClaudeClient();
  // Per-scope model selection: ads/social/leads/overall/predictions/
  // anomalies can each be configured separately in /settings. Falls back
  // to `claude_model` then hardcoded DEFAULT_MODEL.
  const model = await resolveModel(scope);

  const userPrompt = `Scope: ${scope}
Period: ${periodStart.toISOString()} to ${periodEnd.toISOString()}
Comparison: previous 7 days

Data:
${JSON.stringify(metrics, null, 2)}

Analyze and respond with JSON only.`;

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userPrompt }],
  });

  // Concatenate text blocks. Claude almost always returns a single block
  // for our prompt, but the API contract allows multiple.
  const rawText = response.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> =>
      block.type === 'text',
    )
    .map((block) => block.text)
    .join('');

  if (rawText.length === 0) {
    // eslint-disable-next-line no-console
    console.error('[claude] empty response content:', response);
    throw new Error('Claude returned non-JSON response');
  }

  const parsed = parseInsightJson(rawText);

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const tokenUsage = inputTokens + outputTokens;

  return {
    trend: parsed.trend,
    trendPct: parsed.trendPct,
    summary: parsed.summary,
    suggestion: parsed.suggestion,
    tokenUsage,
  };
}
