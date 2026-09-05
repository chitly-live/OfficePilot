'use client';

/**
 * SettingsForm — tabbed client form backing `/settings` (SPEC §12.1).
 *
 * Owns the in-memory form state for every {@link KNOWN_KEYS} entry
 * and, on submit, bulk-PATCHes the lot through `/api/settings`. State
 * shape is `Record<KnownKey, string>` (the same shape the API returns
 * from GET) so initial values, controlled inputs, and the PATCH body
 * stay trivially mappable.
 *
 * Tabs (shadcn Tabs):
 *
 *   1. **AI** — `claude_model`, `daily_digest_hour` (0–23),
 *      `followup_reminder_hour` (0–23).
 *   2. **Secrets** — `anthropic_api_key`, `webhook_hmac_secret`. Both
 *      rendered as `type="password"`. When the server returned the
 *      placeholder `'***'` (a value is stored but not exposed), we
 *      keep that placeholder in state and show it as the input value
 *      so the user can see "a secret is set" without us ever seeing
 *      the plaintext. The PATCH handler treats `'***'` as "no
 *      change" (SPEC §12.2), so leaving the field untouched and
 *      saving is a true no-op for that key.
 *   3. **App** — `currency` (3-letter code).
 *   4. **Hashtag library** — `hashtag_sets` as a raw JSON textarea.
 *      The library is conceptually `[{ name, hashtags[] }, …]`; for
 *      v1 we expose the underlying JSON to keep this page small and
 *      let the social composer surface a friendlier picker (task 83).
 *   5. **Email (SMTP)** — `smtp_host`, `smtp_port`, `smtp_user`,
 *      `smtp_pass`, `smtp_from`. `smtp_pass` is sensitive (encrypted
 *      at rest, masked as `'***'` on read) and follows the same
 *      placeholder semantics as the Secrets tab. A "Send test email"
 *      button posts to `POST /api/settings/test-smtp` so the admin
 *      can verify the credentials without leaving the page.
 *   6. **Meta Ads (Facebook + Instagram)** — `meta_access_token`
 *      (sensitive), `meta_ad_account_id`, `meta_business_id`
 *      (optional). A "Test connection" button posts to
 *      `POST /api/settings/test-meta`, which pings Meta's `/me`
 *      endpoint and reports the principal's display name back on
 *      success. v0.1.3: credentials only — the actual /insights
 *      sync lands in v0.1.4.
 *   7. **Google Ads** — `google_ads_developer_token` (sensitive),
 *      `google_ads_customer_id`, `google_ads_client_id`,
 *      `google_ads_client_secret` (sensitive),
 *      `google_ads_refresh_token` (sensitive),
 *      `google_ads_login_customer_id` (optional MCC ID). A
 *      "Test connection" button posts to
 *      `POST /api/settings/test-google-ads`, which exchanges the
 *      refresh token for an access token at Google's OAuth endpoint
 *      to confirm the credential triple is mutually consistent.
 *   8. **Users** — single link to `/settings/users` (task 82). The
 *      list itself lives there, not here, to avoid duplicating the
 *      pagination/filter machinery.
 *
 * Submission:
 *
 *   • One "Save changes" button at the bottom — bulk PATCH. The
 *     server accepts `{ settings: Record<string, string> }` and
 *     returns `{ ok, updated[], errors[] }` where `errors[]` is a
 *     per-key array. We surface the count in a toast and, when
 *     present, the first per-key message.
 *   • Sensitive placeholders (`'***'`) are sent unchanged — the API
 *     skips writes for those.
 *   • The button is disabled while in flight to prevent double-submits.
 *
 * State management is plain `useState` — the form is small and the
 * fields are heterogeneous enough that `react-hook-form`'s zod
 * resolver wouldn't add much. Lightweight per-field validation runs
 * inline (e.g. clamping the hour input to 0–23) so the user gets
 * feedback before the round-trip.
 *
 * Implements task 81 of `.kiro/specs/officepilot/tasks.md`. See SPEC
 * §12.1 (sections), §12.2 (encryption / placeholder), §15 (admin-only
 * access).
 */

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import {
  SENSITIVE_PLACEHOLDER,
  type KnownKey,
  type SettingsRecord,
} from '@/lib/schemas/settings';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-key error returned by `PATCH /api/settings`. */
interface SettingPatchError {
  key: string;
  message: string;
}

/** Response body shape of `PATCH /api/settings` on a parseable request. */
interface SettingsPatchResponse {
  ok?: boolean;
  updated?: KnownKey[];
  errors?: SettingPatchError[];
  error?: string;
}

export interface SettingsFormProps {
  /**
   * Settings snapshot from the server — every {@link KNOWN_KEYS} entry
   * is present. Sensitive keys with a stored value arrive as
   * {@link SENSITIVE_PLACEHOLDER} (`'***'`); empty / unset keys arrive
   * as `''`.
   */
  initialSettings: SettingsRecord;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SettingsForm({ initialSettings }: SettingsFormProps) {
  const router = useRouter();

  // The form state mirrors `SettingsRecord` exactly so each input can
  // bind to `state[key]` without an intermediate mapping layer.
  const [values, setValues] =
    React.useState<SettingsRecord>(initialSettings);
  const [submitting, setSubmitting] = React.useState(false);
  // Track whether the "Send test email" request is in flight so we can
  // disable the button + show a spinner. Independent of `submitting`
  // because the two buttons hit different endpoints.
  const [sendingTest, setSendingTest] = React.useState(false);
  // Same idea for the ad-platform "Test connection" buttons. Separate
  // booleans so a slow Meta probe doesn't disable the Google Ads
  // button (or vice versa).
  const [testingMeta, setTestingMeta] = React.useState(false);
  const [testingGoogleAds, setTestingGoogleAds] = React.useState(false);

  /**
   * Generic setter — patches a single key in `values`. Stable
   * reference so children memoise cleanly.
   */
  const setValue = React.useCallback(
    (key: KnownKey, next: string) => {
      setValues((prev) => ({ ...prev, [key]: next }));
    },
    [],
  );

  /**
   * Fire `POST /api/settings/test-smtp` with no body — the route falls
   * back to the current admin's email when `to` is omitted. Surfaces
   * the outcome as a toast; the button is disabled while in flight.
   *
   * IMPORTANT: this uses the SAVED config on the server, not whatever
   * is in `values`. If the admin just typed a new host/port/etc. and
   * hasn't clicked "Save changes" yet, the test will run against the
   * previously-saved values. The toast copy makes this explicit.
   */
  async function handleSendTestEmail() {
    if (sendingTest) return;
    setSendingTest(true);
    try {
      const response = await fetch('/api/settings/test-smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      interface TestSmtpResponse {
        ok?: boolean;
        sentTo?: string;
        error?: string;
        message?: string;
      }
      let body: TestSmtpResponse | null = null;
      try {
        body = (await response.json()) as TestSmtpResponse;
      } catch {
        body = null;
      }

      if (response.ok && body?.ok) {
        toast.success(
          body.sentTo
            ? `Test email sent to ${body.sentTo}.`
            : 'Test email sent.',
        );
        return;
      }

      // Friendly mapping of the documented error codes.
      const errorCode = body?.error ?? `http_${response.status}`;
      if (errorCode === 'smtp_not_configured') {
        toast.error(
          'SMTP is not configured. Fill in the fields above and save before testing.',
        );
        return;
      }
      if (errorCode === 'invalid_recipient') {
        toast.error('Your account has no email on file. Set one in Users.');
        return;
      }
      if (errorCode === 'smtp_send_failed') {
        toast.error('SMTP server rejected the message.', {
          description: body?.message ?? undefined,
        });
        return;
      }
      toast.error(`Couldn’t send test email (${errorCode}).`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[settings] test-smtp failed', err);
      toast.error('Couldn’t send test email. Please try again.');
    } finally {
      setSendingTest(false);
    }
  }

  /**
   * Fire `POST /api/settings/test-meta` — the route reads the SAVED
   * Meta credentials from the DB, pings Meta's `/me` endpoint, and
   * returns `{ ok, meName }` on success or `{ ok: false, error }` on
   * a platform failure.
   *
   * As with the SMTP probe, this uses the SAVED config — not whatever
   * is currently in the form fields. The admin must click "Save
   * changes" first if they've just typed new credentials.
   */
  async function handleTestMeta() {
    if (testingMeta) return;
    setTestingMeta(true);
    try {
      const response = await fetch('/api/settings/test-meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      type MetaTestBody = {
        ok?: boolean;
        meName?: string;
        error?: string;
        message?: string;
      };
      let body: MetaTestBody | null = null;
      try {
        body = (await response.json()) as MetaTestBody;
      } catch {
        body = null;
      }

      if (response.ok && body?.ok) {
        toast.success(
          body.meName
            ? `Connected to Meta as ${body.meName}.`
            : 'Connected to Meta.',
        );
        return;
      }

      const errorCode = body?.error ?? `http_${response.status}`;
      if (errorCode === 'meta_not_configured') {
        toast.error(
          'Meta credentials are incomplete. Fill in the fields above and save before testing.',
        );
        return;
      }
      // 502 path — `error` carries Meta's verbatim diagnostic message.
      toast.error('Meta rejected the connection.', {
        description: body?.error ?? body?.message ?? undefined,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[settings] test-meta failed', err);
      toast.error('Couldn’t reach Meta. Please try again.');
    } finally {
      setTestingMeta(false);
    }
  }

  /**
   * Fire `POST /api/settings/test-google-ads` — the route exchanges
   * the stored refresh token for an access token at Google's OAuth
   * endpoint. A 200 confirms the OAuth credentials work; the gRPC
   * Ads API itself isn't called until v0.1.4.
   */
  async function handleTestGoogleAds() {
    if (testingGoogleAds) return;
    setTestingGoogleAds(true);
    try {
      const response = await fetch('/api/settings/test-google-ads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      type GoogleAdsTestBody = {
        ok?: boolean;
        error?: string;
        message?: string;
      };
      let body: GoogleAdsTestBody | null = null;
      try {
        body = (await response.json()) as GoogleAdsTestBody;
      } catch {
        body = null;
      }

      if (response.ok && body?.ok) {
        toast.success('Google Ads OAuth credentials are valid.');
        return;
      }

      const errorCode = body?.error ?? `http_${response.status}`;
      if (errorCode === 'google_ads_not_configured') {
        toast.error(
          'Google Ads credentials are incomplete. Fill in the fields above and save before testing.',
        );
        return;
      }
      toast.error('Google rejected the connection.', {
        description: body?.error ?? body?.message ?? undefined,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[settings] test-google-ads failed', err);
      toast.error('Couldn’t reach Google. Please try again.');
    } finally {
      setTestingGoogleAds(false);
    }
  }

  /**
   * Bulk PATCH — sends every known key, including sensitive
   * placeholders (the API treats `'***'` as "no change"). Per-key
   * errors are surfaced in the toast; on success we revalidate the
   * route so a fresh server snapshot replaces our local state on the
   * next render (covers e.g. trimmed / canonicalised values).
   */
  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);

    try {
      const response = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: values }),
      });

      // Try to read the JSON body either way — the API returns 200
      // with a per-key `errors[]` for partial failures, but 4xx/5xx
      // bodies still carry a useful message via the `errorResponse`
      // helper.
      let body: SettingsPatchResponse | null = null;
      try {
        body = (await response.json()) as SettingsPatchResponse;
      } catch {
        body = null;
      }

      if (!response.ok) {
        const message =
          body?.error ?? `Save failed (${response.status})`;
        toast.error(message);
        return;
      }

      const updatedCount = body?.updated?.length ?? 0;
      const errors = body?.errors ?? [];

      if (errors.length > 0) {
        // Partial success — name the first failing key so the admin
        // can find it. The toast description rolls up the rest.
        const first = errors[0];
        const remaining = errors.length - 1;
        const description =
          remaining > 0
            ? `${first.key}: ${first.message} (+${remaining} more)`
            : `${first.key}: ${first.message}`;
        toast.error(
          updatedCount > 0
            ? `Saved ${updatedCount} setting${updatedCount === 1 ? '' : 's'}, ${errors.length} failed`
            : 'No settings were saved',
          { description },
        );
        return;
      }

      toast.success(
        updatedCount === 0
          ? 'No changes to save.'
          : `Saved ${updatedCount} setting${updatedCount === 1 ? '' : 's'}.`,
      );

      // Pull a fresh server snapshot so canonicalised values (e.g.
      // currency upper-cased, hashtag_sets re-stringified) replace
      // whatever the user typed.
      router.refresh();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[settings] save failed', err);
      toast.error('Couldn\u2019t save settings. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Tabs defaultValue="ai" className="space-y-4">
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="ai">AI</TabsTrigger>
          <TabsTrigger value="secrets">Secrets</TabsTrigger>
          <TabsTrigger value="app">App</TabsTrigger>
          <TabsTrigger value="hashtags">Hashtag library</TabsTrigger>
          <TabsTrigger value="email">Email (SMTP)</TabsTrigger>
          <TabsTrigger value="meta">Meta Ads</TabsTrigger>
          <TabsTrigger value="google_ads">Google Ads</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
        </TabsList>

        {/* --------------------------------------------------------- */}
        {/* AI                                                         */}
        {/* --------------------------------------------------------- */}
        <TabsContent value="ai" className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="claude_model">Default Claude model</Label>
            <select
              id="claude_model"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              value={values.claude_model}
              onChange={(e) => setValue('claude_model', e.target.value)}
            >
              <option value="">(use default: claude-sonnet-4-6)</option>
              <option value="claude-opus-4-7">claude-opus-4-7 — premium reasoning ($15/$75 per 1M)</option>
              <option value="claude-sonnet-4-6">claude-sonnet-4-6 — balanced (recommended, $3/$15)</option>
              <option value="claude-haiku-4-5-20251001">claude-haiku-4-5 — cheap routine ($1/$5)</option>
            </select>
            <p className="text-xs text-muted-foreground">
              Fallback model used by every AI scope unless a per-scope
              override is set below. Anthropic API pricing per 1M tokens
              shown for reference.
            </p>
          </div>

          {/* ----------------------------------------------------- */}
          {/* Per-scope model overrides (v0.1.3 mixed-model strategy) */}
          {/* ----------------------------------------------------- */}
          <details className="rounded-md border bg-muted/20 px-4 py-3">
            <summary className="cursor-pointer select-none text-sm font-medium">
              Per-scope model overrides{' '}
              <span className="text-xs text-muted-foreground">
                (optional — use cheaper/expensive models per scope)
              </span>
            </summary>
            <div className="mt-4 space-y-3">
              <p className="text-xs text-muted-foreground">
                Recommended setup for small teams: default = Haiku
                (cheap), Predictions/Anomalies/Overall = Sonnet (smarter),
                Actions = Opus (best reasoning). Leave any row empty to
                inherit from the default model above.
              </p>
              {([
                ['claude_model_ads', 'Ads scope'],
                ['claude_model_social', 'Social scope'],
                ['claude_model_leads', 'Leads scope'],
                ['claude_model_overall', 'Overall scope'],
                ['claude_model_predictions', 'Predictions scope'],
                ['claude_model_anomalies', 'Anomalies scope'],
                ['claude_model_actions', 'Action List generator'],
              ] as const).map(([key, label]) => (
                <div
                  key={key}
                  className="grid grid-cols-1 gap-1 sm:grid-cols-[200px,1fr] sm:items-center"
                >
                  <Label htmlFor={key} className="text-sm">
                    {label}
                  </Label>
                  <select
                    id={key}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={values[key] ?? ''}
                    onChange={(e) => setValue(key, e.target.value)}
                  >
                    <option value="">(inherit default)</option>
                    <option value="claude-opus-4-7">claude-opus-4-7 — premium</option>
                    <option value="claude-sonnet-4-6">claude-sonnet-4-6 — balanced</option>
                    <option value="claude-haiku-4-5-20251001">claude-haiku-4-5 — cheap</option>
                  </select>
                </div>
              ))}
            </div>
          </details>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="daily_digest_hour">
                Daily digest hour (0–23)
              </Label>
              <Input
                id="daily_digest_hour"
                type="number"
                inputMode="numeric"
                min={0}
                max={23}
                step={1}
                placeholder="9"
                value={values.daily_digest_hour}
                onChange={(e) =>
                  setValue('daily_digest_hour', e.target.value)
                }
              />
              <p className="text-xs text-muted-foreground">
                Local hour at which the morning digest cron runs.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="followup_reminder_hour">
                Follow-up reminder hour (0–23)
              </Label>
              <Input
                id="followup_reminder_hour"
                type="number"
                inputMode="numeric"
                min={0}
                max={23}
                step={1}
                placeholder="9"
                value={values.followup_reminder_hour}
                onChange={(e) =>
                  setValue('followup_reminder_hour', e.target.value)
                }
              />
              <p className="text-xs text-muted-foreground">
                Local hour at which the daily follow-up reminders fire.
              </p>
            </div>
          </div>
        </TabsContent>

        {/* --------------------------------------------------------- */}
        {/* Secrets                                                    */}
        {/* --------------------------------------------------------- */}
        <TabsContent value="secrets" className="space-y-5">
          <div className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
            Stored encrypted at rest with AES-256-GCM (SPEC §12.2).
            Existing values are masked as
            <code className="mx-1 font-mono">{SENSITIVE_PLACEHOLDER}</code>;
            leave a field unchanged to keep the stored credential as
            is. Type a new value to replace it.
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="anthropic_api_key">Anthropic API key</Label>
            <Input
              id="anthropic_api_key"
              type="password"
              autoComplete="new-password"
              placeholder="sk-ant-…"
              value={values.anthropic_api_key}
              onChange={(e) =>
                setValue('anthropic_api_key', e.target.value)
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="webhook_hmac_secret">
              Webhook HMAC secret
            </Label>
            <Input
              id="webhook_hmac_secret"
              type="password"
              autoComplete="new-password"
              placeholder="32+ random bytes"
              value={values.webhook_hmac_secret}
              onChange={(e) =>
                setValue('webhook_hmac_secret', e.target.value)
              }
            />
            <p className="text-xs text-muted-foreground">
              Shared secret used to verify inbound lead webhooks.
            </p>
          </div>
        </TabsContent>

        {/* --------------------------------------------------------- */}
        {/* App                                                        */}
        {/* --------------------------------------------------------- */}
        <TabsContent value="app" className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="currency">Currency</Label>
            <Input
              id="currency"
              autoComplete="off"
              placeholder="INR"
              maxLength={3}
              value={values.currency}
              onChange={(e) =>
                setValue('currency', e.target.value.toUpperCase())
              }
              className="sm:w-32"
            />
            <p className="text-xs text-muted-foreground">
              ISO 4217 three-letter code used to format monetary
              values across the app (e.g. <code>INR</code>,
              <code className="ml-1">USD</code>).
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="company_name">Company name</Label>
            <Input
              id="company_name"
              autoComplete="organization"
              placeholder="Praxxel Technologies Private Limited"
              maxLength={200}
              value={values.company_name}
              onChange={(e) => setValue('company_name', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Printed in the header of Finance report exports (Excel / PDF)
              and used in their file names.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="company_address">Company address / GSTIN</Label>
            <Textarea
              id="company_address"
              rows={2}
              maxLength={500}
              placeholder="Registered address, GSTIN, CIN — whatever the accountant needs to see"
              value={values.company_address}
              onChange={(e) => setValue('company_address', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Optional second line under the company name on Finance reports.
            </p>
          </div>
        </TabsContent>

        {/* --------------------------------------------------------- */}
        {/* Hashtag library                                            */}
        {/* --------------------------------------------------------- */}
        <TabsContent value="hashtags" className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="hashtag_sets">Hashtag sets (JSON)</Label>
            <Textarea
              id="hashtag_sets"
              spellCheck={false}
              rows={10}
              placeholder='[{"name": "Brand", "hashtags": ["#chitly", "#fintech"]}]'
              value={values.hashtag_sets}
              onChange={(e) => setValue('hashtag_sets', e.target.value)}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              An array of named bundles, shape{' '}
              <code>{`[{ name, hashtags: string[] }]`}</code>. Used by
              the social composer to drop reusable hashtag groups
              into a post (SPEC §8.2.5).
            </p>
          </div>
        </TabsContent>

        {/* --------------------------------------------------------- */}
        {/* Email (SMTP)                                               */}
        {/* --------------------------------------------------------- */}
        <TabsContent value="email" className="space-y-5">
          <div className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
            Outbound transactional email (follow-up reminders, admin
            alerts). Falls back to the <code>SMTP_*</code> environment
            variables when these fields are empty. The password is
            stored AES-256-GCM encrypted; the existing value is masked
            as
            <code className="mx-1 font-mono">{SENSITIVE_PLACEHOLDER}</code>
            so leaving the field unchanged keeps the stored credential
            as is.
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="smtp_host">SMTP host</Label>
              <Input
                id="smtp_host"
                autoComplete="off"
                placeholder="smtp.gmail.com"
                value={values.smtp_host}
                onChange={(e) => setValue('smtp_host', e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="smtp_port">SMTP port</Label>
              <Input
                id="smtp_port"
                type="number"
                inputMode="numeric"
                min={1}
                max={65_535}
                step={1}
                placeholder="587"
                value={values.smtp_port}
                onChange={(e) => setValue('smtp_port', e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="smtp_user">SMTP user</Label>
            <Input
              id="smtp_user"
              autoComplete="off"
              placeholder="alerts@chitly.live"
              value={values.smtp_user}
              onChange={(e) => setValue('smtp_user', e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="smtp_pass">SMTP password</Label>
            <Input
              id="smtp_pass"
              type="password"
              autoComplete="new-password"
              placeholder="App password"
              value={values.smtp_pass}
              onChange={(e) => setValue('smtp_pass', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              For Gmail use an <strong>App Password</strong>, not your
              account password. Generate one at{' '}
              <code>myaccount.google.com</code> → Security → App
              passwords.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="smtp_from">SMTP from</Label>
            <Input
              id="smtp_from"
              autoComplete="off"
              placeholder="OfficePilot <alerts@chitly.live>"
              value={values.smtp_from}
              onChange={(e) => setValue('smtp_from', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Email address or <code>{`"Display Name <email@host>"`}</code>{' '}
              format used in the <code>From</code> header on every
              outbound message.
            </p>
          </div>

          <div className="rounded-md border bg-card p-3 text-xs text-muted-foreground">
            <strong>Gmail SMTP:</strong> <code>smtp.gmail.com</code>,
            port <code>587</code>, user is your Gmail address, password
            is an App Password (not your account password). Generate at{' '}
            <a
              href="https://myaccount.google.com/security"
              target="_blank"
              rel="noreferrer noopener"
              className="underline"
            >
              myaccount.google.com
            </a>{' '}
            → Security → App passwords.
          </div>
        </TabsContent>

        {/* --------------------------------------------------------- */}
        {/* Meta Ads (Facebook + Instagram)                            */}
        {/* --------------------------------------------------------- */}
        <TabsContent value="meta" className="space-y-5">
          <div className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
            <strong>Sync not yet wired</strong> — credentials only.
            Manual sync will arrive in v0.1.4. The access token is
            stored AES-256-GCM encrypted; the existing value is masked
            as
            <code className="mx-1 font-mono">{SENSITIVE_PLACEHOLDER}</code>
            so leaving the field unchanged keeps the stored credential
            as is.
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="meta_access_token">Meta access token</Label>
            <Input
              id="meta_access_token"
              type="password"
              autoComplete="new-password"
              placeholder="EAAB…"
              value={values.meta_access_token}
              onChange={(e) =>
                setValue('meta_access_token', e.target.value)
              }
            />
            <p className="text-xs text-muted-foreground">
              Long-lived (system user) token with the{' '}
              <code>ads_read</code> scope.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="meta_ad_account_id">Ad Account ID</Label>
              <Input
                id="meta_ad_account_id"
                autoComplete="off"
                placeholder="act_1234567890"
                value={values.meta_ad_account_id}
                onChange={(e) =>
                  setValue('meta_ad_account_id', e.target.value)
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="meta_business_id">
                Business ID <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="meta_business_id"
                autoComplete="off"
                placeholder="1234567890"
                value={values.meta_business_id}
                onChange={(e) =>
                  setValue('meta_business_id', e.target.value)
                }
              />
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="instagram_business_account_id">
                Instagram Business Account ID{' '}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="instagram_business_account_id"
                autoComplete="off"
                placeholder="17841401234567890"
                value={values.instagram_business_account_id}
                onChange={(e) =>
                  setValue('instagram_business_account_id', e.target.value)
                }
              />
              <p className="text-xs text-muted-foreground">
                Only needed for Instagram organic-content sync (reels reach,
                story views, post likes). Paid Instagram ads are covered by the
                Ad Account ID above. Find it via{' '}
                <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
                  GET /me/accounts?fields=instagram_business_account
                </code>{' '}
                in the Graph API Explorer.
              </p>
            </div>
          </div>

          <div className="rounded-md border bg-card p-3 text-xs text-muted-foreground">
            Get an access token at{' '}
            <a
              href="https://developers.facebook.com/tools/explorer/"
              target="_blank"
              rel="noreferrer noopener"
              className="underline"
            >
              developers.facebook.com/tools/explorer
            </a>{' '}
            (use a System User token for long-lived access). The token
            needs <code>ads_read</code> scope. Your Ad Account ID is
            visible at{' '}
            <a
              href="https://business.facebook.com/adsmanager"
              target="_blank"
              rel="noreferrer noopener"
              className="underline"
            >
              business.facebook.com/adsmanager
            </a>
            .
          </div>

          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleTestMeta}
              disabled={testingMeta}
            >
              {testingMeta ? (
                <>
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                  <span>Testing…</span>
                </>
              ) : (
                <span>Test connection</span>
              )}
            </Button>
          </div>
        </TabsContent>

        {/* --------------------------------------------------------- */}
        {/* Google Ads                                                 */}
        {/* --------------------------------------------------------- */}
        <TabsContent value="google_ads" className="space-y-5">
          <div className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
            <strong>Sync not yet wired</strong> — credentials only.
            Manual sync will arrive in v0.1.4. The developer token,
            client secret, and refresh token are stored AES-256-GCM
            encrypted; existing values are masked as
            <code className="mx-1 font-mono">{SENSITIVE_PLACEHOLDER}</code>
            so leaving a field unchanged keeps the stored credential
            as is.
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="google_ads_developer_token">
              Developer token
            </Label>
            <Input
              id="google_ads_developer_token"
              type="password"
              autoComplete="new-password"
              placeholder="22-character token from API Center"
              value={values.google_ads_developer_token}
              onChange={(e) =>
                setValue('google_ads_developer_token', e.target.value)
              }
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="google_ads_customer_id">
                Customer ID
              </Label>
              <Input
                id="google_ads_customer_id"
                autoComplete="off"
                placeholder="123-456-7890"
                value={values.google_ads_customer_id}
                onChange={(e) =>
                  setValue('google_ads_customer_id', e.target.value)
                }
              />
              <p className="text-xs text-muted-foreground">
                10 digits; hyphens optional and stripped on save.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="google_ads_login_customer_id">
                Login / Manager ID{' '}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="google_ads_login_customer_id"
                autoComplete="off"
                placeholder="123-456-7890"
                value={values.google_ads_login_customer_id}
                onChange={(e) =>
                  setValue(
                    'google_ads_login_customer_id',
                    e.target.value,
                  )
                }
              />
              <p className="text-xs text-muted-foreground">
                MCC account ID, only if you proxy calls through a
                manager account.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="google_ads_client_id">OAuth client ID</Label>
            <Input
              id="google_ads_client_id"
              autoComplete="off"
              placeholder="…apps.googleusercontent.com"
              value={values.google_ads_client_id}
              onChange={(e) =>
                setValue('google_ads_client_id', e.target.value)
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="google_ads_client_secret">
              OAuth client secret
            </Label>
            <Input
              id="google_ads_client_secret"
              type="password"
              autoComplete="new-password"
              placeholder="GOCSPX-…"
              value={values.google_ads_client_secret}
              onChange={(e) =>
                setValue('google_ads_client_secret', e.target.value)
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="google_ads_refresh_token">
              OAuth refresh token
            </Label>
            <Input
              id="google_ads_refresh_token"
              type="password"
              autoComplete="new-password"
              placeholder="1//0…"
              value={values.google_ads_refresh_token}
              onChange={(e) =>
                setValue('google_ads_refresh_token', e.target.value)
              }
            />
          </div>

          <div className="rounded-md border bg-card p-3 text-xs text-muted-foreground">
            Apply for a Google Ads developer token at{' '}
            <a
              href="https://ads.google.com/aw/apicenter"
              target="_blank"
              rel="noreferrer noopener"
              className="underline"
            >
              ads.google.com/aw/apicenter
            </a>
            . Generate OAuth credentials at{' '}
            <a
              href="https://console.cloud.google.com/apis/credentials"
              target="_blank"
              rel="noreferrer noopener"
              className="underline"
            >
              console.cloud.google.com/apis/credentials
            </a>
            . Refresh token: use{' '}
            <a
              href="https://developers.google.com/oauthplayground"
              target="_blank"
              rel="noreferrer noopener"
              className="underline"
            >
              OAuth2 Playground
            </a>{' '}
            with scope{' '}
            <code>https://www.googleapis.com/auth/adwords</code>.{' '}
            <strong>First-time setup takes ~30 min</strong> — see
            DEPLOY.md §22.
          </div>

          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleTestGoogleAds}
              disabled={testingGoogleAds}
            >
              {testingGoogleAds ? (
                <>
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                  <span>Testing…</span>
                </>
              ) : (
                <span>Test connection</span>
              )}
            </Button>
          </div>
        </TabsContent>

        {/* --------------------------------------------------------- */}
        {/* Users                                                      */}
        {/* --------------------------------------------------------- */}
        <TabsContent value="users" className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Manage system users — invite teammates, change roles,
            deactivate access — from the dedicated users page.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/users">
              <span>Manage users</span>
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        </TabsContent>
      </Tabs>

      {/* ----------------------------------------------------------- */}
      {/* Save + ancillary actions                                     */}
      {/* ----------------------------------------------------------- */}
      <div className="flex flex-col items-stretch gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-end">
        <Button type="submit" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span>Saving…</span>
            </>
          ) : (
            <span>Save changes</span>
          )}
        </Button>
        {/* Test-email is a side action — keeps `type="button"` so it
            never submits the form, and stays disabled while either
            request is in flight to prevent the two from racing. */}
        <Button
          type="button"
          variant="outline"
          onClick={handleSendTestEmail}
          disabled={sendingTest || submitting}
        >
          {sendingTest ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span>Sending test…</span>
            </>
          ) : (
            <span>Send test email</span>
          )}
        </Button>
      </div>
    </form>
  );
}
