/**
 * Thin fetch wrapper for the Pecunia API.
 *
 * Every call is prefixed with `/api/v1`, always sends cookies
 * (`credentials: "include"`, needed for the refresh cookie), and JSON-encodes
 * `opts.json` when given. Non-2xx responses are parsed as `{"detail": "..."}`
 * (per docs/CONVENTIONS.md §6) and thrown as `ApiError`; a 401 specifically
 * throws `UnauthorizedError` so the auth layer can catch it and trigger a
 * silent refresh.
 *
 * This module owns the only raw `fetch` call in the app — everything else
 * goes through `apiFetch`.
 *
 * Task 3 (auth) wires itself in via two injection points rather than this
 * module importing the auth store directly (which would invert the
 * dependency and risk a cycle):
 *   - `setAuthTokenGetter` registers a function that returns the current
 *     in-memory bearer token (or null/undefined while unauthenticated). When
 *     no getter is registered, requests simply omit the Authorization header.
 *   - `setOnUnauthorized` registers a callback invoked whenever a request
 *     receives a 401, so the auth layer can attempt a silent refresh. The
 *     handler resolves to `true` if the refresh succeeded (and the token
 *     getter now returns a fresh token) or `false`/`undefined` otherwise.
 *     When it resolves `true`, `apiFetch` replays the original request
 *     exactly once with the fresh token; a 401 on that replay is thrown
 *     straight through without calling the handler again — one retry, never
 *     a loop.
 *   - `opts.skipAuthRetry` opts a single call out of the 401 interceptor
 *     entirely (the 401 is thrown immediately, `onUnauthorized` is not
 *     invoked). The auth module sets this on its own `/auth/login`,
 *     `/auth/refresh`, `/auth/logout`, and `/auth/logout-all` calls — those
 *     endpoints' own 401s are the auth flow's own business (bad
 *     credentials, an actually-expired session), not a signal to attempt
 *     *another* refresh. Without this, a 401 from `/auth/refresh` itself
 *     would re-invoke `onUnauthorized`, which calls back into the same
 *     refresh routine — a deadlock (or worse, a loop) rather than the one
 *     bounded retry this module promises.
 */

const API_BASE = "/api/v1";
const DEFAULT_ERROR_DETAIL = "UNKNOWN_ERROR";

/** One Pydantic validation error, as FastAPI's default 422 body shapes it
 * (`{"detail": [{"loc": [...], "msg": ...}, ...]}`) — distinct from the
 * `{"detail": "SCREAMING_SNAKE"}` string shape every other error uses (per
 * CONVENTIONS §6). `loc` is the field path, e.g. `["body", "preferences",
 * "base_currency"]`. */
export interface ApiFieldError {
  loc: (string | number)[];
  msg: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;
  /** Populated only for a 422 whose body is the Pydantic validation-error
   * array shape above — lets a call site (e.g. setup's initialize) name the
   * offending field. `undefined` for the ordinary string-detail error. */
  readonly fieldErrors?: ApiFieldError[];

  constructor(status: number, detail: string, fieldErrors?: ApiFieldError[]) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.fieldErrors = fieldErrors;
  }
}

export class UnauthorizedError extends ApiError {
  constructor(detail: string) {
    super(401, detail);
    this.name = "UnauthorizedError";
  }
}

export type ApiFetchOptions = RequestInit & { json?: unknown; skipAuthRetry?: boolean };

type AuthTokenGetter = () => string | null | undefined;
type UnauthorizedHandler = (error: UnauthorizedError) => Promise<boolean> | boolean;

let authTokenGetter: AuthTokenGetter | undefined;
let onUnauthorized: UnauthorizedHandler | undefined;

/** Registers the function the auth layer uses to supply the current bearer token. */
export function setAuthTokenGetter(getter: AuthTokenGetter | undefined): void {
  authTokenGetter = getter;
}

/** Registers a callback invoked whenever a request comes back 401 Unauthorized. */
export function setOnUnauthorized(handler: UnauthorizedHandler | undefined): void {
  onUnauthorized = handler;
}

export async function apiFetch<T>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
  return performFetch<T>(path, opts, false);
}

/**
 * Does the actual work of `apiFetch`. `isRetry` is deliberately NOT part of
 * `apiFetch`'s public signature — it's an internal bookkeeping flag for the
 * one-retry-then-throw contract described above, set only by this module's
 * own recursive call below. Exposing it as a public third argument would
 * let a stray call site pass `true` and silently disable the refresh path.
 */
async function performFetch<T>(
  path: string,
  opts: ApiFetchOptions,
  isRetry: boolean,
): Promise<T> {
  const { json, headers, body, skipAuthRetry, ...rest } = opts;

  const finalHeaders = new Headers(headers);
  let finalBody = body;

  if (json !== undefined) {
    finalBody = JSON.stringify(json);
    if (!finalHeaders.has("Content-Type")) {
      finalHeaders.set("Content-Type", "application/json");
    }
  }

  const token = authTokenGetter?.();
  if (token && !finalHeaders.has("Authorization")) {
    finalHeaders.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: finalHeaders,
    body: finalBody,
    credentials: "include",
  });

  if (!response.ok) {
    const { detail, fieldErrors } = await parseErrorBody(response);
    if (response.status === 401) {
      const error = new UnauthorizedError(detail);
      // Only the original request triggers a refresh attempt — the replay
      // (isRetry === true) throws straight through, so a still-401 replay
      // can never re-enter this branch and loop.
      if (!isRetry && !skipAuthRetry && onUnauthorized) {
        const shouldRetry = await onUnauthorized(error);
        if (shouldRetry) {
          return performFetch<T>(path, opts, true);
        }
      }
      throw error;
    }
    throw new ApiError(response.status, detail, fieldErrors);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function isRawFieldError(value: unknown): value is { loc?: unknown; msg?: unknown } {
  return typeof value === "object" && value !== null;
}

/**
 * Parses a non-2xx body into a `{detail, fieldErrors}` pair. Handles both
 * shapes the API sends (CONVENTIONS §6): the ordinary
 * `{"detail": "SCREAMING_SNAKE"}` string, and FastAPI/Pydantic's default 422
 * validation-error array — mapped here to the stable marker
 * `"VALIDATION_ERROR"` plus the parsed `fieldErrors`, rather than the
 * generic `UNKNOWN_ERROR` fallback an unrecognized shape gets.
 */
async function parseErrorBody(
  response: Response,
): Promise<{ detail: string; fieldErrors?: ApiFieldError[] }> {
  try {
    const data = (await response.json()) as { detail?: unknown };
    if (typeof data.detail === "string") {
      return { detail: data.detail };
    }
    if (Array.isArray(data.detail)) {
      const fieldErrors: ApiFieldError[] = data.detail.filter(isRawFieldError).map((item) => ({
        loc: Array.isArray(item.loc) ? (item.loc as (string | number)[]) : [],
        msg: typeof item.msg === "string" ? item.msg : "Invalid value.",
      }));
      return { detail: "VALIDATION_ERROR", fieldErrors };
    }
  } catch {
    // Body wasn't valid JSON (or was empty) — fall through to the default.
  }
  return { detail: DEFAULT_ERROR_DETAIL };
}
