import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import AccountDetail from "./AccountDetail";
import type { AccountOut } from "./useAccounts";
import type { TransactionOut } from "../transactions/useTransactions";
import type { TransferOut } from "../transfers/useTransfers";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const ACCOUNT: AccountOut = {
  id: "a1",
  name: "Everyday checking",
  type: "checking",
  currency: "USD",
  initial_balance_minor: 0,
  balance_minor: 150000,
  is_demo: false,
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const TRANSACTION: TransactionOut = {
  id: "t1",
  account_id: "a1",
  category_id: null,
  contact_id: null,
  project_id: null,
  transfer_id: null,
  amount_minor: -8499,
  currency: "USD",
  description: "Groceries",
  occurred_on: "2026-09-10",
  is_demo: false,
  deleted_at: null,
  created_at: "2026-09-10T00:00:00Z",
  updated_at: "2026-09-10T00:00:00Z",
};

function installFakeBackend(
  options: {
    account?: AccountOut;
    transactions?: TransactionOut[];
    accounts?: AccountOut[];
    transfers?: TransferOut[];
  } = {},
) {
  let balance = options.account?.balance_minor ?? ACCOUNT.balance_minor;
  const transactions = [...(options.transactions ?? [])];

  mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
    const method = opts?.method ?? "GET";

    if (path === "/accounts/a1" && method === "GET") {
      return Promise.resolve({ ...(options.account ?? ACCOUNT), balance_minor: balance });
    }
    if (path.startsWith("/accounts?") && method === "GET") {
      return Promise.resolve({ items: options.accounts ?? [options.account ?? ACCOUNT], next_cursor: null });
    }
    if (path.startsWith("/transfers?") && method === "GET") {
      return Promise.resolve({ items: options.transfers ?? [], next_cursor: null });
    }
    if (path.startsWith("/categories?") && method === "GET") {
      return Promise.resolve({ items: [], next_cursor: null });
    }
    if (path.startsWith("/contacts?") && method === "GET") {
      return Promise.resolve({ items: [], next_cursor: null });
    }
    if (path.startsWith("/projects?") && method === "GET") {
      return Promise.resolve({ items: [], next_cursor: null });
    }
    if (path.startsWith("/transactions?") && method === "GET") {
      return Promise.resolve({ items: transactions, next_cursor: null });
    }
    if (path === "/transactions" && method === "POST") {
      const body = opts?.json as TransactionOut;
      const created: TransactionOut = { ...TRANSACTION, ...body, id: "t-new" };
      transactions.unshift(created);
      balance += created.amount_minor;
      return Promise.resolve(created);
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
          initialEntries={["/accounts/a1"]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <Routes>
            <Route path="/accounts/:id" element={<AccountDetail />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("AccountDetail", () => {
  beforeEach(() => {
    installFakeBackend();
  });

  it("shows the account's header (name, type, balance)", async () => {
    renderDetail();

    expect(await screen.findByRole("heading", { name: "Everyday checking" })).toBeInTheDocument();
    expect(screen.getByText("Checking")).toBeInTheDocument();
    expect(screen.getByText(/1,500\.00/)).toBeInTheDocument();
  });

  it("lists the account's transactions", async () => {
    installFakeBackend({ transactions: [TRANSACTION] });
    renderDetail();

    expect(await screen.findByText("Groceries")).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining("account_id=a1"));
  });

  it("shows a guiding empty state when the account has no transactions yet", async () => {
    renderDetail();
    expect(await screen.findByText(/no transactions yet/i)).toBeInTheDocument();
  });

  it("adding a transaction refreshes the list and the header balance", async () => {
    renderDetail();
    await screen.findByRole("heading", { name: "Everyday checking" });

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Coffee" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-11" } });
    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));

    expect(await screen.findByText("Coffee")).toBeInTheDocument();
    // Outflow of $20 against a $1,500 balance -> $1,480.00.
    await waitFor(() => expect(screen.getByText(/1,480\.00/)).toBeInTheDocument());
  });

  it("labels a transfer leg by its counterpart account instead of a category", async () => {
    const savings: AccountOut = { ...ACCOUNT, id: "a2", name: "Rainy day" };
    const transfer: TransferOut = {
      id: "tr1",
      from_account_id: "a1",
      to_account_id: "a2",
      amount_minor: 5000,
      currency: "USD",
      description: "Move to savings",
      occurred_on: "2026-09-11",
      is_demo: false,
      created_at: "2026-09-11T00:00:00Z",
    };
    const leg: TransactionOut = {
      ...TRANSACTION,
      id: "leg-out",
      transfer_id: "tr1",
      amount_minor: -5000,
      description: "Move to savings",
    };
    installFakeBackend({
      transactions: [leg],
      accounts: [ACCOUNT, savings],
      transfers: [transfer],
    });
    renderDetail();

    const label = await screen.findByText("Transfer to Rainy day");
    const row = label.closest("li")!;
    // The leg's row is labeled by the transfer, not a category badge (the
    // "Uncategorized" text elsewhere on the page belongs to the always-present
    // Add-transaction form's category picker, so scope the check to the row).
    expect(within(row).queryByText("Uncategorized")).not.toBeInTheDocument();
  });
});
