/**
 * NextAuth (Auth.js v5) catch-all route handler.
 *
 * Auth.js v5 ships its HTTP handlers as `{ GET, POST }` on the
 * `handlers` export from `NextAuth(...)` — see `src/lib/auth.ts`. This
 * file is the single mount point that wires those handlers into Next's
 * App Router under `/api/auth/*` (signin, signout, callback, csrf,
 * session, providers, etc.).
 *
 * Runtime: Auth.js v5 depends on Node-only APIs (the `bcryptjs` compare
 * in `authorize()`, `crypto.randomBytes`, etc.) and is not Edge-safe, so
 * we explicitly opt the route into the Node.js runtime.
 *
 * SPEC.md §2.5 / §4.
 */

import { handlers } from '@/lib/auth';

export const runtime = 'nodejs';

export const { GET, POST } = handlers;
