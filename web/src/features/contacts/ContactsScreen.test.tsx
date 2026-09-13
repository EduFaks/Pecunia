import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import ContactsScreen from "./ContactsScreen";
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

let contacts: ContactOut[];
let nextId: number;

function seedContacts(seed: ContactOut[]) {
  contacts = seed.map((contact) => ({ ...contact }));
  nextId = seed.length + 1;
}

function installFakeBackend() {
  mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
    const method = opts?.method ?? "GET";

    if (path.startsWith("/categories?") && method === "GET") {
      return Promise.resolve({ items: [GROCERIES_CATEGORY], next_cursor: null });
    }
    if (path.startsWith("/contacts?") && method === "GET") {
      const includeArchived = new URL(path, "http://localhost").searchParams.get("include_archived") === "true";
      const items = includeArchived ? contacts : contacts.filter((c) => c.archived_at === null);
      return Promise.resolve({ items, next_cursor: null });
    }
    if (path === "/contacts" && method === "POST") {
      const body = opts?.json as {
        name: string;
        type?: ContactOut["type"];
        avatar?: string | null;
        default_category_id?: string | null;
      };
      const created: ContactOut = {
        id: `p${nextId++}`,
        name: body.name,
        default_category_id: body.default_category_id ?? null,
        type: body.type ?? "company",
        avatar: body.avatar ?? null,
        archived_at: null,
        is_demo: false,
        created_at: "2026-09-11T00:00:00Z",
      };
      contacts.push(created);
      return Promise.resolve(created);
    }
    const patchMatch = /^\/contacts\/([^/]+)$/.exec(path);
    if (patchMatch && method === "PATCH") {
      const contact = contacts.find((c) => c.id === patchMatch[1]);
      if (contact) {
        Object.assign(contact, opts?.json as Partial<ContactOut>);
      }
      return Promise.resolve(contact);
    }
    const archiveMatch = /^\/contacts\/([^/]+)\/archive$/.exec(path);
    if (archiveMatch && method === "POST") {
      const contact = contacts.find((c) => c.id === archiveMatch[1]);
      if (contact) {
        contact.archived_at = "2026-09-11T00:00:00Z";
      }
      return Promise.resolve(undefined);
    }
    return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
  });
}

function ContactDetailStub() {
  const { id } = useParams<{ id: string }>();
  return <div>Detail route for {id}</div>;
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Routes>
            <Route path="/" element={<ContactsScreen />} />
            <Route path="/contacts/:id" element={<ContactDetailStub />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

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

const LANDLORD: ContactOut = {
  id: "p-landlord",
  name: "Alex Rent",
  default_category_id: null,
  type: "person",
  avatar: "data:image/webp;base64,AAAA",
  archived_at: null,
  is_demo: false,
  created_at: "2026-09-10T00:00:00Z",
};

describe("ContactsScreen", () => {
  beforeEach(() => {
    seedContacts([]);
    installFakeBackend();
  });

  it("shows a guiding empty state on a fresh workspace", async () => {
    renderScreen();
    expect(await screen.findByText(/no contacts yet/i)).toBeInTheDocument();
  });

  it("lists contacts with their avatar, type, and default category", async () => {
    seedContacts([GROCERY_STORE, LANDLORD]);
    renderScreen();

    const groceryRow = (await screen.findByText("Grocery Store")).closest("li")!;
    expect(within(groceryRow).getByText("Company")).toBeInTheDocument();
    expect(within(groceryRow).getByText("Groceries")).toBeInTheDocument();

    const landlordRow = (await screen.findByText("Alex Rent")).closest("li")!;
    expect(within(landlordRow).getByText("Person")).toBeInTheDocument();
    const img = landlordRow.querySelector("img");
    expect(img).toHaveAttribute("src", "data:image/webp;base64,AAAA");
  });

  it("creates a company contact with the default type", async () => {
    renderScreen();
    await screen.findByText(/no contacts yet/i);

    fireEvent.click(screen.getByRole("button", { name: /new contact/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Fuel Brand" } });
    fireEvent.click(screen.getByRole("button", { name: /create contact/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/contacts",
        expect.objectContaining({
          method: "POST",
          json: expect.objectContaining({ name: "Fuel Brand", type: "company" }),
        }),
      ),
    );
    expect(await screen.findByText("Fuel Brand")).toBeInTheDocument();
  });

  it("creates a person contact when the Person type is chosen", async () => {
    renderScreen();
    await screen.findByText(/no contacts yet/i);

    fireEvent.click(screen.getByRole("button", { name: /new contact/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alex Rent" } });
    fireEvent.click(screen.getByRole("button", { name: "Person" }));
    fireEvent.click(screen.getByRole("button", { name: /create contact/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/contacts",
        expect.objectContaining({ json: expect.objectContaining({ type: "person" }) }),
      ),
    );
  });

  it("edits a contact's name", async () => {
    seedContacts([GROCERY_STORE]);
    renderScreen();

    const row = (await screen.findByText("Grocery Store")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Corner Shop" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/contacts/p-grocery",
        expect.objectContaining({ method: "PATCH", json: expect.objectContaining({ name: "Corner Shop" }) }),
      ),
    );
    expect(await screen.findByText("Corner Shop")).toBeInTheDocument();
  });

  it("archives a contact, hiding it until Show archived is checked", async () => {
    seedContacts([GROCERY_STORE]);
    renderScreen();

    const row = (await screen.findByText("Grocery Store")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /archive/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/contacts/p-grocery/archive", { method: "POST" }),
    );
    await waitFor(() => expect(screen.queryByText("Grocery Store")).not.toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(/show archived contacts/i));

    const archivedRow = (await screen.findByText("Grocery Store")).closest("li")!;
    expect(within(archivedRow).getByText("Archived")).toBeInTheDocument();
    expect(within(archivedRow).queryByRole("button", { name: /^archive$/i })).not.toBeInTheDocument();
  });

  it("routes to the contact's overview when its row is clicked", async () => {
    seedContacts([GROCERY_STORE]);
    renderScreen();

    const link = await screen.findByRole("link", { name: /grocery store/i });
    fireEvent.click(link);

    expect(await screen.findByText("Detail route for p-grocery")).toBeInTheDocument();
  });
});
