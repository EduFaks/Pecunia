import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import AccountsCardsCard from "./AccountsCardsCard";

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

const ACCOUNTS = [
  {
    id: "a1",
    name: "Nubank",
    type: "credit_card",
    currency: "USD",
    balance_minor: -125_000,
    archived_at: null,
  },
  {
    id: "a2",
    name: "Everyday",
    type: "checking",
    currency: "USD",
    balance_minor: 500_000,
    archived_at: null,
  },
  {
    id: "a3",
    name: "Old Savings",
    type: "savings",
    currency: "USD",
    balance_minor: 1_000,
    archived_at: "2025-01-01",
  },
  {
    id: "a4",
    name: "No Limit Card",
    type: "credit_card",
    currency: "USD",
    balance_minor: -5_000,
    archived_at: null,
  },
];

const CONNECTIONS = [
  {
    id: "c1",
    institution_name: "Nubank",
    status: "ok",
    last_error: null,
    last_synced_at: null,
    links: [
      {
        id: "l1",
        account_id: "a1",
        account_name: "Nubank",
        account_currency: "USD",
        pluggy_account_id: "p1",
        sync_from: "2026-01-01",
        provider_balance_minor: -125_000,
        provider_balance_as_of: null,
        derived_balance_minor: -125_000,
        credit_limit_minor: 500_000,
        bill_close_date: "2026-10-10",
        bill_due_date: "2026-10-17",
      },
      {
        id: "l4",
        account_id: "a4",
        account_name: "No Limit Card",
        account_currency: "USD",
        pluggy_account_id: "p4",
        sync_from: "2026-01-01",
        provider_balance_minor: -5_000,
        provider_balance_as_of: null,
        derived_balance_minor: -5_000,
        credit_limit_minor: null,
        bill_close_date: null,
        bill_due_date: null,
      },
    ],
  },
];

function mockFixture({
  accounts = ACCOUNTS,
  connections = CONNECTIONS,
}: { accounts?: unknown; connections?: unknown } = {}) {
  mockApiFetch.mockReset().mockImplementation((path: string) => {
    if (path === "/auth/me") {
      return Promise.resolve({ user: null, preferences: PREFERENCES });
    }
    if (path.startsWith("/accounts")) {
      return Promise.resolve({ items: accounts });
    }
    if (path.startsWith("/bank-sync/connections")) {
      return Promise.resolve(connections);
    }
    return Promise.reject(new Error(`unexpected path: ${path}`));
  });
}

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AccountsCardsCard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function rowFor(name: string): HTMLElement {
  const rows = screen.getAllByRole("listitem");
  const row = rows.find((candidate) => within(candidate).queryByText(name));
  if (!row) {
    throw new Error(`no row found for ${name}`);
  }
  return row;
}

describe("AccountsCardsCard", () => {
  it("shows a used/limit bar and due date for a linked credit card", async () => {
    mockFixture();
    renderCard();

    await screen.findByText("Nubank");
    const row = rowFor("Nubank");

    expect(within(row).getByText("Open Finance")).toBeInTheDocument();

    const bar = within(row).getByRole("progressbar");
    // used 125,000 of a 500,000 limit = 25%.
    expect(bar).toHaveAttribute("aria-valuenow", "25");

    expect(within(row).getByText(/vence/i)).toBeInTheDocument();
    expect(within(row).getByText(/10\/17\/2026/)).toBeInTheDocument();

    // Balance still renders alongside the bar.
    expect(within(row).getByText(/1,250\.00/)).toBeInTheDocument();
  });

  it("renders a plain balance with no chip and no bar for an unlinked account", async () => {
    mockFixture();
    renderCard();

    await screen.findByText("Everyday");
    const row = rowFor("Everyday");

    expect(within(row).queryByText("Open Finance")).not.toBeInTheDocument();
    expect(within(row).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(within(row).getByText(/5,000\.00/)).toBeInTheDocument();
  });

  it("shows the Open Finance chip on a linked account even without a bar when the credit limit is unknown", async () => {
    mockFixture();
    renderCard();

    await screen.findByText("No Limit Card");
    const row = rowFor("No Limit Card");

    expect(within(row).getByText("Open Finance")).toBeInTheDocument();
    expect(within(row).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(within(row).queryByText(/vence/i)).not.toBeInTheDocument();
  });

  it("skips archived accounts", async () => {
    mockFixture();
    renderCard();

    await screen.findByText("Everyday");
    expect(screen.queryByText("Old Savings")).not.toBeInTheDocument();
  });

  it("shows a loading state while fetching", () => {
    mockApiFetch.mockReset().mockImplementation(() => new Promise(() => {}));

    renderCard();

    expect(screen.getByText(/carregando/i)).toBeInTheDocument();
  });

  it("shows an error state when the fetch fails", async () => {
    mockApiFetch.mockReset().mockImplementation((path: string) => {
      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: PREFERENCES });
      }
      return Promise.reject(new Error("boom"));
    });

    renderCard();

    expect(await screen.findByText(/não foi possível/i)).toBeInTheDocument();
  });

  it("shows a calm empty state with no accounts", async () => {
    mockFixture({ accounts: [] });
    renderCard();

    expect(await screen.findByText(/nenhuma conta ainda/i)).toBeInTheDocument();
  });
});
