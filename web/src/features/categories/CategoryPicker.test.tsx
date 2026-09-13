import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import CategoryPicker from "./CategoryPicker";
import type { CategoryOut } from "./useCategories";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

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

const OLD_HOBBY: CategoryOut = {
  id: "c-old-hobby",
  name: "Old Hobby",
  kind: "expense",
  color: "#7c8f76",
  icon: null,
  archived_at: "2026-01-01T00:00:00Z",
  is_demo: false,
};

function renderPicker(value: string, onChange = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CategoryPicker value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
  return { onChange };
}

describe("CategoryPicker", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("lists categories grouped by kind, plus an Uncategorized option", async () => {
    mockApiFetch.mockResolvedValue({ items: [SALARY, GROCERIES], next_cursor: null });
    renderPicker("");

    const select = (await screen.findByLabelText("Category")) as HTMLSelectElement;
    // Wait for the categories query to resolve and the options to render
    // before inspecting the DOM further.
    await within(select).findByRole("option", { name: /salary/i });

    expect(within(select).getByRole("option", { name: "Uncategorized" })).toBeInTheDocument();
    const incomeGroup = select.querySelector('optgroup[label="Income"]') as HTMLElement;
    const expenseGroup = select.querySelector('optgroup[label="Expense"]') as HTMLElement;
    expect(within(incomeGroup).getByRole("option", { name: /salary/i })).toBeInTheDocument();
    expect(within(expenseGroup).getByRole("option", { name: /groceries/i })).toBeInTheDocument();
    expect(within(incomeGroup).queryByRole("option", { name: /groceries/i })).not.toBeInTheDocument();
  });

  it("renders emptyLabel as the empty option's text when provided (filter usage)", async () => {
    mockApiFetch.mockResolvedValue({ items: [SALARY, GROCERIES], next_cursor: null });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CategoryPicker value="" onChange={vi.fn()} emptyLabel="All categories" />
      </QueryClientProvider>,
    );

    const select = (await screen.findByLabelText("Category")) as HTMLSelectElement;
    await within(select).findByRole("option", { name: /salary/i });

    // The empty option carries the caller's label — and still maps to `""`.
    const empty = within(select).getByRole("option", { name: "All categories" }) as HTMLOptionElement;
    expect(empty.value).toBe("");
    expect(within(select).queryByRole("option", { name: "Uncategorized" })).not.toBeInTheDocument();
    // The real categories still list alongside it.
    expect(within(select).getByRole("option", { name: /groceries/i })).toBeInTheDocument();
  });

  it("calls onChange with the selected category's id", async () => {
    mockApiFetch.mockResolvedValue({ items: [SALARY, GROCERIES], next_cursor: null });
    const { onChange } = renderPicker("");

    const select = await screen.findByLabelText("Category");
    await within(select).findByRole("option", { name: /groceries/i });
    fireEvent.change(select, { target: { value: "c-groceries" } });

    expect(onChange).toHaveBeenCalledWith("c-groceries");
  });

  it("hides an archived category from the option list unless it's the current value", async () => {
    mockApiFetch.mockResolvedValue({ items: [GROCERIES, OLD_HOBBY], next_cursor: null });
    renderPicker("");

    const select = await screen.findByLabelText("Category");
    await within(select).findByRole("option", { name: /groceries/i });
    expect(within(select).queryByText(/old hobby/i)).not.toBeInTheDocument();
  });

  it("renders the selected category's lucide icon on the control, not its icon string", async () => {
    mockApiFetch.mockResolvedValue({ items: [SALARY, GROCERIES], next_cursor: null });
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CategoryPicker value="c-groceries" onChange={vi.fn()} />
      </QueryClientProvider>,
    );

    const select = (await screen.findByLabelText("Category")) as HTMLSelectElement;
    const groceries = await within(select).findByRole("option", { name: /groceries/i });
    // The option text is just the name — the raw "— shopping-bag" string is gone.
    expect(groceries.textContent).toBe("Groceries");
    // The selected category's glyph renders on the closed control.
    expect(container.querySelector("svg.lucide-shopping-bag")).toBeInTheDocument();
  });

  it("keeps an already-selected archived category visible, marked archived", async () => {
    mockApiFetch.mockResolvedValue({ items: [GROCERIES, OLD_HOBBY], next_cursor: null });
    renderPicker("c-old-hobby");

    const select = await screen.findByLabelText("Category");
    expect(await within(select).findByText(/old hobby \(archived\)/i)).toBeInTheDocument();
    expect(select).toHaveValue("c-old-hobby");
  });
});
