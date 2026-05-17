/**
 * `/marketing/utm` — UTM builder tool (SPEC §7.1, §7.2.5, task 46).
 *
 * Server Component shell — auth gate + page header. The actual
 * generator is a pure client component (no API calls); it lives at
 * `./utm-builder-form.tsx`.
 *
 * SPEC §7.4: "UTM generator outputs
 *   `https://chitly.live/?utm_source=meta&utm_medium=cpc&utm_campaign=...`"
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { auth } from '@/lib/auth';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { PageHeader } from '@/components/shared/PageHeader';

import { UtmBuilderForm } from './utm-builder-form';

export const metadata = {
  title: 'UTM builder',
};

export const dynamic = 'force-dynamic';

export default async function UtmBuilderPage() {
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/marketing/utm');
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="UTM builder"
        subtitle="Generate copyable URLs with UTM tags. Use the same utm_campaign value on the matching campaign to auto-link leads."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/marketing">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span>Back to campaigns</span>
            </Link>
          </Button>
        }
      />

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Build a UTM URL</CardTitle>
          <CardDescription>
            Pick a destination, add the UTM dimensions, and copy the
            result. The preview updates as you type.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UtmBuilderForm />
        </CardContent>
      </Card>
    </div>
  );
}
