/**
 * Root layout — applied to every page in the app, both `(auth)` and
 * `(app)` route groups.
 *
 * Server Component. Responsibilities (per SPEC §13 design system):
 *
 *   1. Wire the Inter font from `next/font/google` to the CSS variable
 *      `--font-sans` that `tailwind.config.ts` already references via
 *      `fontFamily.sans`. We use the `variable` API (rather than
 *      `className`) so the font cascades to every element via the
 *      Tailwind `font-sans` utility on <body>.
 *   2. Provide page metadata (title, description, viewport) per Next.js
 *      14 conventions — `viewport` is its own export, not a key on
 *      `metadata`, since Next 14.
 *   3. Mount the cross-app providers that must wrap every page:
 *        • `ThemeProvider` (next-themes, system / light / dark)
 *        • Sonner `Toaster` so any `toast(...)` call from anywhere in
 *          the tree renders consistently.
 *   4. Set `lang="en"` on <html> for assistive tech, plus
 *      `suppressHydrationWarning` because next-themes briefly mismatches
 *      the server/client `class` attribute while resolving the saved
 *      theme — that's expected and harmless.
 *
 * This layout intentionally has zero visual chrome of its own. Sidebar
 * + Topbar live in `src/app/(app)/layout.tsx`; the auth gradient lives
 * in `src/app/(auth)/layout.tsx`. Keeping the root layout neutral lets
 * each route group own its full-page presentation.
 */

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';

import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';

import './globals.css';

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

/**
 * Inter — body font for the entire app. SPEC §13.1 calls for a clean,
 * dense type scale; Inter is the de-facto default for shadcn/ui and
 * pairs well with the indigo accent.
 *
 * `display: 'swap'` → fall back to system sans until Inter loads
 *   (avoids invisible-text-while-loading on slow connections).
 * `variable: '--font-sans'` → exposes the loaded font as a CSS var so
 *   `tailwind.config.ts` (`fontFamily.sans = ['var(--font-sans)', ...]`)
 *   can resolve it on every `font-sans` Tailwind utility.
 */
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const metadata: Metadata = {
  title: {
    default: 'OfficePilot — Chitly',
    template: '%s · OfficePilot',
  },
  description:
    'Internal office cockpit for the Chitly team — leads, marketing, social, dev tracking, and AI-driven insights in one place.',
  applicationName: 'OfficePilot',
  // Internal tool — keep search engines out by default. Individual
  // public-facing routes (none in v1) can override per-route.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Indigo brand accent for mobile chrome (matches SPEC §13.1 #6366f1).
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#6366f1' },
    { media: '(prefers-color-scheme: dark)', color: '#4338ca' },
  ],
};

// ---------------------------------------------------------------------------
// Root layout
// ---------------------------------------------------------------------------

interface RootLayoutProps {
  children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html
      lang="en"
      // next-themes flips the `class` attribute on <html> on hydration;
      // React would otherwise log a hydration mismatch warning.
      suppressHydrationWarning
      className={inter.variable}
    >
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster richColors closeButton position="top-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
