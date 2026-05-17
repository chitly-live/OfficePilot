/**
 * `GET` and `POST` for `/api/leads/[id]/notes` (SPEC.md §6.3, §6.2 #6).
 *
 * Backs the notes timeline on the lead detail page (SPEC.md §6.1).
 * The `Note` model uses a loose `(entityType, entityId)` pair to point
 * at the parent record (a `Lead` here, but the same model serves
 * campaigns and devtasks too), so there's no Prisma relation to fold
 * into a `select`.
 *
 *   GET  /api/leads/[id]/notes  →  Authenticated. Returns notes for
 *                                  the lead in newest-first order with
 *                                  the author embedded. Both ADMIN and
 *                                  EMPLOYEE may read (leads are a
 *                                  shared pipeline — SPEC.md §2.1).
 *   POST /api/leads/[id]/notes  →  Authenticated. Validated by
 *                                  `leadNoteCreateSchema`. Writes a
 *                                  `Note` row with `entityType='lead'`
 *                                  and `authorId = session.userId`,
 *                                  then logs `lead.note_added` to
 *                                  `ActivityLog`. Returns 201 + note.
 *
 * The 404 path on a missing lead is symmetric across both verbs so a
 * stale link never lets a client write notes against a phantom row.
 *
 * Activity logging is best-effort (try/catch) so a missing audit row
 * never tanks the actual note write (SPEC.md §14).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseJsonBody,
  requireSession,
} from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { leadNoteCreateSchema } from '@/lib/schemas/leads';

// Force the Node runtime — Prisma is not Edge-compatible.
export const runtime = 'nodejs';

// Each request must hit the database; never serve a cached note feed.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Shared types & projections
// ---------------------------------------------------------------------------

/** Next.js 14 App Router dynamic-segment context shape for `[id]`. */
interface RouteContext {
  params: { id: string };
}

/**
 * Prisma `select` mask for safely returning notes over the wire. The
 * embedded `author` slice mirrors the columns exposed by
 * `userPublicProjection` (id, name, email, role, avatarUrl) so the
 * notes feed renders avatars without an N+1.
 *
 * `as const` so changes to the Note model surface as TypeScript
 * errors at the call site first.
 */
const leadNoteProjection = {
  id: true,
  body: true,
  authorId: true,
  entityType: true,
  entityId: true,
  createdAt: true,
  author: {
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      avatarUrl: true,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /api/leads/[id]/notes
// ---------------------------------------------------------------------------

/**
 * List notes for a lead, newest-first.
 *
 * Returns 404 with `{ error: 'not_found' }` when the lead doesn't
 * exist — the cheap existence check up front avoids returning an
 * empty array for a nonexistent id (which would mask a bad URL).
 *
 * Response shape: `{ items: LeadNote[] }`. Notes carry their own
 * `createdAt` so the client can render relative timestamps; we don't
 * paginate here because v1 lead notes are low-volume per-record
 * (SPEC.md §6.1 — "notes timeline" on the lead detail page).
 */
export async function GET(
  _req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    await requireSession();
    const { id } = context.params;

    // Verify the lead exists before returning notes — a 404 on the
    // parent is more useful than an empty array on a phantom id.
    const lead = await prisma.lead.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!lead) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const items = await prisma.note.findMany({
      where: { entityType: 'lead', entityId: id },
      select: leadNoteProjection,
      // Newest-first plus a stable tie-breaker on id so concurrently
      // created notes always order deterministically.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    return NextResponse.json({ items });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// POST /api/leads/[id]/notes
// ---------------------------------------------------------------------------

/**
 * Create a note on a lead.
 *
 * Authenticated users (any role) may add notes — leads are a shared
 * pipeline, and notes are an annotation channel for the team. The
 * author is always `session.userId`; we never trust an `authorId`
 * from the body.
 *
 * Flow:
 *   1. Authenticate the session.
 *   2. Validate the body via `leadNoteCreateSchema`.
 *   3. Confirm the parent lead exists (404 otherwise).
 *   4. Insert the `Note` row.
 *   5. Best-effort `lead.note_added` activity log (failures are
 *      swallowed so a missing audit row never blocks the write).
 *   6. Return 201 with the new note (author embedded).
 */
export async function POST(
  req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { id } = context.params;

    const input = await parseJsonBody(req, leadNoteCreateSchema);

    // Confirm the parent exists. We capture `name` for the activity
    // log's `entityName` so the timeline reads "User added a note to
    // lead Acme Corp" rather than the bare cuid.
    const lead = await prisma.lead.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!lead) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const note = await prisma.note.create({
      data: {
        body: input.body,
        authorId: session.userId,
        entityType: 'lead',
        entityId: lead.id,
      },
      select: leadNoteProjection,
    });

    // Best-effort audit log. Logging propagates errors by design (see
    // `src/lib/activity.ts`), so wrap to keep the route resilient.
    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.LEAD_NOTE_ADDED,
        entityType: 'lead',
        entityId: lead.id,
        leadId: lead.id,
        metadata: {
          noteId: note.id,
          entityName: lead.name,
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/leads/[id]/notes] activity log failed', logErr);
    }

    return NextResponse.json(note, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
