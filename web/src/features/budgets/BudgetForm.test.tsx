import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../../lib/api";
import BudgetForm from "./BudgetForm";
import type { BudgetFormProps } from "./BudgetForm";
import type { BudgetOut } from "./useBudgets";
import type { CategoryOut } from "../categories/useCategories";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const GROCERIES_CATEGORY: CategoryOut = {
  id: "c-groceries",
  name: "Groceries",
  kind: "expense",
  color: "#8a8578",
  icon: "shopping-bag",
  archived_at: null,
  is_demo: false,
};

function installCategoriesBackend(categories: CategoryOut[] = [GROCERIES_CATEGORY]) {
  mockApiFetch.mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
    if (typeof path === "string" && path.startsWith("/categories?")) {
      return Promise.resolve({ items: categories, next_cursor: null });
    }
    return Promise.reject(new Error(`unexpected call: ${opts?.method ?? "GET"} ${path}`));
  });
}

function renderForm(props: Partial<BudgetFormProps> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSuccess = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <BudgetForm onSuccess={onSuccess} {...props} />
    </QueryClientProvider>,
  );
  return { onSuccess };
}

const BUDGET: BudgetOut = {
  id: "b1",
  name: "Groceries",
  category_id: "c-groceries",
  period: "monthly",
  amount_minor: 60_000,
  currency: "USD",
  actual_minor: 30_000,
  remaining_minor: 30_000,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("BudgetForm — create", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    installCategoriesBackend();
  });

  it("posts name, category_id, period, currency, and the amount converted to minor units", async () => {
    mockApiFetch.mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
      if (path.startsWith("/categories?")) {
        return Promise.resolve({ items: [GROCERIES_CATEGORY], next_cursor: null });
      }
      if (path === "/budgets" && opts?.method === "POST") {
        return Promise.resolve(BUDGET);
      }
      return Promise.reject(new Error(`unexpected call: ${opts?.method ?? "GET"} ${path}`));
    });
    const { onSuccess } = renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Groceries" } });
    const categoryPicker = await screen.findByLabelText("Category");
    await within(categoryPicker).findByRole("option", { name: /groceries/i });
    fireEvent.change(categoryPicker, { target: { value: "c-groceries" } });
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "monthly" } });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "600" } });

    fireEvent.click(screen.getByRole("button", { name: /create budget/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/budgets", {
        method: "POST",
        json: {
          name: "Groceries",
          category_id: "c-groceries",
          period: "monthly",
          currency: "USD",
          amount_minor: 60_000,
        },
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(BUDGET));
  });

  it("sends category_id: null when left as Uncategorized", async () => {
    mockApiFetch.mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
      if (path.startsWith("/categories?")) {
        return Promise.resolve({ items: [GROCERIES_CATEGORY], next_cursor: null });
      }
      if (path === "/budgets" && opts?.method === "POST") {
        return Promise.resolve(BUDGET);
      }
      return Promise.reject(new Error(`unexpected call: ${opts?.method ?? "GET"} ${path}`));
    });
    renderForm();
    await screen.findByLabelText("Category");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Rent" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1500" } });
    fireEvent.click(screen.getByRole("button", { name: /create budget/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/budgets",
        expect.objectContaining({
          json: expect.objectContaining({ category_id: null }),
        }),
      ),
    );
  });

  it("does not submit without a name and a valid amount", () => {
    renderForm();
    expect(screen.getByRole("button", { name: /create budget/i })).toBeDisabled();
  });
});

describe("BudgetForm — edit", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    installCategoriesBackend();
  });

  it("prefills from the given budget, including its category", async () => {
    renderForm({ budget: BUDGET });

    expect(screen.getByLabelText("Name")).toHaveValue("Groceries");
    const categoryPicker = await screen.findByLabelText("Category");
    await within(categoryPicker).findByRole("option", { name: /groceries/i });
    expect(categoryPicker).toHaveValue("c-groceries");
    expect(screen.getByLabelText("Period")).toHaveValue("monthly");
    expect(screen.getByLabelText("Currency")).toHaveValue("USD");
    expect(screen.getByLabelText("Amount")).toHaveValue("600.00");
  });

  it("patches the changed fields on save", async () => {
    mockApiFetch.mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
      if (path.startsWith("/categories?")) {
        return Promise.resolve({ items: [GROCERIES_CATEGORY], next_cursor: null });
      }
      if (path === "/budgets/b1" && opts?.method === "PATCH") {
        return Promise.resolve({ ...BUDGET, amount_minor: 70_000 });
      }
      return Promise.reject(new Error(`unexpected call: ${opts?.method ?? "GET"} ${path}`));
    });
    const { onSuccess } = renderForm({ budget: BUDGET });
    await screen.findByLabelText("Category");

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "700" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/budgets/b1", {
        method: "PATCH",
        json: {
          name: "Groceries",
          category_id: "c-groceries",
          period: "monthly",
          currency: "USD",
          amount_minor: 70_000,
        },
      }),
    );
    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith({ ...BUDGET, amount_minor: 70_000 }),
    );
  });

  it("shows a generic error message on failure", async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/categories?")) {
        return Promise.resolve({ items: [GROCERIES_CATEGORY], next_cursor: null });
      }
      return Promise.reject(new ApiError(500, "UNKNOWN_ERROR"));
    });
    renderForm({ budget: BUDGET });
    await screen.findByLabelText("Category");

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't save/i);
  });

  it("shows a friendly error when the chosen category can't be found (404)", async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/categories?")) {
        return Promise.resolve({ items: [GROCERIES_CATEGORY], next_cursor: null });
      }
      return Promise.reject(new ApiError(404, "CATEGORY_NOT_FOUND"));
    });
    renderForm({ budget: BUDGET });
    await screen.findByLabelText("Category");

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/category/i);
  });
});
