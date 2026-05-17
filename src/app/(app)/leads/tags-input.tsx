'use client';

/**
 * TagsInput — small chip-input for editing a `string[]` of tags.
 *
 * Used by the lead create + edit forms (SPEC §6.4 — leads have a
 * `tags` array; the schema caps each tag at 50 chars and a lead at
 * 30 tags total).
 *
 * UX:
 *   • Type a tag and press `Enter` or `,` to commit it.
 *   • `Backspace` on an empty input removes the last tag.
 *   • Existing tags render as removable chips.
 *   • Duplicates (case-insensitive) are silently ignored.
 *
 * Pure controlled component — owns nothing but the in-flight draft
 * input value; the committed list lives in the parent form state.
 */

import * as React from 'react';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Constants — kept in sync with `leads.ts` schema
// ---------------------------------------------------------------------------

const MAX_TAG_LENGTH = 50;
const MAX_TAGS_PER_LEAD = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TagsInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Override the default 30-tag cap (rarely needed). */
  maxTags?: number;
  /** Override the default 50-char per-tag cap (rarely needed). */
  maxTagLength?: number;
  className?: string;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function TagsInput({
  value,
  onChange,
  disabled = false,
  placeholder = 'Add tag…',
  maxTags = MAX_TAGS_PER_LEAD,
  maxTagLength = MAX_TAG_LENGTH,
  className,
}: TagsInputProps) {
  const [draft, setDraft] = React.useState('');

  const addTag = (raw: string) => {
    const trimmed = raw.trim().slice(0, maxTagLength);
    if (trimmed === '') return;
    const exists = value.some(
      (t) => t.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) {
      setDraft('');
      return;
    }
    if (value.length >= maxTags) {
      // Silent cap — surfacing a toast here would be noisy; the form
      // schema's max() will surface it once the user submits if they
      // somehow override the disabled input.
      return;
    }
    onChange([...value, trimmed]);
    setDraft('');
  };

  const removeTag = (index: number) => {
    if (disabled) return;
    onChange(value.filter((_, i) => i !== index));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addTag(draft);
      return;
    }
    if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      event.preventDefault();
      removeTag(value.length - 1);
    }
  };

  const handleBlur = () => {
    // Commit a pending tag on blur so users don't lose work if they
    // tab away after typing.
    if (draft.trim() !== '') {
      addTag(draft);
    }
  };

  const atLimit = value.length >= maxTags;

  return (
    <div
      className={cn(
        'flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 text-sm ring-offset-background',
        'focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
      onClick={(e) => {
        // Click anywhere in the chip strip → focus the input.
        const input =
          (e.currentTarget.querySelector('input[data-tags-input]') as
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
          <span className="max-w-[12rem] truncate">{tag}</span>
          {!disabled ? (
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              className="rounded-full p-0.5 text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                removeTag(idx);
              }}
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          ) : null}
        </span>
      ))}

      <input
        data-tags-input=""
        type="text"
        className="min-w-[8ch] flex-1 bg-transparent px-1 py-0.5 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        placeholder={atLimit ? `Max ${maxTags} tags` : placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        disabled={disabled || atLimit}
        maxLength={maxTagLength}
      />
    </div>
  );
}
