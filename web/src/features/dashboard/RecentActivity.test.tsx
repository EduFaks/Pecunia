import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
import RecentActivity from "./RecentActivity";
import type { ActivityEntry } from "../../lib/activity";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(qk.me, {
    user: null,
    preferences: {
      base_currency: "USD",
      locale: "en-US",
      date_format: "MM/DD/YYYY",
      number_format: "1,234.56",
      timezone: "UTC",
      first_day_of_week: "monday",
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        {ui}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 1,
    occurred_at: "2026-09-10T12:00:00.000Z",
    template_key: "activity.account.created",
    params: { name: "Checking", type: "checking" },
    ...overrides,
  };
}

describe("RecentActivity", () => {
  beforeEach(() => {
    mockApiFetch.mockReset().mockResolvedValue({ user: null, preferences: null });
  });

  it("renders each entry as a template-keyed sentence", () => {
    const entries = [
      entry({ id: 1, template_key: "activity.account.created", params: { name: "Checking", type: "checking" } }),
      entry({
        id: 2,
        template_key: "activity.budget.created",
        params: { name: "Groceries", amount_minor: 40000, currency: "USD" },
      }),
    ];

    renderWithProviders(<RecentActivity entries={entries} />);

    expect(screen.getByText('Account "Checking" created (checking).')).toBeInTheDocument();
    expect(screen.getByText(/Budget "Groceries" created/)).toBeInTheDocument();
  });

  it("links to the full activity screen", () => {
    renderWithProviders(<RecentActivity entries={[entry()]} />);

    expect(screen.getByRole("link", { name: /view all/i })).toHaveAttribute("href", "/activity");
  });

  it("shows a calm empty message when there is no activity yet", () => {
    renderWithProviders(<RecentActivity entries={[]} />);

    expect(screen.getByText(/no activity yet/i)).toBeInTheDocument();
  });
});
