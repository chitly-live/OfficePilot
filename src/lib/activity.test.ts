/**
 * Property-based + example tests for `src/lib/activity.ts`.
 *
 * Validates: Requirements 13.1, 13.2, 15.1
 *
 * Spec references:
 *   - SPEC.md §14 — Activity logging vocabulary (every state-changing
 *     endpoint persists an `ActivityLog` row).
 *   - SPEC.md §16.1 — Vitest unit tests, ≥80 % line coverage on `lib/`.
 *   - design.md §"Activity Logging" — `logActivity(...)` is called from API
 *     handlers; `formatActivity(...)` renders rows for the timeline UI.
 *
 * The unit under test exposes two surfaces:
 *
 *   1. {@link logActivity} — DI-style writer. We pass a structural test
 *      double (`{ activityLog: { create: vi.fn() } }`) that satisfies the
 *      `ActivityLogWriter` interface, so we can assert call shape without
 *      touching Prisma.
 *   2. {@link formatActivity} — pure formatter. Tests are example-based
 *      per action variant, plus a property-based smoke test that every
 *      action in {@link ACTIVITY_ACTIONS} produces a non-empty string.
 */

import { describe, expect, it, vi } from 'vitest';
import * as fc from 'fast-check';

import {
  ACTIVITY_ACTIONS,
  formatActivity,
  logActivity,
  type ActivityLogWriter,
  type LogActivityParams,
} from './activity';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal `ActivityLogWriter` test double whose `create` method is
 * a `vi.fn()` resolving to a synthetic `ActivityLog` row. The shape is
 * intentionally loose — `logActivity` only ever reads `data` from the
 * arguments and returns whatever `create` resolves with.
 */
function makeWriter(
  overrides: Partial<{
    resolveValue: unknown;
    rejectValue: unknown;
  }> = {},
): { writer: ActivityLogWriter; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn();
  if (overrides.rejectValue !== undefined) {
    create.mockRejectedValueOnce(overrides.rejectValue);
  } else {
    create.mockResolvedValueOnce(
      overrides.resolveValue ?? {
        id: 'act_test_id',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        userId: 'user_x',
        action: 'lead.created',
        entityType: 'lead',
        entityId: 'lead_x',
        leadId: null,
        metadata: null,
      },
    );
  }
  return {
    writer: { activityLog: { create } } as unknown as ActivityLogWriter,
    create,
  };
}

// ---------------------------------------------------------------------------
// logActivity — happy paths + DI shape
// ---------------------------------------------------------------------------

describe('logActivity — common fields', () => {
  it('forwards userId, action, entityType, and entityId verbatim into create.data', async () => {
    const { writer, create } = makeWriter();
    const params: LogActivityParams = {
      userId: 'user_123',
      action: ACTIVITY_ACTIONS.LEAD_CREATED,
      entityType: 'lead',
      entityId: 'lead_456',
    };
    await logActivity(writer, params);
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.userId).toBe('user_123');
    expect(arg.data.action).toBe('lead.created');
    expect(arg.data.entityType).toBe('lead');
    expect(arg.data.entityId).toBe('lead_456');
  });

  it('returns the row produced by create() unchanged to the caller', async () => {
    const fakeRow = {
      id: 'act_unique_xyz',
      createdAt: new Date('2026-02-02T00:00:00Z'),
      userId: 'user_a',
      action: 'lead.created',
      entityType: 'lead',
      entityId: 'lead_a',
      leadId: null,
      metadata: null,
    };
    const { writer } = makeWriter({ resolveValue: fakeRow });
    const result = await logActivity(writer, {
      userId: 'user_a',
      action: ACTIVITY_ACTIONS.LEAD_CREATED,
      entityType: 'lead',
      entityId: 'lead_a',
    });
    expect(result).toBe(fakeRow);
  });
});

describe('logActivity — leadId handling', () => {
  it('includes leadId when caller passes a string', async () => {
    const { writer, create } = makeWriter();
    await logActivity(writer, {
      userId: 'u1',
      action: ACTIVITY_ACTIONS.LEAD_NOTE_ADDED,
      entityType: 'lead',
      entityId: 'lead_1',
      leadId: 'lead_1',
      metadata: { noteId: 'note_1' },
    });
    const data = create.mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data.leadId).toBe('lead_1');
    expect('leadId' in data).toBe(true);
  });

  it('passes leadId: null through verbatim when caller explicitly passes null', async () => {
    const { writer, create } = makeWriter();
    await logActivity(writer, {
      userId: 'u1',
      action: ACTIVITY_ACTIONS.USER_LOGIN,
      entityType: 'user',
      entityId: 'u1',
      leadId: null,
    });
    const data = create.mock.calls[0]![0]!.data as Record<string, unknown>;
    expect('leadId' in data).toBe(true);
    expect(data.leadId).toBeNull();
  });

  it('omits leadId entirely when caller leaves it undefined', async () => {
    const { writer, create } = makeWriter();
    await logActivity(writer, {
      userId: 'u1',
      action: ACTIVITY_ACTIONS.CAMPAIGN_CREATED,
      entityType: 'campaign',
      entityId: 'cmp_1',
    });
    const data = create.mock.calls[0]![0]!.data as Record<string, unknown>;
    expect('leadId' in data).toBe(false);
  });
});

describe('logActivity — metadata handling', () => {
  it('passes structured metadata through to Prisma as the JSON value', async () => {
    const { writer, create } = makeWriter();
    await logActivity(writer, {
      userId: 'u1',
      action: ACTIVITY_ACTIONS.LEAD_STATUS_CHANGED,
      entityType: 'lead',
      entityId: 'lead_1',
      leadId: 'lead_1',
      metadata: { from: 'NEW', to: 'CONTACTED' },
    });
    const data = create.mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data.metadata).toEqual({ from: 'NEW', to: 'CONTACTED' });
  });

  it('omits metadata entirely when caller does not provide it', async () => {
    const { writer, create } = makeWriter();
    await logActivity(writer, {
      userId: 'u1',
      action: ACTIVITY_ACTIONS.DEVTASK_COMPLETED,
      entityType: 'devtask',
      entityId: 'task_1',
    });
    const data = create.mock.calls[0]![0]!.data as Record<string, unknown>;
    expect('metadata' in data).toBe(false);
  });

  it('preserves complex nested metadata shapes (arrays, numbers, nested objects)', async () => {
    const { writer, create } = makeWriter();
    await logActivity(writer, {
      userId: 'u1',
      action: ACTIVITY_ACTIONS.CAMPAIGN_METRICS_UPDATED,
      entityType: 'campaign',
      entityId: 'cmp_1',
      metadata: {
        fields: ['spent', 'clicks'],
        userName: 'Jane',
        entityName: 'Spring Sale',
      },
    });
    const data = create.mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(data.metadata).toEqual({
      fields: ['spent', 'clicks'],
      userName: 'Jane',
      entityName: 'Spring Sale',
    });
  });
});

describe('logActivity — error propagation', () => {
  it('rejects with the error produced by create() (no swallowing)', async () => {
    const boom = new Error('prisma exploded');
    const { writer } = makeWriter({ rejectValue: boom });
    await expect(
      logActivity(writer, {
        userId: 'u1',
        action: ACTIVITY_ACTIONS.LEAD_CREATED,
        entityType: 'lead',
        entityId: 'lead_1',
      }),
    ).rejects.toBe(boom);
  });

  it('does not retry or call create() more than once on failure', async () => {
    const { writer, create } = makeWriter({ rejectValue: new Error('nope') });
    await logActivity(writer, {
      userId: 'u1',
      action: ACTIVITY_ACTIONS.LEAD_CREATED,
      entityType: 'lead',
      entityId: 'lead_1',
    }).catch(() => {});
    expect(create).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// formatActivity — example-based per action type
// ---------------------------------------------------------------------------

const BASE = {
  userId: 'user_xyz',
  entityType: 'lead',
  entityId: 'lead_abc',
};

describe('formatActivity — users / auth', () => {
  it('USER_CREATED renders with userName + entityName from metadata', () => {
    const out = formatActivity({
      ...BASE,
      entityType: 'user',
      entityId: 'u2',
      action: ACTIVITY_ACTIONS.USER_CREATED,
      metadata: { userName: 'Alice', entityName: 'Bob' },
    });
    expect(out).toBe('Alice created user Bob');
  });

  it('USER_UPDATED falls back to "User {id}" / "{type} {id}" without metadata', () => {
    const out = formatActivity({
      ...BASE,
      entityType: 'user',
      entityId: 'u2',
      action: ACTIVITY_ACTIONS.USER_UPDATED,
    });
    expect(out).toBe('User user_xyz updated user user u2');
  });

  it('USER_DEACTIVATED reads entityName from metadata', () => {
    const out = formatActivity({
      ...BASE,
      entityType: 'user',
      entityId: 'u2',
      action: ACTIVITY_ACTIONS.USER_DEACTIVATED,
      metadata: { userName: 'Alice', entityName: 'Bob' },
    });
    expect(out).toBe('Alice deactivated user Bob');
  });

  it('USER_LOGIN does not reference any entity name', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.USER_LOGIN,
      metadata: { userName: 'Alice' },
    });
    expect(out).toBe('Alice logged in');
  });

  it('ATTENDANCE_MARKED with status + date', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.ATTENDANCE_MARKED,
      metadata: { userName: 'Alice', status: 'PRESENT', date: '2026-01-15' },
    });
    expect(out).toBe('Alice marked attendance as PRESENT on 2026-01-15');
  });

  it('ATTENDANCE_MARKED with status only (no date)', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.ATTENDANCE_MARKED,
      metadata: { userName: 'Alice', status: 'WFH' },
    });
    expect(out).toBe('Alice marked attendance as WFH');
  });

  it('ATTENDANCE_MARKED with neither status nor date', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.ATTENDANCE_MARKED,
      metadata: { userName: 'Alice' },
    });
    expect(out).toBe('Alice marked attendance');
  });
});

describe('formatActivity — leads', () => {
  it('LEAD_CREATED reads entityName from metadata', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_CREATED,
      metadata: { userName: 'Alice', entityName: 'Acme Corp' },
    });
    expect(out).toBe('Alice created lead Acme Corp');
  });

  it('LEAD_UPDATED renders with display hints', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_UPDATED,
      metadata: { userName: 'Alice', entityName: 'Acme' },
    });
    expect(out).toBe('Alice updated lead Acme');
  });

  it('LEAD_STATUS_CHANGED with from + to renders the transition', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_STATUS_CHANGED,
      metadata: {
        userName: 'Alice',
        entityName: 'Acme',
        from: 'NEW',
        to: 'CONTACTED',
      },
    });
    expect(out).toBe('Alice moved lead Acme from NEW to CONTACTED');
  });

  it('LEAD_STATUS_CHANGED falls back when metadata is missing from/to', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_STATUS_CHANGED,
      metadata: { userName: 'Alice', entityName: 'Acme' },
    });
    expect(out).toBe('Alice changed status of lead Acme');
  });

  it('LEAD_STATUS_CHANGED falls back when metadata is missing entirely', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_STATUS_CHANGED,
    });
    expect(out).toBe('User user_xyz changed status of lead lead lead_abc');
  });

  it('LEAD_ASSIGNED prefers toOwnerName over toOwnerId', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_ASSIGNED,
      metadata: {
        userName: 'Alice',
        entityName: 'Acme',
        toOwnerId: 'u_999',
        toOwnerName: 'Bob',
      },
    });
    expect(out).toBe('Alice assigned lead Acme to Bob');
  });

  it('LEAD_ASSIGNED falls back to toOwnerId when name absent', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_ASSIGNED,
      metadata: {
        userName: 'Alice',
        entityName: 'Acme',
        toOwnerId: 'u_999',
      },
    });
    expect(out).toBe('Alice assigned lead Acme to u_999');
  });

  it('LEAD_ASSIGNED renders generic "reassigned" when no owner info present', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_ASSIGNED,
      metadata: { userName: 'Alice', entityName: 'Acme' },
    });
    expect(out).toBe('Alice reassigned lead Acme');
  });

  it('LEAD_CONVERTED + LEAD_DELETED render conversion / deletion', () => {
    const meta = { userName: 'Alice', entityName: 'Acme' };
    expect(
      formatActivity({
        ...BASE,
        action: ACTIVITY_ACTIONS.LEAD_CONVERTED,
        metadata: meta,
      }),
    ).toBe('Alice converted lead Acme');
    expect(
      formatActivity({
        ...BASE,
        action: ACTIVITY_ACTIONS.LEAD_DELETED,
        metadata: meta,
      }),
    ).toBe('Alice deleted lead Acme');
  });

  it('LEAD_IMPORTED with imported + skipped numbers', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_IMPORTED,
      metadata: {
        userName: 'Alice',
        rowsTotal: 100,
        rowsImported: 95,
        rowsSkipped: 5,
      },
    });
    expect(out).toBe('Alice imported 95 leads (5 skipped)');
  });

  it('LEAD_IMPORTED with imported only renders without skipped count', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_IMPORTED,
      metadata: { userName: 'Alice', rowsImported: 12 },
    });
    expect(out).toBe('Alice imported 12 leads');
  });

  it('LEAD_IMPORTED falls back when no row counts are present', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_IMPORTED,
      metadata: { userName: 'Alice' },
    });
    expect(out).toBe('Alice imported leads from CSV');
  });

  it('LEAD_NOTE_ADDED renders generically', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_NOTE_ADDED,
      metadata: { userName: 'Alice', entityName: 'Acme' },
    });
    expect(out).toBe('Alice added a note to lead Acme');
  });

  it('LEAD_WEBHOOK_RECEIVED uses entityName but ignores userName (system-driven)', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_WEBHOOK_RECEIVED,
      metadata: { entityName: 'Acme' },
    });
    expect(out).toBe('Lead Acme received via webhook');
  });
});

describe('formatActivity — marketing', () => {
  it('CAMPAIGN_CREATED + CAMPAIGN_UPDATED', () => {
    const meta = { userName: 'Jane', entityName: 'Spring Sale' };
    expect(
      formatActivity({
        ...BASE,
        action: ACTIVITY_ACTIONS.CAMPAIGN_CREATED,
        metadata: meta,
      }),
    ).toBe('Jane created campaign Spring Sale');
    expect(
      formatActivity({
        ...BASE,
        action: ACTIVITY_ACTIONS.CAMPAIGN_UPDATED,
        metadata: meta,
      }),
    ).toBe('Jane updated campaign Spring Sale');
  });

  it('CAMPAIGN_METRICS_UPDATED with fields list joins them with commas', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.CAMPAIGN_METRICS_UPDATED,
      metadata: {
        userName: 'Jane',
        entityName: 'Spring Sale',
        fields: ['spent', 'clicks', 'signups'],
      },
    });
    expect(out).toBe('Jane updated spent, clicks, signups on campaign Spring Sale');
  });

  it('CAMPAIGN_METRICS_UPDATED falls back when fields array is empty / missing', () => {
    const out1 = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.CAMPAIGN_METRICS_UPDATED,
      metadata: {
        userName: 'Jane',
        entityName: 'Spring Sale',
        fields: [],
      },
    });
    const out2 = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.CAMPAIGN_METRICS_UPDATED,
      metadata: { userName: 'Jane', entityName: 'Spring Sale' },
    });
    expect(out1).toBe('Jane updated metrics on campaign Spring Sale');
    expect(out2).toBe('Jane updated metrics on campaign Spring Sale');
  });

  it('CAMPAIGN_SPENT_UPDATED with positive delta renders "increased"', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.CAMPAIGN_SPENT_UPDATED,
      metadata: { userName: 'Jane', entityName: 'Spring Sale', delta: 5000 },
    });
    expect(out).toBe('Jane increased campaign spend by ₹5,000 on Spring Sale');
  });

  it('CAMPAIGN_SPENT_UPDATED with negative delta renders "decreased"', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.CAMPAIGN_SPENT_UPDATED,
      metadata: { userName: 'Jane', entityName: 'Spring Sale', delta: -1500 },
    });
    expect(out).toBe('Jane decreased campaign spend by ₹1,500 on Spring Sale');
  });

  it('CAMPAIGN_SPENT_UPDATED with zero delta renders "increased by ₹0"', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.CAMPAIGN_SPENT_UPDATED,
      metadata: { userName: 'Jane', entityName: 'Spring Sale', delta: 0 },
    });
    expect(out).toBe('Jane increased campaign spend by ₹0 on Spring Sale');
  });

  it('CAMPAIGN_SPENT_UPDATED falls back when delta is missing', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.CAMPAIGN_SPENT_UPDATED,
      metadata: { userName: 'Jane', entityName: 'Spring Sale' },
    });
    expect(out).toBe('Jane updated campaign spend on Spring Sale');
  });

  it('CAMPAIGN_DELETED renders deletion', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.CAMPAIGN_DELETED,
      metadata: { userName: 'Jane', entityName: 'Spring Sale' },
    });
    expect(out).toBe('Jane deleted campaign Spring Sale');
  });
});

describe('formatActivity — social', () => {
  it('SOCIALPOST_CREATED renders draft', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.SOCIALPOST_CREATED,
      metadata: { userName: 'Rahul' },
    });
    expect(out).toBe('Rahul drafted a social post');
  });

  it('SOCIALPOST_UPDATED renders update', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.SOCIALPOST_UPDATED,
      metadata: { userName: 'Rahul', entityName: 'post-1' },
    });
    expect(out).toBe('Rahul updated social post post-1');
  });

  it('SOCIALPOST_PUBLISHED title-cases the platform', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.SOCIALPOST_PUBLISHED,
      metadata: { userName: 'Rahul', platform: 'INSTAGRAM' },
    });
    expect(out).toBe('Rahul published Instagram post');
  });

  it('SOCIALPOST_PUBLISHED falls back when platform is missing', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.SOCIALPOST_PUBLISHED,
      metadata: { userName: 'Rahul', entityName: 'post-1' },
    });
    expect(out).toBe('Rahul published social post post-1');
  });

  it('SOCIALPOST_WINNER_MARKED with isWinner=true marks as winner', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.SOCIALPOST_WINNER_MARKED,
      metadata: { userName: 'Rahul', entityName: 'post-1', isWinner: true },
    });
    expect(out).toBe('Rahul marked social post post-1 as winner');
  });

  it('SOCIALPOST_WINNER_MARKED with isWinner=false unmarks', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.SOCIALPOST_WINNER_MARKED,
      metadata: { userName: 'Rahul', entityName: 'post-1', isWinner: false },
    });
    expect(out).toBe('Rahul unmarked social post post-1 as winner');
  });

  it('SOCIALPOST_WINNER_MARKED defaults to "marked as winner" when isWinner missing', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.SOCIALPOST_WINNER_MARKED,
      metadata: { userName: 'Rahul', entityName: 'post-1' },
    });
    expect(out).toBe('Rahul marked social post post-1 as winner');
  });

  it('SOCIALPOST_DELETED renders deletion', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.SOCIALPOST_DELETED,
      metadata: { userName: 'Rahul', entityName: 'post-1' },
    });
    expect(out).toBe('Rahul deleted social post post-1');
  });
});

describe('formatActivity — dev tasks', () => {
  it('DEVTASK_CREATED renders creation', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.DEVTASK_CREATED,
      metadata: { userName: 'Priya', entityName: 'UI polish' },
    });
    expect(out).toBe('Priya created task UI polish');
  });

  it('DEVTASK_MOVED with from + to renders the transition', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.DEVTASK_MOVED,
      metadata: {
        userName: 'Priya',
        entityName: 'UI polish',
        from: 'TODO',
        to: 'DOING',
      },
    });
    expect(out).toBe('Priya moved task UI polish from TODO to DOING');
  });

  it('DEVTASK_MOVED falls back when from/to are missing', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.DEVTASK_MOVED,
      metadata: { userName: 'Priya', entityName: 'UI polish' },
    });
    expect(out).toBe('Priya moved task UI polish');
  });

  it('DEVTASK_COMPLETED + DEVTASK_DELETED', () => {
    const meta = { userName: 'Priya', entityName: 'UI polish' };
    expect(
      formatActivity({
        ...BASE,
        action: ACTIVITY_ACTIONS.DEVTASK_COMPLETED,
        metadata: meta,
      }),
    ).toBe('Priya completed task UI polish');
    expect(
      formatActivity({
        ...BASE,
        action: ACTIVITY_ACTIONS.DEVTASK_DELETED,
        metadata: meta,
      }),
    ).toBe('Priya deleted task UI polish');
  });
});

describe('formatActivity — AI', () => {
  it('AI_INSIGHT_GENERATED with scope renders scope', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.AI_INSIGHT_GENERATED,
      metadata: { userName: 'Alice', scope: 'leads' },
    });
    expect(out).toBe('Alice generated leads insight');
  });

  it('AI_INSIGHT_GENERATED falls back when scope is missing', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.AI_INSIGHT_GENERATED,
      metadata: { userName: 'Alice' },
    });
    expect(out).toBe('Alice generated AI insight');
  });

  it('AI_INSIGHT_ACTIONED with scope renders scope', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.AI_INSIGHT_ACTIONED,
      metadata: { userName: 'Alice', scope: 'ads' },
    });
    expect(out).toBe('Alice actioned ads insight');
  });

  it('AI_INSIGHT_ACTIONED falls back when scope is missing', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.AI_INSIGHT_ACTIONED,
    });
    expect(out).toBe('User user_xyz actioned AI insight');
  });
});

// ---------------------------------------------------------------------------
// formatActivity — malformed / edge metadata
// ---------------------------------------------------------------------------

describe('formatActivity — malformed metadata', () => {
  it('treats null metadata as if metadata were absent', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_CREATED,
      metadata: null,
    });
    expect(out).toBe('User user_xyz created lead lead lead_abc');
  });

  it('treats string metadata as absent (not a plain object)', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_CREATED,
      metadata: 'not an object',
    });
    expect(out).toBe('User user_xyz created lead lead lead_abc');
  });

  it('treats array metadata as absent (not a plain object)', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_CREATED,
      metadata: ['unexpected', 'shape'],
    });
    expect(out).toBe('User user_xyz created lead lead lead_abc');
  });

  it('ignores empty-string display hints and falls back to defaults', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_CREATED,
      metadata: { userName: '', entityName: '' },
    });
    expect(out).toBe('User user_xyz created lead lead lead_abc');
  });

  it('ignores non-string userName / entityName values', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_CREATED,
      metadata: { userName: 42, entityName: { nested: true } },
    });
    expect(out).toBe('User user_xyz created lead lead lead_abc');
  });

  it('ignores non-finite numeric metadata in LEAD_IMPORTED', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.LEAD_IMPORTED,
      metadata: {
        userName: 'Alice',
        rowsImported: Number.NaN,
        rowsSkipped: Number.POSITIVE_INFINITY,
      },
    });
    expect(out).toBe('Alice imported leads from CSV');
  });

  it('ignores non-string entries inside the fields array', () => {
    const out = formatActivity({
      ...BASE,
      action: ACTIVITY_ACTIONS.CAMPAIGN_METRICS_UPDATED,
      metadata: {
        userName: 'Jane',
        entityName: 'Spring Sale',
        fields: ['spent', 123, null, 'clicks'],
      },
    });
    expect(out).toBe('Jane updated spent, clicks on campaign Spring Sale');
  });

  it('returns a generic fallback for unknown action strings', () => {
    const out = formatActivity({
      ...BASE,
      action: 'mystery.event_we_have_not_seen_before',
      metadata: { userName: 'Alice', entityName: 'X' },
    });
    expect(out).toBe('Alice performed mystery.event_we_have_not_seen_before on X');
  });
});

// ---------------------------------------------------------------------------
// Property — formatActivity is total over ACTIVITY_ACTIONS
// ---------------------------------------------------------------------------

describe('Property — formatActivity is total over ACTIVITY_ACTIONS', () => {
  it('returns a non-empty string for every (action, userId, entityType, entityId)', () => {
    const actionArb = fc.constantFrom(...Object.values(ACTIVITY_ACTIONS));
    const idArb = fc.string({ minLength: 1, maxLength: 32 });
    fc.assert(
      fc.property(actionArb, idArb, idArb, idArb, (action, userId, entityType, entityId) => {
        const out = formatActivity({ userId, action, entityType, entityId });
        expect(typeof out).toBe('string');
        expect(out.length).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });

  it('returns a non-empty string regardless of arbitrary metadata shapes', () => {
    const actionArb = fc.constantFrom(...Object.values(ACTIVITY_ACTIONS));
    const idArb = fc.string({ minLength: 1, maxLength: 32 });
    const metaArb = fc.option(
      fc.oneof(
        fc.constant(null),
        fc.string(),
        fc.integer(),
        fc.array(fc.anything()),
        fc.object(),
      ),
      { nil: undefined, freq: 4 },
    );

    fc.assert(
      fc.property(
        actionArb,
        idArb,
        idArb,
        idArb,
        metaArb,
        (action, userId, entityType, entityId, metadata) => {
          const out = formatActivity({
            userId,
            action,
            entityType,
            entityId,
            metadata,
          });
          expect(typeof out).toBe('string');
          expect(out.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 300 },
    );
  });
});
