'use client';

/**
 * UtmBuilderForm — pure client UTM URL generator (SPEC §7.2.5,
 * task 46).
 *
 * Inputs: base URL, utm_source, utm_medium, utm_campaign, optional
 * utm_content, utm_term. Real-time preview is built via
 * {@link buildUtmUrl} from `@/lib/utm`. The "Copy URL" button copies
 * the preview to the clipboard with a Sonner toast confirmation.
 *
 * Validation:
 *   • Required: base URL, source, medium, campaign.
 *   • Each UTM field is checked against {@link isValidUtmValue} —
 *     when a value would need percent-encoding we still produce a
 *     valid URL (URLSearchParams handles encoding) but we surface a
 *     warning chip so users can avoid fragile inputs to ad
 *     platforms.
 *   • The base URL is validated by attempting `new URL(...)`.
 *
 * "Generate slug from campaign name" helper:
 *   • A small input + button below the campaign field. Type the
 *     campaign's human name → click the wand → utm_campaign is
 *     filled with `slugifyCampaign(name)` (`"Meta Reels July"` →
 *     `"meta-reels-july"`).
 *
 * No API calls — this is a pure tool. URL state is held entirely in
 * React state.
 */

import * as React from 'react';
import { Check, Copy, Wand2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { buildUtmUrl, isValidUtmValue, slugifyCampaign } from '@/lib/utm';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default base URL — SPEC.md §7.4 example uses `chitly.live`. */
const DEFAULT_BASE_URL = 'https://chitly.live/';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try to parse `input` as an absolute HTTP/HTTPS URL. Returns the
 * URL when valid; otherwise `null`.
 */
function tryParseUrl(input: string): URL | null {
  try {
    const u = new URL(input);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function UtmBuilderForm() {
  // Form state — local, no persistence, no router.
  const [baseUrl, setBaseUrl] = React.useState(DEFAULT_BASE_URL);
  const [campaignName, setCampaignName] = React.useState('');
  const [source, setSource] = React.useState('');
  const [medium, setMedium] = React.useState('');
  const [campaign, setCampaign] = React.useState('');
  const [content, setContent] = React.useState('');
  const [term, setTerm] = React.useState('');
  // Briefly toggled true after a successful copy so the button shows
  // a checkmark; reset after 2 s.
  const [copied, setCopied] = React.useState(false);

  // ------------------------------------------------------------------
  // Derived state
  // ------------------------------------------------------------------
  const trimmedBaseUrl = baseUrl.trim();
  const parsedBase = trimmedBaseUrl === '' ? null : tryParseUrl(trimmedBaseUrl);
  const baseUrlInvalid = trimmedBaseUrl !== '' && parsedBase === null;

  const trimmedSource = source.trim();
  const trimmedMedium = medium.trim();
  const trimmedCampaign = campaign.trim();
  const trimmedContent = content.trim();
  const trimmedTerm = term.trim();

  // Per-field encoding warnings.
  const sourceWarning =
    trimmedSource !== '' && !isValidUtmValue(trimmedSource);
  const mediumWarning =
    trimmedMedium !== '' && !isValidUtmValue(trimmedMedium);
  const campaignWarning =
    trimmedCampaign !== '' && !isValidUtmValue(trimmedCampaign);
  const contentWarning =
    trimmedContent !== '' && !isValidUtmValue(trimmedContent);
  const termWarning =
    trimmedTerm !== '' && !isValidUtmValue(trimmedTerm);

  // Build the preview URL whenever any input changes. We guard on
  // `parsedBase` because `buildUtmUrl` throws TypeError on an
  // unparseable URL — we don't want that to bubble to the React
  // error boundary.
  const generatedUrl = React.useMemo(() => {
    if (!parsedBase) return '';
    if (
      trimmedSource === '' ||
      trimmedMedium === '' ||
      trimmedCampaign === ''
    ) {
      return '';
    }
    try {
      return buildUtmUrl({
        url: parsedBase.toString(),
        source: trimmedSource,
        medium: trimmedMedium,
        campaign: trimmedCampaign,
        ...(trimmedContent !== '' ? { content: trimmedContent } : {}),
        ...(trimmedTerm !== '' ? { term: trimmedTerm } : {}),
      });
    } catch {
      return '';
    }
  }, [
    parsedBase,
    trimmedSource,
    trimmedMedium,
    trimmedCampaign,
    trimmedContent,
    trimmedTerm,
  ]);

  const canCopy = generatedUrl !== '';

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  const generateSlug = () => {
    const slug = slugifyCampaign(campaignName);
    if (slug) {
      setCampaign(slug);
    } else {
      toast.error('Enter a campaign name to generate a slug.');
    }
  };

  const copyUrl = async () => {
    if (!canCopy) return;
    try {
      // Modern clipboard API — browsers without it (insecure
      // contexts, very old) get the toast.error fallback.
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(generatedUrl);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
        toast.success('URL copied to clipboard.');
        return;
      }
      throw new Error('clipboard unavailable');
    } catch {
      toast.error('Couldn\u2019t copy. Select the URL and copy manually.');
    }
  };

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Base URL */}
      <div className="space-y-1.5">
        <Label htmlFor="utm-base">Destination URL</Label>
        <Input
          id="utm-base"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://chitly.live/landing"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          aria-invalid={baseUrlInvalid || undefined}
          aria-describedby={baseUrlInvalid ? 'utm-base-error' : undefined}
        />
        {baseUrlInvalid ? (
          <p id="utm-base-error" className="text-xs text-status-red">
            Enter a valid http(s) URL.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            The page users will land on. Existing query parameters are
            preserved.
          </p>
        )}
      </div>

      {/* Required UTM fields */}
      <div className="grid gap-4 sm:grid-cols-3">
        <UtmField
          id="utm-source"
          label="utm_source"
          placeholder="meta"
          value={source}
          onChange={setSource}
          required
          warning={sourceWarning}
        />
        <UtmField
          id="utm-medium"
          label="utm_medium"
          placeholder="cpc"
          value={medium}
          onChange={setMedium}
          required
          warning={mediumWarning}
        />
        <div className="space-y-1.5">
          <Label htmlFor="utm-campaign">
            utm_campaign{' '}
            <span className="text-status-red" aria-hidden="true">
              *
            </span>
          </Label>
          <Input
            id="utm-campaign"
            autoComplete="off"
            placeholder="meta_reels_july"
            value={campaign}
            onChange={(e) => setCampaign(e.target.value)}
            required
            aria-invalid={campaignWarning || undefined}
          />
          {campaignWarning ? (
            <p className="text-xs text-status-amber">
              Contains characters that will be percent-encoded.
            </p>
          ) : null}
        </div>
      </div>

      {/* Slug helper */}
      <div className="space-y-1.5 rounded-md border bg-muted/20 p-3">
        <Label htmlFor="utm-slug-source" className="text-xs">
          Generate slug from campaign name
        </Label>
        <div className="flex gap-2">
          <Input
            id="utm-slug-source"
            autoComplete="off"
            placeholder="Meta Reels July"
            value={campaignName}
            onChange={(e) => setCampaignName(e.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={generateSlug}
            disabled={campaignName.trim() === ''}
            title="Convert to URL-safe slug and fill utm_campaign"
          >
            <Wand2 className="h-4 w-4" aria-hidden="true" />
            <span>Generate</span>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Lowercases the name, strips diacritics, and converts spaces
          + punctuation to dashes (e.g. <code>Meta Reels July</code> →{' '}
          <code>meta-reels-july</code>).
        </p>
      </div>

      {/* Optional UTM fields */}
      <div className="grid gap-4 sm:grid-cols-2">
        <UtmField
          id="utm-content"
          label="utm_content"
          placeholder="hero-banner"
          value={content}
          onChange={setContent}
          optional
          warning={contentWarning}
        />
        <UtmField
          id="utm-term"
          label="utm_term"
          placeholder="growth"
          value={term}
          onChange={setTerm}
          optional
          warning={termWarning}
        />
      </div>

      {/* Generated URL preview + copy */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="utm-generated">Generated URL</Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={copyUrl}
            disabled={!canCopy}
          >
            {copied ? (
              <>
                <Check className="h-4 w-4" aria-hidden="true" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" aria-hidden="true" />
                <span>Copy URL</span>
              </>
            )}
          </Button>
        </div>
        <Textarea
          id="utm-generated"
          readOnly
          rows={3}
          value={
            generatedUrl ||
            'Fill in destination URL, utm_source, utm_medium, and utm_campaign to preview the URL.'
          }
          className="font-mono text-xs"
          // Auto-select on focus so users can copy with Ctrl/Cmd+C
          // even when the clipboard API is unavailable.
          onFocus={(e) => {
            if (canCopy) e.currentTarget.select();
          }}
          aria-readonly="true"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small per-field renderer
// ---------------------------------------------------------------------------

interface UtmFieldProps {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
  required?: boolean;
  optional?: boolean;
  warning: boolean;
}

function UtmField({
  id,
  label,
  placeholder,
  value,
  onChange,
  required,
  optional,
  warning,
}: UtmFieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span className="text-status-red" aria-hidden="true">
            {' '}*
          </span>
        ) : null}
        {optional ? (
          <span className="text-muted-foreground"> (optional)</span>
        ) : null}
      </Label>
      <Input
        id={id}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        aria-invalid={warning || undefined}
      />
      {warning ? (
        <p className="text-xs text-status-amber">
          Contains characters that will be percent-encoded.
        </p>
      ) : null}
    </div>
  );
}
