import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../../lib/api";
import TransactionForm from "./TransactionForm";
import type { TransactionFormProps } from "./TransactionForm";
import type { AccountOut } from "../accounts/useAccounts";
import type { TransactionOut } from "./useTransactions";
import type { CategoryOut } from "../categories/useCategories";
import type { ContactOut } from "../contacts/useContacts";
import type { ProjectOut } from "../projects/useProjects";

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

const SAVINGS_JPY: AccountOut = {
  ...CHECKING,
  id: "a2",
  name: "Savings JPY",
  currency: "JPY",
};

const ACCOUNTS = [CHECKING, SAVINGS_JPY];

const GROCERIES_CATEGORY: CategoryOut = {
  id: "c-groceries",
  name: "Groceries",
  kind: "expense",
  color: "#8a8578",
  icon: "shopping-bag",
  archived_at: null,
  is_demo: false,
};

const DINING_CATEGORY: CategoryOut = {
  id: "c-dining",
  name: "Dining",
  kind: "expense",
  color: "#fb7185",
  icon: null,
  archived_at: null,
  is_demo: false,
};

const GROCERY_STORE: ContactOut = {
  id: "p-grocery",
  name: "Grocery Store",
  default_category_id: "c-groceries",
  type: "company",
  avatar: null,
  archived_at: null,
  is_demo: false,
  created_at: "2026-09-10T00:00:00Z",
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

/** Routes `/categories?...`/`/contacts?...`/`/projects?...` to fixed lists and
 * everything else to `handler` — every test renders `TransactionForm`, which
 * always mounts a `CategoryPicker`, a `ContactPicker`, and a `ProjectPicker`
 * that each fetch their own data. */
function installBackend(
  handler: (path: string, opts?: { method?: string; json?: unknown }) => Promise<unknown>,
  categories: CategoryOut[] = [GROCERIES_CATEGORY],
  contacts: ContactOut[] = [],
  projects: ProjectOut[] = [],
) {
  mockApiFetch.mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
    if (path.startsWith("/categories?")) {
      return Promise.resolve({ items: categories, next_cursor: null });
    }
    if (path.startsWith("/contacts?")) {
      return Promise.resolve({ items: contacts, next_cursor: null });
    }
    if (path.startsWith("/projects?")) {
      return Promise.resolve({ items: projects, next_cursor: null });
    }
    return handler(path, opts);
  });
}

function renderForm(props: Partial<TransactionFormProps> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSuccess = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <TransactionForm accounts={ACCOUNTS} onSuccess={onSuccess} {...props} />
    </QueryClientProvider>,
  );
  return { onSuccess };
}

describe("TransactionForm — create", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("posts an outflow as a negative amount_minor, matching the selected account's currency", async () => {
    installBackend(() => Promise.resolve(TRANSACTION));
    const { onSuccess } = renderForm();

    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "a1" } });
    // Outflow is the default direction.
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "84.99" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Groceries" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-10" } });

    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/transactions", {
        method: "POST",
        json: {
          account_id: "a1",
          category_id: null,
          contact_id: null,
          project_id: null,
          amount_minor: -8499,
          currency: "USD",
          description: "Groceries",
          occurred_on: "2026-09-10",
        },
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(TRANSACTION));
  });

  it("submits the chosen project's id", async () => {
    installBackend(() => Promise.resolve(TRANSACTION), [GROCERIES_CATEGORY], [], [KITCHEN_PROJECT]);
    renderForm();

    const projectInput = await screen.findByLabelText("Project");
    fireEvent.focus(projectInput);
    fireEvent.click(await screen.findByRole("option", { name: /kitchen remodel/i }));

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "84.99" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Cabinets" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-10" } });
    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/transactions",
        expect.objectContaining({ json: expect.objectContaining({ project_id: "pr-kitchen" }) }),
      ),
    );
  });

  it("submits the chosen category's id", async () => {
    installBackend(() => Promise.resolve(TRANSACTION));
    renderForm();

    const categoryPicker = await screen.findByLabelText("Category");
    // Wait for the categories query to resolve so the real option exists
    // before selecting it.
    await within(categoryPicker).findByRole("option", { name: /groceries/i });
    // In the FORM, no category genuinely means uncategorized — the empty
    // option keeps its default label (the filter bar overrides it to
    // "All categories", which must not leak here).
    expect(within(categoryPicker).getByRole("option", { name: "Uncategorized" })).toBeInTheDocument();
    fireEvent.change(categoryPicker, { target: { value: "c-groceries" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "84.99" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Groceries" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-10" } });
    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/transactions",
        expect.objectContaining({ json: expect.objectContaining({ category_id: "c-groceries" }) }),
      ),
    );
  });

  it("submits the chosen contact's id", async () => {
    installBackend(() => Promise.resolve(TRANSACTION), [GROCERIES_CATEGORY], [GROCERY_STORE]);
    renderForm();

    const contactInput = await screen.findByLabelText("Contact");
    fireEvent.focus(contactInput);
    fireEvent.click(await screen.findByRole("option", { name: /grocery store/i }));

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "84.99" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Groceries" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-10" } });
    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/transactions",
        expect.objectContaining({ json: expect.objectContaining({ contact_id: "p-grocery" }) }),
      ),
    );
  });

  it("fills an empty category with the selected contact's default category", async () => {
    installBackend(() => Promise.resolve(TRANSACTION), [GROCERIES_CATEGORY], [GROCERY_STORE]);
    renderForm();

    const categoryPicker = await screen.findByLabelText("Category");
    await within(categoryPicker).findByRole("option", { name: /groceries/i });
    expect(categoryPicker).toHaveValue("");

    const contactInput = screen.getByLabelText("Contact");
    fireEvent.focus(contactInput);
    fireEvent.click(await screen.findByRole("option", { name: /grocery store/i }));

    await waitFor(() => expect(categoryPicker).toHaveValue("c-groceries"));
  });

  it("does not overwrite an already-chosen category when a contact is selected", async () => {
    installBackend(
      () => Promise.resolve(TRANSACTION),
      [GROCERIES_CATEGORY, DINING_CATEGORY],
      [GROCERY_STORE],
    );
    renderForm();

    const categoryPicker = await screen.findByLabelText("Category");
    await within(categoryPicker).findByRole("option", { name: /dining/i });
    fireEvent.change(categoryPicker, { target: { value: "c-dining" } });
    expect(categoryPicker).toHaveValue("c-dining");

    const contactInput = screen.getByLabelText("Contact");
    fireEvent.focus(contactInput);
    fireEvent.click(await screen.findByRole("option", { name: /grocery store/i }));

    // The contact's default (c-groceries) must not clobber the chosen c-dining.
    expect(categoryPicker).toHaveValue("c-dining");
  });

  it("posts a positive amount_minor when the inflow toggle is selected", async () => {
    installBackend(() => Promise.resolve(TRANSACTION));
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: /^inflow$/i }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "84.99" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Paycheck" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-10" } });

    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/transactions",
        expect.objectContaining({ json: expect.objectContaining({ amount_minor: 8499 }) }),
      ),
    );
  });

  it("maps a 0-decimal currency (JPY) amount straight to minor units with no factor applied", async () => {
    installBackend(() => Promise.resolve(TRANSACTION));
    renderForm();

    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "a2" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Groceries" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-10" } });

    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/transactions",
        expect.objectContaining({
          json: expect.objectContaining({ amount_minor: -1000, currency: "JPY" }),
        }),
      ),
    );
  });

  it("hides the account selector and locks to the given account when accountId is fixed", () => {
    installBackend(() => Promise.reject(new Error("unexpected call")));
    renderForm({ lockedAccountId: "a2" });

    expect(screen.queryByLabelText("Account")).not.toBeInTheDocument();
    expect(screen.getAllByText(/JPY/).length).toBeGreaterThan(0);
  });

  it("shows a friendly field error on a currency mismatch (422)", async () => {
    installBackend(() => Promise.reject(new ApiError(422, "CURRENCY_MISMATCH")));
    renderForm();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Test" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-10" } });
    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));

    expect(await screen.findByText(/currency/i)).toBeInTheDocument();
  });

  it("shows a friendly error when the account can't be found (404)", async () => {
    installBackend(() => Promise.reject(new ApiError(404, "ACCOUNT_NOT_FOUND")));
    renderForm();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Test" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-10" } });
    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/account/i);
  });

  it("shows a friendly error when the chosen category can't be found (404)", async () => {
    installBackend(() => Promise.reject(new ApiError(404, "CATEGORY_NOT_FOUND")));
    renderForm();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Test" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-10" } });
    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/category/i);
  });
});

describe("TransactionForm — edit", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("prefills the outflow direction and absolute amount from a negative existing transaction", async () => {
    installBackend(() => Promise.reject(new Error("unexpected call")));
    renderForm({ transaction: TRANSACTION });

    expect(screen.getByLabelText("Amount")).toHaveValue("84.99");
    expect(screen.getByRole("button", { name: /^outflow$/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Description")).toHaveValue("Groceries");
    expect(screen.getByLabelText("Date")).toHaveValue("2026-09-10");
    expect(await screen.findByLabelText("Category")).toHaveValue("");
  });

  it("prefills the picker from an already-categorized transaction", async () => {
    installBackend(() => Promise.reject(new Error("unexpected call")));
    renderForm({ transaction: { ...TRANSACTION, category_id: "c-groceries" } });

    const categoryPicker = await screen.findByLabelText("Category");
    await within(categoryPicker).findByRole("option", { name: /groceries/i });
    expect(categoryPicker).toHaveValue("c-groceries");
  });

  it("patches with the recombined signed amount on save", async () => {
    installBackend(() => Promise.resolve({ ...TRANSACTION, amount_minor: -9000 }));
    renderForm({ transaction: TRANSACTION });

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/transactions/t1",
        expect.objectContaining({
          method: "PATCH",
          json: expect.objectContaining({ amount_minor: -9000 }),
        }),
      ),
    );
  });
});
