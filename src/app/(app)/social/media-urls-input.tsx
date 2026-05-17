'use client';

/**
 * MediaUrlsInput — chip-input for editing a `string[]` of media URLs.
 *
 * Used by the social post create + edit forms (SPEC.md §8.2.2 — every
 * post may carry up to 10 media URLs). The schema in
 * `src/lib/schemas/social.ts` validates each entry as a URL.
 *
 * UX:
 *   • Type a URL and press `Enter` or click "Add" to commit it.
 *   • Existing URLs render as removable chips with the host as the
 *     visible label and the full URL as a tooltip / link.
 *   • Duplicate URLs are silently ignored (case-insensitive).
 *   • Invalid URLs surface inline as an error message before they're
 *     added; the parent form's submit-side schema catches anything
 *     that slips past.
 *
 * Pure controlled component — owns nothing but the in-flight draft
 * input value; the committed list lives in the parent form state.
 */

import * as React from 'react';
import { ExternalLink, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Constants — kept in sync with `src/lib/schemas/social.ts`
// ---------------------------------------------------------------------------

const MAX_MEDIA_URLS = 10;
const MAX_URL_LENGTH = 2048;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate a candidate URL via the platform `URL` constructor. We
 * insist on `http(s)` to keep the field free of `mailto:`,
 * `javascript:`, etc. — anything that would surprise a click handler.
 */
function isValidHttpUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Best-effort short label (host + first path segment). */
function shortLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, '').split('/').slice(0, 1).join('/');
    return path ? `${u.hostname}/${path}` : u.hostname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MediaUrlsInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Override the default 10-URL cap (rarely needed). */
  maxUrls?: number;
  className?: string;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function MediaUrlsInput({
  value,
  onChange,
  disabled = false,
  placeholder = 'https://example.com/image.jpg',
  maxUrls = MAX_MEDIA_URLS,
  className,
}: MediaUrlsInputProps) {
  const [draft, setDraft] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const atLimit = value.length >= maxUrls;

  const tryAdd = () => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      setError(null);
      return;
    }
    if (trimmed.length > MAX_URL_LENGTH) {
      setError(`URL must be ${MAX_URL_LENGTH} characters or fewer`);
      return;
    }
    if (!isValidHttpUrl(trimmed)) {
      setError('Enter a valid http(s) URL');
      return;
    }
    const exists = value.some(
      (existing) => existing.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) {
      setDraft('');
      setError(null);
      return;
    }
    if (value.length >= maxUrls) {
      setError(`Max ${maxUrls} media URLs`);
      return;
    }
    onChange([...value, trimmed]);
    setDraft('');
    setError(null);
  };

  const remove = (index: number) => {
    if (disabled) return;
    onChange(value.filter((_, i) => i !== index));
  };

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-start gap-2">
        <Input
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder={atLimit ? `Max ${maxUrls} URLs` : placeholder}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              tryAdd();
            }
          }}
          disabled={disabled || atLimit}
          maxLength={MAX_URL_LENGTH}
          aria-invalid={error ? 'true' : 'false'}
        />
        <Button
          type="button"
          variant="outline"
          size="default"
          onClick={tryAdd}
          disabled={disabled || atLimit || draft.trim() === ''}
        >
          Add
        </Button>
      </div>

      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {value.length > 0 ? (
        <ul className="space-y-1">
          {value.map((url, idx) => (
            <li
              key={`${url}-${idx}`}
              className="flex items-center gap-2 rounded-md border bg-muted/20 px-2 py-1 text-xs"
            >
              <ExternalLink
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate text-foreground hover:underline"
                title={url}
              >
                {shortLabel(url)}
              </a>
              {!disabled ? (
                <button
                  type="button"
                  aria-label={`Remove media URL ${url}`}
                  className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => remove(idx)}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
