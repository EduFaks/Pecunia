import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import ContactDetail from "./ContactDetail";
import type { ContactOut, ContactOverview } from "./useContacts";
import type { CategoryOut } from "../categories/useCategories";
import type { LoanOut } from "../loans/useLoans";
import type { ScheduledTransactionOut } from "../planned/usePlanned";
import type { SubscriptionOut } from "../subscriptions/useSubscriptions";
import type { TransactionOut } from "../transactions/useTransactions";

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

const CONTACT: ContactOut = {
  id: "c1",
  name: "Acme Corp",
  default_category_id: "cat-groceries",
  type: "company",
  avatar: "data:image/png;base64,AAAA",
  archived_at: null,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
};

const GROCERIES: CategoryOut = {
  id: "cat-groceries",
  name: "Groceries",
  kind: "expense",
  color: "#22d3ee",
  icon: "shopping-bag",
  archived_at: null,
  is_demo: false,
};

const OVERVIEW: ContactOverview = {
  USD: {
    money_in_minor: 500000,
    money_out_minor: 320000,
    net_minor: 180000,
    transaction_count: 12,
    by_category: [
      { category_id: "cat-groceries", name: "Groceries", color: "#22d3ee", in_minor: 0, out_minor: 220000 },
      { category_id: null, name: "Uncategorized", color: null, in_minor: 0, out_minor: 100000 },
      { category_id: "cat-salary", name: "Salary", color: "#a78bfa", in_minor: 500000, out_minor: 0 },
    ],
  },
};

const TRANSACTION: TransactionOut = {
  id: "t1",
  account_id: "a1",
  category_id: "cat-groceries",
  contact_id: "c1",
  project_id: null,
  transfer_id: null,
  amount_minor: -8499,
  currency: "USD",
  description: "Weekly shop",
  occurred_on: "2026-09-10",
  is_demo: false,
  deleted_at: null,
  created_at: "2026-09-10T00:00:00Z",
  updated_at: "2026-09-10T00:00:00Z",
};

const PLANNED_ITEM: ScheduledTransactionOut = {
  id: "s1",
  account_id: "a1",
  category_id: null,
  contact_id: "c1",
  amount_minor: -120000, // $1,200.00 out
  currency: "USD",
  description: "Monthly rent",
  frequency: "monthly",
  interval_count: 1,
  next_due: "2026-10-01",
  end_date: null,
  is_active: true,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const SUBSCRIPTION: SubscriptionOut = {
  id: "sub1",
  name: "Streamly",
  logo: null,
  amount_minor: 1500,
  currency: "USD",
  billing_frequency: "monthly",
  next_renewal: "2026-09-20",
  started_on: null,
  status: "active",
  contact_id: "c1",
  account_id: null,
  category_id: null,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  monthly_minor: 1500, // $15.00 / mo
  annual_minor: 18000,
};

const CAR_LOAN: LoanOut = {
  id: "l1",
  name: "Car loan",
  direction: "borrowed",
  principal_minor: 2_500_000,
  currency: "USD",
  interest_rate_bps: null,
  planned_payment_minor: null,
  payment_frequency: null,
  next_due: null,
  opened_on: null,
  description: null,
  contact_id: "c1",
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  paid_total_minor: 500_000,
  remaining_minor: 2_000_000, // $20,000.00
};

interface Overrides {
  contact?: ContactOut;
  overview?: ContactOverview;
  transactions?: TransactionOut[];
  planned?: ScheduledTransactionOut[];
  subscriptions?: SubscriptionOut[];
  loans?: LoanOut[];
}

function installFakeBackend(overrides: Overrides = {}) {
  mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string }) => {
    const method = opts?.method ?? "GET";
    if (path === "/auth/me") {
      return Promise.resolve({ user: null, preferences: PREFERENCES });
    }
    if (path === "/contacts/c1" && method === "GET") {
      return Promise.resolve(overrides.contact ?? CONTACT);
    }
    if (path.startsWith("/contacts/c1/overview")) {
      return Promise.resolve(overrides.overview ?? OVERVIEW);
    }
    if (path.startsWith("/categories?")) {
      return Promise.resolve({ items: [GROCERIES], next_cursor: null });
    }
    if (path.startsWith("/transactions?")) {
      return Promise.resolve({ items: overrides.transactions ?? [TRANSACTION], next_cursor: null });
    }
    if (path.startsWith("/planned?")) {
      return Promise.resolve({ items: overrides.planned ?? [], next_cursor: null });
    }
    if (path.startsWith("/subscriptions?")) {
      return Promise.resolve({ items: overrides.subscriptions ?? [], next_cursor: null });
    }
    if (path.startsWith("/loans?")) {
      return Promise.resolve({ items: overrides.loans ?? [], next_cursor: null });
    }
    return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
  });
}

function renderDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter
          initialEntries={["/contacts/c1"]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <Routes>
            <Route path="/contacts/:id" element={<ContactDetail />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** Pulls the `from` query param out of every recorded overview call — how the
 * period-selector test proves the window moved. */
function overviewFroms(): string[] {
  return mockApiFetch.mock.calls
    .map(([path]) => path as string)
    .filter((path) => path.startsWith("/contacts/c1/overview"))
    .map((path) => new URL(path, "http://x").searchParams.get("from") ?? "");
}

describe("ContactDetail", () => {
  beforeEach(() => {
    installFakeBackend();
  });

  it("shows the contact header — avatar, name, and type", async () => {
    renderDetail();

    expect(await screen.findByRole("heading", { name: "Acme Corp" })).toBeInTheDocument();
    expect(screen.getByText("Company")).toBeInTheDocument();
    // the uploaded avatar image
    await waitFor(() =>
      expect(document.querySelector('img[src="data:image/png;base64,AAAA"]')).toBeInTheDocument(),
    );
  });

  it("shows money in / out / net and the transaction count over the period", async () => {
    renderDetail();

    const inFig = (await screen.findByText("Money in")).closest("div")!;
    expect(within(inFig).getByText(/5,000\.00/)).toBeInTheDocument();
    const outFig = screen.getByText("Money out").closest("div")!;
    expect(within(outFig).getByText(/3,200\.00/)).toBeInTheDocument();
    const netFig = screen.getByText("Net").closest("div")!;
    expect(within(netFig).getByText(/1,800\.00/)).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("renders the by-category breakdown (spend shown)", async () => {
    renderDetail();

    const list = await screen.findByRole("list", { name: /spending by category/i });
    expect(within(list).getByText("Groceries")).toBeInTheDocument();
    expect(within(list).getByText(/2,200\.00/)).toBeInTheDocument();
    expect(within(list).getByText("Uncategorized")).toBeInTheDocument();
  });

  it("lists recent transactions with this contact", async () => {
    renderDetail();

    expect(await screen.findByText("Weekly shop")).toBeInTheDocument();
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining("contact_id=c1")),
    );
  });

  it("narrows the queried window when the period selector switches to 3 months", async () => {
    renderDetail();

    await screen.findByRole("heading", { name: "Acme Corp" });
    const initialFrom = overviewFroms().at(-1) ?? "";
    expect(initialFrom).not.toBe("");

    fireEvent.click(screen.getByRole("button", { name: "3 months" }));

    await waitFor(() => {
      const froms = overviewFroms();
      expect(froms.length).toBeGreaterThan(1);
      expect(froms.at(-1)! > initialFrom).toBe(true);
    });
  });

  it("shows this contact's planned, subscriptions, and loans — each fetched by contact_id", async () => {
    installFakeBackend({ planned: [PLANNED_ITEM], subscriptions: [SUBSCRIPTION], loans: [CAR_LOAN] });
    renderDetail();

    // Planned: description, amount, next-due date, frequency.
    const planned = (await screen.findByRole("heading", { name: "Planned" })).closest("section")!;
    expect(within(planned).getByText("Monthly rent")).toBeInTheDocument();
    expect(within(planned).getByText(/1,200\.00/)).toBeInTheDocument();
    // frequency + next-due caption ("Monthly · Next <date>")
    expect(within(planned).getByText(/monthly · next/i)).toBeInTheDocument();
    expect(within(planned).getByText(/10\/01\/2026/)).toBeInTheDocument();

    // Subscriptions: name, monthly cost, renewal date.
    const subs = screen.getByRole("heading", { name: "Subscriptions" }).closest("section")!;
    expect(within(subs).getByText("Streamly")).toBeInTheDocument();
    expect(within(subs).getByText(/15\.00/)).toBeInTheDocument();
    expect(within(subs).getByText(/renews/i)).toBeInTheDocument();
    expect(within(subs).getByText(/09\/20\/2026/)).toBeInTheDocument();

    // Loans: name, remaining, direction.
    const loans = screen.getByRole("heading", { name: "Loans" }).closest("section")!;
    expect(within(loans).getByText("Car loan")).toBeInTheDocument();
    expect(within(loans).getByText(/20,000\.00/)).toBeInTheDocument();
    expect(within(loans).getByText("Borrowed")).toBeInTheDocument();

    // Every section reads its list filtered to this contact.
    const paths = mockApiFetch.mock.calls.map(([path]) => path as string);
    expect(paths.some((p) => p.startsWith("/planned?") && p.includes("contact_id=c1"))).toBe(true);
    expect(paths.some((p) => p.startsWith("/subscriptions?") && p.includes("contact_id=c1"))).toBe(
      true,
    );
    expect(paths.some((p) => p.startsWith("/loans?") && p.includes("contact_id=c1"))).toBe(true);
  });

  it("hides the planned/subscriptions/loans sections entirely when each comes back empty", async () => {
    installFakeBackend(); // planned/subscriptions/loans all default to []
    renderDetail();

    await screen.findByRole("heading", { name: "Acme Corp" });
    // Wait until the section reads actually resolved before asserting absence.
    await waitFor(() => {
      const paths = mockApiFetch.mock.calls.map(([path]) => path as string);
      expect(paths.some((p) => p.startsWith("/loans?"))).toBe(true);
    });

    expect(screen.queryByRole("heading", { name: "Planned" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Subscriptions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Loans" })).not.toBeInTheDocument();
  });

  it("holds an empty state when the contact has no activity in the period", async () => {
    installFakeBackend({ overview: {}, transactions: [] });
    renderDetail();

    await screen.findByRole("heading", { name: "Acme Corp" });
    expect(await screen.findByText(/no activity with this contact/i)).toBeInTheDocument();
  });
});
