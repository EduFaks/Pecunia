import { describe, expect, it, vi } from "vitest";
import { apiFetch } from "../../lib/api";
import { createAccount, initialize, seedDemo } from "./setupApi";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockApiFetch = vi.mocked(apiFetch);

const PAYLOAD = {
  owner: { name: "Ada Lovelace", email: "ada@example.com", password: "N7k$pQ2wZr9vLmX4tY8u" },
  preferences: {
    base_currency: "USD",
    locale: "en-US",
    date_format: "MM/DD/YYYY",
    number_format: "1,234.56",
    timezone: "America/New_York",
    first_day_of_week: "sunday" as const,
  },
};

describe("setupApi.initialize", () => {
  it("POSTs /setup/initialize with the payload plus client: web, and returns the response", async () => {
    const response = {
      access_token: "tok",
      token_type: "bearer",
      expires_in: 900,
      refresh_token: null,
      user: { id: "u1", email: "ada@example.com", name: "Ada Lovelace", display_name: null },
    };
    mockApiFetch.mockResolvedValue(response);

    const result = await initialize(PAYLOAD);

    expect(result).toEqual(response);
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/setup/initialize",
      expect.objectContaining({
        method: "POST",
        json: { ...PAYLOAD, client: "web" },
      }),
    );
  });

  it("propagates a rejected apiFetch call unchanged", async () => {
    const error = new Error("boom");
    mockApiFetch.mockRejectedValue(error);

    await expect(initialize(PAYLOAD)).rejects.toBe(error);
  });
});

describe("setupApi.createAccount", () => {
  it("POSTs /accounts with the payload and returns the created account", async () => {
    const response = { id: "acc-1", name: "Everyday checking", type: "checking", currency: "EUR" };
    mockApiFetch.mockResolvedValue(response);

    const payload = { name: "Everyday checking", type: "checking" as const, currency: "EUR" };
    const result = await createAccount(payload);

    expect(result).toEqual(response);
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/accounts",
      expect.objectContaining({ method: "POST", json: payload }),
    );
  });

  it("propagates a rejected apiFetch call unchanged", async () => {
    const error = new Error("boom");
    mockApiFetch.mockRejectedValue(error);

    await expect(
      createAccount({ name: "x", type: "checking", currency: "USD" }),
    ).rejects.toBe(error);
  });
});

describe("setupApi.seedDemo", () => {
  it("POSTs /demo with no body and returns the demo status", async () => {
    const response = { present: true, counts: { accounts: 3 } };
    mockApiFetch.mockResolvedValue(response);

    const result = await seedDemo();

    expect(result).toEqual(response);
    expect(mockApiFetch).toHaveBeenCalledWith("/demo", expect.objectContaining({ method: "POST" }));
  });

  it("propagates a rejected apiFetch call unchanged (e.g. 409 DEMO_ALREADY_PRESENT)", async () => {
    const error = new Error("boom");
    mockApiFetch.mockRejectedValue(error);

    await expect(seedDemo()).rejects.toBe(error);
  });
});
