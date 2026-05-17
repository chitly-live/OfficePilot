/**
 * Zod schemas + per-key validators for the Settings module
 * (SPEC.md §12.1, §12.2; Prisma `Setting` model in §3).
 *
 * `Setting` is a key/value table — `key String @id`, `value String @db.Text`
 * — so every settings value is text in transit and at rest. The fact
 * that some settings are conceptually integers (`daily_digest_hour`),
 * arrays (`hashtag_sets`), or codes (`currency`) is enforced here via
 * the {@link validateSettingValue} dispatcher rather than at the column
 * level.
 *
 * Two flavours of "known" keys live here:
 *
 *   • {@link SENSITIVE_KEYS} — credentials that MUST be encrypted with
 *     AES-256-GCM (`@/lib/crypto`) before being persisted, and MUST NOT
 *     be returned in plaintext from any read endpoint. The `GET`
 *     handler returns the placeholder string `'***'` when a sensitive
 *     setting has a value, and `''` when it's empty.
 *
 *   • {@link KNOWN_KEYS} — the full union of keys the app reads/writes.
 *     Anything outside this list is rejected at the route boundary so
 *     the table can't accumulate typo'd / orphaned rows.
 *
 * The single-key + bulk PATCH body shapes are both handled in the
 * route — see {@link settingsPatchBodySchema}.
 *
 * Implements task 80 of `.kiro/specs/officepilot/tasks.md`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Key vocabulary
// ---------------------------------------------------------------------------

/**
 * Settings whose values are credentials and MUST be encrypted at rest.
 *
 * Read paths that need the plaintext (e.g. `lib/claude.ts`,
 * `api/webhooks/leads`) call `decrypt()` on the stored value. The HTTP
 * `GET /api/settings` endpoint NEVER decrypts these — it returns
 * `'***'` as a "value present, redacted" sentinel.
 *
 * Per SPEC.md §12.2.
 */
export const SENSITIVE_KEYS = [
  'anthropic_api_key',
  'webhook_hmac_secret',
  'smtp_pass',
  // Meta Marketing API — long-lived (system user) access token used to
  // read Ad Account insights. See `src/lib/integrations/meta.ts`.
  // TODO(v0.1.4): consumed by the Meta /insights sync once wired.
  'meta_access_token',
  // Google Ads API — developer token plus the OAuth-client triple. The
  // refresh token is exchanged at request time for a short-lived
  // access token; see `src/lib/integrations/google-ads.ts`.
  // TODO(v0.1.4): consumed by the Google Ads searchStream sync.
  'google_ads_developer_token',
  'google_ads_client_secret',
  'google_ads_refresh_token',
] as const;

/** One of the encrypted-at-rest setting keys. */
export type SensitiveKey = (typeof SENSITIVE_KEYS)[number];

/**
 * Sentinel value returned by `GET /api/settings` for sensitive keys
 * that have a stored value. The PATCH handler treats this same string
 * as "don't change" so a UI can naïvely round-trip the GET response
 * back through PATCH without unintentionally clearing or re-encrypting
 * the secret.
 */
export const SENSITIVE_PLACEHOLDER = '***' as const;

/**
 * Every settings key the app reads or writes. Anything outside this
 * list is a 400 at the route boundary.
 *
 * Source of truth for the key vocabulary (mirrors SPEC.md §3.1 + §12.1
 * + the cron-related additions in §10.6 / §6.2.5).
 */
export const KNOWN_KEYS = [
  ...SENSITIVE_KEYS,
  'claude_model',
  // Per-scope model overrides (v0.1.3). Empty string means "use
  // `claude_model` default". Whitelisted to a small set of Claude model
  // IDs so a typo can't silently nuke the AI module — see
  // `claudeModelField` validator below.
  //
  // Mixed-model strategy lets admins use Haiku for routine daily digest,
  // Sonnet for analytical scopes (overall, predictions, anomalies), and
  // Opus for the Action List where multi-step reasoning matters most.
  'claude_model_ads',
  'claude_model_social',
  'claude_model_leads',
  'claude_model_overall',
  'claude_model_predictions',
  'claude_model_anomalies',
  'claude_model_actions',
  'daily_digest_hour',
  'currency',
  'hashtag_sets',
  'followup_reminder_hour',
  // SMTP — admin-configurable email transport (SPEC.md §12.1 +
  // `src/lib/mailer.ts`). `smtp_pass` lives in {@link SENSITIVE_KEYS}
  // and is encrypted at rest; the rest are plain text. When all five
  // are absent the mailer falls back to the `SMTP_*` env vars.
  'smtp_host',
  'smtp_port',
  'smtp_user',
  'smtp_from',
  // Meta Marketing API — non-secret IDs. The access token lives in
  // {@link SENSITIVE_KEYS}. `meta_business_id` is optional (used only
  // by accounts that hang Ad Accounts under a Business Manager parent
  // and want the test endpoint to confirm both edges).
  // TODO(v0.1.4): wire up Meta /insights sync.
  'meta_ad_account_id',
  'meta_business_id',
  // Instagram Business Account ID — needed by the Instagram Graph API
  // for organic-content insights (reels reach, story views, post likes
  // beyond the ad surface). The Meta access token above covers auth as
  // long as the IG account is linked to the same Business + Facebook
  // Page. Format: ~17-digit numeric string (e.g. 17841401234567890).
  // TODO(v0.1.4): wire up `/media` insights sync into the Social module.
  'instagram_business_account_id',
  // Google Ads API — non-secret IDs. The developer token, client
  // secret, and refresh token are all in {@link SENSITIVE_KEYS}.
  // `google_ads_login_customer_id` is optional and only required for
  // MCC (manager-account) setups that proxy calls through a parent.
  // TODO(v0.1.4): wire up Google Ads /searchStream sync.
  'google_ads_customer_id',
  'google_ads_client_id',
  'google_ads_login_customer_id',
] as const;

/** One of the known setting keys. */
export type KnownKey = (typeof KNOWN_KEYS)[number];

/** Type guard: does this string belong to {@link KNOWN_KEYS}? */
export function isKnownKey(key: string): key is KnownKey {
  return (KNOWN_KEYS as readonly string[]).includes(key);
}

/** Type guard: does this key live in {@link SENSITIVE_KEYS}? */
export function isSensitiveKey(key: string): key is SensitiveKey {
  return (SENSITIVE_KEYS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// Per-key value schemas
// ---------------------------------------------------------------------------

/** Width-bound on free-form string settings to keep accidental paste-bombs
 *  from hitting `@db.Text`. 4 KB is plenty for model names, currency
 *  codes, and API keys. */
const MAX_STRING_VALUE = 4096;

/** Width-bound on the JSON-encoded `hashtag_sets` blob — keep it
 *  under a megabyte so nobody mistakes the kv table for a CMS. */
const MAX_HASHTAG_SETS_JSON = 65_536;

/** RFC 1035 hostname length cap. Practical SMTP hosts are well under
 *  this (`smtp.gmail.com`, `email-smtp.eu-west-1.amazonaws.com`) but
 *  the validator enforces the standard. */
const MAX_HOSTNAME_LENGTH = 253;

/** A non-empty trimmed string used for free-form settings (model name,
 *  sensitive credentials). Bounded to {@link MAX_STRING_VALUE}. */
const nonEmptyStringField = z
  .string()
  .trim()
  .min(1, 'Value cannot be empty')
  .max(MAX_STRING_VALUE, `Value must be ${MAX_STRING_VALUE} characters or fewer`);

/** Hour of day in 24-hour clock (0–23). The DB column is text, so the
 *  validator coerces from string and re-serialises the canonical
 *  form. */
const hourOfDayField = z.coerce
  .number()
  .int('Hour must be an integer')
  .min(0, 'Hour must be between 0 and 23')
  .max(23, 'Hour must be between 0 and 23');

/** TCP port number (1–65535). The DB column is text, so the validator
 *  coerces from string and re-serialises the canonical decimal form
 *  (`"587"`). */
const portNumberField = z.coerce
  .number()
  .int('Port must be an integer')
  .min(1, 'Port must be between 1 and 65535')
  .max(65_535, 'Port must be between 1 and 65535');

/** Hostname/host string used for SMTP. Trimmed, non-empty, bounded by
 *  the RFC 1035 253-character cap. Format (label structure, IDN, etc.)
 *  is intentionally NOT enforced — nodemailer will surface a
 *  meaningful error at connect time if the value is unusable, and a
 *  strict regex risks rejecting valid edge cases (IPv6 literals,
 *  Punycode). */
const smtpHostField = z
  .string()
  .trim()
  .min(1, 'SMTP host cannot be empty')
  .max(
    MAX_HOSTNAME_LENGTH,
    `SMTP host must be ${MAX_HOSTNAME_LENGTH} characters or fewer`,
  );

/**
 * Relaxed `From` header for SMTP. Accepts either:
 *
 *   • A bare email address — `alerts@chitly.live`.
 *   • A display-name form — `OfficePilot <alerts@chitly.live>`.
 *
 * The regex is deliberately permissive (`/^.+@.+\..+$/` or
 * `/^.+<.+@.+\..+>$/`) — nodemailer parses the value with the same
 * forgiving rules `mailcomposer` does and will reject malformed
 * addresses at send time with a clearer message than we could produce
 * here. The validator's job is to catch obvious typos (empty, no `@`,
 * no domain) and stop them at the API boundary.
 */
const smtpFromField = z
  .string()
  .trim()
  .min(1, 'SMTP from cannot be empty')
  .max(MAX_STRING_VALUE, `Value must be ${MAX_STRING_VALUE} characters or fewer`)
  .refine(
    (s) => /^.+@.+\..+$/.test(s) || /^.+<.+@.+\..+>$/.test(s),
    'SMTP from must be an email address or "Display Name <email@host>"',
  );

/** ISO-4217 3-letter currency code, upper-cased. Defaults to `INR`
 *  per SPEC.md §3.1 — the default is applied at seed time, not here. */
const currencyField = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/u, 'Currency must be a 3-letter code')
  .transform((s) => s.toUpperCase());

/**
 * Meta Marketing API Ad Account identifier: literal prefix `act_`
 * followed by 6+ digits. Format documented at
 * https://developers.facebook.com/docs/marketing-api/reference/ad-account.
 *
 * The 6-digit lower bound is permissive — Meta has issued shorter IDs
 * historically, but every account a real user would paste in 2026+ is
 * comfortably above six digits.
 */
const metaAdAccountIdField = z
  .string()
  .trim()
  .regex(
    /^act_\d{6,}$/u,
    'Ad Account ID must start with `act_` followed by digits',
  );

/**
 * Meta Business Manager identifier — a bare digit string. Optional in
 * our model (we only require the Ad Account ID + access token), so the
 * empty-string case is handled explicitly in `validateSettingValue`.
 */
const metaBusinessIdField = z
  .string()
  .trim()
  .regex(/^\d{1,32}$/u, 'Business ID must be a numeric string');

/**
 * Instagram Business Account ID — numeric string returned by the Instagram
 * Graph API's `/me/accounts` endpoint. Typically ~17 digits but the API
 * doesn't fix a length, so we allow 1–32 digits. Empty input is allowed
 * and stored as `''` (handled explicitly in `validateSettingValue`).
 */
const instagramBusinessAccountIdField = z
  .string()
  .trim()
  .regex(/^\d{1,32}$/u, 'Instagram Business Account ID must be a numeric string');

/**
 * Google Ads customer ID: 10 digits, optionally hyphen-separated as
 * `123-456-7890`. The validator strips hyphens so the stored form is
 * always the canonical 10-digit string — call sites that need to render
 * the hyphenated form for humans can re-format on display.
 *
 * Used for both `google_ads_customer_id` and
 * `google_ads_login_customer_id` (manager / MCC ID).
 */
const googleAdsCustomerIdField = z
  .string()
  .trim()
  .regex(
    /^\d{3}-?\d{3}-?\d{4}$/u,
    'Customer ID must be 10 digits (hyphens optional)',
  )
  .transform((s) => s.replace(/-/g, ''));

/** A single named hashtag bundle in the user's saved sets. */
const hashtagSetItemSchema = z.object({
  name: z.string().trim().min(1, 'Set name cannot be empty').max(64),
  hashtags: z
    .array(z.string().trim().min(1).max(64))
    .max(64, 'A set may contain at most 64 hashtags'),
});

/** The hashtag library: an array of named bundles, persisted as a JSON
 *  string in `Setting.value`. Empty array is valid. */
const hashtagSetsArraySchema = z
  .array(hashtagSetItemSchema)
  .max(64, 'At most 64 hashtag sets may be saved');

/**
 * Outcome of a per-key validation. Carries the *normalised* value (the
 * exact string the route handler will write to `Setting.value`) so the
 * caller doesn't have to re-serialise.
 *
 * On failure, `message` is a short human-readable string suitable for
 * surfacing in the per-key `errors[]` array of the PATCH response.
 */
export type ValidateSettingValueResult =
  | { ok: true; value: string }
  | { ok: false; message: string };

/**
 * Validate a single `(key, value)` pair against the per-key schema and
 * return the canonical string form for storage. Pure: no I/O, no
 * encryption — the route handler is responsible for calling
 * `encrypt()` on sensitive values *after* validation.
 *
 * Behaviour by key:
 *
 *   • `claude_model`               — non-empty trimmed string.
 *   • `daily_digest_hour`,
 *     `followup_reminder_hour`     — integer 0–23, normalised to its
 *                                    decimal string (`"9"`, `"23"`).
 *   • `currency`                   — exactly 3 letters, upper-cased.
 *   • `hashtag_sets`               — JSON string parsing to an array of
 *                                    `{ name, hashtags[] }`. The
 *                                    canonical form (`JSON.stringify`)
 *                                    is returned.
 *   • `smtp_host`                  — non-empty trimmed string, max 253
 *                                    characters (RFC 1035 hostname cap).
 *   • `smtp_port`                  — integer 1–65535, normalised to its
 *                                    decimal string (`"587"`).
 *   • `smtp_user`                  — non-empty trimmed string.
 *   • `smtp_from`                  — bare email (`x@y.z`) or display-name
 *                                    form (`Name <x@y.z>`); regex is
 *                                    permissive, nodemailer rejects
 *                                    malformed addresses at send time.
 *   • `meta_ad_account_id`         — `act_<digits>` (Meta Marketing API
 *                                    convention; 6+ digits).
 *   • `meta_business_id`           — optional digit string. Empty input
 *                                    is allowed and stored as `''`.
 *   • `google_ads_customer_id`     — 10 digits, optionally hyphenated
 *                                    (`123-456-7890`). Hyphens are
 *                                    stripped before storage so the
 *                                    canonical form is always
 *                                    `1234567890`.
 *   • `google_ads_client_id`       — non-empty trimmed string (OAuth
 *                                    client ID, format intentionally
 *                                    not regex-checked since Google's
 *                                    `*.apps.googleusercontent.com`
 *                                    rules drift over time).
 *   • `google_ads_login_customer_id` — optional, same shape as
 *                                    `google_ads_customer_id`. Empty
 *                                    input is allowed.
 *   • `anthropic_api_key`,
 *     `webhook_hmac_secret`,
 *     `smtp_pass`,
 *     `meta_access_token`,
 *     `google_ads_developer_token`,
 *     `google_ads_client_secret`,
 *     `google_ads_refresh_token`   — non-empty trimmed string. The
 *                                    placeholder `'***'` is treated as
 *                                    valid here so the route can detect
 *                                    it and skip the write; encryption
 *                                    happens at the route layer.
 *
 * The function never throws; failures are returned as `{ ok: false }`.
 */
export function validateSettingValue(
  key: KnownKey,
  rawValue: string,
): ValidateSettingValueResult {
  switch (key) {
    case 'claude_model': {
      const parsed = nonEmptyStringField.safeParse(rawValue);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid value' };
    }

    case 'claude_model_ads':
    case 'claude_model_social':
    case 'claude_model_leads':
    case 'claude_model_overall':
    case 'claude_model_predictions':
    case 'claude_model_anomalies':
    case 'claude_model_actions': {
      // Empty string clears the override → falls back to `claude_model`
      // at runtime. Otherwise the value must be one of the three valid
      // Claude model IDs (SPEC.md §1 / FIX-LIST §2 for haiku canonical).
      if (rawValue.trim().length === 0) {
        return { ok: true, value: '' };
      }
      const ALLOWED_MODELS = [
        'claude-opus-4-7',
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001',
      ];
      const trimmed = rawValue.trim();
      if (!ALLOWED_MODELS.includes(trimmed)) {
        return {
          ok: false,
          message: `Model must be one of: ${ALLOWED_MODELS.join(', ')}`,
        };
      }
      return { ok: true, value: trimmed };
    }

    case 'daily_digest_hour':
    case 'followup_reminder_hour': {
      // `z.coerce.number()` accepts numeric strings; reject empty or
      // whitespace-only inputs explicitly so the caller gets a clear
      // error instead of "Expected number, received NaN".
      if (rawValue.trim().length === 0) {
        return { ok: false, message: 'Hour is required' };
      }
      const parsed = hourOfDayField.safeParse(rawValue);
      return parsed.success
        ? { ok: true, value: String(parsed.data) }
        : { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid hour' };
    }

    case 'currency': {
      const parsed = currencyField.safeParse(rawValue);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid currency' };
    }

    case 'hashtag_sets': {
      // Two-step parse: JSON first, then schema. Empty string is
      // rejected — callers that want to clear the library should send
      // the literal JSON `"[]"`.
      if (rawValue.length > MAX_HASHTAG_SETS_JSON) {
        return { ok: false, message: 'Hashtag sets payload is too large' };
      }
      let json: unknown;
      try {
        json = JSON.parse(rawValue);
      } catch {
        return { ok: false, message: 'Hashtag sets must be valid JSON' };
      }
      const parsed = hashtagSetsArraySchema.safeParse(json);
      if (!parsed.success) {
        return {
          ok: false,
          message:
            parsed.error.issues[0]?.message ?? 'Hashtag sets payload is invalid',
        };
      }
      // Canonicalise: re-stringify so the stored form is stable across
      // whitespace / key-order differences in client payloads.
      return { ok: true, value: JSON.stringify(parsed.data) };
    }

    case 'smtp_host': {
      const parsed = smtpHostField.safeParse(rawValue);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid SMTP host' };
    }

    case 'smtp_port': {
      // Mirrors `daily_digest_hour` — explicit empty-string guard so
      // the caller gets "Port is required" instead of a generic
      // coercion failure.
      if (rawValue.trim().length === 0) {
        return { ok: false, message: 'Port is required' };
      }
      const parsed = portNumberField.safeParse(rawValue);
      return parsed.success
        ? { ok: true, value: String(parsed.data) }
        : { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid port' };
    }

    case 'smtp_user': {
      const parsed = nonEmptyStringField.safeParse(rawValue);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid SMTP user' };
    }

    case 'smtp_from': {
      const parsed = smtpFromField.safeParse(rawValue);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid SMTP from' };
    }

    case 'meta_ad_account_id': {
      const parsed = metaAdAccountIdField.safeParse(rawValue);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : {
            ok: false,
            message:
              parsed.error.issues[0]?.message ?? 'Invalid Meta Ad Account ID',
          };
    }

    case 'meta_business_id': {
      // Optional field — empty string clears the row. The PATCH handler
      // happily upserts an empty value; clients that want to remove a
      // setting send `""` (consistent with the SMTP optional fields).
      if (rawValue.trim().length === 0) {
        return { ok: true, value: '' };
      }
      const parsed = metaBusinessIdField.safeParse(rawValue);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : {
            ok: false,
            message:
              parsed.error.issues[0]?.message ?? 'Invalid Meta Business ID',
          };
    }

    case 'instagram_business_account_id': {
      // Optional — empty clears the row (matches `meta_business_id`
      // semantics). Same Meta access token covers auth; this ID is
      // public and consumed by the future Instagram Graph API sync.
      if (rawValue.trim().length === 0) {
        return { ok: true, value: '' };
      }
      const parsed = instagramBusinessAccountIdField.safeParse(rawValue);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : {
            ok: false,
            message:
              parsed.error.issues[0]?.message ??
              'Invalid Instagram Business Account ID',
          };
    }

    case 'google_ads_customer_id': {
      const parsed = googleAdsCustomerIdField.safeParse(rawValue);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : {
            ok: false,
            message:
              parsed.error.issues[0]?.message ?? 'Invalid Google Ads Customer ID',
          };
    }

    case 'google_ads_login_customer_id': {
      // Optional — empty clears. Same shape as the primary customer ID.
      if (rawValue.trim().length === 0) {
        return { ok: true, value: '' };
      }
      const parsed = googleAdsCustomerIdField.safeParse(rawValue);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : {
            ok: false,
            message:
              parsed.error.issues[0]?.message ??
              'Invalid Google Ads Login Customer ID',
          };
    }

    case 'google_ads_client_id': {
      // Public OAuth client ID. Non-empty trimmed string — Google's
      // `*.apps.googleusercontent.com` suffix has shifted over time so
      // a strict regex would create false negatives.
      const parsed = nonEmptyStringField.safeParse(rawValue);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : {
            ok: false,
            message:
              parsed.error.issues[0]?.message ?? 'Invalid Google Ads Client ID',
          };
    }

    case 'anthropic_api_key':
    case 'webhook_hmac_secret':
    case 'smtp_pass':
    case 'meta_access_token':
    case 'google_ads_developer_token':
    case 'google_ads_client_secret':
    case 'google_ads_refresh_token': {
      // The placeholder is the route's "skip" sentinel — it's not a
      // real credential, so it bypasses the non-empty check here and
      // is handled at the route layer.
      if (rawValue === SENSITIVE_PLACEHOLDER) {
        return { ok: true, value: rawValue };
      }
      const parsed = nonEmptyStringField.safeParse(rawValue);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid value' };
    }

    default: {
      // Exhaustiveness guard: TS will surface a compile error here if
      // a new entry is added to `KNOWN_KEYS` without a matching case.
      const _exhaustive: never = key;
      void _exhaustive;
      return { ok: false, message: 'Unsupported setting key' };
    }
  }
}

// ---------------------------------------------------------------------------
// PATCH body schemas
// ---------------------------------------------------------------------------

/**
 * Bulk-shape settings payload: a flat string→string map.
 *
 * Key validation (membership in {@link KNOWN_KEYS}) is intentionally
 * NOT done here so the route can return per-key errors for unknown
 * keys instead of a single 400 that aborts the whole request.
 */
export const settingsPatchSchema = z.record(z.string(), z.string());

/** Single-key PATCH body shape: `{ key: string, value: string }`. */
export const settingsPatchSingleSchema = z.object({
  key: z.string().min(1, 'Key is required'),
  value: z.string(),
});

/**
 * Accepted PATCH body shape for `/api/settings`: either a single
 * `{ key, value }` pair or a bulk `{ settings: { ... } }` map. The
 * route handler normalises both into a `Record<string, string>` before
 * applying the per-key validators.
 */
export const settingsPatchBodySchema = z.union([
  settingsPatchSingleSchema,
  z.object({ settings: settingsPatchSchema }),
]);

/** Inferred TypeScript shape of {@link settingsPatchBodySchema}. */
export type SettingsPatchBody = z.infer<typeof settingsPatchBodySchema>;

/**
 * Response shape for `GET /api/settings`. Every {@link KNOWN_KEYS}
 * entry is present; missing rows surface as `''`, sensitive rows
 * with a value surface as {@link SENSITIVE_PLACEHOLDER}.
 */
export type SettingsRecord = Record<KnownKey, string>;
