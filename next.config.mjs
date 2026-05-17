/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    typedRoutes: false,
    // Enable the `instrumentation.ts` hook so `register()` runs once at
    // server boot. Used by `instrumentation.ts` at the workspace root
    // to run boot-time env-var validation via `src/lib/env.ts`
    // (pre-deploy fix B5).
    //
    // Next 14.x: this flag is required (it moves to stable / on-by-
    // default in Next 15). On 14.0.4+ setting it to `true` is a no-op
    // beyond enabling discovery, but documenting the intent is worth
    // the line.
    instrumentationHook: true,
  },
};

export default nextConfig;
