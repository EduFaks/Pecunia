import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import CategoriesPanel from "./CategoriesPanel";
import type { CategoryOut } from "./useCategories";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

let categories: CategoryOut[];
let nextId: number;

function seedCategories(seed: CategoryOut[]) {
  categories = seed.map((category) => ({ ...category }));
  nextId = seed.length + 1;
}

function installFakeBackend() {
  mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
    const method = opts?.method ?? "GET";

    if (path.startsWith("/categories?") && method === "GET") {
      const includeArchived = new URL(path, "http://localhost").searchParams.get("include_archived") === "true";
      const items = includeArchived ? categories : categories.filter((c) => c.archived_at === null);
      return Promise.resolve({ items, next_cursor: null });
    }
    if (path === "/categories" && method === "POST") {
      const body = opts?.json as { name: string; kind: string; color: string; icon?: string | null };
      const created: CategoryOut = {
        id: `c${nextId++}`,
        name: body.name,
        kind: body.kind as CategoryOut["kind"],
        color: body.color,
        icon: body.icon ?? null,
        archived_at: null,
        is_demo: false,
      };
      categories.push(created);
      return Promise.resolve(created);
    }
    const patchMatch = /^\/categories\/([^/]+)$/.exec(path);
    if (patchMatch && method === "PATCH") {
      const category = categories.find((c) => c.id === patchMatch[1]);
      if (category) {
        Object.assign(category, opts?.json as Partial<CategoryOut>);
      }
      return Promise.resolve(category);
    }
    const archiveMatch = /^\/categories\/([^/]+)\/archive$/.exec(path);
    if (archiveMatch && method === "POST") {
      const category = categories.find((c) => c.id === archiveMatch[1]);
      if (category) {
        category.archived_at = "2026-09-11T00:00:00Z";
      }
      return Promise.resolve(undefined);
    }
    return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
  });
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <CategoriesPanel />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const SALARY: CategoryOut = {
  id: "c-salary",
  name: "Salary",
  kind: "income",
  color: "#b08d57",
  icon: "wallet",
  archived_at: null,
  is_demo: false,
};

const GROCERIES: CategoryOut = {
  id: "c-groceries",
  name: "Groceries",
  kind: "expense",
  color: "#8a8578",
  icon: "shopping-bag",
  archived_at: null,
  is_demo: false,
};

describe("CategoriesPanel", () => {
  beforeEach(() => {
    seedCategories([]);
    installFakeBackend();
  });

  it("shows a guiding empty state on a fresh workspace", async () => {
    renderPanel();
    expect(await screen.findByText(/no categories yet/i)).toBeInTheDocument();
  });

  it("lists categories grouped by kind", async () => {
    seedCategories([SALARY, GROCERIES]);
    renderPanel();

    expect(await screen.findByText("Income")).toBeInTheDocument();
    expect(screen.getByText("Expense")).toBeInTheDocument();

    const incomeGroup = screen.getByText("Income").closest("div")!;
    const expenseGroup = screen.getByText("Expense").closest("div")!;
    expect(within(incomeGroup).getByText("Salary")).toBeInTheDocument();
    expect(within(expenseGroup).getByText("Groceries")).toBeInTheDocument();
  });

  it("creates a category and shows it in its kind's group", async () => {
    renderPanel();
    await screen.findByText(/no categories yet/i);

    fireEvent.click(screen.getByRole("button", { name: /new category/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bonus" } });
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "income" } });
    fireEvent.click(screen.getByRole("button", { name: "Amber" }));
    fireEvent.click(screen.getByRole("button", { name: /create category/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/categories", {
        method: "POST",
        json: { name: "Bonus", kind: "income", color: "#fbbf24" },
      }),
    );
    expect(await screen.findByText("Bonus")).toBeInTheDocument();
    expect(screen.getByText("Income")).toBeInTheDocument();
  });

  it("edits a category's name", async () => {
    seedCategories([GROCERIES]);
    renderPanel();

    const row = (await screen.findByText("Groceries")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Food" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/categories/c-groceries",
        expect.objectContaining({ method: "PATCH", json: expect.objectContaining({ name: "Food" }) }),
      ),
    );
    expect(await screen.findByText("Food")).toBeInTheDocument();
  });

  it("archives a category, hiding it until Show archived is checked", async () => {
    seedCategories([GROCERIES]);
    renderPanel();

    const row = (await screen.findByText("Groceries")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /archive/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/categories/c-groceries/archive", { method: "POST" }),
    );
    await waitFor(() => expect(screen.queryByText("Groceries")).not.toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(/show archived categories/i));

    const archivedRow = (await screen.findByText("Groceries")).closest("li")!;
    expect(within(archivedRow).getByText("Archived")).toBeInTheDocument();
    expect(within(archivedRow).queryByRole("button", { name: /^archive$/i })).not.toBeInTheDocument();
  });
});
