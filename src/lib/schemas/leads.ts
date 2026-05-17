/**
 * Zod schemas + DTO types for the Leads module
 * (SPEC.md §6, Prisma `Lead` and `Note` models in §3).
 *
 * Single source of truth for validating request payloads, query strings,
 * CSV rows, and inbound webhook bodies on:
 *
 *   • POST   /api/leads                     → `leadCreateSchema`
 *   • PATCH  /api/leads/[id]                → `leadUpdateSchema`
 *   • GET    /api/leads                     → `leadListQuerySchema`
 *   • POST   /api/leads/[id]/notes          → `leadNoteCreateSchema`
 *   • POST   /api/leads/import              → `leadCsvImportSchema`
 *   • POST   /api/webhooks/leads            → `leadWebhookSchema`
 *
 * Reused by the corresponding `react-hook-form` forms via
 * `@hookform/resolvers/zod` so client and server share one validation
 * contract (SPEC.md §13.5 — never trust client-only validation).
 *
 * `leadPublicProjection` is a Prisma `select` mask used by every read
 * endpoint that returns a lead so that owner relations are included
 * consistently (and `passwordHash` is implicitly excluded since the
 * embedded owner only exposes the safe `userPublicProjection` columns).
 *
 * Implements task 30 of `.kiro/specs/officepilot/tasks.md`.
 */

import { z } from 'zod';
import { LeadSource, LeadStatus, Priority } from '@prisma/client';

// ---------------------------------------------------------------------------
// Field-level constants
// ---------------------------------------------------------------------------

const MAX_NAME_LENGTH = 200;
const MAX_COMPANY_LENGTH = 200;
const MAX_CITY_LENGTH = 100;
const MAX_PHONE_LENGTH = 32;
const MIN_PHONE_DIGITS = 7;
const MAX_EMAIL_LENGTH = 254; // RFC 5321
const MAX_URL_LENGTH = 2048;
/** SPEC.md §6.4 doesn't cap notes, but we keep a generous ceiling so an
 *  accidental paste-bomb hits Zod, not Postgres TOAST. */
const MAX_NOTES_LENGTH = 5000;
const MAX_NOTE_BODY_LENGTH = 5000;
const MAX_TAG_LENGTH = 50;
const MAX_TAGS_PER_LEAD = 30;
const MAX_UTM_FIELD_LENGTH = 200;
const MAX_SEARCH_LENGTH = 200;
const MAX_VALUE = 1_000_000_000; // ₹100 cr ceiling — beyond is almost certainly a typo.

// v0.1.4 — Chitly-spreadsheet field caps. `address` and `extraDetails`
// are both `@db.Text` server-side; the Zod caps below are paste-bomb
// guards rather than hard storage limits.
const MIN_AGE = 0;
const MAX_AGE = 150;
const MAX_ACTIVE_SINCE_LENGTH = 64;
const MAX_LANGUAGE_LENGTH = 64;
const MAX_LANGUAGES_PER_LEAD = 16;
const MAX_EXTRA_DETAILS_LENGTH = 2000;
const MAX_ADDRESS_LENGTH = 2000;

/** Canonical `phoneType` values mirrored on the Prisma column. The
 *  schema stores this as `String?` for forward-compat, but we restrict
 *  inbound writes to this fixed set so the UI can render fixed icons. */
export const PHONE_TYPE_VALUES = ['iPhone', 'Android', 'Other'] as const;
export type PhoneType = (typeof PHONE_TYPE_VALUES)[number];

/**
 * Case-insensitive lookup table for the CSV import: maps common
 * spreadsheet phrasings to a canonical `PhoneType`. Anything not in
 * this table falls back to `'Other'`.
 */
const PHONE_TYPE_ALIASES: Record<string, PhoneType> = {
  iphone: 'iPhone',
  ios: 'iPhone',
  apple: 'iPhone',
  android: 'Android',
  samsung: 'Android',
  oneplus: 'Android',
  google: 'Android',
  pixel: 'Android',
  other: 'Other',
};

/**
 * Truthiness coercion for free-text spreadsheet cells in the
 * "Not on WhatsApp" column. Accepts the obvious "yes/no/true/false/1/0"
 * variants plus the literal column header value itself (some operators
 * paste the header into the cell as a flag).
 */
const NOT_ON_WHATSAPP_TRUE = new Set([
  'true',
  'yes',
  'y',
  '1',
  'not on whatsapp',
  'no whatsapp',
  'noWA'.toLowerCase(),
]);
const NOT_ON_WHATSAPP_FALSE = new Set([
  '',
  'false',
  'no',
  'n',
  '0',
  'on whatsapp',
  'has whatsapp',
]);

const DEFAULT_PAGE = 1;
/** SPEC.md §6.3: default 50/page. */
const DEFAULT_PAGE_SIZE = 50;
/** SPEC.md §6.3 (via task 31): max 200/page. */
const MAX_PAGE_SIZE = 200;

/** SPEC.md §6.4: CSV import is capped at 1 000 rows per upload. */
export const MAX_CSV_ROWS = 1000;

/**
 * Permissive phone shape — we don't try to be libphonenumber here. We just
 * reject obvious garbage (letters, control chars) and require at least
 * `MIN_PHONE_DIGITS` digits so a stray "abc" or "+++" doesn't sail through.
 * Country-specific formatting is the form-layer's problem.
 */
const phoneRegex = /^[+\d][\d\s\-()]{6,}$/;

// ---------------------------------------------------------------------------
// Reusable field schemas
// ---------------------------------------------------------------------------

/** Lower-cased, trimmed email. The DB column is not unique on Lead.email
 *  (a person can submit the same lead through multiple channels), but
 *  CSV import dedupes on `(phone, email)` so normalization matters. */
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email('Invalid email address')
  .max(MAX_EMAIL_LENGTH, `Email must be ${MAX_EMAIL_LENGTH} characters or fewer`);

const phoneField = z
  .string()
  .trim()
  .max(MAX_PHONE_LENGTH, `Phone must be ${MAX_PHONE_LENGTH} characters or fewer`)
  .regex(phoneRegex, 'Invalid phone number')
  .refine(
    (val) => (val.match(/\d/g)?.length ?? 0) >= MIN_PHONE_DIGITS,
    `Phone must contain at least ${MIN_PHONE_DIGITS} digits`,
  );

const nameField = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(MAX_NAME_LENGTH, `Name must be ${MAX_NAME_LENGTH} characters or fewer`);

const companyField = z
  .string()
  .trim()
  .min(1, 'Company cannot be empty')
  .max(MAX_COMPANY_LENGTH, `Company must be ${MAX_COMPANY_LENGTH} characters or fewer`);

const cityField = z
  .string()
  .trim()
  .min(1, 'City cannot be empty')
  .max(MAX_CITY_LENGTH, `City must be ${MAX_CITY_LENGTH} characters or fewer`);

const utmField = z
  .string()
  .trim()
  .min(1, 'UTM value cannot be empty')
  .max(MAX_UTM_FIELD_LENGTH, `UTM value must be ${MAX_UTM_FIELD_LENGTH} characters or fewer`);

const urlField = z
  .string()
  .trim()
  .url('Invalid URL')
  .max(MAX_URL_LENGTH, `URL must be ${MAX_URL_LENGTH} characters or fewer`);

const tagField = z
  .string()
  .trim()
  .min(1, 'Tag cannot be empty')
  .max(MAX_TAG_LENGTH, `Tag must be ${MAX_TAG_LENGTH} characters or fewer`);

const tagsField = z
  .array(tagField)
  .max(MAX_TAGS_PER_LEAD, `A lead may have at most ${MAX_TAGS_PER_LEAD} tags`);

const notesField = z
  .string()
  .max(MAX_NOTES_LENGTH, `Notes must be ${MAX_NOTES_LENGTH} characters or fewer`);

/** Estimated value in INR (SPEC.md §3 — `Lead.value` is a Float). We allow
 *  zero (a free trial lead is still a lead) but reject negatives. */
const valueField = z
  .number()
  .finite('Value must be a finite number')
  .min(0, 'Value must be non-negative')
  .max(MAX_VALUE, `Value must be ${MAX_VALUE} or less`);

/** Prisma `cuid()` IDs are 25 chars starting with `c`. We keep the regex
 *  loose so legacy IDs / future format changes don't break — we just
 *  guarantee non-empty + reasonable length. */
const idField = z.string().trim().min(1, 'ID is required').max(64);

/**
 * Accepts an ISO-8601 datetime string (e.g. `"2026-05-16T03:00:00Z"`) or
 * a `Date` object and yields a `Date`. `z.coerce.date()` covers both
 * cases — `new Date(string)` for strings, identity for Date inputs —
 * while still rejecting nonsense like `"not a date"` (which yields an
 * Invalid Date that Zod catches).
 */
const isoDateTimeField = z.coerce.date();

const leadSourceField = z.nativeEnum(LeadSource);
const leadStatusField = z.nativeEnum(LeadStatus);
const priorityField = z.nativeEnum(Priority);

// ---------------------------------------------------------------------------
// v0.1.4 — Chitly-spreadsheet field schemas
// ---------------------------------------------------------------------------

/**
 * Age in years. Coerced from string ("29") because spreadsheet CSV
 * cells are always strings. Whole numbers only; clamped to
 * [MIN_AGE, MAX_AGE] so a stray `"129"` is fine but `"9999"` (likely a
 * year typed into the wrong column) is rejected.
 */
const ageField = z.coerce
  .number()
  .int('Age must be a whole number')
  .min(MIN_AGE, `Age must be at least ${MIN_AGE}`)
  .max(MAX_AGE, `Age must be at most ${MAX_AGE}`);

/**
 * Free-text "active since" descriptor — e.g. `"5 Days"`, `"6 months"`,
 * `"since Jan 2026"`. Intentionally NOT parsed into a duration: the
 * column is operator-facing context, not data the backend reasons about.
 */
const activeSinceField = z
  .string()
  .trim()
  .min(1, 'Active since cannot be empty')
  .max(
    MAX_ACTIVE_SINCE_LENGTH,
    `Active since must be ${MAX_ACTIVE_SINCE_LENGTH} chars or fewer`,
  );

/** A single language label, e.g. `"Hindi"`. Stored verbatim — no
 *  normalization, no ISO codes — because the spreadsheet uses
 *  human-friendly names and we don't want to lossy-map them. */
const languageField = z
  .string()
  .trim()
  .min(1, 'Language cannot be empty')
  .max(MAX_LANGUAGE_LENGTH, `Language must be ${MAX_LANGUAGE_LENGTH} chars or fewer`);

const languagesField = z
  .array(languageField)
  .max(
    MAX_LANGUAGES_PER_LEAD,
    `A lead may list at most ${MAX_LANGUAGES_PER_LEAD} languages`,
  );

/** Short context line — distinct from `notes` (which is the long-form
 *  scratchpad). Capped at 2 000 chars; the DB column is `@db.Text` so
 *  the cap is a Zod-side paste-bomb guard. */
const extraDetailsField = z
  .string()
  .trim()
  .max(
    MAX_EXTRA_DETAILS_LENGTH,
    `Extra details must be ${MAX_EXTRA_DETAILS_LENGTH} chars or fewer`,
  );

/** Canonical phone-type enum. The Prisma column is `String?` for
 *  forward-compat, but inbound writes are restricted to the fixed set
 *  so the UI can render device icons without mapping fuzz. */
const phoneTypeField = z.enum(PHONE_TYPE_VALUES);

/** Full address — free-form multi-line. `@db.Text` server-side; capped
 *  here so a multi-MB paste hits Zod, not Postgres. */
const addressField = z
  .string()
  .trim()
  .max(MAX_ADDRESS_LENGTH, `Address must be ${MAX_ADDRESS_LENGTH} chars or fewer`);

/**
 * Coerce a free-form `phoneType` string from a CSV cell to the canonical
 * enum value. Case-insensitive lookup against `PHONE_TYPE_ALIASES`;
 * unknown non-empty strings fall back to `'Other'`. Empty/whitespace
 * input yields `undefined` so `.optional()` semantics work as expected
 * downstream.
 */
function coercePhoneType(input: unknown): PhoneType | undefined {
  if (typeof input !== 'string') return undefined;
  const key = input.trim().toLowerCase();
  if (key.length === 0) return undefined;
  return PHONE_TYPE_ALIASES[key] ?? 'Other';
}

/**
 * Coerce a free-form "Not on WhatsApp" cell to a boolean. Truthy
 * variants → `true`; falsy/empty variants → `false`. Anything else
 * also lands on `false` (safer default — the column means "missing
 * WhatsApp", so the cautious read is "we don't know, assume they have
 * it" rather than silently flagging the lead as unreachable).
 */
function coerceNotOnWhatsapp(input: unknown): boolean {
  if (typeof input === 'boolean') return input;
  if (typeof input === 'number') return input !== 0;
  if (typeof input !== 'string') return false;
  const key = input.trim().toLowerCase();
  if (NOT_ON_WHATSAPP_TRUE.has(key)) return true;
  if (NOT_ON_WHATSAPP_FALSE.has(key)) return false;
  return false;
}

// ---------------------------------------------------------------------------
// Source-string coercion (used by CSV + webhook)
// ---------------------------------------------------------------------------

/**
 * Build the lookup table of accepted source aliases once. Allows callers
 * to send `"facebook ad"`, `"facebook-ad"`, `"FACEBOOK_AD"`, or `"fb ads"`
 * — anything that normalizes to a known enum value lands on the canonical
 * `LeadSource`. Unknown strings fall through to `OTHER` (SPEC.md §6.4
 * allows it, the Note column captures the original).
 */
const SOURCE_ALIASES: Record<string, LeadSource> = (() => {
  const aliases: Record<string, LeadSource> = {};
  for (const value of Object.values(LeadSource)) {
    aliases[value.toLowerCase()] = value;
    aliases[value.toLowerCase().replace(/_/g, '')] = value;
    aliases[value.toLowerCase().replace(/_/g, ' ')] = value;
    aliases[value.toLowerCase().replace(/_/g, '-')] = value;
  }
  // Common shorthand seen on inbound forms.
  aliases.fb = LeadSource.FACEBOOK_AD;
  aliases['fb ad'] = LeadSource.FACEBOOK_AD;
  aliases['fb ads'] = LeadSource.FACEBOOK_AD;
  aliases['google ad'] = LeadSource.GOOGLE_AD;
  aliases['google ads'] = LeadSource.GOOGLE_AD;
  aliases.ig = LeadSource.INSTAGRAM;
  aliases.wa = LeadSource.WHATSAPP;
  aliases['whats app'] = LeadSource.WHATSAPP;
  aliases.web = LeadSource.WEBSITE;
  aliases.site = LeadSource.WEBSITE;
  return aliases;
})();

/**
 * Coerce a free-form source string (from CSV or webhook) to a
 * `LeadSource` enum value. Unknown strings land on `OTHER` so a
 * misconfigured external form never bounces a real lead — SPEC.md §6.4
 * favors capture-then-clean over strict rejection on this one.
 */
export function coerceLeadSource(input: string | null | undefined): LeadSource {
  if (!input) return LeadSource.OTHER;
  const key = input.trim().toLowerCase();
  return SOURCE_ALIASES[key] ?? LeadSource.OTHER;
}

/** Zod transformer wrapping `coerceLeadSource`. Accepts any non-empty
 *  string and emits a `LeadSource`. */
const leadSourceFromStringField = z
  .string()
  .trim()
  .min(1, 'Source cannot be empty')
  .transform((val) => coerceLeadSource(val));

// ---------------------------------------------------------------------------
// 1. POST /api/leads
// ---------------------------------------------------------------------------

/**
 * Body schema for `POST /api/leads` (SPEC.md §6.3, §6.4).
 *
 * The route handler (task 31) is responsible for:
 *   1. Auth guard — unauthenticated → 401 (middleware), unauthorized → 403.
 *   2. Setting `createdById = session.userId`.
 *   3. Calling `logActivity(..., 'lead.created', ...)`.
 *   4. UTM auto-fill from the request body when fields are present.
 *
 * SPEC.md §6.4 requires `phone || email` — this is enforced by `.refine`
 * here so both POST and the import row schema get the constraint for free.
 */
export const leadCreateSchema = z
  .object({
    name: nameField,
    phone: phoneField.optional(),
    email: emailField.optional(),
    company: companyField.optional(),
    city: cityField.optional(),
    source: leadSourceField.default(LeadSource.MANUAL),
    status: leadStatusField.default(LeadStatus.NEW),
    priority: priorityField.default(Priority.MEDIUM),
    /** Estimated value in INR (SPEC.md §3 comment on `Lead.value`). */
    value: valueField.optional(),
    notes: notesField.optional(),
    tags: tagsField.optional(),
    ownerId: idField.optional(),
    utmSource: utmField.optional(),
    utmMedium: utmField.optional(),
    utmCampaign: utmField.optional(),
    nextFollowUpAt: isoDateTimeField.optional(),
    // v0.1.4 — Chitly-spreadsheet fields. All optional; defaults
    // (`languages: []`, `notOnWhatsapp: false`) mirror the Prisma
    // column defaults so an omitted field round-trips identically
    // whether persisted via this schema or the import schema.
    age: ageField.optional().nullable(),
    activeSince: activeSinceField.optional(),
    languages: languagesField.optional().default([]),
    extraDetails: extraDetailsField.optional(),
    phoneType: phoneTypeField.optional().nullable(),
    notOnWhatsapp: z.coerce.boolean().optional().default(false),
    address: addressField.optional(),
    /**
     * Optional `createdAt` override — admins backdate leads to the date
     * the lead actually came in (matches the "Date" column in the team's
     * Excel sheet). Omit to use the server's `now()`. The CSV import
     * route already supports this; the manual form gets it here too.
     */
    createdAt: isoDateTimeField.optional(),
  })
  .refine((value) => Boolean(value.phone) || Boolean(value.email), {
    message: 'Either phone or email is required',
    path: ['phone'],
  });

export type LeadCreateInput = z.infer<typeof leadCreateSchema>;

// ---------------------------------------------------------------------------
// 2. PATCH /api/leads/[id]
// ---------------------------------------------------------------------------

/**
 * Body schema for `PATCH /api/leads/[id]` (SPEC.md §6.3, §6.4).
 *
 *   • `id` lives on the URL, not in the body.
 *   • Every field is optional — the route handler should treat the
 *     payload as a partial update (Prisma `update({ data })` semantics).
 *   • Status transitions are intentionally unrestricted (SPEC.md §6.4:
 *     "any → any allowed; log every change"). The route handler
 *     is responsible for emitting the `lead.status_changed` activity
 *     log entry with `{from, to}` metadata.
 *   • `convertedAt` is set by the route handler (NOT the client) when
 *     status transitions into `CONVERTED`. We do not accept it here so
 *     the client cannot fabricate conversion timestamps.
 *
 * Reject empty PATCH bodies — they're almost always a client bug, and an
 * "update with no changes" round-trips a row through Prisma for nothing.
 */
export const leadUpdateSchema = z
  .object({
    name: nameField.optional(),
    phone: phoneField.nullable().optional(),
    email: emailField.nullable().optional(),
    company: companyField.nullable().optional(),
    city: cityField.nullable().optional(),
    source: leadSourceField.optional(),
    status: leadStatusField.optional(),
    priority: priorityField.optional(),
    value: valueField.nullable().optional(),
    notes: notesField.nullable().optional(),
    tags: tagsField.optional(),
    ownerId: idField.nullable().optional(),
    utmSource: utmField.nullable().optional(),
    utmMedium: utmField.nullable().optional(),
    utmCampaign: utmField.nullable().optional(),
    nextFollowUpAt: isoDateTimeField.nullable().optional(),
    // v0.1.4 — Chitly-spreadsheet fields. All nullable on PATCH so an
    // operator can clear `age`/`extraDetails` etc. from the detail
    // page; `languages` accepts an empty array as the "clear" signal
    // rather than `null` because the Prisma column is `String[]`.
    age: ageField.nullable().optional(),
    activeSince: activeSinceField.nullable().optional(),
    languages: languagesField.optional(),
    extraDetails: extraDetailsField.nullable().optional(),
    phoneType: phoneTypeField.nullable().optional(),
    notOnWhatsapp: z.coerce.boolean().optional(),
    address: addressField.nullable().optional(),
    /**
     * Optional `createdAt` override — admins can correct a backdated
     * lead's "Date" without nuking-and-recreating the row. Same field
     * the create schema accepts.
     */
    createdAt: isoDateTimeField.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

export type LeadUpdateInput = z.infer<typeof leadUpdateSchema>;

// ---------------------------------------------------------------------------
// 3. GET /api/leads — list with filters + pagination
// ---------------------------------------------------------------------------

/**
 * Comma-separated multi-value parser for query params. `?status=NEW,CONTACTED`
 * yields `['NEW', 'CONTACTED']`; `?status=NEW` yields `['NEW']`. Empty/missing
 * yields `undefined`. Each value is trimmed; empty pieces are dropped so
 * trailing commas don't pollute the result.
 */
function multiEnum<T extends [string, ...string[]]>(values: T) {
  const single = z.enum(values);
  const multi = z.array(single).min(1);
  return z
    .union([single, multi, z.string()])
    .transform((val, ctx): z.infer<typeof single>[] => {
      if (Array.isArray(val)) return val;
      const parts = String(val)
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const out: z.infer<typeof single>[] = [];
      for (const part of parts) {
        const parsed = single.safeParse(part);
        if (!parsed.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid value: ${part}`,
          });
          return z.NEVER;
        }
        out.push(parsed.data);
      }
      if (out.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'At least one value is required',
        });
        return z.NEVER;
      }
      return out;
    });
}

const leadStatusValues = Object.values(LeadStatus) as [LeadStatus, ...LeadStatus[]];
const leadSourceValues = Object.values(LeadSource) as [LeadSource, ...LeadSource[]];
const priorityValues = Object.values(Priority) as [Priority, ...Priority[]];

/** Allowed `sortBy` keys — friendly aliases that the route handler maps
 *  to actual Prisma columns. */
export const LEAD_SORT_KEYS = ['created', 'updated', 'nextFollowUp', 'value'] as const;
export type LeadSortKey = (typeof LEAD_SORT_KEYS)[number];

const leadSortKeyField = z.enum(LEAD_SORT_KEYS);
const sortDirField = z.enum(['asc', 'desc']);

/**
 * Query-string schema for `GET /api/leads` (SPEC.md §6.1, §6.3).
 *
 * Conventions:
 *   • Query params arrive as strings (or `undefined`). `z.coerce` turns
 *     `"42"` into `42` and a missing param into the `default()`.
 *   • Multi-value filters accept either repeated params (Next.js parses
 *     `?status=NEW&status=LOST` into `['NEW', 'LOST']`) or a single
 *     comma-separated value (`?status=NEW,LOST`).
 *   • `dateFrom`/`dateTo` filter on `Lead.createdAt`; the route handler
 *     translates them into a `gte`/`lte` Prisma where clause.
 *   • `tag` filters on `Lead.tags` array containment (Prisma `has`).
 *   • `search` is a single substring matched against name/email/phone/
 *     company by the route handler (`mode: 'insensitive'` `contains`).
 */
export const leadListQuerySchema = z
  .object({
    status: multiEnum(leadStatusValues).optional(),
    source: multiEnum(leadSourceValues).optional(),
    priority: multiEnum(priorityValues).optional(),
    ownerId: idField.optional(),
    search: z
      .string()
      .trim()
      .min(1, 'Search query cannot be empty')
      .max(MAX_SEARCH_LENGTH, `Search query must be ${MAX_SEARCH_LENGTH} characters or fewer`)
      .optional(),
    tag: tagField.optional(),
    dateFrom: isoDateTimeField.optional(),
    dateTo: isoDateTimeField.optional(),
    page: z.coerce
      .number()
      .int('Page must be an integer')
      .positive('Page must be positive')
      .default(DEFAULT_PAGE),
    pageSize: z.coerce
      .number()
      .int('Page size must be an integer')
      .positive('Page size must be positive')
      .max(MAX_PAGE_SIZE, `Page size cannot exceed ${MAX_PAGE_SIZE}`)
      .default(DEFAULT_PAGE_SIZE),
    sortBy: leadSortKeyField.default('created'),
    sortDir: sortDirField.default('desc'),
  })
  .refine(
    (val) => !val.dateFrom || !val.dateTo || val.dateFrom <= val.dateTo,
    { message: 'dateFrom must be on or before dateTo', path: ['dateFrom'] },
  );

export type LeadListQuery = z.infer<typeof leadListQuerySchema>;

// ---------------------------------------------------------------------------
// 4. POST /api/leads/[id]/notes
// ---------------------------------------------------------------------------

/**
 * Body schema for `POST /api/leads/[id]/notes` (SPEC.md §6.3).
 *
 * The route handler (task 32) writes a `Note` row with
 * `entityType: 'lead'`, `entityId: leadId`, `authorId: session.userId`,
 * then logs `lead.note_added` to `ActivityLog`.
 */
export const leadNoteCreateSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Note body is required')
    .max(MAX_NOTE_BODY_LENGTH, `Note must be ${MAX_NOTE_BODY_LENGTH} characters or fewer`),
});

export type LeadNoteCreateInput = z.infer<typeof leadNoteCreateSchema>;

// ---------------------------------------------------------------------------
// 5. POST /api/leads/import — CSV
// ---------------------------------------------------------------------------

/**
 * Pre-process a CSV cell — trim whitespace, treat empty strings as
 * `undefined` so Zod's `.optional()` semantics work the way callers
 * expect (CSVs use `""` for "no value", not literal nulls).
 */
function emptyToUndef(val: unknown): unknown {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Schema for a single row in `POST /api/leads/import` (SPEC.md §6.2.3,
 * §6.4).
 *
 * Columns, in canonical order: `name, phone, email, company, city,
 * source, tags`. Extra columns are silently ignored; missing optional
 * columns are fine.
 *
 *   • `source` is a free-form string mapped to `LeadSource` via
 *     `coerceLeadSource` — unknown values become `OTHER` rather than
 *     bounce the row, since CSV uploads from spreadsheets often have
 *     wonky channel labels.
 *   • `tags` is a semicolon-separated string (commas are reserved as the
 *     CSV column delimiter) split into an array. Empty pieces dropped.
 *   • `phone || email` is enforced per SPEC.md §6.4.
 */
export const leadCsvRowSchema = z
  .object({
    name: z.preprocess(emptyToUndef, nameField),
    phone: z.preprocess(emptyToUndef, phoneField.optional()),
    email: z.preprocess(emptyToUndef, emailField.optional()),
    company: z.preprocess(emptyToUndef, companyField.optional()),
    city: z.preprocess(emptyToUndef, cityField.optional()),
    source: z.preprocess(
      emptyToUndef,
      z
        .string()
        .transform((val) => coerceLeadSource(val))
        .optional()
        .default(LeadSource.MANUAL),
    ),
    tags: z.preprocess(
      emptyToUndef,
      z
        .string()
        .transform((val) =>
          val
            .split(';')
            .map((t) => t.trim())
            .filter(Boolean),
        )
        .pipe(tagsField)
        .optional()
        .default([]),
    ),
    notes: z.preprocess(emptyToUndef, notesField.optional()),
    // v0.1.4 — Chitly-spreadsheet columns. These are intentionally
    // permissive — the CSV import is a "capture, don't reject" path:
    // unparseable cells degrade to a safe default rather than failing
    // the row, which would lose the rest of the data the operator
    // typed in.
    value: z.preprocess(
      emptyToUndef,
      z.coerce
        .number()
        .finite('Value must be a finite number')
        .min(0, 'Value must be non-negative')
        .max(MAX_VALUE, `Value must be ${MAX_VALUE} or less`)
        .optional(),
    ),
    priority: z.preprocess(
      emptyToUndef,
      z
        .string()
        .transform((val) => val.trim().toUpperCase())
        .pipe(priorityField)
        .optional(),
    ),
    age: z.preprocess(
      (val) => {
        // Empty strings collapse to undefined so `.optional()` kicks
        // in instead of `z.coerce.number()` parsing `""` → NaN.
        if (typeof val === 'string' && val.trim().length === 0) {
          return undefined;
        }
        return val;
      },
      ageField.optional(),
    ),
    activeSince: z.preprocess(emptyToUndef, activeSinceField.optional()),
    languages: z.preprocess(
      emptyToUndef,
      z
        .string()
        .transform((val) =>
          // Comma-separated for the spreadsheet ("Hindi, Marathi, English");
          // semicolons also accepted for symmetry with the `tags` column.
          val
            .split(/[;,]/)
            .map((l) => l.trim())
            .filter(Boolean),
        )
        .pipe(languagesField)
        .optional()
        .default([]),
    ),
    extraDetails: z.preprocess(emptyToUndef, extraDetailsField.optional()),
    phoneType: z.preprocess(
      coercePhoneType,
      phoneTypeField.optional(),
    ),
    notOnWhatsapp: z.preprocess(
      coerceNotOnWhatsapp,
      z.boolean().optional().default(false),
    ),
    address: z.preprocess(emptyToUndef, addressField.optional()),
    /** Optional `createdAt` override — the importer accepts a parsed
     *  `Date` here, set by the route handler from the CSV's "Date"
     *  column. Routed through `z.coerce.date()` so ISO strings sent
     *  by future API clients also work. Falls back to `now()` in the
     *  route when absent or unparseable. */
    createdAt: z.preprocess(
      emptyToUndef,
      z.coerce.date().optional(),
    ),
  })
  .refine((value) => Boolean(value.phone) || Boolean(value.email), {
    message: 'Either phone or email is required',
    path: ['phone'],
  });

export type LeadCsvRowInput = z.infer<typeof leadCsvRowSchema>;

/**
 * Top-level body schema for `POST /api/leads/import`.
 *
 * The route handler (task 33) is responsible for:
 *   1. Streaming CSV → array of objects (papaparse, header row required).
 *   2. Validating each object via `leadCsvRowSchema`.
 *   3. Deduping the validated rows on `(phone, email)` against existing
 *      `Lead` rows AND within the upload itself.
 *   4. Reporting per-row errors before commit (SPEC.md §6.4).
 *
 * `MAX_CSV_ROWS` (1 000) is the SPEC.md §6.4 hard cap — beyond that the
 * route returns 413 with a friendly error.
 */
export const leadCsvImportSchema = z.object({
  rows: z
    .array(leadCsvRowSchema)
    .min(1, 'At least one row is required')
    .max(MAX_CSV_ROWS, `CSV import is limited to ${MAX_CSV_ROWS} rows per upload`),
});

export type LeadCsvImportInput = z.infer<typeof leadCsvImportSchema>;

// ---------------------------------------------------------------------------
// 6. POST /api/webhooks/leads — public, HMAC-signed
// ---------------------------------------------------------------------------

/**
 * Body schema for `POST /api/webhooks/leads` (SPEC.md §6.2.7, §6.2.8,
 * §6.3).
 *
 * This is the public-facing shape — third-party form integrations send
 * snake_case fields. The transform at the bottom maps them onto the
 * internal Lead column names so the route handler can hand the result
 * straight to Prisma after attaching `createdById` and `source`.
 *
 * Notes:
 *   • HMAC verification happens BEFORE this schema runs — see task 34.
 *   • `source` arrives as a free-form string and is coerced to
 *     `LeadSource` via `coerceLeadSource`. Unknown strings become
 *     `OTHER`, matching CSV behavior.
 *   • `page` is the referring URL captured by the form widget. We don't
 *     store it on `Lead` directly (no column for it) but it's a useful
 *     debugging aid in the webhook activity log.
 *   • `tags` is an optional array; we accept either an array of strings
 *     or a semicolon-separated string for clients that can't send JSON
 *     arrays.
 */
const tagsFromWebhook = z
  .union([
    z.array(tagField),
    z.string().transform((val) =>
      val
        .split(/[;,]/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ])
  .pipe(tagsField);

/**
 * Accept languages as either an array of strings or a single
 * comma/semicolon-separated string ("Hindi, English"). Mirrors the
 * `tagsFromWebhook` pattern so embedded forms can send whichever shape
 * is easier to produce on the client.
 */
const languagesFromWebhook = z
  .union([
    z.array(languageField),
    z.string().transform((val) =>
      val
        .split(/[;,]/)
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ])
  .pipe(languagesField);

export const leadWebhookSchema = z
  .object({
    name: nameField,
    phone: phoneField.optional(),
    email: emailField.optional(),
    company: companyField.optional(),
    city: cityField.optional(),
    source: leadSourceFromStringField.optional(),
    utm_source: utmField.optional(),
    utm_medium: utmField.optional(),
    utm_campaign: utmField.optional(),
    /** Referring page URL captured by the embed snippet (for context
     *  only — not persisted on `Lead`). */
    page: urlField.optional(),
    notes: notesField.optional(),
    tags: tagsFromWebhook.optional(),
    // v0.1.4 — Chitly-spreadsheet fields. snake_case for the public
    // wire format (mirrors `utm_source` above); the transform below
    // maps them to internal camelCase column names so the route
    // handler can hand the result straight to Prisma.
    age: ageField.optional(),
    active_since: activeSinceField.optional(),
    languages: languagesFromWebhook.optional(),
    extra_details: extraDetailsField.optional(),
    phone_type: z.preprocess(coercePhoneType, phoneTypeField.optional()),
    not_on_whatsapp: z.preprocess(
      coerceNotOnWhatsapp,
      z.boolean().optional().default(false),
    ),
    address: addressField.optional(),
  })
  .refine((value) => Boolean(value.phone) || Boolean(value.email), {
    message: 'Either phone or email is required',
    path: ['phone'],
  })
  .transform((val) => ({
    name: val.name,
    phone: val.phone,
    email: val.email,
    company: val.company,
    city: val.city,
    source: val.source ?? LeadSource.OTHER,
    utmSource: val.utm_source,
    utmMedium: val.utm_medium,
    utmCampaign: val.utm_campaign,
    referringPage: val.page,
    notes: val.notes,
    tags: val.tags ?? [],
    age: val.age,
    activeSince: val.active_since,
    languages: val.languages ?? [],
    extraDetails: val.extra_details,
    phoneType: val.phone_type,
    notOnWhatsapp: val.not_on_whatsapp,
    address: val.address,
  }));

export type LeadWebhookInput = z.infer<typeof leadWebhookSchema>;

// ---------------------------------------------------------------------------
// 7. Public projection — what we expose to API consumers
// ---------------------------------------------------------------------------

/**
 * Prisma `select` mask for safely returning lead rows over the wire.
 * Used by every read endpoint that returns lead data so the embedded
 * `owner` relation is consistent and `passwordHash` is implicitly
 * excluded (SPEC.md §2.2).
 *
 * Marked `as const` so changes to the Prisma model surface as TypeScript
 * errors at the call site first.
 */
export const leadPublicProjection = {
  id: true,
  name: true,
  phone: true,
  email: true,
  company: true,
  city: true,
  source: true,
  status: true,
  priority: true,
  value: true,
  notes: true,
  tags: true,
  ownerId: true,
  createdById: true,
  utmSource: true,
  utmMedium: true,
  utmCampaign: true,
  nextFollowUpAt: true,
  convertedAt: true,
  createdAt: true,
  updatedAt: true,
  // v0.1.4 — Chitly-spreadsheet columns surfaced on every read so the
  // detail page, list table, and CSV-export endpoints all see the
  // same shape.
  age: true,
  activeSince: true,
  languages: true,
  extraDetails: true,
  phoneType: true,
  notOnWhatsapp: true,
  address: true,
  owner: {
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      avatarUrl: true,
    },
  },
} as const;

/**
 * Embedded owner shape exposed inside `LeadPublic`. Mirrors the columns
 * picked by `leadPublicProjection.owner.select`.
 */
export type LeadOwnerEmbed = {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'EMPLOYEE';
  avatarUrl: string | null;
};

/**
 * The shape of a lead record after running through `leadPublicProjection`.
 * Kept as a structural type rather than a Prisma `Pick` so consumers
 * don't have to import the Prisma `Lead` type just to type a response.
 */
export type LeadPublic = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  company: string | null;
  city: string | null;
  source: LeadSource;
  status: LeadStatus;
  priority: Priority;
  value: number | null;
  notes: string | null;
  tags: string[];
  ownerId: string | null;
  createdById: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  nextFollowUpAt: Date | null;
  convertedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // v0.1.4 — Chitly-spreadsheet fields. `phoneType` is stored as
  // `String?` server-side but is restricted to `PhoneType` on the
  // write path, so reads observe the same fixed set in practice.
  age: number | null;
  activeSince: string | null;
  languages: string[];
  extraDetails: string | null;
  phoneType: PhoneType | string | null;
  notOnWhatsapp: boolean;
  address: string | null;
  owner: LeadOwnerEmbed | null;
};
