import { Navigate, Outlet, useLocation } from "react-router-dom";
import Wordmark from "../components/brand/Wordmark";
import Button from "../components/ui/Button";
import Callout from "../components/ui/Callout";
import { useAuth } from "../lib/auth";
import { useSetupStatus } from "../lib/setup";

/**
 * Branded loading splash shown whenever setup-status or auth is still
 * resolving, so the app never flashes the wizard, login, or app shell
 * before we actually know which one is correct. Deliberately subtle — no
 * `animate` stroke-draw here: this can appear and resolve within a single
 * frame on a warm cache, and a flourish that gets cut off mid-draw reads as
 * broken, not calm. `Login` is where the wordmark gets its moment.
 */
export function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas">
      <Wordmark size="md" className="animate-pulse motion-reduce:animate-none" />
    </div>
  );
}

/**
 * Shown in place of the route tree when the setup-status query itself has
 * failed (network error, API down) — distinct from `isLoading`, which is
 * still "resolving." We deliberately do NOT fall through to the wizard, the
 * app, or login here: we don't actually know `initialized`, so guessing
 * either way could strand the visitor on the wrong screen. `onRetry` re-runs
 * the query in place.
 */
function SetupError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <Wordmark size="md" />
        <Callout variant="negative">Couldn't reach Pecunia. Check your connection and try again.</Callout>
        <Button variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

/**
 * Outermost route guard (see App.tsx) — every other route, including the
 * catch-all `NotFound`, lives inside this one. An uninitialized instance
 * always lands on the setup wizard, from anywhere; once initialized, the
 * inverse holds: visiting `/setup/*` bounces back to the app. Resolution
 * order matters: `isLoading` (still resolving) takes priority over
 * `isError` (query failed) takes priority over `initialized` — a failed
 * query must never be read as "uninitialized" or fall through to the app.
 */
export function RequireSetup() {
  const { initialized, isLoading, isError, refetch } = useSetupStatus();
  const location = useLocation();

  if (isLoading) {
    return <Splash />;
  }

  if (isError) {
    return <SetupError onRetry={refetch} />;
  }

  const onSetupRoute =
    location.pathname === "/setup" || location.pathname.startsWith("/setup/");

  if (initialized === false) {
    return onSetupRoute ? <Outlet /> : <Navigate to="/setup" replace />;
  }

  return onSetupRoute ? <Navigate to="/" replace /> : <Outlet />;
}

/**
 * Assumes `RequireSetup` has already confirmed the instance is
 * initialized. Redirects anonymous visitors to `/login`; authed visitors
 * reach the outlet (the `AppShell` and its nested screens).
 */
export function RequireAuth() {
  const { status } = useAuth();

  if (status === "loading") {
    return <Splash />;
  }

  if (status === "anon") {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}

/** Keeps an already-authed visitor off `/login` (a stale bookmark, back-nav
 * after signing in elsewhere, etc.). */
export function RedirectIfAuthed() {
  const { status } = useAuth();

  if (status === "loading") {
    return <Splash />;
  }

  if (status === "authed") {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
