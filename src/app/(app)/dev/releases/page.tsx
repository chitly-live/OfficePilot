/**
 * `/dev/releases` — release log (SPEC.md §9.1, §9.2.3, §9.4).
 *
 * Server Component. Lists `DevTask` rows with `type=RELEASE`,
 * ordered by `releasedAt` desc with NULL last (unshipped releases
 * bubble to the bottom). Optional `?platform=` filter narrows to a
 * single platform — typical values are "iOS", "Android", "Web".
 *
 * Each release renders as a timeline card showing version, platform,
 * released-on date, status, and the description (changelog body).
 *
 * Out of scope for v1 (per the orchestrator's brief): the "bugs
 * reported in 7 days after release" stat from SPEC.md §9.2.6 — we
 * surface it as a count placeholder if needed in a later task.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, Plus, Rocket } from 'lucide-react';
import { DevTaskType, Prisma } from '@prisma/client';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  devTaskPublicProjection,
  type DevTaskPublic,
} from '@/lib/schemas/dev';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/EmptyState';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

import { PlatformSelect } from './platform-select';

const PLATFORM_ALL = '__all__';

export const metadata = {
  title: 'Releases',
};

export const dynamic = 'force-dynamic';

function coerceParam(
  raw: string | string[] | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    const joined = raw.filter(Boolean).join(',');
    return joined.length > 0 ? joined : undefined;
  }
  return raw;
}

interface DevReleasesPageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default async function DevReleasesPage({
  searchParams,
}: DevReleasesPageProps) {
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/dev/releases');
  }

  const platform = coerceParam(searchParams?.platform);
  const platformActive =
    platform && platform !== PLATFORM_ALL && platform.trim() !== ''
      ? platform.trim()
      : null;

  const where: Prisma.DevTaskWhereInput = {
    type: DevTaskType.RELEASE,
  };
  if (platformActive) {
    where.platform = platformActive;
  }

  const items = (await prisma.devTask.findMany({
    where,
    select: devTaskPublicProjection,
    orderBy: [
      { releasedAt: { sort: 'desc', nulls: 'last' } },
      { createdAt: 'desc' },
      { id: 'asc' },
    ],
    take: 200,
  })) as unknown as DevTaskPublic[];

  // Build the platform options from the existing release rows so the
  // dropdown always reflects what's actually in the system. We also
  // include the canonical iOS / Android / Web triple so an empty
  // database still has something useful to pick.
  const platformRows = await prisma.devTask.findMany({
    where: { type: DevTaskType.RELEASE, platform: { not: null } },
    select: { platform: true },
    distinct: ['platform'],
    take: 50,
  });
  const knownPlatforms = new Set<string>(['iOS', 'Android', 'Web']);
  for (const row of platformRows) {
    if (row.platform) knownPlatforms.add(row.platform);
  }
  const platformOptions = Array.from(knownPlatforms).sort((a, b) =>
    a.localeCompare(b),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Releases"
        subtitle="Timeline of shipped versions across platforms — newest first."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/dev">
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                <span>Back to dev</span>
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/dev/new?type=RELEASE">
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span>Log release</span>
              </Link>
            </Button>
          </div>
        }
      />

      <PlatformSelect
        currentPlatform={platformActive ?? ''}
        platformOptions={platformOptions}
      />

      {items.length === 0 ? (
        <EmptyState
          icon={Rocket}
          title="No releases yet"
          description="Log your first release to start a shipping timeline."
          action={
            <Button asChild size="sm">
              <Link href="/dev/new?type=RELEASE">
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span>Log release</span>
              </Link>
            </Button>
          }
        />
      ) : (
        <ol className="space-y-3">
          {items.map((release) => (
            <ReleaseCard key={release.id} release={release} />
          ))}
        </ol>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReleaseCard
// ---------------------------------------------------------------------------

function getInitials(
  name: string | null | undefined,
  fallback: string,
): string {
  const source = (name ?? '').trim();
  if (source) {
    const parts = source.split(/\s+/).slice(0, 2);
    const initials = parts.map((p) => p[0] ?? '').join('');
    if (initials) return initials.toUpperCase();
  }
  const fromFallback = fallback.trim()[0];
  return (fromFallback ?? '?').toUpperCase();
}

function formatReleaseDate(value: Date | null): string {
  if (!value) return 'Not yet released';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function ReleaseCard({ release }: { release: DevTaskPublic }) {
  const reporter = release.reporter;
  const version = release.releaseVersion?.trim() || release.title;
  const platform = release.platform?.trim();

  return (
    <li>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <CardTitle className="text-lg">
                <span className="font-mono">{version}</span>
                {platform ? (
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    on {platform}
                  </span>
                ) : null}
              </CardTitle>
              <CardDescription>
                {formatReleaseDate(release.releasedAt)}
                {release.title !== version ? (
                  <>
                    <span className="mx-2 text-muted-foreground">·</span>
                    <span>{release.title}</span>
                  </>
                ) : null}
              </CardDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <StatusBadge status={release.status} />
              <StatusBadge status={release.priority} />
            </div>
          </div>
        </CardHeader>
        {release.description || reporter ? (
          <CardContent className="space-y-3 pt-0">
            {release.description ? (
              <p className="whitespace-pre-line text-sm text-foreground">
                {release.description}
              </p>
            ) : null}
            {reporter ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Logged by</span>
                <Avatar className="h-5 w-5">
                  {reporter.avatarUrl ? (
                    <AvatarImage src={reporter.avatarUrl} alt={reporter.name} />
                  ) : null}
                  <AvatarFallback className="bg-brand-100 text-[8px] font-semibold text-brand-700 dark:bg-brand-900/60 dark:text-brand-200">
                    {getInitials(reporter.name, reporter.email)}
                  </AvatarFallback>
                </Avatar>
                <span>{reporter.name || reporter.email}</span>
              </div>
            ) : null}
          </CardContent>
        ) : null}
      </Card>
    </li>
  );
}

// All renderers above are inlined; nothing else to export.
