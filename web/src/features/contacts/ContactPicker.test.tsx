import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import ContactPicker from "./ContactPicker";
import type { ContactOut } from "./useContacts";
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

const FUEL: ContactOut = {
  id: "p-fuel",
  name: "Fuel Brand",
  default_category_id: null,
  type: "company",
  avatar: null,
  archived_at: null,
  is_demo: false,
  created_at: "2026-09-10T00:00:00Z",
};

/** Serves `/contacts?...` and `/categories?...` from fixed lists — the picker
 * fetches both on its own (contacts to list, categories to resolve the
 * default-category hint). */
function installBackend(contacts: ContactOut[], categories: CategoryOut[] = [GROCERIES_CATEGORY]) {
  mockApiFetch.mockReset().mockImplementation((path: string) => {
    if (path.startsWith("/contacts?")) {
      return Promise.resolve({ items: contacts, next_cursor: null });
    }
    if (path.startsWith("/categories?")) {
      return Promise.resolve({ items: categories, next_cursor: null });
    }
    return Promise.reject(new Error(`unexpected call: ${path}`));
  });
}

/** A stateful host so a selection round-trips through `value` the way a real
 * form holds it. */
function Host({ onChange }: { onChange?: (id: string, contact: ContactOut | null) => void }) {
  const [value, setValue] = useState("");
  return (
    <ContactPicker
      value={value}
      onChange={(id, contact) => {
        setValue(id);
        onChange?.(id, contact);
      }}
    />
  );
}

function renderPicker(contacts: ContactOut[], onChange = vi.fn()) {
  installBackend(contacts);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Host onChange={onChange} />
    </QueryClientProvider>,
  );
  return { onChange };
}

describe("ContactPicker", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("lists the workspace's contacts when opened", async () => {
    renderPicker([GROCERY_STORE, FUEL]);

    const input = await screen.findByLabelText("Contact");
    fireEvent.focus(input);

    expect(await screen.findByRole("option", { name: /grocery store/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /fuel brand/i })).toBeInTheDocument();
  });

  it("shows a contact's default category as a hint in its option", async () => {
    renderPicker([GROCERY_STORE, FUEL]);

    const input = await screen.findByLabelText("Contact");
    fireEvent.focus(input);

    const option = await screen.findByRole("option", { name: /grocery store/i });
    expect(within(option).getByText("Groceries")).toBeInTheDocument();
  });

  it("filters the options by the typed text", async () => {
    renderPicker([GROCERY_STORE, FUEL]);

    const input = await screen.findByLabelText("Contact");
    fireEvent.change(input, { target: { value: "fuel" } });

    expect(await screen.findByRole("option", { name: /fuel brand/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /grocery store/i })).not.toBeInTheDocument();
  });

  it("calls onChange with the selected contact's id and object", async () => {
    const { onChange } = renderPicker([GROCERY_STORE, FUEL]);

    const input = await screen.findByLabelText("Contact");
    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole("option", { name: /grocery store/i }));

    expect(onChange).toHaveBeenCalledWith("p-grocery", GROCERY_STORE);
  });

  it("clears the selection via the none option", async () => {
    const { onChange } = renderPicker([GROCERY_STORE, FUEL]);

    const input = await screen.findByLabelText("Contact");
    // Select first so there's something to clear.
    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole("option", { name: /grocery store/i }));
    expect(onChange).toHaveBeenLastCalledWith("p-grocery", GROCERY_STORE);

    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole("option", { name: /no contact/i }));

    expect(onChange).toHaveBeenLastCalledWith("", null);
  });
});
