import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import { qk } from "../../lib/queries";
import CategoryMappingEditor from "./CategoryMappingEditor";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

function installFakeBackend() {
  mockApiFetch
    .mockReset()
    .mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
      const method = opts?.method ?? "GET";

      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: null });
      }
      if (path.startsWith("/bank-sync/category-mappings") && method === "GET") {
        return Promise.resolve([
          {
            pluggy_category: "TRANSFERS",
            category_id: "cat-transfer",
          },
          {
            pluggy_category: "UTILITIES",
            category_id: "cat-utilities",
          },
        ]);
      }
      if (path.startsWith("/categories") && method === "GET") {
        return Promise.resolve({
          items: [
            {
              id: "cat-transfer",
              name: "Transfers",
              color: "#0000FF",
              icon: "arrow-right",
              is_demo: false,
            },
            {
              id: "cat-utilities",
              name: "Utilities",
              color: "#FF0000",
              icon: "zap",
              is_demo: false,
            },
            {
              id: "cat-groceries",
              name: "Groceries",
              color: "#00FF00",
              icon: "shopping-cart",
              is_demo: false,
            },
          ],
          next_cursor: null,
        });
      }
      if (path.startsWith("/bank-sync/category-mappings") && method === "PUT") {
        const body = opts?.json as { mappings: unknown[] };
        return Promise.resolve(body.mappings);
      }
      return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
    });
}

function renderEditor() {
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
        <CategoryMappingEditor />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("CategoryMappingEditor", () => {
  beforeEach(() => {
    installFakeBackend();
  });

  it("displays existing mappings as free-text Pluggy category values", async () => {
    renderEditor();

    // Wait for mappings to load - wait for the "Save mappings" button to appear indicating data is loaded
    const saveButton = await screen.findByRole("button", { name: /save mappings/i });
    expect(saveButton).toBeInTheDocument();

    // Pluggy sends free-text category names (e.g. "Food"), not a fixed
    // vocabulary — the editor must accept whatever string comes back from
    // the mappings endpoint in a plain text input, not a constrained select.
    const pluggyCategoryInputs = screen.getAllByRole("textbox", { name: /Pluggy category/i });
    expect(pluggyCategoryInputs.length).toBeGreaterThanOrEqual(1);
    expect(pluggyCategoryInputs[0]).toHaveValue("TRANSFERS");
  });

  it("adds a new mapping row", async () => {
    renderEditor();

    const addButton = await screen.findByRole("button", { name: /add mapping/i });
    fireEvent.click(addButton);

    // New row should appear with an empty free-text Pluggy category input
    // and an empty Pecunia category select.
    const pluggyCategoryInputs = await screen.findAllByRole("textbox", { name: /Pluggy category/i });
    expect(pluggyCategoryInputs.length).toBeGreaterThanOrEqual(3);
    expect(pluggyCategoryInputs[pluggyCategoryInputs.length - 1]).toHaveValue("");

    const categorySelects = await screen.findAllByRole("combobox", { name: /^Category$/i });
    expect(categorySelects.length).toBeGreaterThanOrEqual(2); // At least the empty new row + existing ones
  });

  it("types a free-text Pluggy category into a mapping row", async () => {
    renderEditor();

    const addButton = await screen.findByRole("button", { name: /add mapping/i });
    fireEvent.click(addButton);

    const pluggyCategoryInputs = await screen.findAllByRole("textbox", { name: /Pluggy category/i });
    const newInput = pluggyCategoryInputs[pluggyCategoryInputs.length - 1];
    fireEvent.change(newInput, { target: { value: "Food" } });
    expect(newInput).toHaveValue("Food");
  });

  it("removes a mapping row", async () => {
    renderEditor();

    // Find the first remove button (for TRANSFERS mapping)
    const removeButtons = await screen.findAllByRole("button", { name: /remove/i });
    fireEvent.click(removeButtons[0]);

    // Should show confirmation dialog
    const confirmButton = await screen.findByRole("button", { name: /^Remove$/i });
    fireEvent.click(confirmButton);

    // After confirmation, mappings should update
    // If TRANSFERS was removed, we should have fewer mappings than before
    const pluggyCategoryInputs = screen.queryAllByRole("textbox", { name: /Pluggy category/i });
    expect(pluggyCategoryInputs.length).toBeLessThanOrEqual(1);
  });

  it("saves mappings via PUT", async () => {
    renderEditor();

    // Add a new mapping
    const addButton = await screen.findByRole("button", { name: /add mapping/i });
    fireEvent.click(addButton);

    // Type a free-text pluggy category for the new mapping — mirrors the
    // free text Pluggy actually sends (see api/.../bank_sync.py docstring
    // and test fixtures using "Food").
    const pluggyCategoryInputs = await screen.findAllByRole("textbox", { name: /Pluggy category/i });
    fireEvent.change(pluggyCategoryInputs[pluggyCategoryInputs.length - 1], {
      target: { value: "Food" },
    });

    // Select a local category
    const categorySelects = await screen.findAllByRole("combobox", { name: /^Category$/i });
    fireEvent.change(categorySelects[categorySelects.length - 1], {
      target: { value: "cat-groceries" },
    });

    // Save
    const saveButton = await screen.findByRole("button", { name: /save mappings/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/bank-sync/category-mappings",
        expect.objectContaining({
          method: "PUT",
          json: expect.objectContaining({
            mappings: expect.arrayContaining([
              expect.objectContaining({
                pluggy_category: "TRANSFERS",
              }),
              expect.objectContaining({
                pluggy_category: "UTILITIES",
              }),
              expect.objectContaining({
                pluggy_category: "Food",
              }),
            ]),
          }),
        }),
      );
    });

    expect(await screen.findByText(/saved|success/i)).toBeInTheDocument();
  });
});
