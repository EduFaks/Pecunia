import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { apiFetch, setAuthTokenGetter, setOnUnauthorized } from "./api";

/**
 * Auth state and actions for the app. SECURITY-CRITICAL (spec D1): the
 * access token lives ONLY in a React ref, in memory, for the lifetime of the
 * tab — it is never written to `localStorage`, `sessionStorage`, or
 * `document.cookie`. The refresh token never reaches the browser at all; the
 * backend sets it as an HttpOnly cookie the web client can't read, and every
 * `apiFetch` call already sends `credentials: "include"` so that cookie
 * rides along automatically.
 *
 * Boot sequence (on mount): a silent `POST /auth/refresh` uses that cookie
 * to mint a fresh access token with no user interaction. Success loads
 * `/auth/me` and flips status to "authed"; failure — no cookie, expired
 * session — is the ordinary logged-out boot, not an error, and flips to
 * "anon".
 *
 * 401 handling for already-authed calls: `AuthProvider` registers itself
 * with `api.ts` via `setAuthTokenGetter` (read the in-memory token) and
 * `setOnUnauthorized` (attempt one silent refresh). `apiFetch` owns the
 * actual retry — see its docstring — so this module's job is only to
 * perform the refresh and report whether it succeeded. Concurrent 401s
 * share a single in-flight refresh rather than each firing their own.
 */

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  display_name: string | null;
}

export type AuthStatus = "loading" | "authed" | "anon";

/** Exported so a caller that already has a `TokenResponse` from elsewhere
 * (Plan 06's setup wizard: `POST /setup/initialize` returns one directly) can
 * type its own result without redeclaring this shape — see `adoptSession`. */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string | null;
  user: AuthUser;
}

interface MeResponse {
  user: AuthUser;
  preferences: unknown;
}

export interface AuthContextValue {
  user: AuthUser | null;
  status: AuthStatus;
  login: (email: string, password: string) => Promise<void>;
  /** Adopts an already-issued `TokenResponse` into this tab's session —
   * Plan 06's setup wizard atomic `POST /setup/initialize` call returns one
   * directly (no separate login round-trip needed) and calls this to
   * auto-login the just-created owner. Stores the access token in memory and
   * flips `status` to `"authed"`, exactly like `login` does after its own
   * fetch — never writes to storage. Synchronous: there's no network call
   * here, the token is already in hand. */
  adoptSession: (token: TokenResponse) => void;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** Refresh ~1 minute before the access token actually expires. */
const REFRESH_SKEW_SECONDS = 60;

export function AuthProvider({ children }: { children: ReactNode }) {
  const tokenRef = useRef<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshInFlightRef = useRef<Promise<boolean> | null>(null);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const clearAuth = useCallback(() => {
    tokenRef.current = null;
    setUser(null);
    setStatus("anon");
    clearRefreshTimer();
  }, [clearRefreshTimer]);

  // `scheduleRefresh` and `silentRefresh` are mutually referential (the
  // timer fires a refresh; a successful refresh reschedules the timer), so
  // the timer calls through a ref rather than closing over `silentRefresh`
  // directly — that would force a declaration-order cycle between the two
  // `useCallback`s.
  const silentRefreshRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));

  // Nice-to-have per the brief: proactively refresh before expiry so an idle
  // tab never has to fall back to the reactive 401-retry path. The 401-retry
  // path above is the required floor and works with or without this timer.
  const scheduleRefresh = useCallback(
    (expiresInSeconds: number) => {
      clearRefreshTimer();
      const delayMs = Math.max(expiresInSeconds - REFRESH_SKEW_SECONDS, 0) * 1000;
      refreshTimerRef.current = setTimeout(() => {
        void silentRefreshRef.current();
      }, delayMs);
    },
    [clearRefreshTimer],
  );

  const applyTokenResponse = useCallback(
    (token: TokenResponse) => {
      tokenRef.current = token.access_token;
      setUser(token.user);
      scheduleRefresh(token.expires_in);
    },
    [scheduleRefresh],
  );

  /** Silent refresh via the HttpOnly cookie. Concurrent callers (the boot
   * effect, a 401 handler, the proactive timer) share one in-flight
   * request rather than each issuing their own. Never throws — resolves
   * `true`/`false` so callers can just branch on the result. */
  const silentRefresh = useCallback(async (): Promise<boolean> => {
    if (refreshInFlightRef.current) {
      return refreshInFlightRef.current;
    }
    const attempt = (async () => {
      try {
        const token = await apiFetch<TokenResponse>("/auth/refresh", {
          method: "POST",
          skipAuthRetry: true,
        });
        applyTokenResponse(token);
        return true;
      } catch {
        clearAuth();
        return false;
      } finally {
        refreshInFlightRef.current = null;
      }
    })();
    refreshInFlightRef.current = attempt;
    return attempt;
  }, [applyTokenResponse, clearAuth]);

  useEffect(() => {
    silentRefreshRef.current = silentRefresh;
  }, [silentRefresh]);

  useEffect(() => {
    setAuthTokenGetter(() => tokenRef.current);
    setOnUnauthorized(() => silentRefresh());

    let cancelled = false;

    (async () => {
      const refreshed = await silentRefresh();
      if (cancelled) {
        return;
      }
      if (!refreshed) {
        setStatus("anon");
        return;
      }
      try {
        const me = await apiFetch<MeResponse>("/auth/me");
        if (cancelled) {
          return;
        }
        setUser(me.user);
        setStatus("authed");
      } catch {
        if (!cancelled) {
          clearAuth();
        }
      }
    })();

    return () => {
      cancelled = true;
      clearRefreshTimer();
      setAuthTokenGetter(undefined);
      setOnUnauthorized(undefined);
    };
    // silentRefresh/clearAuth/clearRefreshTimer are all referentially stable
    // (their own deps chain down to stable refs and setState functions), so
    // this still runs exactly once per mount despite the explicit deps.
  }, [silentRefresh, clearAuth, clearRefreshTimer]);

  const login = useCallback(
    async (email: string, password: string) => {
      // Errors (ApiError, e.g. INVALID_CREDENTIALS) are intentionally not
      // caught here — they propagate to the caller (the login screen).
      const token = await apiFetch<TokenResponse>("/auth/login", {
        method: "POST",
        json: { email, password },
        skipAuthRetry: true,
      });
      applyTokenResponse(token);
      setStatus("authed");
    },
    [applyTokenResponse],
  );

  const adoptSession = useCallback(
    (token: TokenResponse) => {
      applyTokenResponse(token);
      setStatus("authed");
    },
    [applyTokenResponse],
  );

  const logout = useCallback(async () => {
    try {
      await apiFetch("/auth/logout", { method: "POST", skipAuthRetry: true });
    } catch {
      // A failed server-side logout (401 from an already-expired session,
      // a network failure) must not surface as an unhandled rejection, and
      // must not stop this tab from logging out locally — swallow it. The
      // `finally` below still runs either way.
    } finally {
      // Memory is cleared unconditionally — even if the network call fails,
      // this tab must not go on holding a token the user asked to drop.
      clearAuth();
    }
  }, [clearAuth]);

  const logoutAll = useCallback(async () => {
    try {
      await apiFetch("/auth/logout-all", { method: "POST", skipAuthRetry: true });
    } catch {
      // See logout() above.
    } finally {
      clearAuth();
    }
  }, [clearAuth]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, login, adoptSession, logout, logoutAll }),
    [user, status, login, adoptSession, logout, logoutAll],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// `useAuth` belongs with `AuthProvider`/`AuthContext`: they're one cohesive
// unit (provider + the hook that reads it), not a component-only module.
// Fast Refresh still works for `AuthProvider`; this only means editing
// `useAuth` itself forces a full reload — an acceptable trade for not
// splitting a single-responsibility auth module into three files.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
