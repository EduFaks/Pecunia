import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
import ActivityScreen from "./ActivityScreen";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const PREFERENCES = {
  base_currency: "USD",
  locale: "en-US",
  date_format: "MM/DD/YYYY",
  number_format: "1,234.56",
  timezone: "UTC",
  first_day_of_week: "monday",
};

function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(qk.me, { user: null, preferences: PREFERENCES });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * `usePreferences` fires its own `/auth/me` background refetch on mount
 * (default `staleTime: 0` treats the seeded `qk.me` cache entry as stale) —
 * this routes `apiFetch` by path so that refetch and the `/activity` calls
 * under test can both resolve, rather than a `mockResolvedValueOnce` chain
 * where call order between the two queries isn't guaranteed.
 */
function installFakeBackend(page1: unknown, page2: unknown = { items: [], next_cursor: null }) {
  mockApiFetch.mockReset().mockImplementation((path: unknown) => {
    const p = String(path);
    if (p.startsWith("/auth/me")) {
      return Promise.resolve({ user: null, preferences: PREFERENCES });
    }
    if (p.includes("cursor=cursor-1")) {
      return Promise.resolve(page2);
    }
    if (p.startsWith("/activity")) {
      return Promise.resolve(page1);
    }
    return Promise.reject(new Error(`Unexpected apiFetch call: ${p}`));
  });
}

const PAGE_1 = {
  items: [
    {
      id: 1,
      occurred_at: new Date().toISOString(),
      template_key: "activity.account.created",
      params: { name: "Checking", type: "checking" },
    },
    {
      id: 2,
      occurred_at: new Date().toISOString(),
      template_key: "activity.budget.created",
      params: { name: "Groceries", amount_minor: 40000, currency: "USD" },
    },
  ],
  next_cursor: "cursor-1",
};

const PAGE_2 = {
  items: [
    {
      id: 3,
      occurred_at: new Date().toISOString(),
      template_key: "activity.transaction.created",
      params: { description: "Coffee", amount_minor: -450, currency: "USD" },
    },
  ],
  next_cursor: null,
};

describe("ActivityScreen", () => {
  it("fetches /activity and renders entries grouped under a 'Today' heading", async () => {
    installFakeBackend(PAGE_1);

    renderWithProviders(<ActivityScreen />);

    expect(await screen.findByText("Today")).toBeInTheDocument();
    expect(screen.getByText(/Account "Checking" created/)).toBeInTheDocument();
    expect(screen.getByText(/Budget "Groceries" created/)).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledWith(expect.stringMatching(/^\/activity\?/));
  });

  it("loads the next page via the keyset cursor on 'Load more'", async () => {
    installFakeBackend(PAGE_1, PAGE_2);

    renderWithProviders(<ActivityScreen />);

    const loadMore = await screen.findByRole("button", { name: "Load more" });
    fireEvent.click(loadMore);

    expect(await screen.findByText(/Coffee/)).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledWith(expect.stringMatching(/cursor=cursor-1/));
  });

  it("shows a calm empty state when there is no activity yet", async () => {
    installFakeBackend({ items: [], next_cursor: null });

    renderWithProviders(<ActivityScreen />);

    expect(await screen.findByText(/no activity yet/i)).toBeInTheDocument();
  });
});
