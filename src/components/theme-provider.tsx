'use client';

/**
 * ThemeProvider — thin client wrapper around `next-themes`.
 *
 * Why we need this file at all:
 *   `next-themes` provides a Provider component that must run on the
 *   client (it uses localStorage + a layout effect to apply the `class`
 *   on <html>). Next.js 14 server components can render it but cannot
 *   pass props through transparently across the server/client boundary
 *   without "use client" living somewhere — so we keep that boundary
 *   here and re-export under a project-local name.
 *
 *   Centralising the import also gives downstream consumers (e.g. the
 *   sonner Toaster which calls `useTheme()`) a single place to swap
 *   the theming library if we ever migrate.
 *
 * Defaults are tuned for SPEC §13.1's "clean, dense" internal-tool
 * aesthetic:
 *   • `attribute="class"` so Tailwind's `dark:` variant works (we set
 *     `darkMode: 'class'` in `tailwind.config.ts`).
 *   • `defaultTheme="system"` follows the OS preference until a user
 *     explicitly picks light/dark.
 *   • `enableSystem` keeps the system pref live (re-applies on OS-level
 *     toggle without a refresh).
 *   • `disableTransitionOnChange` prevents the brief color-flash that
 *     happens when CSS transitions animate the theme swap.
 */

import * as React from 'react';
import {
  ThemeProvider as NextThemesProvider,
  type ThemeProviderProps,
} from 'next-themes';

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
