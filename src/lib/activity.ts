/**
 * Activity logging helpers for OfficePilot.
 *
 * Every state-changing API endpoint persists a row to `ActivityLog` so the
 * Employees module's profile timeline (SPEC.md §5.2 feature 5) and the
 * dashboard's "recent activity" sidebar can surface a unified audit trail.
 *
 * This module exports three things:
 *
 *   1. {@link ACTIVITY_ACTIONS} — the canonical, app-wide vocabulary of
 *      action strings, listed in SCREAMING_SNAKE_CASE keyed to the dotted
 *      values stored in `ActivityLog.action` (per SPEC.md §14).
 *   2. {@link logActivity} — a side-effecting writer that takes a Prisma
 *      client (or compatible test double / transactional `tx`) by
 *      dependency injection so route handlers and tests share one
 *      implementation. Returns the created `ActivityLog` row.
 *   3. {@link formatActivity} — a *pure* function that converts a stored
 *      `ActivityLog` row into a human-readable line for activity feeds
 *      (e.g. "John Doe converted lead Acme Corp"). Reads display strings
 *      out of the row's `metadata` JSON; falls back gracefully when those
 *      fields are absent.
 *
 * The metadata schema is modelled as a TypeScript discriminated union
 * keyed on `action`, so call sites get tooling-friendly autocomplete and
 * compile-time validation of the metadata they store. Unknown actions
 * fall through to a generic variant — useful for forward-compat in tests
 * and ad-hoc instrumentation.
 */

import type { ActivityLog, Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Action vocabulary
// ---------------------------------------------------------------------------

/**
 * Canonical map of activity-action SCREAMING_SNAKE_CASE keys to the dotted
 * lowercase strings stored in `ActivityLog.action`.
 *
 * The values are the ground truth — they appear verbatim in DB rows and in
 * SPEC.md §14. Use the keys at call sites for type-safety:
 *
 *   logActivity(prisma, {
 *     userId,
 *     action: ACTIVITY_ACTIONS.LEAD_STATUS_CHANGED,
 *     entityType: 'lead',
 *     entityId: lead.id,
 *     leadId: lead.id,
 *     metadata: { from: 'NEW', to: 'CONTACTED' },
 *   });
 *
 * The non-exhaustive list called out in SPEC.md §14 is included here in
 * full, plus the per-module additions implied by the API design (notes,
 * imports, attendance, login, etc.).
 */
export const ACTIVITY_ACTIONS = {
  // Users / auth (Employees module — SPEC.md §5)
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DEACTIVATED: 'user.deactivated',
  USER_LOGIN: 'user.login',
  // Per-module access whitelist change (FEATURE-A / v0.1.3). Carries
  // `from` and `to` arrays in metadata so the audit feed can show the
  // exact transition.
  USER_MODULE_ACCESS_CHANGED: 'user.module_access_changed',
  ATTENDANCE_MARKED: 'user.attendance_marked',

  // Leads module — SPEC.md §6
  LEAD_CREATED: 'lead.created',
  LEAD_UPDATED: 'lead.updated',
  LEAD_STATUS_CHANGED: 'lead.status_changed',
  LEAD_ASSIGNED: 'lead.assigned',
  LEAD_CONVERTED: 'lead.converted',
  LEAD_DELETED: 'lead.deleted',
  LEAD_IMPORTED: 'lead.imported',
  LEAD_NOTE_ADDED: 'lead.note_added',
  LEAD_WEBHOOK_RECEIVED: 'lead.webhook_received',

  // Marketing module — SPEC.md §7
  CAMPAIGN_CREATED: 'campaign.created',
  CAMPAIGN_UPDATED: 'campaign.updated',
  CAMPAIGN_METRICS_UPDATED: 'campaign.metrics_updated',
  CAMPAIGN_SPENT_UPDATED: 'campaign.spent_updated',
  CAMPAIGN_DELETED: 'campaign.deleted',

  // Social module — SPEC.md §8
  SOCIALPOST_CREATED: 'socialpost.created',
  SOCIALPOST_UPDATED: 'socialpost.updated',
  SOCIALPOST_PUBLISHED: 'socialpost.published',
  SOCIALPOST_WINNER_MARKED: 'socialpost.winner_marked',
  SOCIALPOST_DELETED: 'socialpost.deleted',

  // Dev tracking module — SPEC.md §9
  DEVTASK_CREATED: 'devtask.created',
  DEVTASK_MOVED: 'devtask.moved',
  DEVTASK_COMPLETED: 'devtask.completed',
  DEVTASK_DELETED: 'devtask.deleted',

  // AI Analysis module — SPEC.md §10
  AI_INSIGHT_GENERATED: 'ai.insight_generated',
  AI_INSIGHT_ACTIONED: 'ai.insight_actioned',
  // AI Actions module (v0.1.3 Theme 5) — prioritized to-do list backed
  // by the AIAction table. Generated/resolved/dismissed through
  // `/api/ai/actions` and `/api/ai/actions/[id]`.
  AI_ACTIONS_GENERATED: 'ai.actions_generated',
  AI_ACTION_RESOLVED: 'ai.action_resolved',
  AI_ACTION_DISMISSED: 'ai.action_dismissed',

  // Settings module — SPEC.md §12
  SETTING_UPDATED: 'setting.updated',
  /**
   * Emitted when an admin clicks "Send test email" in
   * Settings → Email (SMTP) (`POST /api/settings/test-smtp`). Metadata
   * carries `{ to, ok }` so the audit feed shows recipient + outcome.
   * Plaintext SMTP credentials are never logged (SPEC.md §12.2).
   */
  SETTINGS_SMTP_TEST_SENT: 'settings.smtp_test_sent',
  /**
   * Emitted when an admin clicks "Test connection" in
   * Settings → Meta Ads (`POST /api/settings/test-meta`). Metadata
   * carries `{ ok, error? }`. Meta access tokens never appear in the
   * log payload — only the ping outcome (SPEC.md §12.2 / v0.1.3).
   */
  SETTINGS_META_TEST: 'settings.meta_test',
  /**
   * Emitted when an admin clicks "Test connection" in
   * Settings → Google Ads (`POST /api/settings/test-google-ads`).
   * Metadata carries `{ ok, error? }`. The OAuth credentials never
   * appear in the log payload — only the ping outcome.
   */
  SETTINGS_GOOGLE_ADS_TEST: 'settings.google_ads_test',

  // Finance module (v0.1.5) — income / expense ledger, parties, accounts.
  // Transaction metadata carries `{ direction, amount, categoryLabel,
  // partyName? }` so the feed can say "recorded expense ₹6,000 (Ads) to
  // Facebook" without a lookup.
  FINANCE_TRANSACTION_CREATED: 'finance.transaction_created',
  FINANCE_TRANSACTION_UPDATED: 'finance.transaction_updated',
  FINANCE_TRANSACTION_DELETED: 'finance.transaction_deleted',
  FINANCE_PARTY_CREATED: 'finance.party_created',
  FINANCE_PARTY_UPDATED: 'finance.party_updated',
  FINANCE_PARTY_DELETED: 'finance.party_deleted',
  FINANCE_ACCOUNT_CREATED: 'finance.account_created',
  FINANCE_ACCOUNT_UPDATED: 'finance.account_updated',
  FINANCE_ACCOUNT_DELETED: 'finance.account_deleted',
} as const;

/** Every dotted action string the app emits. Derived from the values of
 *  {@link ACTIVITY_ACTIONS} so the two never drift. */
export type ActivityAction =
  (typeof ACTIVITY_ACTIONS)[keyof typeof ACTIVITY_ACTIONS];

// ---------------------------------------------------------------------------
// Per-action metadata: discriminated union
// ---------------------------------------------------------------------------

/**
 * Display-helper fields the format function will read off any metadata
 * variant when present. Mixing these into specific variants keeps the
 * formatter pure — it never needs to look up users/leads from the DB.
 *
 *   `userName`   — the name of the user who performed the action.
 *   `entityName` — a human label for the affected entity (lead name,
 *                  campaign name, post platform, task title, etc.).
 *
 * They're optional everywhere; {@link formatActivity} falls back to
 * "User {userId}" / "{entityType} {entityId}" when missing.
 */
interface ActivityDisplayHints {
  userName?: string;
  entityName?: string;
}

/**
 * Metadata for {@link ACTIVITY_ACTIONS.LEAD_STATUS_CHANGED}.
 *
 * The `from`/`to` pair is required because lead pipeline transitions are
 * the prime audit signal in SPEC.md §6.5 ("Drag lead from NEW → INTERESTED
 * in Kanban → ActivityLog entry created").
 */
export interface LeadStatusChangedMeta extends ActivityDisplayHints {
  from: string;
  to: string;
}

/** Metadata for {@link ACTIVITY_ACTIONS.LEAD_ASSIGNED}. */
export interface LeadAssignedMeta extends ActivityDisplayHints {
  fromOwnerId?: string | null;
  toOwnerId: string;
  toOwnerName?: string;
}

/** Metadata for {@link ACTIVITY_ACTIONS.LEAD_IMPORTED} (CSV upload). */
export interface LeadImportedMeta extends ActivityDisplayHints {
  rowsTotal: number;
  rowsImported: number;
  rowsSkipped: number;
}

/** Metadata for {@link ACTIVITY_ACTIONS.LEAD_NOTE_ADDED}. */
export interface LeadNoteAddedMeta extends ActivityDisplayHints {
  noteId: string;
}

/**
 * Metadata for {@link ACTIVITY_ACTIONS.CAMPAIGN_SPENT_UPDATED}.
 *
 * `delta` is the amount of *change* in INR (positive = increase). The
 * formatter renders e.g. "Jane updated campaign spend by ₹5000".
 */
export interface CampaignSpentUpdatedMeta extends ActivityDisplayHints {
  delta: number;
  newSpent?: number;
}

/**
 * Metadata for {@link ACTIVITY_ACTIONS.CAMPAIGN_METRICS_UPDATED}.
 *
 * Carries the keys whose value changed; used for the campaign detail
 * timeline (SPEC.md §7.2.2).
 */
export interface CampaignMetricsUpdatedMeta extends ActivityDisplayHints {
  fields: string[];
}

/** Metadata for {@link ACTIVITY_ACTIONS.SOCIALPOST_PUBLISHED}. */
export interface SocialPostPublishedMeta extends ActivityDisplayHints {
  platform: string;
  externalUrl?: string;
}

/** Metadata for {@link ACTIVITY_ACTIONS.SOCIALPOST_WINNER_MARKED}. */
export interface SocialPostWinnerMarkedMeta extends ActivityDisplayHints {
  isWinner: boolean;
}

/** Metadata for {@link ACTIVITY_ACTIONS.DEVTASK_MOVED}. */
export interface DevTaskMovedMeta extends ActivityDisplayHints {
  from: string;
  to: string;
}

/** Metadata for {@link ACTIVITY_ACTIONS.DEVTASK_COMPLETED}. */
export interface DevTaskCompletedMeta extends ActivityDisplayHints {
  taskType?: string;
}

/** Metadata for {@link ACTIVITY_ACTIONS.AI_INSIGHT_GENERATED}. */
export interface AIInsightGeneratedMeta extends ActivityDisplayHints {
  scope: string;
  trend: string;
  trendPct?: number | null;
}

/** Metadata for {@link ACTIVITY_ACTIONS.AI_INSIGHT_ACTIONED}. */
export interface AIInsightActionedMeta extends ActivityDisplayHints {
  scope?: string;
}

/** Metadata for {@link ACTIVITY_ACTIONS.ATTENDANCE_MARKED}. */
export interface AttendanceMarkedMeta extends ActivityDisplayHints {
  date: string;
  status: string;
}

/**
 * Metadata for {@link ACTIVITY_ACTIONS.USER_MODULE_ACCESS_CHANGED}.
 *
 * `from` and `to` are the previous and new `User.moduleAccess` arrays
 * (sorted-on-write is the caller's responsibility — both forms are
 * compared as multisets when rendered). Each entry is one of the IDs
 * in `ALL_EMPLOYEE_MODULES` from `@/lib/permissions`.
 */
export interface UserModuleAccessChangedMeta extends ActivityDisplayHints {
  from: string[];
  to: string[];
}

/**
 * Metadata for {@link ACTIVITY_ACTIONS.SETTING_UPDATED}.
 *
 * `key` is the `Setting.key` that was written. The plaintext value is
 * deliberately omitted — sensitive credentials must never appear in
 * activity log rows (SPEC.md §11.4 / §12.2).
 */
export interface SettingUpdatedMeta extends ActivityDisplayHints {
  key: string;
}

/**
 * Discriminated union of all activity events. The discriminant is
 * `action`; the variant determines the shape of `metadata`.
 *
 * Variants without a structured metadata field fall through to the
 * generic catch-all (`metadata?: Record<string, unknown> & ActivityDisplayHints`)
 * — i.e. "I have no required fields, but I might still carry display
 * hints or arbitrary context."
 */
export type ActivityEvent =
  | { action: typeof ACTIVITY_ACTIONS.LEAD_STATUS_CHANGED; metadata: LeadStatusChangedMeta }
  | { action: typeof ACTIVITY_ACTIONS.LEAD_ASSIGNED; metadata: LeadAssignedMeta }
  | { action: typeof ACTIVITY_ACTIONS.LEAD_IMPORTED; metadata: LeadImportedMeta }
  | { action: typeof ACTIVITY_ACTIONS.LEAD_NOTE_ADDED; metadata: LeadNoteAddedMeta }
  | { action: typeof ACTIVITY_ACTIONS.CAMPAIGN_SPENT_UPDATED; metadata: CampaignSpentUpdatedMeta }
  | { action: typeof ACTIVITY_ACTIONS.CAMPAIGN_METRICS_UPDATED; metadata: CampaignMetricsUpdatedMeta }
  | { action: typeof ACTIVITY_ACTIONS.SOCIALPOST_PUBLISHED; metadata: SocialPostPublishedMeta }
  | { action: typeof ACTIVITY_ACTIONS.SOCIALPOST_WINNER_MARKED; metadata: SocialPostWinnerMarkedMeta }
  | { action: typeof ACTIVITY_ACTIONS.DEVTASK_MOVED; metadata: DevTaskMovedMeta }
  | { action: typeof ACTIVITY_ACTIONS.DEVTASK_COMPLETED; metadata?: DevTaskCompletedMeta }
  | { action: typeof ACTIVITY_ACTIONS.AI_INSIGHT_GENERATED; metadata: AIInsightGeneratedMeta }
  | { action: typeof ACTIVITY_ACTIONS.AI_INSIGHT_ACTIONED; metadata?: AIInsightActionedMeta }
  | { action: typeof ACTIVITY_ACTIONS.ATTENDANCE_MARKED; metadata: AttendanceMarkedMeta }
  | { action: typeof ACTIVITY_ACTIONS.SETTING_UPDATED; metadata: SettingUpdatedMeta }
  | {
      action: typeof ACTIVITY_ACTIONS.USER_MODULE_ACCESS_CHANGED;
      metadata: UserModuleAccessChangedMeta;
    }
  | {
      // Fallback for actions without bespoke metadata schemas (created /
      // updated / deleted variants, login, etc.).
      action: Exclude<
        ActivityAction,
        | typeof ACTIVITY_ACTIONS.LEAD_STATUS_CHANGED
        | typeof ACTIVITY_ACTIONS.LEAD_ASSIGNED
        | typeof ACTIVITY_ACTIONS.LEAD_IMPORTED
        | typeof ACTIVITY_ACTIONS.LEAD_NOTE_ADDED
        | typeof ACTIVITY_ACTIONS.CAMPAIGN_SPENT_UPDATED
        | typeof ACTIVITY_ACTIONS.CAMPAIGN_METRICS_UPDATED
        | typeof ACTIVITY_ACTIONS.SOCIALPOST_PUBLISHED
        | typeof ACTIVITY_ACTIONS.SOCIALPOST_WINNER_MARKED
        | typeof ACTIVITY_ACTIONS.DEVTASK_MOVED
        | typeof ACTIVITY_ACTIONS.DEVTASK_COMPLETED
        | typeof ACTIVITY_ACTIONS.AI_INSIGHT_GENERATED
        | typeof ACTIVITY_ACTIONS.AI_INSIGHT_ACTIONED
        | typeof ACTIVITY_ACTIONS.ATTENDANCE_MARKED
        | typeof ACTIVITY_ACTIONS.SETTING_UPDATED
        | typeof ACTIVITY_ACTIONS.USER_MODULE_ACCESS_CHANGED
      >;
      metadata?: ActivityDisplayHints & Record<string, unknown>;
    };

// ---------------------------------------------------------------------------
// Prisma DI
// ---------------------------------------------------------------------------

/**
 * Minimal structural shape that {@link logActivity} needs from a Prisma
 * client. `PrismaClient`, `Prisma.TransactionClient`, and lightweight test
 * doubles all satisfy this interface.
 *
 * Using a structural slice (rather than the full `PrismaClient`) keeps
 * test wiring trivial: a test can pass `{ activityLog: { create: vi.fn() } }`
 * without constructing a real client.
 */
export interface ActivityLogWriter {
  activityLog: {
    create(args: {
      data: Prisma.ActivityLogUncheckedCreateInput;
    }): Promise<ActivityLog>;
  };
}

// ---------------------------------------------------------------------------
// logActivity
// ---------------------------------------------------------------------------

/**
 * Common (action-agnostic) parameters for {@link logActivity}.
 */
interface LogActivityCommon {
  /** ID of the user who performed the action. */
  userId: string;
  /** Affected entity's logical type, e.g. `'lead' | 'campaign' | 'devtask'`. */
  entityType: string;
  /** Affected entity's primary key (cuid). */
  entityId: string;
  /** Optional foreign key into `Lead`. Set this for lead-related actions
   *  so the lead's activity timeline can use the relation index. */
  leadId?: string | null;
}

/**
 * Full parameter object for {@link logActivity}: common fields plus a
 * discriminated event body so `metadata` is type-checked against `action`.
 */
export type LogActivityParams = LogActivityCommon & ActivityEvent;

/**
 * Persist one row to `ActivityLog`. Side-effecting (writes to DB).
 *
 * Pass any object satisfying {@link ActivityLogWriter} as the first
 * argument — the production `prisma` singleton, a transactional `tx`
 * inside `prisma.$transaction(...)`, or a test double. This makes the
 * helper trivially testable without monkey-patching imports.
 *
 * Returns the freshly created `ActivityLog` row (with `id`, `createdAt`,
 * etc.) so callers can chain or echo it back to clients when useful.
 *
 * Errors propagate. Callers that want best-effort logging (e.g. inside
 * a write path that should not fail because the audit row failed) should
 * wrap with try/catch at the call site.
 *
 * @param prisma a Prisma client or compatible writer (DI).
 * @param params action + entity references + optional metadata.
 * @returns the created `ActivityLog` row.
 */
export function logActivity(
  prisma: ActivityLogWriter,
  params: LogActivityParams,
): Promise<ActivityLog> {
  const { userId, action, entityType, entityId, leadId, metadata } = params;

  return prisma.activityLog.create({
    data: {
      userId,
      action,
      entityType,
      entityId,
      // `leadId` is optional in the schema; pass `null` explicitly when
      // the caller passes `null` and omit when undefined to let Prisma
      // apply the default (NULL).
      ...(leadId !== undefined ? { leadId } : {}),
      // `metadata` is `Json?`; serialise object → JSON. `undefined` stays
      // out of the `data` object so Prisma doesn't try to write `null`
      // unless the caller explicitly asks for it.
      ...(metadata !== undefined
        ? { metadata: metadata as Prisma.InputJsonValue }
        : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// formatActivity (pure)
// ---------------------------------------------------------------------------

/**
 * Subset of an `ActivityLog` row that {@link formatActivity} reads.
 *
 * Accepting a structural type (not the Prisma model directly) keeps the
 * formatter trivial to call from unit tests without instantiating a full
 * row.
 */
export interface FormattableActivity {
  userId: string;
  action: string;
  entityType: string;
  entityId: string;
  leadId?: string | null;
  metadata?: unknown;
}

/**
 * Convert one stored activity row into a one-line human-readable string
 * for activity feeds and the employee profile timeline (SPEC.md §5.2 #5).
 *
 * **Pure.** Reads only fields off the supplied row; performs no DB
 * lookups. Display strings (`userName`, `entityName`, etc.) come from
 * `metadata`; when absent, the formatter falls back to "User {userId}"
 * and "{entityType} {entityId}" so the line is always informative.
 *
 * Examples (with rich metadata):
 *
 *   "John Doe converted lead Acme Corp"
 *   "Jane updated campaign spend by ₹5000 on Meta Reels July"
 *   "Priya moved task UI polish from TODO to DOING"
 *   "Rahul published Instagram post"
 *
 * For unknown action strings, returns "{user} performed {action} on
 * {entity}" — useful when a new action ships before the formatter has
 * a bespoke template.
 */
export function formatActivity(activity: FormattableActivity): string {
  const meta = isPlainObject(activity.metadata) ? activity.metadata : {};
  const userName = readString(meta, 'userName') ?? `User ${activity.userId}`;
  const entityName =
    readString(meta, 'entityName') ?? `${activity.entityType} ${activity.entityId}`;

  switch (activity.action) {
    // -- Users / auth -------------------------------------------------------
    case ACTIVITY_ACTIONS.USER_CREATED:
      return `${userName} created user ${entityName}`;
    case ACTIVITY_ACTIONS.USER_UPDATED:
      return `${userName} updated user ${entityName}`;
    case ACTIVITY_ACTIONS.USER_DEACTIVATED:
      return `${userName} deactivated user ${entityName}`;
    case ACTIVITY_ACTIONS.USER_LOGIN:
      return `${userName} logged in`;
    case ACTIVITY_ACTIONS.ATTENDANCE_MARKED: {
      const status = readString(meta, 'status');
      const date = readString(meta, 'date');
      const suffix =
        status && date
          ? ` as ${status} on ${date}`
          : status
            ? ` as ${status}`
            : '';
      return `${userName} marked attendance${suffix}`;
    }
    case ACTIVITY_ACTIONS.USER_MODULE_ACCESS_CHANGED: {
      const to = readStringArray(meta, 'to') ?? [];
      // Empty `to` means "all modules" (legacy/back-compat) — see the
      // JSDoc on `User.moduleAccess`. Non-empty means an explicit
      // whitelist; we list the modules verbatim.
      const summary = to.length === 0 ? 'all modules' : to.join(', ');
      return `${userName} updated module access for ${entityName} to ${summary}`;
    }

    // -- Leads --------------------------------------------------------------
    case ACTIVITY_ACTIONS.LEAD_CREATED:
      return `${userName} created lead ${entityName}`;
    case ACTIVITY_ACTIONS.LEAD_UPDATED:
      return `${userName} updated lead ${entityName}`;
    case ACTIVITY_ACTIONS.LEAD_STATUS_CHANGED: {
      const from = readString(meta, 'from');
      const to = readString(meta, 'to');
      if (from && to) {
        return `${userName} moved lead ${entityName} from ${from} to ${to}`;
      }
      return `${userName} changed status of lead ${entityName}`;
    }
    case ACTIVITY_ACTIONS.LEAD_ASSIGNED: {
      const toOwnerName =
        readString(meta, 'toOwnerName') ?? readString(meta, 'toOwnerId');
      return toOwnerName
        ? `${userName} assigned lead ${entityName} to ${toOwnerName}`
        : `${userName} reassigned lead ${entityName}`;
    }
    case ACTIVITY_ACTIONS.LEAD_CONVERTED:
      return `${userName} converted lead ${entityName}`;
    case ACTIVITY_ACTIONS.LEAD_DELETED:
      return `${userName} deleted lead ${entityName}`;
    case ACTIVITY_ACTIONS.LEAD_IMPORTED: {
      const imported = readNumber(meta, 'rowsImported');
      const skipped = readNumber(meta, 'rowsSkipped');
      if (imported != null && skipped != null) {
        return `${userName} imported ${imported} leads (${skipped} skipped)`;
      }
      if (imported != null) {
        return `${userName} imported ${imported} leads`;
      }
      return `${userName} imported leads from CSV`;
    }
    case ACTIVITY_ACTIONS.LEAD_NOTE_ADDED:
      return `${userName} added a note to lead ${entityName}`;
    case ACTIVITY_ACTIONS.LEAD_WEBHOOK_RECEIVED:
      return `Lead ${entityName} received via webhook`;

    // -- Marketing ----------------------------------------------------------
    case ACTIVITY_ACTIONS.CAMPAIGN_CREATED:
      return `${userName} created campaign ${entityName}`;
    case ACTIVITY_ACTIONS.CAMPAIGN_UPDATED:
      return `${userName} updated campaign ${entityName}`;
    case ACTIVITY_ACTIONS.CAMPAIGN_METRICS_UPDATED: {
      const fields = readStringArray(meta, 'fields');
      if (fields && fields.length > 0) {
        return `${userName} updated ${fields.join(', ')} on campaign ${entityName}`;
      }
      return `${userName} updated metrics on campaign ${entityName}`;
    }
    case ACTIVITY_ACTIONS.CAMPAIGN_SPENT_UPDATED: {
      const delta = readNumber(meta, 'delta');
      if (delta == null) {
        return `${userName} updated campaign spend on ${entityName}`;
      }
      const verb = delta < 0 ? 'decreased' : 'increased';
      const amount = formatInr(Math.abs(delta));
      return `${userName} ${verb} campaign spend by ${amount} on ${entityName}`;
    }
    case ACTIVITY_ACTIONS.CAMPAIGN_DELETED:
      return `${userName} deleted campaign ${entityName}`;

    // -- Social -------------------------------------------------------------
    case ACTIVITY_ACTIONS.SOCIALPOST_CREATED:
      return `${userName} drafted a social post`;
    case ACTIVITY_ACTIONS.SOCIALPOST_UPDATED:
      return `${userName} updated social post ${entityName}`;
    case ACTIVITY_ACTIONS.SOCIALPOST_PUBLISHED: {
      const platform = readString(meta, 'platform');
      return platform
        ? `${userName} published ${formatPlatform(platform)} post`
        : `${userName} published social post ${entityName}`;
    }
    case ACTIVITY_ACTIONS.SOCIALPOST_WINNER_MARKED: {
      const isWinner = readBoolean(meta, 'isWinner');
      if (isWinner === false) {
        return `${userName} unmarked social post ${entityName} as winner`;
      }
      return `${userName} marked social post ${entityName} as winner`;
    }
    case ACTIVITY_ACTIONS.SOCIALPOST_DELETED:
      return `${userName} deleted social post ${entityName}`;

    // -- Dev ----------------------------------------------------------------
    case ACTIVITY_ACTIONS.DEVTASK_CREATED:
      return `${userName} created task ${entityName}`;
    case ACTIVITY_ACTIONS.DEVTASK_MOVED: {
      const from = readString(meta, 'from');
      const to = readString(meta, 'to');
      if (from && to) {
        return `${userName} moved task ${entityName} from ${from} to ${to}`;
      }
      return `${userName} moved task ${entityName}`;
    }
    case ACTIVITY_ACTIONS.DEVTASK_COMPLETED:
      return `${userName} completed task ${entityName}`;
    case ACTIVITY_ACTIONS.DEVTASK_DELETED:
      return `${userName} deleted task ${entityName}`;

    // -- AI -----------------------------------------------------------------
    case ACTIVITY_ACTIONS.AI_INSIGHT_GENERATED: {
      const scope = readString(meta, 'scope');
      return scope
        ? `${userName} generated ${scope} insight`
        : `${userName} generated AI insight`;
    }
    case ACTIVITY_ACTIONS.AI_INSIGHT_ACTIONED: {
      const scope = readString(meta, 'scope');
      return scope
        ? `${userName} actioned ${scope} insight`
        : `${userName} actioned AI insight`;
    }

    // -- Settings ----------------------------------------------------------
    case ACTIVITY_ACTIONS.SETTING_UPDATED: {
      const key = readString(meta, 'key');
      return key
        ? `${userName} updated setting ${key}`
        : `${userName} updated a setting`;
    }

    // -- Finance ------------------------------------------------------------
    case ACTIVITY_ACTIONS.FINANCE_TRANSACTION_CREATED:
    case ACTIVITY_ACTIONS.FINANCE_TRANSACTION_UPDATED:
    case ACTIVITY_ACTIONS.FINANCE_TRANSACTION_DELETED: {
      const verb =
        activity.action === ACTIVITY_ACTIONS.FINANCE_TRANSACTION_CREATED
          ? 'recorded'
          : activity.action === ACTIVITY_ACTIONS.FINANCE_TRANSACTION_UPDATED
            ? 'updated'
            : 'deleted';
      const direction = readString(meta, 'direction');
      const noun =
        direction === 'IN'
          ? 'income'
          : direction === 'OUT'
            ? 'expense'
            : 'transaction';
      const amount = readNumber(meta, 'amount');
      const categoryLabel = readString(meta, 'categoryLabel');
      const partyName = readString(meta, 'partyName');
      const parts = [`${userName} ${verb} ${noun}`];
      if (amount != null) parts.push(formatInr(amount));
      if (categoryLabel) parts.push(`(${categoryLabel})`);
      if (partyName) parts.push(`${direction === 'IN' ? 'from' : 'to'} ${partyName}`);
      return parts.join(' ');
    }
    case ACTIVITY_ACTIONS.FINANCE_PARTY_CREATED:
      return `${userName} added finance party ${entityName}`;
    case ACTIVITY_ACTIONS.FINANCE_PARTY_UPDATED:
      return `${userName} updated finance party ${entityName}`;
    case ACTIVITY_ACTIONS.FINANCE_PARTY_DELETED:
      return `${userName} deleted finance party ${entityName}`;
    case ACTIVITY_ACTIONS.FINANCE_ACCOUNT_CREATED:
      return `${userName} added finance account ${entityName}`;
    case ACTIVITY_ACTIONS.FINANCE_ACCOUNT_UPDATED:
      return `${userName} updated finance account ${entityName}`;
    case ACTIVITY_ACTIONS.FINANCE_ACCOUNT_DELETED:
      return `${userName} deleted finance account ${entityName}`;

    default:
      return `${userName} performed ${activity.action} on ${entityName}`;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (pure, no exports)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readString(
  meta: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = meta[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function readNumber(
  meta: Record<string, unknown>,
  key: string,
): number | undefined {
  const raw = meta[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function readBoolean(
  meta: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const raw = meta[key];
  return typeof raw === 'boolean' ? raw : undefined;
}

function readStringArray(
  meta: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const raw = meta[key];
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Format a non-negative INR amount with a thousands separator using the
 * Indian numbering convention (₹5,000 / ₹1,00,000). Trims trailing zeros
 * and decimal points: `formatInr(5000)` → `'₹5,000'`,
 * `formatInr(1234.5)` → `'₹1,234.5'`.
 *
 * Pure: deterministic for finite numeric inputs; ignores locale.
 */
function formatInr(amount: number): string {
  if (!Number.isFinite(amount)) return '₹0';
  // Use the canonical Indian grouping pattern (1,23,45,678) via
  // Intl with `en-IN`. Strip trailing `.00`.
  const formatted = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
  return `₹${formatted}`;
}

/**
 * Title-case a `SocialPlatform` enum-style value for display:
 * `'INSTAGRAM'` → `'Instagram'`, `'youtube'` → `'Youtube'`.
 */
function formatPlatform(platform: string): string {
  if (platform.length === 0) return platform;
  return platform[0]!.toUpperCase() + platform.slice(1).toLowerCase();
}
