/**
 * `/leads/import` — bulk lead import via CSV upload (SPEC §6.1, §6.2.3,
 * §6.4).
 *
 * Server Component. Responsibilities:
 *
 *   1. Auth gate — redirect to `/login` if there's no session. Both
 *      ADMIN and EMPLOYEE may import leads (SPEC §6.4 — owner defaults
 *      to the importing user, admin can reassign post-import). The
 *      middleware already 401s anonymous traffic on `/api/leads/import`;
 *      we mirror the gate at the page level so a curl-bypass doesn't
 *      render the upload form.
 *   2. Render the `<PageHeader>` with a "Back to leads" affordance and
 *      mount `<CsvImport>` (client) which handles parsing, mapping,
 *      preview, and the POST to `/api/leads/import`.
 *
 * Parsing happens entirely in the browser (`papaparse`) so the server
 * route stays JSON-only — see the file-level comment on
 * `src/app/api/leads/import/route.ts` for the rationale.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { auth } from '@/lib/auth';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/PageHeader';

import { CsvImport } from './csv-import';

export const metadata = {
  title: 'Import leads',
};

export const dynamic = 'force-dynamic';

export default async function ImportLeadsPage() {
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/leads/import');
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Import leads"
        subtitle="Upload a CSV, map columns to lead fields, and review duplicates before committing."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/leads">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span>Back to leads</span>
            </Link>
          </Button>
        }
      />

      <CsvImport />
    </div>
  );
}
