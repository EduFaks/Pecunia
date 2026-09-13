import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import TransactionsScreen from "./TransactionsScreen";
import type { AccountOut } from "../accounts/useAccounts";
import type { CategoryOut } from "../categories/useCategories";
import type { ContactOut } from "../contacts/useContacts";
import type { LoanOut } from "../loans/useLoans";
import type { ProjectOut } from "../projects/useProjects";
import type { TransferOut } from "../transfers/useTransfers";
import type { TransactionOut } from "./useTransactions";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const CHECKING: AccountOut = {
  id: "a1",
  name: "Checking",
  type: "checking",
  currency: "USD",
  initial_balance_minor: 0,
  balance_minor: 150000,
  is_demo: false,
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const FOOD_CATEGORY: CategoryOut = {
  id: "c-food",
  name: "Food",
  kind: "expense",
  color: "#8a8578",
  icon: "shopping-bag",
  archived_at: null,
  is_demo: false,
};

const GROCERY_STORE: ContactOut = {
  id: "p-grocery",
  name: "Grocery Store",
  default_category_id: "c-food",
  type: "company",
  avatar: null,
  archived_at: null,
  is_demo: false,
  created_at: "2026-09-10T00:00:00Z",
};

const GROCERIES: TransactionOut = {
  id: "t1",
  account_id: "a1",
  category_id: "c-food",
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

const PAYCHECK: TransactionOut = {
  id: "t2",
  account_id: "a1",
  category_id: null,
  contact_id: null,
  project_id: null,
  transfer_id: null,
  amount_minor: 250000, // $2,500.00
  currency: "USD",
  description: "Paycheck",
  occurred_on: "2026-09-09",
  is_demo: false,
  deleted_at: null,
  created_at: "2026-09-09T00:00:00Z",
  updated_at: "2026-09-09T00:00:00Z",
};

const KITCHEN_PROJECT: ProjectOut = {
  id: "pr-kitchen",
  name: "Kitchen remodel",
  description: null,
  target_amount_minor: 5_000_000,
  currency: "USD",
  status: "active",
  type: "spending",
  planned_minor: 0,
  actual_minor: 0,
  is_demo: false,
  created_at: "2026-09-10T00:00:00Z",
  updated_at: "2026-09-10T00:00:00Z",
};

const SAVINGS: AccountOut = { ...CHECKING, id: "a2", name: "Savings", balance_minor: 500000 };

const MOVE_TRANSFER: TransferOut = {
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

const OUT_LEG: TransactionOut = {
  id: "leg-out",
  account_id: "a1",
  category_id: null,
  contact_id: null,
  project_id: null,
  transfer_id: "tr1",
  amount_minor: -5000,
  currency: "USD",
  description: "Move to savings",
  occurred_on: "2026-09-11",
  is_demo: false,
  deleted_at: null,
  created_at: "2026-09-11T00:00:00Z",
  updated_at: "2026-09-11T00:00:00Z",
};

const IN_LEG: TransactionOut = {
  ...OUT_LEG,
  id: "leg-in",
  account_id: "a2",
  amount_minor: 5000,
};

const CAR_LOAN: LoanOut = {
  id: "l1",
  name: "Car loan",
  direction: "borrowed",
  principal_minor: 2_500_000,
  currency: "USD",
  interest_rate_bps: 425,
  planned_payment_minor: 45_000,
  payment_frequency: "monthly",
  next_due: "2026-10-01",
  opened_on: "2025-01-01",
  description: null,
  contact_id: null,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  paid_total_minor: 135_000,
  remaining_minor: 2_365_000,
};

let accounts: AccountOut[];
let categories: CategoryOut[];
let contacts: ContactOut[];
let projects: ProjectOut[];
let transactions: TransactionOut[];
let transfers: TransferOut[];
let loans: LoanOut[];
let applyConflict: boolean;
let nextId: number;

function seed(
  accountSeed: AccountOut[],
  transactionSeed: TransactionOut[] = [],
  categorySeed: CategoryOut[] = [FOOD_CATEGORY],
  contactSeed: ContactOut[] = [],
  projectSeed: ProjectOut[] = [],
  transferSeed: TransferOut[] = [],
  loanSeed: LoanOut[] = [],
) {
  accounts = accountSeed.map((a) => ({ ...a }));
  transactions = transactionSeed.map((t) => ({ ...t }));
  categories = categorySeed.map((c) => ({ ...c }));
  contacts = contactSeed.map((p) => ({ ...p }));
  projects = projectSeed.map((p) => ({ ...p }));
  transfers = transferSeed.map((t) => ({ ...t }));
  loans = loanSeed.map((l) => ({ ...l }));
  applyConflict = false;
  nextId = transactionSeed.length + 1;
}

function installFakeBackend() {
  mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
    const method = opts?.method ?? "GET";

    if (path.startsWith("/accounts?") && method === "GET") {
      return Promise.resolve({ items: accounts, next_cursor: null });
    }
    if (path.startsWith("/categories?") && method === "GET") {
      return Promise.resolve({ items: categories, next_cursor: null });
    }
    if (path.startsWith("/contacts?") && method === "GET") {
      return Promise.resolve({ items: contacts, next_cursor: null });
    }
    if (path.startsWith("/projects?") && method === "GET") {
      return Promise.resolve({ items: projects, next_cursor: null });
    }
    if (path.startsWith("/transfers?") && method === "GET") {
      return Promise.resolve({ items: transfers, next_cursor: null });
    }
    if (path.startsWith("/loans?") && method === "GET") {
      return Promise.resolve({ items: loans, next_cursor: null });
    }
    const applyMatch = /^\/transactions\/([^/]+)\/apply-to-loan$/.exec(path);
    if (applyMatch && method === "POST") {
      if (applyConflict) {
        return Promise.reject(new ApiError(409, "TRANSACTION_ALREADY_LINKED"));
      }
      const body = opts?.json as { loan_id: string };
      return Promise.resolve({
        id: "lp-new",
        loan_id: body.loan_id,
        transaction_id: applyMatch[1],
        amount_minor: 8499,
        paid_on: "2026-09-10",
        note: null,
        is_demo: false,
        created_at: "2026-09-10T00:00:00Z",
      });
    }
    const transferMatch = /^\/transfers\/([^/]+)$/.exec(path);
    if (transferMatch && method === "DELETE") {
      const transferId = transferMatch[1];
      transfers = transfers.filter((t) => t.id !== transferId);
      // A transfer's legs go with it (server-side CASCADE) — drop them here
      // so the refetched list no longer shows either side.
      for (const t of transactions) {
        if (t.transfer_id === transferId) t.deleted_at = "2026-09-11T00:00:00Z";
      }
      return Promise.resolve(undefined);
    }
    if (path.startsWith("/transactions?") && method === "GET") {
      const url = new URL(path, "http://localhost");
      const p = url.searchParams;
      const accountId = p.get("account_id");
      const categoryId = p.get("category_id");
      const contactId = p.get("contact_id");
      const q = p.get("q");
      const type = p.get("type");
      const from = p.get("from");
      const to = p.get("to");
      const minAmount = p.get("min_amount_minor");
      const maxAmount = p.get("max_amount_minor");
      const items = transactions.filter((t) => {
        if (t.deleted_at !== null) return false;
        if (accountId && t.account_id !== accountId) return false;
        if (categoryId && t.category_id !== categoryId) return false;
        if (contactId && t.contact_id !== contactId) return false;
        if (q && !t.description.toLowerCase().includes(q.toLowerCase())) return false;
        if (type === "income" && !(t.amount_minor > 0 && t.transfer_id === null)) return false;
        if (type === "expense" && !(t.amount_minor < 0 && t.transfer_id === null)) return false;
        if (type === "transfer" && t.transfer_id === null) return false;
        if (from && t.occurred_on < from) return false;
        if (to && t.occurred_on > to) return false;
        const magnitude = Math.abs(t.amount_minor);
        if (minAmount && magnitude < Number(minAmount)) return false;
        if (maxAmount && magnitude > Number(maxAmount)) return false;
        return true;
      });
      return Promise.resolve({ items, next_cursor: null });
    }
    if (path === "/transactions" && method === "POST") {
      const body = opts?.json as Omit<TransactionOut, "id" | "is_demo" | "deleted_at" | "created_at" | "updated_at">;
      const created: TransactionOut = {
        ...body,
        id: `t${nextId++}`,
        is_demo: false,
        deleted_at: null,
        created_at: "2026-09-11T00:00:00Z",
        updated_at: "2026-09-11T00:00:00Z",
      };
      transactions.push(created);
      return Promise.resolve(created);
    }
    const deleteMatch = /^\/transactions\/([^/]+)$/.exec(path);
    if (deleteMatch && method === "DELETE") {
      const t = transactions.find((tx) => tx.id === deleteMatch[1]);
      if (t) t.deleted_at = "2026-09-11T00:00:00Z";
      return Promise.resolve(undefined);
    }
    const restoreMatch = /^\/transactions\/([^/]+)\/restore$/.exec(path);
    if (restoreMatch && method === "POST") {
      const t = transactions.find((tx) => tx.id === restoreMatch[1]);
      if (t) t.deleted_at = null;
      return Promise.resolve(undefined);
    }
    return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
  });
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <TransactionsScreen />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("TransactionsScreen", () => {
  beforeEach(() => {
    seed([CHECKING]);
    installFakeBackend();
  });

  it("shows a guiding empty state when there are no transactions", async () => {
    renderScreen();
    expect(await screen.findByText(/no transactions yet/i)).toBeInTheDocument();
  });

  it("lists transactions with description, account, amount, and category badge", async () => {
    seed([CHECKING], [GROCERIES]);
    renderScreen();

    const row = (await screen.findByText("Groceries")).closest("li")!;
    expect(within(row).getByText(/checking/i)).toBeInTheDocument();
    expect(within(row).getByText(/84\.99/)).toBeInTheDocument();
    expect(within(row).getByText("Food")).toBeInTheDocument();
  });

  it("shows in / out / net totals for the currently loaded transactions, with no 'loaded rows' note when the list isn't truncated", async () => {
    seed([CHECKING], [GROCERIES, PAYCHECK]);
    renderScreen();

    await screen.findByText("Groceries");
    await screen.findByText("Paycheck");

    const inBlock = (await screen.findByText("In")).parentElement!;
    const outBlock = screen.getByText("Out").parentElement!;
    const netBlock = screen.getByText("Net").parentElement!;

    // In: 250000 -> $2,500.00 (positive)
    const inAmount = within(inBlock).getByText("$2,500.00");
    expect(inAmount.className).toMatch(/text-positive/);
    // Out: -8499 -> -$84.99 (negative)
    const outAmount = within(outBlock).getByText("-$84.99");
    expect(outAmount.className).toMatch(/text-negative/);
    // Net: 250000 - 8499 = 241501 -> $2,415.01 (positive)
    const netAmount = within(netBlock).getByText("$2,415.01");
    expect(netAmount.className).toMatch(/text-positive/);

    expect(screen.queryByText(/loaded rows/i)).not.toBeInTheDocument();
  });

  it("labels the totals 'loaded rows' when more transactions remain beyond the loaded page", async () => {
    mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string }) => {
      const method = opts?.method ?? "GET";
      if (path.startsWith("/accounts?") && method === "GET") {
        return Promise.resolve({ items: [CHECKING], next_cursor: null });
      }
      if (path.startsWith("/categories?") || path.startsWith("/contacts?") || path.startsWith("/projects?") || path.startsWith("/transfers?") || path.startsWith("/loans?")) {
        return Promise.resolve({ items: [], next_cursor: null });
      }
      if (path.startsWith("/transactions?") && method === "GET") {
        // Always reports another page beyond this one.
        return Promise.resolve({ items: [GROCERIES], next_cursor: "cursor-2" });
      }
      return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
    });
    renderScreen();

    await screen.findByText("Groceries");

    expect(await screen.findByText(/loaded rows/i)).toBeInTheDocument();
  });

  it("shows a transaction's contact in its row", async () => {
    seed([CHECKING], [{ ...GROCERIES, contact_id: "p-grocery" }], [FOOD_CATEGORY], [GROCERY_STORE]);
    renderScreen();

    const row = (await screen.findByText("Groceries")).closest("li")!;
    expect(within(row).getByText("Grocery Store")).toBeInTheDocument();
  });

  it("shows a transaction's linked project in its row", async () => {
    seed(
      [CHECKING],
      [{ ...GROCERIES, project_id: "pr-kitchen" }],
      [FOOD_CATEGORY],
      [],
      [KITCHEN_PROJECT],
    );
    renderScreen();

    const row = (await screen.findByText("Groceries")).closest("li")!;
    expect(await within(row).findByText("Kitchen remodel")).toBeInTheDocument();
  });

  it("shows Uncategorized for a transaction with no category", async () => {
    seed([CHECKING], [{ ...GROCERIES, category_id: null }]);
    renderScreen();

    const row = (await screen.findByText("Groceries")).closest("li")!;
    expect(within(row).getByText("Uncategorized")).toBeInTheDocument();
  });

  it("re-fetches scoped to the selected account when the filter changes", async () => {
    seed([CHECKING], [GROCERIES]);
    renderScreen();
    await screen.findByText("Groceries");

    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "a1" } });

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining("account_id=a1")),
    );
  });

  it("creates a transaction and shows it in the list", async () => {
    renderScreen();
    await screen.findByText(/no transactions yet/i);

    fireEvent.click(screen.getByRole("button", { name: /new transaction/i }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "12.50" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Coffee" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-11" } });
    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));

    expect(await screen.findByText("Coffee")).toBeInTheDocument();
  });

  it("wraps a row's action buttons onto their own line instead of squeezing them against the description on a narrow viewport", async () => {
    seed([CHECKING], [GROCERIES]);
    renderScreen();

    const row = (await screen.findByText("Groceries")).closest("li")!;
    const deleteButton = within(row).getByRole("button", { name: /delete/i });
    // The actions cluster (Apply to loan / Edit / Delete) wraps as a group...
    expect(deleteButton.parentElement?.className).toMatch(/\bflex-wrap\b/);
    // ...inside a row that stacks to full width on mobile and reverts to the
    // original single-line, right-aligned layout at `sm:` and up.
    const amountAndActions = deleteButton.parentElement?.parentElement;
    expect(amountAndActions?.className).toMatch(/\bflex-wrap\b/);
    expect(amountAndActions?.className).toMatch(/\bsm:flex-nowrap\b/);
  });

  it("soft-deletes a transaction, removing it from the list, and restores it via the toast's Undo action", async () => {
    seed([CHECKING], [GROCERIES]);
    renderScreen();

    const row = (await screen.findByText("Groceries")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /delete/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/transactions/t1", { method: "DELETE" }),
    );
    await waitFor(() => expect(screen.queryByText("Groceries")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /undo/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/transactions/t1/restore", { method: "POST" }),
    );
    expect(await screen.findByText("Groceries")).toBeInTheDocument();
  });
});

describe("TransactionsScreen — transfer legs", () => {
  beforeEach(() => {
    seed([CHECKING, SAVINGS], [OUT_LEG, IN_LEG], [FOOD_CATEGORY], [], [], [MOVE_TRANSFER]);
    installFakeBackend();
  });

  it("labels the outflow leg as a transfer to the other account, not a category", async () => {
    renderScreen();

    const rows = await screen.findAllByText("Move to savings");
    const outRow = rows.map((n) => n.closest("li")!).find((li) => within(li).queryByText(/transfer to/i));
    expect(outRow).toBeTruthy();
    expect(within(outRow!).getByText("Transfer to Savings")).toBeInTheDocument();
    // The category badge is replaced by the transfer label — no "Uncategorized".
    expect(within(outRow!).queryByText("Uncategorized")).not.toBeInTheDocument();
  });

  it("labels the inflow leg as a transfer from the other account", async () => {
    renderScreen();

    const rows = await screen.findAllByText("Move to savings");
    const inRow = rows.map((n) => n.closest("li")!).find((li) => within(li).queryByText(/transfer from/i));
    expect(within(inRow!).getByText("Transfer from Checking")).toBeInTheDocument();
  });

  it("opens the transfer editor (not the transaction form) when a leg's edit is clicked", async () => {
    renderScreen();

    const rows = await screen.findAllByText("Move to savings");
    const outRow = rows.map((n) => n.closest("li")!).find((li) => within(li).queryByText(/transfer to/i))!;
    fireEvent.click(within(outRow).getByRole("button", { name: /edit/i }));

    // The transfer editor exposes From/To account selects — the transaction
    // form (uniquely marked by its inflow/outflow Direction toggle) must not
    // be what opened. Category is no longer a form-only marker now that the
    // filter bar above the list carries its own Category control.
    expect(await screen.findByLabelText("From account")).toHaveValue("a1");
    expect(screen.getByLabelText("To account")).toHaveValue("a2");
    expect(screen.queryByRole("group", { name: "Direction" })).not.toBeInTheDocument();
  });

  it("deletes the transfer from the editor, removing both legs from the list", async () => {
    renderScreen();

    const rows = await screen.findAllByText("Move to savings");
    const outRow = rows.map((n) => n.closest("li")!).find((li) => within(li).queryByText(/transfer to/i))!;
    fireEvent.click(within(outRow).getByRole("button", { name: /edit/i }));

    fireEvent.click(await screen.findByRole("button", { name: /delete transfer/i }));

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete transfer" }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/transfers/tr1", { method: "DELETE" }),
    );
    await waitFor(() => expect(screen.queryByText("Move to savings")).not.toBeInTheDocument());
  });

  it("opens the transfer form from the New transfer action", async () => {
    renderScreen();
    await screen.findAllByText("Move to savings");

    fireEvent.click(screen.getByRole("button", { name: /new transfer/i }));

    expect(await screen.findByLabelText("From account")).toBeInTheDocument();
    expect(screen.getByLabelText("To account")).toBeInTheDocument();
  });
});

describe("TransactionsScreen — apply to loan", () => {
  beforeEach(() => {
    seed([CHECKING], [GROCERIES], [FOOD_CATEGORY], [], [], [], [CAR_LOAN]);
    installFakeBackend();
  });

  it("opens the loan picker and applies the transaction to the chosen loan", async () => {
    renderScreen();

    const row = (await screen.findByText("Groceries")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /apply to loan/i }));

    // The loan picker lists the workspace's active loans.
    fireEvent.click(await within(row).findByText("Car loan"));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/transactions/t1/apply-to-loan", {
        method: "POST",
        json: { loan_id: "l1" },
      }),
    );
  });

  it("surfaces a friendly message when the transaction is already linked (409)", async () => {
    renderScreen();
    applyConflict = true;

    const row = (await screen.findByText("Groceries")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /apply to loan/i }));
    fireEvent.click(await within(row).findByText("Car loan"));

    expect(await screen.findByText(/already linked/i)).toBeInTheDocument();
  });

  it("offers no apply-to-loan action on a transfer leg", async () => {
    seed([CHECKING, SAVINGS], [OUT_LEG, IN_LEG], [FOOD_CATEGORY], [], [], [MOVE_TRANSFER], [CAR_LOAN]);
    installFakeBackend();
    renderScreen();

    const rows = await screen.findAllByText("Move to savings");
    const outRow = rows.map((n) => n.closest("li")!).find((li) => within(li).queryByText(/transfer to/i))!;
    expect(within(outRow).queryByRole("button", { name: /apply to loan/i })).not.toBeInTheDocument();
  });
});

describe("TransactionsScreen — search & filters", () => {
  /** The last `/transactions?…` URL the fake backend was asked for — the
   * request whose params reflect the current filter state (other resources'
   * lists don't refetch when a filter changes). */
  function lastTransactionsQuery(): string {
    const calls = mockApiFetch.mock.calls
      .map((c) => c[0])
      .filter((p): p is string => typeof p === "string" && p.startsWith("/transactions?"));
    return calls[calls.length - 1] ?? "";
  }

  it("queries with q only after the debounce elapses (advancing timers)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      seed([CHECKING], [GROCERIES]);
      installFakeBackend();
      renderScreen();
      await screen.findByText("Groceries");
      mockApiFetch.mockClear();

      fireEvent.change(screen.getByLabelText("Search"), { target: { value: "Groc" } });

      // The keystroke alone does not fire a request — the term is debounced.
      expect(mockApiFetch).not.toHaveBeenCalledWith(expect.stringContaining("q=Groc"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      await waitFor(() =>
        expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining("q=Groc")),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters the query by the chosen type", async () => {
    seed([CHECKING], [GROCERIES]);
    installFakeBackend();
    renderScreen();
    await screen.findByText("Groceries");

    fireEvent.click(screen.getByRole("button", { name: "Income" }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining("type=income")),
    );
  });

  it("filters the query by the chosen category, with 'All categories' as the unset state", async () => {
    seed([CHECKING], [GROCERIES], [FOOD_CATEGORY]);
    installFakeBackend();
    renderScreen();
    await screen.findByText("Groceries");

    // As a filter the empty option means "no category filter", so it reads
    // "All categories" (mirroring "All accounts") — never the form's
    // "Uncategorized".
    const categoryFilter = screen.getByLabelText("Category") as HTMLSelectElement;
    expect(
      await within(categoryFilter).findByRole("option", { name: "All categories" }),
    ).toBeInTheDocument();
    expect(
      within(categoryFilter).queryByRole("option", { name: "Uncategorized" }),
    ).not.toBeInTheDocument();

    fireEvent.change(categoryFilter, { target: { value: "c-food" } });

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining("category_id=c-food")),
    );
  });

  it("filters the query by the chosen contact", async () => {
    seed([CHECKING], [GROCERIES], [FOOD_CATEGORY], [GROCERY_STORE]);
    installFakeBackend();
    renderScreen();
    await screen.findByText("Groceries");

    const contactInput = screen.getByRole("combobox", { name: "Contact" });
    fireEvent.focus(contactInput);
    fireEvent.click(await screen.findByText("Grocery Store"));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining("contact_id=p-grocery")),
    );
  });

  it("filters the query by the chosen account", async () => {
    seed([CHECKING, SAVINGS], [GROCERIES]);
    installFakeBackend();
    renderScreen();
    await screen.findByText("Groceries");

    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "a2" } });

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining("account_id=a2")),
    );
  });

  it("threads a date range and an amount range into the query", async () => {
    seed([CHECKING], [GROCERIES]);
    installFakeBackend();
    renderScreen();
    await screen.findByText("Groceries");

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-30" } });
    fireEvent.change(screen.getByLabelText("Min amount"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Max amount"), { target: { value: "50" } });

    await waitFor(() => {
      const query = lastTransactionsQuery();
      expect(query).toContain("from=2026-09-01");
      expect(query).toContain("to=2026-09-30");
      // "$10"/"$50" typed → integer minor units, and the range is on magnitude.
      expect(query).toContain("min_amount_minor=1000");
      expect(query).toContain("max_amount_minor=5000");
    });
  });

  it("renders a chip for a set filter, removes it, and reverts the query", async () => {
    seed([CHECKING], [GROCERIES]);
    installFakeBackend();
    renderScreen();
    await screen.findByText("Groceries");

    fireEvent.click(screen.getByRole("button", { name: "Income" }));
    // The chip summarizing the set filter appears, labeled with its value.
    const remove = await screen.findByLabelText("Remove type filter");
    expect(remove.closest("span")).toHaveTextContent("Income");

    fireEvent.click(remove);

    // The chip is gone and the query no longer carries the type param.
    await waitFor(() => expect(screen.queryByLabelText("Remove type filter")).not.toBeInTheDocument());
    await waitFor(() => expect(lastTransactionsQuery()).not.toContain("type="));
  });

  it("clears every filter with Clear all", async () => {
    seed([CHECKING], [GROCERIES], [FOOD_CATEGORY]);
    installFakeBackend();
    renderScreen();
    await screen.findByText("Groceries");

    fireEvent.click(screen.getByRole("button", { name: "Expense" }));
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "c-food" } });
    expect(await screen.findByLabelText("Remove type filter")).toBeInTheDocument();
    expect(screen.getByLabelText("Remove category filter")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /clear all/i }));

    await waitFor(() => {
      expect(screen.queryByLabelText("Remove type filter")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Remove category filter")).not.toBeInTheDocument();
    });
    // Back to the unfiltered end: "All" is the active type and the category
    // control is reset to "All categories" (the empty value).
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Category")).toHaveValue("");
  });

  it("shows a distinct 'no results' empty state when filters match nothing (not the first-run state)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      seed([CHECKING], [GROCERIES]);
      installFakeBackend();
      renderScreen();
      await screen.findByText("Groceries");

      fireEvent.change(screen.getByLabelText("Search"), { target: { value: "no-such-description" } });

      expect(
        await screen.findByText(/no transactions match these filters/i),
      ).toBeInTheDocument();
      // The first-run "nothing here yet" copy must NOT be what's shown.
      expect(screen.queryByText(/no transactions yet/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
