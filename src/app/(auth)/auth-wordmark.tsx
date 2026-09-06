/**
 * "OfficePilot · by Praxxel" wordmark shown above every auth card
 * (forgot-password, reset-password). Mirrors the markup in
 * `login/page.tsx` — SPEC §13.1 indigo accent, no logo asset yet.
 */
export function AuthWordmark() {
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <span className="text-3xl font-semibold tracking-tight text-foreground">
        Office<span className="text-brand-600">Pilot</span>
      </span>
      <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
        by Praxxel
      </span>
    </div>
  );
}
