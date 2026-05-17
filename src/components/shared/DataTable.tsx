'use client';

/**
 * DataTable — generic shadcn Table wrapper backed by TanStack Table.
 *
 * Used everywhere a list of records is rendered (Leads, Campaigns,
 * Posts, DevTasks, Employees, AI insights). Per task 21 we keep this
 * intentionally lean:
 *
 *   • columns + data in, rows rendered out
 *   • loading-skeleton state (SPEC §13.4)
 *   • empty state (SPEC §13.3) — defaults to a built-in `EmptyState`,
 *     overridable by the caller
 *
 * Sorting / filtering / pagination live PER PAGE because each module
 * has different needs (server-side pagination on /leads vs in-memory
 * on /social). We expose the underlying TanStack `table` instance via
 * `useReactTable` internally; if a caller needs more advanced
 * interactions later they can fork this into a richer wrapper without
 * disturbing the simple consumers.
 *
 * Generic in TRow so column accessors stay type-safe at the call
 * site:
 *
 *   const columns: DataTableColumn<Lead>[] = [...];
 *   <DataTable<Lead> columns={columns} data={leads} />
 *
 * Client component because TanStack Table uses React hooks
 * internally.
 */

import * as React from 'react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
} from '@tanstack/react-table';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { EmptyState, type EmptyStateProps } from './EmptyState';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Column type re-exported as `DataTableColumn` so callers don't have
 * to import from `@tanstack/react-table` directly. The full TanStack
 * `ColumnDef<TRow>` API is supported (accessorKey / accessorFn / id /
 * cell / header).
 */
export type DataTableColumn<TRow, TValue = unknown> = ColumnDef<TRow, TValue>;

export interface DataTableProps<TRow> {
  /** Column definitions. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TanStack's `ColumnDef<TRow, TValue>` invariance requires `any` for heterogeneous columns; `unknown` here triggers a contravariance error in callers.
  columns: DataTableColumn<TRow, any>[];
  /** Row data. */
  data: TRow[];
  /**
   * When true, render `loadingRows` skeleton rows instead of the
   * actual data. Used while the server query is in flight (>200 ms
   * per SPEC §13.4).
   */
  isLoading?: boolean;
  /** Skeleton-row count while loading. @default 5 */
  loadingRows?: number;
  /**
   * Empty-state slot. If omitted, a default `EmptyState` ("No
   * records") is rendered.
   */
  emptyState?: React.ReactNode;
  /**
   * Convenience prop to customize the default empty state without
   * having to render a full ReactNode. Ignored if `emptyState` is
   * provided.
   */
  emptyStateProps?: Partial<EmptyStateProps>;
  /**
   * Optional row click handler. If provided, rows render with a
   * pointer cursor + `hover:bg-muted/50`.
   */
  onRowClick?: (row: TRow, ctx: Row<TRow>) => void;
  /**
   * Stable React key for each row. Defaults to TanStack's row id
   * (which falls back to the row index). Provide a function returning
   * the database id for a more stable identity across paginations.
   */
  getRowId?: (row: TRow, index: number) => string;
  /** Extra classes on the outer scroll container. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/**
 * Renders a typed, generic table. See file-level JSDoc.
 *
 * Note: the function declaration uses an explicit generic via an
 * arrow-style `function` so we can keep `TRow` as a generic param
 * rather than baking it in at the export boundary.
 */
export function DataTable<TRow>({
  columns,
  data,
  isLoading = false,
  loadingRows = 5,
  emptyState,
  emptyStateProps,
  onRowClick,
  getRowId,
  className,
}: DataTableProps<TRow>) {
  const table = useReactTable<TRow>({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId,
  });

  const headerGroups = table.getHeaderGroups();
  const rows = table.getRowModel().rows;
  const colCount = columns.length || 1;

  return (
    <div className={cn('w-full overflow-x-auto rounded-md border', className)}>
      <Table>
        <TableHeader>
          {headerGroups.map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id} colSpan={header.colSpan}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>

        <TableBody>
          {isLoading ? (
            // SPEC §13.4 skeleton loaders. We render `loadingRows` rows
            // each with `colCount` cells so the skeleton matches the
            // future row shape without layout shift on hydration.
            Array.from({ length: Math.max(1, loadingRows) }).map((_, rowIdx) => (
              <TableRow key={`skeleton-${rowIdx}`} aria-hidden="true">
                {Array.from({ length: colCount }).map((__, cellIdx) => (
                  <TableCell key={`skeleton-${rowIdx}-${cellIdx}`}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={colCount}
                className="p-0"
              >
                {emptyState ?? (
                  <EmptyState
                    title={emptyStateProps?.title ?? 'No records'}
                    description={emptyStateProps?.description}
                    action={emptyStateProps?.action}
                    icon={emptyStateProps?.icon}
                    className={cn(
                      // No nested border — the table already has one.
                      'rounded-none border-0 bg-transparent',
                      emptyStateProps?.className,
                    )}
                  />
                )}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow
                key={row.id}
                data-state={row.getIsSelected() ? 'selected' : undefined}
                onClick={
                  onRowClick ? () => onRowClick(row.original, row) : undefined
                }
                className={cn(
                  onRowClick &&
                    'cursor-pointer focus-within:bg-muted/40 hover:bg-muted/50',
                )}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(
                      cell.column.columnDef.cell,
                      cell.getContext(),
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
