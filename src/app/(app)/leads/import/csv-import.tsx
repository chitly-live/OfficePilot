'use client';

/**
 * CsvImport — `/leads/import` client workflow.
 *
 * Implements the 4-stage flow called out in SPEC §6.2.3 and task 39:
 *
 *   1. **Upload** — file input (.csv only) pipes the file into
 *      `papaparse` with `header: true`. We parse in the browser so the
 *      `/api/leads/import` route stays JSON-only (see route file-level
 *      JSDoc for the rationale).
 *   2. **Map** — the parsed header row is rendered next to a target
 *      lead-field select. Mappings are auto-guessed from the header
 *      name (e.g. "Phone Number" → `phone`) so a well-formed CSV
 *      typically needs no manual intervention.
 *   3. **Preview** — the first 10 rows are rendered using the active
 *      mapping. A validation panel reports row counts (valid /
 *      missing-required / duplicate within file) so the operator can
 *      catch problems before the network round-trip.
 *   4. **Commit** — the "Import" button posts the mapped rows to
 *      `POST /api/leads/import`. The server response (totalRows,
 *      importedRows, skippedRows, duplicates[], errors[]) is rendered
 *      inline so the operator can resolve flagged rows and re-import
 *      if needed.
 *
 * Why a client-only flow? The spec mandates a "column mapping preview"
 * step. Doing this on the server would mean a second upload after the
 * mapping is chosen; doing it in the browser keeps the iteration loop
 * tight and matches the SPEC §13.4 dense, internal-tool feel.
 *
 * The component intentionally keeps file parsing isolated to the
 * upload step. Re-mapping never re-parses the CSV — the parsed rows
 * stay in component state, the preview just re-derives from them.
 */

import * as React from 'react';
import Link from 'next/link';
import Papa, { type ParseResult } from 'papaparse';
import { ArrowLeft, FileWarning, Loader2, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SPEC §6.4: max 1 000 rows per upload — enforced server-side too,
 *  but checking here means we can refuse a 10 000-row file instantly. */
const MAX_ROWS = 1000;

/** Number of rows to render in the preview table. The mapping UX only
 *  needs a handful of rows to convey what's happening. */
const PREVIEW_ROW_COUNT = 10;

/** Sentinel value used by the mapping `Select` to express "ignore
 *  this CSV column". Radix `SelectItem` can't have an empty string
 *  value, so we use a sentinel and translate it to `null` in state. */
const UNMAPPED = '__unmapped__';

// ---------------------------------------------------------------------------
// Target field model
// ---------------------------------------------------------------------------

/**
 * The target lead fields the import API understands (per the route's
 * `leadCsvRowSchema`). Order here drives the order in the mapping UI
 * and the preview table.
 *
 * v0.1.4 — extended with the 7 spreadsheet fields (`age`, `activeSince`,
 * `languages`, `extraDetails`, `phoneType`, `notOnWhatsapp`, `address`)
 * and a `date` column so an import of the Chitly team's existing
 * spreadsheet auto-maps cleanly.
 */
type LeadField =
  | 'name'
  | 'phone'
  | 'email'
  | 'company'
  | 'city'
  | 'address'
  | 'age'
  | 'activeSince'
  | 'languages'
  | 'extraDetails'
  | 'phoneType'
  | 'notOnWhatsapp'
  | 'source'
  | 'tags'
  | 'createdAt';

const LEAD_FIELDS: ReadonlyArray<{
  key: LeadField;
  label: string;
  required: boolean;
  hint?: string;
}> = [
  { key: 'createdAt', label: 'Date', required: false, hint: 'When the lead came in — e.g. 31-Jan-2026' },
  { key: 'name', label: 'Name', required: true },
  { key: 'phone', label: 'Phone', required: false, hint: 'Phone or email required' },
  { key: 'email', label: 'Email', required: false, hint: 'Phone or email required' },
  { key: 'company', label: 'Company', required: false },
  { key: 'city', label: 'City', required: false },
  { key: 'address', label: 'Address', required: false, hint: 'Free-form' },
  { key: 'age', label: 'Age', required: false, hint: 'Whole number' },
  { key: 'activeSince', label: 'Active Since', required: false, hint: 'e.g. "10 Days"' },
  { key: 'languages', label: 'Languages', required: false, hint: 'Comma-separated' },
  { key: 'extraDetails', label: 'Extra Details', required: false },
  { key: 'phoneType', label: 'Phone Type', required: false, hint: 'iPhone / Android / Other' },
  { key: 'notOnWhatsapp', label: 'Not on WhatsApp', required: false, hint: 'true / false / yes / no' },
  { key: 'source', label: 'Source', required: false, hint: 'Defaults to MANUAL' },
  { key: 'tags', label: 'Tags', required: false, hint: 'Semicolon-separated' },
];

/**
 * Auto-mapping table. Each entry is a list of normalized header names
 * (lowercased, alphanumerics only) that should map to the given
 * lead field. The order matters: the first match wins, so we put the
 * canonical names first and looser variants after.
 *
 * v0.1.4 — added hints for `address`, `age`, `activeSince`, `languages`,
 * `extraDetails`, `phoneType`, `notOnWhatsapp`. The `phone` hints
 * include `whatsappnumber` / `whatsapptelegramcontact` so the Chitly
 * team's "WhatsApp/Telegram Contact" header auto-maps to phone.
 */
const HEADER_HINTS: Record<LeadField, string[]> = {
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
    'contact',
    'tel',
    'telephone',
  ],
  email: ['email', 'emailaddress', 'mail', 'emailid'],
  company: ['company', 'organization', 'organisation', 'org', 'business', 'companyname'],
  city: ['city', 'town'],
  address: ['address', 'fulladdress', 'location', 'place'],
  age: ['age', 'years', 'yearsold'],
  activeSince: ['activesince', 'active', 'since', 'memberfor', 'duration'],
  languages: ['language', 'languages', 'lang', 'speaks'],
  extraDetails: [
    'extradetails',
    'extra',
    'details',
    'about',
    'description',
    'remarks',
  ],
  phoneType: ['phonetype', 'devicetype', 'device', 'os'],
  notOnWhatsapp: [
    'notonwhatsapp',
    'nowhatsapp',
    'whatsappstatus',
    'whatsappavailable',
  ],
  source: ['source', 'leadsource', 'channel'],
  tags: ['tags', 'labels', 'tag'],
  createdAt: [
    'date',
    'createdat',
    'created',
    'createddate',
    'leaddate',
    'entrydate',
    'addedon',
  ],
};

/** Normalize a header for hint matching: lowercase + strip non-alnum. */
function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Parse spreadsheet date strings into a Date. Mirrors the server's
 * `parseSpreadsheetDate` so the preview UI displays a consistent date.
 *
 * Accepted formats:
 *   • ISO (`2026-01-31`, `2026-01-31T00:00:00Z`)
 *   • `31-Jan-2026`, `31 Jan 2026`, `31/Jan/2026`
 *   • `31-01-2026`, `31/01/2026` (DD/MM/YYYY — Indian convention)
 *   • `1/31/2026` (US-style fallback)
 *
 * Returns `null` for un-parseable input — caller drops the field.
 */
const MONTH_BY_ABBREV: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseSpreadsheetDate(raw: string): Date | null {
  const v = raw.trim();
  if (v === '') return null;

  // ISO first — fast path.
  const iso = new Date(v);
  if (!Number.isNaN(iso.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(v)) return iso;

  // DD-Mon-YYYY or DD Mon YYYY or DD/Mon/YYYY
  const monthMatch = v.match(/^(\d{1,2})[-\/\s]([A-Za-z]{3,})[-\/\s](\d{2,4})$/);
  if (monthMatch) {
    const day = parseInt(monthMatch[1], 10);
    const monKey = monthMatch[2].slice(0, 3).toLowerCase();
    const yearRaw = parseInt(monthMatch[3], 10);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    const month = MONTH_BY_ABBREV[monKey];
    if (month !== undefined && day >= 1 && day <= 31) {
      return new Date(year, month, day);
    }
  }

  // DD-MM-YYYY or DD/MM/YYYY (Indian default) and US-style MM/DD/YYYY.
  const numMatch = v.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
  if (numMatch) {
    const a = parseInt(numMatch[1], 10);
    const b = parseInt(numMatch[2], 10);
    const yearRaw = parseInt(numMatch[3], 10);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    // If a > 12, it must be a day → DD/MM/YYYY. Else assume DD/MM/YYYY
    // (Indian convention) but tolerate US MM/DD when day is invalid.
    let day = a;
    let month = b - 1;
    if (a > 12 && b <= 12) {
      day = a;
      month = b - 1;
    } else if (b > 12 && a <= 12) {
      day = b;
      month = a - 1;
    }
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      return new Date(year, month, day);
    }
  }

  return null;
}

/**
 * Build the initial column → field mapping from the parsed headers.
 * For each header in order, we look it up in `HEADER_HINTS` and
 * assign the first matching field — but only if the field hasn't
 * already been claimed by an earlier column (so two phone-like
 * columns don't both map to `phone`).
 */
function autoMapHeaders(headers: string[]): Record<string, LeadField | null> {
  const mapping: Record<string, LeadField | null> = {};
  const claimed = new Set<LeadField>();

  for (const header of headers) {
    const norm = normalizeHeader(header);
    let assigned: LeadField | null = null;
    for (const field of LEAD_FIELDS) {
      if (claimed.has(field.key)) continue;
      const hints = HEADER_HINTS[field.key];
      if (hints.some((h) => h === norm)) {
        assigned = field.key;
        break;
      }
    }
    if (assigned) {
      claimed.add(assigned);
      mapping[header] = assigned;
    } else {
      mapping[header] = null;
    }
  }

  return mapping;
}

// ---------------------------------------------------------------------------
// Validation helpers (client-side preview only — server is authoritative)
// ---------------------------------------------------------------------------

/** Strip everything that isn't a digit. Matches the server's normalization. */
function normalizePhone(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, '');
  return digits.length > 0 ? digits : undefined;
}

/** Lower-case + trim email. Matches the server's normalization. */
function normalizeEmail(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const t = email.trim().toLowerCase();
  return t.length > 0 ? t : undefined;
}

/**
 * Build a row in the API payload shape from a parsed CSV record + the
 * current mapping. Empty strings are dropped so they don't get sent
 * (the server treats absent vs empty differently for optional fields).
 *
 * `tags` is split on semicolons; `source` is passed through as-is and
 * the server coerces unknown labels to `OTHER`.
 */
function buildRow(
  record: Record<string, string>,
  mapping: Record<string, LeadField | null>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [csvCol, field] of Object.entries(mapping)) {
    if (!field) continue;
    const raw = record[csvCol];
    if (raw === undefined) continue;
    const trimmed = String(raw).trim();
    if (trimmed === '') continue;
    if (field === 'tags') {
      const parts = trimmed
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean);
      if (parts.length > 0) out.tags = parts;
    } else if (field === 'languages') {
      // v0.1.4 — languages are comma-separated in the user's
      // spreadsheet (e.g. "Hindi, English"). We also tolerate a
      // semicolon for parity with `tags`.
      const parts = trimmed
        .split(/[;,]/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (parts.length > 0) out.languages = parts;
    } else if (field === 'age') {
      const n = Number(trimmed);
      if (Number.isInteger(n) && n > 0 && n < 200) {
        out.age = n;
      }
    } else if (field === 'notOnWhatsapp') {
      const norm = trimmed.toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(norm)) {
        out.notOnWhatsapp = true;
      } else if (['false', '0', 'no', 'n'].includes(norm)) {
        out.notOnWhatsapp = false;
      }
    } else if (field === 'phoneType') {
      // Light normalisation — canonicalise iphone/Android/other
      // capitalisation; pass other values through so the schema can
      // accept tenant-specific labels.
      const lc = trimmed.toLowerCase();
      if (lc === 'iphone') out.phoneType = 'iPhone';
      else if (lc === 'android') out.phoneType = 'Android';
      else if (lc === 'other') out.phoneType = 'Other';
      else out.phoneType = trimmed;
    } else if (field === 'createdAt') {
      // Parse common spreadsheet date formats and emit an ISO string.
      // The server's `parseSpreadsheetDate` (see `/api/leads/import`)
      // also accepts the raw string, but normalising here makes the
      // preview table render the date nicely.
      const parsed = parseSpreadsheetDate(trimmed);
      if (parsed) {
        out.createdAt = parsed.toISOString();
      }
    } else {
      out[field] = trimmed;
    }
  }
  return out;
}

interface PreviewSummary {
  validCount: number;
  missingRequiredCount: number;
  duplicateInFileCount: number;
  missingNameCount: number;
  missingContactCount: number;
}

/**
 * Compute a quick summary of the parsed rows under the active mapping.
 * Mirrors the server's two cheapest checks (`name` required, and
 * `phone || email` required) plus an in-file dedupe by phone+email.
 *
 * Caveats:
 *   • This is an early-warning UX aid only — the server is the
 *     source of truth (it validates each row through Zod and
 *     cross-checks against the database).
 *   • In-file dedupe here uses the same first-occurrence-wins rule as
 *     the server, so the "valid" and "duplicate" counts predict the
 *     server's response when there are no DB-side duplicates.
 */
function computeSummary(
  rows: Record<string, string>[],
  mapping: Record<string, LeadField | null>,
): PreviewSummary {
  let validCount = 0;
  let missingNameCount = 0;
  let missingContactCount = 0;
  let duplicateInFileCount = 0;

  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();

  for (const record of rows) {
    const built = buildRow(record, mapping);
    const name = typeof built.name === 'string' ? built.name : '';
    const phone = typeof built.phone === 'string' ? built.phone : undefined;
    const email = typeof built.email === 'string' ? built.email : undefined;

    if (!name) {
      missingNameCount += 1;
      continue;
    }
    if (!phone && !email) {
      missingContactCount += 1;
      continue;
    }

    const emailKey = normalizeEmail(email);
    const phoneKey = normalizePhone(phone);
    const emailDup = emailKey !== undefined && seenEmails.has(emailKey);
    const phoneDup = phoneKey !== undefined && seenPhones.has(phoneKey);
    if (emailDup || phoneDup) {
      duplicateInFileCount += 1;
      continue;
    }
    if (emailKey) seenEmails.add(emailKey);
    if (phoneKey) seenPhones.add(phoneKey);
    validCount += 1;
  }

  return {
    validCount,
    missingNameCount,
    missingContactCount,
    missingRequiredCount: missingNameCount + missingContactCount,
    duplicateInFileCount,
  };
}

// ---------------------------------------------------------------------------
// API response shape (mirrors `ImportSummary` in the route handler)
// ---------------------------------------------------------------------------

interface ApiRowError {
  rowIndex: number;
  error: string;
  issues?: { message?: string; path?: (string | number)[] }[];
}

interface ApiRowDuplicate {
  rowIndex: number;
  name: string;
  email?: string;
  phone?: string;
  reason: 'duplicate_in_upload' | 'duplicate_in_database';
}

interface ApiImportSummary {
  totalRows: number;
  importedRows: number;
  skippedRows: number;
  duplicates: ApiRowDuplicate[];
  errors: ApiRowError[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CsvImport() {
  // Parsed CSV state — populated after a successful Papa parse.
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [headers, setHeaders] = React.useState<string[]>([]);
  const [rows, setRows] = React.useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = React.useState<Record<string, LeadField | null>>({});

  // UI state.
  const [parseError, setParseError] = React.useState<string | null>(null);
  const [isParsing, setIsParsing] = React.useState(false);
  const [isImporting, setIsImporting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ApiImportSummary | null>(null);

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  // Reset everything to the initial state. Used after the operator
  // chooses a different file or clicks "Reset".
  function resetAll() {
    setFileName(null);
    setHeaders([]);
    setRows([]);
    setMapping({});
    setParseError(null);
    setSubmitError(null);
    setResult(null);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Clear previous state — a new file is a fresh start.
    resetAll();
    setFileName(file.name);
    setIsParsing(true);

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      // Trim header whitespace so "Email " and "Email" auto-map the
      // same way. Leave cell whitespace alone — `buildRow` trims
      // before sending.
      transformHeader: (h) => h.trim(),
      complete: (parsed: ParseResult<Record<string, string>>) => {
        setIsParsing(false);

        const fields = (parsed.meta.fields ?? []).filter(
          (h) => h && h.length > 0,
        );
        if (fields.length === 0) {
          setParseError(
            'Could not detect any columns. Make sure the first row contains headers.',
          );
          return;
        }

        const data = parsed.data ?? [];
        if (data.length === 0) {
          setParseError('The CSV has no data rows.');
          return;
        }

        if (data.length > MAX_ROWS) {
          setParseError(
            `CSV import is limited to ${MAX_ROWS} rows per upload (your file has ${data.length}). Split it and try again.`,
          );
          return;
        }

        // Surface any parser-level errors as a soft warning so the
        // operator knows some rows may have been skipped, but don't
        // bail — the rows we did parse are still importable.
        if (parsed.errors.length > 0) {
          // First error is enough to communicate the problem; full
          // detail is in the browser console for debugging.
          // eslint-disable-next-line no-console
          console.warn('[csv-import] papaparse warnings:', parsed.errors);
        }

        setHeaders(fields);
        setRows(data);
        setMapping(autoMapHeaders(fields));
      },
      error: (err) => {
        setIsParsing(false);
        setParseError(`Failed to parse CSV: ${err.message}`);
      },
    });
  }

  /**
   * Update the mapping for a single CSV column. We intentionally
   * allow the same target field to be mapped from multiple columns;
   * the operator may want to try both and remove one. The server's
   * row-builder will use whichever column was last set in the
   * mapping object, but in practice the auto-mapper claims fields
   * uniquely so this is rarely an issue.
   */
  function setColumnMapping(csvCol: string, field: LeadField | null) {
    setMapping((prev) => ({ ...prev, [csvCol]: field }));
  }

  // Derived values.
  const summary = React.useMemo(
    () => (rows.length > 0 ? computeSummary(rows, mapping) : null),
    [rows, mapping],
  );

  const previewRows = React.useMemo(
    () => rows.slice(0, PREVIEW_ROW_COUNT),
    [rows],
  );

  const mappedFields = React.useMemo(() => {
    const set = new Set<LeadField>();
    for (const v of Object.values(mapping)) if (v) set.add(v);
    return set;
  }, [mapping]);

  const hasNameMapping = mappedFields.has('name');
  const hasContactMapping = mappedFields.has('phone') || mappedFields.has('email');
  // The mapping must at least cover `name` and one of `phone|email` —
  // otherwise no row could ever be valid. We surface this up-front so
  // the import button stays disabled rather than failing every row
  // server-side.
  const mappingComplete = hasNameMapping && hasContactMapping;
  const canImport =
    rows.length > 0 &&
    mappingComplete &&
    !isImporting &&
    !isParsing &&
    summary !== null &&
    summary.validCount > 0;

  async function handleImport() {
    if (!canImport) return;
    setSubmitError(null);
    setIsImporting(true);

    // Build the payload from the full row set — NOT just the preview.
    // Empty rows (after build) are dropped client-side; the server
    // will reject any that still slip through with a row-level error.
    const payload = {
      rows: rows.map((r) => buildRow(r, mapping)),
    };

    try {
      const res = await fetch('/api/leads/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      if (!res.ok) {
        const msg =
          (body && typeof body === 'object' && 'error' in body
            ? String((body as { error?: unknown }).error ?? '')
            : '') ||
          `Import failed (${res.status}).`;
        setSubmitError(msg);
        return;
      }

      setResult(body as ApiImportSummary);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'Network error during import.',
      );
    } finally {
      setIsImporting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------------------ */}
      {/* Step 1 — Upload */}
      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle>1. Upload CSV</CardTitle>
          <CardDescription>
            Up to {MAX_ROWS} rows per file. The first row must be headers.
            We dedupe on phone and email both within your file and against
            existing leads.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:max-w-md">
            <Label htmlFor="csv-file">CSV file</Label>
            <Input
              id="csv-file"
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileChange}
              disabled={isParsing || isImporting}
            />
            {fileName ? (
              <p className="text-xs text-muted-foreground">
                Selected: <span className="font-mono">{fileName}</span>
                {rows.length > 0 ? (
                  <> &middot; {rows.length} row{rows.length === 1 ? '' : 's'}</>
                ) : null}
              </p>
            ) : null}
          </div>

          {isParsing ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Parsing CSV…
            </p>
          ) : null}

          {parseError ? (
            <p
              role="alert"
              className="flex items-start gap-2 text-sm text-destructive"
            >
              <FileWarning className="mt-0.5 h-4 w-4" aria-hidden="true" />
              <span>{parseError}</span>
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Step 2 — Map columns (only after a successful parse) */}
      {/* ------------------------------------------------------------------ */}
      {headers.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>2. Map columns</CardTitle>
            <CardDescription>
              Point each CSV column at a lead field. We&apos;ve guessed the
              obvious ones — adjust as needed. Unmapped columns are ignored.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-1/2">CSV column</TableHead>
                    <TableHead>Lead field</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {headers.map((h) => {
                    const current = mapping[h] ?? null;
                    return (
                      <TableRow key={h}>
                        <TableCell className="font-medium">
                          <span className="font-mono text-xs">{h}</span>
                        </TableCell>
                        <TableCell>
                          <Select
                            value={current ?? UNMAPPED}
                            onValueChange={(v) =>
                              setColumnMapping(
                                h,
                                v === UNMAPPED ? null : (v as LeadField),
                              )
                            }
                          >
                            <SelectTrigger className="sm:max-w-xs">
                              <SelectValue placeholder="Ignore this column" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={UNMAPPED}>
                                — Ignore this column —
                              </SelectItem>
                              {LEAD_FIELDS.map((f) => (
                                <SelectItem key={f.key} value={f.key}>
                                  {f.label}
                                  {f.required ? ' *' : ''}
                                  {f.hint ? ` (${f.hint})` : ''}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {!mappingComplete ? (
              <p
                role="alert"
                className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-500"
              >
                <FileWarning className="mt-0.5 h-4 w-4" aria-hidden="true" />
                <span>
                  Map a column to <strong>Name</strong> and at least one of{' '}
                  <strong>Phone</strong> or <strong>Email</strong> to enable
                  the import.
                </span>
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Step 3 — Preview + summary */}
      {/* ------------------------------------------------------------------ */}
      {rows.length > 0 && summary ? (
        <Card>
          <CardHeader>
            <CardTitle>3. Preview</CardTitle>
            <CardDescription>
              First {Math.min(PREVIEW_ROW_COUNT, rows.length)} of {rows.length}{' '}
              row{rows.length === 1 ? '' : 's'} under the active mapping.
              Unmapped columns are hidden.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Validation summary chips — quick read of what'll be sent. */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="secondary">
                Total: {rows.length}
              </Badge>
              <Badge
                variant={summary.validCount > 0 ? 'default' : 'secondary'}
              >
                Valid: {summary.validCount}
              </Badge>
              {summary.missingNameCount > 0 ? (
                <Badge variant="destructive">
                  Missing name: {summary.missingNameCount}
                </Badge>
              ) : null}
              {summary.missingContactCount > 0 ? (
                <Badge variant="destructive">
                  Missing phone &amp; email: {summary.missingContactCount}
                </Badge>
              ) : null}
              {summary.duplicateInFileCount > 0 ? (
                <Badge variant="outline">
                  Duplicate in file: {summary.duplicateInFileCount}
                </Badge>
              ) : null}
            </div>

            <p className="text-xs text-muted-foreground">
              Database-side duplicates can&apos;t be detected until the
              server checks them — the response below will list any extras
              that match existing leads.
            </p>

            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12 text-right">#</TableHead>
                    {LEAD_FIELDS.filter((f) => mappedFields.has(f.key)).map(
                      (f) => (
                        <TableHead key={f.key}>
                          <span className="text-foreground">{f.label}</span>
                          {f.required ? (
                            <span className="text-destructive"> *</span>
                          ) : null}
                        </TableHead>
                      ),
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewRows.map((r, idx) => {
                    const built = buildRow(r, mapping);
                    return (
                      <TableRow key={idx}>
                        <TableCell className="text-right text-xs text-muted-foreground">
                          {idx + 1}
                        </TableCell>
                        {LEAD_FIELDS.filter((f) =>
                          mappedFields.has(f.key),
                        ).map((f) => {
                          const v = built[f.key];
                          if (f.key === 'tags' || f.key === 'languages') {
                            const items = Array.isArray(v)
                              ? (v as string[])
                              : [];
                            return (
                              <TableCell key={f.key}>
                                {items.length > 0 ? (
                                  <div className="flex flex-wrap gap-1">
                                    {items.map((t) => (
                                      <Badge
                                        key={t}
                                        variant="secondary"
                                        className="font-normal"
                                      >
                                        {t}
                                      </Badge>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-xs text-muted-foreground">
                                    —
                                  </span>
                                )}
                              </TableCell>
                            );
                          }
                          if (f.key === 'age') {
                            return (
                              <TableCell
                                key={f.key}
                                className="text-right tabular-nums"
                              >
                                {typeof v === 'number' ? (
                                  v
                                ) : (
                                  <span className="text-xs text-muted-foreground">
                                    —
                                  </span>
                                )}
                              </TableCell>
                            );
                          }
                          if (f.key === 'notOnWhatsapp') {
                            return (
                              <TableCell key={f.key}>
                                {typeof v === 'boolean' ? (
                                  <Badge
                                    variant={v ? 'destructive' : 'secondary'}
                                    className="font-normal"
                                  >
                                    {v ? 'Not on WhatsApp' : 'On WhatsApp'}
                                  </Badge>
                                ) : (
                                  <span className="text-xs text-muted-foreground">
                                    —
                                  </span>
                                )}
                              </TableCell>
                            );
                          }
                          return (
                            <TableCell key={f.key} className="max-w-xs truncate">
                              {typeof v === 'string' && v.length > 0 ? (
                                v
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  —
                                </span>
                              )}
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Button
                type="button"
                onClick={handleImport}
                disabled={!canImport}
              >
                {isImporting ? (
                  <>
                    <Loader2
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                    <span>Importing…</span>
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4" aria-hidden="true" />
                    <span>
                      Import {summary.validCount} lead
                      {summary.validCount === 1 ? '' : 's'}
                    </span>
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  // Reset both component state and the file input so
                  // re-selecting the same file fires `change` again.
                  resetAll();
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
                disabled={isImporting}
              >
                Reset
              </Button>
            </div>

            {submitError ? (
              <p role="alert" className="text-sm text-destructive">
                {submitError}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Step 4 — Result */}
      {/* ------------------------------------------------------------------ */}
      {result ? (
        <Card>
          <CardHeader>
            <CardTitle>4. Import results</CardTitle>
            <CardDescription>
              {result.importedRows} of {result.totalRows} row
              {result.totalRows === 1 ? '' : 's'} imported.{' '}
              {result.skippedRows > 0
                ? `${result.skippedRows} skipped — see details below.`
                : 'No rows were skipped.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="secondary">Total: {result.totalRows}</Badge>
              <Badge variant="default">Imported: {result.importedRows}</Badge>
              <Badge variant="outline">Skipped: {result.skippedRows}</Badge>
              {result.duplicates.length > 0 ? (
                <Badge variant="outline">
                  Duplicates: {result.duplicates.length}
                </Badge>
              ) : null}
              {result.errors.length > 0 ? (
                <Badge variant="destructive">
                  Errors: {result.errors.length}
                </Badge>
              ) : null}
            </div>

            {result.errors.length > 0 ? (
              <div>
                <h3 className="mb-2 text-sm font-medium">Errors</h3>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-20 text-right">Row</TableHead>
                        <TableHead>Problem</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.errors.map((e) => (
                        <TableRow key={`err-${e.rowIndex}`}>
                          <TableCell className="text-right text-xs text-muted-foreground">
                            {/* Server uses 0-based; humans count from 1. */}
                            {e.rowIndex + 1}
                          </TableCell>
                          <TableCell className="text-sm">{e.error}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ) : null}

            {result.duplicates.length > 0 ? (
              <div>
                <h3 className="mb-2 text-sm font-medium">Duplicates</h3>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-20 text-right">Row</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Phone</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>Reason</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.duplicates.map((d) => (
                        <TableRow key={`dup-${d.rowIndex}`}>
                          <TableCell className="text-right text-xs text-muted-foreground">
                            {d.rowIndex + 1}
                          </TableCell>
                          <TableCell className="text-sm">{d.name}</TableCell>
                          <TableCell className="text-sm">
                            {d.phone ?? (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">
                            {d.email ?? (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">
                            {d.reason === 'duplicate_in_upload'
                              ? 'Duplicate in file'
                              : 'Already in database'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Button asChild>
                <Link href="/leads">
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                  <span>View leads</span>
                </Link>
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  resetAll();
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
              >
                Import another file
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
