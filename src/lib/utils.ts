import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind class names while resolving conflicts.
 * Standard shadcn/ui helper used by every primitive in `src/components/ui/*`.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
