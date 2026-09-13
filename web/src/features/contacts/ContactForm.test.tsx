import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../../lib/api";
import ContactForm from "./ContactForm";
import type { ContactOut } from "./useContacts";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

function installBackend(onWrite?: (path: string, opts?: { method?: string; json?: unknown }) => unknown) {
  mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
    if (path.startsWith("/categories?")) {
      return Promise.resolve({ items: [], next_cursor: null });
    }
    if (onWrite) {
      try {
        return Promise.resolve(onWrite(path, opts));
      } catch (err) {
        return Promise.reject(err);
      }
    }
    const body = (opts?.json ?? {}) as Partial<ContactOut>;
    return Promise.resolve({
      id: "new",
      name: body.name ?? "",
      default_category_id: body.default_category_id ?? null,
      type: body.type ?? "company",
      avatar: body.avatar ?? null,
      archived_at: null,
      is_demo: false,
      created_at: "2026-09-11T00:00:00Z",
    } satisfies ContactOut);
  });
}

function renderForm(props: Parameters<typeof ContactForm>[0]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ContactForm {...props} />
    </QueryClientProvider>,
  );
}

const CONTACT_WITH_AVATAR: ContactOut = {
  id: "c1",
  name: "Grocery Store",
  default_category_id: null,
  type: "company",
  avatar: "data:image/webp;base64,AAAA",
  archived_at: null,
  is_demo: false,
  created_at: "2026-09-10T00:00:00Z",
};

describe("ContactForm", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("submits the name and the default company type", async () => {
    installBackend();
    const onSuccess = vi.fn();
    renderForm({ onSuccess });

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
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it("submits the person type when toggled", async () => {
    installBackend();
    renderForm({ onSuccess: vi.fn() });

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

  it("keeps the avatar when editing an existing contact", async () => {
    installBackend();
    renderForm({ contact: CONTACT_WITH_AVATAR, onSuccess: vi.fn() });

    // The preview shows the current avatar image.
    expect(document.querySelector("img")).toHaveAttribute("src", "data:image/webp;base64,AAAA");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Corner Shop" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/contacts/c1",
        expect.objectContaining({
          method: "PATCH",
          json: expect.objectContaining({ name: "Corner Shop", avatar: "data:image/webp;base64,AAAA" }),
        }),
      ),
    );
  });

  it("surfaces a clear message when the avatar is rejected (AVATAR_INVALID)", async () => {
    installBackend((path, opts) => {
      if (path === "/contacts" && opts?.method === "POST") {
        throw new ApiError(422, "AVATAR_INVALID");
      }
      return undefined;
    });
    renderForm({ onSuccess: vi.fn() });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Fuel Brand" } });
    fireEvent.click(screen.getByRole("button", { name: /create contact/i }));

    expect(await screen.findByText(/image couldn't be saved/i)).toBeInTheDocument();
  });
});
