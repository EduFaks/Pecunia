import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import { qk } from "../../lib/queries";
import SubscriptionsScreen from "./SubscriptionsScreen";
import type { SubscriptionOut, SubscriptionTotals } from "./useSubscriptions";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

let subscriptions: SubscriptionOut[];
let totals: SubscriptionTotals;

function seed(subs: SubscriptionOut[], subsTotals: SubscriptionTotals = {}) {
  subscriptions = subs.map((s) => ({ ...s }));
  totals = subsTotals;
}

function installBackend() {
  mockApiFetch
    .mockReset()
    .mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
      const method = opts?.method ?? "GET";

      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: null });
      }
      if (path.startsWith("/contacts?") || path.startsWith("/categories?") || path.startsWith("/accounts?")) {
        return Promise.resolve({ items: [], next_cursor: null });
      }
      if (path.startsWith("/subscriptions/totals")) {
        return Promise.resolve(totals);
      }
      if (path.endsWith("/renew") && method === "POST") {
        const id = path.split("/")[2];
        const sub = subscriptions.find((s) => s.id === id)!;
        sub.next_renewal = "2026-11-01";
        return Promise.resolve(sub);
      }
      if (path.startsWith("/subscriptions?") && method === "GET") {
        return Promise.resolve({ items: subscriptions, next_cursor: null });
      }
      if (path.startsWith("/subscriptions/") && method === "PATCH") {
        const id = path.split("/")[2];
        const sub = subscriptions.find((s) => s.id === id)!;
        Object.assign(sub, opts?.json as Partial<SubscriptionOut>);
        return Promise.resolve(sub);
      }
      if (path.startsWith("/subscriptions/") && method === "DELETE") {
        const id = path.split("/")[2];
        subscriptions = subscriptions.filter((s) => s.id !== id);
        return Promise.resolve(undefined);
      }
      return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
    });
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
      <ToastProvider>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <SubscriptionsScreen />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const NETFLIX: SubscriptionOut = {
  id: "s-netflix",
  name: "Netflix",
  logo: null,
  amount_minor: 1599,
  currency: "USD",
  billing_frequency: "monthly",
  next_renewal: "2026-10-01",
  started_on: "2025-01-01",
  status: "active",
  contact_id: null,
  account_id: null,
  category_id: null,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  monthly_minor: 1599,
  annual_minor: 19188,
};

const SPOTIFY: SubscriptionOut = {
  id: "s-spotify",
  name: "Spotify",
  logo: "data:image/png;base64,AAAA",
  amount_minor: 12000,
  currency: "USD",
  billing_frequency: "yearly",
  next_renewal: "2026-12-15",
  started_on: null,
  status: "active",
  contact_id: null,
  account_id: null,
  category_id: null,
  is_demo: false,
  created_at: "2026-02-01T00:00:00Z",
  monthly_minor: 1000,
  annual_minor: 12000,
};

const OLD_GYM: SubscriptionOut = {
  id: "s-gym",
  name: "Old Gym",
  logo: null,
  amount_minor: 5000,
  currency: "USD",
  billing_frequency: "monthly",
  next_renewal: "2026-09-20",
  started_on: null,
  status: "canceled",
  contact_id: null,
  account_id: null,
  category_id: null,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  monthly_minor: 5000,
  annual_minor: 60000,
};

describe("SubscriptionsScreen", () => {
  beforeEach(() => {
    seed([]);
    installBackend();
  });

  it("shows a guiding empty state on a fresh workspace", async () => {
    renderScreen();
    expect(await screen.findByText(/no subscriptions yet/i)).toBeInTheDocument();
  });

  it("renders the monthly + annual totals header and lists each subscription", async () => {
    seed([NETFLIX, SPOTIFY], { USD: { monthly_minor: 2599, annual_minor: 31188, count: 2 } });
    renderScreen();

    // Totals header (base currency): monthly $25.99, annualized $311.88.
    expect(await screen.findByText("$25.99")).toBeInTheDocument();
    expect(screen.getByText("$311.88")).toBeInTheDocument();

    // Netflix row: monogram fallback (no logo), normalized monthly cost, the
    // billing cycle, and the next-renewal date.
    expect(screen.getByText("Netflix")).toBeInTheDocument();
    expect(screen.getByText("NE")).toBeInTheDocument(); // Avatar monogram fallback
    expect(screen.getByText("$15.99")).toBeInTheDocument();
    expect(screen.getAllByText(/monthly/i).length).toBeGreaterThan(0);
    expect(screen.getByText("10/01/2026")).toBeInTheDocument();

    // Spotify row: normalized to a per-month figure, a real logo image.
    expect(screen.getByText("Spotify")).toBeInTheDocument();
    expect(screen.getByText("$10.00")).toBeInTheDocument();
    expect(document.querySelector('img[src="data:image/png;base64,AAAA"]')).toBeInTheDocument();
  });

  it("keeps a second currency's monthly/annual totals as their own separate entries", async () => {
    seed(
      [NETFLIX],
      {
        USD: { monthly_minor: 1599, annual_minor: 19188, count: 1 },
        EUR: { monthly_minor: 500, annual_minor: 6000, count: 1 },
      },
    );
    renderScreen();

    await screen.findByText("Netflix");

    const monthlyBlock = screen.getByText("Monthly spend").parentElement!;
    expect(within(monthlyBlock).getByText("$15.99")).toBeInTheDocument();
    expect(within(monthlyBlock).getByText("€5.00")).toBeInTheDocument();

    const annualBlock = screen.getByText("Annualized").parentElement!;
    expect(within(annualBlock).getByText("$191.88")).toBeInTheDocument();
    expect(within(annualBlock).getByText("€60.00")).toBeInTheDocument();
  });

  it("stacks a row and wraps its action buttons instead of squeezing four of them onto one cramped line on a narrow viewport", async () => {
    seed([NETFLIX], { USD: { monthly_minor: 1599, annual_minor: 19188, count: 1 } });
    renderScreen();

    const row = (await screen.findByText("Netflix")).closest("li")!;
    // Stacks to a column on mobile, reverting to the original side-by-side
    // row at `sm:` and up.
    expect(row.className).toMatch(/\bflex-col\b/);
    expect(row.className).toMatch(/\bsm:flex-row\b/);
    // Renew / Edit / Cancel / Delete wrap as a cluster rather than forcing
    // the row wider than the viewport.
    const deleteButton = within(row).getByRole("button", { name: /delete/i });
    expect(deleteButton.parentElement?.className).toMatch(/\bflex-wrap\b/);
  });

  it("renews a subscription by advancing its renewal date", async () => {
    seed([NETFLIX], { USD: { monthly_minor: 1599, annual_minor: 19188, count: 1 } });
    renderScreen();

    await screen.findByText("Netflix");
    fireEvent.click(screen.getByRole("button", { name: /^renew$/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/subscriptions/s-netflix/renew", {
        method: "POST",
      }),
    );
  });

  it("cancels a subscription by patching its status", async () => {
    seed([NETFLIX], { USD: { monthly_minor: 1599, annual_minor: 19188, count: 1 } });
    renderScreen();

    await screen.findByText("Netflix");
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/subscriptions/s-netflix", {
        method: "PATCH",
        json: { status: "canceled" },
      }),
    );
  });

  it("shows a canceled subscription as canceled with a reactivate action", async () => {
    seed([OLD_GYM]);
    renderScreen();

    const row = (await screen.findByText("Old Gym")).closest("li")!;
    expect(within(row).getByText(/canceled/i)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /reactivate/i })).toBeInTheDocument();
    // Renew is meaningless for a canceled subscription.
    expect(within(row).queryByRole("button", { name: /^renew$/i })).not.toBeInTheDocument();
  });
});
