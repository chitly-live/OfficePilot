'use client';

/**
 * HashtagsInput — chip-input for editing a `string[]` of hashtags.
 *
 * Used by the social post create + edit forms (SPEC.md §8.2.5 — the
 * hashtag library "saves reusable sets, paste into composer"). The
 * schema in `src/lib/schemas/social.ts` caps each hashtag at 50 chars
 * and a post at 30 hashtags total.
 *
 * UX:
 *   • Type a hashtag and press `Enter`, `,` or `Space` to commit it.
 *     `Space` is included because a typical hashtag flow is "type
 *     several hashtags separated by spaces" rather than commas.
 *   • A leading `#` is stripped automatically; we store the bare tag.
 *   • `Backspace` on an empty input removes the last hashtag.
 *   • Existing hashtags render as removable chips.
 *   • Duplicates (case-insensitive) are silently ignored.
 *   • Optional `sets` prop renders a row of "quick paste" buttons above
 *     the input — one per saved hashtag set (SPEC.md §8.2 #5, §12.1 #5).
 *     Clicking a set appends its hashtags to the existing list, deduped.
 *
 * Pure controlled component — owns nothing but the in-flight draft
 * input value; the committed list lives in the parent form state.
 */

import * as React from 'react';
import { Hash, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import type { HashtagSet } from './hashtag-sets';

// ---------------------------------------------------------------------------
// Constants — kept in sync with `src/lib/schemas/social.ts`
// ---------------------------------------------------------------------------

const MAX_HASHTAG_LENGTH = 50;
const MAX_HASHTAGS_PER_POST = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HashtagsInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Override the default 30-tag cap (rarely needed). */
  maxHashtags?: number;
  /** Override the default 50-char per-tag cap (rarely needed). */
  maxHashtagLength?: number;
  /**
   * Saved hashtag library (SPEC.md §8.2 #5). When non-empty, a row of
   * "quick paste" buttons renders above the input — one per set. When
   * empty/undefined the row is hidden entirely.
   */
  sets?: HashtagSet[];
  className?: string;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function HashtagsInput({
  value,
  onChange,
  disabled = false,
  placeholder = 'Add hashtag…',
  maxHashtags = MAX_HASHTAGS_PER_POST,
  maxHashtagLength = MAX_HASHTAG_LENGTH,
  sets,
  className,
}: HashtagsInputProps) {
  const [draft, setDraft] = React.useState('');

  const addHashtag = (raw: string) => {
    // Strip a leading `#` and any whitespace — hashtags are stored
    // without the `#` prefix so consumers don't have to keep
    // stripping it.
    const trimmed = raw.trim().replace(/^#/, '').slice(0, maxHashtagLength);
    if (trimmed === '') return;
    if (/\s/.test(trimmed)) return;
    const exists = value.some(
      (t) => t.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) {
      setDraft('');
      return;
    }
    if (value.length >= maxHashtags) {
      // Silent cap — surfacing a toast here would be noisy; the form
      // schema's max() will surface it once the user submits if they
      // somehow override the disabled input.
      return;
    }
    onChange([...value, trimmed]);
    setDraft('');
  };

  const removeHashtag = (index: number) => {
    if (disabled) return;
    onChange(value.filter((_, i) => i !== index));
  };

  /**
   * Append every hashtag from a saved set to the current value, in
   * order. Duplicates (case-insensitive) and empty strings are
   * skipped, and we stop early if we'd exceed `maxHashtags` so the
   * paste never produces an over-cap state.
   */
  const pasteSet = (setHashtags: string[]) => {
    if (disabled) return;
    const next = [...value];
    const seen = new Set(next.map((t) => t.toLowerCase()));
    for (const raw of setHashtags) {
      if (next.length >= maxHashtags) break;
      const cleaned = raw.trim().replace(/^#/, '').slice(0, maxHashtagLength);
      if (cleaned === '') continue;
      if (/\s/.test(cleaned)) continue;
      const lower = cleaned.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      next.push(cleaned);
    }
    if (next.length !== value.length) onChange(next);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (event.key === 'Enter' || event.key === ',' || event.key === ' ') {
      // Only intercept space when there's something to commit; the
      // user might want to type a multi-word draft before pressing
      // Enter.
      if (event.key === ' ' && draft.trim() === '') return;
      event.preventDefault();
      addHashtag(draft);
      return;
    }
    if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      event.preventDefault();
      removeHashtag(value.length - 1);
    }
  };

  const handleBlur = () => {
    // Commit a pending hashtag on blur so users don't lose work if
    // they tab away after typing.
    if (draft.trim() !== '') {
      addHashtag(draft);
    }
  };

  const atLimit = value.length >= maxHashtags;
  const hasSets = Array.isArray(sets) && sets.length > 0;

  return (
    <div className="space-y-2">
      {hasSets ? (
        <div
          className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-1"
          role="group"
          aria-label="Paste a saved hashtag set"
        >
          {sets!.map((set, idx) => (
            <Button
              key={`${set.name}-${idx}`}
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || atLimit}
              onClick={() => pasteSet(set.hashtags)}
              className="shrink-0"
              title={
                set.hashtags.length > 0
                  ? `#${set.hashtags.join(' #')}`
                  : 'Empty set'
              }
            >
              <Hash className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{set.name}</span>
            </Button>
          ))}
        </div>
      ) : null}

      <div
        className={cn(
          'flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 text-sm ring-offset-background',
          'focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2',
          disabled && 'cursor-not-allowed opacity-50',
          className,
        )}
        onClick={(e) => {
          const input =
            (e.currentTarget.querySelector('input[data-hashtags-input]') as
              | HTMLInputElement
              | null) ?? null;
          input?.focus();
        }}
      >
        {value.map((tag, idx) => (
          <span
            key={`${tag}-${idx}`}
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground"
          >
            <Hash className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
            <span className="max-w-[12rem] truncate">{tag}</span>
            {!disabled ? (
              <button
                type="button"
                aria-label={`Remove hashtag ${tag}`}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  removeHashtag(idx);
                }}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            ) : null}
          </span>
        ))}

        <input
          data-hashtags-input=""
          type="text"
          className="min-w-[8ch] flex-1 bg-transparent px-1 py-0.5 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          placeholder={atLimit ? `Max ${maxHashtags} hashtags` : placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          disabled={disabled || atLimit}
          maxLength={maxHashtagLength}
        />
      </div>
    </div>
  );
}
