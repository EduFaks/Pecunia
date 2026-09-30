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
      if (path === "/bank-sync/category-mappings" && method === "GET") {
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
      if (path === "/categories" && method === "GET") {
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
      if (path === "/bank-sync/category-mappings" && method === "PUT") {
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

  it("displays existing mappings", async () => {
    renderEditor();

    expect(await screen.findByText("TRANSFERS")).toBeInTheDocument();
    expect(screen.getByText("UTILITIES")).toBeInTheDocument();
  });

  it("adds a new mapping row", async () => {
    renderEditor();

    const addButton = await screen.findByRole("button", { name: /add|new mapping|plus/i });
    fireEvent.click(addButton);

    // New row should appear with empty dropdowns
    const newRow = await screen.findByText(/select category|choose/i);
    expect(newRow).toBeInTheDocument();
  });

  it("removes a mapping row", async () => {
    renderEditor();

    const removeButtons = await screen.findAllByRole("button", { name: /remove|delete|x/i });
    // Remove the first mapping
    fireEvent.click(removeButtons[0]);

    // Should confirm removal
    const confirmButton = await screen.findByRole("button", { name: /confirm|yes|remove/i });
    fireEvent.click(confirmButton);

    // After confirmation, one fewer mapping should be visible
    const mappings = await screen.findAllByText(/TRANSFERS|UTILITIES/);
    expect(mappings.length).toBeLessThan(2);
  });

  it("saves mappings via PUT", async () => {
    renderEditor();

    // Add a new mapping
    const addButton = await screen.findByRole("button", { name: /add|new mapping/i });
    fireEvent.click(addButton);

    // Select a pluggy category for the new mapping
    const pluggyCategorySelects = await screen.findAllByRole("combobox", { name: /pluggy category/i });
    fireEvent.change(pluggyCategorySelects[pluggyCategorySelects.length - 1], {
      target: { value: "FOOD_AND_DINING" },
    });

    // Select a local category
    const categorySelects = await screen.findAllByRole("combobox", { name: /category/i });
    fireEvent.change(categorySelects[categorySelects.length - 1], {
      target: { value: "cat-groceries" },
    });

    // Save
    const saveButton = screen.getByRole("button", { name: /save|apply/i });
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
                pluggy_category: "FOOD_AND_DINING",
              }),
            ]),
          }),
        }),
      );
    });

    expect(await screen.findByText(/saved|success/i)).toBeInTheDocument();
  });
});
