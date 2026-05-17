'use client';

/**
 * Pagination — server-side pagination controls.
 *
 * SPEC §6.3 caps `/api/leads` at 200 rows, default 50 — every list
 * needs a pager. This component is server-side: it does NOT slice
 * data client-side; instead it exposes "page N of M" plus prev/next
 * controls and emits the new page number through one of two APIs:
 *
 *   • `onPageChange(nextPage)` — callback variant for client tables.
 *   • `basePath` + `searchParams` — Link variant for server-rendered
 *     lists where pagination is reflected in the URL (`?page=2`),
 *     enabling deep-linking and back-button navigation. Pass the
 *     current page's pathname as `basePath` (e.g. `/ai`) and the
 *     non-page filters to preserve as `searchParams`. The component
 *     builds the page hrefs itself — keeping props serialisable
 *     across the RSC → Client Component boundary (passing a function
 *     prop from a Server Component throws at serialisation time).
 *
 * If both are supplied, the callback takes precedence.
 *
 * Page numbers are 1-indexed throughout — matches what users expect
 * to see in URLs ("page 1, page 2") and what `Prisma.skip = (page-1)
 * * pageSize` consumes naturally.
 *
 * Client component because the callback variant relies on event
 * handlers; the Link variant is also fine here (Next's <Link> works
 * inside client components).
 */

import * as React from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PaginationProps {
  /** Current page (1-indexed). */
  page: number;
  /** Page size (rows per page). Used to compute the "showing X–Y of N" line. */
  pageSize: number;
  /** Total number of records across all pages. */
  total: number;
  /**
   * Callback invoked with the next page number when the user clicks
   * Prev/Next. Either this or the Link variant (`basePath`) should be
   * provided.
   */
  onPageChange?: (nextPage: number) => void;
  /**
   * Pathname for the Link variant (e.g. `/ai`). When provided, the
   * Prev/Next controls render as `<Link>`s pointing at the same path
   * with an updated `page` query param. Use together with
   * `searchParams` to preserve the current filter state across page
   * changes. Either this or `onPageChange` should be provided.
   */
  basePath?: string;
  /**
   * Current non-page filters to preserve when navigating between
   * pages. Each entry becomes a query param on the generated URL.
   * `undefined` / empty values are dropped so they don't pollute the
   * URL. The `page` key (configurable via `pageParamName`) is managed
   * by the component itself — set it via `page` instead.
   */
  searchParams?: Record<string, string | undefined>;
  /**
   * Name of the URL query parameter that tracks the current page.
   * @default 'page'
   */
  pageParamName?: string;
  /**
   * When true, hide the component entirely if there's only one page.
   * @default true
   */
  hideOnSinglePage?: boolean;
  /** Extra classes on the outer nav. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampPage(value: number, totalPages: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  if (value > totalPages) return totalPages;
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/** See file-level JSDoc. */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  basePath,
  searchParams,
  pageParamName,
  hideOnSinglePage = true,
  className,
}: PaginationProps) {
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(Math.max(0, total) / safePageSize));
  const currentPage = clampPage(page, totalPages);

  if (hideOnSinglePage && totalPages <= 1) {
    return null;
  }

  // 1-indexed inclusive range of visible records on the current page.
  const fromIndex = total === 0 ? 0 : (currentPage - 1) * safePageSize + 1;
  const toIndex = Math.min(total, currentPage * safePageSize);

  const isFirstPage = currentPage <= 1;
  const isLastPage = currentPage >= totalPages;

  // Build a Link-variant href for a given target page from the
  // serialisable `basePath` + `searchParams` props. Kept inside the
  // component so the URL construction lives next to the props that
  // feed it — and so the caller doesn't have to pass a closure
  // (which would break RSC serialisation).
  function makePageHref(target: number): string {
    const base = basePath ?? '';
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams ?? {})) {
      if (v !== undefined && v !== '') usp.set(k, v);
    }
    const paramName = pageParamName ?? 'page';
    if (target !== 1) usp.set(paramName, String(target));
    else usp.delete(paramName);
    const qs = usp.toString();
    return qs ? `${base}?${qs}` : base;
  }

  // Resolve a renderable Prev/Next control. We prefer the callback
  // form when present (avoids a router round-trip on client tables);
  // fall back to <Link> for server-rendered URL-driven pagination.
  const renderControl = (
    direction: 'prev' | 'next',
    target: number,
    disabled: boolean,
  ) => {
    const isPrev = direction === 'prev';
    const Icon = isPrev ? ChevronLeft : ChevronRight;
    const label = isPrev ? 'Previous page' : 'Next page';
    const text = isPrev ? 'Previous' : 'Next';

    const content = (
      <>
        {isPrev ? (
          <Icon className="h-4 w-4" aria-hidden="true" />
        ) : null}
        <span>{text}</span>
        {!isPrev ? (
          <Icon className="h-4 w-4" aria-hidden="true" />
        ) : null}
      </>
    );

    if (onPageChange) {
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onPageChange(target)}
          aria-label={label}
        >
          {content}
        </Button>
      );
    }

    if (basePath && !disabled) {
      return (
        <Button
          asChild
          variant="outline"
          size="sm"
          aria-label={label}
        >
          <Link href={makePageHref(target)}>{content}</Link>
        </Button>
      );
    }

    // Disabled fallback when neither handler is wired or we're at an
    // edge with the Link variant.
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled
        aria-label={label}
      >
        {content}
      </Button>
    );
  };

  return (
    <nav
      role="navigation"
      aria-label="Pagination"
      className={cn(
        'flex flex-col items-center justify-between gap-3 py-3 text-sm sm:flex-row',
        className,
      )}
    >
      <p className="text-muted-foreground">
        {total === 0 ? (
          <>No results</>
        ) : (
          <>
            Showing <span className="font-medium text-foreground">{fromIndex}</span>
            –<span className="font-medium text-foreground">{toIndex}</span>{' '}
            of <span className="font-medium text-foreground">{total}</span>
          </>
        )}
      </p>

      <div className="flex items-center gap-2">
        {renderControl('prev', Math.max(1, currentPage - 1), isFirstPage)}
        <span
          className="px-2 text-xs text-muted-foreground"
          aria-current="page"
        >
          Page <span className="font-medium text-foreground">{currentPage}</span>{' '}
          of <span className="font-medium text-foreground">{totalPages}</span>
        </span>
        {renderControl('next', Math.min(totalPages, currentPage + 1), isLastPage)}
      </div>
    </nav>
  );
}
