import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import Button from "../../../components/ui/Button";
import { cn } from "../../../lib/cn";

/** How long the cross-fade-out plays before `navigate("/")` actually fires.
 * A fixed timer (not a `transitionend` listener) on purpose: under
 * `prefers-reduced-motion` the global CSS rule (`global.css`) forces the
 * transition's own duration to ~0, and a 0-duration CSS transition doesn't
 * reliably fire `transitionend` in every browser — a listener-driven
 * navigate could simply never happen. A plain `setTimeout` always fires,
 * motion preference or not, which is what "reduced-motion-safe" means here:
 * clicking Enter always reaches the dashboard, just without (or with) the
 * visible fade depending on the viewer's OS setting. */
const CROSSFADE_MS = 200;

/**
 * Step 5 — Finish: the wizard's payoff. A static check glyph (a plain SVG
 * path in the accent color) scales/fades in on mount, then "You're ready." +
 * "Pecunia is now configured." + the primary "Enter Pecunia →" reveal in on
 * an ordinary opacity/translate transition, delayed (`delay-700`) to land
 * just after the checkmark settles — the "holds a beat" from the spec.
 * Both reveals are plain CSS transitions, reduced-motion-safe for free: the
 * global `prefers-reduced-motion` rule already zeroes ordinary transition
 * durations app-wide (§9.1), so under that setting everything simply appears
 * at its final frame instantly.
 *
 * Clicking Enter cross-fades the whole step (opacity + a subtle scale) and,
 * after `CROSSFADE_MS`, calls `navigate("/")`. By the time this step is
 * reachable at all the instance is initialized and the wizard auto-logged
 * the owner in (Step 3), so `RequireSetup`/`RequireAuth` (routes/guards.tsx)
 * let `/` render the real app (`AppShell` — Plan 07 fills in the dashboard
 * itself) instead of bouncing back to `/setup` or `/login`.
 *
 * That last part depends on `useSetupStatus`'s query cache (`lib/setup.ts`,
 * key `["setup-status"]`) actually knowing the instance is initialized —
 * `RequireSetup` reads it, not the server, on every render. Nothing updates
 * that cache when Step 3's `POST /setup/initialize` succeeds (deliberately —
 * see `StepPreferences`'s doc comment: doing it there, while still under
 * `/setup/*`, makes `RequireSetup` redirect to `/` immediately, skipping
 * Steps 4 and 5 entirely), so left alone it can still read the stale
 * `{initialized: false}` fetched when the wizard first mounted (within
 * `useSetupStatus`'s 30s staleTime, `lib/query.ts`) right up until this
 * click — which would otherwise bounce the just-onboarded owner straight
 * back to `/setup` instead of landing on the dashboard. Fixed here, the one
 * place the wizard actually leaves `/setup/*`: the cache write happens in
 * the same tick as `navigate("/")` (not earlier — that would trigger the
 * same premature redirect Steps 4/5 avoid above; not via
 * `invalidateQueries`, which only schedules a background refetch, the same
 * staleness window until it resolves) so `RequireSetup` never re-renders
 * with "initialized now true, but still on /setup" as its own state.
 */
function StepFinish() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  function handleEnter() {
    if (leaving) {
      return;
    }
    setLeaving(true);
    window.setTimeout(() => {
      navigate("/");
      queryClient.setQueryData(["setup-status"], { initialized: true });
    }, CROSSFADE_MS);
  }

  return (
    <div
      className={cn(
        "flex min-h-screen flex-col items-center justify-center gap-6 bg-canvas px-6 text-center transition-all duration-200 ease-pc",
        leaving ? "scale-[0.98] opacity-0" : "scale-100 opacity-100",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex h-16 w-16 items-center justify-center transition-all duration-300 ease-pc-out",
          revealed ? "scale-100 opacity-100" : "scale-75 opacity-0",
        )}
      >
        <svg viewBox="0 0 24 24" fill="none" className="h-full w-full">
          <path
            d="M4 12.5 L9.5 18.5 L20 5.5"
            stroke="var(--pc-accent)"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>

      <div
        className={cn(
          "flex flex-col items-center gap-3 transition-all delay-700 duration-300 ease-pc",
          revealed ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
        )}
      >
        <h1 className="font-display text-3xl text-ink">You&rsquo;re ready.</h1>
        <p className="text-sm text-ink-2">Pecunia is now configured.</p>
        <Button size="lg" className="mt-4" onClick={handleEnter}>
          Enter Pecunia →
        </Button>
      </div>
    </div>
  );
}

export default StepFinish;
