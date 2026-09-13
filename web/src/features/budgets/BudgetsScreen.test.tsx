import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import BudgetsScreen from "./BudgetsScreen";
import type { BudgetOut } from "./useBudgets";
import type { CategoryOut } from "../categories/useCategories";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const FOOD_CATEGORY: CategoryOut = {
  id: "c-food",
  name: "Food",
  kind: "expense",
  color: "#8a8578",
  icon: "shopping-bag",
  archived_at: null,
  is_demo: false,
};

let budgets: BudgetOut[];
let categories: CategoryOut[];
let nextId: number;

function seedBudgets(seed: BudgetOut[], categorySeed: CategoryOut[] = [FOOD_CATEGORY]) {
  budgets = seed.map((budget) => ({ ...budget }));
  categories = categorySeed.map((category) => ({ ...category }));
  nextId = seed.length + 1;
}

function installFakeBackend() {
  mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
    const method = opts?.method ?? "GET";

    if (path.startsWith("/categories?") && method === "GET") {
      return Promise.resolve({ items: categories, next_cursor: null });
    }
    if (path.startsWith("/budgets?") && method === "GET") {
      return Promise.resolve({ items: budgets, next_cursor: null });
    }
    if (path === "/budgets" && method === "POST") {
      const body = opts?.json as {
        name: string;
        category_id?: string | null;
        period: string;
        amount_minor: number;
        currency: string;
      };
      const created: BudgetOut = {
        id: `b${nextId++}`,
        name: body.name,
        category_id: body.category_id ?? null,
        period: body.period as BudgetOut["period"],
        amount_minor: body.amount_minor,
        currency: body.currency,
        actual_minor: null,
        remaining_minor: null,
        is_demo: false,
        created_at: "2026-09-11T00:00:00Z",
        updated_at: "2026-09-11T00:00:00Z",
      };
      budgets.push(created);
      return Promise.resolve(created);
    }
    const idMatch = /^\/budgets\/([^/]+)$/.exec(path);
    if (idMatch && method === "PATCH") {
      const budget = budgets.find((b) => b.id === idMatch[1]);
      if (budget) {
        Object.assign(budget, opts?.json as Partial<BudgetOut>);
      }
      return Promise.resolve(budget);
    }
    if (idMatch && method === "DELETE") {
      budgets = budgets.filter((b) => b.id !== idMatch[1]);
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
        <BudgetsScreen />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const GROCERIES: BudgetOut = {
  id: "b1",
  name: "Groceries",
  category_id: "c-food",
  period: "monthly",
  amount_minor: 60_000,
  currency: "USD",
  actual_minor: 30_000,
  remaining_minor: 30_000,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const UNCATEGORIZED_RENT: BudgetOut = {
  ...GROCERIES,
  id: "b2",
  name: "Rent",
  category_id: null,
  actual_minor: null,
  remaining_minor: null,
};

const OVER_BUDGET_DINING: BudgetOut = {
  ...GROCERIES,
  id: "b3",
  name: "Dining",
  actual_minor: 90_000,
  remaining_minor: -30_000,
};

describe("BudgetsScreen", () => {
  beforeEach(() => {
    seedBudgets([]);
    installFakeBackend();
  });

  it("shows a guiding empty state on a fresh workspace", async () => {
    renderScreen();
    expect(await screen.findByText(/no budgets yet/i)).toBeInTheDocument();
  });

  it("lists budgets with name, category badge, period pill, and amount", async () => {
    seedBudgets([GROCERIES]);
    renderScreen();

    const row = (await screen.findByText("Groceries")).closest("li")!;
    expect(within(row).getByText("Food")).toBeInTheDocument();
    expect(within(row).getByText("Monthly")).toBeInTheDocument();
    expect(within(row).getByText(/600\.00/)).toBeInTheDocument();
  });

  it("shows Uncategorized for a budget with no category, and hides its vs-actual bar", async () => {
    seedBudgets([UNCATEGORIZED_RENT]);
    renderScreen();

    const row = (await screen.findByText("Rent")).closest("li")!;
    expect(within(row).getByText("Uncategorized")).toBeInTheDocument();
    expect(within(row).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(within(row).getByText(/set a category to track spending/i)).toBeInTheDocument();
  });

  it("renders the budget-vs-actual bar with the accent fill when under budget", async () => {
    seedBudgets([GROCERIES]);
    renderScreen();

    const row = (await screen.findByText("Groceries")).closest("li")!;
    const bar = within(row).getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    const fill = row.querySelector("[data-budget-fill]") as HTMLElement;
    expect(fill.className).toMatch(/bg-accent/);
    expect(within(row).getByText(/remaining/i)).toBeInTheDocument();
  });

  it("switches the vs-actual bar to the negative (coral) fill when over budget", async () => {
    seedBudgets([OVER_BUDGET_DINING]);
    renderScreen();

    const row = (await screen.findByText("Dining")).closest("li")!;
    const fill = row.querySelector("[data-budget-fill]") as HTMLElement;
    expect(fill.className).toMatch(/bg-negative/);
    expect(within(row).getByText(/over by/i)).toBeInTheDocument();
  });

  it("creates, edits, and deletes a budget end to end", async () => {
    renderScreen();
    await screen.findByText(/no budgets yet/i);

    // Create.
    fireEvent.click(screen.getAllByRole("button", { name: /new budget|add your first budget/i })[0]);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Groceries" } });
    fireEvent.change(await screen.findByLabelText("Category"), { target: { value: "c-food" } });
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "monthly" } });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "600" } });
    fireEvent.click(screen.getByRole("button", { name: /create budget/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/budgets", {
        method: "POST",
        json: {
          name: "Groceries",
          category_id: "c-food",
          period: "monthly",
          currency: "USD",
          amount_minor: 60_000,
        },
      }),
    );
    let row = (await screen.findByText("Groceries")).closest("li")!;

    // Edit.
    fireEvent.click(within(row).getByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "650" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/budgets/b1",
        expect.objectContaining({ method: "PATCH", json: expect.objectContaining({ amount_minor: 65_000 }) }),
      ),
    );
    row = (await screen.findByText("Groceries")).closest("li")!;
    expect(within(row).getByText(/650\.00/)).toBeInTheDocument();

    // Delete — clicking the row action opens a confirmation first.
    fireEvent.click(within(row).getByRole("button", { name: /^delete$/i }));
    expect(await screen.findByRole("alertdialog")).toHaveAccessibleName('Delete "Groceries"?');
    expect(mockApiFetch).not.toHaveBeenCalledWith("/budgets/b1", { method: "DELETE" });

    fireEvent.click(screen.getByRole("button", { name: "Delete budget" }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/budgets/b1", { method: "DELETE" }),
    );
    await waitFor(() => expect(screen.queryByText("Groceries")).not.toBeInTheDocument());
    expect(await screen.findByText(/no budgets yet/i)).toBeInTheDocument();
  });

  it("cancelling the delete confirmation leaves the budget in place", async () => {
    seedBudgets([GROCERIES]);
    renderScreen();

    const row = (await screen.findByText("Groceries")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /^delete$/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalledWith("/budgets/b1", { method: "DELETE" });
    expect(screen.getByText("Groceries")).toBeInTheDocument();
  });
});
