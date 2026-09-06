/**
 * Small client-safe helpers shared by the Finance pages and forms. Pure
 * TypeScript — importable from both Server and Client Components.
 */

import type { FinanceDirection, FinancePartyType } from '@prisma/client';

import type { StatusTone } from '@/components/shared/StatusBadge';

/** Sentinel for "no party / no account" in Radix `Select` (which
 *  forbids an empty-string item value). */
export const NONE_VALUE = '__none__';

/** Sentinel for "all months" on the transactions list. */
export const ALL_MONTHS = 'all';

export interface ApiErrorBody {
  error?: string;
  message?: string;
  issues?: Array<{ message?: string; path?: (string | number)[] }>;
}

/** Turn an API error response into a toast-friendly sentence. */
export function describeApiError(
  body: ApiErrorBody | null,
  status: number,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'Only admins can change finance data.';
  if (status === 404) return 'That record no longer exists.';
  if (body?.issues && body.issues.length > 0) {
    return body.issues[0]?.message ?? 'Some fields are invalid.';
  }
  if (body?.message) return body.message;
  if (body?.error && body.error !== 'bad_request') return body.error;
  return fallback;
}

export type JsonResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; message: string };

/**
 * `fetch` + JSON + error normalisation. Never throws; network failures
 * come back as `{ ok: false, status: 0 }`.
 */
export async function requestJson<T = unknown>(
  url: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<JsonResult<T>> {
  const { json, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: {
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(rest.headers ?? {}),
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
  } catch {
    return { ok: false, status: 0, message: 'Network error. Please try again.' };
  }

  let body: unknown = null;
  if (res.status !== 204) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: describeApiError(body as ApiErrorBody | null, res.status),
    };
  }
  return { ok: true, status: res.status, data: body as T };
}

/** Badge tone for IN / OUT. */
export function directionTone(direction: FinanceDirection): StatusTone {
  return direction === 'IN' ? 'green' : 'red';
}

/** Text colour class for an amount cell. */
export function amountClass(direction: FinanceDirection): string {
  return direction === 'IN' ? 'text-status-green' : 'text-status-red';
}

/** `+₹6,000` / `−₹6,000` style prefix. */
export function amountSign(direction: FinanceDirection): string {
  return direction === 'IN' ? '+' : '−';
}

export const PARTY_TYPE_TONE: Record<FinancePartyType, StatusTone> = {
  FINANCER: 'amber',
  CARD_OWNER: 'blue',
  WORKER: 'green',
  VENDOR: 'neutral',
  CLIENT: 'green',
  INTERMEDIARY: 'amber',
  OTHER: 'neutral',
};

/** `'2026-09-05'` for the browser's local calendar day (form default). */
export function todayLocalDateKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** `'2026-09'` for the browser's local month. */
export function currentLocalMonthKey(): string {
  return todayLocalDateKey().slice(0, 7);
}

/** `Date | string | null` → `'YYYY-MM-DD'` (UTC) for a date input. */
export function toDateInputValue(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}
