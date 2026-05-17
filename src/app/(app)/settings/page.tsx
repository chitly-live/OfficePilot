/**
 * `/settings` — admin-only OfficePilot settings page (SPEC.md §12.1).
 *
 * Server Component. Responsibilities:
 *
 *   1. Auth gate (defence-in-depth on top of the `(app)` layout):
 *      • No session         → `/login?callbackUrl=/settings`.
 *      • Non-admin session  → soft redirect to `/dashboard` (the
 *        whole settings surface is admin-only per SPEC §12.1; SPEC
 *        carves out per-user "Profile" + "Hashtag library" tabs but
 *        the v1 implementation keeps the page admin-only since every
 *        modelled key is admin-controlled — see §12.2 secrets and
 *        §10.6 cron knobs).
 *
 *   2. Build the same response shape that `GET /api/settings` would
 *      produce, but read directly from Prisma. Fetching the API from
 *      a server component is awkward (the cookie / origin must be
 *      forwarded by hand) and the API is doing nothing more than:
 *        • pulling every {@link KNOWN_KEYS} row,
 *        • masking sensitive values to {@link SENSITIVE_PLACEHOLDER},
 *        • defaulting missing rows to `''`.
 *      We replicate that here verbatim so the page and the API stay
 *      semantically identical (any drift is a bug).
 *
 *   3. Render `<PageHeader>` + the {@link SettingsForm} client
 *      component, which owns the actual form state and submits
 *      `PATCH /api/settings` on save.
 *
 * The Users tab is intentionally a single cross-link to
 * `/settings/users` (task 82) — that page already lists / paginates
 * the `User` table and reuses the existing employee create form, so
 * duplicating the list here would be redundant.
 *
 * Implements task 81 of `.kiro/specs/officepilot/tasks.md`.
 */

import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  isSensitiveKey,
  KNOWN_KEYS,
  SENSITIVE_PLACEHOLDER,
  type SettingsRecord,
} from '@/lib/schemas/settings';
import { PageHeader } from '@/components/shared/PageHeader';

import { SettingsForm } from './settings-form';

export const metadata = {
  title: 'Settings · OfficePilot',
};

// Settings change rarely but the page must always reflect the latest
// write — never serve a cached render across users.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Server-side settings loader
// ---------------------------------------------------------------------------

/**
 * Mirror of `GET /api/settings`'s response builder, executed in-process
 * so we don't have to forward auth cookies through a `fetch()`.
 *
 *   • Missing rows                 → `''`.
 *   • Sensitive rows with a value  → {@link SENSITIVE_PLACEHOLDER}
 *                                    (`'***'`). Plaintext credentials
 *                                    NEVER leave the server.
 *   • Sensitive rows without value → `''`.
 *   • Plain rows                   → the raw stored value.
 *
 * Per SPEC §12.2.
 */
async function loadSettings(): Promise<SettingsRecord> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: KNOWN_KEYS as unknown as string[] } },
    select: { key: true, value: true },
  });

  const byKey = new Map<string, string>();
  for (const row of rows) {
    byKey.set(row.key, row.value);
  }

  const settings = {} as SettingsRecord;
  for (const key of KNOWN_KEYS) {
    const stored = byKey.get(key);
    if (stored === undefined || stored.length === 0) {
      settings[key] = '';
      continue;
    }
    settings[key] = isSensitiveKey(key) ? SENSITIVE_PLACEHOLDER : stored;
  }
  return settings;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function SettingsPage() {
  // ------------------------------------------------------------------
  // 1. Auth gate — admin only (SPEC §12.1, §15).
  // ------------------------------------------------------------------
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/settings');
  }
  if (session.role !== 'ADMIN') {
    // Soft redirect rather than 403 — gives non-admins a forgiving
    // fallback if they followed a stale link.
    redirect('/dashboard');
  }

  // ------------------------------------------------------------------
  // 2. Load the canonical settings snapshot.
  // ------------------------------------------------------------------
  const settings = await loadSettings();

  // ------------------------------------------------------------------
  // 3. Render the header + tabbed form.
  // ------------------------------------------------------------------
  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        subtitle="API keys, AI config, and the hashtag library."
      />

      <SettingsForm initialSettings={settings} />
    </div>
  );
}
