import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import GoalForm from "./GoalForm";
import type { GoalOut } from "./useGoals";
import type { AccountOut } from "../accounts/useAccounts";
import type { PortfolioOut } from "../portfolio/usePortfolios";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const CREATED: GoalOut = {
  id: "g-new",
  name: "Emergency fund",
  target_minor: 500_000,
  currency: "USD",
  target_date: null,
  source_kind: "manual",
  source_id: null,
  manual_current_minor: null,
  created_at: "2026-09-13T00:00:00Z",
  progress: { current_minor: 0, target_minor: 500_000, pct_bps: 0 },
  eta: { reached_on: null, on_track: false },
};

const CHECKING: AccountOut = {
  id: "a-checking",
  name: "Checking",
  type: "checking",
  currency: "USD",
  initial_balance_minor: 0,
  balance_minor: 80_000,
  is_demo: false,
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const BROKERAGE: PortfolioOut = {
  id: "p-brokerage",
  name: "Brokerage",
  currency: "EUR",
  description: null,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  value_minor: 10_000,
  holding_count: 1,
};

function installBackend(result: GoalOut = CREATED) {
  mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string }) => {
    const method = opts?.method ?? "GET";
    if (path.startsWith("/accounts?")) {
      return Promise.resolve({ items: [CHECKING], next_cursor: null });
    }
    if (path.startsWith("/portfolios?")) {
      return Promise.resolve({ items: [BROKERAGE], next_cursor: null });
    }
    if ((path === "/goals" && method === "POST") || (path.startsWith("/goals/") && method === "PATCH")) {
      return Promise.resolve(result);
    }
    return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
  });
}

function renderForm(props: Partial<ComponentProps<typeof GoalForm>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <GoalForm onSuccess={props.onSuccess ?? (() => {})} {...props} />
    </QueryClientProvider>,
  );
}

describe("GoalForm", () => {
  beforeEach(() => {
    installBackend();
  });

  it("shows the manual current-amount field by default (manual source)", () => {
    renderForm({ defaultCurrency: "USD" });

    expect(screen.getByLabelText("Current amount")).toBeInTheDocument();
    expect(screen.getByLabelText("Currency")).toBeInTheDocument();
  });

  it("hides the manual amount field and shows an account picker when switching to account", async () => {
    renderForm({ defaultCurrency: "USD" });

    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "account" } });

    expect(screen.queryByLabelText("Current amount")).not.toBeInTheDocument();
    expect(await screen.findByLabelText("Account")).toBeInTheDocument();
    // Currency is locked to the source, not a free-choice Select anymore.
    expect(screen.queryByLabelText("Currency")).not.toBeInTheDocument();
  });

  it("hides the manual amount field and shows a portfolio picker when switching to portfolio", async () => {
    renderForm({ defaultCurrency: "USD" });

    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "portfolio" } });

    expect(screen.queryByLabelText("Current amount")).not.toBeInTheDocument();
    expect(await screen.findByLabelText("Portfolio")).toBeInTheDocument();
    expect(screen.queryByLabelText("Currency")).not.toBeInTheDocument();
  });

  it("hides the manual amount field but keeps a free currency choice for net worth", () => {
    renderForm({ defaultCurrency: "USD" });

    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "net_worth" } });

    expect(screen.queryByLabelText("Current amount")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Currency")).toBeInTheDocument();
  });

  it("creates a manual goal with the typed target and current amount", async () => {
    const onSuccess = vi.fn();
    renderForm({ onSuccess, defaultCurrency: "USD" });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Emergency fund" } });
    fireEvent.change(screen.getByLabelText("Target amount"), { target: { value: "5000" } });
    fireEvent.change(screen.getByLabelText("Current amount"), { target: { value: "1250" } });

    fireEvent.click(screen.getByRole("button", { name: /create goal/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/goals", {
        method: "POST",
        json: {
          name: "Emergency fund",
          target_minor: 500_000,
          currency: "USD",
          source_kind: "manual",
          manual_current_minor: 125_000,
        },
      }),
    );
    expect(onSuccess).toHaveBeenCalled();
  });

  it("submits the picked account's id and its own currency on create", async () => {
    renderForm({ defaultCurrency: "USD" });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Down payment" } });
    fireEvent.change(screen.getByLabelText("Target amount"), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "account" } });
    await screen.findByRole("option", { name: /checking/i });
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "a-checking" } });

    fireEvent.click(screen.getByRole("button", { name: /create goal/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/goals", {
        method: "POST",
        json: {
          name: "Down payment",
          target_minor: 100_000,
          currency: "USD",
          source_kind: "account",
          source_id: "a-checking",
        },
      }),
    );
  });

  it("submits the picked portfolio's id and its own currency on create", async () => {
    renderForm({ defaultCurrency: "USD" });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Retirement" } });
    fireEvent.change(screen.getByLabelText("Target amount"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "portfolio" } });
    await screen.findByRole("option", { name: /brokerage/i });
    fireEvent.change(screen.getByLabelText("Portfolio"), { target: { value: "p-brokerage" } });

    fireEvent.click(screen.getByRole("button", { name: /create goal/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/goals", {
        method: "POST",
        json: {
          name: "Retirement",
          target_minor: 10_000, // EUR, the portfolio's own currency
          currency: "EUR",
          source_kind: "portfolio",
          source_id: "p-brokerage",
        },
      }),
    );
  });

  it("prefills from an existing goal in edit mode", () => {
    const goal: GoalOut = { ...CREATED, name: "Vacation", manual_current_minor: 25_000 };
    renderForm({ goal });

    expect(screen.getByLabelText("Name")).toHaveValue("Vacation");
    expect(screen.getByLabelText("Target amount")).toHaveValue("5000.00");
    expect(screen.getByLabelText("Current amount")).toHaveValue("250.00");
  });

  it("shows a friendly message on a currency mismatch", async () => {
    const { ApiError } = await import("../../lib/api");
    mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string }) => {
      const method = opts?.method ?? "GET";
      if (path.startsWith("/accounts?")) {
        return Promise.resolve({ items: [CHECKING], next_cursor: null });
      }
      if (path.startsWith("/portfolios?")) {
        return Promise.resolve({ items: [], next_cursor: null });
      }
      if (path === "/goals" && method === "POST") {
        return Promise.reject(new ApiError(422, "GOAL_CURRENCY_MISMATCH"));
      }
      return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
    });

    renderForm({ defaultCurrency: "USD" });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText("Target amount"), { target: { value: "10" } });

    fireEvent.click(screen.getByRole("button", { name: /create goal/i }));

    expect(
      await screen.findByText("This goal's currency must match its source's own currency."),
    ).toBeInTheDocument();
  });
});
