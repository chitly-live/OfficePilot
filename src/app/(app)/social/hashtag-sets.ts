/**
 * Hashtag library — shared helpers for the `Setting('hashtag_sets')` row.
 *
 * The settings UI (SPEC.md §12.1 #5) stores reusable hashtag sets as a
 * stringified JSON array of `{ name, hashtags }` entries. The composer at
 * `/social/new` and `/social/[id]` reads that row server-side and lets the
 * user paste a saved set into the hashtag chip input (SPEC.md §8.2 #5).
 *
 * Centralising the parse here keeps both pages consistent and gives us a
 * single place to do defensive validation — the `Setting` table is shared
 * configuration that any admin can edit, so a malformed JSON value or a
 * stray entry shape must never crash the composer.
 */

export interface HashtagSet {
  /** Human-friendly label rendered on the quick-paste button. */
  name: string;
  /** Bare hashtags (without the leading `#`). */
  hashtags: string[];
}

/**
 * Parse a `Setting('hashtag_sets').value` string into a typed list.
 *
 * Defensive on every layer:
 *   • Returns `[]` for `null`, `undefined`, or empty strings.
 *   • Returns `[]` when the value isn't valid JSON.
 *   • Returns `[]` when the parsed value isn't an array.
 *   • Skips individual entries that aren't `{ name: string, hashtags: string[] }`.
 *
 * In every defensive branch we emit a `console.warn` so an operator can
 * spot a corrupted setting in the server logs without the UI breaking.
 */
export function parseHashtagSets(
  raw: string | null | undefined,
): HashtagSet[] {
  if (raw === null || raw === undefined || raw === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      '[social] Setting("hashtag_sets") is not valid JSON; falling back to []',
      err,
    );
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.warn(
      '[social] Setting("hashtag_sets") is not an array; falling back to []',
    );
    return [];
  }

  const sets: HashtagSet[] = [];
  for (const entry of parsed) {
    if (
      entry !== null &&
      typeof entry === 'object' &&
      typeof (entry as { name?: unknown }).name === 'string' &&
      Array.isArray((entry as { hashtags?: unknown }).hashtags) &&
      (entry as { hashtags: unknown[] }).hashtags.every(
        (h) => typeof h === 'string',
      )
    ) {
      sets.push({
        name: (entry as { name: string }).name,
        hashtags: (entry as { hashtags: string[] }).hashtags,
      });
    } else {
      console.warn(
        '[social] Setting("hashtag_sets") contains a malformed entry; skipping',
        entry,
      );
    }
  }

  return sets;
}
