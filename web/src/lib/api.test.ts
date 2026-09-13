import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  UnauthorizedError,
  apiFetch,
  setAuthTokenGetter,
  setOnUnauthorized,
} from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

describe("apiFetch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAuthTokenGetter(undefined);
    setOnUnauthorized(undefined);
  });

  it("prepends /api/v1 to the given path", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }));

    await apiFetch("/accounts");

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/accounts",
      expect.anything(),
    );
  });

  it("always includes credentials so cookies are sent", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }));

    await apiFetch("/accounts");

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it("parses and returns the JSON response body", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: "abc", name: "Checking" }));

    const result = await apiFetch<{ id: string; name: string }>("/accounts/abc");

    expect(result).toEqual({ id: "abc", name: "Checking" });
  });

  it("returns undefined for a 204 No Content response", async () => {
    vi.mocked(fetch).mockResolvedValue(emptyResponse(204));

    const result = await apiFetch("/accounts/abc");

    expect(result).toBeUndefined();
  });

  it.each([400, 404, 409])(
    "throws ApiError with the parsed detail on a %d response",
    async (status) => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({ detail: "SOME_ERROR_CODE" }, status),
      );

      await expect(apiFetch("/accounts")).rejects.toMatchObject({
        status,
        detail: "SOME_ERROR_CODE",
      });
      await expect(apiFetch("/accounts")).rejects.toBeInstanceOf(ApiError);
    },
  );

  it("throws UnauthorizedError (an ApiError subclass) on a 401 response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ detail: "NOT_AUTHENTICATED" }, 401),
    );

    await expect(apiFetch("/accounts")).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(apiFetch("/accounts")).rejects.toBeInstanceOf(ApiError);
  });

  it("notifies the registered onUnauthorized handler on a 401", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ detail: "NOT_AUTHENTICATED" }, 401),
    );
    const handler = vi.fn();
    setOnUnauthorized(handler);

    await expect(apiFetch("/accounts")).rejects.toBeInstanceOf(UnauthorizedError);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.any(UnauthorizedError));
  });

  it("replays the original request once when onUnauthorized resolves true", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ detail: "NOT_AUTHENTICATED" }, 401))
      .mockResolvedValueOnce(jsonResponse({ id: "abc" }));
    setOnUnauthorized(vi.fn().mockResolvedValue(true));

    const result = await apiFetch<{ id: string }>("/accounts/abc");

    expect(result).toEqual({ id: "abc" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry (and does not re-notify) when the replayed request also 401s", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ detail: "NOT_AUTHENTICATED" }, 401));
    const handler = vi.fn().mockResolvedValue(true);
    setOnUnauthorized(handler);

    await expect(apiFetch("/accounts/abc")).rejects.toBeInstanceOf(UnauthorizedError);

    // One notification for the original 401; the replay's own 401 is thrown
    // straight through rather than triggering a second refresh attempt.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws the original 401 without retrying when onUnauthorized resolves false", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ detail: "NOT_AUTHENTICATED" }, 401));
    setOnUnauthorized(vi.fn().mockResolvedValue(false));

    await expect(apiFetch("/accounts/abc")).rejects.toBeInstanceOf(UnauthorizedError);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("skips the onUnauthorized handler entirely when opts.skipAuthRetry is set", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ detail: "INVALID_REFRESH_TOKEN" }, 401));
    const handler = vi.fn().mockResolvedValue(true);
    setOnUnauthorized(handler);

    await expect(
      apiFetch("/auth/refresh", { method: "POST", skipAuthRetry: true }),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    expect(handler).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("JSON-encodes opts.json and sets Content-Type: application/json", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }));

    await apiFetch("/accounts", { method: "POST", json: { name: "Savings" } });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ name: "Savings" }));
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("sends the bearer token from the registered auth token getter", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }));
    setAuthTokenGetter(() => "test-token-123");

    await apiFetch("/accounts");

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-token-123");
  });

  it("parses a Pydantic-shaped 422 array detail into VALIDATION_ERROR + fieldErrors", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        {
          detail: [
            { loc: ["body", "preferences", "base_currency"], msg: "String should match pattern" },
          ],
        },
        422,
      ),
    );

    await expect(apiFetch("/setup/initialize")).rejects.toMatchObject({
      status: 422,
      detail: "VALIDATION_ERROR",
      fieldErrors: [
        { loc: ["body", "preferences", "base_currency"], msg: "String should match pattern" },
      ],
    });
  });

  it("leaves fieldErrors undefined for the ordinary string-detail error shape", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ detail: "SOME_ERROR_CODE" }, 422));

    await expect(apiFetch("/accounts")).rejects.toMatchObject({
      status: 422,
      detail: "SOME_ERROR_CODE",
      fieldErrors: undefined,
    });
  });

  it("omits the Authorization header when no token getter is registered", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }));

    await apiFetch("/accounts");

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has("Authorization")).toBe(false);
  });
});
