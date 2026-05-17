/**
 * `POST /api/leads/import` — bulk lead import from a parsed CSV.
 *
 * SPEC.md §6.2 (feature 3 "CSV import with deduplication on phone+email")
 * and §6.4 ("CSV import: max 1000 rows per upload; show row-by-row errors
 * before commit"; "Either phone OR email required").
 *
 * **Wire format — JSON only (no multipart).** The upload page
 * (`/leads/import`, task 39) parses the CSV in the browser using
 * papaparse and POSTs the resulting array of objects as JSON. Keeping
 * the server JSON-only avoids streaming a multipart body through the
 * Next.js Edge → Node bridge, sidesteps inconsistent encoding handling
 * across browsers, and gives us a single validation contract
 * (`leadCsvImportSchema`) that the form preview can also use to render
 * row-level errors before submit. If we ever need to accept a raw
 * file (e.g., for an external integration that can't parse CSV
 * client-side), it should land at a sibling endpoint
 * (`/api/leads/import/upload`) so this route's dedupe + activity
 * logging stay easy to reason about.
 *
 * **Authorization (SPEC.md §2.1, §6.4).** Any authenticated user may
 * import leads. The middleware already 401s anonymous traffic; this
 * handler doesn't add a role gate. All imported rows are stamped with
 * `createdById = session.userId` and `ownerId = session.userId`
 * (employees can only assign new leads to themselves — see
 * `POST /api/leads`). Admin-bulk-assign-on-import is intentionally not
 * supported; reassign post-import via PATCH if needed.
 *
 * **Validation strategy.** The body is `{ rows: [...] }`. We validate:
 *   1. `rows.length` ∈ [1, `MAX_CSV_ROWS`] (1 000 — SPEC.md §6.4).
 *      Out-of-range → 400.
 *   2. Each row is fed through `leadCsvRowSchema` *individually* (NOT
 *      via `leadCsvImportSchema`, which fails the whole batch on a
 *      single bad row). Failures are collected per `rowIndex` and
 *      returned in the `errors[]` array — never abort the import on a
 *      single bad row. SPEC.md §6.4 explicitly: "show row-by-row
 *      errors before commit".
 *
 * **Dedupe (SPEC.md §6.2 #3, §6.4).** Two-stage:
 *   1. *Within the upload* — keyed on lowercased email and
 *      digit-only normalized phone. The first occurrence of any
 *      given key wins; subsequent rows sharing that key go into the
 *      `duplicates[]` array. We dedupe within the upload BEFORE
 *      hitting the DB so a 1 000-row file with 900 in-batch dupes
 *      doesn't trigger 900 unnecessary DB compare round-trips.
 *   2. *Against existing leads* — a single Prisma query for any
 *      existing `Lead` where `email IN (lowercaseEmails)` OR
 *      `phone IN (rawPhones)`. Matching rows are skipped and added to
 *      `duplicates[]`. We compare email case-insensitively (the
 *      schema lowercases emails on both write and read paths) and
 *      compare phone by exact raw match — a phone formatted
 *      differently from the DB row will sneak through. The browser
 *      preview UI surfaces this on the next import, and the operator
 *      can reformat. Beyond v1, a normalized-phone column would close
 *      this gap definitively.
 *
 * **Persistence.** Valid, non-duplicate rows commit via
 * `prisma.lead.createMany({ data: [...], skipDuplicates: false })`.
 * `Lead` has no application-level unique constraints on email or phone
 * (SPEC.md §3) — the dedupe stage above is the only one that runs —
 * so `skipDuplicates: false` is the safe default; no row is silently
 * dropped after we already classified it.
 *
 * **Activity logging.** One `LEAD_IMPORTED` row per import (success or
 * partial), with metadata `{ rowsTotal, rowsImported, rowsSkipped }`
 * matching `LeadImportedMeta` in `src/lib/activity.ts`. Logging is
 * best-effort (try/catch) so a missing audit row never fails an
 * otherwise successful import (SPEC.md §14).
 *
 * **Response (200).**
 *
 *   {
 *     totalRows:    number,                                   // body row count
 *     importedRows: number,                                   // rows actually inserted
 *     skippedRows:  number,                                   // duplicates.length + errors.length
 *     duplicates:   [{ rowIndex, name, email?, phone?, reason }],
 *     errors:       [{ rowIndex, error, issues? }]
 *   }
 *
 * Note: the route returns 200 (not 207) even on partial failure — the
 * import endpoint is "best-effort by design" per SPEC.md §6.4.
 * Clients should always inspect `errors[]` and `duplicates[]` instead
 * of relying on status alone.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { errorResponse, parseJsonBody, requireSession } from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import {
  MAX_CSV_ROWS,
  leadCsvRowSchema,
  type LeadCsvRowInput,
} from '@/lib/schemas/leads';

// ---------------------------------------------------------------------------
// Server-side header recognition (v0.1.4)
// ---------------------------------------------------------------------------

/**
 * Canonical lead fields the row schema understands. Keep in sync with
 * `leadCsvRowSchema`'s top-level keys in `src/lib/schemas/leads.ts`.
 *
 * Used by `canonicalizeRow` to translate spreadsheet column headers
 * (which arrive verbatim from the upload UI's auto-detect *or* from a
 * direct API caller that hasn't pre-mapped its CSV) onto the schema's
 * canonical key names. Pre-mapped payloads — where every key is already
 * a canonical field name — pass through unchanged because each
 * canonical name is also listed as a synonym for itself.
 */
const CANONICAL_FIELDS = [
  'name',
  'phone',
  'email',
  'company',
  'city',
  'source',
  'tags',
  'notes',
  'value',
  'priority',
  'age',
  'activeSince',
  'languages',
  'extraDetails',
  'phoneType',
  'notOnWhatsapp',
  'address',
  'createdAt',
] as const;
type CanonicalField = (typeof CANONICAL_FIELDS)[number];

/**
 * Normalize a header string for case/whitespace/punctuation-insensitive
 * lookup. Lowercases, strips trailing colons (some spreadsheets render
 * headers as "Phone Type:"), strips everything that isn't a letter or
 * digit. This must match the keys used in `HEADER_ALIASES` below.
 */
function normalizeHeader(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[:#]+$/, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Lookup table mapping normalized header variants to the canonical
 * field name. Each canonical field lists every spreadsheet phrasing
 * we've seen in the Chitly team's existing imports (see SPEC v0.1.4 +
 * the Excel screenshot the user shared).
 *
 * Built as a const lookup at module load so per-row canonicalization
 * is O(headers) per row, not O(headers × variants).
 */
const HEADER_ALIASES: Record<string, CanonicalField> = (() => {
  const variants: Record<CanonicalField, string[]> = {
    name: ['name', 'fullname', 'leadname', 'contactname', 'firstname'],
    phone: [
      'phone',
      'phonenumber',
      'mobile',
      'mobilenumber',
      'cell',
      'whatsapp',
      'whatsappnumber',
      'whatsapptelegramcontact',
      'whatsapptelegram',
      'whatsappcontact',
      'telegramcontact',
      'contact',
      'tel',
      'telephone',
    ],
    email: ['email', 'emailaddress', 'mail', 'emailid'],
    company: [
      'company',
      'organization',
      'organisation',
      'org',
      'business',
      'companyname',
    ],
    city: ['city', 'town'],
    source: ['source', 'leadsource', 'channel'],
    tags: ['tags', 'labels', 'tag'],
    notes: ['notes', 'note', 'longnotes', 'comments'],
    value: ['value', 'inrvalue', 'estimatedvalue', 'dealvalue', 'amount'],
    priority: ['priority'],
    // v0.1.4 spreadsheet columns
    age: ['age'],
    activeSince: ['activesince', 'since', 'active'],
    languages: ['language', 'languages', 'lang', 'langs'],
    extraDetails: [
      'extradetails',
      'details',
      'notesbrief',
      'briefnotes',
      'context',
    ],
    phoneType: ['phonetype', 'device', 'devicetype', 'phoneos'],
    notOnWhatsapp: [
      'notonwhatsapp',
      'nowhatsapp',
      'whatsappabsent',
      'nowa',
    ],
    address: ['address', 'addr', 'location', 'fulladdress', 'streetaddress'],
    createdAt: ['date', 'created', 'createdat', 'createdon', 'createddate'],
  };

  const out: Record<string, CanonicalField> = {};
  for (const field of CANONICAL_FIELDS) {
    for (const variant of variants[field]) {
      out[variant] = field;
    }
  }
  return out;
})();

/**
 * Accept multiple date formats commonly produced by spreadsheets:
 *
 *   • Native `Date` instance (passed straight through).
 *   • ISO 8601 — `2026-01-31`, `2026-01-31T03:00:00Z`. Native `Date`.
 *   • US slash — `1/31/2026`, `01/31/2026`. Disambiguated by year
 *     position (4-digit year wins).
 *   • Excel month abbreviation — `31-Jan-2026`. Manually parsed.
 *
 * Returns `undefined` (NOT throws) when parsing fails so the route
 * can fall back to `now()` rather than rejecting the whole row —
 * preserving operator intent on partial data ("import even if I
 * mis-formatted the date column").
 */
const MONTH_ABBREV: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseSpreadsheetDate(raw: unknown): Date | undefined {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? undefined : raw;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  // 31-Jan-2026 / 31 Jan 2026 / Jan-31-2026
  const abbrev = trimmed.match(
    /^(?:(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-]+(\d{4}))$/,
  );
  if (abbrev) {
    const day = Number(abbrev[1]);
    const monthKey = abbrev[2]!.slice(0, 3).toLowerCase();
    const year = Number(abbrev[3]);
    const month = MONTH_ABBREV[monthKey];
    if (month !== undefined && Number.isFinite(day) && Number.isFinite(year)) {
      const d = new Date(Date.UTC(year, month, day));
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  // M/D/YYYY (US) — disambiguate by 4-digit year position.
  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    const year = Number(slash[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(Date.UTC(year, month - 1, day));
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  // ISO / anything else `new Date` understands.
  const fallback = new Date(trimmed);
  if (!Number.isNaN(fallback.getTime())) return fallback;
  return undefined;
}

/**
 * Translate a raw inbound row (keys may be CSV header names OR
 * canonical field names) into a canonical-keyed object ready for
 * `leadCsvRowSchema`. Unknown headers are silently dropped.
 *
 * If multiple input keys map to the same canonical field (e.g. both
 * `"Phone"` and `"WhatsApp"` columns exist in the source CSV), the
 * first non-empty value wins — operators typically duplicate the
 * column for visibility, not to provide different values.
 *
 * The `createdAt` column is parsed into a `Date` here rather than at
 * the Zod layer because the date formats accepted (`31-Jan-2026`,
 * `1/31/2026`) require multi-format parsing logic that doesn't belong
 * in a schema field. Unparseable dates degrade to `undefined`, which
 * the route then translates to "use now()".
 */
function canonicalizeRow(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalized = normalizeHeader(key);
    const canonical = HEADER_ALIASES[normalized];
    if (!canonical) continue;
    // First-non-empty-value-wins: an existing non-empty value isn't
    // overwritten by a later alias hit.
    const existing = out[canonical];
    const existingHasValue =
      existing !== undefined &&
      existing !== null &&
      !(typeof existing === 'string' && existing.trim().length === 0);
    if (existingHasValue) continue;

    if (canonical === 'createdAt') {
      const parsed = parseSpreadsheetDate(value);
      if (parsed !== undefined) out[canonical] = parsed;
      continue;
    }
    out[canonical] = value;
  }
  return out;
}

// Force the Node runtime — Prisma is not Edge-compatible.
export const runtime = 'nodejs';

// Each request must hit the database; never serve a cached response.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Body envelope schema
// ---------------------------------------------------------------------------

/**
 * Top-level body schema for `POST /api/leads/import`.
 *
 * We deliberately do NOT compose `leadCsvRowSchema` into this schema
 * — Zod's `z.array(...)` semantics fail the whole parse on the first
 * invalid element, which would prevent us from returning row-level
 * errors. Instead, we accept each row as `unknown` here and validate
 * it individually below so we can collect a per-row error report
 * (SPEC.md §6.4 "show row-by-row errors before commit").
 */
const importBodySchema = z.object({
  rows: z
    .array(z.unknown())
    .min(1, 'At least one row is required')
    .max(MAX_CSV_ROWS, `CSV import is limited to ${MAX_CSV_ROWS} rows per upload`),
});

// ---------------------------------------------------------------------------
// Response shape (informal; documented above)
// ---------------------------------------------------------------------------

interface RowError {
  rowIndex: number;
  error: string;
  issues?: z.ZodIssue[];
}

interface RowDuplicate {
  rowIndex: number;
  name: string;
  email?: string;
  phone?: string;
  reason: 'duplicate_in_upload' | 'duplicate_in_database';
}

interface ImportSummary {
  totalRows: number;
  importedRows: number;
  skippedRows: number;
  duplicates: RowDuplicate[];
  errors: RowError[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip everything that isn't a digit. Used to compare phone numbers
 * across formatting variations within an upload (e.g., `"(555) 123-4567"`
 * and `"555-123-4567"` both normalize to `"5551234567"`).
 *
 * Returns `undefined` when the input has no digits at all so callers
 * can treat it as "no comparable phone".
 */
function normalizePhone(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, '');
  return digits.length > 0 ? digits : undefined;
}

/**
 * Lower-case + trim an email. The schema already lowercases emails on
 * read, but defensive normalization here means the dedupe key is
 * stable even if a row somehow arrives un-normalized (e.g., a future
 * caller bypasses the schema).
 */
function normalizeEmail(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A single row that passed `leadCsvRowSchema` plus its original index
 *  in the request body. The index travels with the row through dedupe
 *  so duplicate/error reports can point operators to the offending CSV
 *  row 1:1. */
interface ValidRow {
  rowIndex: number;
  data: LeadCsvRowInput;
}

// ---------------------------------------------------------------------------
// POST /api/leads/import
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireSession();

    const { rows } = await parseJsonBody(req, importBodySchema);

    const totalRows = rows.length;
    const errors: RowError[] = [];
    const duplicates: RowDuplicate[] = [];

    // -- 1. Per-row schema validation ----------------------------------------
    //
    // Validate each row independently so a single bad row produces a
    // targeted `errors[]` entry rather than aborting the batch. Each
    // row is canonicalized first (header aliases → canonical field
    // names) so callers can post either a pre-mapped object (the
    // upload UI's path) or a raw-CSV object keyed by spreadsheet
    // headers (external integrations / direct API callers).
    const validRows: ValidRow[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const canonical = canonicalizeRow(rows[i]);
      const parsed = leadCsvRowSchema.safeParse(canonical);
      if (!parsed.success) {
        // Use the first issue's message as the human summary; the
        // full issue list ships in `issues` for clients that want to
        // render a richer error UI.
        const firstIssue = parsed.error.issues[0];
        errors.push({
          rowIndex: i,
          error: firstIssue?.message ?? 'Validation failed',
          issues: parsed.error.issues,
        });
        continue;
      }
      validRows.push({ rowIndex: i, data: parsed.data });
    }

    // -- 2. In-upload dedupe -------------------------------------------------
    //
    // First-occurrence wins. We track two keyed sets — one for emails
    // (lowercased) and one for phones (digit-only). A row is a
    // duplicate if EITHER key is already seen. The schema guarantees
    // every valid row has at least one of phone/email, so at least
    // one key is always available.
    const seenEmails = new Set<string>();
    const seenPhones = new Set<string>();
    const dedupedInUpload: ValidRow[] = [];

    for (const row of validRows) {
      const emailKey = normalizeEmail(row.data.email);
      const phoneKey = normalizePhone(row.data.phone);

      const emailDup = emailKey !== undefined && seenEmails.has(emailKey);
      const phoneDup = phoneKey !== undefined && seenPhones.has(phoneKey);

      if (emailDup || phoneDup) {
        duplicates.push({
          rowIndex: row.rowIndex,
          name: row.data.name,
          email: row.data.email,
          phone: row.data.phone,
          reason: 'duplicate_in_upload',
        });
        continue;
      }

      // Add this row's keys AFTER the duplicate check so the first
      // occurrence is the survivor; subsequent rows with overlapping
      // keys go to `duplicates[]`.
      if (emailKey !== undefined) seenEmails.add(emailKey);
      if (phoneKey !== undefined) seenPhones.add(phoneKey);
      dedupedInUpload.push(row);
    }

    // -- 3. Cross-check against existing leads -------------------------------
    //
    // Build the candidate sets from the survivors of stage 2 only —
    // that's the smallest input and avoids re-checking rows we've
    // already classified as duplicates.
    const candidateEmails = Array.from(
      new Set(
        dedupedInUpload
          .map((r) => normalizeEmail(r.data.email))
          .filter((e): e is string => e !== undefined),
      ),
    );
    const candidatePhones = Array.from(
      new Set(
        dedupedInUpload
          .map((r) => r.data.phone)
          .filter((p): p is string => p !== undefined && p.length > 0),
      ),
    );

    // Skip the query entirely when there's nothing to look up — saves
    // a network round-trip for the empty-survivor case (e.g., 100%
    // duplicates within the upload itself).
    let existingEmails = new Set<string>();
    let existingPhones = new Set<string>();
    if (candidateEmails.length > 0 || candidatePhones.length > 0) {
      // OR branches with empty arrays would be `email IN ()` which
      // Postgres rejects; build the OR list dynamically so each
      // branch only appears when it has at least one value.
      const orFilters: { email?: { in: string[] }; phone?: { in: string[] } }[] = [];
      if (candidateEmails.length > 0) {
        orFilters.push({ email: { in: candidateEmails } });
      }
      if (candidatePhones.length > 0) {
        orFilters.push({ phone: { in: candidatePhones } });
      }

      const existing = await prisma.lead.findMany({
        where: { OR: orFilters },
        select: { email: true, phone: true },
      });

      // Build comparison sets up-front so the per-row check is O(1).
      // Existing emails are normalized so the comparison is
      // case-insensitive even when DB hygiene slips on legacy rows.
      existingEmails = new Set(
        existing
          .map((row) => normalizeEmail(row.email ?? undefined))
          .filter((e): e is string => e !== undefined),
      );
      existingPhones = new Set(
        existing
          .map((row) => row.phone ?? undefined)
          .filter((p): p is string => p !== undefined && p.length > 0),
      );
    }

    // -- 4. Final survivors -------------------------------------------------
    const toInsert: ValidRow[] = [];
    for (const row of dedupedInUpload) {
      const emailKey = normalizeEmail(row.data.email);
      const phoneKey = row.data.phone;

      const emailDup = emailKey !== undefined && existingEmails.has(emailKey);
      const phoneDup = phoneKey !== undefined && existingPhones.has(phoneKey);

      if (emailDup || phoneDup) {
        duplicates.push({
          rowIndex: row.rowIndex,
          name: row.data.name,
          email: row.data.email,
          phone: row.data.phone,
          reason: 'duplicate_in_database',
        });
        continue;
      }
      toInsert.push(row);
    }

    // -- 5. Insert ---------------------------------------------------------
    //
    // `createMany` is the right tool — single statement, no per-row
    // round-trips. We've already deduped, so `skipDuplicates: false`
    // is intentional: any row that reaches this point is expected to
    // commit, and silently dropping one would mask a bug. (Lead has
    // no DB-level unique constraints on email/phone anyway, so this
    // flag has no effective behavior here — we set it explicitly for
    // documentation.)
    let importedRows = 0;
    if (toInsert.length > 0) {
      const result = await prisma.lead.createMany({
        data: toInsert.map((row) => ({
          name: row.data.name,
          // Optional fields: only attach when present so Prisma
          // applies its column defaults (NULL/empty) for absent ones.
          ...(row.data.phone !== undefined ? { phone: row.data.phone } : {}),
          ...(row.data.email !== undefined ? { email: row.data.email } : {}),
          ...(row.data.company !== undefined ? { company: row.data.company } : {}),
          ...(row.data.city !== undefined ? { city: row.data.city } : {}),
          source: row.data.source,
          tags: row.data.tags,
          ...(row.data.notes !== undefined ? { notes: row.data.notes } : {}),
          ...(row.data.value !== undefined ? { value: row.data.value } : {}),
          ...(row.data.priority !== undefined ? { priority: row.data.priority } : {}),
          // v0.1.4 — Chitly-spreadsheet columns. The schema's defaults
          // (`languages: []`, `notOnWhatsapp: false`) are applied
          // unconditionally so the column shape stays predictable
          // even when a row's CSV omitted the field entirely.
          ...(row.data.age !== undefined ? { age: row.data.age } : {}),
          ...(row.data.activeSince !== undefined
            ? { activeSince: row.data.activeSince }
            : {}),
          languages: row.data.languages,
          ...(row.data.extraDetails !== undefined
            ? { extraDetails: row.data.extraDetails }
            : {}),
          ...(row.data.phoneType !== undefined
            ? { phoneType: row.data.phoneType }
            : {}),
          notOnWhatsapp: row.data.notOnWhatsapp,
          ...(row.data.address !== undefined ? { address: row.data.address } : {}),
          // Honour an operator-provided `Date` column so the imported
          // pipeline reflects the original lead capture order — useful
          // when an existing-spreadsheet operator is back-filling.
          // `createMany` accepts `createdAt` directly (Prisma's default
          // is `now()` which is only applied when the field is absent).
          ...(row.data.createdAt !== undefined
            ? { createdAt: row.data.createdAt }
            : {}),
          ownerId: session.userId,
          createdById: session.userId,
        })),
        skipDuplicates: false,
      });
      importedRows = result.count;
    }

    const skippedRows = duplicates.length + errors.length;

    // -- 6. Activity log (best-effort) -------------------------------------
    //
    // Single `LEAD_IMPORTED` row summarising the batch — there's no
    // single lead to point at, so we use a synthetic `entityId`
    // marker (`'csv-import'`) and omit `leadId`. The format helper in
    // `activity.ts` reads `rowsImported`/`rowsSkipped` out of metadata
    // and renders "User imported N leads (M skipped)".
    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.LEAD_IMPORTED,
        entityType: 'lead',
        entityId: 'csv-import',
        metadata: {
          rowsTotal: totalRows,
          rowsImported: importedRows,
          rowsSkipped: skippedRows,
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/leads/import] activity log failed', logErr);
    }

    const summary: ImportSummary = {
      totalRows,
      importedRows,
      skippedRows,
      duplicates,
      errors,
    };

    return NextResponse.json(summary);
  } catch (err) {
    return errorResponse(err);
  }
}
