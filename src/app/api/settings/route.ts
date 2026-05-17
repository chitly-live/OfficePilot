/**
 * `GET /api/settings` and `PATCH /api/settings` — admin-only settings
 * read/write surface backing the `/settings` page (SPEC.md §12).
 *
 * The `Setting` model is a flat key/value store: `key String @id`,
 * `value String @db.Text`. The schemas in
 * `@/lib/schemas/settings` define the closed set of `KNOWN_KEYS` the
 * app understands and the per-key value validators. Two of those keys
 * (`anthropic_api_key`, `webhook_hmac_secret`) are sensitive and live
 * AES-256-GCM-encrypted at rest per SPEC.md §12.2.
 *
 * Endpoints:
 *
 *   GET   /api/settings  → `{ settings: Record<KnownKey, string> }`.
 *                          Sensitive keys are returned as `'***'` when
 *                          a value is stored, `''` when not. Plaintext
 *                          credentials NEVER leave the server.
 *
 *   PATCH /api/settings  → accepts `{ key, value }` (single) OR
 *                          `{ settings: { ... } }` (bulk). Each key is
 *                          validated independently; partial success is
 *                          allowed and per-key errors come back in the
 *                          response body. Sensitive values are
 *                          encrypted via `encrypt()` before write; the
 *                          placeholder `'***'` means "leave the stored
 *                          value alone" so a UI can naïvely round-trip
 *                          GET → PATCH without leaking credentials.
 *
 * Both endpoints are admin-gated. The middleware (`src/middleware.ts`)
 * already 401s unauthenticated `/api/*` traffic and the broader Wave 9
 * design also restricts `/api/settings` to ADMIN; the handler enforces
 * the role check defensively via `requireAdminSession()` regardless.
 *
 * Implements task 80 of `.kiro/specs/officepilot/tasks.md`.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import {
  errorResponse,
  parseJsonBody,
  requireAdminSession,
} from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import {
  isKnownKey,
  isSensitiveKey,
  KNOWN_KEYS,
  SENSITIVE_PLACEHOLDER,
  settingsPatchBodySchema,
  validateSettingValue,
  type KnownKey,
  type SettingsPatchBody,
  type SettingsRecord,
} from '@/lib/schemas/settings';

// `encrypt()` is a Node-only crypto wrapper, and Prisma never runs on
// Edge — so the route is pinned to the Node runtime.
export const runtime = 'nodejs';

// Settings change rarely but must reflect the latest write on every
// request — never serve a cached GET.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/settings
// ---------------------------------------------------------------------------

/**
 * Return every {@link KNOWN_KEYS} entry as a flat `Record<KnownKey, string>`.
 *
 *   • Missing rows                 → `''`.
 *   • Sensitive rows with a value  → `'***'` (never decrypt).
 *   • Sensitive rows without value → `''`.
 *   • Plain rows                   → the raw stored value.
 *
 * The caller is admin-only; non-admin sessions are rejected with 403 by
 * `requireAdminSession()`. An unauthenticated request gets the usual
 * 401 from `requireSession()` upstream.
 */
export async function GET(): Promise<NextResponse> {
  try {
    await requireAdminSession();

    // Fetch only the keys we care about. The set is small (<10), so a
    // single `findMany({ where: { key: { in: [...] } } })` is the right
    // call — no need for a `findUnique` per key.
    const rows = await prisma.setting.findMany({
      where: { key: { in: KNOWN_KEYS as unknown as string[] } },
      select: { key: true, value: true },
    });

    // Index by key for O(1) lookup while building the response.
    const byKey = new Map<string, string>();
    for (const row of rows) {
      byKey.set(row.key, row.value);
    }

    // Build the canonical response object — every known key is present,
    // ordered by `KNOWN_KEYS`, redacting sensitive values.
    const settings = {} as SettingsRecord;
    for (const key of KNOWN_KEYS) {
      const stored = byKey.get(key);
      if (stored === undefined || stored.length === 0) {
        settings[key] = '';
        continue;
      }
      settings[key] = isSensitiveKey(key) ? SENSITIVE_PLACEHOLDER : stored;
    }

    return NextResponse.json({ settings });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/settings
// ---------------------------------------------------------------------------

/**
 * Per-key error returned in the PATCH response when a particular key
 * fails validation, encryption, or persistence. Other keys in the same
 * request still go through.
 */
interface SettingPatchError {
  key: string;
  message: string;
}

/**
 * Normalise the two accepted body shapes
 * (`{ key, value }` or `{ settings: {...} }`) into a single map. The
 * single-shape form is preserved as a one-entry record so the rest of
 * the handler doesn't need to branch.
 */
function normaliseBody(body: SettingsPatchBody): Record<string, string> {
  if ('settings' in body) {
    return body.settings;
  }
  return { [body.key]: body.value };
}

/**
 * Bulk update settings. Body shape:
 *
 *   { key: string, value: string }                   // single
 *   { settings: { [key: string]: string } }          // bulk
 *
 * For each entry in turn:
 *
 *   1. Reject the key with `unknown_key` if it's not in {@link KNOWN_KEYS}.
 *   2. Run {@link validateSettingValue} for the canonical string form.
 *   3. If the key is sensitive AND the value is the placeholder
 *      `'***'`, skip the write entirely — this is the "no change"
 *      sentinel that lets a UI round-trip the GET response back through
 *      PATCH without leaking or re-rolling the credential.
 *   4. Otherwise, encrypt sensitive values and `upsert` the row.
 *   5. Best-effort log `setting.updated` to ActivityLog so the change
 *      is auditable. Logging failures are swallowed — a successful
 *      write must never be reverted because the audit row failed.
 *
 * Partial success is allowed: response shape is
 *   `{ ok: true, updated: string[], errors: SettingPatchError[] }`.
 * The HTTP status is always 200 when the request body itself parses;
 * per-key failures live in `errors`.
 *
 * Status mapping for the request as a whole:
 *   • 401 unauthenticated, 403 non-admin (via `requireAdminSession`).
 *   • 400 if the body shape is wrong (via `parseJsonBody`).
 *   • 500 on unexpected Prisma errors (via `errorResponse`).
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();

    const body = await parseJsonBody(req, settingsPatchBodySchema);
    const updates = normaliseBody(body);

    const updated: KnownKey[] = [];
    const errors: SettingPatchError[] = [];

    // Process each key in turn. Sequential, not transactional: settings
    // are independent rows and a partial failure must not roll back the
    // successful writes (per task spec).
    for (const [rawKey, rawValue] of Object.entries(updates)) {
      // 1. Key membership check.
      if (!isKnownKey(rawKey)) {
        errors.push({ key: rawKey, message: 'Unknown setting key' });
        continue;
      }
      const key: KnownKey = rawKey;

      // 2. Per-key value validation.
      const validation = validateSettingValue(key, rawValue);
      if (!validation.ok) {
        errors.push({ key, message: validation.message });
        continue;
      }
      const canonical = validation.value;

      // 3. Sensitive-key skip sentinel: `'***'` means "don't change".
      //    Don't count as updated, don't count as an error — it's a
      //    no-op echo of the GET shape.
      if (isSensitiveKey(key) && canonical === SENSITIVE_PLACEHOLDER) {
        continue;
      }

      // 4. Encrypt sensitive values. `encrypt()` reads ENCRYPTION_KEY
      //    from env and may throw if the key is missing/malformed —
      //    catch per-key so one bad config doesn't tank the whole
      //    request.
      let storedValue: string;
      try {
        storedValue = isSensitiveKey(key) ? encrypt(canonical) : canonical;
      } catch (cryptoErr) {
        // eslint-disable-next-line no-console
        console.error('[api/settings] encrypt failed', { key, cryptoErr });
        errors.push({ key, message: 'Failed to encrypt sensitive value' });
        continue;
      }

      // 5. Upsert the row. Per-key try/catch so one Prisma failure
      //    surfaces as a single per-key error rather than aborting the
      //    whole request.
      try {
        await prisma.setting.upsert({
          where: { key },
          create: { key, value: storedValue },
          update: { value: storedValue },
        });
        updated.push(key);
      } catch (dbErr) {
        // eslint-disable-next-line no-console
        console.error('[api/settings] upsert failed', { key, dbErr });
        errors.push({ key, message: 'Failed to persist setting' });
        continue;
      }

      // 6. Best-effort audit log. The plaintext value is intentionally
      //    NOT included — sensitive secrets must never appear in the
      //    activity log (SPEC.md §11.4).
      try {
        await logActivity(prisma, {
          userId: session.userId,
          action: ACTIVITY_ACTIONS.SETTING_UPDATED,
          entityType: 'setting',
          entityId: key,
          metadata: { key, entityName: key },
        });
      } catch (logErr) {
        // eslint-disable-next-line no-console
        console.error('[api/settings] activity log failed', { key, logErr });
      }
    }

    return NextResponse.json({ ok: true, updated, errors });
  } catch (err) {
    return errorResponse(err);
  }
}
