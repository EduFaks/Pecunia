import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "./auth";
import { ApiError, apiFetch } from "./api";
import type { ReactNode } from "react";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

const USER = { id: "u1", email: "ada@example.com", name: "Ada Lovelace", display_name: null };

function tokenResponse(overrides: Partial<typeof USER> = {}, expiresIn = 900) {
  return {
    access_token: "access-token-abc",
    token_type: "bearer",
    expires_in: expiresIn,
    refresh_token: null,
    user: { ...USER, ...overrides },
  };
}

function meResponse() {
  return { user: USER, preferences: null };
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Routes the mocked global `fetch` by "METHOD /api/v1/path" so boot
 * (refresh + me), login, logout, and ad-hoc data calls can all be exercised
 * within one test without depending on call order. */
function mockFetchRouter() {
  const handlers = new Map<string, Handler>();
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url}`;
    const handler = handlers.get(key);
    if (!handler) {
      throw new Error(`Unhandled fetch in test: ${key}`);
    }
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fn);
  return {
    on(method: string, path: string, handler: Handler) {
      handlers.set(`${method.toUpperCase()} /api/v1${path}`, handler);
      return this;
    },
    fn,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

describe("AuthProvider / useAuth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("boots to authed with a valid refresh cookie, loads the user, and never touches storage", async () => {
    const router = mockFetchRouter();
    router
      .on("POST", "/auth/refresh", () => jsonResponse(tokenResponse()))
      .on("GET", "/auth/me", () => jsonResponse(meResponse()));

    const { result } = renderHook(() => useAuth(), { wrapper });

    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("authed"));

    expect(result.current.user).toEqual(USER);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("boots to anon when the silent refresh fails (normal not-logged-in boot)", async () => {
    const router = mockFetchRouter();
    router.on("POST", "/auth/refresh", () => jsonResponse({ detail: "INVALID_REFRESH_TOKEN" }, 401));

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("anon"));

    expect(result.current.user).toBeNull();
  });

  it("login stores the token in memory, sets authed, and never touches storage", async () => {
    const router = mockFetchRouter();
    router
      .on("POST", "/auth/refresh", () => jsonResponse({ detail: "INVALID_REFRESH_TOKEN" }, 401))
      .on("POST", "/auth/login", () => jsonResponse(tokenResponse()));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("anon"));

    await act(() => result.current.login("ada@example.com", "correct horse"));

    expect(result.current.status).toBe("authed");
    expect(result.current.user).toEqual(USER);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("adoptSession stores the token in memory, sets authed, and never touches storage", async () => {
    const router = mockFetchRouter();
    router.on("POST", "/auth/refresh", () => jsonResponse({ detail: "INVALID_REFRESH_TOKEN" }, 401));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("anon"));

    const owner = { id: "owner-1", email: "owner@example.com", name: "Owner", display_name: null };
    act(() => {
      result.current.adoptSession({
        access_token: "setup-access-token",
        token_type: "bearer",
        expires_in: 900,
        refresh_token: null,
        user: owner,
      });
    });

    expect(result.current.status).toBe("authed");
    expect(result.current.user).toEqual(owner);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    // "In memory" means the token actually reaches apiFetch's Authorization
    // header, not just that `status`/`user` flipped — exercise a real call.
    router.on("GET", "/widgets", () => jsonResponse({ ok: true }));
    await act(() => apiFetch("/widgets"));
    const call = router.fn.mock.calls.find(([input]) => String(input) === "/api/v1/widgets");
    const headers = new Headers((call?.[1] as RequestInit | undefined)?.headers);
    expect(headers.get("Authorization")).toBe("Bearer setup-access-token");
  });

  it("surfaces ApiError from a failed login to the caller", async () => {
    const router = mockFetchRouter();
    router
      .on("POST", "/auth/refresh", () => jsonResponse({ detail: "INVALID_REFRESH_TOKEN" }, 401))
      .on("POST", "/auth/login", () => jsonResponse({ detail: "INVALID_CREDENTIALS" }, 401));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("anon"));

    await act(async () => {
      await expect(result.current.login("ada@example.com", "wrong")).rejects.toBeInstanceOf(
        ApiError,
      );
    });
    // A rejected login must not leave the app half-authenticated.
    expect(result.current.status).toBe("anon");
    expect(result.current.user).toBeNull();
  });

  it("logout calls /auth/logout and clears state back to anon", async () => {
    const router = mockFetchRouter();
    router
      .on("POST", "/auth/refresh", () => jsonResponse(tokenResponse()))
      .on("GET", "/auth/me", () => jsonResponse(meResponse()))
      .on("POST", "/auth/logout", () => emptyResponse(204));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("authed"));

    await act(() => result.current.logout());

    expect(result.current.status).toBe("anon");
    expect(result.current.user).toBeNull();
    expect(
      router.fn.mock.calls.some(([input, init]) => {
        const method = (init as RequestInit | undefined)?.method?.toUpperCase();
        return String(input) === "/api/v1/auth/logout" && method === "POST";
      }),
    ).toBe(true);
  });

  it("logout resolves (does not throw) and still clears state to anon when the server call rejects", async () => {
    const router = mockFetchRouter();
    router
      .on("POST", "/auth/refresh", () => jsonResponse(tokenResponse()))
      .on("GET", "/auth/me", () => jsonResponse(meResponse()))
      .on("POST", "/auth/logout", () => Promise.reject(new Error("network down")));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("authed"));

    await act(async () => {
      await expect(result.current.logout()).resolves.toBeUndefined();
    });

    expect(result.current.status).toBe("anon");
    expect(result.current.user).toBeNull();
  });

  it("logoutAll calls /auth/logout-all and clears state back to anon", async () => {
    const router = mockFetchRouter();
    router
      .on("POST", "/auth/refresh", () => jsonResponse(tokenResponse()))
      .on("GET", "/auth/me", () => jsonResponse(meResponse()))
      .on("POST", "/auth/logout-all", () => emptyResponse(204));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("authed"));

    await act(() => result.current.logoutAll());

    expect(result.current.status).toBe("anon");
    expect(result.current.user).toBeNull();
    expect(
      router.fn.mock.calls.some(([input, init]) => {
        const method = (init as RequestInit | undefined)?.method?.toUpperCase();
        return String(input) === "/api/v1/auth/logout-all" && method === "POST";
      }),
    ).toBe(true);
  });

  it("logoutAll resolves (does not throw) and still clears state to anon when the server call rejects", async () => {
    const router = mockFetchRouter();
    router
      .on("POST", "/auth/refresh", () => jsonResponse(tokenResponse()))
      .on("GET", "/auth/me", () => jsonResponse(meResponse()))
      .on("POST", "/auth/logout-all", () => Promise.reject(new Error("network down")));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("authed"));

    await act(async () => {
      await expect(result.current.logoutAll()).resolves.toBeUndefined();
    });

    expect(result.current.status).toBe("anon");
    expect(result.current.user).toBeNull();
  });

  it("a 401 on a data call triggers exactly one refresh and replays the call once", async () => {
    const router = mockFetchRouter();
    let dataCalls = 0;
    router
      .on("POST", "/auth/refresh", () => jsonResponse(tokenResponse()))
      .on("GET", "/auth/me", () => jsonResponse(meResponse()))
      .on("GET", "/widgets", () => {
        dataCalls += 1;
        return dataCalls === 1
          ? jsonResponse({ detail: "TOKEN_EXPIRED" }, 401)
          : jsonResponse({ ok: true });
      });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("authed"));
    router.fn.mockClear();

    const data = await act(() => apiFetch<{ ok: boolean }>("/widgets"));

    expect(data).toEqual({ ok: true });
    expect(dataCalls).toBe(2);
    const refreshCalls = router.fn.mock.calls.filter(
      ([input]) => String(input) === "/api/v1/auth/refresh",
    );
    expect(refreshCalls).toHaveLength(1);
    expect(result.current.status).toBe("authed");
  });

  it("two concurrent 401'd data calls share exactly one refresh (no stampede)", async () => {
    const router = mockFetchRouter();
    let widgetsCalls = 0;
    let gadgetsCalls = 0;
    router
      .on("POST", "/auth/refresh", () => jsonResponse(tokenResponse()))
      .on("GET", "/auth/me", () => jsonResponse(meResponse()))
      .on("GET", "/widgets", () => {
        widgetsCalls += 1;
        return widgetsCalls === 1
          ? jsonResponse({ detail: "TOKEN_EXPIRED" }, 401)
          : jsonResponse({ ok: "widgets" });
      })
      .on("GET", "/gadgets", () => {
        gadgetsCalls += 1;
        return gadgetsCalls === 1
          ? jsonResponse({ detail: "TOKEN_EXPIRED" }, 401)
          : jsonResponse({ ok: "gadgets" });
      });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("authed"));
    router.fn.mockClear();

    // Two data calls that both come back 401 essentially simultaneously
    // (both fire before either's refresh attempt resolves) must not each
    // kick off their own refresh — `silentRefresh`'s in-flight-promise
    // dedupe (auth.tsx) is exactly what prevents this stampede.
    const [widgets, gadgets] = await act(() =>
      Promise.all([
        apiFetch<{ ok: string }>("/widgets"),
        apiFetch<{ ok: string }>("/gadgets"),
      ]),
    );

    expect(widgets).toEqual({ ok: "widgets" });
    expect(gadgets).toEqual({ ok: "gadgets" });
    const refreshCalls = router.fn.mock.calls.filter(
      ([input]) => String(input) === "/api/v1/auth/refresh",
    );
    expect(refreshCalls).toHaveLength(1);
    expect(result.current.status).toBe("authed");
  });

  it("clears state to anon (and does not loop) when the retry refresh also fails", async () => {
    const router = mockFetchRouter();
    let refreshCalls = 0;
    router
      .on("POST", "/auth/refresh", () => {
        refreshCalls += 1;
        return refreshCalls === 1
          ? jsonResponse(tokenResponse())
          : jsonResponse({ detail: "INVALID_REFRESH_TOKEN" }, 401);
      })
      .on("GET", "/auth/me", () => jsonResponse(meResponse()))
      .on("GET", "/widgets", () => jsonResponse({ detail: "TOKEN_EXPIRED" }, 401));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("authed"));

    await act(async () => {
      await expect(apiFetch("/widgets")).rejects.toMatchObject({ status: 401 });
    });

    await waitFor(() => expect(result.current.status).toBe("anon"));
    expect(result.current.user).toBeNull();
    expect(refreshCalls).toBe(2); // one at boot, exactly one retry attempt — no loop
  });

  it("does not render without a provider", () => {
    function Bare() {
      useAuth();
      return null;
    }
    // React logs the thrown render error to console.error even though we
    // assert on it below; silence that expected noise for a clean run.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render(<Bare />)).toThrow("useAuth must be used within an AuthProvider");
    } finally {
      consoleError.mockRestore();
    }
  });
});
