'use client';

/**
 * KanbanBoard — generic drag-and-drop kanban built on `@dnd-kit`.
 *
 * Two consumers in the SPEC:
 *
 *   • /leads — 6-stage funnel (NEW → CONTACTED → INTERESTED →
 *     FOLLOW_UP → CONVERTED → LOST), see SPEC §6.2.2.
 *   • /dev   — 3-stage flow (TODO → DOING → DONE), see SPEC §9.2.1.
 *
 * Generic over the card payload type so each consumer keeps full
 * type-safety on its own item shape:
 *
 *   <KanbanBoard<Lead>
 *     columns={leadColumns}
 *     items={leads}
 *     onItemMove={(item, fromColId, toColId) => mutate(item, toColId)}
 *     renderCard={(lead) => <LeadCard lead={lead} />}
 *     getItemColumn={(lead) => lead.status}
 *   />
 *
 * Drag-drop semantics:
 *   • Pointer + keyboard sensors (a11y).
 *   • Drop target = whole column (so empty columns still accept
 *     cards) AND individual cards (sortable order within a column).
 *   • `onItemMove` fires when an item lands in a different column.
 *     Re-ordering within the same column is a no-op for now (SPEC
 *     doesn't require it on the kanban surface — modules use
 *     `displayOrder` only for stage-level position which the API
 *     re-derives).
 *
 * Mobile (SPEC §13.2): below `md` we render a horizontally-scrolling
 * single-column-at-a-time strip with snap. The user swipes between
 * columns rather than seeing all of them shrunken.
 *
 * Loading / empty states: pass `isLoading` to render a skeleton
 * column set; pass `emptyState` to swap the global "no records yet"
 * surface (each column independently shows "No items" when empty,
 * no extra wiring required).
 *
 * Client component — `@dnd-kit` is hooks-driven and the component
 * holds local drag state.
 */

import * as React from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface KanbanColumn {
  /** Unique column id. Typically the status enum value. */
  id: string;
  /** Header label shown above the column. */
  title: React.ReactNode;
  /**
   * Optional accent color class for the column header. Defaults to
   * the theme's muted foreground.
   */
  accentClassName?: string;
}

export interface KanbanBoardProps<TItem> {
  /** Column definitions, in the order they render left-to-right. */
  columns: KanbanColumn[];
  /** All items, regardless of column. */
  items: TItem[];
  /**
   * Resolve which column a given item belongs to. Typically returns
   * `item.status`. The result MUST match a `column.id` from
   * `columns`; items whose column doesn't exist are silently dropped
   * (preferred over throwing — keeps the UI rendering when a status
   * enum gets a new value before the columns array is updated).
   */
  getItemColumn: (item: TItem) => string;
  /** Stable id for an item — typically the database id. */
  getItemId: (item: TItem) => string;
  /**
   * Called after the user drops a card in a different column.
   * Same-column reorders are NOT emitted (see file-level docs).
   */
  onItemMove: (item: TItem, fromColumnId: string, toColumnId: string) => void;
  /** Render the body of a single card. */
  renderCard: (item: TItem) => React.ReactNode;
  /**
   * Optional render override for the column header. Defaults to a
   * simple title row with item count.
   */
  renderColumnHeader?: (column: KanbanColumn, count: number) => React.ReactNode;
  /**
   * When true, swap the columns for skeleton placeholders (3 cards
   * per column). SPEC §13.4.
   */
  isLoading?: boolean;
  /**
   * Optional global empty state — rendered above the columns when
   * `items.length === 0`. Per-column emptiness still uses the
   * lightweight built-in label.
   */
  emptyState?: React.ReactNode;
  /** Disable drag-and-drop (read-only board, e.g. for non-owners). */
  disableDrag?: boolean;
  /** Extra classes on the outer container. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Internal: card
// ---------------------------------------------------------------------------

interface KanbanCardProps {
  id: string;
  disabled?: boolean;
  children: React.ReactNode;
}

function KanbanCard({ id, disabled, children }: KanbanCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        'rounded-md border bg-card p-3 text-sm shadow-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        !disabled && 'cursor-grab active:cursor-grabbing',
        isDragging && 'opacity-60 ring-2 ring-brand-500',
      )}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal: column
// ---------------------------------------------------------------------------

interface KanbanColumnViewProps<TItem> {
  column: KanbanColumn;
  items: TItem[];
  getItemId: (item: TItem) => string;
  renderCard: (item: TItem) => React.ReactNode;
  renderHeader?: (column: KanbanColumn, count: number) => React.ReactNode;
  disableDrag?: boolean;
}

function KanbanColumnView<TItem>({
  column,
  items,
  getItemId,
  renderCard,
  renderHeader,
  disableDrag,
}: KanbanColumnViewProps<TItem>) {
  // Whole column is a droppable so cards can be dropped onto an
  // empty column (SortableContext alone wouldn't accept drops with
  // no items).
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  const itemIds = items.map(getItemId);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        // Column shell — fixed comfortable width on desktop, full
        // width with snap on mobile.
        'flex w-full shrink-0 snap-start flex-col gap-2 rounded-lg border bg-muted/30 p-3 md:w-72',
        isOver && 'ring-2 ring-brand-500',
      )}
      data-column-id={column.id}
    >
      {renderHeader ? (
        renderHeader(column, items.length)
      ) : (
        <div className="flex items-center justify-between px-1">
          <h3
            className={cn(
              'text-xs font-semibold uppercase tracking-wide text-muted-foreground',
              column.accentClassName,
            )}
          >
            {column.title}
          </h3>
          <span className="text-xs text-muted-foreground">{items.length}</span>
        </div>
      )}

      <SortableContext
        id={column.id}
        items={itemIds}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex flex-col gap-2">
          {items.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
              No items
            </div>
          ) : (
            items.map((item) => (
              <KanbanCard
                key={getItemId(item)}
                id={getItemId(item)}
                disabled={disableDrag}
              >
                {renderCard(item)}
              </KanbanCard>
            ))
          )}
        </div>
      </SortableContext>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal: skeleton
// ---------------------------------------------------------------------------

function KanbanSkeleton({ columns }: { columns: KanbanColumn[] }) {
  return (
    <>
      {columns.map((column) => (
        <div
          key={column.id}
          className="flex w-full shrink-0 snap-start flex-col gap-2 rounded-lg border bg-muted/30 p-3 md:w-72"
        >
          <div className="flex items-center justify-between px-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {column.title}
            </h3>
            <Skeleton className="h-4 w-6" />
          </div>
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }).map((_, idx) => (
              <Skeleton key={idx} className="h-16 w-full rounded-md" />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/** See file-level JSDoc. */
export function KanbanBoard<TItem>({
  columns,
  items,
  getItemColumn,
  getItemId,
  onItemMove,
  renderCard,
  renderColumnHeader,
  isLoading = false,
  emptyState,
  disableDrag = false,
  className,
}: KanbanBoardProps<TItem>) {
  // Group items by column. Use a Map to preserve insertion order
  // from the `items` array within each column — drives the
  // displayed order on the board.
  const itemsByColumn = React.useMemo(() => {
    const map = new Map<string, TItem[]>();
    for (const column of columns) {
      map.set(column.id, []);
    }
    for (const item of items) {
      const colId = getItemColumn(item);
      const bucket = map.get(colId);
      if (bucket) bucket.push(item);
      // Items whose column id doesn't appear in `columns` are
      // intentionally dropped — see file-level docs.
    }
    return map;
  }, [columns, items, getItemColumn]);

  // Quick lookup: item id → item, used during drag-end resolution.
  const itemsById = React.useMemo(() => {
    const map = new Map<string, TItem>();
    for (const item of items) {
      map.set(getItemId(item), item);
    }
    return map;
  }, [items, getItemId]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Track which column a drag started in so we can detect cross-
  // column moves on drop.
  const dragOriginRef = React.useRef<string | null>(null);

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    const item = itemsById.get(id);
    dragOriginRef.current = item ? getItemColumn(item) : null;
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    const origin = dragOriginRef.current;
    dragOriginRef.current = null;
    if (!over || !origin) return;

    const activeItem = itemsById.get(String(active.id));
    if (!activeItem) return;

    // The drop target's id is either:
    //   • a column id (when dropped over the column container or its
    //     empty placeholder), or
    //   • another item's id (when dropped over an existing card).
    // Resolve to a column id either way.
    const overId = String(over.id);
    const targetColumnId = columns.some((c) => c.id === overId)
      ? overId
      : itemsById.has(overId)
        ? getItemColumn(itemsById.get(overId)!)
        : null;

    if (!targetColumnId || targetColumnId === origin) return;

    onItemMove(activeItem, origin, targetColumnId);
  };

  const showGlobalEmpty = !isLoading && items.length === 0 && emptyState;

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {showGlobalEmpty ? <div>{emptyState}</div> : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div
          className={cn(
            // Mobile: horizontal scroll, full-width single-column
            // snap (SPEC §13.2). Desktop: side-by-side columns.
            'flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 md:snap-none',
          )}
        >
          {isLoading ? (
            <KanbanSkeleton columns={columns} />
          ) : (
            columns.map((column) => (
              <KanbanColumnView<TItem>
                key={column.id}
                column={column}
                items={itemsByColumn.get(column.id) ?? []}
                getItemId={getItemId}
                renderCard={renderCard}
                renderHeader={renderColumnHeader}
                disableDrag={disableDrag}
              />
            ))
          )}
        </div>
      </DndContext>
    </div>
  );
}
